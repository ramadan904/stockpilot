// The server-side endpoints. POST /api/propose { goal, usd } -> { proposal, source };
// POST /api/refine { proposal, instruction, usd } -> { proposal, source, changes };
// POST /api/report ReportFacts -> { report, source }.
// POST /api/subscribe Subscription -> { verified, forwarded } (alerts signed by the vault's owner).
// POST /api/ask { question, facts, history } -> AskResult (answers grounded in the vault's onchain facts).
// POST /api/relay { chainId, vault, action, deadline, signature } -> { tx } (submits an owner's signed check-in or
// pause, paid by the operator's SIGNATURE_RELAY_KEY, so the owner needs no gas).
// POST /api/fund { chainId, fund, action, ... } -> { tx } (a free trial in a fund on testnets, or a signed redemption).
// The API key stays on the server; the browser turns the proposal into a mandate for whichever chain it is on.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, createWalletClient, getAddress, http, isAddress, isHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { VaultFacts, askVault, attachRationales, type Turn } from "./ask";
import { LOG_DIR } from "./log";
import { verifySubscription } from "./alerts";
import { verifyTaxPreferences } from "./taxaware";
import { LISTINGS } from "./listings";
import { ReportFacts, writeReport } from "./reporter";
import { Proposal, defaultClient, draft, refine } from "./strategist";
import { IMAGE_TYPES, MAX_IMAGE_BASE64, parseHoldingsText, readStatementImage } from "./importer";
import { cloneCode } from "./codecheck";

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

const MAX_PASTED_CHARS = 20_000;

/**
 * POST /api/import { image: { media_type, data } } or { text } -> { holdings, source }. A screenshot is read by Claude;
 * pasted text is parsed in plain code and works without credentials. Mapping onto the vault's assets happens in the
 * browser (agent/holdings.ts), where the owner sees how every line mapped.
 */
export async function handleImport(body: unknown, client = defaultClient()): Promise<{ status: number; json: unknown }> {
  const { image, text } = (body ?? {}) as { image?: { media_type?: unknown; data?: unknown }; text?: unknown };
  if (typeof text === "string") {
    if (text.length > MAX_PASTED_CHARS) return { status: 400, json: { error: `Paste at most ${MAX_PASTED_CHARS.toLocaleString("en-US")} characters.` } };
    return { status: 200, json: { holdings: parseHoldingsText(text), source: "text" } };
  }
  if (!image || typeof image.data !== "string" || !IMAGE_TYPES.includes(image.media_type as never)) {
    return { status: 400, json: { error: "Send a PNG, JPEG, WebP or GIF screenshot, or paste your holdings as text." } };
  }
  if (image.data.length > MAX_IMAGE_BASE64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)) {
    return { status: 400, json: { error: "That image is too large (about 3 MB at most) or not valid base64." } };
  }
  try {
    const holdings = await readStatementImage({ media_type: image.media_type as (typeof IMAGE_TYPES)[number], data: image.data }, client);
    return { status: 200, json: { holdings, source: "claude" } };
  } catch (e) {
    return { status: client ? 502 : 400, json: { error: (e as Error).message } };
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
  // Alert subscriptions and tax preferences: both signed by the vault's owner, both kept in the operator's store.
  const tax = (body as { kind?: unknown } | null)?.kind === "tax-preferences";
  const v = await (tax ? verifyTaxPreferences(body, readOwner).then((r) => (r.ok ? { ok: true as const, doc: r.prefs as unknown } : r)) : verifySubscription(body, readOwner).then((r) => (r.ok ? { ok: true as const, doc: r.sub as unknown } : r))).catch(
    (e) => ({ ok: false as const, why: (e as Error).message.split("\n")[0] }),
  );
  if (!v.ok) return { status: 400, json: { error: `${tax ? "Tax preferences" : "Subscription"} rejected: ${v.why}.` } };
  const sink = process.env.SUBSCRIPTION_SINK_URL;
  if (!sink) return { status: 200, json: { verified: true, forwarded: false } };
  const res = await fetchImpl(sink, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(v.doc) }).catch(() => null);
  return res?.ok ? { status: 200, json: { verified: true, forwarded: true } } : { status: 502, json: { error: "Verified, but the operator's store did not accept it." } };
}

const MAX_QUESTION_CHARS = 500;

/** The pilot's logbook for a vault, if this server keeps one (the fleet host or local development). */
function readLog(vault: string): { rationale: string }[] {
  if (!isAddress(vault)) return []; // never a path
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

const RELAY_ABI = [
  { type: "function", name: "checkInWithSig", stateMutability: "nonpayable", inputs: [{ type: "uint256" }, { type: "bytes" }], outputs: [] },
  { type: "function", name: "pauseWithSig", stateMutability: "nonpayable", inputs: [{ type: "uint256" }, { type: "bytes" }], outputs: [] },
] as const;

export interface Relayer {
  /** True only for a vault created by one of this deployment's factories, so gas is never spent on anything else. */
  isVault(vault: Address): Promise<boolean>;
  /** Dry-runs the call (reverts on a bad signature, so nothing is paid for it), then sends it. */
  send(vault: Address, functionName: "checkInWithSig" | "pauseWithSig", deadline: bigint, signature: Hex): Promise<Hex>;
}

/** The factories whose vaults the relay serves, from the deployment files (DEPLOYMENTS_DIR, default deployments/). */
function factoriesFor(chainId: number): Address[] {
  const dir = process.env.DEPLOYMENTS_DIR ?? "deployments";
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as { chainId?: number; factory?: string })
    .filter((d) => d.chainId === chainId && typeof d.factory === "string" && isAddress(d.factory))
    .map((d) => d.factory as Address);
}

export { cloneCode } from "./codecheck";

const FACTORY_ABI = [{ type: "function", name: "implementation", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }] as const;

/**
 * The relay's key as pasted: MetaMask shows keys without "0x", and copies can carry spaces or line breaks. Anything
 * that is not 64 hex digits once cleaned means no relay, rather than a crash.
 */
export function relayKey(raw: string | undefined): Hex | undefined {
  const k = (raw ?? "").replace(/\s+/g, "").replace(/^0x/i, "");
  return /^[0-9a-fA-F]{64}$/.test(k) ? `0x${k}` : undefined;
}

function chainRelayer(chainId: number): Relayer | null {
  const key = relayKey(process.env.SIGNATURE_RELAY_KEY);
  const url = process.env[`RPC_${chainId}`] ?? RPCS[chainId];
  if (!key || !url) return null;
  const account = privateKeyToAccount(key);
  const chain = { id: chainId, name: `chain-${chainId}`, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [url] } } };
  const pub = createPublicClient({ chain, transport: http(url) });
  const wallet = createWalletClient({ account, chain, transport: http(url) });
  return {
    async isVault(vault) {
      const code = (await pub.getCode({ address: vault }))?.toLowerCase();
      if (!code) return false;
      for (const factory of factoriesFor(chainId)) {
        const impl = (await pub.readContract({ address: factory, abi: FACTORY_ABI, functionName: "implementation" })) as Address;
        if (code === cloneCode(impl)) return true;
      }
      return false;
    },
    async send(vault, functionName, deadline, signature) {
      const { request } = await pub.simulateContract({ account, address: vault, abi: RELAY_ABI, functionName, args: [deadline, signature] });
      return wallet.writeContract(request);
    },
  };
}

/** Submits an owner's signed check-in or pause. Only these two harmless actions can be relayed. */
const RELAYS_PER_HOUR = 3;
const relayLog = new Map<string, number[]>();

export async function handleRelay(body: unknown, relayerFor: (chainId: number) => Relayer | null = chainRelayer, now = Date.now()): Promise<{ status: number; json: unknown }> {
  const { chainId, vault, action, deadline, signature } = (body ?? {}) as Record<string, unknown>;
  if (typeof vault !== "string" || !isAddress(vault)) return { status: 400, json: { error: "Bad vault address." } };
  if (action !== "checkIn" && action !== "pause") return { status: 400, json: { error: "Only check-in and pause can be relayed." } };
  if (typeof signature !== "string" || !isHex(signature) || typeof deadline !== "string" || !/^\d+$/.test(deadline)) return { status: 400, json: { error: "Malformed signature." } };
  const relayer = relayerFor(Number(chainId));
  if (!relayer) return { status: 501, json: { error: "No relayer is configured here. Submit the signed message from any wallet." } };
  if (!(await relayer.isVault(vault).catch(() => false))) return { status: 400, json: { error: "Not a StockPilot vault on this chain." } };
  // A safety action is needed now and then, not in a loop: a few per vault per hour, so nobody can drain the relay.
  const key = `${chainId}:${vault.toLowerCase()}`;
  const recent = (relayLog.get(key) ?? []).filter((t) => now - t < 3_600_000);
  if (recent.length >= RELAYS_PER_HOUR) return { status: 429, json: { error: "Too many relayed actions for this vault; try again later or submit it from any wallet." } };
  relayLog.set(key, [...recent, now]);
  try {
    const tx = await relayer.send(vault, action === "checkIn" ? "checkInWithSig" : "pauseWithSig", BigInt(deadline), signature);
    return { status: 200, json: { tx } };
  } catch (e) {
    return { status: 422, json: { error: (e as { shortMessage?: string }).shortMessage ?? (e as Error).message.split("\n")[0] } };
  }
}

// POST /api/fund { chainId, fund, action: "trial", holder } -> { tx }: on a testnet, the relay mints $100 of test cash
// and buys the holder shares in a genuine StockPilot fund, so anyone with a wallet can try a fund without gas.
// POST /api/fund { chainId, fund, action: "redeem", holder, shares, to, deadline, signature } -> { tx }: submits a
// holder's signed redemption (the fund checks the signature), so a holder with no gas can still leave.

export const TRIAL_USD = 100;
const TRIALS_PER_HOUR = 30;
const REDEEMS_PER_HOUR = 5;

export interface FundRelayer {
  /** True only for a fund listed by this deployment's fund factory. */
  isFund(fund: Address): Promise<boolean>;
  /** Mint TRIAL_USD of test cash to the relay and buy `holder` shares with it. Testnets only. */
  trial(fund: Address, holder: Address): Promise<Hex>;
  /** Dry-runs the signed redemption (a bad signature reverts, so nothing is paid for it), then sends it. */
  redeem(fund: Address, holder: Address, shares: bigint, to: Address, deadline: bigint, signature: Hex): Promise<Hex>;
}

const FUND_ABI = [
  { type: "function", name: "isFund", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "buyFor", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "redeemWithSig", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }, { type: "address" }, { type: "uint256" }, { type: "bytes" }], outputs: [] },
  { type: "function", name: "mint", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

/** This chain's deployment, from the deployment files (DEPLOYMENTS_DIR, default deployments/). */
function deploymentOn(chainId: number): { funds?: Address; tokens?: Record<string, Address>; production?: boolean } | null {
  const dir = process.env.DEPLOYMENTS_DIR ?? "deployments";
  if (!existsSync(dir)) return null;
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".json"))) {
    const d = JSON.parse(readFileSync(join(dir, f), "utf8"));
    if (d.chainId === chainId) return d;
  }
  return null;
}

function chainFundRelayer(chainId: number): FundRelayer | null {
  const key = relayKey(process.env.SIGNATURE_RELAY_KEY);
  const url = process.env[`RPC_${chainId}`] ?? RPCS[chainId];
  const d = deploymentOn(chainId);
  if (!key || !url || !d?.funds) return null;
  const account = privateKeyToAccount(key);
  const chain = { id: chainId, name: `chain-${chainId}`, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [url] } } };
  const pub = createPublicClient({ chain, transport: http(url) });
  const wallet = createWalletClient({ account, chain, transport: http(url) });
  const send = async (address: Address, functionName: "mint" | "approve" | "buyFor" | "redeemWithSig", args: readonly unknown[]) => {
    const { request } = await pub.simulateContract({ account, address, abi: FUND_ABI, functionName, args } as never);
    return wallet.writeContract(request as never) as Promise<Hex>;
  };
  return {
    isFund: (fund) => pub.readContract({ address: d.funds!, abi: FUND_ABI, functionName: "isFund", args: [fund] }) as Promise<boolean>,
    async trial(fund, holder) {
      const usdg = d.tokens?.USDG;
      if (d.production || !usdg) throw new Error("Free trials run on testnets only.");
      const amount = BigInt(TRIAL_USD) * 10n ** 6n;
      await pub.waitForTransactionReceipt({ hash: await send(usdg, "mint", [account.address, amount]) });
      const allowance = (await pub.readContract({ address: usdg, abi: FUND_ABI, functionName: "allowance", args: [account.address, fund] })) as bigint;
      if (allowance < amount) await pub.waitForTransactionReceipt({ hash: await send(usdg, "approve", [fund, 2n ** 255n]) });
      return send(fund, "buyFor", [holder, usdg, amount, 0n]);
    },
    redeem: (fund, holder, shares, to, deadline, signature) => send(fund, "redeemWithSig", [holder, shares, to, deadline, signature]),
  };
}

const fundLog = new Map<string, number[]>();
const trialLog = new Map<string, number>();

/** Gas-free fund actions: a free trial purchase on testnets, and submitting a holder's signed redemption. */
export async function handleFund(body: unknown, relayerFor: (chainId: number) => FundRelayer | null = chainFundRelayer, now = Date.now()): Promise<{ status: number; json: unknown }> {
  const { chainId, fund, action, holder } = (body ?? {}) as Record<string, unknown>;
  if (typeof fund !== "string" || !isAddress(fund) || typeof holder !== "string" || !isAddress(holder)) return { status: 400, json: { error: "Bad fund or holder address." } };
  if (action !== "trial" && action !== "redeem") return { status: 400, json: { error: "Only a trial purchase or a signed redemption can be relayed." } };
  const relayer = relayerFor(Number(chainId));
  if (!relayer) return { status: 501, json: { error: "No relay is configured here. Use a wallet with gas instead." } };
  if (!(await relayer.isFund(fund).catch(() => false))) return { status: 400, json: { error: "Not a StockPilot fund on this chain." } };
  const hour = (k: string, max: number) => {
    const recent = (fundLog.get(k) ?? []).filter((t) => now - t < 3_600_000);
    if (recent.length >= max) return false;
    fundLog.set(k, [...recent, now]);
    return true;
  };
  try {
    if (action === "trial") {
      // One trial per wallet per fund a day, and a cap across everyone, so nobody can drain the relay's gas.
      const key = `${chainId}:${fund.toLowerCase()}:${holder.toLowerCase()}`;
      const last = trialLog.get(key);
      if (last !== undefined && now - last < 86_400_000) return { status: 429, json: { error: "This wallet already had its free trial of this fund today." } };
      if (!hour(`${chainId}:trials`, TRIALS_PER_HOUR)) return { status: 429, json: { error: "Too many free trials this hour; try again later." } };
      trialLog.set(key, now);
      return { status: 200, json: { tx: await relayer.trial(getAddress(fund), getAddress(holder)) } };
    }
    const { shares, to, deadline, signature } = body as Record<string, unknown>;
    if (typeof to !== "string" || !isAddress(to) || typeof signature !== "string" || !isHex(signature)) return { status: 400, json: { error: "Malformed signature." } };
    if (typeof shares !== "string" || !/^\d+$/.test(shares) || typeof deadline !== "string" || !/^\d+$/.test(deadline)) return { status: 400, json: { error: "Malformed signature." } };
    if (!hour(`${chainId}:redeem:${holder.toLowerCase()}`, REDEEMS_PER_HOUR)) return { status: 429, json: { error: "Too many relayed redemptions; try again later." } };
    return { status: 200, json: { tx: await relayer.redeem(getAddress(fund), getAddress(holder), BigInt(shares), getAddress(to), BigInt(deadline), signature) } };
  } catch (e) {
    return { status: 422, json: { error: (e as { shortMessage?: string }).shortMessage ?? (e as Error).message.split("\n")[0] } };
  }
}
