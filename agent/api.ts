// The server-side endpoints. POST /api/propose { goal, usd } -> { proposal, source };
// POST /api/refine { proposal, instruction, usd } -> { proposal, source, changes };
// POST /api/report ReportFacts -> { report, source }.
// POST /api/subscribe Subscription -> { verified, forwarded } (alerts signed by the vault's owner).
// POST /api/ask { question, facts, history } -> AskResult (answers grounded in the vault's onchain facts).
// The API key stays on the server; the browser turns the proposal into a mandate for whichever chain it is on.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, getAddress, http, type Address } from "viem";
import { VaultFacts, askVault, attachRationales, type Turn } from "./ask";
import { LOG_DIR } from "./log";
import { verifySubscription } from "./alerts";
import { LISTINGS } from "./listings";
import { ReportFacts, writeReport } from "./reporter";
import { Proposal, draft, refine } from "./strategist";

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

export async function handleReport(body: unknown): Promise<{ status: number; json: unknown }> {
  const facts = ReportFacts.safeParse(body);
  if (!facts.success) return { status: 400, json: { error: "Malformed report facts." } };
  try {
    return { status: 200, json: await writeReport(facts.data) };
  } catch (e) {
    return { status: 502, json: { error: (e as Error).message } };
  }
}

export async function handleRefine(body: unknown): Promise<{ status: number; json: unknown }> {
  const { proposal, instruction, usd } = (body ?? {}) as { proposal?: unknown; instruction?: unknown; usd?: unknown };
  const parsed = Proposal.safeParse(proposal);
  if (!parsed.success) return { status: 400, json: { error: "Malformed draft." } };
  if (typeof instruction !== "string" || !instruction.trim()) return { status: 400, json: { error: "Say what to change." } };
  if (instruction.length > MAX_GOAL_CHARS) return { status: 400, json: { error: `Keep it under ${MAX_GOAL_CHARS} characters.` } };
  const portfolioUsd = typeof usd === "number" && usd > 0 && usd < 1e12 ? usd : 10_000;
  try {
    return { status: 200, json: await refine(parsed.data, instruction.trim(), [...LISTINGS], portfolioUsd) };
  } catch (e) {
    return { status: 422, json: { error: (e as Error).message } };
  }
}

const RPCS: Record<number, string> = {
  46630: "https://rpc.testnet.chain.robinhood.com/rpc",
  4663: "https://rpc.mainnet.chain.robinhood.com",
  421614: "https://sepolia-rollup.arbitrum.io/rpc",
  42161: "https://arb1.arbitrum.io/rpc",
  31337: "http://127.0.0.1:8545", // local development
};

const OWNER_ABI = [{ type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }] as const;

function chainOwnerReader(chainId: number) {
  const url = process.env[`RPC_${chainId}`] ?? RPCS[chainId];
  if (!url) return null;
  const client = createPublicClient({ transport: http(url) });
  return (vault: Address) => client.readContract({ address: vault, abi: OWNER_ABI, functionName: "owner" });
}

/**
 * Checks that a subscription was signed by the vault's owner, then forwards it to the pilot operator's store
 * (SUBSCRIPTION_SINK_URL, any endpoint accepting a JSON POST). Without a sink it only verifies, and the web app
 * offers the signed subscription for the owner to send to their operator.
 */
export async function handleSubscribe(
  body: unknown,
  readOwnerFor: (chainId: number) => ((vault: Address) => Promise<Address>) | null = chainOwnerReader,
  fetchImpl: typeof fetch = fetch,
): Promise<{ status: number; json: unknown }> {
  const chainId = Number((body as { chainId?: unknown } | null)?.chainId);
  const readOwner = Number.isFinite(chainId) ? readOwnerFor(chainId) : null;
  if (!readOwner) return { status: 400, json: { error: "Unsupported chain." } };
  const v = await verifySubscription(body, readOwner).catch((e) => ({ ok: false as const, why: (e as Error).message.split("\n")[0] }));
  if (!v.ok) return { status: 400, json: { error: `Subscription rejected: ${v.why}.` } };
  const sink = process.env.SUBSCRIPTION_SINK_URL;
  if (!sink) return { status: 200, json: { verified: true, forwarded: false } };
  const res = await fetchImpl(sink, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(v.sub) }).catch(() => null);
  return res?.ok ? { status: 200, json: { verified: true, forwarded: true } } : { status: 502, json: { error: "Verified, but the operator's store did not accept it." } };
}

const MAX_QUESTION_CHARS = 500;

/** The pilot's logbook for a vault, if this server keeps one (the fleet host or local development). */
function readLog(vault: string): { rationale: string }[] {
  let names: string[] = [vault];
  try {
    names = [...new Set([vault, getAddress(vault), vault.toLowerCase()])];
  } catch {
    // not an address: try the name as given
  }
  for (const n of names) {
    const file = join(LOG_DIR, `${n}.jsonl`);
    if (!existsSync(file)) continue;
    return readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((l) => {
        try {
          const e = JSON.parse(l);
          return typeof e.rationale === "string" ? [{ rationale: e.rationale }] : [];
        } catch {
          return [];
        }
      });
  }
  return [];
}

export async function handleAsk(body: unknown, log: (vault: string) => { rationale: string }[] = readLog): Promise<{ status: number; json: unknown }> {
  const { question, facts, history } = (body ?? {}) as { question?: unknown; facts?: unknown; history?: unknown };
  if (typeof question !== "string" || !question.trim()) return { status: 400, json: { error: "Ask a question." } };
  if (question.length > MAX_QUESTION_CHARS) return { status: 400, json: { error: `Keep the question under ${MAX_QUESTION_CHARS} characters.` } };
  const parsed = VaultFacts.safeParse(facts);
  if (!parsed.success) return { status: 400, json: { error: "Malformed vault facts." } };
  const turns: Turn[] = Array.isArray(history)
    ? history
        .filter((t): t is Turn => typeof t?.question === "string" && typeof t?.answer === "string")
        .slice(-6)
        .map((t) => ({ question: t.question.slice(0, MAX_QUESTION_CHARS), answer: t.answer.slice(0, 4_000) }))
    : [];
  try {
    return { status: 200, json: await askVault(question.trim(), attachRationales(parsed.data, log(parsed.data.vault)), turns) };
  } catch (e) {
    return { status: 502, json: { error: (e as Error).message } };
  }
}
