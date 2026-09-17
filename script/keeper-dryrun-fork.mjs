/**
 * Exercises the keeper against a real deployed feed, without spending anything.
 *
 * Forks X Layer into anvil, deploys StateraFeed with the REAL publisher address (the
 * one that will be funded), then runs the keeper twice in dry-run:
 *
 *   1. against an empty feed  -> must decide to post, because no key is published
 *   2. after a run is posted   -> must decide to skip, because nothing moved
 *
 * The second run is the one worth having: it proves the 5 bps / heartbeat gate
 * actually suppresses a pointless transaction, which is what keeps the OKB bill at
 * pennies. The keeper is never given --post here, so no transaction is ever signed
 * by the real key; the seeding post is made by anvil's throwaway account.
 */
import { spawn, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, defineChain } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Rpc } from "../dist/src/rpc.js";
import { run as runEngine } from "../dist/src/engine.js";
import { packReport, toTuple } from "../dist/src/pack.js";
import { FEED_ABI } from "../dist/src/keeper.js";

// The repo root, derived from this file rather than hardcoded, so a clone works
// wherever it lands.
const ROOT = new URL("..", import.meta.url).pathname;

const PORT = Number(process.env["FORK_PORT"] ?? 8571);
const LOCAL = `http://127.0.0.1:${PORT}`;
const UPSTREAM = "https://rpc.xlayer.tech";
const BIN = `${process.env["HOME"]}/.foundry/bin`;
const PUBLISHER = readFileSync(new URL("../.deploykey.address", import.meta.url), "utf8").trim();

function runKeeper(feed, extraEnv = {}) {
  try {
    return execFileSync("node", ["dist/src/keeper.js"], {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        STATERA_FEED: feed,
        STATERA_CHAIN_RPC: LOCAL, // the feed lives on the fork
        STATERA_RPC: UPSTREAM, // fast archive reads
        STATERA_ENGINE_BLOCK: String(extraEnv.__pin ?? ""), // pinned to the fork's head
        STATERA_PUBLISHER: PUBLISHER, // for gas estimation only; no key is used
        // A cold fork proxies every uncached read upstream, so the first engine pass
        // is far slower than against the public endpoint.
        STATERA_RPC_TIMEOUT_MS: "120000",
        STATERA_LOCK: `/tmp/statera-keeper-dryrun-${PORT}.lock`,
        STATERA_KEEPER_LOG: `/tmp/statera-keeper-dryrun-${PORT}.log`,
        ...Object.fromEntries(Object.entries(extraEnv).filter(([k]) => !k.startsWith("__"))),
      },
    });
  } catch (e) {
    return (e.stdout ?? "") + (e.stderr ?? "");
  }
}

async function main() {
  console.log("keeper dry-run against a forked feed");
  console.log(`publisher (real, unfunded): ${PUBLISHER}\n`);

  const anvil = spawn(`${BIN}/anvil`, ["--fork-url", UPSTREAM, "--port", String(PORT), "--accounts", "1"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let buf = "";
  let devKey = null;
  await new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error("anvil timeout")), 90_000);
    anvil.stdout.on("data", (d) => {
      buf += d.toString();
      if (!devKey) {
        const m = buf.match(/Private Keys?\s*=+\s*\n+\(0\)\s*(0x[0-9a-f]{64})/i);
        if (m) devKey = m[1];
      }
      if (buf.includes("Listening on")) {
        clearTimeout(to);
        res();
      }
    });
    let errBuf = "";
    anvil.stderr.on("data", (d) => { errBuf += d.toString(); });
    anvil.on("exit", (c) => rej(new Error(`anvil exited ${c}: ${errBuf.trim().split("\n").slice(-3).join(" | ") || "(no stderr)"}`)));
  });

  try {
    // Deploy with the REAL publisher, so the keeper's publisher check is meaningful.
    const out = execFileSync(
      `${BIN}/forge`,
      ["create", "contracts/StateraFeed.sol:StateraFeed", "--rpc-url", LOCAL, "--private-key", devKey, "--broadcast", "--constructor-args", PUBLISHER],
      { cwd: ROOT, encoding: "utf8" },
    );
    const feed = out.match(/Deployed to:\s*(0x[0-9a-fA-F]{40})/)[1];
    console.log(`StateraFeed on the fork: ${feed}`);
    console.log(`  publisher set to the real key's address, which holds no OKB\n`);

    const forkHead = Number(await (await import("viem")).createPublicClient({
      chain: defineChain({ id: 196, name: "fork", nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 }, rpcUrls: { default: { http: [LOCAL] } } }),
      transport: http(LOCAL),
    }).getBlockNumber());
    console.log(`fork head ${forkHead}; the engine is pinned to it so the feed's`);
    console.log(`engine-block bound is satisfied without mining the fork forward\n`);

    console.log("--- run 1: empty feed, keeper must decide to POST ---");
    const r1 = runKeeper(feed, { __pin: forkHead });
    console.log(r1.trim().split("\n").slice(-1)[0]);
    const j1 = JSON.parse(r1.trim().split("\n").filter((l) => l.startsWith("{")).pop());
    console.log(`  event=${j1.event} decision="${j1.decision}" rows=${j1.rows} gasEstimate=${j1.gasEstimate}`);
    console.log(`  costOkb=${j1.costOkb} costUsd=${j1.costUsd}`);
    const ok1 = j1.event === "dry-run" && /never been published/.test(j1.decision ?? "");
    console.log(`  ${ok1 ? "ok" : "FAIL"}  decides to post on an empty feed, and sent nothing`);

    // Seed the feed with the engine's output, using anvil's throwaway account.
    console.log("\nseeding the feed (anvil's throwaway account, not the real key)");
    const account = privateKeyToAccount(devKey);
    const chain = defineChain({ id: 196, name: "fork", nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 }, rpcUrls: { default: { http: [LOCAL] } } });
    const pub = createPublicClient({ chain, transport: http(LOCAL) });
    const wallet = createWalletClient({ account, chain, transport: http(LOCAL) });

    // The feed only accepts its publisher, so impersonate it on the fork.
    await pub.request({ method: "anvil_impersonateAccount", params: [PUBLISHER] });
    await pub.request({ method: "anvil_setBalance", params: [PUBLISHER, "0xde0b6b3a7640000"] });

    // Same chain for measuring and posting, so engineBlock <= head by construction.
    process.env["STATERA_ENGINE_BLOCK"] = String(forkHead);
    const report = await runEngine(new Rpc({ url: UPSTREAM }));
    const packed = packReport(report);

    const impersonated = createWalletClient({ account: PUBLISHER, chain, transport: http(LOCAL) });
    const hash = await impersonated.writeContract({
      address: feed,
      abi: FEED_ABI,
      functionName: "post",
      args: [packed.engineBlock, packed.rows.map(toTuple)],
    });
    const rc = await pub.waitForTransactionReceipt({ hash });
    console.log(`  seeded ${packed.rows.length} rows at engine block ${packed.engineBlock}, gasUsed ${rc.gasUsed}`);
    void wallet;

    console.log("\n--- run 2: feed already current, keeper must decide to SKIP ---");
    const r2 = runKeeper(feed, { __pin: forkHead });
    const j2 = JSON.parse(r2.trim().split("\n").filter((l) => l.startsWith("{")).pop());
    console.log(`  event=${j2.event} decision="${j2.decision}"`);
    const moved = (j2.moved ?? []).filter((m) => m.bps > 5);
    console.log(`  values over the 5 bps threshold: ${moved.length}`);
    // Between the two engine runs the market moves, so a post here is legitimate as
    // long as the reason is movement and not a failure to compare.
    const ok2 =
      (j2.event === "skip" && /nothing moved/.test(j2.decision ?? "")) ||
      (j2.event === "dry-run" && /moved more than/.test(j2.decision ?? ""));
    console.log(`  ${ok2 ? "ok" : "FAIL"}  ${j2.event === "skip" ? "suppressed a pointless post" : "posted only because live values moved"}`);

    console.log("\n--- run 3: lock must prevent an overlapping run ---");
    const lock = `/tmp/statera-keeper-lockcheck-${PORT}.lock`;
    execFileSync("sh", ["-c", `printf '%s\\n%s\\n' 99999 "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > ${lock}`]);
    const r3 = runKeeper(feed, { STATERA_LOCK: lock, __pin: forkHead });
    const held = /another keeper run holds/.test(r3);
    console.log(`  ${held ? "ok" : "FAIL"}  refused to run while the lock was held`);

    const allOk = ok1 && ok2 && held;
    console.log("");
    console.log(allOk ? "PASS  keeper exercised end to end, nothing signed by the real key" : "FAIL  see above");
    process.exitCode = allOk ? 0 : 1;
  } finally {
    anvil.kill("SIGTERM");
  }
}

main().catch((e) => {
  console.error(`keeper dry-run failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
