// Testnet oracle relayer: brings real stock prices to the testnet's MockPriceFeeds, so a testnet vault prices TSLA,
// AAPL, NVDA and SPY like the real market, and stops trading when the real market closes.
//
// Prices come from Pyth's public Hermes API. A feed is updated when the price moved more than `deviationBps`, or the
// onchain value is older than `heartbeatSec`, and only with a price newer than what is onchain. Each update carries
// Pyth's own publish time, so outside market hours (when Pyth stops publishing equities) the onchain price simply
// ages, and the vault's maxPriceAge check stops the pilot. That is the behaviour a mainnet deployment would have.

export const HERMES = "https://hermes.pyth.network";

export interface PythQuote {
  id: string;
  /** Price with 8 decimals, as the feeds store it. */
  answer: bigint;
  /** Confidence, 8 decimals. */
  conf: bigint;
  publishTime: number;
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
export function decide(onchain: OnchainPrice, quote: PythQuote, now: number, p: RelayPolicy = DEFAULT_POLICY): Decision {
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

/** Pyth price ids for US equities, e.g. { TSLA: "0x..." }, looked up by Hermes's search. */
export async function resolveEquityIds(symbols: string[], fetchImpl: Fetch = fetch, base = HERMES): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const symbol of symbols) {
    const res = await fetchImpl(`${base}/v2/price_feeds?query=${encodeURIComponent(symbol)}&asset_type=equity`);
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
export async function fetchQuotes(ids: string[], fetchImpl: Fetch = fetch, base = HERMES): Promise<PythQuote[]> {
  const qs = ids.map((id) => `ids[]=${id}`).join("&");
  const res = await fetchImpl(`${base}/v2/updates/price/latest?${qs}&parsed=true`);
  if (!res.ok) throw new Error(`Hermes price request failed: HTTP ${res.status}`);
  const body = (await res.json()) as { parsed: { id: string; price: { price: string; conf: string; expo: number; publish_time: number } }[] };
  return body.parsed.map((p) => ({
    id: p.id.startsWith("0x") ? p.id : `0x${p.id}`,
    answer: toEightDecimals(BigInt(p.price.price), p.price.expo),
    conf: toEightDecimals(BigInt(p.price.conf), p.price.expo),
    publishTime: p.price.publish_time,
  }));
}
