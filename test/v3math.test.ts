/**
 * Unit tests for the v3 math, against cases worked by hand and against the two
 * constants the Uniswap source publishes.
 *
 * The important ones are the boundary ratios: tick +/-887272 exercises every
 * one of the twenty derived multiply-shift constants, so if the derivation were
 * wrong anywhere the boundaries could not land on the published values.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getSqrtRatioAtTick, RATIO_CONSTANTS, deriveRatioConstants, isqrt, MIN_TICK, MAX_TICK,
  MIN_SQRT_RATIO, MAX_SQRT_RATIO, Q96,
} from "../src/v3/tickmath.js";
import {
  getAmount0Delta, getAmount1Delta, getNextSqrtPriceFromInput,
  mulDiv, mulDivRoundingUp, divRoundingUp,
} from "../src/v3/sqrtmath.js";
import { computeSwapStep } from "../src/v3/swapmath.js";
import { simulateExactInput, type PoolState } from "../src/v3/pool.js";

test("isqrt is exact on perfect squares and floors otherwise", () => {
  assert.equal(isqrt(0n), 0n);
  assert.equal(isqrt(1n), 1n);
  assert.equal(isqrt(4n), 2n);
  assert.equal(isqrt(15n), 3n);
  assert.equal(isqrt(16n), 4n);
  assert.equal(isqrt((1n << 128n) * (1n << 128n)), 1n << 128n);
  const n = 123456789012345678901234567890n;
  const r = isqrt(n);
  assert.ok(r * r <= n && (r + 1n) * (r + 1n) > n);
});

test("the inlined table equals an exact rational re-derivation", () => {
  // Independent recomputation: round-to-nearest of 2^128*(10000/10001)^(2^(i-1)).
  assert.deepEqual(deriveRatioConstants(), [...RATIO_CONSTANTS]);
});

test("derived tick constants reproduce the literals in the Uniswap source", () => {
  // The five leading constants of TickMath.getSqrtRatioAtTick.
  const expected = [
    0xfffcb933bd6fad37aa2d162d1a594001n,
    0xfff97272373d413259a46990580e213an,
    0xfff2e50f5f656932ef12357cf3c7fdccn,
    0xffe5caca7e10e4e61c3624eaa0941cd0n,
    0xffcb9843d60f6159c9db58835c926644n,
  ];
  for (let i = 0; i < expected.length; i++) {
    assert.equal(RATIO_CONSTANTS[i], expected[i], `constant for bit 2^${i} mismatched`);
  }
});

test("tick 0 is exactly 2^96", () => {
  assert.equal(getSqrtRatioAtTick(0), Q96);
});

test("tick boundaries equal the published MIN/MAX sqrt ratios", () => {
  // These exercise all twenty constants at once.
  assert.equal(getSqrtRatioAtTick(MIN_TICK), MIN_SQRT_RATIO);
  assert.equal(getSqrtRatioAtTick(MAX_TICK), MAX_SQRT_RATIO);
});

test("sqrt ratio is monotonic and 1.0001 per tick", () => {
  let prev = getSqrtRatioAtTick(-500);
  for (let t = -499; t <= 500; t++) {
    const cur = getSqrtRatioAtTick(t);
    assert.ok(cur > prev, `not monotonic at ${t}`);
    prev = cur;
  }
  // price(t) = 1.0001^t, so ratio(100)^2 / 2^192 should be 1.0001^100.
  const r = getSqrtRatioAtTick(100);
  const price = Number((r * r * 10n ** 12n) / (1n << 192n)) / 1e12;
  assert.ok(Math.abs(price - 1.0001 ** 100) < 1e-9, `price ${price}`);
});

test("reciprocal symmetry: ratio(t) * ratio(-t) is 2^192 to within rounding", () => {
  for (const t of [1, 7, 100, 4096, 100000, 700000]) {
    const a = getSqrtRatioAtTick(t);
    const b = getSqrtRatioAtTick(-t);
    const prod = a * b;
    const target = 1n << 192n;
    const diff = prod > target ? prod - target : target - prod;
    // Both sides are rounded up, so the product may exceed 2^192 slightly.
    assert.ok((diff * 10n ** 12n) / target < 10n ** 6n, `tick ${t} off by ${diff}`);
  }
});

test("rounding helpers", () => {
  assert.equal(mulDiv(10n, 10n, 3n), 33n);
  assert.equal(mulDivRoundingUp(10n, 10n, 3n), 34n);
  assert.equal(mulDivRoundingUp(9n, 1n, 3n), 3n);
  assert.equal(divRoundingUp(7n, 2n), 4n);
  assert.equal(divRoundingUp(8n, 2n), 4n);
});

/**
 * Hand-worked amount deltas.
 *
 * Take L = 2^96 and move the price from 1 to 4, i.e. sqrt price from 2^96 to
 * 2*2^96. The closed forms give exact powers of two:
 *   amount1 = L * (sqrtB - sqrtA) / 2^96 = 2^96 * 2^96 / 2^96      = 2^96
 *   amount0 = L * (1/sqrtA - 1/sqrtB)    = 2^96 * (1 - 1/2) / 1    = 2^95
 */
test("amount deltas match the hand-worked powers of two", () => {
  const L = 1n << 96n;
  const a = 1n << 96n;
  const b = 2n * (1n << 96n);
  assert.equal(getAmount1Delta(a, b, L, false), 1n << 96n);
  assert.equal(getAmount0Delta(a, b, L, false), 1n << 95n);
  // Swapping the price arguments must not change the answer.
  assert.equal(getAmount1Delta(b, a, L, false), 1n << 96n);
  assert.equal(getAmount0Delta(b, a, L, false), 1n << 95n);
  // Rounding up never returns less than rounding down.
  assert.ok(getAmount0Delta(a, b, L, true) >= getAmount0Delta(a, b, L, false));
  assert.ok(getAmount1Delta(a, b, L, true) >= getAmount1Delta(a, b, L, false));
});

test("next price from input inverts the amount1 delta", () => {
  const L = 1n << 96n;
  const a = 1n << 96n;
  const b = 2n * (1n << 96n);
  const dy = getAmount1Delta(a, b, L, false); // 2^96
  // Putting exactly that much token1 in must land on b (price 4).
  assert.equal(getNextSqrtPriceFromInput(a, L, dy, false), b);
});

/**
 * Hand-worked single-range swap, zero fee.
 *
 * L = 2^96, start at sqrt price 2^96 (price 1), target 2*2^96 (price 4), and
 * offer exactly 2^96 of token1. That is precisely the amount needed to reach
 * the target, so the step must consume all of it, land on the target, and
 * return 2^95 of token0.
 */
test("computeSwapStep: exact fill to the target, no fee", () => {
  const L = 1n << 96n;
  const s = computeSwapStep(1n << 96n, 2n * (1n << 96n), L, 1n << 96n, 0n);
  assert.equal(s.sqrtRatioNextX96, 2n * (1n << 96n));
  assert.equal(s.amountIn, 1n << 96n);
  assert.equal(s.amountOut, 1n << 95n);
  assert.equal(s.feeAmount, 0n);
});

test("computeSwapStep: partial fill stops short of the target", () => {
  const L = 1n << 96n;
  const half = 1n << 95n;
  const s = computeSwapStep(1n << 96n, 2n * (1n << 96n), L, half, 0n);
  assert.ok(s.sqrtRatioNextX96 < 2n * (1n << 96n), "should not reach the target");
  assert.equal(s.sqrtRatioNextX96, (1n << 96n) + half); // price moves by dy/L
  assert.equal(s.amountIn, half);
  // amount0 out = L*(1/sqrtA - 1/sqrtB) = 2^96 * (1 - 1/1.5) = 2^96/3
  assert.equal(s.amountOut, (1n << 96n) / 3n);
});

/**
 * Fee accounting. When the step reaches its target the fee is charged on top of
 * the input at feePips/(1e6 - feePips), rounded up.
 */
test("computeSwapStep: fee is charged on top when the target is reached", () => {
  const L = 1n << 96n;
  const feePips = 3000n; // 0.3%
  const need = 1n << 96n; // input required to reach the target, before fee
  // Offer generously so the target is reached.
  const s = computeSwapStep(1n << 96n, 2n * (1n << 96n), L, need * 2n, feePips);
  assert.equal(s.sqrtRatioNextX96, 2n * (1n << 96n));
  assert.equal(s.amountIn, need);
  assert.equal(s.feeAmount, mulDivRoundingUp(need, feePips, 1_000_000n - feePips));
});

test("computeSwapStep: the fee reduces how far a fixed input reaches", () => {
  const L = 1n << 96n;
  const noFee = computeSwapStep(1n << 96n, 4n * (1n << 96n), L, 1n << 96n, 0n);
  const withFee = computeSwapStep(1n << 96n, 4n * (1n << 96n), L, 1n << 96n, 3000n);
  assert.ok(withFee.amountOut < noFee.amountOut);
  assert.ok(withFee.sqrtRatioNextX96 < noFee.sqrtRatioNextX96);
  // The whole offered amount is spent either way (input + fee).
  assert.equal(withFee.amountIn + withFee.feeAmount, 1n << 96n);
});

test("exact-output is refused rather than silently mishandled", () => {
  assert.throws(() => computeSwapStep(1n << 96n, 2n * (1n << 96n), 1n << 96n, -1n, 0n), /exact-output/);
});

/** A synthetic two-range pool, so the tick-crossing path is covered offline. */
function syntheticPool(): PoolState {
  return {
    address: "0xpool", token0: "0xt0", token1: "0xt1", dec0: 6, dec1: 18,
    fee: 0n, tickSpacing: 10, sqrtPriceX96: getSqrtRatioAtTick(0), tick: 0,
    liquidity: 1n << 96n,
    // Liquidity doubles above tick 100 and ends at tick 200.
    ticks: [
      { tick: -200, liquidityNet: 1n << 96n },
      { tick: 100, liquidityNet: 1n << 96n },
      { tick: 200, liquidityNet: -(1n << 97n) },
    ],
    loadedTickLo: -20480, loadedTickHi: 20480, block: 0,
    netSumZero: true, activeMatches: true, wordsEachSide: 8,
  };
}

test("simulateExactInput crosses ticks and picks up liquidity", () => {
  const p = syntheticPool();
  // Small trade stays inside the first range: no crossings.
  const small = simulateExactInput(p, false, 1n << 80n);
  assert.equal(small.ticksCrossed, 0);
  assert.equal(small.exhausted, false);
  assert.ok(small.amountOut > 0n);

  // Large trade must cross tick 100 and then run out at tick 200.
  const large = simulateExactInput(p, false, 1n << 96n);
  assert.ok(large.ticksCrossed >= 1, "expected at least one crossing");
  assert.equal(large.exhausted, true, "liquidity ends at tick 200");
  assert.ok(large.amountInUsed < (1n << 96n), "cannot absorb the whole input");
});

test("simulateExactInput is pure: the pool state is unchanged", () => {
  const p = syntheticPool();
  const before = JSON.stringify(p, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  simulateExactInput(p, false, 1n << 90n);
  simulateExactInput(p, true, 1n << 90n);
  const after = JSON.stringify(p, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  assert.equal(before, after);
});

test("more input never returns less output (monotonicity)", () => {
  const p = syntheticPool();
  let prev = 0n;
  for (const n of [70n, 75n, 80n, 85n, 90n, 93n]) {
    const r = simulateExactInput(p, false, 1n << n);
    assert.ok(r.amountOut >= prev, `output fell at 2^${n}`);
    prev = r.amountOut;
  }
});

test("an empty ladder cannot fill anything", () => {
  const p = { ...syntheticPool(), ticks: [] };
  const r = simulateExactInput(p, false, 1n << 90n);
  assert.equal(r.exhausted, true);
  assert.equal(r.amountOut, 0n);
  assert.equal(r.amountInUsed, 0n);
});
