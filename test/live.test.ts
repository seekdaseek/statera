/**
 * Live tests against X Layer.
 *
 * ORACLE CHOICE. No QuoterV2 is deployed for factory
 * 0x4b2ab38dbf28d31d467aa8993f6c2585981d6804 on chain 196 (see README), so the
 * engine is checked against something stronger than a quoter: real swaps that
 * already executed. For a historical Swap event the pool state is loaded at the
 * preceding block, the event's own input amount is replayed through the engine,
 * and the predicted output is compared with what the chain actually paid out.
 *
 * A replay only counts when the simulated end price equals the sqrtPriceX96 the
 * event recorded. That equality is what proves the pre-swap state was the right
 * one — if another swap or a liquidity change landed earlier in the same block,
 * the price will not match and the sample is skipped rather than fudged.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Rpc, blockTag } from "../src/rpc.js";
import { loadPool, simulateExactInput } from "../src/v3/pool.js";
import { word, asSigned } from "../src/abi.js";
import { run } from "../src/engine.js";
import { TOKENS, SIZES_USD } from "../src/config.js";

const SWAP_TOPIC = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";

const POOLS = [
  { label: "v3 USDG/wSPYx", address: "0x07c40850d14064d20eb0afdef9574675392f2c11" },
  { label: "v3 USDG/wNVDAx", address: "0x2a2b11730c2b6d99a58034a869dd810d7300a7b2" },
  { label: "v3 USDC/wTSLAx", address: "0x6a58944eed3d2074e137eb4e94b302fe4af247a6" },
];

interface SwapEvent {
  blockNumber: number;
  txHash: string;
  amount0: bigint;
  amount1: bigint;
  sqrtPriceX96: bigint;
  liquidity: bigint;
  tick: number;
}

function decodeSwap(log: any): SwapEvent {
  const d: string = log.data;
  return {
    blockNumber: Number(BigInt(log.blockNumber)),
    txHash: log.transactionHash,
    amount0: asSigned(word(d, 0), 256),
    amount1: asSigned(word(d, 1), 256),
    sqrtPriceX96: word(d, 2),
    liquidity: word(d, 3),
    tick: Number(asSigned(word(d, 4), 24)),
  };
}

/** Most recent swaps on a pool, newest first. The RPC caps ranges at 100 blocks. */
async function recentSwaps(rpc: Rpc, address: string, head: number, windows = 40): Promise<SwapEvent[]> {
  const out: SwapEvent[] = [];
  for (let i = 0; i < windows && out.length < 12; i++) {
    const to = head - i * 100;
    const from = to - 99;
    let logs: any[] = [];
    try {
      logs = await rpc.getLogs([address], [SWAP_TOPIC], from, to);
    } catch {
      continue;
    }
    for (const l of logs.reverse()) out.push(decodeSwap(l));
  }
  return out;
}

for (const p of POOLS) {
  test(`replay: engine reproduces real executed swaps on ${p.label}`, async () => {
    const rpc = new Rpc();
    const head = await rpc.blockNumber();
    const swaps = await recentSwaps(rpc, p.address, head);
    assert.ok(swaps.length > 0, `no Swap events found on ${p.label} in the scanned window`);

    let validated = 0;
    const misses: string[] = [];

    for (const s of swaps) {
      if (validated >= 2) break;
      // Direction and gross amounts as the pool recorded them.
      const zeroForOne = s.amount0 > 0n;
      const amountIn = zeroForOne ? s.amount0 : s.amount1;
      const actualOut = zeroForOne ? -s.amount1 : -s.amount0;
      if (amountIn <= 0n || actualOut <= 0n) continue;

      const prev = s.blockNumber - 1;
      const pool = await loadPool(rpc, p.address, blockTag(prev), prev);
      if (!pool.netSumZero || !pool.activeMatches) { misses.push(`block ${s.blockNumber}: ladder incomplete`); continue; }

      const sim = simulateExactInput(pool, zeroForOne, amountIn);

      // The price equality is the gate: it proves we started from the right state.
      if (sim.endSqrtPriceX96 !== s.sqrtPriceX96) {
        misses.push(`block ${s.blockNumber}: end price ${sim.endSqrtPriceX96} != event ${s.sqrtPriceX96} (state moved earlier in the block)`);
        continue;
      }

      const diff = sim.amountOut > actualOut ? sim.amountOut - actualOut : actualOut - sim.amountOut;
      const relBps = Number((diff * 10_000n) / actualOut);
      assert.ok(
        relBps <= 20,
        `${p.label} block ${s.blockNumber} tx ${s.txHash}: simulated ${sim.amountOut} vs actual ${actualOut} (${relBps} bps apart, limit 20 = 0.2%)`,
      );
      // The end price matched exactly, so the output should be exact too.
      assert.equal(sim.amountOut, actualOut, `${p.label} block ${s.blockNumber}: end price matched but output did not`);
      validated++;
    }

    assert.ok(
      validated > 0,
      `no replayable swap on ${p.label}; candidates rejected: ${misses.slice(0, 6).join(" | ") || "none"}`,
    );
  });
}

test("engine: 1,000 USD rows are measured and internally consistent", async () => {
  const rpc = new Rpc();
  const rep = await run(rpc);
  assert.equal(rep.chainId, 196);
  assert.ok(rep.block > 0);

  for (const t of TOKENS) {
    const rows = rep.rows.filter((r) => r.token === t.rawSymbol && r.sizeUsd === 1_000);
    assert.equal(rows.length, 2, `expected raw and wrapped rows for ${t.rawSymbol}`);
    for (const r of rows) {
      assert.equal(r.status, "measured", `${t.rawSymbol}/${r.form} at 1,000 USD: ${r.status} (${r.note})`);
      assert.ok(r.markUsd !== null && r.markUsd > 0, "mark must be present");
      assert.ok(r.realisableUsd !== null && r.realisableUsd > 0, "realisable must be present");
      assert.ok(r.gapBps !== null, "gap must be present");
      // A 1,000 USD sale into these pools costs the 0.05% fee plus a little
      // impact, and venue basis can push it either way. Anything outside this
      // band means the pricing path is wrong, not that the market moved.
      assert.ok(r.gapBps > -300 && r.gapBps < 100, `${t.rawSymbol}/${r.form} gap ${r.gapBps} bps is outside the sane band`);
      assert.ok(r.poolsUsed.length > 0, "a measured row must name its pools");
    }
    // Both forms are the same claim on the same pool liquidity, so at equal USD
    // notional they must realise the same amount.
    const [a, b] = rows as [typeof rows[0], typeof rows[0]];
    const da = Math.abs(a.realisableUsd! - b.realisableUsd!);
    assert.ok(da <= 0.02, `raw and wrapped realisable differ by ${da} USD for ${t.rawSymbol}`);
  }
});

test("engine: every row carries a status, and non-measured rows carry no gap", async () => {
  const rpc = new Rpc();
  const rep = await run(rpc);
  assert.equal(rep.rows.length, TOKENS.length * 2 * SIZES_USD.length);
  for (const r of rep.rows) {
    assert.ok(["measured", "absent", "unmeasured"].includes(r.status));
    if (r.status === "unmeasured") {
      assert.equal(r.realisableUsd, null, "unmeasured rows must carry no numbers");
      assert.equal(r.gapBps, null);
    }
    if (r.status === "absent") {
      assert.equal(r.gapBps, null, "absent rows must not report a gap");
      assert.ok(r.fillableUsd !== null, "absent rows must state the fillable amount");
    }
  }
  // Pool ladders must prove themselves, or the depth numbers are only bounds.
  for (const p of rep.pools) {
    assert.ok(p.netSumZero, `${p.label}: liquidityNet does not sum to zero`);
    assert.ok(p.activeMatches, `${p.label}: active liquidity not reconstructed from the ladder`);
  }
});

test("engine: larger sizes never realise a better price per token", async () => {
  const rpc = new Rpc();
  const rep = await run(rpc);
  for (const t of TOKENS) {
    for (const form of ["raw", "wrapped"] as const) {
      const rows = rep.rows
        .filter((r) => r.token === t.rawSymbol && r.form === form && r.status === "measured")
        .sort((a, b) => a.sizeUsd - b.sizeUsd);
      for (let i = 1; i < rows.length; i++) {
        const prev = rows[i - 1]!;
        const cur = rows[i]!;
        assert.ok(
          cur.gapBps! <= prev.gapBps! + 1e-9,
          `${t.rawSymbol}/${form}: gap improved from ${prev.gapBps} at ${prev.sizeUsd} to ${cur.gapBps} at ${cur.sizeUsd}`,
        );
      }
    }
  }
});
