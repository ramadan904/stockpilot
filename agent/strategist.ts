// Turns an investor's goal, in their own words, into a mandate the vault can enforce.
//
// Claude proposes the allocation and explains it; plain code then validates it and converts it into exact onchain
// units. The proposal is only ever a draft: the owner reviews it and signs setMandate themselves, so the model never
// holds keys or moves funds. Without Anthropic credentials, a keyword-based preset is used instead so the rest of the
// product still works offline.

import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { Proposal, presetFor, toMandate, type Strategy, type UniverseAsset } from "./mandate";

export * from "./mandate";

export const MODEL = "claude-opus-5-5";

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
  const { proposal, source } = await draft(goal, universe, portfolioUsd, client);
  return { ...toMandate(proposal, universe, portfolioUsd), source };
}

/**
 * Just the proposal, before it is tied to token addresses. The web app's server calls this and converts the result
 * in the browser, where it knows which chain the owner is on. Token and feed addresses are never sent to the model.
 */
export async function draft(
  goal: string,
  universe: Pick<UniverseAsset, "symbol" | "name" | "profile" | "stable">[],
  portfolioUsd: number,
  client: Anthropic | null = defaultClient(),
): Promise<{ proposal: Proposal; source: Strategy["source"] }> {
  if (!client) return { proposal: presetFor(goal, universe), source: "preset" };

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
  return { proposal: response.parsed_output, source: "claude" };
}

/** A client when credentials are configured, else null (callers fall back to offline behaviour). */
export function defaultClient() {
  const hasCredentials = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_PROFILE;
  return hasCredentials ? new Anthropic() : null;
}
