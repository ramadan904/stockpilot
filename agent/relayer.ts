// Testnet oracle relayer: brings real stock prices to the testnet's MockPriceFeeds, so a testnet vault prices TSLA,
// AAPL, NVDA and SPY like the real market, and stops trading when the real market closes.
//
// Prices come from Yahoo Finance's public chart API, which needs no key, or from Pyth's Hermes when PYTH_API_KEY is set
// (since the Pyth Core upgrade of 26 Aug 2026, Hermes serves prices only with a key, on a paid plan). A feed is updated when the price moved more than `deviationBps`, or the
// onchain value is older than `heartbeatSec`, and only with a price newer than what is onchain. Each update carries
// the source's own publish time (the last trade's), so outside market hours the onchain price simply
// ages, and the vault's maxPriceAge check stops the pilot. That is the behaviour a mainnet deployment would have.

export const HERMES = "https://hermes.pyth.network";
/** Hermes for API-key holders, since the Pyth Core upgrade. */
export const HERMES_KEYED = "https://pyth.dourolabs.app/hermes";
export const YAHOO = "https://query1.finance.yahoo.com";

export interface Quote {
  /** Price with 8 decimals, as the feeds store it. */
  answer: bigint;
  /** Confidence, 8 decimals (0 when the source gives none). */
  conf: bigint;
  publishTime: number;
}

export interface PythQuote extends Quote {
  id: string;
}

export interface OnchainPrice {
  answer: bigint;
  updatedAt: number;
}

export interface RelayPolicy {
  deviationBps: number;
  heartbeatSec: number;
  /** Ignore quotes older than this; they are a closed market, not a price. */
  maxQuoteAgeSec: number;
  /** Ignore quotes whose confidence interval is wider than this share of the price. */
  maxConfBps: number;
}

export const DEFAULT_POLICY: RelayPolicy = { deviationBps: 20, heartbeatSec: 1_800, maxQuoteAgeSec: 120, maxConfBps: 100 };

export type Decision = { push: true; why: string } | { push: false; why: string };

/** Should this quote be written onchain? */
export function decide(onchain: OnchainPrice, quote: Quote, now: number, p: RelayPolicy = DEFAULT_POLICY): Decision {
  if (quote.answer <= 0n) return { push: false, why: "non-positive price" };
  if (now - quote.publishTime > p.maxQuoteAgeSec) return { push: false, why: `quote is ${now - quote.publishTime}s old (market closed?)` };
  if (quote.conf * 10_000n > quote.answer * BigInt(p.maxConfBps)) return { push: false, why: "confidence interval too wide" };
  const diff = quote.answer > onchain.answer ? quote.answer - onchain.answer : onchain.answer - quote.answer;
  const moved = onchain.answer === 0n ? Infinity : Number((diff * 1_000_000n) / onchain.answer) / 100;
  // A real, fresh price that differs a lot always wins, even over a newer-stamped value (e.g. the placeholder a feed
  // is deployed with). It is written with its own publish time, never a later one.
  if (moved >= p.deviationBps) return { push: true, why: `moved ${(moved / 100).toFixed(2)}%` };
  if (quote.publishTime <= onchain.updatedAt) return { push: false, why: "onchain price is as new" };
  if (now - onchain.updatedAt >= p.heartbeatSec) return { push: true, why: "heartbeat" };
  return { push: false, why: `moved only ${(moved / 100).toFixed(3)}%` };
}

/** Scale a Pyth (price, expo) pair to 8 decimals. */
export function toEightDecimals(value: bigint, expo: number): bigint {
  const shift = expo + 8;
  return shift >= 0 ? value * 10n ** BigInt(shift) : value / 10n ** BigInt(-shift);
}

type Fetch = typeof fetch;

const bearer = (apiKey?: string): RequestInit | undefined => (apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : undefined);

/** Pyth price ids for US equities, e.g. { TSLA: "0x..." }, looked up by Hermes's search. */
export async function resolveEquityIds(symbols: string[], fetchImpl: Fetch = fetch, base = HERMES, apiKey?: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const symbol of symbols) {
    const res = await fetchImpl(`${base}/v2/price_feeds?query=${encodeURIComponent(symbol)}&asset_type=equity`, bearer(apiKey));
    if (!res.ok) throw new Error(`Hermes search for ${symbol} failed: HTTP ${res.status}`);
    const feeds = (await res.json()) as { id: string; attributes: Record<string, string> }[];
    const wanted = `Equity.US.${symbol}/USD`;
    const hit = feeds.find((f) => f.attributes?.symbol === wanted);
    if (!hit) throw new Error(`No Pyth feed named ${wanted}. Set PYTH_IDS to map it by hand.`);
    out[symbol] = hit.id.startsWith("0x") ? hit.id : `0x${hit.id}`;
  }
  return out;
}

/** Latest quotes for the given ids from Hermes. */
export async function fetchQuotes(ids: string[], fetchImpl: Fetch = fetch, base = HERMES, apiKey?: string): Promise<PythQuote[]> {
  const qs = ids.map((id) => `ids[]=${id}`).join("&");
  const res = await fetchImpl(`${base}/v2/updates/price/latest?${qs}&parsed=true`, bearer(apiKey));
  if (res.status === 401 && !apiKey) throw new Error("Hermes price request failed: HTTP 401 (Hermes now needs PYTH_API_KEY; leave it unset to use the keyless Yahoo source)");
  if (!res.ok) throw new Error(`Hermes price request failed: HTTP ${res.status}`);
  const body = (await res.json()) as { parsed: { id: string; price: { price: string; conf: string; expo: number; publish_time: number } }[] };
  return body.parsed.map((p) => ({
    id: p.id.startsWith("0x") ? p.id : `0x${p.id}`,
    answer: toEightDecimals(BigInt(p.price.price), p.price.expo),
    conf: toEightDecimals(BigInt(p.price.conf), p.price.expo),
    publishTime: p.price.publish_time,
  }));
}

/** Latest US quotes from Yahoo Finance's public chart API (no key), each stamped with its last trade's time. */
export async function fetchYahooQuotes(symbols: string[], fetchImpl: Fetch = fetch, base = YAHOO): Promise<Record<string, Quote>> {
  const out: Record<string, Quote> = {};
  for (const symbol of symbols) {
    const res = await fetchImpl(`${base}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1m&range=1d`, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; StockPilot testnet relayer)" },
    });
    if (!res.ok) throw new Error(`Yahoo quote for ${symbol} failed: HTTP ${res.status}`);
    const body = (await res.json()) as { chart?: { result?: { meta?: { currency?: string; regularMarketPrice?: number; regularMarketTime?: number } }[] | null } };
    const meta = body.chart?.result?.[0]?.meta;
    if (meta?.currency !== "USD" || !(Number(meta.regularMarketPrice) > 0) || !meta.regularMarketTime) throw new Error(`Yahoo has no USD price for ${symbol}`);
    out[symbol] = { answer: BigInt(Math.round(meta.regularMarketPrice! * 1e8)), conf: 0n, publishTime: meta.regularMarketTime };
  }
  return out;
}
