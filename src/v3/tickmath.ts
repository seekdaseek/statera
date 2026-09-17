/**
 * Uniswap v3 TickMath.
 *
 * getSqrtRatioAtTick multiplies a chain of constants, one per set bit of |tick|.
 * The constant for bit 2^i is 2^128 * 1.0001^(-2^(i-1)) ROUNDED TO NEAREST — not
 * floored, which is a real trap: the exact floor for bit 2^1 is ...777 while the
 * value Uniswap ships is ...778, and using the floor would put every quote
 * slightly off.
 *
 * The constants are inlined so start-up costs nothing, and
 * deriveRatioConstants() recomputes them from the definition in exact rational
 * arithmetic. test/v3math.test.ts asserts that the derivation reproduces the
 * table, that the table reproduces the five literals published in the Uniswap
 * source, and that tick +/-887272 lands exactly on the published MIN/MAX sqrt
 * ratios — which exercises all twenty constants at once.
 */

export const MIN_TICK = -887272;
export const MAX_TICK = 887272;
export const Q96 = 1n << 96n;
export const Q128 = 1n << 128n;
export const MIN_SQRT_RATIO = 4295128739n;
export const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n;
const MAX_UINT256 = (1n << 256n) - 1n;

export const RATIO_CONSTANTS: readonly bigint[] = [
  0xfffcb933bd6fad37aa2d162d1a594001n,
  0xfff97272373d413259a46990580e213an,
  0xfff2e50f5f656932ef12357cf3c7fdccn,
  0xffe5caca7e10e4e61c3624eaa0941cd0n,
  0xffcb9843d60f6159c9db58835c926644n,
  0xff973b41fa98c081472e6896dfb254c0n,
  0xff2ea16466c96a3843ec78b326b52861n,
  0xfe5dee046a99a2a811c461f1969c3053n,
  0xfcbe86c7900a88aedcffc83b479aa3a4n,
  0xf987a7253ac413176f2b074cf7815e54n,
  0xf3392b0822b70005940c7a398e4b70f3n,
  0xe7159475a2c29b7443b29c7fa6e889d9n,
  0xd097f3bdfd2022b8845ad8f792aa5825n,
  0xa9f746462d870fdf8a65dc1f90e061e5n,
  0x70d869a156d2a1b890bb3df62baf32f7n,
  0x31be135f97d08fd981231505542fcfa6n,
  0x9aa508b5b7a84e1c677de54f3e99bc9n,
  0x5d6af8dedb81196699c329225ee604n,
  0x2216e584f5fa1ea926041bedfe98n,
  0x48a170391f7dc42444e8fa2n,
];

/** Integer square root (Newton). Exact floor(sqrt(n)) for n >= 0. */
export function isqrt(n: bigint): bigint {
  if (n < 0n) throw new RangeError("isqrt of negative");
  if (n < 2n) return n;
  let x = 1n << (BigInt(n.toString(2).length) / 2n + 1n);
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) break;
    x = y;
  }
  return x;
}

/**
 * Recompute the table from its definition, in exact rational arithmetic:
 * round-to-nearest of 2^128 * (10000/10001)^(2^(i-1)). Used by the tests as an
 * independent check on the inlined constants; not needed at run time.
 */
export function deriveRatioConstants(): bigint[] {
  // i = 0 has exponent 1/2, so it needs a square root: 2^128*sqrt(10000/10001).
  const arg = (Q128 * Q128 * 10000n) / 10001n;
  let c0 = isqrt(arg);
  if ((c0 + 1n) * (c0 + 1n) - arg < arg - c0 * c0) c0 += 1n; // nearest, not floor
  const out = [c0];
  let num = 10000n;
  let den = 10001n;
  for (let i = 1; i < 20; i++) {
    out.push((2n * Q128 * num + den) / (2n * den)); // round to nearest
    num *= num;
    den *= den;
  }
  return out;
}

/** sqrt(1.0001^tick) * 2^96, matching Uniswap's rounding. */
export function getSqrtRatioAtTick(tick: number): bigint {
  if (!Number.isInteger(tick)) throw new RangeError(`tick must be an integer: ${tick}`);
  const absTick = tick < 0 ? -tick : tick;
  if (absTick > MAX_TICK) throw new RangeError(`tick out of range: ${tick}`);

  let ratio = Q128;
  for (let i = 0; i < 20; i++) {
    if ((absTick >> i) & 1) {
      const c = RATIO_CONSTANTS[i];
      if (c === undefined) throw new Error("missing ratio constant");
      ratio = (ratio * c) >> 128n;
    }
  }
  if (tick > 0) ratio = MAX_UINT256 / ratio;

  // Q128.128 -> Q64.96, rounding up.
  const shifted = ratio >> 32n;
  return ratio % (1n << 32n) === 0n ? shifted : shifted + 1n;
}
