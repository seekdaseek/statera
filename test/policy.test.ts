/**
 * Tests for the spending policy, one case per rule, plus the cases where two rules
 * disagree.
 *
 * The rules exist because there is no more funding: 0.00281 OKB has to carry the feed
 * to 2026-09-30. A bug here does not throw, it quietly drains the wallet or quietly
 * stops posting, and either one is only visible days later. So each rule is tested at
 * its boundary rather than somewhere in the middle of its range, and the precedence
 * between rules is tested explicitly — the order is a decision, not an accident.
 *
 * decidePolicy is pure, so "now" and the balance are arguments. No clock, no network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decidePolicy, computeMovement, moveBps, utcDay,
  BALANCE_FLOOR_WEI, COST_CAP_WEI, STEADY_STATE_COST_WEI, COST_CAP_MULTIPLE,
  HEARTBEAT_SECONDS, MOVE_COOLDOWN_SECONDS, MOVE_BPS, MAX_POSTS_PER_UTC_DAY,
  type PolicyInput, type OnchainRow, type PackedLike,
} from "../src/policy.js";
import {
  loadState, saveState, rollDay, alertDue, markAlerted, emptyState,
} from "../src/state.js";
import { readCreds, redact } from "../src/alert.js";
import { mkdtempSync, writeFileSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const NOW = 1_758_000_000; // 2025-09-16T03:20:00Z
const TODAY = utcDay(NOW);

/** A run that every guard would wave through, so each test changes exactly one thing. */
function input(over: Partial<PolicyInput> = {}): PolicyInput {
  return {
    nowSec: NOW,
    lastPublishedAtSec: NOW - 60,
    postsToday: 0,
    counterDay: TODAY,
    balanceWei: 2_800_000_000_000_000n, // 0.0028 OKB
    estimatedCostWei: STEADY_STATE_COST_WEI,
    rowCount: 18,
    moved: [],
    newKeys: 0,
    statusChanges: 0,
    ...over,
  };
}

const moved1 = [{ label: "NVDAx wrapped 1000", field: "realisableUsd", bps: 150 }];

/* ------------------------------------------------------------ the constants */

// If these drift from the task's numbers the rules below still pass while the keeper
// spends against a policy nobody agreed to, so pin the literals themselves.
test("the policy numbers are the ones the budget was set against", () => {
  assert.equal(HEARTBEAT_SECONDS, 100 * 60);
  assert.equal(MOVE_COOLDOWN_SECONDS, 30 * 60);
  assert.equal(MOVE_BPS, 100);
  assert.equal(MAX_POSTS_PER_UTC_DAY, 18);
  assert.equal(BALANCE_FLOOR_WEI, 300_000_000_000_000n); // 0.0003 OKB
  assert.equal(COST_CAP_MULTIPLE, 3n);
  assert.equal(COST_CAP_WEI, STEADY_STATE_COST_WEI * 3n);
});

/* --------------------------------------------------- rule: 100-min heartbeat */

test("heartbeat: posts once the last post is 100 minutes old", () => {
  const d = decidePolicy(input({ lastPublishedAtSec: NOW - HEARTBEAT_SECONDS }));
  assert.equal(d.post, true);
  assert.equal(d.code, "post-heartbeat");
  assert.equal(d.ageSeconds, HEARTBEAT_SECONDS);
});

test("heartbeat: one second short of 100 minutes is not due", () => {
  const d = decidePolicy(input({ lastPublishedAtSec: NOW - HEARTBEAT_SECONDS + 1 }));
  assert.equal(d.post, false);
  assert.equal(d.code, "refuse-quiet");
});

test("heartbeat: an hours-stale feed still posts, the rule is >= not ==", () => {
  const d = decidePolicy(input({ lastPublishedAtSec: NOW - 6 * 3600 }));
  assert.equal(d.code, "post-heartbeat");
});

test("a feed that has never been posted to posts immediately", () => {
  const d = decidePolicy(input({ lastPublishedAtSec: 0 }));
  assert.equal(d.post, true);
  assert.equal(d.code, "post-first");
  assert.equal(d.ageSeconds, null);
});

/* ------------------------------------------------------- rule: 100 bps moved */

test("movement: a move over 100 bps posts once the cooldown has passed", () => {
  const d = decidePolicy(input({ lastPublishedAtSec: NOW - MOVE_COOLDOWN_SECONDS, moved: moved1 }));
  assert.equal(d.post, true);
  assert.equal(d.code, "post-movement");
  assert.match(d.reason, /worst 150 bps/);
});

test("movement: nothing moved and inside the heartbeat means no post", () => {
  const d = decidePolicy(input({ lastPublishedAtSec: NOW - MOVE_COOLDOWN_SECONDS }));
  assert.equal(d.post, false);
  assert.equal(d.code, "refuse-quiet");
});

test("movement: only measured rows count as a move", () => {
  // An absent row's numbers describe a partial fill the gate refuses anyway, so
  // paying gas to refresh one buys nothing. Same values, status 2 instead of 1.
  const rows = (status: number): PackedLike[] => [{
    token: "0xAbC0000000000000000000000000000000000001", form: 1, sizeTierUsd: 1000,
    markUsd: 200_000_000n, realisableUsd: 300_000_000n, fillableUsd: 0n, status,
    label: "test 1000",
  }];
  const prev = (status: number): Map<string, OnchainRow> => new Map([[
    "0xabc0000000000000000000000000000000000001/1/1000",
    { markUsd: 100_000_000n, realisableUsd: 100_000_000n, fillableUsd: 0n, status },
  ]]);
  assert.equal(computeMovement(rows(1), prev(1)).moved.length, 2); // mark and realisable
  assert.equal(computeMovement(rows(2), prev(2)).moved.length, 0);
});

test("movement: exactly 100 bps holds, 101 bps triggers", () => {
  const row = (realisableUsd: bigint): PackedLike[] => [{
    token: "0xAbC0000000000000000000000000000000000001", form: 1, sizeTierUsd: 1000,
    markUsd: 100_000_000n, realisableUsd, fillableUsd: 0n, status: 1, label: "test 1000",
  }];
  const prev = new Map<string, OnchainRow>([[
    "0xabc0000000000000000000000000000000000001/1/1000",
    { markUsd: 100_000_000n, realisableUsd: 100_000_000n, fillableUsd: 0n, status: 1 },
  ]]);
  assert.equal(moveBps(100_000_000n, 101_000_000n), 100);
  assert.equal(computeMovement(row(101_000_000n), prev).moved.length, 0);
  assert.equal(moveBps(100_000_000n, 101_010_000n), 101);
  assert.equal(computeMovement(row(101_010_000n), prev).moved.length, 1);
});

test("movement: a new key and a status change are triggers of their own", () => {
  const base = { lastPublishedAtSec: NOW - MOVE_COOLDOWN_SECONDS };
  assert.equal(decidePolicy(input({ ...base, newKeys: 1 })).code, "post-movement");
  assert.equal(decidePolicy(input({ ...base, statusChanges: 1 })).code, "post-movement");
});

/* -------------------------------------------------- rule: 30-minute cooldown */

test("cooldown: a move one second inside 30 minutes is refused", () => {
  const d = decidePolicy(input({ lastPublishedAtSec: NOW - MOVE_COOLDOWN_SECONDS + 1, moved: moved1 }));
  assert.equal(d.post, false);
  assert.equal(d.code, "refuse-cooldown");
  assert.match(d.reason, /cooldown/);
});

test("cooldown: exactly 30 minutes is outside it", () => {
  const d = decidePolicy(input({ lastPublishedAtSec: NOW - MOVE_COOLDOWN_SECONDS, moved: moved1 }));
  assert.equal(d.code, "post-movement");
});

test("cooldown: a new key does not get to bypass it either", () => {
  // Otherwise one flapping row could post every cron run: a row that reads back
  // unmeasured looks like a new key on every single pass.
  const d = decidePolicy(input({ lastPublishedAtSec: NOW - 120, newKeys: 3 }));
  assert.equal(d.post, false);
  assert.equal(d.code, "refuse-cooldown");
});

/* --------------------------------------------------- rule: 18 posts per UTC day */

test("daily cap: the 19th post of a UTC day is refused", () => {
  const d = decidePolicy(input({
    postsToday: MAX_POSTS_PER_UTC_DAY,
    lastPublishedAtSec: NOW - HEARTBEAT_SECONDS, // heartbeat due, and still refused
  }));
  assert.equal(d.post, false);
  assert.equal(d.code, "refuse-daily-cap");
  assert.match(d.reason, /18\/day cap/);
});

test("daily cap: the 18th is allowed", () => {
  const d = decidePolicy(input({
    postsToday: MAX_POSTS_PER_UTC_DAY - 1,
    lastPublishedAtSec: NOW - HEARTBEAT_SECONDS,
  }));
  assert.equal(d.post, true);
  assert.equal(d.postsTodayEffective, 17);
});

test("daily cap: a counter from yesterday is spent, not carried", () => {
  const d = decidePolicy(input({
    postsToday: 18,
    counterDay: "2025-09-15",
    lastPublishedAtSec: NOW - HEARTBEAT_SECONDS,
  }));
  assert.equal(d.post, true);
  assert.equal(d.postsTodayEffective, 0, "the cap is per UTC day, not rolling");
});

/* -------------------------------------------------- rule: 0.0003 OKB floor */

test("balance floor: one wei below the floor refuses and asks for an alert", () => {
  const d = decidePolicy(input({
    balanceWei: BALANCE_FLOOR_WEI - 1n,
    lastPublishedAtSec: NOW - HEARTBEAT_SECONDS,
  }));
  assert.equal(d.post, false);
  assert.equal(d.code, "refuse-balance-floor");
  assert.deepEqual(d.alerts, ["balance-floor"]);
  assert.match(d.reason, /below the 0\.000300000 OKB floor/);
});

test("balance floor: exactly at the floor still posts", () => {
  const d = decidePolicy(input({
    balanceWei: BALANCE_FLOOR_WEI,
    lastPublishedAtSec: NOW - HEARTBEAT_SECONDS,
  }));
  assert.equal(d.post, true);
});

/* ------------------------------------------------------ rule: 3x cost cap */

test("cost cap: one wei over 3x the steady-state cost refuses and alerts", () => {
  const d = decidePolicy(input({
    estimatedCostWei: COST_CAP_WEI + 1n,
    lastPublishedAtSec: NOW - HEARTBEAT_SECONDS,
  }));
  assert.equal(d.post, false);
  assert.equal(d.code, "refuse-cost-cap");
  assert.deepEqual(d.alerts, ["gas-spike"]);
  assert.match(d.reason, /3\.0x the steady-state/);
});

test("cost cap: exactly 3x is allowed", () => {
  const d = decidePolicy(input({
    estimatedCostWei: COST_CAP_WEI,
    lastPublishedAtSec: NOW - HEARTBEAT_SECONDS,
  }));
  assert.equal(d.post, true);
});

test("cost cap: an unestimatable post is treated as unaffordable, not as free", () => {
  // A node that will not simulate the post may also be about to revert it. Guessing
  // the cost is how a wallet empties.
  const d = decidePolicy(input({
    estimatedCostWei: null,
    lastPublishedAtSec: NOW - HEARTBEAT_SECONDS,
  }));
  assert.equal(d.post, false);
  assert.equal(d.code, "refuse-cost-cap");
  assert.deepEqual(d.alerts, ["gas-spike"]);
  assert.match(d.reason, /could not be estimated/);
});

/* ----------------------------------------------------------- nothing to say */

test("no postable rows means no post, whatever the cadence says", () => {
  const d = decidePolicy(input({ rowCount: 0, lastPublishedAtSec: 0 }));
  assert.equal(d.post, false);
  assert.equal(d.code, "refuse-no-rows");
});

/* ------------------------------------------------------------- precedence */

test("solvency outranks cadence: the floor beats a due heartbeat AND a move", () => {
  const d = decidePolicy(input({
    balanceWei: BALANCE_FLOOR_WEI - 1n,
    lastPublishedAtSec: NOW - 6 * 3600,
    moved: moved1,
    newKeys: 4,
  }));
  assert.equal(d.code, "refuse-balance-floor");
});

test("a gas spike beats a due heartbeat", () => {
  const d = decidePolicy(input({
    estimatedCostWei: COST_CAP_WEI * 10n,
    lastPublishedAtSec: NOW - 6 * 3600,
  }));
  assert.equal(d.code, "refuse-cost-cap");
});

test("the floor is checked before the gas price, so a broke wallet reads as broke", () => {
  const d = decidePolicy(input({
    balanceWei: 0n,
    estimatedCostWei: COST_CAP_WEI * 10n,
    lastPublishedAtSec: NOW - 6 * 3600,
  }));
  assert.equal(d.code, "refuse-balance-floor");
});

test("the daily cap beats the first-post rule, so a fresh feed cannot loop", () => {
  const d = decidePolicy(input({ postsToday: 18, lastPublishedAtSec: 0 }));
  assert.equal(d.code, "refuse-daily-cap");
});

/* ------------------------------------------------- every refusal is loggable */

test("every refusal carries a code and a non-empty reason", () => {
  const cases: [string, PolicyInput][] = [
    ["refuse-no-rows", input({ rowCount: 0 })],
    ["refuse-balance-floor", input({ balanceWei: 0n })],
    ["refuse-cost-cap", input({ estimatedCostWei: COST_CAP_WEI + 1n })],
    ["refuse-daily-cap", input({ postsToday: 18 })],
    ["refuse-cooldown", input({ lastPublishedAtSec: NOW - 60, moved: moved1 })],
    ["refuse-quiet", input({ lastPublishedAtSec: NOW - 60 })],
  ];
  for (const [code, i] of cases) {
    const d = decidePolicy(i);
    assert.equal(d.post, false, code);
    assert.equal(d.code, code);
    assert.ok(d.reason.length > 20, `${code} reason too thin: ${d.reason}`);
  }
  // And all nine codes are reachable: three post, six refuse.
  const posts = [
    decidePolicy(input({ lastPublishedAtSec: 0 })).code,
    decidePolicy(input({ lastPublishedAtSec: NOW - HEARTBEAT_SECONDS })).code,
    decidePolicy(input({ lastPublishedAtSec: NOW - MOVE_COOLDOWN_SECONDS, moved: moved1 })).code,
  ];
  assert.deepEqual(new Set(posts).size, 3);
  assert.equal(new Set([...posts, ...cases.map((c) => c[0])]).size, 9);
});

test("a post decision never asks for an alert", () => {
  for (const last of [0, NOW - HEARTBEAT_SECONDS, NOW - MOVE_COOLDOWN_SECONDS]) {
    const d = decidePolicy(input({ lastPublishedAtSec: last, moved: moved1 }));
    if (d.post) assert.deepEqual(d.alerts, []);
  }
});

/* ------------------------------------------------------------------- state */

const stateDir = mkdtempSync(join(tmpdir(), "statera-state-"));
let stateN = 0;
const freshState = () => join(stateDir, `s${stateN++}.json`);

test("state: a missing file reads back as a fresh day, it does not throw", () => {
  const s = loadState(NOW, join(stateDir, "does-not-exist.json"));
  assert.equal(s.postsToday, 0);
  assert.equal(s.counterDay, TODAY);
});

test("state: a corrupt file reads back as fresh rather than taking the feed down", () => {
  const p = freshState();
  writeFileSync(p, "{ this is not json");
  const s = loadState(NOW, p);
  assert.equal(s.postsToday, 0);
  assert.equal(s.counterDay, TODAY);
});

test("state: a round trip keeps the counter, and the file is 0600", () => {
  const p = freshState();
  saveState({ counterDay: TODAY, postsToday: 7, alertedOn: { "gas-spike": TODAY }, balanceFloorAlerted: true, lastTxHash: "0xdead" }, p);
  const s = loadState(NOW, p);
  assert.equal(s.postsToday, 7);
  assert.equal(s.balanceFloorAlerted, true);
  assert.equal(s.lastTxHash, "0xdead");
  assert.equal(statSync(p).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(p, "utf8")).postsToday, 7);
});

test("state: a negative or non-numeric counter reads back as zero", () => {
  const p = freshState();
  writeFileSync(p, JSON.stringify({ counterDay: TODAY, postsToday: -5 }));
  assert.equal(loadState(NOW, p).postsToday, 0);
  writeFileSync(p, JSON.stringify({ counterDay: TODAY, postsToday: "lots" }));
  assert.equal(loadState(NOW, p).postsToday, 0);
});

test("state: rollDay zeroes the counter on a new UTC day and leaves today alone", () => {
  const y = { ...emptyState(NOW), counterDay: "2025-09-15", postsToday: 18 };
  assert.equal(rollDay(y, NOW).postsToday, 0);
  assert.equal(rollDay(y, NOW).counterDay, TODAY);
  const t = { ...emptyState(NOW), postsToday: 4 };
  assert.equal(rollDay(t, NOW).postsToday, 4);
});

test("state: an alert fires once a day per kind, and again tomorrow", () => {
  let s = emptyState(NOW);
  assert.equal(alertDue(s, "gas-spike", NOW), true);
  s = markAlerted(s, "gas-spike", NOW);
  assert.equal(alertDue(s, "gas-spike", NOW), false);
  assert.equal(alertDue(s, "post-failed", NOW), true, "kinds debounce independently");
  assert.equal(alertDue(s, "gas-spike", NOW + 86_400), true);
});

/* ------------------------------------------------------------------ alerts */

test("alerts: credentials are read from the env file by name", () => {
  const p = freshState();
  writeFileSync(p, "OTHER=x\nTG_BOT_TOKEN=111111111:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\nTG_ALERT_CHAT=-1001234567\n");
  const c = readCreds(p);
  assert.equal(c?.chat, "-1001234567");
  assert.equal(c?.token.length, 45);
});

test("alerts: a missing file or a missing key yields no credentials, not a crash", () => {
  assert.equal(readCreds(join(stateDir, "nope.env")), null);
  const p = freshState();
  writeFileSync(p, "TG_BOT_TOKEN=111111111:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n");
  assert.equal(readCreds(p), null, "a token without a chat id is unusable");
});

test("alerts: redact removes the token, and the token SHAPE even when unknown", () => {
  // G1: the shape regex is what protects a log line the failing URL leaked into, so
  // it is checked against a known-positive first — a wrong regex here is silent.
  const tok = "123456789:ABCdefGHIjklMNOpqrsTUVwxyz1234567890";
  assert.match(tok, /\d{6,}:[A-Za-z0-9_-]{30,}/, "control: the fixture looks like a token");
  assert.equal(redact(`POST https://api.telegram.org/bot${tok}/sendMessage failed`, tok),
    "POST https://api.telegram.org/bot[redacted]/sendMessage failed");
  assert.equal(redact(`leaked ${tok} here`), "leaked [redacted] here", "no token argument, shape only");
  // The one that matters: the token glued to "bot" in the URL, with no token
  // argument to fall back on. An anchored \\b pattern silently matched nothing here.
  assert.equal(redact(`bot${tok}/x`), "bot[redacted]/x");
  assert.ok(!redact(`bot${tok}/x`).includes("ABCdefGHI"));
  assert.equal(redact("bot1234567890123:ABCdefGHIjklMNOpqrsTUVwxyz1234567890/x"),
    "bot[redacted]/x", "a longer bot id is still redacted, not skipped");
  assert.equal(redact("nothing secret here"), "nothing secret here");
});
