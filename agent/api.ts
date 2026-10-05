// The one server-side endpoint: POST /api/propose { goal, usd } -> { proposal, source }.
// The API key stays on the server; the browser turns the proposal into a mandate for whichever chain it is on.

import { LISTINGS } from "./listings";
import { draft } from "./strategist";

const MAX_GOAL_CHARS = 1_000;

export async function handlePropose(body: unknown): Promise<{ status: number; json: unknown }> {
  const { goal, usd } = (body ?? {}) as { goal?: unknown; usd?: unknown };
  if (typeof goal !== "string" || goal.trim().length === 0) return { status: 400, json: { error: "Describe your goal." } };
  if (goal.length > MAX_GOAL_CHARS) return { status: 400, json: { error: `Keep the goal under ${MAX_GOAL_CHARS} characters.` } };
  const portfolioUsd = typeof usd === "number" && usd > 0 && usd < 1e12 ? usd : 10_000;
  try {
    return { status: 200, json: await draft(goal.trim(), [...LISTINGS], portfolioUsd) };
  } catch (e) {
    return { status: 502, json: { error: (e as Error).message } };
  }
}
