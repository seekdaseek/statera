/**
 * End-to-end fork test.
 *
 * Forks X Layer mainnet into a local anvil, deploys StateraFeed and CollateralGate
 * onto it, runs the real phase 1 engine against the live chain, packs its output the
 * way the keeper does, posts it in one transaction, and reads it back through the
 * gate. Nothing here touches mainnet state or spends anything: the only signer is a
 * throwaway account anvil prints at startup, and it exists for the life of the test.
 *
 *   node script/fork-e2e.mjs
 *
 * The keys anvil generates are read from its stdout rather than hardcoded, so no
 * key-shaped string ever lives in this repo.
 */
import { spawn, execFileSync } from "node:child_process";
import { createPublicClient, createWalletClient, http, defineChain, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Rpc } from "../dist/src/rpc.js";
import { run as runEngine } from "../dist/src/engine.js";
import { packReport, toTuple } from "../dist/src/pack.js";
import { FEED_ABI } from "../dist/src/keeper.js";

// The repo root, derived from this file rather than hardcoded, so a clone works
// wherever it lands.
const ROOT = new URL("..", import.meta.url).pathname;

const PORT = Number(process.env["FORK_PORT"] ?? 8546);
const LOCAL = `http://127.0.0.1:${PORT}`;
const UPSTREAM = "https://rpc.xlayer.tech";
const FOUNDRY_BIN = `${process.env["HOME"]}/.foundry/bin`;
const MAX_AGE = 1800;
const LTV = 5000;

const GATE_ABI = parseAbi([
  "function borrowLimitUsd(address token, uint8 form, uint256 amountUsd, uint16 ltvBps) view returns (uint256)",
  "function realisableValueUsd(address token, uint8 form, uint256 amountUsd) view returns (uint256)",
  "function haircutBps(address token, uint8 form, uint256 amountUsd) view returns (uint256)",
  "function coveringTierUsd(address token, uint8 form, uint256 amountUsd) view returns (uint32)",
  "function tryBorrowLimitUsd(address token, uint8 form, uint256 amountUsd, uint16 ltvBps) view returns (uint8 refusal, uint256 limitUsd, uint32 tierUsd, uint128 fillableUsd)",
]);
const REFUSAL = ["None", "UnknownSeries", "NoTierCoversAmount", "Unmeasured", "NotSellable", "Stale"];

const usd = (v) => (Number(v) / 1e6).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) {
    console.log(`  ok    ${name}${detail ? "  " + detail : ""}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? "  " + detail : ""}`);
  }
}

function forgeCreate(what, args, key) {
  const out = execFileSync(
    `${FOUNDRY_BIN}/forge`,
    ["create", what, "--rpc-url", LOCAL, "--private-key", key, "--broadcast", ...(args.length ? ["--constructor-args", ...args] : [])],
    { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const m = out.match(/Deployed to:\s*(0x[0-9a-fA-F]{40})/);
  if (!m) throw new Error(`could not parse deploy output for ${what}:\n${out}`);
  return m[1];
}

async function main() {
  console.log("statera fork end-to-end");
  console.log(`forking ${UPSTREAM} into anvil on ${LOCAL}\n`);

  // The engine runs FIRST, and the fork is then pinned to the exact block it read.
  // The feed refuses an engine block above the chain head — correct in production,
  // where the transaction always lands after the block that was measured — so a fork
  // frozen at an earlier block than the live chain could never accept the post.
  // Pinning also makes this test reproducible: same block, same numbers.
  console.log("running the live engine against X Layer");
  const report = await runEngine(new Rpc({ url: UPSTREAM }));
  const packed = packReport(report);
  console.log(`  engine block ${report.block}, ${packed.rows.length} postable rows, ${packed.dropped.length} dropped`);
  for (const d of packed.dropped) console.log(`  dropped ${d.label}: ${d.reason}`);
  if (packed.rows.length === 0) throw new Error("engine produced nothing postable; cannot exercise the feed");
  console.log(`  pinning the fork to block ${packed.engineBlock}\n`);

  const anvil = spawn(
    `${FOUNDRY_BIN}/anvil`,
    ["--fork-url", UPSTREAM, "--fork-block-number", String(packed.engineBlock), "--port", String(PORT), "--accounts", "1"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let buf = "";
  let devKey = null;
  const ready = new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error("anvil did not become ready in 90s")), 90_000);
    anvil.stdout.on("data", (d) => {
      buf += d.toString();
      if (!devKey) {
        const m = buf.match(/Private Keys?\s*=+\s*\n+\(0\)\s*(0x[0-9a-f]{64})/i);
        if (m) devKey = m[1];
      }
      if (buf.includes("Listening on")) {
        clearTimeout(to);
        resolve();
      }
    });
    anvil.on("exit", (c) => reject(new Error(`anvil exited early (${c})`)));
  });

  try {
    await ready;
    if (!devKey) throw new Error("could not read anvil's throwaway key from its output");
    const account = privateKeyToAccount(devKey);

    const chain = defineChain({
      id: 196,
      name: "X Layer fork",
      nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
      rpcUrls: { default: { http: [LOCAL] } },
    });
    const pub = createPublicClient({ chain, transport: http(LOCAL) });
    const wallet = createWalletClient({ account, chain, transport: http(LOCAL) });

    const forkBlock = await pub.getBlockNumber();
    console.log(`fork block ${forkBlock}, chain id ${await pub.getChainId()}`);
    console.log(`publisher (throwaway) ${account.address}\n`);

    console.log("deploying onto the fork");
    const feed = forgeCreate("contracts/StateraFeed.sol:StateraFeed", [account.address], devKey);
    const gate = forgeCreate("contracts/CollateralGate.sol:CollateralGate", [feed, String(MAX_AGE)], devKey);
    console.log(`  StateraFeed    ${feed}`);
    console.log(`  CollateralGate ${gate}\n`);


    console.log("posting the run in one transaction");
    const hash = await wallet.writeContract({
      address: feed,
      abi: FEED_ABI,
      functionName: "post",
      args: [packed.engineBlock, packed.rows.map(toTuple)],
    });
    const rc = await pub.waitForTransactionReceipt({ hash });
    console.log(`  tx ${hash}`);
    console.log(`  status ${rc.status}, gasUsed ${rc.gasUsed}, logs ${rc.logs.length}\n`);

    check("post succeeded", rc.status === "success");
    check("one event per row plus the run event", rc.logs.length === packed.rows.length + 1, `${rc.logs.length} logs for ${packed.rows.length} rows`);

    console.log("reading every row back out of the feed");
    console.log(
      "  " + pad("token/form/tier", 26) + padL("mark", 12) + padL("realisable", 14) + padL("gap bps", 10) + padL("status", 10) + padL("engBlock", 11),
    );
    console.log("  " + "-".repeat(80));
    let mismatches = 0;
    for (const r of packed.rows) {
      const got = await pub.readContract({
        address: feed,
        abi: FEED_ABI,
        functionName: "latestFor",
        args: [r.token, r.form, r.sizeTierUsd],
      });
      const same =
        BigInt(got.markUsd) === r.markUsd &&
        BigInt(got.realisableUsd) === r.realisableUsd &&
        BigInt(got.fillableUsd) === r.fillableUsd &&
        Number(got.gapBps) === r.gapBps &&
        Number(got.status) === r.status &&
        Number(got.engineBlock) === packed.engineBlock;
      if (!same) mismatches++;
      console.log(
        "  " +
          pad(r.label, 26) +
          padL(usd(got.markUsd), 12) +
          padL(usd(got.realisableUsd), 14) +
          padL(got.gapBps, 10) +
          padL(["unmeas","measured","absent"][Number(got.status)], 10) +
          padL(got.engineBlock, 11) +
          (same ? "" : "   <-- MISMATCH"),
      );
    }
    check("every row read back exactly as packed", mismatches === 0, `${mismatches} mismatches`);
    console.log("");

    console.log("valuing collateral through the gate");
    const measured = packed.rows.filter((r) => r.status === 1);
    let gateChecks = 0;
    for (const r of measured) {
      const amount = BigInt(r.sizeTierUsd) * 1_000_000n;
      const value = await pub.readContract({ address: gate, abi: GATE_ABI, functionName: "realisableValueUsd", args: [r.token, r.form, amount] });
      const limit = await pub.readContract({ address: gate, abi: GATE_ABI, functionName: "borrowLimitUsd", args: [r.token, r.form, amount, LTV] });
      const hair = await pub.readContract({ address: gate, abi: GATE_ABI, functionName: "haircutBps", args: [r.token, r.form, amount] });
      const tier = await pub.readContract({ address: gate, abi: GATE_ABI, functionName: "coveringTierUsd", args: [r.token, r.form, amount] });

      const valueOk = BigInt(value) === r.realisableUsd;
      const limitOk = BigInt(limit) === (r.realisableUsd * BigInt(LTV)) / 10_000n;
      const belowMark = BigInt(limit) < (amount * BigInt(LTV)) / 10_000n;
      if (valueOk && limitOk && Number(tier) === r.sizeTierUsd) gateChecks++;
      console.log(
        `  ${pad(r.label, 26)} tier ${padL(tier, 7)} value ${padL(usd(value), 13)} limit@50% ${padL(usd(limit), 13)} haircut ${padL(hair, 5)} bps` +
          (belowMark ? "" : "   <-- NOT below the mark-based limit"),
      );
    }
    check("gate valued every measured row at its realisable value", gateChecks === measured.length, `${gateChecks}/${measured.length}`);

    // The refusals, exercised against live data.
    console.log("\nrefusals, against the same live rows");
    const first = measured[0];
    const overLargest = 10_000_000n * 1_000_000n; // $10m, above every tier
    const tryOver = await pub.readContract({
      address: gate,
      abi: GATE_ABI,
      functionName: "tryBorrowLimitUsd",
      args: [first.token, first.form, overLargest, LTV],
    });
    console.log(`  $10,000,000 pledge -> ${REFUSAL[Number(tryOver[0])]}`);
    check("refuses a size no tier covers", Number(tryOver[0]) === 2);

    let sawStrictRevert = false;
    try {
      await pub.readContract({ address: gate, abi: GATE_ABI, functionName: "borrowLimitUsd", args: [first.token, first.form, overLargest, LTV] });
    } catch {
      sawStrictRevert = true;
    }
    check("the strict form reverts where the try form flags", sawStrictRevert);

    const absentRow = packed.rows.find((r) => r.status === 2);
    if (absentRow) {
      const amt = (BigInt(absentRow.sizeTierUsd) * 1_000_000n * 8n) / 10n;
      const t = await pub.readContract({ address: gate, abi: GATE_ABI, functionName: "tryBorrowLimitUsd", args: [absentRow.token, absentRow.form, amt, LTV] });
      console.log(`  ${absentRow.label} at 80% of tier -> ${REFUSAL[Number(t[0])]}, fillable ${usd(t[3])}`);
      check("refuses an absent tier and reports what would fill", Number(t[0]) === 4 && BigInt(t[3]) > 0n);
    } else {
      console.log("  (no absent row in this run; the unit suite covers that path)");
    }

    // Staleness, using the fork's clock.
    const unknownToken = "0x000000000000000000000000000000000000dEaD";
    const tUnknown = await pub.readContract({ address: gate, abi: GATE_ABI, functionName: "tryBorrowLimitUsd", args: [unknownToken, 1, 1_000_000_000n, LTV] });
    console.log(`  never-published asset -> ${REFUSAL[Number(tUnknown[0])]}`);
    check("refuses an asset the feed has never published", Number(tUnknown[0]) === 1);

    console.log("");
    console.log(`maxFillableUsd per series`);
    const seen = new Set();
    for (const r of packed.rows) {
      const k = `${r.token}/${r.form}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const m = await pub.readContract({ address: feed, abi: FEED_ABI, functionName: "latestFor", args: [r.token, r.form, r.sizeTierUsd] });
      void m;
    }
    const runCount = await pub.readContract({ address: feed, abi: FEED_ABI, functionName: "runCount" });
    const lastBlk = await pub.readContract({ address: feed, abi: FEED_ABI, functionName: "lastEngineBlock" });
    console.log(`  runCount ${runCount}, lastEngineBlock ${lastBlk}`);
    check("run metadata recorded", Number(runCount) === 1 && Number(lastBlk) === packed.engineBlock);

    console.log("");
    console.log(failures === 0 ? `PASS  all fork end-to-end checks passed` : `FAIL  ${failures} check(s) failed`);
    process.exitCode = failures === 0 ? 0 : 1;
  } finally {
    anvil.kill("SIGTERM");
  }
}

main().catch((e) => {
  console.error(`fork e2e failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
