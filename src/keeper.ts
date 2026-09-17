/**
 * statera keeper.
 *
 * Runs the engine, packs the rows, and posts one transaction — but only when there
 * is something worth paying for. Two triggers, either sufficient:
 *
 *   movement   any posted value moved more than MOVE_BPS against what is onchain,
 *              or a status changed, or a key has never been published
 *   heartbeat  the feed's last post is older than HEARTBEAT_SECONDS, so consumers
 *              can distinguish "quiet market" from "keeper died"
 *
 * SAFETY POSTURE. It is dry-run by default. Sending requires BOTH --post and a
 * readable key file, and it refuses to send if the engine produced nothing postable.
 * Unmeasured rows are dropped by the packer and can never reach the chain, so the
 * feed is never written with zeros standing in for unknowns.
 *
 * The private key is read into memory from a 0600 file and handed to viem. It is
 * never placed on a command line, never logged, and never written anywhere else.
 */
import { readFileSync, writeFileSync, appendFileSync, openSync, closeSync, unlinkSync, statSync, readFileSync as rf } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createPublicClient, createWalletClient, http, defineChain, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Rpc } from "./rpc.js";
import { run as runEngine } from "./engine.js";
import { packReport, toTuple } from "./pack.js";
import {
  decidePolicy, computeMovement, utcDay, STEADY_STATE_COST_WEI, COST_CAP_WEI,
  BALANCE_FLOOR_WEI, HEARTBEAT_SECONDS as POLICY_HEARTBEAT, MOVE_BPS as POLICY_MOVE_BPS,
  MOVE_COOLDOWN_SECONDS, MAX_POSTS_PER_UTC_DAY, type AlertKind, type OnchainRow,
} from "./policy.js";
import { loadState, saveState, rollDay, alertDue, markAlerted } from "./state.js";
import { sendAlert } from "./alert.js";
import { DEFAULT_RPC } from "./config.js";

/* ----------------------------------------------------------------- config */

// The spending rules live in policy.ts, pure and tested on their own. These
// re-exports keep the old import sites working and give the tests one place to read
// the live numbers from.
export {
  decidePolicy, computeMovement, POLICY_HEARTBEAT as HEARTBEAT_SECONDS,
  POLICY_MOVE_BPS as MOVE_BPS, MOVE_COOLDOWN_SECONDS, MAX_POSTS_PER_UTC_DAY,
  BALANCE_FLOOR_WEI, COST_CAP_WEI, STEADY_STATE_COST_WEI,
};

const LOCK_PATH = process.env["STATERA_LOCK"] ?? "/tmp/statera-keeper.lock";
const LOG_PATH = process.env["STATERA_KEEPER_LOG"] ?? "/var/log/statera-keeper.log";
const LOCK_STALE_MS = 15 * 60 * 1000;

export const xlayer = defineChain({
  id: 196,
  name: "X Layer",
  nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
  rpcUrls: { default: { http: [DEFAULT_RPC] } },
});


/* -------------------------------------------------------------------- abi */

export const FEED_ABI = [
  {
    type: "function",
    name: "post",
    stateMutability: "nonpayable",
    inputs: [
      { name: "engineBlock", type: "uint40" },
      {
        name: "rows",
        type: "tuple[]",
        components: [
          { name: "token", type: "address" },
          { name: "form", type: "uint8" },
          { name: "sizeTierUsd", type: "uint32" },
          { name: "markUsd", type: "uint128" },
          { name: "realisableUsd", type: "uint128" },
          { name: "fillableUsd", type: "uint128" },
          { name: "gapBps", type: "int32" },
          { name: "status", type: "uint8" },
        ],
      },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "latestFor",
    stateMutability: "view",
    inputs: [
      { name: "token", type: "address" },
      { name: "form", type: "uint8" },
      { name: "sizeTierUsd", type: "uint32" },
    ],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "markUsd", type: "uint128" },
          { name: "realisableUsd", type: "uint128" },
          { name: "fillableUsd", type: "uint128" },
          { name: "gapBps", type: "int32" },
          { name: "status", type: "uint8" },
          { name: "engineBlock", type: "uint40" },
          { name: "publishedAt", type: "uint48" },
        ],
      },
    ],
  },
  { type: "function", name: "lastPublishedAt", stateMutability: "view", inputs: [], outputs: [{ type: "uint48" }] },
  { type: "function", name: "lastEngineBlock", stateMutability: "view", inputs: [], outputs: [{ type: "uint40" }] },
  { type: "function", name: "publisher", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "runCount", stateMutability: "view", inputs: [], outputs: [{ type: "uint64" }] },
  { type: "function", name: "lastEngineBlock", stateMutability: "view", inputs: [], outputs: [{ type: "uint40" }] },
] as const;

/* ------------------------------------------------------------------- lock */

/**
 * Exclusive lock so two runs never overlap. The cron line also wraps this in
 * flock(1) on the VPS; this in-process lock is the portable backstop, because
 * macOS has no flock binary and a keeper that double-posts wastes real OKB.
 */
export function acquireLock(path = LOCK_PATH, attempt = 0): () => void {
  // A token unique to this acquisition. Release only removes the file if the token
  // still matches, so a run that overran its stale window and had its lock broken
  // cannot delete the lock now held by its successor — which would have let a third
  // run start alongside the second and double-post.
  const token = `${process.pid}:${randomUUID()}`;
  try {
    const fd = openSync(path, "wx");
    writeFileSync(fd, `${token}\n${new Date().toISOString()}\n`);
    closeSync(fd);
  } catch (e: any) {
    if (e?.code !== "EEXIST") throw e;
    if (attempt >= 2) throw new Error(`could not take ${path} after breaking a stale lock`);

    // Decide staleness from the timestamp, and fall back to the file's mtime when
    // that line is missing or unparseable. Without the fallback a zero-byte lock —
    // exactly what a crash between create and write leaves behind — could never be
    // broken, and the keeper would stay silent forever.
    let ageMs: number | null = null;
    try {
      const raw = rf(path, "utf8").split("\n");
      const when = Date.parse(raw[1] ?? "");
      if (Number.isFinite(when)) ageMs = Date.now() - when;
    } catch {
      /* fall through to mtime */
    }
    if (ageMs === null) {
      try {
        ageMs = Date.now() - statSync(path).mtimeMs;
      } catch {
        ageMs = LOCK_STALE_MS + 1; // the file vanished; treat it as gone
      }
    }
    if (ageMs <= LOCK_STALE_MS) throw new Error(`another keeper run holds ${path}`);
    try {
      unlinkSync(path);
    } catch {
      /* someone else broke it first */
    }
    return acquireLock(path, attempt + 1);
  }

  return () => {
    try {
      const held = rf(path, "utf8").split("\n")[0];
      if (held !== token) return; // not ours any more; leave it alone
      unlinkSync(path);
    } catch {
      /* already gone */
    }
  };
}

/* ------------------------------------------------------------------- cost */

async function okbUsd(): Promise<number | null> {
  try {
    const r = await fetch("https://www.okx.com/api/v5/market/ticker?instId=OKB-USDT");
    const j: any = await r.json();
    const t = j?.data?.[0];
    const bid = Number(t?.bidPx);
    const ask = Number(t?.askPx);
    if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0) return (bid + ask) / 2;
    const last = Number(t?.last);
    return Number.isFinite(last) ? last : null;
  } catch {
    return null;
  }
}

function logLine(o: Record<string, unknown>): void {
  const line = JSON.stringify({ at: new Date().toISOString(), ...o });
  console.log(line);
  try {
    appendFileSync(LOG_PATH, line + "\n");
  } catch {
    /* logging must never break a run */
  }
}

/* ------------------------------------------------------------------- main */

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const wantPost = argv.includes("--post");
  const feedAddress = (process.env["STATERA_FEED"] ?? "") as Hex;
  // Two RPCs, because they are two different jobs. STATERA_RPC is where the engine
  // reads pool state from; STATERA_CHAIN_RPC is where the feed lives and the
  // transaction goes.
  const rpcUrl = process.env["STATERA_RPC"] ?? DEFAULT_RPC;
  const chainRpcUrl = process.env["STATERA_CHAIN_RPC"] ?? rpcUrl;
  // Secrets never live inside a git working tree; the default is outside the repo.
  const keyPath = process.env["STATERA_KEY"] ?? join(homedir(), ".config", "statera", "deploykey");

  if (!feedAddress) throw new Error("set STATERA_FEED to the deployed StateraFeed address");

  // A held lock means the previous run is still working — ordinary under a 10-minute
  // cron when a run overruns, so it logs one line and exits 0 rather than throwing.
  let release: () => void;
  try {
    release = acquireLock();
  } catch (e) {
    logLine({ event: "locked", message: e instanceof Error ? e.message : String(e) });
    return;
  }
  const started = Date.now();
  const nowSec = Math.floor(Date.now() / 1000);
  let state = rollDay(loadState(nowSec), nowSec);

  /** Send an alert at most once per UTC day per kind, and never fail the run over it. */
  const alert = async (kind: AlertKind, message: string): Promise<void> => {
    if (!alertDue(state, kind, nowSec)) {
      logLine({ event: "alert-suppressed", kind, reason: "already sent today" });
      return;
    }
    const r = await sendAlert(kind, message);
    state = markAlerted(state, kind, nowSec);
    saveState(state);
    logLine({ event: "alert", kind, sent: r.sent, detail: r.detail });
  };

  try {
    const pub = createPublicClient({ chain: xlayer, transport: http(chainRpcUrl, { batch: { batchSize: 10 } }) });

    // 1. Measure.
    const report = await runEngine(new Rpc({ url: rpcUrl }));
    const packed = packReport(report);

    // 2. What is onchain, plus the numbers the policy needs.
    const onchain = new Map<string, OnchainRow>();
    for (const r of packed.rows) {
      const got: any = await pub.readContract({
        address: feedAddress,
        abi: FEED_ABI,
        functionName: "latestFor",
        args: [r.token, r.form, r.sizeTierUsd],
      });
      onchain.set(`${r.token.toLowerCase()}/${r.form}/${r.sizeTierUsd}`, {
        markUsd: BigInt(got.markUsd),
        realisableUsd: BigInt(got.realisableUsd),
        fillableUsd: BigInt(got.fillableUsd),
        status: Number(got.status),
      });
    }
    const lastPublishedAt = Number(
      await pub.readContract({ address: feedAddress, abi: FEED_ABI, functionName: "lastPublishedAt" }),
    );
    const publisher = (await pub.readContract({
      address: feedAddress,
      abi: FEED_ABI,
      functionName: "publisher",
    })) as Hex;
    const balanceWei = await pub.getBalance({ address: publisher });
    const gasPrice = await pub.getGasPrice();
    const movement = computeMovement(packed.rows, onchain);

    // 3. Estimate before deciding: the cost cap is one of the rules, so the policy
    //    cannot be evaluated without it. Estimating as the publisher doubles as a
    //    pre-flight that the feed would ACCEPT this run.
    const args = [packed.engineBlock, packed.rows.map(toTuple)] as const;
    let gas: bigint | null = null;
    let estimateError: string | null = null;
    if (packed.rows.length > 0) {
      try {
        gas = await pub.estimateContractGas({
          address: feedAddress,
          abi: FEED_ABI,
          functionName: "post",
          args: args as any,
          account: publisher,
        });
      } catch (e) {
        estimateError = (e instanceof Error ? e.message : String(e)).split("\n")[0] ?? "unknown";
      }
    }
    const estimatedCostWei = gas === null ? null : gas * gasPrice;

    // 4. Decide.
    const d = decidePolicy({
      nowSec,
      lastPublishedAtSec: lastPublishedAt,
      postsToday: state.postsToday,
      counterDay: state.counterDay,
      balanceWei,
      estimatedCostWei,
      rowCount: packed.rows.length,
      moved: movement.moved,
      newKeys: movement.newKeys,
      statusChanges: movement.statusChanges,
    });

    const px = await okbUsd();
    const base = {
      engineBlock: packed.engineBlock,
      rows: packed.rows.length,
      dropped: packed.dropped,
      code: d.code,
      decision: d.reason,
      utcDay: utcDay(nowSec),
      postsToday: d.postsTodayEffective,
      dailyCap: MAX_POSTS_PER_UTC_DAY,
      ageSeconds: d.ageSeconds,
      balanceOkb: Number(balanceWei) / 1e18,
      gasPriceWei: Number(gasPrice),
      gasEstimate: gas === null ? null : Number(gas),
      estimateError,
      costOkb: estimatedCostWei === null ? null : Number(estimatedCostWei) / 1e18,
      costCapOkb: Number(COST_CAP_WEI) / 1e18,
      movedCount: movement.moved.length,
      moved: movement.moved.slice(0, 6),
      newKeys: movement.newKeys,
      statusChanges: movement.statusChanges,
      elapsedMs: Date.now() - started,
    };

    // The balance-floor alert fires once on the way down, and re-arms if the balance
    // recovers, so a top-up followed by another slide is reported again.
    if (d.code === "refuse-balance-floor") {
      if (!state.balanceFloorAlerted) {
        state = { ...state, balanceFloorAlerted: true };
        saveState(state);
        await alert("balance-floor", `balance ${(Number(balanceWei) / 1e18).toFixed(9)} OKB is below the floor; the feed will go stale`);
      } else {
        logLine({ event: "alert-suppressed", kind: "balance-floor", reason: "already reported on the way down" });
      }
    } else if (state.balanceFloorAlerted && balanceWei >= BALANCE_FLOOR_WEI) {
      state = { ...state, balanceFloorAlerted: false };
      saveState(state);
    }
    if (d.code === "refuse-cost-cap") {
      await alert("gas-spike", d.reason);
    }

    if (!d.post) {
      logLine({ event: "skip", ...base });
      saveState(state);
      return;
    }

    if (!wantPost) {
      logLine({
        event: "dry-run",
        ...base,
        costUsd: estimatedCostWei === null || px === null ? null : (Number(estimatedCostWei) / 1e18) * px,
        wouldBeAccepted: gas !== null,
        note: "no transaction sent; pass --post with STATERA_KEY to publish",
      });
      saveState(state);
      return;
    }

    // 5. Send.
    const key = (() => {
      const repoRoot = resolve(new URL("../..", import.meta.url).pathname);
      if (resolve(keyPath).startsWith(repoRoot + "/")) {
        throw new Error(`refusing to read a key from inside the repo: ${keyPath}`);
      }
      return readFileSync(keyPath, "utf8").trim() as Hex;
    })();
    const account = privateKeyToAccount(key);
    if (publisher.toLowerCase() !== account.address.toLowerCase()) {
      throw new Error(`key ${account.address} is not the feed's publisher (${publisher})`);
    }
    const wallet = createWalletClient({ account, chain: xlayer, transport: http(chainRpcUrl) });

    let hash: Hex;
    try {
      hash = await wallet.writeContract({
        address: feedAddress,
        abi: FEED_ABI,
        functionName: "post",
        args: args as any,
      });
    } catch (e) {
      const msg = (e instanceof Error ? e.message : String(e)).split("\n")[0] ?? "unknown";
      logLine({ event: "post-failed", ...base, stage: "send", message: msg });
      await alert("post-failed", `send failed: ${msg}`);
      process.exitCode = 1;
      return;
    }

    const rc = await pub.waitForTransactionReceipt({ hash });
    if (rc.status !== "success") {
      logLine({ event: "post-failed", ...base, stage: "receipt", txHash: hash, status: rc.status });
      await alert("post-failed", `transaction ${hash} reverted`);
      process.exitCode = 1;
      return;
    }

    const costWei = rc.gasUsed * (rc.effectiveGasPrice ?? 0n);
    const costOkb = Number(costWei) / 1e18;
    state = { ...state, postsToday: d.postsTodayEffective + 1, lastTxHash: hash };
    saveState(state);

    logLine({
      event: "posted",
      ...base,
      postsToday: state.postsToday,
      txHash: hash,
      xlayerBlock: Number(rc.blockNumber),
      gasUsed: Number(rc.gasUsed),
      effectiveGasPriceWei: Number(rc.effectiveGasPrice ?? 0n),
      costOkb,
      okbUsd: px,
      costUsd: px === null ? null : costOkb * px,
      balanceAfterOkb: Number(await pub.getBalance({ address: publisher })) / 1e18,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logLine({ event: "error", message: msg });
    await alert("post-failed", `keeper run failed: ${msg}`);
    process.exitCode = 1;
  } finally {
    release();
  }
}

// Only run when invoked directly, so the pack/decide logic stays importable.
if (process.argv[1] && process.argv[1].endsWith("keeper.js")) {
  void main();
}
