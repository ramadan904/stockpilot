// Share a strategy as a link: the mandate's allocation and guardrails, compact and URL-safe, so anyone can open it,
// stress-test it and copy it into a vault of their own. Only the proposal travels; no addresses, no keys.

import { Proposal } from "./mandate";

interface Compact {
  s: string;
  r: Proposal["risk_level"];
  w: [string, number][];
  b: number;
  t: number;
  d: number;
}

const toBase64Url = (s: string) => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromBase64Url = (s: string) => decodeURIComponent(escape(atob(s.replace(/-/g, "+").replace(/_/g, "/"))));

export const MAX_SHARED_CHARS = 2_000;

export function encodeStrategy(p: Proposal): string {
  const c: Compact = {
    s: p.summary.slice(0, 280),
    r: p.risk_level,
    w: p.allocations.filter((a) => a.weight_percent > 0).map((a) => [a.symbol, a.weight_percent]),
    b: p.band_percent,
    t: p.max_trade_percent,
    d: p.daily_turnover_percent,
  };
  return toBase64Url(JSON.stringify(c));
}

/** The shared proposal, or null if the link is malformed. Assets left out of the link are at 0%. */
export function decodeStrategy(encoded: string, universe: readonly { symbol: string }[]): Proposal | null {
  if (encoded.length > MAX_SHARED_CHARS) return null;
  try {
    const c = JSON.parse(fromBase64Url(encoded)) as Compact;
    const weights = new Map(c.w.map(([sym, w]) => [String(sym).toUpperCase(), Number(w)]));
    const parsed = Proposal.safeParse({
      summary: String(c.s ?? "").slice(0, 280) || "A shared StockPilot strategy.",
      risk_level: c.r,
      allocations: universe.map((u) => ({ symbol: u.symbol, weight_percent: weights.get(u.symbol.toUpperCase()) ?? 0, reason: "From a shared strategy." })),
      band_percent: Number(c.b),
      max_trade_percent: Number(c.t),
      daily_turnover_percent: Number(c.d),
    });
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
