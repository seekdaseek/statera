/**
 * Tests for the one place a wrong answer is worse than no answer: how the client
 * classifies a per-item JSON-RPC error inside a batch.
 *
 * rpc.xlayer.tech limits by request rate per IP and reports it as
 * {"code":-32016,"message":"over rate limit"} on the individual item, inside a 200 OK
 * batch response. The client used to map any item error to null, so a throttled
 * tickBitmap read was indistinguishable from a word with no initialised ticks in it.
 * The engine then computed a realisable value from a ladder with holes in it. That is
 * how the VPS reported a third of the Mac's tick count while looking healthy.
 *
 * These run against a stub server, so they pin the behaviour without a network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { Rpc, RpcError } from "../src/rpc.js";

const WORD = "0x" + "11".repeat(32);

/** A stub endpoint. `handler` sees each batched call and returns its JSON-RPC item. */
async function stub(handler: (call: any, hit: number) => any): Promise<{ url: string; close: () => Promise<void>; requests: () => number; at: () => number[] }> {
  let requests = 0;
  const at: number[] = [];
  const hits = new Map<string, number>();
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requests++;
      at.push(Date.now());
      const parsed = JSON.parse(body);
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      const out = arr.map((c: any) => {
        const k = JSON.stringify(c.params?.[0] ?? c.method);
        const n = (hits.get(k) ?? 0) + 1;
        hits.set(k, n);
        return { jsonrpc: "2.0", id: c.id, ...handler(c, n) };
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(Array.isArray(parsed) ? out : out[0]));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
    requests: () => requests,
    at: () => at,
  };
}

test("a throttled item is retried, not reported as a revert", async () => {
  // First ask: over rate limit. Second: the real word. The old client returned null
  // here, and null reads as "no initialised ticks in this word".
  const s = await stub((_c, hit) =>
    hit === 1 ? { error: { code: -32016, message: "over rate limit" } } : { result: WORD });
  try {
    const rpc = new Rpc({ url: s.url, minIntervalMs: 0, retries: 2 });
    const [got] = await rpc.callMany([{ to: "0xpool", data: "0xdead" }], "latest");
    assert.equal(got, WORD, "the retried value must come back, not null");
    assert.equal(rpc.throttled, 1, "and the run must be able to say it was throttled");
  } finally {
    await s.close();
  }
});

test("a genuine revert is still null, so a reverting getter is not a fatal error", async () => {
  const s = await stub(() => ({ error: { code: 3, message: "execution reverted" } }));
  try {
    const rpc = new Rpc({ url: s.url, minIntervalMs: 0, retries: 0 });
    const [got] = await rpc.callMany([{ to: "0xpool", data: "0xdead" }], "latest");
    assert.equal(got, null);
    assert.equal(rpc.throttled, 0, "a revert is not throttling");
  } finally {
    await s.close();
  }
});

test("a call throttled to the end throws rather than returning a plausible null", async () => {
  const s = await stub(() => ({ error: { code: -32016, message: "over rate limit" } }));
  try {
    const rpc = new Rpc({ url: s.url, minIntervalMs: 0, retries: 0 });
    await assert.rejects(
      () => rpc.callMany([{ to: "0xpool", data: "0xdead" }], "latest"),
      (e: unknown) => e instanceof RpcError && /over rate limit/.test((e as Error).message),
      "an unreadable call must be loud; a silent null understates pool depth",
    );
  } finally {
    await s.close();
  }
});

test("the retryable classification covers the codes and the wording", async () => {
  // G1: each of these is asserted against the classifier rather than assumed, and a
  // revert is asserted NOT to match, because the whole point is telling them apart.
  const cases: [any, boolean][] = [
    [{ code: -32016, message: "over rate limit" }, true],
    [{ code: -32005, message: "limit exceeded" }, true],
    [{ code: 429, message: "Too Many Requests" }, true],
    [{ code: -32000, message: "please try again later" }, true],
    [{ code: 3, message: "execution reverted" }, false],
    [{ code: -32000, message: "execution reverted: STF" }, false],
  ];
  for (const [err, want] of cases) {
    const s = await stub((_c, hit) => (hit === 1 ? { error: err } : { result: WORD }));
    try {
      const rpc = new Rpc({ url: s.url, minIntervalMs: 0, retries: 1 });
      const [got] = await rpc.callMany([{ to: "0xpool", data: "0xdead" }], "latest");
      assert.equal(got === WORD, want, `${JSON.stringify(err)} should ${want ? "" : "not "}retry`);
    } finally {
      await s.close();
    }
  }
});

test("the rate gate spaces round trips even when slices run concurrently", async () => {
  // Concurrency alone does not bound a request RATE, which is what the endpoint
  // limits. Four slices at 60ms apart must span at least three gaps.
  const s = await stub(() => ({ result: WORD }));
  try {
    const rpc = new Rpc({ url: s.url, minIntervalMs: 60, batchSize: 1, retries: 0 });
    const t0 = Date.now();
    await rpc.callMany(Array.from({ length: 4 }, () => ({ to: "0xpool", data: "0xdead" })), "latest", 4);
    const span = Date.now() - t0;
    assert.equal(s.requests(), 4);
    assert.ok(span >= 3 * 60, `four requests spanned ${span}ms, expected at least 180ms`);
  } finally {
    await s.close();
  }
});

test("minIntervalMs 0 leaves the gate out of the way entirely", async () => {
  const s = await stub(() => ({ result: WORD }));
  try {
    const rpc = new Rpc({ url: s.url, minIntervalMs: 0, batchSize: 1, retries: 0 });
    const t0 = Date.now();
    await rpc.callMany(Array.from({ length: 6 }, () => ({ to: "0xpool", data: "0xdead" })), "latest", 6);
    assert.ok(Date.now() - t0 < 500, "no throttle means no added latency");
  } finally {
    await s.close();
  }
});
