// Decides the pilot's next trade. Pure and deterministic: the same vault state always yields the same plan, which
// keeps the pilot auditable and lets tests pin its behaviour.

import {
  BPS,
  WAD,
  amountFor,
  available,
  check,
  totalValue,
  valueOf,
  weightWad,
  type AssetState,
  type Trade,
  type VaultState,
} from "./model";

export interface PlannerOptions {
  /** Fee the pilot expects the venue to charge, used to predict fills. */
  expectedFeeBps: number;
  /** Extra slippage the pilot tolerates on top of the expected fee, for minAmountOut. Capped by the mandate. */
  slippageToleranceBps: number;
  /** Ignore trades smaller than this (USD, 18 decimals); not worth the gas. */
  minTradeUsd: bigint;
  /**
   * Start rebalancing once an asset drifts this fraction of the way to its band edge. The band is the hard limit
   * the vault enforces; the trigger is the pilot's own, tighter, habit.
   */
  triggerFraction: number;
}

export const DEFAULT_PLANNER: PlannerOptions = {
  expectedFeeBps: 10,
  slippageToleranceBps: 50,
  minTradeUsd: 10n * WAD,
  triggerFraction: 0.5,
};

export interface PlannedTrade extends Trade {
  minAmountOut: bigint;
  expectedAmountOut: bigint;
  valueUsd: bigint;
  /** Plain-English reason; its keccak256 goes onchain with the trade. */
  rationale: string;
}

export type Plan =
  | { action: "trade"; trade: PlannedTrade; drift: Drift[] }
  | { action: "hold"; reason: string; drift: Drift[] };

export interface Drift {
  symbol: string;
  weightBps: number;
  targetBps: number;
  bandBps: number;
  /** Weight minus target, in bps. */
  driftBps: number;
  outOfBand: boolean;
  /** Past the pilot's trigger: worth trading back toward target. */
  triggered: boolean;
}

export function drift(state: VaultState, triggerFraction = DEFAULT_PLANNER.triggerFraction): Drift[] {
  const total = totalValue(state.assets);
  return state.assets.map((a) => {
    const weightBps = Number((weightWad(valueOf(a.balance, a.price, a.decimals), total) * BPS) / WAD);
    const driftBps = weightBps - a.targetBps;
    return {
      symbol: a.symbol,
      weightBps,
      targetBps: a.targetBps,
      bandBps: a.bandBps,
      driftBps,
      outOfBand: Math.abs(driftBps) > a.bandBps,
      triggered: Math.abs(driftBps) > a.bandBps * triggerFraction,
    };
  });
}

/**
 * Threshold rebalancing: do nothing while every asset sits near its target. When one drifts past the trigger (by
 * default, halfway to its band edge), sell the most
 * overweight asset into the most underweight one, sized to bring the worse of the two back to target, then shrunk
 * until the vault's own rules accept it. One trade per call; the cooldown spaces them out.
 */
export function plan(state: VaultState, opts: PlannerOptions = DEFAULT_PLANNER): Plan {
  const d = drift(state, opts.triggerFraction);
  if (state.paused) return { action: "hold", reason: "The vault is paused.", drift: d };
  if (state.assets.some((a) => state.now - a.priceUpdatedAt > BigInt(state.limits.maxPriceAge))) {
    return { action: "hold", reason: "A price is stale (market closed or feed down); not trading on it.", drift: d };
  }
  const cooldownEnds = state.lastTradeAt + BigInt(state.limits.cooldown);
  if (state.lastTradeAt !== 0n && state.now < cooldownEnds) {
    return { action: "hold", reason: `Cooling down for ${cooldownEnds - state.now}s more.`, drift: d };
  }
  if (!d.some((x) => x.triggered)) {
    return { action: "hold", reason: "Every asset is within its rebalancing trigger.", drift: d };
  }

  const total = totalValue(state.assets);
  const gap = (a: AssetState) => valueOf(a.balance, a.price, a.decimals) - (total * BigInt(a.targetBps)) / BPS;
  const byGap = [...state.assets].sort((x, y) => (gap(y) > gap(x) ? 1 : gap(y) < gap(x) ? -1 : 0));
  const sell = byGap[0];
  const buy = byGap[byGap.length - 1];
  const excess = gap(sell);
  const deficit = -gap(buy);
  if (excess <= 0n || deficit <= 0n) return { action: "hold", reason: "Nothing is overweight enough to sell.", drift: d };

  const budget = available(state);
  let usd = min(excess, deficit, state.limits.maxTradeUsd, budget);
  if (usd < opts.minTradeUsd) {
    const why = budget < opts.minTradeUsd ? "The 24-hour trading limit is used up for now." : "Drift is too small to trade.";
    return { action: "hold", reason: why, drift: d };
  }

  // Shrink until the mandate model accepts the trade with the fill we expect. Usually the first try passes.
  for (let i = 0; i < 24 && usd >= opts.minTradeUsd; i++, usd = (usd * 3n) / 4n) {
    const amountIn = min(amountFor(usd, sell.price, sell.decimals), sell.balance);
    const valueUsd = valueOf(amountIn, sell.price, sell.decimals);
    const expectedAmountOut = amountFor((valueUsd * (BPS - BigInt(opts.expectedFeeBps))) / BPS, buy.price, buy.decimals);
    const trade = { tokenIn: sell.token, tokenOut: buy.token, amountIn };
    if (!check(state, trade, expectedAmountOut).ok) continue;

    const tolerance = Math.min(opts.expectedFeeBps + opts.slippageToleranceBps, state.limits.maxSlippageBps);
    const minAmountOut = amountFor((valueUsd * (BPS - BigInt(tolerance))) / BPS, buy.price, buy.decimals);
    const s = d.find((x) => x.symbol === sell.symbol)!;
    const b = d.find((x) => x.symbol === buy.symbol)!;
    const rationale =
      `${sell.symbol} is ${pct(s.weightBps)} of the portfolio against a ${pct(s.targetBps)} target; ` +
      `${buy.symbol} is ${pct(b.weightBps)} against ${pct(b.targetBps)}. ` +
      `Selling ${fmtUsd(valueUsd)} of ${sell.symbol} for ${buy.symbol} to move both back toward target.`;
    return { action: "trade", trade: { ...trade, minAmountOut, expectedAmountOut, valueUsd, rationale }, drift: d };
  }
  return { action: "hold", reason: "No trade size fits the mandate right now.", drift: d };
}

function min(...xs: bigint[]) {
  return xs.reduce((m, x) => (x < m ? x : m));
}

export function pct(bps: number) {
  return `${(bps / 100).toFixed(1)}%`;
}

export function fmtUsd(wad: bigint) {
  const cents = wad / 10n ** 16n;
  const dollars = cents / 100n;
  return `$${dollars.toLocaleString("en-US")}.${(cents % 100n).toString().padStart(2, "0")}`;
}
