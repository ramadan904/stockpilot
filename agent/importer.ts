// Start from what you already own: Claude reads the positions off a screenshot of a brokerage statement, as structured
// data. Mapping them onto the vault's assets is plain code (agent/holdings.ts), and the owner reviews, refines and
// signs the resulting draft as usual: nothing here touches keys or funds.

import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { ExtractedHoldings, type IMAGE_TYPES } from "./holdings";
import { MODEL, defaultClient } from "./strategist";

export * from "./holdings";

const READ = `You read screenshots of brokerage and bank statements for StockPilot. List every position you can see
with its name, ticker, kind and current market value in US dollars, exactly as shown. Never estimate a value that is
not on the screen: use null instead. Leave out totals, subtotals, account numbers and anything that is not a position.
If the image is not a statement or holdings list, return no holdings and say so in the note.`;


/** Claude reads the holdings off a statement screenshot. */
export async function readStatementImage(
  image: { media_type: (typeof IMAGE_TYPES)[number]; data: string },
  client: Anthropic | null = defaultClient(),
): Promise<ExtractedHoldings> {
  if (!client) throw new Error("Reading a screenshot needs Claude (set ANTHROPIC_API_KEY on the server). Paste your holdings as text instead.");
  const response = await client.beta.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    output_config: { effort: "medium", format: betaZodOutputFormat(ExtractedHoldings) },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: READ,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: image.media_type, data: image.data } },
          { type: "text", text: "List the positions in this statement." },
        ],
      },
    ],
  });
  if (response.stop_reason === "refusal") throw new Error(`Claude declined to read this image: ${response.stop_details?.explanation ?? "no reason given"}`);
  if (!response.parsed_output) throw new Error(`No holdings could be read (${response.stop_reason}).`);
  return response.parsed_output;
}

