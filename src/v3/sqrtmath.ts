/** Uniswap v3 SqrtPriceMath, ported to BigInt. Rounding directions preserved. */
import { Q96 } from "./tickmath.js";

const MAX_UINT160 = (1n << 160n) - 1n;

export function mulDiv(a: bigint, b: bigint, d: bigint): bigint {
  if (d === 0n) throw new RangeError("mulDiv by zero");
  return (a * b) / d;
}
export function mulDivRoundingUp(a: bigint, b: bigint, d: bigint): bigint {
  if (d === 0n) throw new RangeError("mulDiv by zero");
  const p = a * b;
  return p / d + (p % d === 0n ? 0n : 1n);
}
export function divRoundingUp(a: bigint, d: bigint): bigint {
  return a / d + (a % d === 0n ? 0n : 1n);
}

/** token0 amount between two prices for a given liquidity. */
export function getAmount0Delta(sqrtA: bigint, sqrtB: bigint, liquidity: bigint, roundUp: boolean): bigint {
  let a = sqrtA, b = sqrtB;
  if (a > b) [a, b] = [b, a];
  if (a <= 0n) throw new RangeError("sqrt price must be positive");
  const numerator1 = liquidity << 96n;
  const numerator2 = b - a;
  return roundUp
    ? divRoundingUp(mulDivRoundingUp(numerator1, numerator2, b), a)
    : mulDiv(numerator1, numerator2, b) / a;
}

/** token1 amount between two prices for a given liquidity. */
export function getAmount1Delta(sqrtA: bigint, sqrtB: bigint, liquidity: bigint, roundUp: boolean): bigint {
  let a = sqrtA, b = sqrtB;
  if (a > b) [a, b] = [b, a];
  return roundUp ? mulDivRoundingUp(liquidity, b - a, Q96) : mulDiv(liquidity, b - a, Q96);
}

export function getNextSqrtPriceFromAmount0RoundingUp(sqrtP: bigint, liquidity: bigint, amount: bigint, add: boolean): bigint {
  if (amount === 0n) return sqrtP;
  const numerator1 = liquidity << 96n;
  if (add) {
    const product = amount * sqrtP;
    if (product / amount === sqrtP) {
      const denominator = numerator1 + product;
      if (denominator >= numerator1) return mulDivRoundingUp(numerator1, sqrtP, denominator);
    }
    return divRoundingUp(numerator1, numerator1 / sqrtP + amount);
  }
  const product = amount * sqrtP;
  if (!(product / amount === sqrtP && numerator1 > product)) throw new RangeError("amount0 exceeds reserves");
  const denominator = numerator1 - product;
  return mulDivRoundingUp(numerator1, sqrtP, denominator);
}

export function getNextSqrtPriceFromAmount1RoundingDown(sqrtP: bigint, liquidity: bigint, amount: bigint, add: boolean): bigint {
  if (add) {
    const quotient = amount <= MAX_UINT160 ? (amount << 96n) / liquidity : mulDiv(amount, Q96, liquidity);
    return sqrtP + quotient;
  }
  const quotient = amount <= MAX_UINT160 ? divRoundingUp(amount << 96n, liquidity) : mulDivRoundingUp(amount, Q96, liquidity);
  if (sqrtP <= quotient) throw new RangeError("amount1 exceeds reserves");
  return sqrtP - quotient;
}

/** Price after putting `amountIn` in, given direction. */
export function getNextSqrtPriceFromInput(sqrtP: bigint, liquidity: bigint, amountIn: bigint, zeroForOne: boolean): bigint {
  if (sqrtP <= 0n || liquidity <= 0n) throw new RangeError("bad pool state");
  return zeroForOne
    ? getNextSqrtPriceFromAmount0RoundingUp(sqrtP, liquidity, amountIn, true)
    : getNextSqrtPriceFromAmount1RoundingDown(sqrtP, liquidity, amountIn, true);
}
