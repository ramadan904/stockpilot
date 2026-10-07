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
import { DEFAULT_TAX, estimateSale, inWashWindow, type SaleEstimate, type TaxPolicy } from "./taxaware";

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
export function plan(state: VaultState, opts: PlannerOptions = DEFAULT_PLANNER, tax?: TaxPolicy): Plan {
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
  let sell = byGap[0];
  let buy = byGap[byGap.length - 1];
  const budget = available(state);
  let taxNote = "";
  if (tax && gap(sell) > 0n && gap(buy) < 0n) {
    const choice = taxAwarePair(state, d, byGap, gap, budget, opts, tax);
    if ("hold" in choice) return { action: "hold", reason: choice.hold, drift: d };
    ({ sell, buy, note: taxNote } = choice);
  }
  const excess = gap(sell);
  const deficit = -gap(buy);
  if (excess <= 0n || deficit <= 0n) return { action: "hold", reason: "Nothing is overweight enough to sell.", drift: d };

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
      `Selling ${fmtUsd(valueUsd)} of ${sell.symbol} for ${buy.symbol} to move both back toward target.` +
      (tax ? ` ${taxNote}${taxSummary(estimateSale(tax, sell.token, amountIn, sell.price, sell.decimals, Number(state.now)), tax)}` : "");
    return { action: "trade", trade: { ...trade, minAmountOut, expectedAmountOut, valueUsd, rationale }, drift: d };
  }
  return { action: "hold", reason: "No trade size fits the mandate right now.", drift: d };
}

/**
 * The tax-aware choice of what to sell and what to buy, among the trades that still rebalance. An asset outside its
 * band always wins, whatever the tax: the mandate comes first.
 */
function taxAwarePair(
  state: VaultState,
  d: Drift[],
  byGap: AssetState[],
  gap: (a: AssetState) => bigint,
  budget: bigint,
  opts: PlannerOptions,
  tax: TaxPolicy,
): { sell: AssetState; buy: AssetState; note: string } | { hold: string } {
  const now = Number(state.now);
  const out = (a: AssetState) => d.find((x) => x.symbol === a.symbol)!.outOfBand;
  const forced = d.some((x) => x.outOfBand);

  // Buy: the most underweight asset, unless buying it would make a recent loss a wash sale (deferring that loss into
  // the new lot) and another asset at least half as underweight is clean. Never a reason to wait.
  const under = [...byGap].reverse().filter((a) => gap(a) < 0n && -gap(a) >= opts.minTradeUsd);
  if (under.length === 0) return { sell: byGap[0], buy: byGap[byGap.length - 1], note: "" };
  const clean = under.find((a) => !inWashWindow(tax, a.token, now) && -gap(a) * 2n >= -gap(under[0]));
  const buy = out(under[0]) || !clean ? under[0] : clean;
  const deficit = -gap(buy);

  // Sell: of the overweight assets at least half as far over as the most overweight (so trades stay worth making),
  // or only the out-of-band ones if any are, the lowest estimated tax per dollar sold.
  const most = gap(byGap[0]);
  let over = byGap.filter((a) => gap(a) > 0n && gap(a) * 2n >= most && gap(a) >= opts.minTradeUsd);
  if (over.some(out)) over = over.filter(out);
  if (over.length === 0) over = [byGap[0]];
  const scored = over.map((a) => {
    const usd = min(gap(a), deficit, state.limits.maxTradeUsd, budget > 0n ? budget : 1n);
    const amount = min(amountFor(usd, a.price, a.decimals), a.balance);
    return { a, usd: usd > 0n ? usd : 1n, est: estimateSale(tax, a.token, amount, a.price, a.decimals, now) };
  });
  // Lowest tax per dollar (cross-multiplied to stay exact); ties go to the more overweight asset, as without tax.
  scored.sort((x, y) => {
    const l = x.est.taxUsd * y.usd;
    const r = y.est.taxUsd * x.usd;
    return l < r ? -1 : l > r ? 1 : gap(y.a) > gap(x.a) ? 1 : gap(y.a) < gap(x.a) ? -1 : 0;
  });
  const best = scored[0];
  const wait = best.est.longTermInDays;
  // Waiting is only for drift well inside the bands: once anything nears its band edge, rebalance now.
  const nearEdge = d.some((x) => Math.abs(x.driftBps) * 4 > x.bandBps * 3);
  if (!forced && !nearEdge && tax.deferDays > 0 && wait !== null && wait <= tax.deferDays && best.est.taxUsd > 0n) {
    const saving = (best.est.shortGainUsd * BigInt(tax.shortTermRateBps - tax.longTermRateBps)) / BPS;
    return {
      hold: `Waiting ${wait} day${wait === 1 ? "" : "s"}: selling ${best.a.symbol} now would realize ${fmtUsd(best.est.shortGainUsd)} of short-term gains; then they are long term, about ${fmtUsd(saving)} less tax. Nothing is outside its band.`,
    };
  }
  // The owner's yearly gains budget: past it, only a band forces a sale.
  const gain = best.est.shortGainUsd + best.est.longGainUsd;
  if (!forced && tax.gainBudgetUsd !== undefined && gain > 0n && !best.est.washSale) {
    const sofar = tax.realizedThisYearUsd ?? 0n;
    if (sofar + gain > tax.gainBudgetUsd)
      return {
        hold: `Holding: selling ${best.a.symbol} now would realize ${fmtUsd(gain)} of gains, taking this year's to ${fmtUsd(sofar + gain)} against your ${fmtUsd(tax.gainBudgetUsd)} budget. It will rebalance anyway if any asset leaves its band.`,
      };
  }
  const note = best.a.token !== byGap[0].token ? `Tax-aware: selling ${best.a.symbol} rather than ${byGap[0].symbol}. ` : "";
  return { sell: best.a, buy, note };
}

/** One sentence on what a sale realizes. */
export function taxSummary(e: SaleEstimate, tax: Pick<TaxPolicy, "shortTermRateBps" | "longTermRateBps"> = DEFAULT_TAX): string {
  if (e.washSale) return "Realizes a loss, but within 30 days of buying, so it would not count (wash sale).";
  const parts: string[] = [];
  if (e.shortGainUsd !== 0n) parts.push(`${e.shortGainUsd < 0n ? "a short-term loss of " + fmtUsd(-e.shortGainUsd) : fmtUsd(e.shortGainUsd) + " short-term gain"}`);
  if (e.longGainUsd !== 0n) parts.push(`${e.longGainUsd < 0n ? "a long-term loss of " + fmtUsd(-e.longGainUsd) : fmtUsd(e.longGainUsd) + " long-term gain"}`);
  if (parts.length === 0) return "Realizes no gain or loss.";
  const t = e.taxUsd;
  return `Realizes ${parts.join(" and ")}: ${t < 0n ? `about ${fmtUsd(-t)} of tax saved` : `about ${fmtUsd(t)} of tax`} at ${tax.shortTermRateBps / 100}%/${tax.longTermRateBps / 100}%.`;
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
