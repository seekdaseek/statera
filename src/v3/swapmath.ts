/** Uniswap v3 SwapMath.computeSwapStep, exact-input path. */
import {
  getAmount0Delta, getAmount1Delta, getNextSqrtPriceFromInput, mulDiv, mulDivRoundingUp,
} from "./sqrtmath.js";

const MILLION = 1_000_000n;

export interface SwapStep {
  sqrtRatioNextX96: bigint;
  amountIn: bigint;
  amountOut: bigint;
  feeAmount: bigint;
}

/**
 * One step of a swap, from the current price toward a target price.
 * Exact-input only (amountRemaining > 0), which is all statera needs.
 */
export function computeSwapStep(
  sqrtRatioCurrentX96: bigint,
  sqrtRatioTargetX96: bigint,
  liquidity: bigint,
  amountRemaining: bigint,
  feePips: bigint,
): SwapStep {
  if (amountRemaining < 0n) throw new RangeError("exact-output not supported");
  const zeroForOne = sqrtRatioCurrentX96 >= sqrtRatioTargetX96;

  const amountRemainingLessFee = mulDiv(amountRemaining, MILLION - feePips, MILLION);
  let amountIn = zeroForOne
    ? getAmount0Delta(sqrtRatioTargetX96, sqrtRatioCurrentX96, liquidity, true)
    : getAmount1Delta(sqrtRatioCurrentX96, sqrtRatioTargetX96, liquidity, true);

  let sqrtRatioNextX96: bigint;
  if (amountRemainingLessFee >= amountIn) {
    sqrtRatioNextX96 = sqrtRatioTargetX96;
  } else {
    sqrtRatioNextX96 = getNextSqrtPriceFromInput(sqrtRatioCurrentX96, liquidity, amountRemainingLessFee, zeroForOne);
  }

  const max = sqrtRatioTargetX96 === sqrtRatioNextX96;
  let amountOut: bigint;
  if (zeroForOne) {
    amountIn = max ? amountIn : getAmount0Delta(sqrtRatioNextX96, sqrtRatioCurrentX96, liquidity, true);
    amountOut = getAmount1Delta(sqrtRatioNextX96, sqrtRatioCurrentX96, liquidity, false);
  } else {
    amountIn = max ? amountIn : getAmount1Delta(sqrtRatioCurrentX96, sqrtRatioNextX96, liquidity, true);
    amountOut = getAmount0Delta(sqrtRatioCurrentX96, sqrtRatioNextX96, liquidity, false);
  }

  // If we did not reach the target, the remainder of the input is the fee.
  const feeAmount = !max
    ? amountRemaining - amountIn
    : mulDivRoundingUp(amountIn, feePips, MILLION - feePips);

  return { sqrtRatioNextX96, amountIn, amountOut, feeAmount };
}
