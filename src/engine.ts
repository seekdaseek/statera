/**
 * statera engine.
 *
 * Produces, per token and per form, the three numbers and a status. The rules it
 * enforces matter more than the arithmetic:
 *
 *   measured    a mark was obtained AND the pools absorbed the whole size
 *   absent      the pools exist but cannot fill the size; the fillable amount is
 *               reported and nothing beyond it is extrapolated
 *   unmeasured  the RPC or the mark failed; the row carries no numbers at all
 *
 * A row is never half-real. If the mark is missing the realisable value is
 * withheld too, because a gap against an unknown mark is not a number.
 */
import { Rpc, blockTag } from "./rpc.js";
import { SEL, encAddress, encUint, word } from "./abi.js";
import { CHAIN_ID, STABLES, TOKENS, NON_FLOAT, SIZES_USD, type TokenConfig } from "./config.js";
import { loadPool, simulateExactInput, type PoolState } from "./v3/pool.js";
import { fetchMark, type Mark } from "./mark.js";

export type Status = "measured" | "absent" | "unmeasured";
export type Form = "raw" | "wrapped";

export interface Row {
  token: string;
  form: Form;
  symbol: string;
  address: string;
  sizeUsd: number;
  markUsd: number | null;
  markSource: string;
  markAgeMs: number | null;
  tokensSold: string | null;
  realisableUsd: number | null;
  gapBps: number | null;
  status: Status;
  poolsUsed: string[];
  fillableUsd: number | null;
  route: string;
  note: string;
}

export interface Report {
  chainId: number;
  block: number;
  rpcUrl: string;
  rpcCalls: number;
  generatedAt: string;
  rows: Row[];
  /** Raw-form free float, i.e. supply outside issuer custody and OKX wallets. */
  floats: { token: string; totalSupply: number; nonFloat: number; float: number; floatPct: number; nonFloatBreakdown: { label: string; amount: number }[] }[];
  multipliers: { token: string; assetsPerShare: number }[];
  pools: { label: string; address: string; fee: number; tick: number; ticksLoaded: number; wordsEachSide: number; netSumZero: boolean; activeMatches: boolean }[];
  warnings: string[];
}

const SLICES = 48;

interface PoolLeg {
  pool: PoolState;
  label: string;
  /** True when the wrapped stock is token0 and we sell token0 for token1. */
  zeroForOne: boolean;
  stableSymbol: string;
  stableDecimals: number;
}

function legFor(pool: PoolState, label: string, wrapped: string): PoolLeg | null {
  const t0 = pool.token0.toLowerCase();
  const t1 = pool.token1.toLowerCase();
  const w = wrapped.toLowerCase();
  const s0 = STABLES[t0];
  const s1 = STABLES[t1];
  if (t0 === w && s1) return { pool, label, zeroForOne: true, stableSymbol: s1.symbol, stableDecimals: s1.decimals };
  if (t1 === w && s0) return { pool, label, zeroForOne: false, stableSymbol: s0.symbol, stableDecimals: s0.decimals };
  return null;
}

/**
 * Split `amountIn` of the wrapped stock across legs, greedily by marginal
 * output. Pure arithmetic over already-loaded state, so this costs no RPC.
 */
function allocate(legs: PoolLeg[], amountIn: bigint): { out: bigint; used: bigint; usedLegs: string[] } {
  if (legs.length === 0) return { out: 0n, used: 0n, usedLegs: [] };
  if (legs.length === 1) {
    const leg = legs[0]!;
    const r = simulateExactInput(leg.pool, leg.zeroForOne, amountIn);
    return { out: r.amountOut, used: r.amountInUsed, usedLegs: r.amountOut > 0n ? [leg.label] : [] };
  }

  const alloc = new Array<bigint>(legs.length).fill(0n);
  const curOut = new Array<bigint>(legs.length).fill(0n);
  const slice = amountIn / BigInt(SLICES);
  if (slice === 0n) {
    const leg = legs[0]!;
    const r = simulateExactInput(leg.pool, leg.zeroForOne, amountIn);
    return { out: r.amountOut, used: r.amountInUsed, usedLegs: [leg.label] };
  }

  let placed = 0n;
  for (let s = 0; s < SLICES; s++) {
    const step = s === SLICES - 1 ? amountIn - placed : slice;
    if (step <= 0n) break;
    let best = -1;
    let bestGain = -1n;
    for (let i = 0; i < legs.length; i++) {
      const leg = legs[i]!;
      const r = simulateExactInput(leg.pool, leg.zeroForOne, alloc[i]! + step);
      const gain = r.amountOut - curOut[i]!;
      if (gain > bestGain) { bestGain = gain; best = i; }
    }
    if (best < 0 || bestGain <= 0n) break; // no leg can absorb more
    alloc[best] = alloc[best]! + step;
    const leg = legs[best]!;
    curOut[best] = simulateExactInput(leg.pool, leg.zeroForOne, alloc[best]!).amountOut;
    placed += step;
  }

  let out = 0n, used = 0n;
  const usedLegs: string[] = [];
  for (let i = 0; i < legs.length; i++) {
    if (alloc[i]! <= 0n) continue;
    const leg = legs[i]!;
    const r = simulateExactInput(leg.pool, leg.zeroForOne, alloc[i]!);
    out += r.amountOut;
    used += r.amountInUsed;
    if (r.amountOut > 0n) usedLegs.push(leg.label);
  }
  return { out, used, usedLegs };
}

const scale = (x: number, dp: number): bigint => BigInt(Math.round(x * 10 ** dp));
const fmt18 = (v: bigint): string => {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const i = a / 10n ** 18n;
  const f = (a % 10n ** 18n).toString().padStart(18, "0").slice(0, 6);
  return `${neg ? "-" : ""}${i}.${f}`;
};

export async function run(rpc: Rpc): Promise<Report> {
  const warnings: string[] = [];
  const chainId = await rpc.chainId();
  if (chainId !== CHAIN_ID) throw new Error(`wrong chain: expected ${CHAIN_ID}, got ${chainId}`);
  // STATERA_ENGINE_BLOCK pins the report to a specific block instead of the head.
  // Useful for a reproducible report or a backtest, and necessary against a forked
  // chain: the feed refuses an engine block above the head it sees, and a fork's head
  // is frozen while the live chain runs on.
  const pinned = process.env["STATERA_ENGINE_BLOCK"];
  const block = pinned ? Number(pinned) : await rpc.blockNumber();
  if (!Number.isFinite(block) || block <= 0) throw new Error(`bad engine block: ${pinned ?? "head"}`);
  const tag = blockTag(block);

  // Load every pool once, pinned to `block`.
  const poolStates = new Map<string, PoolState>();
  const poolErrors = new Map<string, string>();
  for (const t of TOKENS) {
    for (const p of t.pools) {
      if (poolStates.has(p.address)) continue;
      try {
        poolStates.set(p.address, await loadPool(rpc, p.address, tag, block));
      } catch (e) {
        poolErrors.set(p.address, String(e instanceof Error ? e.message : e));
      }
    }
  }

  // Wrapper share->asset rate (this is the rebasing multiplier) and raw supply/float.
  const ONE = 10n ** 18n;
  const calls: { to: string; data: string }[] = [];
  for (const t of TOKENS) {
    calls.push({ to: t.wrapped, data: SEL.convertToAssets + encUint(ONE) });
    calls.push({ to: t.raw, data: SEL.totalSupply });
    for (const w of Object.keys(NON_FLOAT)) calls.push({ to: t.raw, data: SEL.balanceOf + encAddress(w) });
  }
  const res = await rpc.callMany(calls, tag);

  const nonFloatKeys = Object.keys(NON_FLOAT);
  const stride = 2 + nonFloatKeys.length;
  const cta = new Map<string, bigint>();
  const floats: Report["floats"] = [];
  for (let i = 0; i < TOKENS.length; i++) {
    const t = TOKENS[i]!;
    const base = i * stride;
    const ctaRaw = res[base];
    if (ctaRaw) cta.set(t.rawSymbol, word(ctaRaw, 0));
    const tsRaw = res[base + 1];
    if (tsRaw) {
      const total = word(tsRaw, 0);
      let nf = 0n;
      const breakdown: { label: string; amount: number }[] = [];
      for (let k = 0; k < nonFloatKeys.length; k++) {
        const r = res[base + 2 + k];
        if (!r) continue;
        const v = word(r, 0);
        nf += v;
        if (v > 0n) breakdown.push({ label: NON_FLOAT[nonFloatKeys[k]!]!, amount: Number(v) / 1e18 });
      }
      const fl = total - nf;
      floats.push({
        token: t.rawSymbol,
        totalSupply: Number(total) / 1e18,
        nonFloat: Number(nf) / 1e18,
        float: Number(fl) / 1e18,
        floatPct: total > 0n ? (Number(fl) / Number(total)) * 100 : 0,
        nonFloatBreakdown: breakdown,
      });
    }
  }

  // Marks, independent of the pools.
  const marks = new Map<string, Mark>();
  await Promise.all(
    TOKENS.map(async (t) => {
      try {
        marks.set(t.rawSymbol, await fetchMark(t.okxInstId));
      } catch (e) {
        warnings.push(`mark unavailable for ${t.rawSymbol} (${t.okxInstId}): ${e instanceof Error ? e.message : String(e)}`);
      }
    }),
  );

  const rows: Row[] = [];
  for (const t of TOKENS) {
    const legs: PoolLeg[] = [];
    for (const p of t.pools) {
      const st = poolStates.get(p.address);
      if (!st) continue;
      const leg = legFor(st, p.label, t.wrapped);
      if (leg) legs.push(leg);
      else warnings.push(`pool ${p.address} (${p.label}) is not a ${t.wrappedSymbol}/stable pair; skipped`);
    }
    for (const p of t.pools) {
      const err = poolErrors.get(p.address);
      if (err) warnings.push(`pool ${p.address} (${p.label}) unreadable: ${err}`);
    }

    const mark = marks.get(t.rawSymbol);
    const ctaV = cta.get(t.rawSymbol);
    const stableDp = legs[0]?.stableDecimals ?? 6;

    for (const form of ["raw", "wrapped"] as Form[]) {
      const isRaw = form === "raw";
      const symbol = isRaw ? t.rawSymbol : t.wrappedSymbol;
      const address = isRaw ? t.raw : t.wrapped;
      const route = isRaw
        ? `wrap (ERC-4626 deposit, permissionless) -> ${legs.map((l) => l.label).join(" + ") || "no pool"}`
        : legs.map((l) => l.label).join(" + ") || "no pool";

      for (const sizeUsd of SIZES_USD) {
        const baseRow: Row = {
          token: t.rawSymbol, form, symbol, address, sizeUsd,
          markUsd: null, markSource: mark?.source ?? "n/a", markAgeMs: mark?.ageMs ?? null,
          tokensSold: null, realisableUsd: null, gapBps: null,
          status: "unmeasured", poolsUsed: [], fillableUsd: null, route, note: "",
        };

        if (!mark) { rows.push({ ...baseRow, note: "mark unavailable" }); continue; }
        if (ctaV === undefined) { rows.push({ ...baseRow, note: "wrapper share rate unavailable" }); continue; }
        if (legs.length === 0) {
          rows.push({ ...baseRow, markUsd: null, status: "unmeasured", note: "no readable pool for this token" });
          continue;
        }

        // Mark per unit of the form being sold.
        const markRawScaled = scale(mark.usd, 12); // USD per raw token, 1e12
        const markFormScaled = isRaw ? markRawScaled : (markRawScaled * ctaV) / ONE;
        if (markFormScaled <= 0n) { rows.push({ ...baseRow, note: "mark scaled to zero" }); continue; }
        const markUsd = Number(markFormScaled) / 1e12;

        // Tokens of the sold form, then the wrapped amount that reaches the pool.
        const tokensForm = (BigInt(sizeUsd) * 10n ** 30n) / markFormScaled;
        const wrappedIn = isRaw ? (tokensForm * ONE) / ctaV : tokensForm;

        let sim;
        try {
          sim = allocate(legs, wrappedIn);
        } catch (e) {
          rows.push({ ...baseRow, markUsd, note: `simulation failed: ${e instanceof Error ? e.message : String(e)}` });
          continue;
        }

        const realisableUsd = Number(sim.out) / 10 ** stableDp;
        const filled = sim.used >= wrappedIn - wrappedIn / 100_000n; // tolerate 0.001% dust
        if (!filled) {
          const fillableUsd = (Number(sim.used) / 1e18) * (Number(markFormScaled) / 1e12) * (isRaw ? Number(ctaV) / 1e18 : 1);
          rows.push({
            ...baseRow,
            markUsd,
            tokensSold: fmt18(sim.used),
            realisableUsd,
            gapBps: null,
            status: "absent",
            poolsUsed: sim.usedLegs,
            fillableUsd,
            note: `pools absorb only ${fmt18(sim.used)} of ${fmt18(wrappedIn)} ${t.wrappedSymbol}; that fillable part returns ${realisableUsd.toFixed(2)} USD. Nothing extrapolated beyond it.`,
          });
          continue;
        }

        const gapBps = (realisableUsd / sizeUsd - 1) * 10_000;
        rows.push({
          ...baseRow,
          markUsd,
          tokensSold: fmt18(tokensForm),
          realisableUsd,
          gapBps,
          status: "measured",
          poolsUsed: sim.usedLegs,
          note: isRaw ? "requires a wrap transaction before the swap" : "",
        });
      }
    }
  }

  const multipliers = TOKENS.map((t) => ({
    token: t.rawSymbol,
    assetsPerShare: cta.has(t.rawSymbol) ? Number(cta.get(t.rawSymbol)!) / 1e18 : NaN,
  }));

  const pools: Report["pools"] = [];
  for (const t of TOKENS) {
    for (const p of t.pools) {
      const st = poolStates.get(p.address);
      if (!st) continue;
      pools.push({
        label: p.label, address: p.address, fee: Number(st.fee), tick: st.tick,
        ticksLoaded: st.ticks.length, wordsEachSide: st.wordsEachSide,
        netSumZero: st.netSumZero, activeMatches: st.activeMatches,
      });
      if (!st.netSumZero) warnings.push(`${p.label}: tick ladder does not close (liquidityNet sums non-zero) even at +/-${st.wordsEachSide} bitmap words; depth for this pool is a lower bound`);
      if (!st.activeMatches) warnings.push(`${p.label}: nets at/below the current tick do not reconstruct liquidity(); depth for this pool is a lower bound`);
    }
  }

  warnings.push("USDG, USD₮0 and USDC are treated as USD 1:1; a depeg would bias realisable value.");

  return {
    chainId, block, rpcUrl: rpc.url, rpcCalls: rpc.calls,
    generatedAt: new Date().toISOString(), rows, floats, multipliers, pools, warnings,
  };
}
