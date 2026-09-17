# statera

For tokenized stocks on X Layer (chain 196), statera publishes three numbers side
by side: an **independent mark**, the **realisable value** of selling a given size
into live onchain liquidity, and the **gap in basis points** — each with a status
of `measured`, `absent` or `unmeasured`.

## Live on X Layer

| contract | address | Sourcify |
|---|---|---|
| StateraFeed | [`0x879d9a5d1Fa688DDf94b13361490746Faf8b784C`](https://www.oklink.com/x-layer/address/0x879d9a5d1fa688ddf94b13361490746faf8b784c) | [exact_match](https://repo.sourcify.dev/196/0x879d9a5d1Fa688DDf94b13361490746Faf8b784C) |
| CollateralGate — **current**, maxAge 7200s | [`0x12c23e1cce2Ee3246a3161852d2CA7D6cFe4B9DA`](https://www.oklink.com/x-layer/address/0x12c23e1cce2ee3246a3161852d2ca7d6cfe4b9da) | [exact_match](https://repo.sourcify.dev/196/0x12c23e1cce2Ee3246a3161852d2CA7D6cFe4B9DA) |
| CollateralGate — superseded, maxAge 1800s | [`0x5Ab5C851246c7056B90245af6639e9446BF1Ad79`](https://www.oklink.com/x-layer/address/0x5ab5c851246c7056b90245af6639e9446bf1ad79) | [exact_match](https://repo.sourcify.dev/196/0x5Ab5C851246c7056B90245af6639e9446BF1Ad79) |

Chain 196. The publisher is immutable and there is no admin, so these cannot be
repointed, upgraded or taken over by anyone, including the deployer. Point new
integrations at the **7200-second gate**; the 1800-second one is left live for
anything already using it, and simply refuses sooner. Full record, with transaction
hashes and how each was verified, in [DEPLOYMENT.md](DEPLOYMENT.md).

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

---

# Phase 2 — the onchain half

A feed contract on X Layer, a keeper that posts the engine's numbers, and an example
lender that consumes them. Nothing is deployed yet; everything below is exercised on
a fork.

```bash
export PATH="$HOME/.foundry/bin:$PATH"
forge test                                   # 85 Solidity tests
forge test --fork-url https://rpc.xlayer.tech # the same 85, against real chain state
npm test                                     # 46 TypeScript tests
node script/fork-e2e.mjs                     # live engine -> forked feed -> gate
node script/gas-estimate.mjs                 # measured cost, priced in OKB and USD
node script/keeper-dryrun-fork.mjs           # the keeper, signing nothing
```

## StateraFeed

Keyed by `(token, form, sizeTier)`. `token` is the raw xStock address, which is the
asset identity for both forms; `form` is `Raw` or `Wrapped`. Rows pack into two slots.

```solidity
enum Form { Raw, Wrapped }
enum Status { Unmeasured, Measured, Absent }

struct Row {
    uint128 markUsd;        // USD, 6 dp, per one token of `form`
    uint128 realisableUsd;  // USD, 6 dp, proceeds of selling the tier
    uint128 fillableUsd;    // USD, 6 dp, meaningful only when Absent
    int32   gapBps;         // negative means worse than the mark
    uint8   status;
    uint40  engineBlock;    // the X Layer block the engine read
    uint48  publishedAt;    // block.timestamp of the post
}

function post(uint40 engineBlock, RowInput[] calldata rows) external;   // publisher only
function latest(bytes32 rowKey) external view returns (Row memory);
function latestFor(address token, Form form, uint32 sizeTierUsd) external view returns (Row memory);
function isFresh(bytes32 rowKey, uint256 maxAgeSeconds) external view returns (bool);
function maxFillableUsd(address token, Form form) external view returns (uint256);
function maxFillableUsdFresh(address token, Form form, uint256 maxAgeSeconds) external view returns (uint256);
function tiers(address token, Form form) external view returns (uint32[] memory);
function expectedGapBps(uint32 sizeTierUsd, uint128 realisableUsd) external pure returns (int256);
```

One run posts in one transaction and emits one `RowPosted` per row plus a `RunPosted`,
so the whole series is reconstructible from logs by anyone who does not trust storage.

**The gap is not forgeable.** A `Measured` row's `gapBps` is recomputed from
`realisableUsd` against the tier's face value and must agree within
`GAP_TOLERANCE_BPS` (1 bp, for the publisher's rounding). A publisher cannot post
honest values with a flattering gap, nor a gap with no values behind it:

| status | must carry | must not carry |
|---|---|---|
| `Measured` | mark, realisable, and a gap that agrees with them | — |
| `Absent` | `fillableUsd` > 0 | any gap |
| `Unmeasured` | nothing at all | mark, realisable, fillable, or gap |

A genuinely zero gap is legal and is not mistaken for a missing one — that case is
pinned by a test, because inferring "no gap" from `gapBps == 0` would have been the
easy wrong design.

**The publisher is immutable.** No owner, no upgrade path, no transfer function. A
posted row can be superseded but never edited, and nobody including the deployer can
repoint the feed. The cost is that a lost publisher key ends the feed; that is
accepted, because a feed a stranger can take over is not worth reading.

`isFresh` returns false for `Unmeasured` however recently it was posted: freshness is
a claim about usable numbers, not about keeper liveness. `maxFillableUsd` counts a
`Measured` tier at its full face value, an `Absent` tier at only the part that filled,
and an `Unmeasured` tier at nothing.

## CollateralGate

```solidity
function borrowLimitUsd(address token, Form form, uint256 amountUsd, uint16 ltvBps) external view returns (uint256);
function realisableValueUsd(address token, Form form, uint256 amountUsd) external view returns (uint256);
function haircutBps(address token, Form form, uint256 amountUsd) external view returns (uint256);
function coveringTierUsd(address token, Form form, uint256 amountUsd) external view returns (uint32);
function tryBorrowLimitUsd(...) external view returns (Refusal, uint256 limitUsd, uint32 tierUsd, uint128 fillableUsd);
```

It never reads the mark. Named refusals, every one tested:

| error | when |
|---|---|
| `UnknownSeries` | the feed has never published this asset in this form |
| `NoTierCoversAmount` | every measured tier is smaller than the pledge |
| `RowUnmeasured` | the covering tier was not measured — unknown, not worthless |
| `CollateralNotSellableAtSize` | the pools cannot fill that size; carries `fillableUsd` |
| `RowStale` | the row is older than `maxAgeSeconds` |
| `ZeroAmount`, `InvalidLtv` | bad inputs |

**Tier selection rounds up.** A $40,000 pledge is priced off the $100,000 row, not the
$10,000 one, because the cost of selling $40,000 is bounded by the cost of selling
$100,000 and never by the cost of selling $10,000. Rounding down would flatter the
borrower with slippage from a trade a tenth the size.

Measured live through the gate, $100,000 of wNVDAx at 50% LTV: the realisable value is
$98,149.45 and the limit $49,074.72, where a mark-based lender would have extended
$50,000. That ~$925 is the phantom credit statera exists to remove.

## Keeper

`src/pack.ts` converts a report into rows; `src/keeper.ts` decides and posts.

- **Never posts a zero.** `Unmeasured` rows are dropped, not written as zeros, because
  a zero meaning "unknown" is the confusion statera exists to remove. The previous row
  then ages out and is refused as stale, which is the honest outcome. If a run yields
  no postable rows, nothing is sent at all.
- **Posts when it is worth paying for**, under the budget policy in `src/policy.ts`
  (below). The short version: a 100-minute heartbeat so a quiet market is
  distinguishable from a dead keeper, plus a 100 bps movement trigger, both bounded by
  a cooldown, a daily cap, a balance floor and a cost cap.
- **`gapBps` is derived from the integer**, the same truncating division the contract
  uses — not rounded from the engine's float. Deriving it any other way would make
  posts revert at rounding boundaries in production and nowhere else.
- **Dry-run by default.** Sending needs both `--post` and a readable key. The key is
  read from a 0600 file into memory and handed to viem; it is never in a command line,
  a log, or another file.
- **Two locks.** `bin/keeper.sh` wraps the run in `flock(1)` on the VPS; the script
  also takes its own lockfile, because macOS has no `flock` and a double post wastes
  real OKB. A held lock logs one line and exits 0, since an overrun is ordinary.

Env: `STATERA_FEED` (required), `STATERA_RPC` (engine reads), `STATERA_CHAIN_RPC`
(where the feed lives, defaults to `STATERA_RPC`), `STATERA_KEY`, `STATERA_LOCK`,
`STATERA_STATE` (daily counter), `STATERA_KEEPER_LOG`, `STATERA_TG_ENV`.

### The spending policy

The publisher is funded once and will not be topped up, so when to post is a spending
question before it is a freshness question. `src/policy.ts` is pure — no clock, no
network, no filesystem — and every branch returns a machine-readable code as well as a
sentence, because a refusal nobody can grep is indistinguishable from a keeper that
died. `test/policy.test.ts` tests each rule at its boundary.

| rule | value | why |
|---|---|---|
| heartbeat | post at 100 min or older | matches the 7200-second gate with room for a missed run |
| movement | post when a measured value moves more than 100 bps | smaller moves are not worth a transaction |
| cooldown | never within 30 min of the last post | one flapping row cannot post every cron run |
| daily cap | 18 posts per UTC day, hard | bounds the worst case a bug can spend in a day |
| balance floor | stop below 0.0003 OKB | leaves the tail unspent instead of dribbling it away |
| cost cap | refuse above 3x the steady-state cost | catches a gas spike and an oversized run alike, since it compares cost, not gas |

Two details that are decisions rather than details:

**The order is deliberate.** The two solvency guards run before the two cadence rules,
so a due heartbeat can never override the balance floor or a gas spike. Running dry is
worse than a stale row, because a stale row is refused honestly by the gate while an
empty wallet cannot be refused at all.

**An unestimatable post counts as unaffordable**, not as free. A node that will not
simulate the post may also be about to revert it, and guessing the cost is how a
wallet empties.

Only *measured* rows contribute movement. An absent row's numbers describe a partial
fill the gate refuses anyway, so paying gas to refresh one buys nothing; a row that
appears or changes status is counted separately, because those are shape changes a
consumer cannot infer from a price.

The daily counter lives in a local JSON file rather than being read back from the
chain: `eth_getLogs` is capped at 100-block windows on the public RPC and a UTC day is
about 86,400 blocks. A missing or corrupt counter reads back as a fresh day — refusing
to run because a counter file is unparseable would take the feed down over a
formatting problem.

Three things alert to Telegram, once per kind per day: crossing the balance floor, a
gas spike that suppressed a post, and a post that failed. Credentials are read from a
file at call time, never printed, never logged, never put on a command line; the
token is redacted out of any error string before it can reach a log, because the
failing URL contains it. Alerting is best-effort — a keeper that dies because Telegram
is down is worse than one that posts quietly.

## Mark fungibility — answered

**Yes for the networks.** OKX's own documentation, fetched without a login or key:
[okx.com/help/unified-tokenized-stocks](https://www.okx.com/help/unified-tokenized-stocks)
answers "Which network and token can I deposit?" with "Currently, xStocks tokens on
Solana and Xlayer", and "withdrawals are paid out in the xStocks token… an xAAPL
balance is converted back into AAPLx on withdrawal". The listing announcement
[okx-to-list-unified-tokenized-stocks-for-spot-trading](https://www.okx.com/help/okx-to-list-unified-tokenized-stocks-for-spot-trading)
states "supports deposits and withdrawals of xStocks on the Solana and X Layer
networks" and names XSPY, XNVDA and XTSLA in Batch 2 with withdrawals opening
08:00 UTC, 16 Jul 2026. A later batch announcement repeats the same two networks, so
no third has been added.

**No for the contract addresses.** No OKX deposit or withdrawal surface prints a
contract address — the help and announcement HTML contains no `0x` addresses at all.
The one endpoint that returns a per-network `ctAddr`, `/api/v5/asset/currencies`, is
401 without an API key. OKX Wallet does display each address as NVDAx / TSLAx / SPYx
on X Layer, so the chain XNVDA → NVDAx → `0xc845…` is joined across two OKX surfaces
rather than asserted on one. **Settles with one authenticated call:**
`GET /api/v5/asset/currencies?ccy=XNVDA` with a free read-only key returns `chain`,
`ctAddr`, `canDep` and `canWd` per network.

**One claim tested and rejected.** OKX's docs describe balances as *shares* converted
to tokens on withdrawal, which suggests OKX might quote per share rather than per
token. Measured at block 70,888,320, it does not:

| | OKX mid | pool spot (wrapper) | multiplier | OKX / pool | OKX / (pool ÷ mult) |
|---|---|---|---|---|---|
| NVDA | 219.3950 | 219.7412 | 1.001701197 | 0.998425 | **1.000123** |
| TSLA | 367.1400 | 367.2467 | 1.000000000 | 0.999709 | 0.999709 |
| SPY | 761.4850 | 765.7632 | 1.005714560 | 0.994413 | **1.000096** |

NVDA and SPY agree to within 2 bps once the multiplier is divided out, despite their
multipliers differing by 46 bps — which only cancels if OKX quotes **per raw token**.
Under the per-share reading they would diverge by 40 bps. So phase 1's assignment
(mark_raw = OKX, mark_wrapped = OKX × multiplier) is correct. TSLA's −29 bps is
ordinary venue basis; its multiplier is exactly 1, so it cannot distinguish the two.

## Measured cost

X Layer gas 0.02 gwei, OKB $112.05, measured on a fork:

| item | gas | OKB | USD |
|---|---|---|---|
| deploy StateraFeed | 1,736,186 | 0.000034724 | $0.0039 |
| deploy CollateralGate | 1,217,171 | 0.000024343 | $0.0027 |
| post 18 rows, first write | 1,766,304 | 0.000035326 | $0.0040 |
| post 18 rows, steady state | 436,458 | 0.000008729 | $0.0010 |

Seven days of posting: $0.33 at the 30-minute heartbeat, $1.99 at a 5-minute cron,
$9.89 at a paranoid 1-minute cadence. Funding ask **0.11 OKB (~$12)**, which is 1.25x
the worst measured week and about six weeks at the realistic cadence.

## Not settled in phase 2

- **Nothing is deployed.** Every number above comes from a fork. Mainnet behaviour is
  UNTESTED until phase 3.
- **`STATERA_ENGINE_BLOCK`** pins a report to a specific block instead of the head.
  It exists for reproducible reports and backtests, and it is what lets the fork
  harnesses satisfy the engine-block bound: mining a fork forward is not an option at
  a measured 1.66 s per block.
- **The keeper has never sent a transaction.** The signing path is written and the
  publisher check is exercised on a fork, but `--post` has never been used against
  mainnet.
- **No audit.** The contracts are reviewed and tested, not audited.
- **The `Refusal` enum returned by `tryBorrowLimitUsd` for a zero amount or a bad LTV
  is `NoTierCoversAmount`**, which is imprecise. The strict form reverts with the
  correct `ZeroAmount` / `InvalidLtv`.

## Reviewed and hardened

Six independent adversarial lenses were run over the contracts and keeper before any
deployment. Nine defects were proposed; **five reproduced against the code** and were
fixed, along with three keeper defects and one weak test. Each fix carries a
regression test named after what it prevents.

**The worst one was never verified by the review at all.** Its verifier agents died on
a session limit, so "engineBlock is never bounded" arrived with no verdict. Triaged by
hand, it reproduced — and it was the most severe of the set. `post` took `engineBlock`
from the publisher and only checked it was non-zero and not going backwards. A single
fat-fingered value — a units error, a timestamp pasted into the wrong argument —
raises `lastEngineBlock` beyond any real block number, after which **every future post
reverts on monotonicity, forever**. With an immutable publisher and no admin there is
no way back: the feed would be permanently dead. The fix is the bound that was always
implied, since the engine reads a block that has already been mined:

```solidity
if (engineBlock > block.number) revert EngineBlockInFuture(engineBlock, block.number);
```

`lastEngineBlock` can now never exceed the chain head, so an honest post always
succeeds. `test_post_cannotBeBrickedByABadEngineBlock` pins it.

That bound has a consequence worth knowing operationally: the engine's block must be
at or below the head of the chain the feed lives on. In production that is automatic —
the engine reads block N and the transaction lands at N+k. On a fork it is not, because
the fork's head is frozen while the live chain advances, so `script/fork-e2e.mjs` now
runs the engine first and pins the fork to exactly the block it measured (which also
makes the test reproducible), and `script/keeper-dryrun-fork.mjs` points the engine at
the fork so measuring and posting share one chain, as they do in production.

**The one the review did confirm as reproducing.** A `Measured` row could claim proceeds far above the tier's
face value and pass every check — including the gap check, because the gap is computed
*from* that value, so the two agreed with each other while both were nonsense. Proved
with a probe: a row claiming ten times face turned a $1,000 pledge into a **$10,000
borrow limit at 100% LTV**. Two independent fixes, because a lender must not depend on
its feed being sane:

- the feed rejects a `Measured` row whose proceeds exceed `MAX_REALISABLE_MULTIPLE`
  (2×) face — generous enough that genuine positive venue basis still posts, tight
  enough that a misplaced decimal cannot;
- the gate caps its valuation at face regardless of what the feed says.

The rest:

| defect | fix |
|---|---|
| `Absent` could claim a `fillableUsd` at or above the tier it declared unfillable, inflating `maxFillableUsd` past anything observed | `fillableUsd` must be strictly below the tier's face value |
| `Measured` could carry a `fillableUsd`, which is meaningless for a filled tier | must be zero |
| `haircutBps` reported a 100% haircut on a healthy series for a dust pledge (the value truncated to zero first) | derived from the tier, not from the pledged amount |
| an `Absent` smaller tier did not stop the gate valuing a larger pledge, which is contradictory data | refuses with `SmallerTierNotSellable`, naming the tier that disagrees |
| `tryBorrowLimitUsd` reported a zero amount or bad LTV as `NoTierCoversAmount` | distinct `Refusal.BadParameters` |
| the keeper's `release()` deleted whatever lock file was present, so an overrun run could delete its successor's lock and let a third run double-post | the lock carries a per-acquisition token and is only removed by its owner |
| a zero-byte lock — what a crash between create and write leaves — could never be broken, silencing the keeper forever | staleness falls back to the file's mtime |
| the dry run reported a clean run with a `null` gas estimate unless an undocumented env var was set | estimates as the publisher read from the feed itself, which doubles as a pre-flight that the run **would be accepted**; reports the revert reason when it would not |

**How to read the review's own verdict.** The workflow returned zero confirmed
findings, and that number is an artifact, not a result. Its verifiers ran after the
fixes had already landed in the working tree, so they correctly found the checks
present and refuted each finding as already-closed — several said so explicitly,
noting the finding "would have been valid against HEAD 6f70b2f". Separately, 52 of its
81 agents died on a session limit, so most findings never got a verdict at all. The
evidence that these defects were real is not the workflow's vote: it is that each one
was reproduced against the pre-fix code with a probe test that asserted the buggy
behaviour and passed, then failed once the fix landed.

One test was weak rather than wrong-headed: `testFuzz_valuationIsMonotonicInAmount`
asserted that value always rises with the amount pledged. That is not a property of
tiered pricing — crossing into a larger tier reprices the whole pledge at that tier's
worse rate, so total value can dip by a hair at a boundary. It passed only until the
fuzzer found a boundary pair. It is now split into monotonicity *within* a tier plus
an explicit test pinning the boundary discontinuity as intended, conservative
behaviour.

Also worth recording: the review agents wrote scratch Solidity probe files into the
working tree while testing their claims. Those were read for anything worth keeping —
two invariants were, and were rewritten as `testFuzz_strictAndTryFormsAlwaysAgree` and
`testFuzz_valueNeverExceedsFace` — and then deleted. Nothing agent-authored is in the
commit.

## Licence

MIT. See LICENSE.
