/** statera CLI. Read-only: prints a table, or --json for machine use. */
import { Rpc } from "./rpc.js";
import { run, type Row } from "./engine.js";

const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));
const padL = (s: string, n: number) => (s.length >= n ? s : " ".repeat(n - s.length) + s);
const usd = (v: number | null) => (v === null ? "-" : v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

function table(rows: Row[]): string {
  const head =
    pad("token", 8) + pad("form", 8) + pad("symbol", 9) + padL("size USD", 10) +
    padL("mark", 11) + padL("tokens", 14) + padL("realisable", 13) + padL("gap bps", 10) +
    "  " + pad("status", 11) + "pools";
  const lines = [head, "-".repeat(head.length + 20)];
  for (const r of rows) {
    lines.push(
      pad(r.token, 8) + pad(r.form, 8) + pad(r.symbol, 9) + padL(r.sizeUsd.toLocaleString("en-US"), 10) +
      padL(r.markUsd === null ? "-" : r.markUsd.toFixed(4), 11) +
      padL(r.tokensSold ?? "-", 14) +
      padL(usd(r.realisableUsd), 13) +
      padL(r.gapBps === null ? "-" : r.gapBps.toFixed(1), 10) +
      "  " + pad(r.status, 11) + (r.poolsUsed.join(" + ") || "-"),
    );
  }
  return lines.join("\n");
}

async function main() {
  const asJson = process.argv.includes("--json");
  const rpc = new Rpc();
  const rep = await run(rpc);

  if (asJson) {
    process.stdout.write(JSON.stringify(rep, null, 2) + "\n");
    return;
  }

  console.log(`statera — X Layer chain ${rep.chainId}, block ${rep.block}, ${rep.generatedAt}`);
  console.log(`rpc ${rep.rpcUrl} (${rep.rpcCalls} round trips)`);
  console.log("");
  console.log(table(rep.rows));
  console.log("");
  console.log("pool ladder integrity (netSumZero and activeMatches must both be true for depth to be exact)");
  for (const p of rep.pools) {
    console.log(`  ${pad(p.label, 24)} fee=${padL(String(p.fee), 5)} tick=${padL(String(p.tick), 8)} ticks=${padL(String(p.ticksLoaded), 4)} words=+/-${padL(String(p.wordsEachSide), 4)} netSumZero=${p.netSumZero} activeMatches=${p.activeMatches}`);
  }
  console.log("");
  console.log("wrapper share rate (assets per share; this is the rebasing multiplier)");
  for (const m of rep.multipliers) console.log(`  ${pad(m.token, 8)} ${m.assetsPerShare.toFixed(9)}`);
  console.log("");
  console.log("raw free float (supply outside issuer custody and OKX-labelled wallets)");
  for (const f of rep.floats) {
    console.log(`  ${pad(f.token, 8)} total ${padL(f.totalSupply.toFixed(2), 12)}  non-float ${padL(f.nonFloat.toFixed(2), 12)}  float ${padL(f.float.toFixed(2), 12)} (${f.floatPct.toFixed(2)}%)`);
    for (const b of f.nonFloatBreakdown) console.log(`           - ${pad(b.label, 22)} ${b.amount.toFixed(2)}`);
  }
  if (rep.warnings.length) {
    console.log("");
    console.log("notes");
    for (const w of rep.warnings) console.log(`  - ${w}`);
  }
  for (const r of rep.rows) {
    if (r.status !== "measured" && r.note) console.log(`  ! ${r.token}/${r.form} ${r.sizeUsd}: ${r.note}`);
  }
}

main().catch((e) => {
  console.error(`statera failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
