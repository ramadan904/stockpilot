// Claude writes the owner's report. All numbers come from ReportFacts, computed by code from the chain; the model only
// turns them into plain English, and is told not to introduce figures of its own.

import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { Report, ReportFacts, basicReport } from "./report";
import { MODEL, defaultClient } from "./strategist";

export * from "./report";

const SYSTEM = `You write StockPilot's report to a portfolio owner. StockPilot is an automated pilot that rebalances the
owner's tokenized stock portfolio inside limits the owner signed onchain.

Write for a smart non-expert. Plain words, short sentences, no jargon, no hype. Use only numbers that appear in the
facts; round them sensibly; never estimate or invent figures, returns, or forecasts. Explain trades by their stated
reasons. If the vault blocked attempted trades, say plainly that the onchain rules stopped them. Do not give investment
advice or recommend buying or selling anything; "keep an eye on" items should be observations, not instructions.`;

export async function writeReport(
  facts: ReportFacts,
  client: Anthropic | null = defaultClient(),
): Promise<{ report: Report; source: "claude" | "basic" }> {
  const parsed = ReportFacts.parse(facts);
  if (!client) return { report: basicReport(parsed), source: "basic" };

  const response = await client.beta.messages.parse({
    model: MODEL,
    max_tokens: 4000,
    output_config: { effort: "low", format: betaZodOutputFormat(Report) },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: SYSTEM,
    messages: [{ role: "user", content: `Facts for the report, as JSON:\n${JSON.stringify(parsed, null, 2)}` }],
  });
  if (response.stop_reason === "refusal" || !response.parsed_output) {
    return { report: basicReport(parsed), source: "basic" };
  }
  return { report: response.parsed_output, source: "claude" };
}
