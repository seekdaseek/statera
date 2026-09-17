/**
 * Uniswap v3 pool state, loaded once per report and then simulated purely in
 * memory.
 *
 * The tick ladder is read from tickBitmap/ticks over a window around the current
 * tick and kept as a flat array of (tick, liquidityNet), so memory is constant
 * regardless of pool age. The window EXPANDS until the ladder proves itself
 * complete, because a truncated ladder silently understates depth.
 *
 * Two integrity facts are recorded and carried into the report:
 *
 *   sum of every liquidityNet == 0          no position's upper bound is missing
 *   sum of nets at/below tick == liquidity()  the pool's own active liquidity is
 *                                           reconstructed, which independently
 *                                           confirms the sign convention
 *
 * Measured consequence worth knowing: a pool's token balance is NOT its depth.
 * The USDG/wTSLAx pool on X Layer holds ~13,357 USDG while its positions can
 * release about 5 — the rest sits in the contract outside any position and can
 * never be swapped out.
 */
import { Rpc } from "../rpc.js";
import { SEL, encInt, word, asSigned, decAddress } from "../abi.js";
import { getSqrtRatioAtTick, MIN_TICK, MAX_TICK } from "./tickmath.js";
import { computeSwapStep } from "./swapmath.js";

export interface PoolState {
  address: string;
  token0: string;
  token1: string;
  dec0: number;
  dec1: number;
  fee: bigint;
  tickSpacing: number;
  sqrtPriceX96: bigint;
  tick: number;
  liquidity: bigint;
  /** Ascending by tick. */
  ticks: { tick: number; liquidityNet: bigint }[];
  loadedTickLo: number;
  loadedTickHi: number;
  block: number;
  netSumZero: boolean;
  activeMatches: boolean;
  wordsEachSide: number;
}

export interface SimResult {
  /** Input actually consumed, including fees. */
  amountInUsed: bigint;
  amountOut: bigint;
  /** True when the pool's liquidity ran out before the input was absorbed. */
  exhausted: boolean;
  endSqrtPriceX96: bigint;
  ticksCrossed: number;
}

const START_WORDS = 8;
const MAX_WORDS = 512; // a full-range position sits at +/-887272 ticks

async function readLadder(
  rpc: Rpc, address: string, block: string, tickSpacing: number, centreWord: number, wordsEachSide: number,
): Promise<{ tick: number; liquidityNet: bigint }[]> {
  const words: number[] = [];
  for (let w = centreWord - wordsEachSide; w <= centreWord + wordsEachSide; w++) words.push(w);

  const bitmaps = await rpc.callMany(
    words.map((w) => ({ to: address, data: SEL.tickBitmap + encInt(BigInt(w)) })),
    block,
  );

  const initialized: number[] = [];
  for (let i = 0; i < words.length; i++) {
    const raw = bitmaps[i];
    const w = words[i];
    if (!raw || w === undefined) continue;
    const bits = BigInt(raw);
    if (bits === 0n) continue;
    for (let b = 0; b < 256; b++) {
      if ((bits >> BigInt(b)) & 1n) {
        const t = (w * 256 + b) * tickSpacing;
        if (t >= MIN_TICK && t <= MAX_TICK) initialized.push(t);
      }
    }
  }
  initialized.sort((a, b) => a - b);

  const tickData = await rpc.callMany(
    initialized.map((t) => ({ to: address, data: SEL.ticks + encInt(BigInt(t)) })),
    block,
  );
  const out: { tick: number; liquidityNet: bigint }[] = [];
  for (let i = 0; i < initialized.length; i++) {
    const raw = tickData[i];
    const t = initialized[i];
    if (!raw || t === undefined) continue;
    // Tick.Info: liquidityGross (word 0), liquidityNet (word 1, int128).
    out.push({ tick: t, liquidityNet: asSigned(word(raw, 1), 128) });
  }
  return out;
}

/** Load everything the simulation needs, pinned to one block. */
export async function loadPool(rpc: Rpc, address: string, block: string, blockNumber: number): Promise<PoolState> {
  const head = await rpc.callMany(
    [
      { to: address, data: SEL.slot0 },
      { to: address, data: SEL.liquidity },
      { to: address, data: SEL.tickSpacing },
      { to: address, data: SEL.fee },
      { to: address, data: SEL.token0 },
      { to: address, data: SEL.token1 },
    ],
    block,
  );
  const [slot0, liq, spacingRaw, feeRaw, t0Raw, t1Raw] = head;
  if (!slot0 || !liq || !spacingRaw || !feeRaw || !t0Raw || !t1Raw) {
    throw new Error(`pool ${address}: core getters did not answer`);
  }
  const sqrtPriceX96 = word(slot0, 0);
  const tick = Number(asSigned(word(slot0, 1), 24));
  const liquidity = word(liq, 0);
  const tickSpacing = Number(word(spacingRaw, 0));
  const fee = word(feeRaw, 0);
  const token0 = decAddress(t0Raw);
  const token1 = decAddress(t1Raw);
  if (tickSpacing <= 0) throw new Error(`pool ${address}: bad tickSpacing ${tickSpacing}`);

  const decs = await rpc.callMany(
    [{ to: token0, data: SEL.decimals }, { to: token1, data: SEL.decimals }],
    block,
  );
  if (!decs[0] || !decs[1]) throw new Error(`pool ${address}: token decimals unavailable`);
  const dec0 = Number(word(decs[0], 0));
  const dec1 = Number(word(decs[1], 0));

  const centreWord = Math.floor(tick / tickSpacing) >> 8;

  let wordsEachSide = START_WORDS;
  let ticks = await readLadder(rpc, address, block, tickSpacing, centreWord, wordsEachSide);
  let netSum = ticks.reduce((a, t) => a + t.liquidityNet, 0n);
  let active = ticks.filter((t) => t.tick <= tick).reduce((a, t) => a + t.liquidityNet, 0n);

  // Expand until the ladder closes, so depth is never understated by the window.
  while ((netSum !== 0n || active !== liquidity) && wordsEachSide < MAX_WORDS) {
    wordsEachSide = Math.min(wordsEachSide * 4, MAX_WORDS);
    ticks = await readLadder(rpc, address, block, tickSpacing, centreWord, wordsEachSide);
    netSum = ticks.reduce((a, t) => a + t.liquidityNet, 0n);
    active = ticks.filter((t) => t.tick <= tick).reduce((a, t) => a + t.liquidityNet, 0n);
  }

  return {
    address, token0, token1, dec0, dec1, fee, tickSpacing,
    sqrtPriceX96, tick, liquidity, ticks,
    loadedTickLo: (centreWord - wordsEachSide) * 256 * tickSpacing,
    loadedTickHi: ((centreWord + wordsEachSide) * 256 + 255) * tickSpacing,
    block: blockNumber,
    netSumZero: netSum === 0n,
    activeMatches: active === liquidity,
    wordsEachSide,
  };
}

/** Next initialized tick in the direction of travel. */
function nextTick(pool: PoolState, tick: number, zeroForOne: boolean): { tick: number; liquidityNet: bigint } | undefined {
  const a = pool.ticks;
  if (zeroForOne) {
    for (let i = a.length - 1; i >= 0; i--) {
      const e = a[i];
      if (e && e.tick <= tick) return e;
    }
    return undefined;
  }
  for (let i = 0; i < a.length; i++) {
    const e = a[i];
    if (e && e.tick > tick) return e;
  }
  return undefined;
}

/**
 * Exact-input swap against the loaded state. Pure: touches no network and does
 * not mutate `pool`, so one state can be simulated many times, which is what
 * the multi-pool split search does.
 */
export function simulateExactInput(pool: PoolState, zeroForOne: boolean, amountIn: bigint): SimResult {
  let sqrtP = pool.sqrtPriceX96;
  let liquidity = pool.liquidity;
  let tick = pool.tick;
  let remaining = amountIn;
  let amountOut = 0n;
  let used = 0n;
  let crossed = 0;
  let exhausted = false;

  const MAX_STEPS = 20_000;
  let step = 0;
  for (; step < MAX_STEPS; step++) {
    if (remaining <= 0n) break;
    const next = nextTick(pool, tick, zeroForOne);
    if (!next) { exhausted = true; break; } // liquidity ends here

    const sqrtNext = getSqrtRatioAtTick(next.tick);

    if (liquidity === 0n) {
      // Gap with no liquidity: cross to the next initialized tick, trading nothing.
      liquidity += zeroForOne ? -next.liquidityNet : next.liquidityNet;
      tick = zeroForOne ? next.tick - 1 : next.tick;
      sqrtP = sqrtNext;
      crossed++;
      continue;
    }

    const s = computeSwapStep(sqrtP, sqrtNext, liquidity, remaining, pool.fee);
    const spent = s.amountIn + s.feeAmount;
    remaining -= spent;
    used += spent;
    amountOut += s.amountOut;

    if (s.sqrtRatioNextX96 === sqrtNext) {
      liquidity += zeroForOne ? -next.liquidityNet : next.liquidityNet;
      tick = zeroForOne ? next.tick - 1 : next.tick;
      sqrtP = sqrtNext;
      crossed++;
      if (spent === 0n && remaining > 0n && liquidity === 0n) continue;
    } else {
      sqrtP = s.sqrtRatioNextX96;
      remaining = 0n;
      break;
    }
  }
  if (step >= MAX_STEPS) exhausted = true;

  return { amountInUsed: used, amountOut, exhausted, endSqrtPriceX96: sqrtP, ticksCrossed: crossed };
}

/** Spot price of token1 measured in token0, as a float (display only). */
export function spotToken1InToken0(pool: PoolState): number {
  const r = Number(pool.sqrtPriceX96) / 2 ** 96;
  const p0in1 = (r * r * 10 ** pool.dec0) / 10 ** pool.dec1;
  return 1 / p0in1;
}
