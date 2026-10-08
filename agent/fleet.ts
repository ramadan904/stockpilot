// The hosted pilot: one key flying every vault that named it as pilot. Each tick it finds its vaults, plans each one,
// sends the trades the vaults will accept, and reports what happened. One vault failing never stops the others.

import type { Abi, Address, Hash, PublicClient, WalletClient } from "viem";
import { publishReason, readVault, rationaleHash, sendTrade } from "./chain";
import { eq } from "./model";
import { fmtUsd, plan, type PlannerOptions, DEFAULT_PLANNER } from "./planner";
import { taxPolicyFor, type TaxPreferences } from "./taxaware";

export interface FleetConfig {
  client: PublicClient;
  wallet: WalletClient;
  vaultAbi: Abi;
  factoryAbi: Abi;
  factory: Address;
  /** Serve only vaults paying at least this fee to this pilot (bps a year). 0 serves every vault that names it. */
  minFeeBps?: number;
  planner?: PlannerOptions;
  notify?: Notifier;
  /** Owners' signed tax preferences by vault (lower-case); a vault with them on is planned tax-aware. */
  taxPreferences?: () => Map<string, TaxPreferences>;
  /** The pilot journal: each trade's full reason is published there, checkable against the trade's hash. */
  journal?: Address;
  /** Called with each trade for the logbook. */
  onTrade?: (entry: { vault: Address; tx: Hash; rationale: string; rationaleHash: Hash }) => void;
}

export type FleetEvent =
  | { kind: "trade"; vault: Address; tx: Hash; rationale: string; valueUsd: bigint }
  | { kind: "hold"; vault: Address; reason: string }
  | { kind: "skip"; vault: Address; reason: string }
  | { kind: "error"; vault: Address; error: string }
  | { kind: "fee"; vault: Address; tx: Hash }
  | { kind: "defensive"; vault: Address; tx: Hash; peakUsd: bigint; valueUsd: bigint }
  | { kind: "deposit"; vault: Address; tx: Hash; amount: bigint; symbol: string; decimals: number };

export type Notifier = (event: FleetEvent) => Promise<void> | void;

/** Every vault in the factory whose current pilot is `pilot`. Reads `pilot()` live, so reassignments are honoured. */
export async function discoverVaults(cfg: Pick<FleetConfig, "client" | "factory" | "factoryAbi" | "vaultAbi">, pilot: Address) {
  const { client } = cfg;
  const count = (await client.readContract({ address: cfg.factory, abi: cfg.factoryAbi, functionName: "vaultCount" })) as bigint;
  const all = await Promise.all(
    Array.from({ length: Number(count) }, (_, i) =>
      client.readContract({ address: cfg.factory, abi: cfg.factoryAbi, functionName: "vaultAt", args: [BigInt(i)] }) as Promise<Address>,
    ),
  );
  const pilots = await Promise.all(
    all.map((v) => client.readContract({ address: v, abi: cfg.vaultAbi, functionName: "pilot" }) as Promise<Address>),
  );
  return all.filter((_, i) => eq(pilots[i], pilot));
}

/** One pass over the fleet. Returns what happened to each vault. */
export async function fleetTick(cfg: FleetConfig): Promise<FleetEvent[]> {
  const me = cfg.wallet.account!.address;
  const vaults = await discoverVaults(cfg, me);
  const events: FleetEvent[] = [];
  for (const vault of vaults) {
    // Decide whether this fleet serves the vault before spending any gas on it.
    const refused = await refuses(cfg, vault, me).catch((e): FleetEvent => ({ kind: "error", vault, error: firstLine(e) }));
    if (refused) {
      events.push(refused);
      await cfg.notify?.(refused);
      continue;
    }
    const depositEvent = await pullDueDeposit(cfg, vault).catch((e): FleetEvent | null => onceADay(cfg, vault, `recurring investment: ${firstLine(e)}`));
    if (depositEvent) {
      events.push(depositEvent);
      await cfg.notify?.(depositEvent);
    }
    const guardEvent = await watchGuard(cfg, vault).catch(() => null); // a failed poke (stale prices) must not stop the trade
    if (guardEvent) {
      events.push(guardEvent);
      await cfg.notify?.(guardEvent);
    }
    const event = await flyOne(cfg, vault, me).catch((e): FleetEvent => ({ kind: "error", vault, error: firstLine(e) }));
    events.push(event);
    await cfg.notify?.(event);
  }
  return events;
}

/**
 * What a keeper should do about a vault's crash guard at `totalUsd`: record a new peak (once it is 1% above the
 * recorded one, to save gas), trigger defensive mode, or nothing.
 */
export function guardAction(g: { drawdownBps: number; defensive: boolean; peakUsd: bigint }, totalUsd: bigint): "record" | "trigger" | null {
  if (g.drawdownBps === 0 || g.defensive || totalUsd === 0n) return null;
  if (g.peakUsd === 0n || totalUsd * 100n >= g.peakUsd * 101n) return "record";
  if (totalUsd * 10_000n < g.peakUsd * BigInt(10_000 - g.drawdownBps)) return "trigger";
  return null;
}

/** Pull a vault's recurring investment when it is due, so the pilot can invest it in the same tick. */
async function pullDueDeposit(cfg: FleetConfig, vault: Address): Promise<FleetEvent | null> {
  const { client, vaultAbi, wallet } = cfg;
  const read = <T,>(functionName: string) => client.readContract({ address: vault, abi: vaultAbi, functionName }) as Promise<T>;
  const [amount, nextAt, paused, block] = await Promise.all([read<bigint>("recurringAmount"), read<bigint>("recurringNextAt"), read<boolean>("paused"), client.getBlock()]);
  if (amount === 0n || paused || block.timestamp < nextAt) return null;
  const token = await read<Address>("recurringToken");
  const erc20 = [
    { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
    { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  ] as const;
  const [symbol, decimals] = await Promise.all([client.readContract({ address: token, abi: erc20, functionName: "symbol" }), client.readContract({ address: token, abi: erc20, functionName: "decimals" })]);
  const { request } = await client.simulateContract({ account: wallet.account!, address: vault, abi: vaultAbi, functionName: "pullRecurringDeposit" });
  const tx = await wallet.writeContract(request);
  await client.waitForTransactionReceipt({ hash: tx });
  return { kind: "deposit", vault, tx, amount, symbol, decimals };
}

/** Keep a guarded vault's peak current and trip its crash guard when due, before planning the next trade. */
async function watchGuard(cfg: FleetConfig, vault: Address): Promise<FleetEvent | null> {
  const { client, vaultAbi, wallet } = cfg;
  const read = <T,>(functionName: string) => client.readContract({ address: vault, abi: vaultAbi, functionName }) as Promise<T>;
  const [drawdownBps, defensive, peakUsd, [, totalUsd]] = await Promise.all([
    read<number>("drawdownBps"),
    read<boolean>("defensive"),
    read<bigint>("peakValueUsd"),
    read<readonly [unknown, bigint]>("portfolio"),
  ]);
  const action = guardAction({ drawdownBps: Number(drawdownBps), defensive, peakUsd }, totalUsd);
  if (!action) return null;
  const { request } = await client.simulateContract({ account: wallet.account!, address: vault, abi: vaultAbi, functionName: "poke" });
  const tx = await wallet.writeContract(request);
  await client.waitForTransactionReceipt({ hash: tx });
  return action === "trigger" && (await read<boolean>("defensive")) ? { kind: "defensive", vault, tx, peakUsd, valueUsd: totalUsd } : null;
}

/** A skip event when this fleet does not serve the vault (it does not pay the fee the fleet requires), else null. */
async function refuses(cfg: FleetConfig, vault: Address, me: Address): Promise<FleetEvent | null> {
  const { client, vaultAbi } = cfg;
  const minFee = cfg.minFeeBps ?? 0;
  if (minFee === 0) return null;
  const [bps, recipient] = await Promise.all([
    client.readContract({ address: vault, abi: vaultAbi, functionName: "feeBps" }) as Promise<number>,
    client.readContract({ address: vault, abi: vaultAbi, functionName: "feeRecipient" }) as Promise<Address>,
  ]);
  if (Number(bps) >= minFee && eq(recipient, me)) return null;
  return { kind: "skip", vault, reason: `pays ${Number(bps) / 100}% to ${recipient}; this service needs ${minFee / 100}% to ${me}` };
}

/** A repeating failure (say, an approval that ran out) is reported once a day per vault, not on every tick. */
const reported = new WeakMap<FleetConfig, Map<string, number>>();
function onceADay(cfg: FleetConfig, vault: Address, error: string, now = Date.now()): FleetEvent | null {
  if (!reported.has(cfg)) reported.set(cfg, new Map());
  const seen = reported.get(cfg)!;
  const key = `${vault.toLowerCase()} ${error}`;
  if (now - (seen.get(key) ?? -Infinity) < 86_400_000) return null;
  seen.set(key, now);
  return { kind: "error", vault, error };
}

async function flyOne(cfg: FleetConfig, vault: Address, _me: Address): Promise<FleetEvent> {
  const { client, vaultAbi } = cfg;
  const state = await readVault(client, vaultAbi, vault);
  let p = plan(state, cfg.planner ?? DEFAULT_PLANNER);
  // Tax-aware only changes which trade, or holds one: read the vault's history only when there is a trade to weigh.
  const prefs = cfg.taxPreferences?.().get(vault.toLowerCase());
  if (p.action === "trade" && prefs?.enabled) p = plan(state, cfg.planner ?? DEFAULT_PLANNER, await taxPolicyFor(client, vaultAbi, state, prefs));
  if (p.action === "hold") return { kind: "hold", vault, reason: p.reason };
  const { hash } = await sendTrade(client, cfg.wallet, vaultAbi, vault, p.trade);
  cfg.onTrade?.({ vault, tx: hash, rationale: p.trade.rationale, rationaleHash: rationaleHash(p.trade.rationale) });
  await publishReason(client, cfg.wallet, cfg.journal, vault, p.trade.rationale);
  return { kind: "trade", vault, tx: hash, rationale: p.trade.rationale, valueUsd: p.trade.valueUsd };
}

/** Collect the management fee from every vault in the fleet that pays one. */
export async function collectFees(cfg: FleetConfig): Promise<FleetEvent[]> {
  const me = cfg.wallet.account!.address;
  const events: FleetEvent[] = [];
  for (const vault of await discoverVaults(cfg, me)) {
    try {
      const bps = Number(await cfg.client.readContract({ address: vault, abi: cfg.vaultAbi, functionName: "feeBps" }));
      if (bps === 0) continue;
      const tx = await cfg.wallet.writeContract({
        account: cfg.wallet.account!,
        chain: cfg.wallet.chain,
        address: vault,
        abi: cfg.vaultAbi,
        functionName: "collectFee",
      });
      await cfg.client.waitForTransactionReceipt({ hash: tx });
      events.push({ kind: "fee", vault, tx });
    } catch (e) {
      events.push({ kind: "error", vault, error: firstLine(e) });
    }
  }
  for (const e of events) await cfg.notify?.(e);
  return events;
}

/** A human-readable line for an event, used by the webhook notifier and the CLI. */
export function describe(event: FleetEvent) {
  const v = `${event.vault.slice(0, 6)}…${event.vault.slice(-4)}`;
  switch (event.kind) {
    case "trade":
      return `StockPilot traded ${fmtUsd(event.valueUsd)} in vault ${v}: ${event.rationale}`;
    case "hold":
      return `Vault ${v}: holding. ${event.reason}`;
    case "skip":
      return `Vault ${v}: skipped, ${event.reason}`;
    case "error":
      return `Vault ${v}: error, ${event.error}`;
    case "fee":
      return `Vault ${v}: management fee collected (${event.tx})`;
    case "deposit": {
      const n = Number(event.amount) / 10 ** event.decimals;
      return `Recurring investment: ${n.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${event.symbol} moved from the owner's wallet into vault ${v}; the pilot invests it inside the mandate.`;
    }
    case "defensive": {
      const drop = Number(((event.peakUsd - event.valueUsd) * 1000n) / event.peakUsd) / 10;
      return `Crash guard: vault ${v} is worth ${fmtUsd(event.valueUsd)}, ${drop}% below its ${fmtUsd(event.peakUsd)} peak. It switched to its defensive targets, and the pilot can now only de-risk until you lift it.`;
    }
  }
}

/**
 * Posts trades and errors to a webhook. The body carries `text` (Slack) and `content` (Discord) plus the raw event,
 * so it works with both and with any custom endpoint. Holds and skips are not sent: they are the normal case.
 */
export function webhookNotifier(url: string, fetchImpl: typeof fetch = fetch): Notifier {
  return async (event) => {
    if (event.kind === "hold" || event.kind === "skip") return;
    const text = describe(event);
    try {
      await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, content: text, event }, (_, v) => (typeof v === "bigint" ? v.toString() : v)),
      });
    } catch (e) {
      // A notification failing must never stop the pilot.
      console.error(`notification failed: ${firstLine(e)}`);
    }
  };
}

function firstLine(e: unknown) {
  const err = e as { shortMessage?: string; message?: string };
  return (err.shortMessage ?? err.message ?? String(e)).split("\n")[0];
}
