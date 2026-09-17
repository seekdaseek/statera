/**
 * When the keeper is allowed to spend.
 *
 * The feed has to stay live until 2026-09-30 on a balance that will not be topped
 * up, so the policy is a spending rule first and a freshness rule second. Every
 * branch returns a machine-readable code as well as a sentence, because a refusal
 * nobody can grep is indistinguishable from a keeper that died.
 *
 * ORDER MATTERS, and it is deliberate. The two solvency guards come before the two
 * cadence rules, so a heartbeat that is due can never override a balance floor or a
 * gas spike: running dry on Sep 25 is worse than a stale row on Sep 25, because a
 * stale row is refused honestly by the gate while an empty wallet cannot be refused
 * at all. The daily cap sits above the cadence rules for the same reason.
 *
 * Pure: no clock, no network, no filesystem. Everything it needs is an argument,
 * which is what makes each rule testable on its own.
 */

import { moveBps } from "./pack.js";

/** The reference post: 18 warm rows at the gas price this budget was planned against. */
export const STEADY_STATE_GAS = 436_458n;
export const REFERENCE_GAS_PRICE_WEI = 20_000_001n;
export const STEADY_STATE_COST_WEI = STEADY_STATE_GAS * REFERENCE_GAS_PRICE_WEI;

/** Refuse a post costing more than this multiple of the reference. Catches both a
 *  gas spike and an unexpectedly large run, since it compares cost, not gas. */
export const COST_CAP_MULTIPLE = 3n;
export const COST_CAP_WEI = STEADY_STATE_COST_WEI * COST_CAP_MULTIPLE;

/** Stop spending entirely below this, leaving the last of the balance unspent
 *  rather than dribbling it away mid-day. */
export const BALANCE_FLOOR_WEI = 300_000_000_000_000n; // 0.0003 OKB

export const HEARTBEAT_SECONDS = 100 * 60; // 100 minutes
export const MOVE_COOLDOWN_SECONDS = 30 * 60; // no movement post within 30 minutes
export const MOVE_BPS = 100; // a measured value must move more than this
export const MAX_POSTS_PER_UTC_DAY = 18;

export type DecisionCode =
  | "post-heartbeat"
  | "post-movement"
  | "post-first"
  | "refuse-no-rows"
  | "refuse-balance-floor"
  | "refuse-cost-cap"
  | "refuse-daily-cap"
  | "refuse-cooldown"
  | "refuse-quiet";

export type AlertKind = "balance-floor" | "gas-spike" | "post-failed";

export interface Movement {
  label: string;
  field: string;
  bps: number;
}

export interface PolicyInput {
  /** Seconds since epoch, UTC. */
  nowSec: number;
  /** The feed's own lastPublishedAt. 0 when nothing has ever been posted. */
  lastPublishedAtSec: number;
  /** Posts already made in the UTC day `counterDay`. */
  postsToday: number;
  /** The UTC day (YYYY-MM-DD) the counter belongs to; a different day resets it. */
  counterDay: string;
  balanceWei: bigint;
  /** Estimated cost of this post, or null when the estimate failed. */
  estimatedCostWei: bigint | null;
  /** How many rows are ready to post. Zero means there is nothing to say. */
  rowCount: number;
  /** Measured values that moved more than MOVE_BPS against what is onchain. */
  moved: Movement[];
  /** Keys with no published row yet. */
  newKeys: number;
  /** Rows whose status changed. */
  statusChanges: number;
}

export interface PolicyDecision {
  post: boolean;
  code: DecisionCode;
  reason: string;
  /** Alerts this decision wants sent. De-duplication is the caller's job. */
  alerts: AlertKind[];
  /** Post count for the current UTC day after applying any day rollover. */
  postsTodayEffective: number;
  ageSeconds: number | null;
}

export const utcDay = (nowSec: number): string => new Date(nowSec * 1000).toISOString().slice(0, 10);

export function decidePolicy(i: PolicyInput): PolicyDecision {
  const today = utcDay(i.nowSec);
  // A counter from another UTC day is spent; the cap is per day, not rolling.
  const postsToday = i.counterDay === today ? i.postsToday : 0;
  const age = i.lastPublishedAtSec === 0 ? null : i.nowSec - i.lastPublishedAtSec;
  const base = { alerts: [] as AlertKind[], postsTodayEffective: postsToday, ageSeconds: age };

  if (i.rowCount === 0) {
    return { post: false, code: "refuse-no-rows", reason: "the engine produced no postable rows", ...base };
  }

  // --- solvency, before anything that wants to spend ---

  if (i.balanceWei < BALANCE_FLOOR_WEI) {
    return {
      post: false,
      code: "refuse-balance-floor",
      reason: `balance ${fmt(i.balanceWei)} OKB is below the ${fmt(BALANCE_FLOOR_WEI)} OKB floor; not spending further`,
      ...base,
      alerts: ["balance-floor"],
    };
  }

  if (i.estimatedCostWei === null) {
    // No estimate means the node would not simulate the post. Treat as unaffordable
    // rather than guessing: a post that cannot be estimated may also revert.
    return {
      post: false,
      code: "refuse-cost-cap",
      reason: "gas could not be estimated, so the cost of this post is unknown",
      ...base,
      alerts: ["gas-spike"],
    };
  }

  if (i.estimatedCostWei > COST_CAP_WEI) {
    const mult = Number(i.estimatedCostWei) / Number(STEADY_STATE_COST_WEI);
    return {
      post: false,
      code: "refuse-cost-cap",
      reason: `this post would cost ${fmt(i.estimatedCostWei)} OKB, ${mult.toFixed(1)}x the steady-state ${fmt(STEADY_STATE_COST_WEI)} OKB and over the ${COST_CAP_MULTIPLE}x cap`,
      ...base,
      alerts: ["gas-spike"],
    };
  }

  if (postsToday >= MAX_POSTS_PER_UTC_DAY) {
    return {
      post: false,
      code: "refuse-daily-cap",
      reason: `already posted ${postsToday} times on ${today}, at the ${MAX_POSTS_PER_UTC_DAY}/day cap`,
      ...base,
    };
  }

  // --- cadence ---

  if (age === null) {
    return { post: true, code: "post-first", reason: "nothing has ever been posted to this feed", ...base };
  }

  if (age >= HEARTBEAT_SECONDS) {
    return {
      post: true,
      code: "post-heartbeat",
      reason: `last post was ${age}s ago, at or past the ${HEARTBEAT_SECONDS}s heartbeat`,
      ...base,
    };
  }

  const triggers = i.moved.length + i.newKeys + i.statusChanges;
  if (triggers > 0) {
    if (age < MOVE_COOLDOWN_SECONDS) {
      return {
        post: false,
        code: "refuse-cooldown",
        reason: `${triggers} trigger(s) but the last post was only ${age}s ago, inside the ${MOVE_COOLDOWN_SECONDS}s cooldown`,
        ...base,
      };
    }
    const worst = i.moved.reduce((m, x) => (x.bps > m ? x.bps : m), 0);
    return {
      post: true,
      code: "post-movement",
      reason:
        `${i.moved.length} measured value(s) moved more than ${MOVE_BPS} bps` +
        (worst ? ` (worst ${worst} bps)` : "") +
        (i.newKeys ? `, ${i.newKeys} new key(s)` : "") +
        (i.statusChanges ? `, ${i.statusChanges} status change(s)` : "") +
        `, and the last post was ${age}s ago`,
      ...base,
    };
  }

  return {
    post: false,
    code: "refuse-quiet",
    reason: `nothing moved more than ${MOVE_BPS} bps and the last post was ${age}s ago, inside the ${HEARTBEAT_SECONDS}s heartbeat`,
    ...base,
  };
}

function fmt(wei: bigint): string {
  return (Number(wei) / 1e18).toFixed(9);
}

/* ------------------------------------------------------------------ movement */

export interface OnchainRow {
  markUsd: bigint;
  realisableUsd: bigint;
  fillableUsd: bigint;
  status: number;
}

export interface PackedLike {
  token: string;
  form: number;
  sizeTierUsd: number;
  markUsd: bigint;
  realisableUsd: bigint;
  fillableUsd: bigint;
  status: number;
  label: string;
}

export interface MovementSummary {
  moved: Movement[];
  newKeys: number;
  statusChanges: number;
}

// moveBps lives in pack.ts and is re-exported here rather than copied: two
// definitions of the same threshold arithmetic would drift, and the one the tests
// pin must be the one the policy uses.
export { moveBps } from "./pack.js";

/**
 * What changed since the last post.
 *
 * Only MEASURED rows contribute a movement: an absent row's numbers describe a
 * partial fill that the gate refuses anyway, so paying gas to refresh one would buy
 * nothing. A row that appears or changes status is counted separately, because those
 * are shape changes rather than price changes and a consumer cannot infer them.
 */
export function computeMovement(rows: PackedLike[], onchain: Map<string, OnchainRow>): MovementSummary {
  const moved: Movement[] = [];
  let newKeys = 0;
  let statusChanges = 0;

  for (const r of rows) {
    const prev = onchain.get(`${r.token.toLowerCase()}/${r.form}/${r.sizeTierUsd}`);
    if (!prev || prev.status === 0) {
      newKeys++;
      continue;
    }
    if (prev.status !== r.status) {
      statusChanges++;
      continue;
    }
    if (r.status !== 1) continue; // only measured values count as movement
    for (const [field, a, b] of [
      ["realisableUsd", prev.realisableUsd, r.realisableUsd],
      ["markUsd", prev.markUsd, r.markUsd],
    ] as const) {
      const bps = moveBps(a, b);
      if (bps > MOVE_BPS) moved.push({ label: r.label, field, bps });
    }
  }
  return { moved, newKeys, statusChanges };
}
