# statera

For tokenized stocks on X Layer (chain 196), statera publishes three numbers side
by side: an **independent mark**, the **realisable value** of selling a given size
into live onchain liquidity, and the **gap in basis points** — each with a status
of `measured`, `absent` or `unmeasured`.

Read-only. It signs nothing, sends nothing and holds no keys. The only JSON-RPC
methods used are `eth_chainId`, `eth_blockNumber`, `eth_call`, `eth_getStorageAt`
and (tests only) `eth_getLogs`.

```bash
npm install
npm run build
npm start            # table
npm run json         # machine-readable
npm test             # unit + live
```

## What it measures, and why it is shaped this way

Raw xStocks barely trade onchain. The tradable form is a **wrapper**, and the two
forms are reported side by side so a holder can see which one they can actually
sell. Four findings from the research gate drive the design.

### 1. The mark must come from another venue

A Uniswap pool's own `slot0` price against that same pool's depth measures
slippage, not mispricing — the gap would be a tautology. OKX's public spot order
book lists the same tokenized stocks and needs no key, so it is the mark:

| token | OKX instrument | note |
|---|---|---|
| NVDAx | `XNVDA-USDT` | also `XNVDA-USDC` |
| TSLAx | `XTSLA-USDT` | also `XTSLA-USDC` |
| SPYx  | `XSPY-USDT`  | also `XSPY-USDC` |

The naming is a prefix `X`, not the suffix `x` used onchain. Mid of bid/ask is
used, and the exchange timestamp is carried through as `markAgeMs` (observed
sub-second). If the mark fails, the row is `unmeasured` and carries no numbers —
a gap against an unknown mark is not a number.

### 2. The wrappers are ERC-4626 vaults, not 1:1 wrappers

Each `Wrapped <name> xStock` is a proxy over one verified implementation,
`WrappedBackedTokenImplementation` at
`0x76c6851ea0b2741eedcbbed240715e8817e85583` — Backed Finance's own contract, not
a third party's. All three share that implementation, the proxy admin
`0x312063009e74142339edc92bcff6cfcfaa958bfa`, and an `owner()` of
`0x49754062e35f7591b93cc4f9915965be89643a65`, which is also the `owner()` of the
xStock tokens themselves.

They are **not** redeemable 1:1. `wrapper.totalSupply()` equals
`xStock.sharesOf(wrapper)` exactly, so **one wrapped token is one raw share**, and
`convertToAssets(1e18)` returns the rebasing multiplier:

```
wNVDAx  1.001701197 NVDAx per wNVDAx
wTSLAx  1.000000000 TSLAx per wTSLAx
wSPYx   1.005714560 SPYx  per wSPYx
```

So the wrapped token is worth *more* than the raw token by exactly that factor.
Applying it is not cosmetic: skip it and statera would print a phantom gap of up
to 57 bps. `maxDeposit`/`maxMint` are unlimited, so wrapping is **permissionless**
— which is why the raw form is quoted at all: its route is `wrap -> pool`, and it
needs one extra transaction before the swap.

### 3. `balanceOf` is already adjusted; `sharesOf` is raw

Settled on MMMx, whose multiplier is not 1:

```
MMMx   balanceOf(custody) 36342.30951450
       sharesOf(custody)  36231.76780003   ratio 1.003050961
TSLAx  balanceOf == sharesOf              ratio 1.000000000
```

The ratio equals the multiplier, so `balanceOf` and `totalSupply` return
multiplier-applied amounts and must **not** be scaled again. TSLAx alone would
have been misleading: its ratio is 1 only because its multiplier is 1. There is
no plain `multiplier()` getter on the token — the wrapper's `convertToAssets` is
the accessible one.

### 4. No QuoterV2, so the math is exact and validated against real swaps

No QuoterV2 is deployed for factory
`0x4b2ab38dbf28d31d467aa8993f6c2585981d6804` that could be found on chain 196.
Two routers do sit on that factory — `0x4f0c28f5926afda16bf2506d5d9e57ea190f9bca`
(SwapRouter02) and `0x7078c4537c04c2b2e52ddba06074dbdacf23ca15` — and both revert
on the `Quoter` and `QuoterV2` ABIs, as routers should.

The pools expose everything tick-walking needs: `slot0`, `liquidity`,
`tickSpacing`, `fee`, `ticks(int24)` and `tickBitmap(int16)`. So statera
implements exact v3 math and validates it against **swaps that already
executed**: load the pool at the block before a historical `Swap` event, replay
the event's own input, and compare with what the chain paid out. A sample counts
only when the simulated end `sqrtPriceX96` equals the event's, which proves the
pre-swap state was the right one. On every validated sample the predicted output
matches the actual output **exactly**.

## Two traps the numbers depend on

**A pool's token balance is not its depth.** The USDG/wTSLAx pool holds about
13,357 USDG while its positions can release roughly 5. Scanning ticks −92,160 to
524,790 found only 10 initialized ticks with `liquidityNet` summing to exactly 0,
so the ladder is provably complete: the rest of that balance sits in the contract
outside any position and can never be swapped out. Quoting depth from balances
would overstate that pool by three orders of magnitude.

**The tick ladder has to prove itself.** Every pool load records two facts, both
surfaced in the report and asserted in the tests:

- `netSumZero` — every `liquidityNet` sums to zero, so no position's upper bound
  fell outside the loaded window. Selling walks upward, so this is the condition
  that matters.
- `activeMatches` — the nets at or below the current tick reconstruct the pool's
  own `liquidity()`. This is an independent check of the sign convention; if the
  walk direction were inverted it would not agree.

The window starts at ±8 bitmap words and **expands** until both hold, so depth is
never understated by an arbitrary bound.

## Statuses

| status | meaning |
|---|---|
| `measured` | a mark was obtained and the pools absorbed the whole size |
| `absent` | the pools exist but cannot fill the size. The fillable amount and what it returns are reported; **no gap is published** and nothing is extrapolated beyond real liquidity |
| `unmeasured` | the RPC or the mark failed. The row carries no numbers at all |

## Addresses

All verified on-chain: `symbol()`/`decimals()` read from each token, and
`token0()`/`token1()`/`fee()` read from each pool.

| | address |
|---|---|
| NVDAx / wNVDAx | `0xc845b2894dbddd03858fd2d643b4ef725fe0849d` / `0xa8ddb5cd96b5222afe198316e9a57caa642850d5` |
| TSLAx / wTSLAx | `0x8ad3c73f833d3f9a523ab01476625f269aeb7cf0` / `0xc3fdbe3a68ee5de461d30415a8165cf9aefe1171` |
| SPYx / wSPYx | `0x90a2a4c76b5d8c0bc892a69ea28aa775a8f2dd48` / `0xe7e553cd128f0011777323a0b44a7b96ea1cb540` |
| v3 USDG/wSPYx | `0x07c40850d14064d20eb0afdef9574675392f2c11` (fee 500) |
| v3 USDG/wNVDAx | `0x2a2b11730c2b6d99a58034a869dd810d7300a7b2` (fee 500) |
| v3 USD₮0/wNVDAx | `0xa575234cc82be1dd41d133ca33e879287d6751a0` (fee 3000) |
| v3 USDC/wTSLAx | `0x6a58944eed3d2074e137eb4e94b302fe4af247a6` (fee 500) |
| v3 USDG/wTSLAx | `0xe1071db4691b325c709854dc3d5ccd5d77e62ed1` (fee 500) |
| USDG / USD₮0 / USDC | `0x4ae46a509f6b1d9056937ba4500cb143933d2dc8` / `0x779ded0c9e1022225f8e0630b35a9b54be713736` / `0xb6ceceab302e2e4948951ee7843fc24e92933061` |
| issuer custody EOA | `0x5f7a4c11bde4f218f0025ef444c369d838ffa2ad` |

## Operational notes

- `rpc.xlayer.tech` rejects JSON-RPC batches above **10** calls (`-32014`) and
  caps `eth_getLogs` ranges at **100 blocks**. The client batches at 10 and halves
  a slice if a provider rejects it, so a stricter endpoint costs speed, not
  correctness.
- Archive state works: `eth_call` at historical blocks returns historical values,
  which is what makes the replay validation possible.
- Everything is pinned to one block per report, so every number describes the same
  chain state. A run is ~80 round trips and ~19 s.
- Memory is flat by design: the tick ladder is a bounded array per pool (hundreds
  of entries) and all simulation is pure in-memory arithmetic, so a multi-pool
  split search costs no RPC.
- Stablecoins are treated as USD 1:1. A depeg would bias realisable value; this is
  stated in the report's own warnings rather than hidden.
- `STATERA_RPC` overrides the endpoint; `STATERA_SIZES` (comma separated) overrides
  the quoted sizes.

## Not settled

- **Whether OKX's `XNVDA`/`XTSLA`/`XSPY` are the same instrument as the xStock on
  X Layer.** OKX's listing material describes its tokenized stocks as
  xStocks-powered and the prices track within ~0.1%, but fungibility was not
  proven. What would settle it: OKX's deposit/withdrawal page naming the X Layer
  contract, or a withdrawal receipt.
- **The issuer price API host.** `docs.xstocks.fi` documents
  `/public/assets/{symbol}/price-data` (onchain providers plus Nasdaq/Blue Ocean)
  and says public endpoints need no auth, but publishes no base URL, and
  `xstocks.fi` is a static site that calls no API. What would settle it: the docs'
  API reference section, or an OpenAPI spec.
- **Any onchain oracle for equities on chain 196.** Pyth is absent from X Layer in
  its own EVM deployment list. Chainlink, RedStone, Stork and Supra were not
  individually checked. What would settle it: each provider's deployed-address
  docs.
- **Caliber propAMM** (`0x154586b2479b9a11e3d4db90024dc0e26f097312`) holds wTSLAx
  but answers none of the standard AMM getters, so its depth is not counted. What
  would settle it: Caliber's ABI.
- **Uniswap v4.** The v4 `PoolManager`
  (`0x360e68faccca8ca495c1b759fd9eee466db9fb32`) holds wSPYx and wNVDAx. v4
  liquidity is not read, so reported depth is a floor, not a ceiling.
