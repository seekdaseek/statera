/**
 * Minimal JSON-RPC client. Read-only by construction: the only methods used are
 * eth_chainId, eth_blockNumber, eth_call and eth_getStorageAt. Nothing here can
 * sign or send a transaction.
 *
 * Calls are batched because the depth engine needs a few hundred tick reads per
 * pool, and issued against a pinned block so every number in one report
 * describes the same chain state.
 */

export class RpcError extends Error {}

export interface RpcOpts {
  url?: string;
  timeoutMs?: number;
  retries?: number;
  batchSize?: number;
  /** Max slices in flight. Lower it when the endpoint throttles by request rate. */
  concurrency?: number;
  /** Minimum gap between HTTP round trips, in ms. 0 disables the throttle. */
  minIntervalMs?: number;
}

interface Call {
  to: string;
  data: string;
}

export class Rpc {
  readonly url: string;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly batchSize: number;
  readonly concurrency: number;
  private readonly minIntervalMs: number;
  /** Serialises the rate gate: each request waits for the previous one's slot. */
  private gate: Promise<void> = Promise.resolve();
  private nextSlot = 0;
  private id = 0;
  /** Per-item rate-limit rejections that had to be retried. Reported as a warning. */
  throttled = 0;
  /** Count of HTTP round trips, so the report can state its own cost. */
  calls = 0;

  constructor(o: RpcOpts = {}) {
    this.url = o.url ?? process.env["STATERA_RPC"] ?? "https://rpc.xlayer.tech";
    // A cold archive node, or an anvil fork proxying uncached calls upstream, can
    // take far longer per request than the public endpoint does. Overridable so a
    // slow backend degrades in speed rather than failing the run.
    this.timeoutMs = o.timeoutMs ?? Number(process.env["STATERA_RPC_TIMEOUT_MS"] ?? 20_000);
    this.retries = o.retries ?? 3;
    // rpc.xlayer.tech rejects batches above 10 with -32014 "too many RPC calls
    // in batch request" (measured: 10 ok, 11 not), so batches are capped there.
    this.batchSize = o.batchSize ?? 10;
    // rpc.xlayer.tech also limits by REQUEST RATE, per IP, and says so as a
    // per-item -32016 inside a 200 OK batch. Concurrency alone does not bound the
    // rate: a box with a low round-trip time to the endpoint issues far more
    // requests per second at the same concurrency than a slower one, which is why
    // this tripped on the VPS and never on the Mac. Both are tunable, and the
    // defaults are what the VPS measured as clean.
    this.concurrency = o.concurrency ?? Number(process.env["STATERA_RPC_CONCURRENCY"] ?? 4);
    this.minIntervalMs = o.minIntervalMs ?? Number(process.env["STATERA_RPC_MIN_INTERVAL_MS"] ?? 25);
  }

  /**
   * Space HTTP round trips at least minIntervalMs apart, whatever the concurrency.
   * Chained through a single promise so the ordering is total rather than per-worker.
   */
  private async rateGate(): Promise<void> {
    if (this.minIntervalMs <= 0) return;
    const mine = this.gate.then(async () => {
      const now = Date.now();
      const at = Math.max(now, this.nextSlot);
      this.nextSlot = at + this.minIntervalMs;
      if (at > now) await new Promise((r) => setTimeout(r, at - now));
    });
    this.gate = mine;
    return mine;
  }

  private async post(body: unknown): Promise<any> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      await this.rateGate();
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), this.timeoutMs);
      try {
        this.calls++;
        const r = await fetch(this.url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: ac.signal,
        });
        if (!r.ok) throw new RpcError(`HTTP ${r.status}`);
        return await r.json();
      } catch (e) {
        lastErr = e;
        if (attempt < this.retries) await new Promise((res) => setTimeout(res, 250 * 2 ** attempt));
      } finally {
        clearTimeout(t);
      }
    }
    throw new RpcError(`rpc failed after ${this.retries + 1} attempts: ${String(lastErr)}`);
  }

  async send(method: string, params: unknown[]): Promise<string> {
    const j = await this.post({ jsonrpc: "2.0", id: ++this.id, method, params });
    if (j.error) throw new RpcError(`${method}: ${j.error.message}`);
    return j.result as string;
  }

  /**
   * Is this per-item JSON-RPC error the endpoint refusing to serve us, rather than
   * the contract refusing the call?
   *
   * THE DISTINCTION IS LOAD-BEARING. A revert means "the answer is: no". Throttling
   * means "no answer". Collapsing the two is how a dropped tickBitmap word becomes
   * an empty word, and an empty word silently understates a pool's depth: the engine
   * then reports a realisable value computed from a ladder with holes in it. The
   * completeness checks catch it (netSumZero, activeMatches), but only after the
   * numbers have already been computed from bad data.
   *
   * -32016 "over rate limit" is what rpc.xlayer.tech returns, inside a 200 OK batch.
   */
  private static retryableItem(err: any): boolean {
    const code = Number(err?.code);
    if (code === -32016 || code === -32005 || code === -32029 || code === 429) return true;
    const m = String(err?.message ?? "").toLowerCase();
    return m.includes("rate limit") || m.includes("too many requests") || m.includes("try again");
  }

  /**
   * One batch slice. If the node rejects the batch wholesale (size limits differ
   * between providers) the slice is halved and retried, down to single calls, so
   * a stricter endpoint degrades in speed rather than failing the report.
   *
   * Items the endpoint throttled are retried with backoff. Items that genuinely
   * reverted become null. An item still throttled after every attempt throws, so
   * the caller sees "unreadable" instead of a plausible wrong number.
   */
  private async slice(calls: Call[], block: string, offset: number, out: (string | null)[]): Promise<void> {
    const body = calls.map((c, k) => ({
      jsonrpc: "2.0",
      id: offset + k,
      method: "eth_call",
      params: [{ to: c.to, data: c.data }, block],
    }));
    const res = await this.post(body);
    if (!Array.isArray(res)) {
      if (calls.length === 1) { out[offset] = null; return; }
      const mid = Math.ceil(calls.length / 2);
      await this.slice(calls.slice(0, mid), block, offset, out);
      await this.slice(calls.slice(mid), block, offset + mid, out);
      return;
    }
    const throttledIdx: number[] = [];
    for (const item of res) {
      const idx = Number(item.id);
      if (!Number.isFinite(idx) || idx < 0 || idx >= out.length) continue;
      if (item.error && Rpc.retryableItem(item.error)) {
        throttledIdx.push(idx);
        continue;
      }
      out[idx] = item.error ? null : (item.result as string);
    }
    if (throttledIdx.length === 0) return;

    this.throttled += throttledIdx.length;
    // Re-ask for exactly the throttled calls, one at a time, backing off. Single
    // calls because the point is to stop competing with ourselves for the budget.
    for (const idx of throttledIdx) {
      const c = calls[idx - offset];
      if (!c) continue;
      let ok = false;
      for (let attempt = 0; attempt < this.retries + 1 && !ok; attempt++) {
        await new Promise((r) => setTimeout(r, 200 * 2 ** attempt));
        const one = await this.post([
          { jsonrpc: "2.0", id: idx, method: "eth_call", params: [{ to: c.to, data: c.data }, block] },
        ]);
        const item = Array.isArray(one) ? one[0] : one;
        if (item?.error && Rpc.retryableItem(item.error)) continue;
        out[idx] = item?.error ? null : (item?.result as string);
        ok = true;
      }
      if (!ok) {
        throw new RpcError(
          `over rate limit on ${c.to} after ${this.retries + 1} retries; ` +
          `refusing to report a partial read (lower STATERA_RPC_CONCURRENCY or raise STATERA_RPC_MIN_INTERVAL_MS)`,
        );
      }
    }
  }

  /**
   * Batched eth_call. Returns results in request order; a reverted call yields
   * null. Slices run with bounded concurrency: a pool's tick ladder is a few
   * hundred reads and sequential batches of ten would dominate runtime.
   */
  async callMany(calls: Call[], block: string, concurrency = this.concurrency): Promise<(string | null)[]> {
    const out: (string | null)[] = new Array(calls.length).fill(null);
    const starts: number[] = [];
    for (let i = 0; i < calls.length; i += this.batchSize) starts.push(i);

    let cursor = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const k = cursor++;
        const start = starts[k];
        if (start === undefined) return;
        await this.slice(calls.slice(start, start + this.batchSize), block, start, out);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, starts.length) }, worker));
    return out;
  }

  async call(to: string, data: string, block = "latest"): Promise<string | null> {
    const [r] = await this.callMany([{ to, data }], block);
    return r ?? null;
  }

  async chainId(): Promise<number> {
    return Number(BigInt(await this.send("eth_chainId", [])));
  }
  async blockNumber(): Promise<number> {
    return Number(BigInt(await this.send("eth_blockNumber", [])));
  }
  async storageAt(addr: string, slot: string, block = "latest"): Promise<string> {
    return this.send("eth_getStorageAt", [addr, slot, block]);
  }

  /**
   * eth_getLogs. rpc.xlayer.tech caps the range at 100 blocks, so callers pass
   * one window at a time. Used only by the live test, which replays real swaps.
   */
  async getLogs(address: string[], topics: (string | null)[], fromBlock: number, toBlock: number): Promise<any[]> {
    const j = await this.post({
      jsonrpc: "2.0", id: ++this.id, method: "eth_getLogs",
      params: [{ address, topics, fromBlock: "0x" + fromBlock.toString(16), toBlock: "0x" + toBlock.toString(16) }],
    });
    if (j.error) throw new RpcError(`eth_getLogs: ${j.error.message}`);
    return (j.result as any[]) ?? [];
  }
}

export const blockTag = (n: number): string => "0x" + n.toString(16);
