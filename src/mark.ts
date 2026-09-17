/**
 * The independent mark.
 *
 * It must come from somewhere other than the pools statera measures, or the gap
 * would be a tautology: the pool's own spot price against the pool's own depth
 * only ever measures slippage. OKX's public spot order book carries the same
 * tokenized stocks (XNVDA/XTSLA/XSPY), needs no key, and is a different venue,
 * so it is the mark. Failure here yields `unmeasured` and no numbers.
 */

const OKX_TICKER = "https://www.okx.com/api/v5/market/ticker?instId=";

export interface Mark {
  instId: string;
  /** Mid of bid/ask. Falls back to last only if a side is missing. */
  usd: number;
  bid: number;
  ask: number;
  /** Exchange timestamp, ms. */
  tsMs: number;
  ageMs: number;
  source: string;
}

export async function fetchMark(instId: string, timeoutMs = 15_000): Promise<Mark> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(OKX_TICKER + encodeURIComponent(instId), { signal: ac.signal });
    if (!r.ok) throw new Error(`OKX HTTP ${r.status}`);
    const j: any = await r.json();
    if (j.code !== "0") throw new Error(`OKX code ${j.code}: ${j.msg}`);
    const d = j.data?.[0];
    if (!d) throw new Error(`OKX returned no ticker for ${instId}`);
    const bid = Number(d.bidPx), ask = Number(d.askPx), last = Number(d.last);
    const usd = Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0 ? (bid + ask) / 2 : last;
    if (!Number.isFinite(usd) || usd <= 0) throw new Error(`OKX ticker for ${instId} carries no usable price`);
    const tsMs = Number(d.ts);
    return { instId, usd, bid, ask, tsMs, ageMs: Date.now() - tsMs, source: "OKX spot order book (public, no auth)" };
  } finally {
    clearTimeout(t);
  }
}
