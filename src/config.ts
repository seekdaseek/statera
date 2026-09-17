/**
 * Address registry for X Layer (chain 196). Every address here was verified
 * on-chain: symbol()/decimals() read from the contract, and for pools
 * token0()/token1()/fee() read from the pool itself. Nothing is inferred from a
 * naming convention.
 */

export const CHAIN_ID = 196;
export const DEFAULT_RPC = "https://rpc.xlayer.tech";

export interface StableInfo {
  symbol: string;
  address: string;
  decimals: number;
}

/** Quote assets treated as USD 1:1. A depeg would bias realisable value. */
export const STABLES: Record<string, StableInfo> = {
  "0x4ae46a509f6b1d9056937ba4500cb143933d2dc8": { symbol: "USDG", address: "0x4ae46a509f6b1d9056937ba4500cb143933d2dc8", decimals: 6 },
  "0x779ded0c9e1022225f8e0630b35a9b54be713736": { symbol: "USD₮0", address: "0x779ded0c9e1022225f8e0630b35a9b54be713736", decimals: 6 },
  "0xb6ceceab302e2e4948951ee7843fc24e92933061": { symbol: "USDC", address: "0xb6ceceab302e2e4948951ee7843fc24e92933061", decimals: 6 },
};

export interface TokenConfig {
  /** Raw rebasing xStock. */
  rawSymbol: string;
  raw: string;
  /** Non-rebasing ERC-4626 wrapper, the form that actually trades. */
  wrappedSymbol: string;
  wrapped: string;
  /** OKX spot instrument used as the independent mark. */
  okxInstId: string;
  /** v3 pools pairing the wrapper against a stable. */
  pools: { address: string; label: string }[];
}

export const TOKENS: TokenConfig[] = [
  {
    rawSymbol: "NVDAx",
    raw: "0xc845b2894dbddd03858fd2d643b4ef725fe0849d",
    wrappedSymbol: "wNVDAx",
    wrapped: "0xa8ddb5cd96b5222afe198316e9a57caa642850d5",
    okxInstId: "XNVDA-USDT",
    pools: [
      { address: "0x2a2b11730c2b6d99a58034a869dd810d7300a7b2", label: "v3 USDG/wNVDAx" },
      { address: "0xa575234cc82be1dd41d133ca33e879287d6751a0", label: "v3 USD₮0/wNVDAx" },
    ],
  },
  {
    rawSymbol: "TSLAx",
    raw: "0x8ad3c73f833d3f9a523ab01476625f269aeb7cf0",
    wrappedSymbol: "wTSLAx",
    wrapped: "0xc3fdbe3a68ee5de461d30415a8165cf9aefe1171",
    okxInstId: "XTSLA-USDT",
    pools: [
      { address: "0x6a58944eed3d2074e137eb4e94b302fe4af247a6", label: "v3 USDC/wTSLAx" },
      { address: "0xe1071db4691b325c709854dc3d5ccd5d77e62ed1", label: "v3 USDG/wTSLAx" },
    ],
  },
  {
    rawSymbol: "SPYx",
    raw: "0x90a2a4c76b5d8c0bc892a69ea28aa775a8f2dd48",
    wrappedSymbol: "wSPYx",
    wrapped: "0xe7e553cd128f0011777323a0b44a7b96ea1cb540",
    okxInstId: "XSPY-USDT",
    pools: [{ address: "0x07c40850d14064d20eb0afdef9574675392f2c11", label: "v3 USDG/wSPYx" }],
  },
];

/** Wallets whose holdings are not free float: issuer custody and OKX's own. */
export const NON_FLOAT: Record<string, string> = {
  "0x5f7a4c11bde4f218f0025ef444c369d838ffa2ad": "issuer custody EOA",
  "0x5075ff68a0efb54db13423ad924bd680327d305e": "OKX Deposit_1",
  "0xe64b0f1a50ba340426861f29327e9eaa7fb404ad": "OKX Hot Wallet_167",
  "0x70789bca54e332ee446287a612df29b4c19b1c23": "OKX Hot Wallet_210",
  "0x6e06bac60daaef305ab40e9f10630ede2888fb37": "OKX User",
};

/**
 * Sizes to quote, in USD. Overridable with STATERA_SIZES (comma separated) so
 * the absent path can be exercised against real liquidity without editing code.
 */
export const SIZES_USD: number[] = (() => {
  const env = process.env["STATERA_SIZES"];
  if (!env) return [1_000, 10_000, 100_000];
  const v = env.split(",").map((x) => Number(x.trim())).filter((n) => Number.isFinite(n) && n > 0);
  return v.length ? v : [1_000, 10_000, 100_000];
})();
