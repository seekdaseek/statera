/**
 * The little bit of memory a budget-capped keeper needs between cron runs.
 *
 * The chain already knows when the last post happened, so that is read from the feed
 * rather than cached here. What the chain cannot tell us is how many posts have been
 * made today — `eth_getLogs` is capped at 100-block windows on the public RPC and a
 * UTC day is ~86,400 blocks — so the daily counter lives in this file.
 *
 * It also records which alerts have already fired, so crossing the balance floor
 * pages once rather than every ten minutes for a week.
 *
 * A missing or corrupt file is not an error: it reads back as a fresh state. The
 * failure mode that matters is the opposite one — refusing to run because a counter
 * file is unparseable would take the feed down over a formatting problem.
 */
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { utcDay } from "./policy.js";

export interface KeeperState {
  /** UTC day the counter belongs to. */
  counterDay: string;
  postsToday: number;
  /** UTC day on which each alert kind was last sent, for one-per-day debouncing. */
  alertedOn: Record<string, string>;
  /** Set once the balance floor has been reported; cleared if the balance recovers. */
  balanceFloorAlerted: boolean;
  /** Last post transaction, for the log trail. */
  lastTxHash?: string;
}

export const STATE_PATH = process.env["STATERA_STATE"] ?? "/opt/statera/keeper-state.json";

export function emptyState(nowSec: number): KeeperState {
  return { counterDay: utcDay(nowSec), postsToday: 0, alertedOn: {}, balanceFloorAlerted: false };
}

export function loadState(nowSec: number, path = STATE_PATH): KeeperState {
  try {
    const j = JSON.parse(readFileSync(path, "utf8")) as Partial<KeeperState>;
    return {
      counterDay: typeof j.counterDay === "string" ? j.counterDay : utcDay(nowSec),
      postsToday: Number.isFinite(j.postsToday as number) && (j.postsToday as number) >= 0 ? (j.postsToday as number) : 0,
      alertedOn: j.alertedOn && typeof j.alertedOn === "object" ? (j.alertedOn as Record<string, string>) : {},
      balanceFloorAlerted: j.balanceFloorAlerted === true,
      ...(typeof j.lastTxHash === "string" ? { lastTxHash: j.lastTxHash } : {}),
    };
  } catch {
    return emptyState(nowSec);
  }
}

/** Write via a temp file and rename, so a crash mid-write cannot corrupt the counter. */
export function saveState(s: KeeperState, path = STATE_PATH): void {
  try {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(s, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, path);
  } catch {
    /* state is an optimisation, not a prerequisite; never fail a run over it */
  }
}

/** Roll the counter into today if it belongs to an earlier UTC day. */
export function rollDay(s: KeeperState, nowSec: number): KeeperState {
  const today = utcDay(nowSec);
  if (s.counterDay === today) return s;
  return { ...s, counterDay: today, postsToday: 0 };
}

/** True when this alert kind has not been sent yet today. */
export function alertDue(s: KeeperState, kind: string, nowSec: number): boolean {
  return s.alertedOn[kind] !== utcDay(nowSec);
}

export function markAlerted(s: KeeperState, kind: string, nowSec: number): KeeperState {
  return { ...s, alertedOn: { ...s.alertedOn, [kind]: utcDay(nowSec) } };
}
