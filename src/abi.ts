/**
 * Hand-rolled ABI bits. Only static types and one dynamic string are needed, so
 * a dependency (and a keccak implementation) would buy nothing: every selector
 * used is a documented constant, listed here with its signature so it can be
 * checked by eye against 4byte.
 */

export const SEL = {
  // ERC-20
  balanceOf: "0x70a08231", // balanceOf(address)
  totalSupply: "0x18160ddd", // totalSupply()
  decimals: "0x313ce567", // decimals()
  symbol: "0x95d89b41", // symbol()
  // Backed rebasing token
  sharesOf: "0xf5eb42dc", // sharesOf(address)
  // ERC-4626 wrapper
  asset: "0x38d52e0f", // asset()
  convertToAssets: "0x07a2d13a", // convertToAssets(uint256)
  convertToShares: "0xc6e6f592", // convertToShares(uint256)
  // Uniswap v3 pool
  slot0: "0x3850c7bd", // slot0()
  liquidity: "0x1a686502", // liquidity()
  tickSpacing: "0xd0c93a7c", // tickSpacing()
  fee: "0xddca3f43", // fee()
  token0: "0x0dfe1681", // token0()
  token1: "0xd21220a7", // token1()
  ticks: "0xf30dba93", // ticks(int24)
  tickBitmap: "0x5339c296", // tickBitmap(int16)
} as const;

const WORD = 64;

export function encAddress(a: string): string {
  return a.replace(/^0x/, "").toLowerCase().padStart(WORD, "0");
}
export function encUint(v: bigint): string {
  if (v < 0n) throw new RangeError("encUint of negative");
  return v.toString(16).padStart(WORD, "0");
}
/** Two's-complement encoding for signed ints (int24 / int16 args). */
export function encInt(v: bigint): string {
  const x = v < 0n ? (1n << 256n) + v : v;
  return x.toString(16).padStart(WORD, "0");
}

export function word(hex: string, i: number): bigint {
  const b = hex.replace(/^0x/, "");
  const s = b.slice(i * WORD, (i + 1) * WORD);
  if (s.length < WORD) throw new RangeError(`return data too short for word ${i}`);
  return BigInt("0x" + s);
}

/** Interpret a 256-bit word as a signed integer of `bits` width. */
export function asSigned(v: bigint, bits: number): bigint {
  const b = BigInt(bits);
  const half = 1n << (b - 1n);
  const mod = 1n << b;
  const x = v & (mod - 1n);
  return x >= half ? x - mod : x;
}

export function decAddress(hex: string): string {
  return "0x" + hex.replace(/^0x/, "").slice(-40).toLowerCase();
}

export function decString(hex: string): string | null {
  const b = hex.replace(/^0x/, "");
  if (b.length < 128) return null;
  const len = Number(BigInt("0x" + b.slice(64, 128)));
  if (!Number.isFinite(len) || len <= 0 || len > 256) return null;
  return Buffer.from(b.slice(128, 128 + len * 2), "hex").toString("utf8");
}
