// Holdings from a statement, mapped onto the assets a vault can hold. Pure code (no model, no network), shared by the
// server and the browser: pasted holdings are parsed here, and every holding, however it was read, is mapped here,
// with the reason for each line, into a draft that mirrors the portfolio.

import { z } from "zod/v4";
import type { Proposal, UniverseAsset } from "./mandate";

export const ExtractedHoldings = z.object({
  holdings: z
    .array(
      z.object({
        name: z.string().describe("The holding's name as shown, e.g. 'Apple Inc' or 'Vanguard S&P 500 ETF'."),
        ticker: z.string().nullable().describe("The ticker or symbol as shown, uppercase; null when none is shown."),
        asset_class: z.enum(["stock", "fund", "cash", "bond", "crypto", "other"]),
        value_usd: z.number().nullable().describe("Current market value in US dollars as shown; null when not shown."),
      }),
    )
    .describe("Every position visible, in the order shown. Leave out totals, subtotals and headers."),
  note: z.string().describe("One sentence on anything unreadable, cut off or ambiguous; empty when there is none."),
});
export type ExtractedHoldings = z.infer<typeof ExtractedHoldings>;
export type Holding = ExtractedHoldings["holdings"][number];

/** Base64 characters: about 3 MB of image, under the 4.5 MB request limit of serverless functions. The browser shrinks screenshots first. */
export const MAX_IMAGE_BASE64 = 4_000_000;
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;

const CASH_WORDS = /\b(cash|money market|sweep|core position|settlement fund|treasury bills?|t-bills?)\b/i;
const MONEY_MARKET = new Set(["SPAXX", "FDRXX", "VMFXX", "SWVXX", "SNVXX", "FZFXX", "VUSXX", "SPRXX"]);
const CRYPTO = new Set(["BTC", "ETH", "SOL", "XRP", "DOGE", "ADA", "IBIT", "FBTC", "GBTC", "ETHA"]);
const BONDS = new Set(["BND", "AGG", "TLT", "IEF", "SHY", "VGIT", "VGSH", "BSV", "SCHZ", "GOVT", "FXNAX", "VBTLX"]);

/**
 * Holdings pasted as text: one per line, a ticker (or "Cash") and a dollar value, in any common layout ("AAPL
 * $12,300.50", "VOO, 40000", a CSV row with more columns). Lines without both are skipped. No model involved.
 */
export function parseHoldingsText(text: string): ExtractedHoldings {
  const holdings: Holding[] = [];
  for (const raw of text.split(/\r?\n/).slice(0, 200)) {
    const line = raw.trim();
    if (!line || /^(symbol|ticker|total|subtotal)\b/i.test(line)) continue;
    const money = [...line.matchAll(/\$?\s?(-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+(?:\.\d+)?)/g)].map((m) => Number(m[1].replace(/,/g, "")));
    if (money.length === 0) continue;
    const value = money[money.length - 1]; // market value is the last number on most statements
    const cash = CASH_WORDS.test(line);
    const ticker = line.match(/\b[A-Z]{1,5}(?:\.[A-Z])?\b/)?.[0] ?? null;
    if (!cash && !ticker) continue;
    const t = cash && !(ticker && MONEY_MARKET.has(ticker)) ? null : ticker;
    // The description is what is left once the ticker, numbers and filler are taken out ("APPLE INC", "Cash").
    const name = line
      .replace(/\$?\s?-?\d[\d,]*(?:\.\d+)?/g, " ")
      .replace(t ? new RegExp(`\\b${t.replace(".", "\\.")}\\b\\**`) : /^$/, " ")
      .replace(/\b(shares?|sh|worth|at|@|x)\b/gi, " ")
      .replace(/[$",*|;]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 60);
    holdings.push({ name: name || t || "Cash", ticker: t, asset_class: cash ? "cash" : classify(t), value_usd: value });
  }
  return { holdings, note: holdings.length === 0 ? "No lines with a ticker and a dollar value were found." : "" };
}

function classify(ticker: string | null): Holding["asset_class"] {
  if (!ticker) return "other";
  if (MONEY_MARKET.has(ticker)) return "cash";
  if (CRYPTO.has(ticker)) return "crypto";
  if (BONDS.has(ticker)) return "bond";
  return "stock";
}

/** Broad US-market funds, mapped to the S&P 500 token. */
const BROAD_MARKET = new Set(["SPY", "VOO", "IVV", "SPLG", "VTI", "ITOT", "SCHB", "SCHX", "FXAIX", "SWPPX", "VFIAX", "VTSAX", "FSKAX", "VV", "RSP"]);

export interface MappedLine {
  name: string;
  valueUsd: number;
  /** The vault asset it counts toward, or null when it was left out. */
  to: string | null;
  why: string;
}

export interface ImportResult {
  proposal: Proposal;
  lines: MappedLine[];
  totalUsd: number;
  /** Value left out (crypto, holdings without a value or with no counterpart), not part of the mandate. */
  leftOutUsd: number;
}

/**
 * Maps holdings onto the vault's assets, mirroring the portfolio's mix: a listed ticker as itself, broad US funds to
 * the S&P 500 token, cash and money-market funds to the stablecoin, other single stocks and equity funds to the S&P 500
 * token as the closest broad exposure; bonds to the stablecoin as the nearest low-risk holding; crypto is left out.
 * Weights are rounded to half percents and add up to exactly 100.
 */
export function mapToUniverse(extracted: ExtractedHoldings, universe: Pick<UniverseAsset, "symbol" | "stable">[]): ImportResult {
  const stable = universe.find((a) => a.stable)?.symbol ?? null;
  const broad = universe.find((a) => a.symbol === "SPY")?.symbol ?? null;
  const listed = new Set(universe.map((a) => a.symbol.toUpperCase()));
  const lines: MappedLine[] = extracted.holdings.map((h) => {
    const name = h.ticker && h.name && h.name.toUpperCase() !== h.ticker.toUpperCase() ? `${h.ticker} (${h.name})` : h.ticker ?? h.name;
    const value = h.value_usd ?? 0;
    const t = h.ticker?.toUpperCase() ?? null;
    if (h.value_usd === null || value <= 0) return { name, valueUsd: 0, to: null, why: "No market value shown." };
    if (h.asset_class === "crypto" || (t && CRYPTO.has(t))) return { name, valueUsd: value, to: null, why: "Crypto is not among the vault's assets; left out." };
    if (t && listed.has(t)) return { name, valueUsd: value, to: t, why: "Listed as a tokenized asset." };
    if (h.asset_class === "cash" || (t && MONEY_MARKET.has(t))) return { name, valueUsd: value, to: stable, why: "Cash or a money-market fund: held as the stablecoin." };
    if (h.asset_class === "bond" || (t && BONDS.has(t))) return { name, valueUsd: value, to: stable, why: "No bond token is listed; the stablecoin is the nearest low-risk holding." };
    if (t && BROAD_MARKET.has(t)) return { name, valueUsd: value, to: broad, why: "A broad US-market fund: mapped to the S&P 500 token." };
    if (h.asset_class === "stock" || h.asset_class === "fund") return { name, valueUsd: value, to: broad, why: "No tokenized version is listed: mapped to the S&P 500 token as the closest broad exposure." };
    return { name, valueUsd: value, to: null, why: "Not something the vault can hold; left out." };
  });

  const counted = lines.filter((l) => l.to !== null);
  const totalUsd = lines.reduce((s, l) => s + l.valueUsd, 0);
  const matched = counted.reduce((s, l) => s + l.valueUsd, 0);
  if (matched <= 0) throw new Error("None of these holdings could be mapped to the vault's assets.");

  const bySymbol = new Map<string, { usd: number; from: string[] }>();
  for (const l of counted) {
    const e = bySymbol.get(l.to!) ?? { usd: 0, from: [] };
    e.usd += l.valueUsd;
    e.from.push(l.name.split(" (")[0]);
    bySymbol.set(l.to!, e);
  }
  const weights = halfPercents(universe.map((a) => (bySymbol.get(a.symbol)?.usd ?? 0) / matched));
  const stableShare = stable ? weights[universe.findIndex((a) => a.symbol === stable)] : 0;
  const risk: Proposal["risk_level"] = stableShare >= 50 ? "conservative" : stableShare >= 25 ? "balanced" : stableShare >= 10 ? "growth" : "aggressive";
  const band = { conservative: 3, balanced: 5, growth: 7, aggressive: 10 }[risk];
  const fmt = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
  return {
    proposal: {
      summary: `Mirrors the ${counted.length} holding${counted.length === 1 ? "" : "s"} from your statement (${fmt(matched)}): ${100 - stableShare}% stocks, ${stableShare}% cash. Adjust it in your own words below.`,
      risk_level: risk,
      allocations: universe.map((a, i) => {
        const e = bySymbol.get(a.symbol);
        const from = e ? [...new Set(e.from)] : [];
        return {
          symbol: a.symbol,
          weight_percent: weights[i],
          reason: e ? `From ${from.slice(0, 4).join(", ")}${from.length > 4 ? ` and ${from.length - 4} more` : ""} (${fmt(e.usd)}).` : "Not in your statement.",
        };
      }),
      band_percent: band,
      max_trade_percent: 10,
      daily_turnover_percent: 30,
    },
    lines,
    totalUsd,
    leftOutUsd: totalUsd - matched,
  };
}

/** Shares (summing to 1) as half-percent weights summing to exactly 100: largest remainders get the leftover halves. */
export function halfPercents(shares: number[]): number[] {
  const units = shares.map((s) => s * 200);
  const out = units.map(Math.floor);
  let left = 200 - out.reduce((s, x) => s + x, 0);
  const order = units.map((u, i) => ({ i, r: u - Math.floor(u) })).sort((a, b) => b.r - a.r || a.i - b.i);
  for (let k = 0; left > 0; k = (k + 1) % order.length, left--) out[order[k].i]++;
  return out.map((u) => u / 2);
}
