// Every vault an owner has, side by side and added up, like a broker's "all accounts" view: one vault per goal
// (retirement on a glide path, a child's fund with an heir, an emergency fund in cash), each with its own mandate,
// and the household's total and combined allocation across all of them. Read from the chain only.

import type { Abi, Address, PublicClient } from "viem";
import { readVault } from "./chain";
import { glideProgress, readGlide } from "./glide";
import { isCash } from "./taxaware";
import { BPS, eq, totalValue, valueOf, type VaultState } from "./model";

export interface HouseholdVault {
  vault: Address;
  owner: Address;
  /** False when ownership has since passed to someone else (a transfer or an inheritance). */
  stillYours: boolean;
  state: VaultState;
  totalUsd: bigint;
  /** Share of the vault in stocks (everything but cash), in bps of its value. */
  stocksBps: number;
  paused: boolean;
  /** Fraction of the way along its glide path, if it has one. */
  glide: { progress: number; end: number } | null;
  guard: "off" | "armed" | "defensive";
  heir: Address | null;
}

export interface Household {
  vaults: HouseholdVault[];
  totalUsd: bigint;
  /** Combined holdings across the owner's vaults, largest first. */
  allocation: { symbol: string; valueUsd: bigint; bps: number }[];
  stocksBps: number;
}

const ZERO = /^0x0{40}$/i;

/** One vault, with what the household view shows about it. */
export async function householdVault(client: Pick<PublicClient, "readContract" | "getBlock">, abi: Abi, vault: Address, me: Address): Promise<HouseholdVault> {
  const read = (functionName: string) => client.readContract({ address: vault, abi, functionName } as never) as Promise<unknown>;
  const state = await readVault(client as never, abi, vault);
  const [owner, drawdown, defensive, heir, glide] = await Promise.all([
    read("owner") as Promise<Address>,
    read("drawdownBps"),
    read("defensive") as Promise<boolean>,
    read("heir") as Promise<Address>,
    readGlide(client, abi, vault, state.assets.map((a) => a.token)),
  ]);
  const total = totalValue(state.assets);
  const stocks = state.assets.filter((a) => !isCash(a.symbol)).reduce((s, a) => s + valueOf(a.balance, a.price, a.decimals), 0n);
  const now = Number(state.now);
  return {
    vault,
    owner,
    stillYours: eq(owner, me),
    state,
    totalUsd: total,
    stocksBps: total === 0n ? 0 : Number((stocks * BPS) / total),
    paused: state.paused,
    glide: glide ? { progress: glideProgress(glide, now), end: glide.end } : null,
    guard: Number(drawdown) === 0 ? "off" : defensive ? "defensive" : "armed",
    heir: ZERO.test(heir) ? null : heir,
  };
}

/** Totals and combined allocation over the vaults still owned. */
export function combine(vaults: HouseholdVault[]): Household {
  const mine = vaults.filter((v) => v.stillYours);
  const bySymbol = new Map<string, bigint>();
  let total = 0n;
  let stocks = 0n;
  for (const v of mine) {
    for (const a of v.state.assets) {
      const value = valueOf(a.balance, a.price, a.decimals);
      bySymbol.set(a.symbol, (bySymbol.get(a.symbol) ?? 0n) + value);
      total += value;
      if (!isCash(a.symbol)) stocks += value;
    }
  }
  const allocation = [...bySymbol]
    .map(([symbol, valueUsd]) => ({ symbol, valueUsd, bps: total === 0n ? 0 : Number((valueUsd * BPS) / total) }))
    .sort((a, b) => (b.valueUsd > a.valueUsd ? 1 : b.valueUsd < a.valueUsd ? -1 : a.symbol.localeCompare(b.symbol)));
  return { vaults, totalUsd: total, allocation, stocksBps: total === 0n ? 0 : Number((stocks * BPS) / total) };
}

/** The household for these vaults: each read in parallel; a vault that cannot be read is left out, not fatal. */
export async function readHousehold(client: Pick<PublicClient, "readContract" | "getBlock">, abi: Abi, vaults: Address[], me: Address): Promise<Household> {
  const read = await Promise.all(vaults.map((v) => householdVault(client, abi, v, me).catch(() => null)));
  return combine(read.filter((v): v is HouseholdVault => v !== null));
}
