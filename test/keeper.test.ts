/**
 * Tests for the keeper's two jobs: packing an engine report into feed rows without
 * inventing anything, and deciding whether a post is worth paying for.
 *
 * The gap formula is the load-bearing part. The feed rejects a Measured row whose
 * gap disagrees with its values, so if expectedGapBps here diverged from
 * StateraFeed.expectedGapBps by even one basis point at a rounding boundary, posts
 * would fail in production and nowhere else. The fork end-to-end test is the other
 * half of that check: it posts 18 real rows and the contract accepts every one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  packReport, toUsd6, expectedGapBps, moveBps, toTuple,
  FORM_RAW, FORM_WRAPPED, STATUS_MEASURED, STATUS_ABSENT,
} from "../src/pack.js";
import { decide, acquireLock, MOVE_BPS, HEARTBEAT_SECONDS } from "../src/keeper.js";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TOKENS } from "../src/config.js";
import type { Report, Row } from "../src/engine.js";

const NVDA = TOKENS.find((t) => t.rawSymbol === "NVDAx")!;

function row(over: Partial<Row>): Row {
  return {
    token: "NVDAx",
    form: "wrapped",
    symbol: "wNVDAx",
    address: NVDA.wrapped,
    sizeUsd: 1000,
    markUsd: 220.0187,
    markSource: "test",
    markAgeMs: 100,
    tokensSold: "4.545069",
    realisableUsd: 997.6,
    gapBps: -24,
    status: "measured",
    poolsUsed: ["v3 USDG/wNVDAx"],
    fillableUsd: null,
    route: "v3 USDG/wNVDAx",
    note: "",
    ...over,
  } as Row;
}

function report(rows: Row[], block = 70_885_401): Report {
  return {
    chainId: 196,
    block,
    rpcUrl: "test",
    rpcCalls: 0,
    generatedAt: "2026-09-17T00:00:00.000Z",
    rows,
    floats: [],
    multipliers: [],
    pools: [],
    warnings: [],
  } as Report;
}

/* ------------------------------------------------------------- conversions */

test("toUsd6 rounds to six decimals and refuses nonsense", () => {
  assert.equal(toUsd6(1), 1_000_000n);
  assert.equal(toUsd6(997.6), 997_600_000n);
  assert.equal(toUsd6(0.0000005), 1n); // half-up at the last decimal
  assert.equal(toUsd6(0), 0n);
  assert.equal(toUsd6(-5), 0n);
  assert.equal(toUsd6(Number.NaN), 0n);
  assert.equal(toUsd6(Number.POSITIVE_INFINITY), 0n);
});

test("expectedGapBps reproduces the contract's integer truncation", () => {
  // Same cases asserted against the contract in StateraFeed.t.sol.
  assert.equal(expectedGapBps(1000, 997_600_000n), -24);
  assert.equal(expectedGapBps(100000, 97_924_170_000n), -207);
  assert.equal(expectedGapBps(1000, 1_000_000_000n), 0);
  assert.equal(expectedGapBps(1000, 1_010_000_000n), 100);
});

test("expectedGapBps truncates toward zero on both signs", () => {
  // -0.5 bps must become 0, not -1: Solidity integer division truncates.
  assert.equal(expectedGapBps(1000, 999_950_000n), 0);
  // +0.5 bps likewise.
  assert.equal(expectedGapBps(1000, 1_000_050_000n), 0);
  // And a clean -1 stays -1.
  assert.equal(expectedGapBps(1000, 999_900_000n), -1);
});

test("expectedGapBps refuses a zero tier rather than dividing by zero", () => {
  assert.throws(() => expectedGapBps(0, 1n), /tier of zero/);
});

test("moveBps measures relative movement and treats a new value as infinite", () => {
  assert.equal(moveBps(1_000_000n, 1_000_000n), 0);
  assert.equal(moveBps(1_000_000n, 1_000_500n), 5);
  assert.equal(moveBps(1_000_000n, 1_000_600n), 6);
  assert.equal(moveBps(1_000_000n, 999_400n), 6); // symmetric
  assert.equal(moveBps(0n, 5n), Number.POSITIVE_INFINITY);
  assert.equal(moveBps(0n, 0n), 0);
});

/* ------------------------------------------------------------------ packing */

test("packing maps both forms onto the raw token as the asset identity", () => {
  const p = packReport(report([row({ form: "raw" }), row({ form: "wrapped" })]));
  assert.equal(p.rows.length, 2);
  assert.equal(p.rows[0]!.token.toLowerCase(), NVDA.raw.toLowerCase());
  assert.equal(p.rows[1]!.token.toLowerCase(), NVDA.raw.toLowerCase());
  assert.equal(p.rows[0]!.form, FORM_RAW);
  assert.equal(p.rows[1]!.form, FORM_WRAPPED);
});

test("packing derives the gap from the integer, not from the engine's float", () => {
  // The engine's float says -24.03; the integer realisable implies -24 exactly.
  const p = packReport(report([row({ realisableUsd: 997.6, gapBps: -24.0312345 })]));
  assert.equal(p.rows[0]!.realisableUsd, 997_600_000n);
  assert.equal(p.rows[0]!.gapBps, -24);
  assert.equal(p.rows[0]!.gapBps, expectedGapBps(1000, 997_600_000n));
});

test("an unmeasured row is dropped, never posted as zeros", () => {
  const p = packReport(
    report([
      row({ status: "unmeasured", markUsd: null, realisableUsd: null, gapBps: null, note: "mark unavailable" }),
      row({ sizeUsd: 10000, realisableUsd: 9959.11 }),
    ]),
  );
  assert.equal(p.rows.length, 1);
  assert.equal(p.rows[0]!.sizeTierUsd, 10000);
  assert.equal(p.dropped.length, 1);
  assert.match(p.dropped[0]!.reason, /unmeasured/);
  // Nothing in the payload carries a zero mark or a zero realisable value.
  for (const r of p.rows) {
    assert.ok(r.markUsd > 0n);
    assert.ok(r.realisableUsd > 0n);
  }
});

test("a whole run of unmeasured rows packs to nothing at all", () => {
  const p = packReport(
    report([
      row({ status: "unmeasured", markUsd: null, realisableUsd: null }),
      row({ status: "unmeasured", markUsd: null, realisableUsd: null, form: "raw" }),
    ]),
  );
  assert.equal(p.rows.length, 0);
  assert.equal(p.dropped.length, 2);
});

test("an absent row carries its fillable amount and no gap", () => {
  const p = packReport(
    report([
      row({
        status: "absent",
        sizeUsd: 500000,
        realisableUsd: 293456.51,
        fillableUsd: 372798,
        gapBps: null,
      }),
    ]),
  );
  assert.equal(p.rows.length, 1);
  const r = p.rows[0]!;
  assert.equal(r.status, STATUS_ABSENT);
  assert.equal(r.fillableUsd, 372_798_000_000n);
  assert.equal(r.realisableUsd, 293_456_510_000n);
  assert.equal(r.gapBps, 0, "an absent row must not claim a gap");
});

test("an absent row without a fillable amount is dropped", () => {
  const p = packReport(
    report([row({ status: "absent", sizeUsd: 500000, realisableUsd: 1000, fillableUsd: null })]),
  );
  assert.equal(p.rows.length, 0);
  assert.match(p.dropped[0]!.reason, /fillable/);
});

test("a measured row missing a value is dropped rather than posted broken", () => {
  const p = packReport(report([row({ status: "measured", markUsd: null })]));
  assert.equal(p.rows.length, 0);
  assert.match(p.dropped[0]!.reason, /missing a mark/);
});

test("the tuple field order matches RowInput", () => {
  const p = packReport(report([row({})]));
  const t = toTuple(p.rows[0]!);
  assert.deepEqual(Object.keys(t), [
    "token", "form", "sizeTierUsd", "markUsd", "realisableUsd", "fillableUsd", "gapBps", "status",
  ]);
});

/* ----------------------------------------------------------------- deciding */

const NOW = 1_750_000_000;
const key = (form: number, tier: number) => `${NVDA.raw.toLowerCase()}/${form}/${tier}`;

function onchainFrom(rows: ReturnType<typeof packReport>["rows"]) {
  const m = new Map<string, { markUsd: bigint; realisableUsd: bigint; fillableUsd: bigint; status: number }>();
  for (const r of rows) {
    m.set(key(r.form, r.sizeTierUsd), {
      markUsd: r.markUsd,
      realisableUsd: r.realisableUsd,
      fillableUsd: r.fillableUsd,
      status: r.status,
    });
  }
  return m;
}

test("posts when a key has never been published", () => {
  const p = packReport(report([row({})]));
  const d = decide(p.rows, new Map(), 0, NOW);
  assert.equal(d.post, true);
  assert.match(d.reason, /never been published/);
});

test("skips when nothing moved and the heartbeat is not due", () => {
  const p = packReport(report([row({})]));
  const d = decide(p.rows, onchainFrom(p.rows), NOW - 60, NOW);
  assert.equal(d.post, false);
  assert.match(d.reason, /nothing moved/);
});

test("posts when a value moved more than the threshold", () => {
  const p = packReport(report([row({})]));
  const chain = onchainFrom(p.rows);
  const k = key(FORM_WRAPPED, 1000);
  const prev = chain.get(k)!;
  // Move the onchain realisable value 20 bps away from the fresh one. Note the
  // asymmetry: moveBps is measured against the OLD value, so a +6 bps nudge reads
  // back as 5 bps and would not trigger. 20 bps is unambiguous either way.
  chain.set(k, { ...prev, realisableUsd: (prev.realisableUsd * 10_020n) / 10_000n });
  const d = decide(p.rows, chain, NOW - 60, NOW);
  assert.equal(d.post, true);
  assert.match(d.reason, /moved more than 5 bps/);
  assert.equal(d.movedRows[0]!.field, "realisableUsd");
  assert.ok(d.movedRows[0]!.bps > MOVE_BPS, `reported ${d.movedRows[0]!.bps} bps`);
});

test("a move of exactly the threshold is not enough to pay for a post", () => {
  // moveBps is relative to the value already onchain, and the trigger is strictly
  // greater than MOVE_BPS, so a move that lands exactly on it must hold.
  const p = packReport(report([row({})]));
  const chain = onchainFrom(p.rows);
  const k = key(FORM_WRAPPED, 1000);
  const prev = chain.get(k)!;
  chain.set(k, { ...prev, realisableUsd: (prev.realisableUsd * (10_000n + BigInt(MOVE_BPS))) / 10_000n });
  const d = decide(p.rows, chain, NOW - 60, NOW);
  assert.equal(d.post, false);
});

test("posts when a row changed status even if the numbers barely moved", () => {
  const p = packReport(report([row({})]));
  const chain = onchainFrom(p.rows);
  const k = key(FORM_WRAPPED, 1000);
  chain.set(k, { ...chain.get(k)!, status: STATUS_ABSENT });
  const d = decide(p.rows, chain, NOW - 60, NOW);
  assert.equal(d.post, true);
  assert.match(d.reason, /changed status/);
});

test("posts on the heartbeat so silence is distinguishable from a dead keeper", () => {
  const p = packReport(report([row({})]));
  const d = decide(p.rows, onchainFrom(p.rows), NOW - HEARTBEAT_SECONDS, NOW);
  assert.equal(d.post, true);
  assert.match(d.reason, /heartbeat/);
});

test("one second before the heartbeat it still holds", () => {
  const p = packReport(report([row({})]));
  const d = decide(p.rows, onchainFrom(p.rows), NOW - HEARTBEAT_SECONDS + 1, NOW);
  assert.equal(d.post, false);
});

test("an onchain row that reads back unmeasured counts as never published", () => {
  const p = packReport(report([row({})]));
  const chain = onchainFrom(p.rows);
  const k = key(FORM_WRAPPED, 1000);
  chain.set(k, { markUsd: 0n, realisableUsd: 0n, fillableUsd: 0n, status: 0 });
  const d = decide(p.rows, chain, NOW - 60, NOW);
  assert.equal(d.post, true);
  assert.match(d.reason, /never been published/);
});

/* --------------------------------------------------------------------- lock */

const lockDir = mkdtempSync(join(tmpdir(), "statera-lock-"));
let lockN = 0;
const freshLock = () => join(lockDir, `l${lockN++}.lock`);

test("the lock is exclusive while held, and releasable by its owner", () => {
  const p = freshLock();
  const release = acquireLock(p);
  assert.ok(existsSync(p));
  assert.throws(() => acquireLock(p), /another keeper run holds/);
  release();
  assert.ok(!existsSync(p));
  // And it can be taken again afterwards.
  acquireLock(p)();
});

test("a stale lock is broken so a crashed run cannot silence the keeper", () => {
  const p = freshLock();
  writeFileSync(p, `999999:old\n${new Date(Date.now() - 60 * 60 * 1000).toISOString()}\n`);
  const release = acquireLock(p); // must succeed
  assert.match(readFileSync(p, "utf8").split("\n")[0] ?? "", /^\d+:/);
  release();
});

test("a zero-byte lock is broken via its mtime rather than wedging forever", () => {
  // Exactly what a crash between create and write leaves behind. Before the mtime
  // fallback, the unparseable timestamp made this lock permanent.
  const p = freshLock();
  writeFileSync(p, "");
  const old = (Date.now() - 60 * 60 * 1000) / 1000;
  utimesSync(p, old, old);
  const release = acquireLock(p);
  release();
});

test("a fresh zero-byte lock is still respected", () => {
  const p = freshLock();
  writeFileSync(p, "");
  assert.throws(() => acquireLock(p), /another keeper run holds/);
});

test("release does not delete a lock that now belongs to someone else", () => {
  // The overrun scenario: run A's lock goes stale, run B breaks it and takes its own,
  // then A finishes and calls release. A must not remove B's lock, or a third run
  // could start alongside B and double-post.
  const p = freshLock();
  const releaseA = acquireLock(p);
  const aToken = readFileSync(p, "utf8").split("\n")[0];
  // Age A's lock out and let B take it.
  const old = (Date.now() - 60 * 60 * 1000) / 1000;
  utimesSync(p, old, old);
  writeFileSync(p, `999999:B\n${new Date(Date.now() - 60 * 60 * 1000).toISOString()}\n`);
  const releaseB = acquireLock(p);
  const bToken = readFileSync(p, "utf8").split("\n")[0];
  assert.notEqual(aToken, bToken);

  releaseA(); // late, and not the owner
  assert.ok(existsSync(p), "A must not have removed B's lock");
  assert.equal(readFileSync(p, "utf8").split("\n")[0], bToken);
  releaseB();
  assert.ok(!existsSync(p));
});
