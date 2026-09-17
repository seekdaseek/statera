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
import { packReport, toTuple, moveBps, type PackedRow } from "./pack.js";
import { DEFAULT_RPC } from "./config.js";

/* ----------------------------------------------------------------- config */

export const MOVE_BPS = 5;
export const HEARTBEAT_SECONDS = 30 * 60;

const LOCK_PATH = process.env["STATERA_LOCK"] ?? "/tmp/statera-keeper.lock";
const LOG_PATH = process.env["STATERA_KEEPER_LOG"] ?? "/Volumes/D/statera/keeper.log";
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

/* --------------------------------------------------------------- decision */

export interface Decision {
  post: boolean;
  reason: string;
  movedRows: { label: string; field: string; bps: number }[];
  ageSeconds: number | null;
}

export function decide(
  packed: PackedRow[],
  onchain: Map<string, { markUsd: bigint; realisableUsd: bigint; fillableUsd: bigint; status: number }>,
  lastPublishedAt: number,
  nowSeconds: number,
): Decision {
  const moved: { label: string; field: string; bps: number }[] = [];
  let newKey = false;
  let statusChange = false;

  for (const r of packed) {
    const k = `${r.token.toLowerCase()}/${r.form}/${r.sizeTierUsd}`;
    const prev = onchain.get(k);
    if (!prev || prev.status === 0) {
      newKey = true;
      moved.push({ label: r.label, field: "new", bps: Number.POSITIVE_INFINITY });
      // NOTE: Infinity is not representable in JSON. The log maps it to the string
      // "unbounded" before writing, so a reader never sees a bare null here.
      continue;
    }
    if (prev.status !== r.status) {
      statusChange = true;
      moved.push({ label: r.label, field: "status", bps: Number.POSITIVE_INFINITY });
      continue;
    }
    for (const [field, a, b] of [
      ["realisableUsd", prev.realisableUsd, r.realisableUsd],
      ["markUsd", prev.markUsd, r.markUsd],
      ["fillableUsd", prev.fillableUsd, r.fillableUsd],
    ] as const) {
      const bps = moveBps(a, b);
      if (bps > MOVE_BPS) moved.push({ label: r.label, field, bps });
    }
  }

  const age = lastPublishedAt === 0 ? null : nowSeconds - lastPublishedAt;
  const heartbeatDue = age === null || age >= HEARTBEAT_SECONDS;

  if (newKey) return { post: true, reason: "a key has never been published", movedRows: moved, ageSeconds: age };
  if (statusChange) return { post: true, reason: "a row changed status", movedRows: moved, ageSeconds: age };
  if (moved.length > 0) {
    return { post: true, reason: `${moved.length} value(s) moved more than ${MOVE_BPS} bps`, movedRows: moved, ageSeconds: age };
  }
  if (heartbeatDue) {
    return {
      post: true,
      reason: age === null ? "no post on record" : `heartbeat: last post ${age}s ago`,
      movedRows: moved,
      ageSeconds: age,
    };
  }
  return { post: false, reason: `nothing moved more than ${MOVE_BPS} bps and last post was ${age}s ago`, movedRows: moved, ageSeconds: age };
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
  // transaction goes. They default to the same endpoint, and separating them is what
  // lets a fork test post locally while still measuring the real chain.
  const rpcUrl = process.env["STATERA_RPC"] ?? DEFAULT_RPC;
  const chainRpcUrl = process.env["STATERA_CHAIN_RPC"] ?? rpcUrl;
  // Secrets never live inside a git working tree; the default is outside the repo.
  const keyPath = process.env["STATERA_KEY"] ?? join(homedir(), ".config", "statera", "deploykey");

  if (!feedAddress) throw new Error("set STATERA_FEED to the deployed StateraFeed address");

  // A held lock means the previous run is still working. That is ordinary under a
  // 5-minute cron, so it logs one line and exits cleanly rather than throwing a
  // stack trace into the cron mail every time a run overruns its slot.
  let release: () => void;
  try {
    release = acquireLock();
  } catch (e) {
    logLine({ event: "locked", message: e instanceof Error ? e.message : String(e) });
    return;
  }
  const started = Date.now();
  try {
    const pub = createPublicClient({ chain: xlayer, transport: http(chainRpcUrl, { batch: { batchSize: 10 } }) });

    // 1. Measure.
    const report = await runEngine(new Rpc({ url: rpcUrl }));
    const packed = packReport(report);

    if (packed.rows.length === 0) {
      logLine({
        event: "skip",
        reason: "engine produced no postable rows",
        engineBlock: packed.engineBlock,
        dropped: packed.dropped,
      });
      return;
    }

    // 2. Compare against what is already onchain.
    const onchain = new Map<string, { markUsd: bigint; realisableUsd: bigint; fillableUsd: bigint; status: number }>();
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
    const nowSeconds = Math.floor(Date.now() / 1000);
    const decision = decide(packed.rows, onchain, lastPublishedAt, nowSeconds);

    const base = {
      engineBlock: packed.engineBlock,
      rows: packed.rows.length,
      dropped: packed.dropped,
      decision: decision.reason,
      moved: decision.movedRows.slice(0, 8).map((m) => ({
        ...m,
        bps: Number.isFinite(m.bps) ? m.bps : "unbounded",
      })),
      elapsedMs: Date.now() - started,
    };

    if (!decision.post) {
      logLine({ event: "skip", ...base });
      return;
    }

    const args = [packed.engineBlock, packed.rows.map(toTuple)] as const;

    // 3. Estimate always; send only when explicitly told to.
    if (!wantPost) {
      // Estimate AS THE PUBLISHER, read from the feed itself. Estimating as nobody
      // just reverts on the publisher check and reports a useless null; estimating as
      // the real publisher also serves as a pre-flight that the feed would ACCEPT
      // this run, so a row the invariants reject shows up here instead of wedging the
      // next real post. STATERA_PUBLISHER overrides it for odd setups.
      let account = process.env["STATERA_PUBLISHER"] as Hex | undefined;
      if (!account) {
        try {
          account = (await pub.readContract({
            address: feedAddress,
            abi: FEED_ABI,
            functionName: "publisher",
          })) as Hex;
        } catch {
          account = undefined;
        }
      }
      let gas: bigint | null = null;
      let estimateError: string | null = null;
      try {
        gas = await pub.estimateContractGas({
          address: feedAddress,
          abi: FEED_ABI,
          functionName: "post",
          args: args as any,
          ...(account ? { account } : {}),
        });
      } catch (e) {
        gas = null;
        // The revert reason is the whole value of a dry run: it names the row the
        // feed would refuse.
        estimateError = (e instanceof Error ? e.message : String(e)).split("\n")[0] ?? "unknown";
      }
      const gasPrice = await pub.getGasPrice();
      const px = await okbUsd();
      logLine({
        event: "dry-run",
        ...base,
        gasEstimate: gas === null ? null : Number(gas),
        gasPriceWei: Number(gasPrice),
        costOkb: gas === null ? null : Number(gas * gasPrice) / 1e18,
        costUsd: gas === null || px === null ? null : (Number(gas * gasPrice) / 1e18) * px,
        estimatedAs: account ?? null,
        estimateError,
        wouldBeAccepted: gas !== null,
        note: "no transaction sent; pass --post with STATERA_KEY to publish",
      });
      return;
    }

    // 4. Send.
    // Refuse a key path inside the repo, so a future convenience edit cannot
    // reintroduce a secret into the working tree.
    const repoRoot = resolve(new URL("../..", import.meta.url).pathname);
    if (resolve(keyPath).startsWith(repoRoot + "/")) {
      throw new Error(`refusing to read a key from inside the repo: ${keyPath}`);
    }
    const key = readFileSync(keyPath, "utf8").trim() as Hex;
    const account = privateKeyToAccount(key);
    const wallet = createWalletClient({ account, chain: xlayer, transport: http(chainRpcUrl) });

    const publisher = (await pub.readContract({
      address: feedAddress,
      abi: FEED_ABI,
      functionName: "publisher",
    })) as Hex;
    if (publisher.toLowerCase() !== account.address.toLowerCase()) {
      throw new Error(`key ${account.address} is not the feed's publisher (${publisher})`);
    }

    const hash = await wallet.writeContract({
      address: feedAddress,
      abi: FEED_ABI,
      functionName: "post",
      args: args as any,
    });
    const rc = await pub.waitForTransactionReceipt({ hash });
    const px = await okbUsd();
    const costWei = rc.gasUsed * (rc.effectiveGasPrice ?? 0n);
    const costOkb = Number(costWei) / 1e18;

    logLine({
      event: "posted",
      ...base,
      txHash: hash,
      status: rc.status,
      xlayerBlock: Number(rc.blockNumber),
      gasUsed: Number(rc.gasUsed),
      effectiveGasPriceWei: Number(rc.effectiveGasPrice ?? 0n),
      costOkb,
      okbUsd: px,
      costUsd: px === null ? null : costOkb * px,
    });
  } catch (e) {
    logLine({ event: "error", message: e instanceof Error ? e.message : String(e) });
    process.exitCode = 1;
  } finally {
    release();
  }
}

// Only run when invoked directly, so the pack/decide logic stays importable.
if (process.argv[1] && process.argv[1].endsWith("keeper.js")) {
  void main();
}
