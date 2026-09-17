/**
 * Turning an engine report into feed rows.
 *
 * Kept separate from the keeper so it can be tested without a chain, and so the
 * one rule that matters is in one place: THE KEEPER NEVER INVENTS A NUMBER.
 *
 * Two conversions are easy to get wrong and are therefore done deliberately:
 *
 * 1. gapBps is recomputed from the INTEGER realisable value the way the contract
 *    recomputes it — truncating integer division against the tier's face value —
 *    rather than rounded from the engine's float. The feed rejects a gap that does
 *    not agree with the values it summarises, so deriving it any other way would
 *    make posts fail unpredictably at the boundary.
 *
 * 2. Unmeasured rows are dropped, never posted. An unmeasured row would have to
 *    carry zeros, and a zero that means "unknown" is exactly the confusion statera
 *    exists to remove. Dropping it instead lets the previous row age out and be
 *    refused as stale, which is the honest outcome.
 */
import type { Report, Row as EngineRow } from "./engine.js";
import { TOKENS } from "./config.js";

export const FORM_RAW = 0;
export const FORM_WRAPPED = 1;
export const STATUS_UNMEASURED = 0;
export const STATUS_MEASURED = 1;
export const STATUS_ABSENT = 2;

const USD = 1_000_000n;

export interface PackedRow {
  token: `0x${string}`;
  form: number;
  sizeTierUsd: number;
  markUsd: bigint;
  realisableUsd: bigint;
  fillableUsd: bigint;
  gapBps: number;
  status: number;
  /** For logs only. */
  label: string;
}

export interface PackResult {
  engineBlock: number;
  rows: PackedRow[];
  dropped: { label: string; reason: string }[];
}

/** USD float -> integer with 6 decimals, half-up, never negative. */
export function toUsd6(v: number): bigint {
  if (!Number.isFinite(v) || v <= 0) return 0n;
  return BigInt(Math.round(v * 1e6));
}

/**
 * The gap the feed will expect, computed exactly as StateraFeed.expectedGapBps does.
 * Integer division truncating toward zero — which is what Solidity does for ints.
 */
export function expectedGapBps(sizeTierUsd: number, realisableUsd6: bigint): number {
  const face = BigInt(sizeTierUsd) * USD;
  if (face === 0n) throw new Error("tier of zero has no gap");
  const num = (realisableUsd6 - face) * 10_000n;
  // BigInt division truncates toward zero for positives; force the same for negatives.
  const q = num / face;
  return Number(q);
}

/** The raw xStock address is the asset identity for both forms. */
function identityFor(tokenSymbol: string): `0x${string}` {
  const t = TOKENS.find((x) => x.rawSymbol === tokenSymbol);
  if (!t) throw new Error(`no config entry for ${tokenSymbol}`);
  return t.raw as `0x${string}`;
}

export function packReport(report: Report): PackResult {
  const rows: PackedRow[] = [];
  const dropped: { label: string; reason: string }[] = [];

  for (const r of report.rows as EngineRow[]) {
    const label = `${r.token}/${r.form}/${r.sizeUsd}`;

    if (r.status === "unmeasured") {
      dropped.push({ label, reason: `unmeasured: ${r.note || "engine reported no numbers"}` });
      continue;
    }

    const token = identityFor(r.token);
    const form = r.form === "raw" ? FORM_RAW : FORM_WRAPPED;
    const mark = toUsd6(r.markUsd ?? 0);
    const realisable = toUsd6(r.realisableUsd ?? 0);

    if (r.status === "measured") {
      if (mark === 0n || realisable === 0n) {
        dropped.push({ label, reason: "measured row missing a mark or a realisable value" });
        continue;
      }
      rows.push({
        token,
        form,
        sizeTierUsd: r.sizeUsd,
        markUsd: mark,
        realisableUsd: realisable,
        fillableUsd: 0n,
        // Derived from the integer, to agree with the contract bit for bit.
        gapBps: expectedGapBps(r.sizeUsd, realisable),
        status: STATUS_MEASURED,
        label,
      });
      continue;
    }

    // Absent: must state what would fill, and must not state a gap.
    const fillable = toUsd6(r.fillableUsd ?? 0);
    if (fillable === 0n) {
      dropped.push({ label, reason: "absent row without a fillable amount" });
      continue;
    }
    rows.push({
      token,
      form,
      sizeTierUsd: r.sizeUsd,
      markUsd: mark,
      realisableUsd: realisable,
      fillableUsd: fillable,
      gapBps: 0,
      status: STATUS_ABSENT,
      label,
    });
  }

  return { engineBlock: report.block, rows, dropped };
}

/** Tuple order must match RowInput in IStateraFeed.sol. */
export function toTuple(r: PackedRow) {
  return {
    token: r.token,
    form: r.form,
    sizeTierUsd: r.sizeTierUsd,
    markUsd: r.markUsd,
    realisableUsd: r.realisableUsd,
    fillableUsd: r.fillableUsd,
    gapBps: r.gapBps,
    status: r.status,
  };
}

/** Relative move in basis points between two integer USD values. */
export function moveBps(oldV: bigint, newV: bigint): number {
  if (oldV === 0n) return newV === 0n ? 0 : Number.POSITIVE_INFINITY;
  const d = newV > oldV ? newV - oldV : oldV - newV;
  return Number((d * 10_000n) / oldV);
}
