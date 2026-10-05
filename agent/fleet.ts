// The hosted pilot: one key flying every vault that named it as pilot. Each tick it finds its vaults, plans each one,
// sends the trades the vaults will accept, and reports what happened. One vault failing never stops the others.

import type { Abi, Address, Hash, PublicClient, WalletClient } from "viem";
import { readVault, rationaleHash, sendTrade } from "./chain";
import { eq } from "./model";
import { fmtUsd, plan, type PlannerOptions, DEFAULT_PLANNER } from "./planner";

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
  /** Called with each trade for the logbook. */
  onTrade?: (entry: { vault: Address; tx: Hash; rationale: string; rationaleHash: Hash }) => void;
}

export type FleetEvent =
  | { kind: "trade"; vault: Address; tx: Hash; rationale: string; valueUsd: bigint }
  | { kind: "hold"; vault: Address; reason: string }
  | { kind: "skip"; vault: Address; reason: string }
  | { kind: "error"; vault: Address; error: string }
  | { kind: "fee"; vault: Address; tx: Hash };

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
    const event = await flyOne(cfg, vault, me).catch((e): FleetEvent => ({ kind: "error", vault, error: firstLine(e) }));
    events.push(event);
    await cfg.notify?.(event);
  }
  return events;
}

async function flyOne(cfg: FleetConfig, vault: Address, me: Address): Promise<FleetEvent> {
  const { client, vaultAbi } = cfg;
  const minFee = cfg.minFeeBps ?? 0;
  if (minFee > 0) {
    const [bps, recipient] = await Promise.all([
      client.readContract({ address: vault, abi: vaultAbi, functionName: "feeBps" }) as Promise<number>,
      client.readContract({ address: vault, abi: vaultAbi, functionName: "feeRecipient" }) as Promise<Address>,
    ]);
    if (Number(bps) < minFee || !eq(recipient, me)) {
      return { kind: "skip", vault, reason: `pays ${Number(bps) / 100}% to ${recipient}; this service needs ${minFee / 100}% to ${me}` };
    }
  }
  const state = await readVault(client, vaultAbi, vault);
  const p = plan(state, cfg.planner ?? DEFAULT_PLANNER);
  if (p.action === "hold") return { kind: "hold", vault, reason: p.reason };
  const { hash } = await sendTrade(client, cfg.wallet, vaultAbi, vault, p.trade);
  cfg.onTrade?.({ vault, tx: hash, rationale: p.trade.rationale, rationaleHash: rationaleHash(p.trade.rationale) });
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
