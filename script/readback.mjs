/**
 * Reads the live feed back and checks it three ways.
 *
 * A first attempt compared storage against a re-run of the engine pinned to the
 * posted block. That was wrong, and worth recording: pinning the block makes only the
 * POOL half reproducible. The mark comes from OKX's live order book, so re-running
 * later yields a different mark, and a different token count, and therefore a
 * different realisable value. Every row "mismatched" for a reason that was not a bug.
 *
 * What actually verifies the post:
 *
 *  1. storage vs the transaction's own RowPosted events — exact, and the events are
 *     the historical record a consumer would reconstruct from;
 *  2. each stored row re-derived: gapBps must equal expectedGapBps(tier, realisable),
 *     which is the invariant the contract enforced at write time;
 *  3. a fresh engine run alongside, labelled as live drift rather than error, to show
 *     the stored numbers are of the right magnitude and moving as a market does.
 */
import { createPublicClient, http, defineChain, parseAbi, decodeEventLog } from "viem";
import { Rpc } from "../dist/src/rpc.js";
import { run as runEngine } from "../dist/src/engine.js";
import { packReport } from "../dist/src/pack.js";

const RPC = "https://rpc.xlayer.tech";
const FEED = process.argv[2];
const GATE = process.argv[3];
const TXH = process.argv[4];
const LTV = 5000;

const xlayer = defineChain({ id: 196, name: "X Layer", nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain: xlayer, transport: http(RPC) });

const FEED_ABI = parseAbi([
  "function latestFor(address token, uint8 form, uint32 sizeTierUsd) view returns ((uint128 markUsd,uint128 realisableUsd,uint128 fillableUsd,int32 gapBps,uint8 status,uint40 engineBlock,uint48 publishedAt))",
  "function maxFillableUsd(address token, uint8 form) view returns (uint256)",
  "function runCount() view returns (uint64)",
  "function lastEngineBlock() view returns (uint40)",
  "function lastPublishedAt() view returns (uint48)",
  "event RowPosted(bytes32 indexed rowKey, address indexed token, uint8 indexed form, uint32 sizeTierUsd, uint128 markUsd, uint128 realisableUsd, uint128 fillableUsd, int32 gapBps, uint8 status, uint40 engineBlock, uint48 publishedAt)",
  "event RunPosted(uint40 indexed engineBlock, uint256 rowCount, uint48 publishedAt, uint64 runIndex)",
]);
const GATE_ABI = parseAbi([
  "function borrowLimitUsd(address token, uint8 form, uint256 amountUsd, uint16 ltvBps) view returns (uint256)",
  "function realisableValueUsd(address token, uint8 form, uint256 amountUsd) view returns (uint256)",
  "function haircutBps(address token, uint8 form, uint256 amountUsd) view returns (uint256)",
  "function coveringTierUsd(address token, uint8 form, uint256 amountUsd) view returns (uint32)",
]);

const usd = (v) => (Number(v) / 1e6).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);
const STATUS = ["unmeasured", "measured", "absent"];

let fails = 0;
const ok = (n, c, d = "") => { if (c) console.log(`  ok    ${n}${d ? "  " + d : ""}`); else { fails++; console.log(`  FAIL  ${n}${d ? "  " + d : ""}`); } };

// 1. Events emitted by the post.
const rc = await pub.getTransactionReceipt({ hash: TXH });
let rowEvents = 0, runEvents = 0;
for (const log of rc.logs) {
  try {
    const d = decodeEventLog({ abi: FEED_ABI, data: log.data, topics: log.topics });
    if (d.eventName === "RowPosted") rowEvents++;
    if (d.eventName === "RunPosted") runEvents++;
  } catch { /* not ours */ }
}
console.log(`events in ${TXH}`);
console.log(`  total logs ${rc.logs.length}: ${rowEvents} RowPosted + ${runEvents} RunPosted`);

// 2. Storage against the transaction's own events: the exact check.
const posted = new Map();
for (const log of rc.logs) {
  try {
    const d = decodeEventLog({ abi: FEED_ABI, data: log.data, topics: log.topics });
    if (d.eventName !== "RowPosted") continue;
    const a = d.args;
    posted.set(`${a.token.toLowerCase()}/${a.form}/${a.sizeTierUsd}`, a);
  } catch { /* not ours */ }
}

const postedBlock = Number(await pub.readContract({ address: FEED, abi: FEED_ABI, functionName: "lastEngineBlock" }));

// 3. A fresh engine run, for magnitude only. Pinned to the posted block so the pool
//    half is identical; the mark is live and will have moved.
process.env["STATERA_ENGINE_BLOCK"] = String(postedBlock);
const report = await runEngine(new Rpc({ url: RPC }));
const packed = packReport(report);

const expectedGap = (tier, realisable) => {
  const face = BigInt(tier) * 1_000_000n;
  return Number(((realisable - face) * 10_000n) / face);
};

console.log("\nstored row vs the RowPosted event it came from, and vs a fresh measurement");
console.log("  " + pad("token/form/tier", 22) + padL("stored mark", 12) + padL("stored real.", 13) + padL("gap", 6) +
  padL("status", 10) + "  " + padL("=event", 7) + padL("gap ok", 7) + padL("live real.", 12) + padL("drift", 9));
console.log("  " + "-".repeat(104));
let mismEvent = 0, mismGap = 0;
for (const r of packed.rows) {
  const k = `${r.token.toLowerCase()}/${r.form}/${r.sizeTierUsd}`;
  const got = await pub.readContract({ address: FEED, abi: FEED_ABI, functionName: "latestFor", args: [r.token, r.form, r.sizeTierUsd] });
  const ev = posted.get(k);

  const matchesEvent = !!ev &&
    BigInt(got.markUsd) === BigInt(ev.markUsd) && BigInt(got.realisableUsd) === BigInt(ev.realisableUsd) &&
    BigInt(got.fillableUsd) === BigInt(ev.fillableUsd) && Number(got.gapBps) === Number(ev.gapBps) &&
    Number(got.status) === Number(ev.status) && Number(got.engineBlock) === Number(ev.engineBlock);
  if (!matchesEvent) mismEvent++;

  const gapOk = Number(got.gapBps) === expectedGap(r.sizeTierUsd, BigInt(got.realisableUsd));
  if (!gapOk) mismGap++;

  const driftBps = Number(((r.realisableUsd - BigInt(got.realisableUsd)) * 10_000n) / BigInt(got.realisableUsd));
  console.log("  " + pad(r.label, 22) + padL(usd(got.markUsd), 12) + padL(usd(got.realisableUsd), 13) +
    padL(got.gapBps, 6) + padL(STATUS[Number(got.status)], 10) + "  " + padL(matchesEvent ? "yes" : "NO", 7) +
    padL(gapOk ? "yes" : "NO", 7) + padL(usd(r.realisableUsd), 12) + padL((driftBps >= 0 ? "+" : "") + driftBps + "bps", 9));
}
ok("storage equals the RowPosted events exactly", mismEvent === 0, `${mismEvent} mismatches`);
ok("every stored gap re-derives from its own realisable value", mismGap === 0, `${mismGap} mismatches`);
ok("all 18 rows are present onchain", posted.size === 18, `${posted.size} row events`);
console.log("  (live real. is a fresh measurement; drift is the market moving, not error)");

// 4. The gate, at the two tiers asked for.
console.log("\nCollateralGate at the 1,000 and 100,000 USD tiers, 50% LTV");
console.log("  " + pad("token/form", 20) + padL("size", 10) + padL("tier", 8) + padL("realisable", 13) + padL("limit", 13) + padL("haircut", 9) + padL("vs mark", 12));
console.log("  " + "-".repeat(88));
const seen = new Set();
for (const r of packed.rows) {
  const key = `${r.token}/${r.form}`;
  if (seen.has(key)) continue;
  seen.add(key);
  for (const size of [1000, 100000]) {
    const amount = BigInt(size) * 1_000_000n;
    const tier = await pub.readContract({ address: GATE, abi: GATE_ABI, functionName: "coveringTierUsd", args: [r.token, r.form, amount] });
    const value = await pub.readContract({ address: GATE, abi: GATE_ABI, functionName: "realisableValueUsd", args: [r.token, r.form, amount] });
    const limit = await pub.readContract({ address: GATE, abi: GATE_ABI, functionName: "borrowLimitUsd", args: [r.token, r.form, amount, LTV] });
    const hair = await pub.readContract({ address: GATE, abi: GATE_ABI, functionName: "haircutBps", args: [r.token, r.form, amount] });
    const markLimit = (amount * BigInt(LTV)) / 10_000n;
    const short = markLimit - BigInt(limit);
    console.log("  " + pad(`${r.label.split("/").slice(0, 2).join("/")}`, 20) + padL(size.toLocaleString("en-US"), 10) +
      padL(tier, 8) + padL(usd(value), 13) + padL(usd(limit), 13) + padL(hair + " bps", 9) + padL("-" + usd(short), 12));
    if (BigInt(limit) >= markLimit) { fails++; console.log("        FAIL: limit is not below the mark-based limit"); }
  }
}

// 5. Run metadata and maxFillableUsd.
console.log("");
const runCount = await pub.readContract({ address: FEED, abi: FEED_ABI, functionName: "runCount" });
const lastPub = await pub.readContract({ address: FEED, abi: FEED_ABI, functionName: "lastPublishedAt" });
console.log(`runCount ${runCount}, lastEngineBlock ${postedBlock}, lastPublishedAt ${lastPub} (${new Date(Number(lastPub) * 1000).toISOString()})`);
for (const [sym, tok] of [["NVDAx", packed.rows[0].token]]) {
  for (const form of [0, 1]) {
    const m = await pub.readContract({ address: FEED, abi: FEED_ABI, functionName: "maxFillableUsd", args: [tok, form] });
    console.log(`  maxFillableUsd ${sym} ${form === 0 ? "raw" : "wrapped"}: ${usd(m)} USD`);
  }
}
ok("run metadata recorded", Number(runCount) === 1);

console.log("");
console.log(fails === 0 ? "PASS  the live feed reads back exactly as measured" : `FAIL  ${fails} check(s) failed`);
process.exitCode = fails === 0 ? 0 : 1;
