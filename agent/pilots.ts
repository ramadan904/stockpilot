// The pilot marketplace: who offers to fly vaults (PilotRegistry, self-described) and what each has actually done
// (computed from the chain, never self-reported). Shared by the web app, the MCP server and scripts.

import { parseAbiItem, type Abi, type PublicClient } from "viem";
import { maxDrawdown } from "./backtest";
import { readVault } from "./chain";
import { eq, type Address } from "./model";
import { vaultPerformance } from "./performance";

export interface PilotEntry {
  address: Address;
  name: string;
  uri: string;
  feeBps: number;
  active: boolean;
  registeredAt: number;
  updatedAt: number;
}

export interface TrackRecord {
  /** Vaults whose current pilot this is. */
  vaults: number;
  /** Of those, paused by their owner or the pilot. */
  paused: number;
  /** Their combined value at oracle prices (18 decimals), skipping any vault whose prices cannot be read. */
  aumUsd: bigint;
  /** Trades in those vaults since this pilot was put in charge of each. */
  trades: number;
  tradedUsd: bigint;
  lastTradeBlock: bigint | null;
}

type Reader = Pick<PublicClient, "readContract" | "getLogs">;

const PAGE = 50n;

/** Every entry in the registry, in registration order. */
export async function listPilots(client: Reader, registryAbi: Abi, registry: Address): Promise<PilotEntry[]> {
  const count = (await client.readContract({ address: registry, abi: registryAbi, functionName: "pilotCount" })) as bigint;
  const out: PilotEntry[] = [];
  for (let start = 0n; start < count; start += PAGE) {
    type Raw = { name: string; uri: string; feeBps: number; active: boolean; registeredAt: bigint; updatedAt: bigint };
    const [addrs, entries] = (await client.readContract({
      address: registry,
      abi: registryAbi,
      functionName: "pilots",
      args: [start, PAGE],
    })) as readonly [Address[], Raw[]];
    addrs.forEach((address, i) => {
      const e = entries[i];
      out.push({
        address,
        name: e.name,
        uri: e.uri,
        feeBps: Number(e.feeBps),
        active: e.active,
        registeredAt: Number(e.registeredAt),
        updatedAt: Number(e.updatedAt),
      });
    });
  }
  return out;
}

const pilotSet = parseAbiItem("event PilotSet(address indexed pilot)");
const rebalanced = parseAbiItem(
  "event Rebalanced(address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut, uint256 valueInUsd, uint256 valueOutUsd, bytes32 indexed rationale)",
);

export const emptyRecord = (): TrackRecord => ({ vaults: 0, paused: 0, aumUsd: 0n, trades: 0, tradedUsd: 0n, lastTradeBlock: null });

/**
 * Track records for `pilots`, from every vault in the factory. A trade counts for a pilot only if it happened after
 * the vault's most recent `PilotSet`, i.e. while that pilot was in charge. `fromBlock` bounds the log search on chains
 * whose RPCs limit it.
 */
export async function trackRecords(
  client: Reader,
  abis: { factory: Abi; vault: Abi },
  factory: Address,
  pilots: Address[],
  fromBlock = 0n,
): Promise<Map<string, TrackRecord>> {
  const records = new Map<string, TrackRecord>(pilots.map((p) => [p.toLowerCase(), emptyRecord()]));
  const count = (await client.readContract({ address: factory, abi: abis.factory, functionName: "vaultCount" })) as bigint;
  const vaults = await Promise.all(
    Array.from({ length: Number(count) }, (_, i) =>
      client.readContract({ address: factory, abi: abis.factory, functionName: "vaultAt", args: [BigInt(i)] }) as Promise<Address>,
    ),
  );
  const read = <T>(address: Address, functionName: string) => client.readContract({ address, abi: abis.vault, functionName }) as Promise<T>;
  const current = await Promise.all(vaults.map((v) => read<Address>(v, "pilot")));
  const served = vaults.map((v, i) => ({ vault: v, pilot: current[i] })).filter((x) => records.has(x.pilot.toLowerCase()));
  if (served.length === 0) return records;

  const addresses = served.map((s) => s.vault);
  const [sets, trades] = await Promise.all([
    client.getLogs({ address: addresses, event: pilotSet, fromBlock }),
    client.getLogs({ address: addresses, event: rebalanced, fromBlock }),
  ]);
  // Position in the chain, so a trade and a pilot change in the same block are ordered correctly.
  const at = (l: { blockNumber: bigint | null; logIndex: number | null }) => (l.blockNumber ?? 0n) * 1_000_000n + BigInt(l.logIndex ?? 0);
  const since = new Map<string, bigint>();
  for (const l of sets) {
    const k = l.address.toLowerCase();
    if (at(l) > (since.get(k) ?? -1n)) since.set(k, at(l));
  }

  await Promise.all(
    served.map(async ({ vault, pilot }) => {
      const r = records.get(pilot.toLowerCase())!;
      r.vaults++;
      const [paused, total] = await Promise.all([
        read<boolean>(vault, "paused"),
        read<readonly [unknown, bigint]>(vault, "portfolio").then((p) => p[1]).catch(() => 0n),
      ]);
      if (paused) r.paused++;
      r.aumUsd += total;
      const from = since.get(vault.toLowerCase()) ?? 0n;
      for (const t of trades) {
        if (!eq(t.address, vault) || at(t) < from) continue;
        r.trades++;
        r.tradedUsd += t.args.valueInUsd ?? 0n;
        if (r.lastTradeBlock === null || t.blockNumber! > r.lastTradeBlock) r.lastTradeBlock = t.blockNumber!;
      }
    }),
  );
  return records;
}

/** What a fleet operator wants its registry entry to say, and whether the chain already says it. */
export function registrationNeeded(entry: Pick<PilotEntry, "name" | "uri" | "feeBps" | "active"> | null, want: { name: string; uri: string; feeBps: number }) {
  if (!entry || !entry.active) return true;
  return entry.name !== want.name || entry.uri !== want.uri || entry.feeBps !== want.feeBps;
}

export interface PilotScore {
  /** Vaults scored: those whose current pilot this is and that hold anything. */
  vaults: number;
  /** Their value now, and the value of what each held when this pilot took over (plus later deposits, minus
   * withdrawals) had it never been traded. Both at today's oracle prices, 18 decimals; the vault's value is after fees. */
  valueUsd: bigint;
  untradedUsd: bigint;
  /** What the pilot added (or cost), after fees, as bps of the untraded value; null with nothing to score. */
  addedBps: number | null;
  /** Worst fall from a peak, in percent, of value per dollar invested: the pilot's vaults, and the same untraded. */
  worstFallPct: number;
  untradedWorstFallPct: number;
  /** Vault-days flown, summed over the vaults scored: how much evidence there is. */
  vaultDays: number;
}

/**
 * How much each pilot has added since it took over each vault it flies, after fees, against leaving what it inherited
 * untraded; and how deep the falls were on each side. Read from the chain: the vault's own value, its oracle prices,
 * and its deposits and withdrawals. A vault-days figure says how much evidence each score rests on.
 */
export async function pilotScores(
  client: Reader & Pick<PublicClient, "getBlock">,
  abis: { factory: Abi; vault: Abi },
  factory: Address,
  pilots: Address[],
  samples = 20,
): Promise<Map<string, PilotScore>> {
  const scores = new Map<string, PilotScore>(
    pilots.map((p) => [p.toLowerCase(), { vaults: 0, valueUsd: 0n, untradedUsd: 0n, addedBps: null, worstFallPct: 0, untradedWorstFallPct: 0, vaultDays: 0 }]),
  );
  const count = (await client.readContract({ address: factory, abi: abis.factory, functionName: "vaultCount" })) as bigint;
  const vaults = await Promise.all(
    Array.from({ length: Number(count) }, (_, i) => client.readContract({ address: factory, abi: abis.factory, functionName: "vaultAt", args: [BigInt(i)] }) as Promise<Address>),
  );
  const current = await Promise.all(vaults.map((v) => client.readContract({ address: v, abi: abis.vault, functionName: "pilot" }) as Promise<Address>));
  const served = vaults.map((v, i) => ({ vault: v, pilot: current[i] })).filter((x) => scores.has(x.pilot.toLowerCase()));
  if (served.length === 0) return scores;

  const sets = await client.getLogs({ address: served.map((s) => s.vault), event: pilotSet, fromBlock: 0n });
  const since = new Map<string, bigint>();
  for (const l of sets) {
    const k = l.address.toLowerCase();
    if (l.blockNumber! > (since.get(k) ?? -1n)) since.set(k, l.blockNumber!);
  }

  await Promise.all(
    served.map(async ({ vault, pilot }) => {
      const state = await readVault(client as never, abis.vault, vault).catch(() => null);
      if (!state) return;
      const decimals = new Map(state.assets.map((a) => [a.token.toLowerCase(), a.decimals]));
      const points = await vaultPerformance(client as never, abis.vault, vault, decimals, samples, since.get(vault.toLowerCase()) ?? 0n, true).catch(() => []);
      const last = points.at(-1);
      if (!last || last.netDepositedUsd <= 0n) return;
      const s = scores.get(pilot.toLowerCase())!;
      s.vaults++;
      s.valueUsd += last.valueUsd;
      s.untradedUsd += last.untradedUsd;
      // Per dollar invested, so money moving in or out is never mistaken for a rise or a fall.
      const perDollar = (v: bigint, net: bigint) => (net > 0n ? Number((v * 1_000_000n) / net) / 1_000_000 : 1);
      s.worstFallPct = Math.max(s.worstFallPct, maxDrawdown(points.map((p) => perDollar(p.valueUsd, p.netDepositedUsd))) * 100);
      s.untradedWorstFallPct = Math.max(s.untradedWorstFallPct, maxDrawdown(points.map((p) => perDollar(p.untradedUsd, p.netDepositedUsd))) * 100);
      s.vaultDays += (points[points.length - 1].time - points[0].time) / 86_400;
    }),
  );
  for (const s of scores.values()) if (s.untradedUsd > 0n) s.addedBps = Number(((s.valueUsd - s.untradedUsd) * 10_000n) / s.untradedUsd);
  return scores;
}
