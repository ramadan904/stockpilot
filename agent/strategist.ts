// Turns an investor's goal, in their own words, into a mandate the vault can enforce.
//
// Claude proposes the allocation and explains it; plain code then validates it and converts it into exact onchain
// units. The proposal is only ever a draft: the owner reviews it and signs setMandate themselves, so the model never
// holds keys or moves funds. Without Anthropic credentials, a keyword-based preset is used instead so the rest of the
// product still works offline.

import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod/v4";
import { BPS, WAD, type Address } from "./model";

export const MODEL = "claude-opus-5-5";

export interface UniverseAsset {
  symbol: string;
  name: string;
  token: Address;
  feed: Address;
  /** One line the model can reason from, e.g. "EV maker; high volatility". */
  profile: string;
  stable?: boolean;
}

export const Proposal = z.object({
  summary: z.string().describe("Two or three sentences, in plain English, on what this portfolio is for."),
  risk_level: z.enum(["conservative", "balanced", "growth", "aggressive"]),
  allocations: z
    .array(
      z.object({
        symbol: z.string(),
        weight_percent: z.number().describe("Share of the portfolio, 0-100. All weights add up to 100."),
        reason: z.string().describe("One sentence on why this weight."),
      }),
    )
    .describe("One entry per asset in the universe, including those at 0%."),
  band_percent: z
    .number()
    .describe("How far, in percentage points, any weight may drift before rebalancing. Typically 2-10."),
  max_trade_percent: z.number().describe("Largest single trade as a percentage of the portfolio. Typically 5-25."),
  daily_turnover_percent: z
    .number()
    .describe("Most the pilot may trade in a day, as a percentage of the portfolio. Typically 10-50."),
});
export type Proposal = z.infer<typeof Proposal>;

export interface Mandate {
  assets: { token: Address; feed: Address; targetBps: number; bandBps: number }[];
  limits: { maxTradeUsd: bigint; dailyLimitUsd: bigint; maxSlippageBps: number; maxPriceAge: number; cooldown: number };
}

export interface Strategy {
  proposal: Proposal;
  mandate: Mandate;
  source: "claude" | "preset";
  /** Anything the validator had to fix in the proposal. Show these to the owner. */
  adjustments: string[];
}

const SYSTEM = `You are StockPilot's strategist. An investor describes a goal in their own words; you propose a
portfolio of tokenized stocks and a stablecoin, plus guardrails, that an automated pilot will keep in balance.

Rules:
- Use only the assets listed. Give every listed asset an entry, using 0 for assets you leave out.
- Weights are whole or half percentages and add up to exactly 100.
- Match risk to what the investor said. If they mention needing the money soon, safety, or retirement income, hold
  more of the stablecoin. If they say they can stomach big swings, hold less.
- Avoid putting more than 40% in a single stock unless the investor explicitly asks for concentration.
- Bands are wider for volatile portfolios (fewer, cheaper rebalances) and narrower for conservative ones.
- This is a draft the investor will review and sign. It is not personalised financial advice; do not claim it is.`;

/**
 * Ask Claude for a proposal and convert it into a mandate. Falls back to a preset when no credentials are
 * configured, so demos and tests never depend on network access.
 */
export async function propose(
  goal: string,
  universe: UniverseAsset[],
  portfolioUsd: number,
  client: Anthropic | null = defaultClient(),
): Promise<Strategy> {
  if (!client) return { ...toMandate(presetFor(goal, universe), universe, portfolioUsd), source: "preset" };

  const response = await client.beta.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    output_config: { effort: "medium", format: betaZodOutputFormat(Proposal) },
    // On a safety decline, let the API retry on the appropriate fallback model instead of failing the request.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content:
          `Assets available:\n${universe.map((a) => `- ${a.symbol} (${a.name}): ${a.profile}`).join("\n")}\n\n` +
          `Portfolio size: about $${portfolioUsd.toLocaleString("en-US")}.\n\n` +
          `The investor's goal, in their words:\n"""${goal}"""`,
      },
    ],
  });

  if (response.stop_reason === "refusal") {
    throw new Error(`The strategist declined this request: ${response.stop_details?.explanation ?? "no reason given"}`);
  }
  if (!response.parsed_output) throw new Error(`The strategist returned no usable proposal (${response.stop_reason}).`);
  return { ...toMandate(response.parsed_output, universe, portfolioUsd), source: "claude" };
}

function defaultClient() {
  const hasCredentials = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_PROFILE;
  return hasCredentials ? new Anthropic() : null;
}

/**
 * Validate a proposal and convert it to onchain units. Never trusts the model's arithmetic: weights are renormalised
 * to exactly 10,000 bps, and every limit is clamped to a sane range. Each fix is reported in `adjustments`.
 */
export function toMandate(
  proposal: Proposal,
  universe: UniverseAsset[],
  portfolioUsd: number,
): { proposal: Proposal; mandate: Mandate; adjustments: string[] } {
  const adjustments: string[] = [];
  const bySymbol = new Map(universe.map((a) => [a.symbol.toUpperCase(), a]));

  const weights = new Map<string, number>();
  for (const a of proposal.allocations) {
    const sym = a.symbol.toUpperCase();
    if (!bySymbol.has(sym)) {
      adjustments.push(`Dropped ${a.symbol}: not an available asset.`);
      continue;
    }
    const w = Number.isFinite(a.weight_percent) ? Math.max(0, a.weight_percent) : 0;
    if (w !== a.weight_percent) adjustments.push(`${sym}: weight ${a.weight_percent} replaced with ${w}.`);
    weights.set(sym, (weights.get(sym) ?? 0) + w);
  }
  const sum = [...weights.values()].reduce((s, w) => s + w, 0);
  if (sum <= 0) throw new Error("The proposal allocates nothing.");
  if (Math.abs(sum - 100) > 0.01) adjustments.push(`Weights added up to ${sum}%; scaled to 100%.`);

  const targets = largestRemainder(
    universe.map((a) => weights.get(a.symbol.toUpperCase()) ?? 0),
    Number(BPS),
  );

  const band = clamp(proposal.band_percent, 1, 20, "band", adjustments);
  const maxTrade = clamp(proposal.max_trade_percent, 1, 50, "max trade", adjustments);
  const daily = clamp(proposal.daily_turnover_percent, maxTrade, 100, "daily turnover", adjustments);

  const assets = universe.map((a, i) => ({
    token: a.token,
    feed: a.feed,
    targetBps: targets[i],
    // A zero-weight asset gets no band, so the pilot can only sell it down.
    bandBps: targets[i] === 0 ? 0 : Math.round(band * 100),
  }));
  const usd = (pct: number) => (BigInt(Math.round(portfolioUsd * pct * 100)) * WAD) / 10_000n;

  return {
    proposal,
    adjustments,
    mandate: {
      assets,
      limits: {
        maxTradeUsd: usd(maxTrade),
        dailyLimitUsd: usd(daily),
        maxSlippageBps: 100,
        maxPriceAge: 3_600,
        cooldown: 300,
      },
    },
  };
}

/** Integer shares of `total` proportional to `weights`, summing to exactly `total`. */
export function largestRemainder(weights: number[], total: number): number[] {
  const sum = weights.reduce((s, w) => s + w, 0);
  const exact = weights.map((w) => (w / sum) * total);
  const floors = exact.map(Math.floor);
  let left = total - floors.reduce((s, x) => s + x, 0);
  const order = exact.map((x, i) => [x - Math.floor(x), i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (const [, i] of order) {
    if (left-- <= 0) break;
    floors[i]++;
  }
  return floors;
}

function clamp(value: number, lo: number, hi: number, label: string, adjustments: string[]) {
  const v = Number.isFinite(value) ? Math.min(hi, Math.max(lo, value)) : lo;
  if (v !== value) adjustments.push(`${label} ${value}% clamped to ${v}%.`);
  return v;
}

/** Offline stand-in for the model: picks a risk level from keywords and spreads the rest evenly over stocks. */
export function presetFor(goal: string, universe: UniverseAsset[]): Proposal {
  const g = goal.toLowerCase();
  const risk: Proposal["risk_level"] = /retire|safe|soon|income|conservative|careful|low risk/.test(g)
    ? "conservative"
    : /aggressive|moon|max(imum)? growth|high risk|yolo/.test(g)
      ? "aggressive"
      : /growth|long[- ]term|decade/.test(g)
        ? "growth"
        : "balanced";
  const stableShare = { conservative: 60, balanced: 30, growth: 15, aggressive: 5 }[risk];
  const band = { conservative: 3, balanced: 5, growth: 7, aggressive: 10 }[risk];
  const stocks = universe.filter((a) => !a.stable);
  const each = (100 - stableShare) / stocks.length;
  return {
    summary: `A ${risk} mix: ${stableShare}% in the stablecoin, the rest spread evenly across ${stocks.length} stocks.`,
    risk_level: risk,
    allocations: universe.map((a) => ({
      symbol: a.symbol,
      weight_percent: a.stable ? stableShare : each,
      reason: a.stable ? "Cushion against drawdowns and dry powder for rebalancing." : "Equal-weighted stock exposure.",
    })),
    band_percent: band,
    max_trade_percent: 10,
    daily_turnover_percent: 30,
  };
}
