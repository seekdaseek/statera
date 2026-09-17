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
  private id = 0;
  /** Count of HTTP round trips, so the report can state its own cost. */
  calls = 0;

  constructor(o: RpcOpts = {}) {
    this.url = o.url ?? process.env["STATERA_RPC"] ?? "https://rpc.xlayer.tech";
    this.timeoutMs = o.timeoutMs ?? 20_000;
    this.retries = o.retries ?? 3;
    // rpc.xlayer.tech rejects batches above 10 with -32014 "too many RPC calls
    // in batch request" (measured: 10 ok, 11 not), so batches are capped there.
    this.batchSize = o.batchSize ?? 10;
  }

  private async post(body: unknown): Promise<any> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
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
   * One batch slice. If the node rejects the batch wholesale (size limits differ
   * between providers) the slice is halved and retried, down to single calls, so
   * a stricter endpoint degrades in speed rather than failing the report.
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
    for (const item of res) {
      const idx = Number(item.id);
      if (Number.isFinite(idx) && idx >= 0 && idx < out.length) {
        out[idx] = item.error ? null : (item.result as string);
      }
    }
  }

  /**
   * Batched eth_call. Returns results in request order; a reverted call yields
   * null. Slices run with bounded concurrency: a pool's tick ladder is a few
   * hundred reads and sequential batches of ten would dominate runtime.
   */
  async callMany(calls: Call[], block: string, concurrency = 4): Promise<(string | null)[]> {
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
