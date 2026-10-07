// The facts a report is written from, and the deterministic report used without Claude. Browser-safe: the web app
// builds ReportFacts from the chain or the simulator and sends them to the server.

import { z } from "zod/v4";
import { valueOf, type VaultState } from "./model";
import { drift } from "./planner";

export const ReportFacts = z.object({
  period: z.string().max(60).describe('e.g. "the last 7 days" or "this session"'),
  valueStartUsd: z.number().nullable(),
  valueNowUsd: z.number(),
  paused: z.boolean(),
  budgetLeftUsd: z.number(),
  feeBps: z.number(),
  holdings: z
    .array(
      z.object({
        symbol: z.string().max(12),
        valueUsd: z.number(),
        weightPct: z.number(),
        targetPct: z.number(),
        bandPct: z.number(),
        priceChangePct: z.number().nullable(),
      }),
    )
    .max(8),
  trades: z
    .array(
      z.object({
        sold: z.string().max(12),
        bought: z.string().max(12),
        valueUsd: z.number(),
        reason: z.string().max(400).nullable(),
      }),
    )
    .max(50),
  blocked: z.array(z.object({ attempt: z.string().max(80), reason: z.string().max(200) })).max(20),
});
export type ReportFacts = z.infer<typeof ReportFacts>;

export const Report = z.object({
  headline: z.string().describe("One sentence, at most 14 words, on the most important thing that happened."),
  summary: z.string().describe("Two short paragraphs in plain English for the owner. Use only numbers from the facts."),
  highlights: z.array(z.string()).describe("Two to four bullet points, each one sentence."),
  watch: z.array(z.string()).describe("Zero to three things the owner may want to keep an eye on, each one sentence."),
});
export type Report = z.infer<typeof Report>;

const money = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

/** A plain report straight from the facts, for when Claude is not configured or not reachable. */
export function basicReport(f: ReportFacts): Report {
  const change = f.valueStartUsd ? ((f.valueNowUsd - f.valueStartUsd) / f.valueStartUsd) * 100 : null;
  const volume = f.trades.reduce((s, t) => s + t.valueUsd, 0);
  const drifting = f.holdings.filter((h) => Math.abs(h.weightPct - h.targetPct) > h.bandPct / 2);
  const biggestMove = [...f.holdings].filter((h) => h.priceChangePct !== null).sort((a, b) => Math.abs(b.priceChangePct!) - Math.abs(a.priceChangePct!))[0];

  const headline =
    f.trades.length === 0
      ? `No trades during ${f.period}; the portfolio stayed near target.`
      : `${f.trades.length} rebalancing trade${f.trades.length === 1 ? "" : "s"} during ${f.period}, ${money(volume)} in total.`;
  const valueLine =
    change === null ? `The portfolio is worth ${money(f.valueNowUsd)}.` : `The portfolio went from ${money(f.valueStartUsd!)} to ${money(f.valueNowUsd)} (${change >= 0 ? "+" : ""}${change.toFixed(2)}%).`;
  const tradeLine =
    f.trades.length === 0
      ? "The pilot did not need to trade."
      : `The pilot traded ${f.trades.map((t) => `${money(t.valueUsd)} of ${t.sold} into ${t.bought}`).join("; ")}.`;
  const highlights = [
    biggestMove ? `${biggestMove.symbol} moved the most: ${biggestMove.priceChangePct! >= 0 ? "+" : ""}${biggestMove.priceChangePct!.toFixed(1)}%.` : null,
    f.blocked.length ? `The vault blocked ${f.blocked.length} trade attempt${f.blocked.length === 1 ? "" : "s"} that broke the mandate.` : null,
    `Every asset is ${drifting.length === 0 ? "within" : "mostly within"} its rebalancing trigger.`,
    f.feeBps ? `The pilot's fee is ${(f.feeBps / 100).toFixed(2)}% a year.` : null,
  ].filter((x): x is string => x !== null);
  const watch = [
    ...drifting.map((h) => `${h.symbol} is at ${h.weightPct.toFixed(1)}% against a ${h.targetPct.toFixed(1)}% target.`),
    f.paused ? "The vault is paused: the pilot will not trade until you unpause it." : null,
    f.budgetLeftUsd < 1 ? "The pilot has used its trading budget; it refills over the next 24 hours." : null,
  ].filter((x): x is string => x !== null);
  return { headline, summary: `${valueLine} ${tradeLine}`, highlights, watch };
}

const num = (wad: bigint) => Number(wad / 10n ** 14n) / 10_000;

/** The holdings part of ReportFacts, from any vault state. `startPrices` (by symbol) adds price changes. */
export function holdingsFacts(state: VaultState, startPrices?: Record<string, bigint>): ReportFacts["holdings"] {
  const d = drift(state);
  return state.assets.map((a, i) => {
    const start = startPrices?.[a.symbol];
    return {
      symbol: a.symbol,
      valueUsd: Math.round(num(valueOf(a.balance, a.price, a.decimals)) * 100) / 100,
      weightPct: d[i].weightBps / 100,
      targetPct: d[i].targetBps / 100,
      bandPct: d[i].bandBps / 100,
      priceChangePct: start ? Math.round((Number(((a.price - start) * 100_000n) / start) / 1000) * 100) / 100 : null,
    };
  });
}

/** Total value in USD, rounded to cents. */
export function valueFacts(state: VaultState) {
  return Math.round(num(state.assets.reduce((t, a) => t + valueOf(a.balance, a.price, a.decimals), 0n)) * 100) / 100;
}
