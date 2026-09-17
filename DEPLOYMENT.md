# statera on X Layer mainnet

Chain 196. Deployed 2026-09-17. The publisher is immutable and there is no admin, so
these addresses cannot be repointed, upgraded or taken over by anyone, including the
deployer.

## Addresses

| contract | address | status |
|---|---|---|
| StateraFeed | [`0x879d9a5d1Fa688DDf94b13361490746Faf8b784C`](https://www.oklink.com/x-layer/address/0x879d9a5d1fa688ddf94b13361490746faf8b784c) | live, the only feed |
| CollateralGate (maxAge 7200) | [`0x12c23e1cce2Ee3246a3161852d2CA7D6cFe4B9DA`](https://www.oklink.com/x-layer/address/0x12c23e1cce2ee3246a3161852d2ca7d6cfe4b9da) | **current gate** |
| CollateralGate (maxAge 1800) | [`0x5Ab5C851246c7056B90245af6639e9446BF1Ad79`](https://www.oklink.com/x-layer/address/0x5ab5c851246c7056b90245af6639e9446bf1ad79) | superseded, still live |
| publisher (EOA) | [`0x5B65b1e067270c46945e3bE5c0588FDb4dc7c018`](https://www.oklink.com/x-layer/address/0x5b65b1e067270c46945e3be5c0588fdb4dc7c018) | |

Constructor arguments: `StateraFeed(publisher)`, `CollateralGate(feed, maxAgeSeconds)`.

**Why there are two gates.** `maxAgeSeconds` is immutable, deliberately: a lender's
staleness tolerance should not be editable by whoever holds a key. Changing it means
deploying a new gate. The original gate demanded a post every 1800 seconds, which the
funded balance cannot sustain to Sep 30 — the keeper would have had to post 48 times a
day and would have run dry. The 7200-second gate matches a budget of at most 18 posts
a day. Both read the same feed and the same rows; they differ only in how old a row
they will lend against, so the superseded one is left deployed rather than orphaned:
anything already pointed at it keeps working, it just refuses sooner.

## Transactions

| what | tx | block | gas | cost |
|---|---|---|---|---|
| deploy StateraFeed | [`0x0c337035…f401151`](https://www.oklink.com/x-layer/tx/0x0c33703581590713b44a33e9ba594ae2fb8fb5849ccc226e3a18beefcf401151) | 70,894,352 | 1,736,186 | 0.000034724 OKB |
| deploy CollateralGate | [`0xdcf79328…1b08c48b`](https://www.oklink.com/x-layer/tx/0xdcf79328b3f68cd369e91418df697d2199e6cdbbdb65994aa1aa5bce1b08c48b) | 70,894,356 | 1,217,171 | 0.000024343 OKB |
| first post, 18 rows | [`0x0aea9f23…f15cdd09`](https://www.oklink.com/x-layer/tx/0x0aea9f2368ab276af3aaa3b3617fa135bf1b9c47993e7a80b1a879f0f15cdd09) | 70,894,753 | 1,766,304 | 0.000035326 OKB |
| deploy CollateralGate 7200 | [`0xf76d70dc…994b84a2`](https://www.oklink.com/x-layer/tx/0xf76d70dc12529ad6c3d1255b697a8d7cfc3795160326941c3970dc9e994b84a2) | 70,898,362 | 1,217,171 | 0.000024343 OKB |

All at 0.020000001 gwei. Total **0.000118736 OKB ($0.0133)** at OKB $112.
Every gas figure matched the fork forecast exactly.

The first post recorded engine block **70,894,700** and emitted **19 logs: 18
`RowPosted` + 1 `RunPosted`**, one per row plus the run, so the series is
reconstructible from logs alone.

## Verification

**Sourcify — verified, `exact_match`, both contracts, no account required.**

```
forge verify-contract <address> contracts/<C>.sol:<C> --chain 196 --verifier sourcify
```

| contract | Sourcify |
|---|---|
| StateraFeed | [exact_match](https://repo.sourcify.dev/196/0x879d9a5d1Fa688DDf94b13361490746Faf8b784C) · verified 2026-09-17T16:45:23Z |
| CollateralGate 7200 (current) | [exact_match](https://repo.sourcify.dev/196/0x12c23e1cce2Ee3246a3161852d2CA7D6cFe4B9DA) · verified 2026-09-17T17:50:51Z |
| CollateralGate 1800 (superseded) | [exact_match](https://repo.sourcify.dev/196/0x5Ab5C851246c7056B90245af6639e9446BF1Ad79) · verified 2026-09-17T16:45:24Z |

**OKLink — UNVERIFIED, and it needs an account.** Its `verify-source-code` endpoint
accepted a keyless submission for both contracts (`{"code":"0"}` plus a job GUID:
`b243d4905f39482ba7543f42412c1b21` for the feed, `84ccf9c1e26a4f2ea001a5072b0458f8`
for the gate), but the explorer still showed "unverified" ten minutes later, and the
outcome cannot be diagnosed without a key: `check-verify-status` returned
`50404 URL not found` on the path tried, and the address-information read API returns
`401`. **What it needs:** a free OKLink account to obtain an `Ok-Access-Key`, then
re-submit with that header and poll the status endpoint named in their current docs.
Independent bytecode verification does not depend on this — see below.

## Verified onchain, independently of any explorer

`script/verify-deploy.mjs` polls `eth_getCode` until code exists (the public RPC is
load balanced, so a read can land on a node that has not seen the deployment) and then
checks:

- deployed bytecode matches the local build, with the artifact's own
  `immutableReferences` windows masked — 64 bytes for the feed, 384 for the gate — and
  the immutable *values* checked separately through the contracts' getters, which
  proves the constructor wired them rather than only that bytes landed;
- `feed.publisher()` is the funded key; `runCount` and `lastEngineBlock` started at 0;
- `GAP_TOLERANCE_BPS` is 1 and `MAX_REALISABLE_MULTIPLE` is 2, the reviewed values;
- `gate.feed()` is the deployed feed and `gate.maxAgeSeconds()` is 1800.

## First post, read back

`script/readback.mjs` checks storage three ways. One note on method, because the
obvious check is wrong: comparing storage against a re-run of the engine pinned to the
posted block does **not** work. Pinning makes only the pool half reproducible — the
mark comes from OKX's live order book, so a later run yields a different mark, a
different token count and a different realisable value. The first attempt reported all
18 rows as mismatched for that reason alone. What verifies the post is:

1. **storage equals the transaction's own `RowPosted` events, exactly** — 0 mismatches
   across all 18 rows, and the events are what a consumer would reconstruct from;
2. **every stored `gapBps` re-derives from its own `realisableUsd`** against the tier's
   face value — the invariant the contract enforced at write time — 0 mismatches;
3. a fresh measurement alongside, as drift rather than error: +5 to +6 bps on NVDAx,
   −11 to −12 bps on TSLAx, 0 bps on SPYx. That is the market moving in the four
   minutes between the post and the read.

The keeper was then run again immediately and **skipped**: *"nothing moved more than
5 bps and last post was 257s ago"*. No transaction, no OKB.

## Operating it

```bash
export STATERA_FEED=0x879d9a5d1Fa688DDf94b13361490746Faf8b784C
node dist/src/keeper.js            # dry run: decides and estimates, sends nothing
node dist/src/keeper.js --post     # posts only if something moved or the heartbeat is due
```

The publisher key lives at `~/.config/statera/deploykey` (0600, directory 0700),
**outside the repo**. Both `script/deploy.sh` and the keeper default to that path and
refuse a key path inside the working tree.

Cron, once there is enough OKB to justify it:

```
*/5 * * * * STATERA_FEED=0x879d9a5d1Fa688DDf94b13361490746Faf8b784C /opt/statera/bin/keeper.sh --post >> /opt/statera/cron.log 2>&1
```

## Balance and runway

Funded 0.002902775 OKB, spent 0.000094393, **remaining 0.002808382 OKB ($0.31)**.

At 0.02 gwei a steady-state post costs 0.000008729 OKB, so the balance covers about
**321 posts**:

| cadence | posts/day | runway |
|---|---|---|
| 30-min heartbeat only | 48 | ~7 days |
| 15-min | 96 | ~3 days |
| 5-min cron, every run posting | 288 | ~1 day |

The true rate sits between the heartbeat floor and the cron ceiling, since most runs
skip. A 10x gas spike divides all of it by ten. **Top up before relying on it.**
