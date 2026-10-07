// Copy-trading by mandate: turn a live vault's onchain rules into a draft anyone can simulate, adjust and sign into a
// vault of their own. What is copied is the rules (targets, bands, limits as shares of the vault), never the funds,
// the owner or the pilot.

import { totalValue, type VaultState } from "./model";
import type { Proposal } from "./mandate";

const pct = (part: bigint, whole: bigint) => (whole > 0n ? Number((part * 10_000n) / whole) / 100 : 0);
const round1 = (n: number) => Math.round(n * 10) / 10;

/** A risk label from how much sits in the stablecoin: the same four the strategist uses. */
export function riskFromCash(cashPercent: number): Proposal["risk_level"] {
  if (cashPercent >= 50) return "conservative";
  if (cashPercent >= 25) return "balanced";
  if (cashPercent >= 10) return "growth";
  return "aggressive";
}

export function proposalFromVault(state: VaultState, from: { vault: string; chain: string }, stable = "USDG"): Proposal {
  const total = totalValue(state.assets);
  const cash = state.assets.find((a) => a.symbol === stable)?.targetBps ?? 0;
  // Bands are per asset onchain; a draft has one. The widest keeps every copied asset at least as free as it was.
  const band = Math.max(...state.assets.map((a) => a.bandBps)) / 100;
  // Limits are in dollars onchain; as shares of this vault they carry over to a vault of any size. An empty vault has
  // no size to measure against, so the strategist's usual defaults stand in.
  const maxTrade = total > 0n ? round1(pct(state.limits.maxTradeUsd, total)) : 10;
  const daily = total > 0n ? round1(pct(state.limits.dailyLimitUsd, total)) : 30;
  const short = `${from.vault.slice(0, 6)}…${from.vault.slice(-4)}`;
  return {
    summary: `Copied from vault ${short} on ${from.chain}: its targets, bands and trading limits as they stand onchain.`,
    risk_level: riskFromCash(cash / 100),
    allocations: state.assets.map((a) => ({
      symbol: a.symbol,
      weight_percent: a.targetBps / 100,
      reason: `${a.targetBps / 100}% target in the copied vault, may drift ±${a.bandBps / 100} pts.`,
    })),
    band_percent: band,
    max_trade_percent: maxTrade,
    daily_turnover_percent: daily,
  };
}
