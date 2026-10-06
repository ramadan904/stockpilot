// "Ask your vault": an owner asks a question in plain words and gets an answer grounded in the vault's own facts,
// read from the chain by code. Claude may only use those facts, must cite the transactions it relies on, and every
// citation is checked against the facts before the answer is shown, so it cannot point at a trade that never
// happened. Trade reasons count as the pilot's own words only when their hash matches the one committed onchain.

import type Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { keccak256, toHex } from "viem";
import { z } from "zod/v4";
import { MODEL, defaultClient } from "./strategist";

const Tx = z.string().regex(/^0x[0-9a-fA-F]{64}$/);

export const VaultFacts = z.object({
  vault: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  chain: z.string(),
  asOf: z.string(),
  status: z.object({
    paused: z.boolean(),
    totalUsd: z.number(),
    pilot: z.string(),
    pilotName: z.string().nullable(),
    feePercentPerYear: z.number(),
    nextMove: z.string(),
  }),
  holdings: z
    .array(
      z.object({
        symbol: z.string(),
        valueUsd: z.number(),
        weightPct: z.number(),
        targetPct: z.number(),
        bandPct: z.number(),
        priceUsd: z.number(),
        priceAgeMinutes: z.number(),
      }),
    )
    .max(8),
  limits: z.object({
    maxTradeUsd: z.number(),
    dailyLimitUsd: z.number(),
    budgetLeftUsd: z.number(),
    maxSlippagePct: z.number(),
    cooldownMinutes: z.number(),
    maxPriceAgeMinutes: z.number(),
  }),
  trades: z
    .array(
      z.object({
        tx: Tx,
        time: z.string(),
        sold: z.string(),
        bought: z.string(),
        valueUsd: z.number(),
        rationaleHash: z.string(),
        /** The pilot's written reason, only when it hashes to `rationaleHash`. */
        rationale: z.string().max(2_000).nullable(),
      }),
    )
    .max(40),
  events: z.array(z.object({ tx: Tx, time: z.string(), text: z.string().max(300) })).max(40),
  taxes: z
    .object({ year: z.number(), shortTermGainUsd: z.number(), longTermGainUsd: z.number(), feesPaidUsd: z.number(), unrealizedGainUsd: z.number() })
    .nullable(),
  inheritance: z.object({ heir: z.string().nullable(), periodDays: z.number(), heirCanClaimFrom: z.string().nullable() }),
  crashGuard: z
    .object({ armed: z.boolean(), defensive: z.boolean(), tripsAtFallPct: z.number(), safeAsset: z.string().nullable(), safeTargetPct: z.number(), peakUsd: z.number() })
    .optional(),
});
export type VaultFacts = z.infer<typeof VaultFacts>;

export const Answer = z.object({
  answer: z.string().describe("The answer, in plain words, two to six sentences unless a list is clearer"),
  citations: z.array(z.string()).describe("Transaction hashes from the facts that the answer relies on; empty if none"),
  followUps: z.array(z.string()).describe("Up to three short questions the owner might ask next"),
});
export type Answer = z.infer<typeof Answer>;

export interface Turn {
  question: string;
  answer: string;
}

export interface AskResult extends Answer {
  source: "claude" | "basic";
  /** Citations the model gave that are not in the facts, removed from `citations`. */
  dropped: string[];
}

const SYSTEM = `You answer a portfolio owner's questions about their StockPilot vault. StockPilot is an automated pilot
that rebalances the owner's tokenized stock portfolio, but only inside rules (a mandate) the owner signed onchain:
target weights with bands, a per-trade cap, a 24-hour trade budget, a cooldown, a slippage limit against oracle prices,
and a maximum price age. The owner can pause, withdraw, change the pilot or the rules, name an heir, and arm a crash
guard (past a set fall from the recorded peak, the vault switches to defensive targets and the pilot can only de-risk).

Use only the facts you are given, which code read from the chain. If the facts do not answer the question, say so and
say what would. Never invent numbers, trades, dates or reasons. When you explain why the pilot traded, quote or
paraphrase the trade's rationale if it is given (it is verified against the hash stored onchain); if it is null, say
the written reason is not available here and explain from the numbers instead. Cite the transaction hash of every trade
or event you rely on. Be plain and brief. Do not give investment or tax advice, and do not tell the owner to buy or
sell; you may explain what the rules and numbers mean.`;

/** Fill in trade reasons from the pilot's logbook, keeping only those whose hash matches the onchain commitment. */
export function attachRationales(facts: VaultFacts, log: { rationale: string; rationaleHash?: string }[]): VaultFacts {
  const byHash = new Map<string, string>();
  for (const l of log) byHash.set(keccak256(toHex(l.rationale)).toLowerCase(), l.rationale);
  return {
    ...facts,
    trades: facts.trades.map((t) => ({ ...t, rationale: t.rationale && verified(t.rationale, t.rationaleHash) ? t.rationale : (byHash.get(t.rationaleHash.toLowerCase()) ?? null) })),
  };
}

export function verified(rationale: string, hash: string) {
  return keccak256(toHex(rationale)).toLowerCase() === hash.toLowerCase();
}

/** Keep only citations that are transactions in the facts. */
export function checkCitations(citations: string[], facts: VaultFacts) {
  const known = new Set([...facts.trades.map((t) => t.tx.toLowerCase()), ...facts.events.map((e) => e.tx.toLowerCase())]);
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const c of citations) (known.has(c.toLowerCase()) ? kept : dropped).push(c);
  return { kept: [...new Set(kept)], dropped };
}

export async function askVault(question: string, facts: VaultFacts, history: Turn[] = [], client: Anthropic | null = defaultClient()): Promise<AskResult> {
  // Unverifiable reasons never reach the model.
  const clean = { ...facts, trades: facts.trades.map((t) => ({ ...t, rationale: t.rationale && verified(t.rationale, t.rationaleHash) ? t.rationale : null })) };
  if (!client) return { ...basicAnswer(question, clean), source: "basic", dropped: [] };

  const messages: Anthropic.Beta.BetaMessageParam[] = [];
  history.slice(-6).forEach((t, i) => {
    messages.push({ role: "user", content: i === 0 ? `Facts about my vault, as JSON:\n${JSON.stringify(clean)}\n\nQuestion: ${t.question}` : t.question });
    messages.push({ role: "assistant", content: t.answer });
  });
  messages.push({ role: "user", content: messages.length === 0 ? `Facts about my vault, as JSON:\n${JSON.stringify(clean)}\n\nQuestion: ${question}` : question });

  const response = await client.beta.messages.parse({
    model: MODEL,
    max_tokens: 4000,
    output_config: { effort: "low", format: betaZodOutputFormat(Answer) },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: SYSTEM,
    messages,
  });
  if (response.stop_reason === "refusal" || !response.parsed_output) return { ...basicAnswer(question, clean), source: "basic", dropped: [] };
  const { kept, dropped } = checkCitations(response.parsed_output.citations, clean);
  return { ...response.parsed_output, citations: kept, followUps: response.parsed_output.followUps.slice(0, 3), source: "claude", dropped };
}

// ---------------------------------------------------------------------------------------------------------------
// Without credentials: answers the common questions directly from the facts.

const money = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: n >= 100 ? 0 : 2 });

export function basicAnswer(question: string, f: VaultFacts): Answer {
  const q = question.toLowerCase();
  const escape = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const symbol = f.holdings.find((h) => new RegExp(`(^|[^a-z0-9])${escape(h.symbol.toLowerCase())}($|[^a-z0-9])`).test(q))?.symbol;
  const follow = ["Why did the pilot last trade?", "How much can the pilot trade today?", "What happens if I lose my keys?"];

  if (/\b(limit|limits|budget|allowed|can the pilot|how much can)\b/.test(q)) {
    const l = f.limits;
    return {
      answer: `The pilot can trade at most ${money(l.maxTradeUsd)} per trade and ${money(l.dailyLimitUsd)} per 24 hours; ${money(l.budgetLeftUsd)} of that budget is available now. It must wait ${l.cooldownMinutes} minutes between trades, may lose at most ${l.maxSlippagePct}% to slippage against oracle prices, and cannot trade on prices older than ${l.maxPriceAgeMinutes} minutes.`,
      citations: [],
      followUps: follow,
    };
  }
  if (/\b(why|reason|sold|sell|bought|buy|trade|traded)\b/.test(q)) {
    const t = f.trades.find((x) => !symbol || x.sold === symbol || x.bought === symbol);
    if (!t) return { answer: symbol ? `The pilot has not traded ${symbol} in the history I can see.` : "The pilot has not traded yet in the history I can see.", citations: [], followUps: follow };
    const why = t.rationale ? `Its recorded reason, which matches the hash stored onchain: "${t.rationale}"` : "Its written reason is not available here, but every trade had to pass the vault's rules.";
    return { answer: `On ${t.time.slice(0, 10)} the pilot sold ${money(t.valueUsd)} of ${t.sold} for ${t.bought}. ${why}`, citations: [t.tx], followUps: follow };
  }
  if (/\b(heir|inherit|keys?|die|death|lose|lost)\b/.test(q)) {
    const i = f.inheritance;
    return {
      answer: i.heir
        ? `Your heir is ${i.heir}. If you do nothing with the vault for ${i.periodDays} days, they can take it over${i.heirCanClaimFrom ? ` (from ${i.heirCanClaimFrom.slice(0, 10)} if you stay inactive)` : ""}. Any action of yours restarts the clock.`
        : "No heir is named, so if you lose your keys nobody can recover this vault. You can name an heir and an inactivity period in the Inheritance card.",
      citations: [],
      followUps: follow,
    };
  }
  if (/\b(tax|taxes|gain|gains|loss)\b/.test(q)) {
    const t = f.taxes;
    return {
      answer: t
        ? `In ${t.year} so far: ${money(t.shortTermGainUsd)} short-term and ${money(t.longTermGainUsd)} long-term realized gains, ${money(t.feesPaidUsd)} in fees, and ${money(t.unrealizedGainUsd)} unrealized on open lots. The Taxes card has every lot and a CSV. This is not tax advice.`
        : "Build the tax report in the Taxes card first; then I can summarize it.",
      citations: [],
      followUps: follow,
    };
  }
  if (/\b(crash|crashes|drawdown|guard|stop.?loss|protect|protected|defensive)\b/.test(q)) {
    const g = f.crashGuard;
    return {
      answer: !g || !g.armed
        ? "The crash guard is off: if markets fall, the pilot keeps rebalancing to your normal targets. You can arm it in the Crash guard card."
        : g.defensive
          ? `The crash guard has tripped: the vault is on defensive targets, ${g.safeAsset} at ${g.safeTargetPct}%, and the pilot can only de-risk until you lift it.`
          : `The crash guard is armed: if the vault falls more than ${g.tripsAtFallPct}% below its recorded peak${g.peakUsd ? ` of ${money(g.peakUsd)}` : ""}, ${g.safeAsset} goes to ${g.safeTargetPct}% and the pilot can only de-risk. The contract enforces it.`,
      citations: [],
      followUps: follow,
    };
  }
  if (/\b(fee|fees|cost|pay)\b/.test(q)) {
    return { answer: f.status.feePercentPerYear > 0 ? `The pilot's fee is ${f.status.feePercentPerYear}% a year, taken from every asset in proportion, and it stops while the vault is paused. You can cancel it at any time.` : "This vault pays no pilot fee.", citations: [], followUps: follow };
  }
  const h = symbol ? f.holdings.find((x) => x.symbol === symbol)! : null;
  if (h) return { answer: `${h.symbol} is ${money(h.valueUsd)}, ${h.weightPct.toFixed(1)}% of the vault, against a ${h.targetPct}% target and a ±${h.bandPct}% band.`, citations: [], followUps: follow };
  const off = f.holdings.filter((x) => Math.abs(x.weightPct - x.targetPct) > x.bandPct / 2);
  return {
    answer: `The vault holds ${money(f.status.totalUsd)}${f.status.paused ? " and is paused" : ""}. ${
      off.length ? `Drifting most: ${off.map((x) => `${x.symbol} at ${x.weightPct.toFixed(1)}% vs ${x.targetPct}%`).join(", ")}.` : "Every asset is close to its target."
    } The pilot's next move: ${f.status.nextMove}`,
    citations: [],
    followUps: follow,
  };
}
