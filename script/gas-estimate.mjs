/**
 * Measures, rather than guesses, what phase 3 will cost.
 *
 * Forks X Layer into anvil, deploys both contracts, posts a realistic 18-row run
 * twice (cold slots then warm), and prices every number at the live X Layer gas
 * price and the live OKB-USDT mid. Spends nothing: the fork is local and the signer
 * is a throwaway account anvil prints at startup.
 */
import { spawn, execFileSync } from "node:child_process";
import { createPublicClient, createWalletClient, http, defineChain } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { FEED_ABI } from "../dist/src/keeper.js";

// The repo root, derived from this file rather than hardcoded, so a clone works
// wherever it lands.
const ROOT = new URL("..", import.meta.url).pathname;

const PORT = Number(process.env["FORK_PORT"] ?? 8555);
const LOCAL = `http://127.0.0.1:${PORT}`;
const UPSTREAM = "https://rpc.xlayer.tech";
const BIN = `${process.env["HOME"]}/.foundry/bin`;

const NVDAx = "0xc845b2894dBddd03858fd2D643B4eF725fE0849d";
const TSLAx = "0x8aD3c73F833d3F9A523aB01476625F269aEB7Cf0";
const SPYx = "0x90A2a4c76b5D8c0bc892A69EA28Aa775a8f2dD48";

const gapOf = (tier, realisable) => {
  const face = BigInt(tier) * 1_000_000n;
  return Number(((realisable - face) * 10_000n) / face);
};

function buildRun() {
  const rows = [];
  for (const token of [NVDAx, TSLAx, SPYx]) {
    for (const form of [0, 1]) {
      for (const tier of [1000, 10000, 100000]) {
        const realisable = (BigInt(tier) * 1_000_000n * 9970n) / 10000n;
        rows.push({
          token,
          form,
          sizeTierUsd: tier,
          markUsd: 220_018_700n,
          realisableUsd: realisable,
          fillableUsd: 0n,
          gapBps: gapOf(tier, realisable),
          status: 1,
        });
      }
    }
  }
  return rows;
}

async function okbMid() {
  const r = await fetch("https://www.okx.com/api/v5/market/ticker?instId=OKB-USDT");
  const t = (await r.json()).data[0];
  return (Number(t.bidPx) + Number(t.askPx)) / 2;
}

async function main() {
  // Live pricing inputs, from mainnet not the fork.
  const mainnet = createPublicClient({
    chain: defineChain({ id: 196, name: "X Layer", nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 }, rpcUrls: { default: { http: [UPSTREAM] } } }),
    transport: http(UPSTREAM),
  });
  const gasPrice = await mainnet.getGasPrice();
  const baseFee = (await mainnet.getBlock()).baseFeePerGas ?? 0n;
  const okb = await okbMid();

  console.log("live pricing inputs");
  console.log(`  X Layer gas price   ${gasPrice} wei (${Number(gasPrice) / 1e9} gwei)`);
  console.log(`  X Layer base fee    ${baseFee} wei (${Number(baseFee) / 1e9} gwei)`);
  console.log(`  OKB-USDT mid        $${okb.toFixed(2)}`);
  console.log("");

  const anvil = spawn(`${BIN}/anvil`, ["--fork-url", UPSTREAM, "--port", String(PORT), "--accounts", "1"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let buf = "";
  let key = null;
  await new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error("anvil timeout")), 90_000);
    anvil.stdout.on("data", (d) => {
      buf += d.toString();
      if (!key) {
        const m = buf.match(/Private Keys?\s*=+\s*\n+\(0\)\s*(0x[0-9a-f]{64})/i);
        if (m) key = m[1];
      }
      if (buf.includes("Listening on")) {
        clearTimeout(to);
        res();
      }
    });
    anvil.on("exit", (c) => rej(new Error(`anvil exited ${c}`)));
  });

  try {
    const account = privateKeyToAccount(key);
    const chain = defineChain({ id: 196, name: "fork", nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 }, rpcUrls: { default: { http: [LOCAL] } } });
    const pub = createPublicClient({ chain, transport: http(LOCAL) });
    const wallet = createWalletClient({ account, chain, transport: http(LOCAL) });

    const deploy = (what, args) => {
      const out = execFileSync(
        `${BIN}/forge`,
        ["create", what, "--rpc-url", LOCAL, "--private-key", key, "--broadcast", ...(args.length ? ["--constructor-args", ...args] : [])],
        { cwd: ROOT, encoding: "utf8" },
      );
      const addr = out.match(/Deployed to:\s*(0x[0-9a-fA-F]{40})/)[1];
      const tx = out.match(/Transaction hash:\s*(0x[0-9a-f]{64})/)[1];
      return { addr, tx };
    };

    const feed = deploy("contracts/StateraFeed.sol:StateraFeed", [account.address]);
    const gate = deploy("contracts/CollateralGate.sol:CollateralGate", [feed.addr, "1800"]);
    const feedRc = await pub.getTransactionReceipt({ hash: feed.tx });
    const gateRc = await pub.getTransactionReceipt({ hash: gate.tx });

    const rows = buildRun();
    const h1 = await wallet.writeContract({ address: feed.addr, abi: FEED_ABI, functionName: "post", args: [70_887_500, rows] });
    const r1 = await pub.waitForTransactionReceipt({ hash: h1 });
    const h2 = await wallet.writeContract({ address: feed.addr, abi: FEED_ABI, functionName: "post", args: [70_887_600, rows] });
    const r2 = await pub.waitForTransactionReceipt({ hash: h2 });

    const items = [
      ["deploy StateraFeed", feedRc.gasUsed],
      ["deploy CollateralGate", gateRc.gasUsed],
      ["post 18 rows (first, cold slots)", r1.gasUsed],
      ["post 18 rows (steady state)", r2.gasUsed],
    ];

    const cost = (g) => {
      const wei = g * gasPrice;
      const o = Number(wei) / 1e18;
      return { okb: o, usd: o * okb };
    };

    console.log("measured on a fork of X Layer");
    console.log("  " + "item".padEnd(36) + "gas".padStart(12) + "OKB".padStart(16) + "USD".padStart(12));
    console.log("  " + "-".repeat(76));
    for (const [name, g] of items) {
      const c = cost(g);
      console.log("  " + name.padEnd(36) + String(g).padStart(12) + c.okb.toFixed(9).padStart(16) + ("$" + c.usd.toFixed(5)).padStart(12));
    }

    const deployTotal = feedRc.gasUsed + gateRc.gasUsed;
    const dc = cost(deployTotal);
    console.log("  " + "-".repeat(76));
    console.log("  " + "both deployments".padEnd(36) + String(deployTotal).padStart(12) + dc.okb.toFixed(9).padStart(16) + ("$" + dc.usd.toFixed(5)).padStart(12));
    console.log("");

    // Seven days of posting at several cadences. The keeper's heartbeat is 30 min,
    // so 48/day is the floor; movement triggers push it toward the cron interval.
    const perPost = cost(r2.gasUsed);
    console.log("seven days of posting (steady-state gas per post)");
    console.log("  " + "cadence".padEnd(30) + "posts/7d".padStart(10) + "OKB".padStart(16) + "USD".padStart(12));
    console.log("  " + "-".repeat(68));
    const cadences = [
      ["every 30 min (heartbeat only)", (7 * 24 * 60) / 30],
      ["every 15 min", (7 * 24 * 60) / 15],
      ["every 5 min (cron ceiling)", (7 * 24 * 60) / 5],
      ["every 1 min (paranoid ceiling)", 7 * 24 * 60],
    ];
    let worst = 0;
    for (const [name, n] of cadences) {
      const o = perPost.okb * n;
      const u = perPost.usd * n;
      if (o > worst) worst = o;
      console.log("  " + name.padEnd(30) + String(n).padStart(10) + o.toFixed(6).padStart(16) + ("$" + u.toFixed(4)).padStart(12));
    }

    // Funding. Two bases, both stated, so the ask is auditable rather than a vibe.
    const fixed = dc.okb + cost(r1.gasUsed).okb; // both deploys + the one cold post
    const realistic = fixed + perPost.okb * ((7 * 24 * 60) / 5); // 7d at the 5-min cron
    const paranoid = fixed + worst; // 7d at the 1-min ceiling
    const ask = Math.ceil(paranoid * 1.2 * 100) / 100; // round up to a clean 0.01 OKB

    console.log("");
    console.log("funding");
    console.log(`  fixed, one off (both deploys + first cold post)     ${fixed.toFixed(6)} OKB  $${(fixed * okb).toFixed(4)}`);
    console.log(`  realistic 7 days (5-min cron, every run posts)      ${realistic.toFixed(6)} OKB  $${(realistic * okb).toFixed(4)}`);
    console.log(`  worst case 7 days (1-min cadence, every run posts)  ${paranoid.toFixed(6)} OKB  $${(paranoid * okb).toFixed(4)}`);
    console.log(`  ASK, worst case plus 20 percent, rounded up         ${ask.toFixed(2)} OKB  $${(ask * okb).toFixed(2)}`);
    console.log("");
    console.log(`  X Layer gas is ${Number(gasPrice) / 1e9} gwei, so a realistic week costs about`);
    console.log(`  $${(realistic * okb).toFixed(2)}. The ask is ${(ask / paranoid).toFixed(2)}x the worst measured week (1-min cadence).`);
    console.log(`  Against the realistic 5-min cadence that is ${(ask / (realistic - fixed)).toFixed(0)} weeks of runway, or one`);
    console.log(`  week at ${(ask / (realistic - fixed)).toFixed(0)}x today's gas price. Top up, do not over-fund a hot key.`);
  } finally {
    anvil.kill("SIGTERM");
  }
}

main().catch((e) => {
  console.error(`gas estimate failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
