// What would the pilot have done? Runs the real planner and the real rule model over simulated price paths and
// compares the result with simply holding the starting portfolio. Pure and seeded: the same inputs always give the
// same numbers, so the web app and the tests agree.
//
// The price model is deliberately plain (correlated geometric Brownian motion with illustrative volatilities), and
// says nothing about future returns. Its job is to show what rebalancing inside a mandate does to risk: drawdowns,
// volatility and concentration. The return difference depends on the path.

import type { Mandate } from "./mandate";
import { BPS, WAD, afterSpend, amountFor, check, valueOf, type AssetState, type VaultState } from "./model";
import { DEFAULT_PLANNER, plan, type PlannerOptions } from "./planner";
import { LotBook, yearOf, type AssetInfo, type Sale } from "./tax";
import { taxDue, type TaxPolicy } from "./taxaware";
import { glidedTargets, type GlidePath } from "./glide";

export interface AssetModel {
  symbol: string;
  decimals: number;
  price: number;
  /** Annual volatility, e.g. 0.5 for 50%. */
  vol: number;
  /** Correlation with the broad market factor, 0..1. */
  beta: number;
  /** Annual drift. */
  drift: number;
}

/** Illustrative only: rough long-run volatilities, one drift for every stock, no forecasts. */
export const DEFAULT_MODELS: Record<string, Omit<AssetModel, "symbol" | "decimals" | "price">> = {
  USDG: { vol: 0, beta: 0, drift: 0 },
  SPY: { vol: 0.18, beta: 0.95, drift: 0.07 },
  AAPL: { vol: 0.28, beta: 0.7, drift: 0.07 },
  NVDA: { vol: 0.5, beta: 0.6, drift: 0.07 },
  TSLA: { vol: 0.55, beta: 0.5, drift: 0.07 },
};

export interface BacktestOptions {
  assets: AssetModel[];
  mandate: Mandate;
  startUsd: number;
  days: number;
  paths: number;
  seed: number;
  /** Venue cost per trade, bps. */
  venueFeeBps: number;
  /** Management fee, bps a year. */
  feeBps: number;
  planner?: PlannerOptions;
  /** A glide path to these targets (mandate order, summing to 100%) by the last day, as `setGlidePath` runs it. */
  glideTo?: number[];
  /** Track tax lots (and, if `aware`, plan tax-aware). */
  tax?: TaxSettings;
}

/**
 * Tax in the backtest. Wash sales are not adjusted for in the tax due: that can only understate the plain pilot's tax
 * (the tax-aware one avoids them), so the comparison errs against the tax-aware pilot.
 */
export interface TaxSettings {
  shortTermRateBps: number;
  longTermRateBps: number;
  deferDays: number;
  /** Yearly net gains budget, USD. */
  gainBudgetUsd?: number;
  /** Plan tax-aware; otherwise lots are only tracked, to measure the plain pilot's taxes. */
  aware: boolean;
}

export interface PathTax {
  /** Tax due on gains realized along the way (fees paid in kind included), year by year. */
  alongTheWayUsd: number;
  /** Further tax if everything were sold on the last day. */
  liquidationUsd: number;
  /** The same for the starting portfolio left alone. */
  holdLiquidationUsd: number;
  shortGainUsd: number;
  longGainUsd: number;
}

export interface PathResult {
  pilot: number[];
  hold: number[];
  trades: number;
  volumeUsd: number;
  feesUsd: number;
  /** Trades the rule model rejected. The planner only proposes accepted trades, so this should always be 0. */
  rejected: number;
  maxDriftBps: number;
  /** Largest weight any single risky (non-stable) asset reached, in percent. */
  maxRiskyWeightPct: number;
  /** Day the crash guard tripped, if it did. */
  defensiveDay: number | null;
  tax?: PathTax;
}

/** The vault's crash guard, as `setCrashGuard` arms it. */
export interface GuardConfig {
  /** Index of the safe asset in the mandate. */
  safeIndex: number;
  safeTargetBps: number;
  drawdownBps: number;
}

/**
 * One crash-guard check at `totalUsd`, exactly `PilotVault._guard`: off or already defensive, nothing changes; above the
 * peak, a new peak; past the drawdown below it, a trip. The Solana rules core reproduces it (solana/mandate-core).
 */
export function guardStep(totalUsd: bigint, peakUsd: bigint, drawdownBps: number, defensive: boolean): { peakUsd: bigint; trip: boolean } {
  if (drawdownBps === 0 || defensive) return { peakUsd, trip: false };
  if (totalUsd > peakUsd) return { peakUsd: totalUsd, trip: false };
  return { peakUsd, trip: totalUsd * BPS < peakUsd * (BPS - BigInt(drawdownBps)) };
}

/** The targets the vault switches to in defensive mode: exactly `PilotVault._target`, rounding included. */
export function defensiveTargets(targets: number[], g: GuardConfig): number[] {
  const safeNormal = targets[g.safeIndex];
  return targets.map((t, i) => (i === g.safeIndex ? g.safeTargetBps : Math.floor((t * (10_000 - g.safeTargetBps)) / (10_000 - safeNormal))));
}

export interface Summary {
  finalValue: Percentiles;
  maxDrawdownPct: Percentiles;
  volatilityPct: Percentiles;
  maxConcentrationPct: Percentiles;
}

export interface Percentiles {
  p5: number;
  p50: number;
  p95: number;
}

export interface BacktestResult {
  pilot: Summary;
  hold: Summary;
  /** Share of paths where the pilot ended with more than holding. */
  pilotWinsPct: number;
  tradesPerYear: number;
  volumeUsdPerYear: number;
  feesUsdPerYear: number;
  rejected: number;
  /** The path whose pilot outcome is the median, for charting. Daily values. */
  medianPath: { pilot: number[]; hold: number[] };
}

/** Seeded uniform [0, 1). */
export function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normal(u: () => number) {
  return Math.sqrt(-2 * Math.log(1 - u())) * Math.cos(2 * Math.PI * u());
}

const toWad = (x: number) => BigInt(Math.round(x * 1e6)) * 10n ** 12n;
const fromWad = (x: bigint) => Number(x / 10n ** 12n) / 1e6;

/** Daily prices for every asset over one path. */
export function simulatePrices(assets: AssetModel[], days: number, u: () => number): number[][] {
  const dt = 1 / 252;
  const prices = assets.map((a) => [a.price]);
  for (let d = 1; d <= days; d++) {
    const market = normal(u);
    assets.forEach((a, i) => {
      const z = a.beta * market + Math.sqrt(1 - a.beta * a.beta) * normal(u);
      const r = (a.drift - 0.5 * a.vol * a.vol) * dt + a.vol * Math.sqrt(dt) * z;
      prices[i].push(prices[i][d - 1] * Math.exp(r));
    });
  }
  return prices;
}

/** One path: the pilot flying the mandate, and the same starting portfolio left alone. */
export function runPath(o: BacktestOptions, prices: number[][], guard?: GuardConfig): PathResult {
  const cooldown = BigInt(Math.max(o.mandate.limits.cooldown, 1));
  let now = 1_700_000_000n;
  let state: VaultState = {
    address: "0x0000000000000000000000000000000000000000",
    assets: o.assets.map((a, i) => ({
      token: `0x${(i + 1).toString(16).padStart(40, "0")}` as const,
      symbol: a.symbol,
      decimals: a.decimals,
      balance: amountFor((toWad(o.startUsd) * BigInt(o.mandate.assets[i].targetBps)) / BPS, toWad(a.price), a.decimals),
      price: toWad(a.price),
      priceUpdatedAt: now,
      targetBps: o.mandate.assets[i].targetBps,
      bandBps: o.mandate.assets[i].bandBps,
    })),
    limits: o.mandate.limits,
    lastTradeAt: 0n,
    budgetUsd: o.mandate.limits.dailyLimitUsd,
    budgetUpdatedAt: now,
    paused: false,
    now,
  };
  const holdBalances = state.assets.map((a) => a.balance);
  const total = (assets: AssetState[]) => fromWad(assets.reduce((t, a) => t + valueOf(a.balance, a.price, a.decimals), 0n));
  const out: PathResult = { pilot: [], hold: [], trades: 0, volumeUsd: 0, feesUsd: 0, rejected: 0, maxDriftBps: 0, maxRiskyWeightPct: 0, defensiveDay: null };
  let peak = 0n;
  const dailyFee = BigInt(Math.round((o.feeBps / 252) * 1e6)); // per trading day, in millionths of a bp

  // Tax lots: the starting portfolio is bought on day one; every trade and fee is a sale, first in, first out.
  const info = new Map<string, AssetInfo>(state.assets.map((a, i) => [a.token, { symbol: a.symbol, decimals: a.decimals, cash: o.assets[i].vol === 0 }]));
  const book = o.tax ? new LotBook(info) : null;
  const holdBook = o.tax ? new LotBook(info) : null;
  for (const a of state.assets) {
    book?.acquire(a.token, a.balance, valueOf(a.balance, a.price, a.decimals), Number(now), true);
    holdBook?.acquire(a.token, a.balance, valueOf(a.balance, a.price, a.decimals), Number(now), true);
  }
  const feeOwed = state.assets.map(() => 0n);
  const mandateTargets = o.mandate.assets.map((a) => a.targetBps);
  const glide: GlidePath | null = o.glideTo ? { start: Number(now), end: Number(now) + (prices[0].length - 1) * 86_400, from: mandateTargets, to: o.glideTo } : null;
  const cash = new Set(state.assets.filter((_, i) => o.assets[i].vol === 0).map((a) => a.token.toLowerCase()));
  const policy = (): TaxPolicy | undefined =>
    o.tax?.aware && book
      ? {
          lots: book.open(),
          lastLossSale: book.lastLossSale,
          cash,
          shortTermRateBps: o.tax.shortTermRateBps,
          longTermRateBps: o.tax.longTermRateBps,
          deferDays: o.tax.deferDays,
          gainBudgetUsd: o.tax.gainBudgetUsd === undefined ? undefined : toWad(o.tax.gainBudgetUsd),
          realizedThisYearUsd: book.gainsIn(yearOf(Number(state.now))),
        }
      : undefined;

  for (let d = 0; d < prices[0].length; d++) {
    now += 86_400n;
    state = { ...state, now, assets: state.assets.map((a, i) => ({ ...a, price: toWad(prices[i][d]), priceUpdatedAt: now })) };

    if (d > 0 && o.feeBps > 0) {
      const before = total(state.assets);
      const fee = state.assets.map((a) => (a.balance * dailyFee) / (BPS * 1_000_000n));
      // The fee accrues daily and is booked as collected once a month (a sale of what it took, at that day's price).
      fee.forEach((f, i) => (feeOwed[i] += f));
      if (book && d % 21 === 0) {
        state.assets.forEach((a, i) => book.dispose(a.token, feeOwed[i], valueOf(feeOwed[i], a.price, a.decimals), Number(now), "fee", "0x"));
        feeOwed.fill(0n);
      }
      state = { ...state, assets: state.assets.map((a, i) => ({ ...a, balance: a.balance - fee[i] })) };
      out.feesUsd += before - total(state.assets);
    }

    // The glide path moves the targets every day; in defensive mode the guard's targets are taken from the glided ones.
    if (glide) {
      const base = glidedTargets(mandateTargets, glide, Number(now));
      const next = guard && out.defensiveDay !== null ? defensiveTargets(base, guard) : base;
      state = { ...state, assets: state.assets.map((a, i) => ({ ...a, targetBps: next[i] })) };
    }

    // The crash guard, as the vault runs it (poked daily by the fleet, and again by every trade).
    if (guard && out.defensiveDay === null) {
      const step = guardStep(state.assets.reduce((s, a) => s + valueOf(a.balance, a.price, a.decimals), 0n), peak, guard.drawdownBps, false);
      peak = step.peakUsd;
      if (step.trip) {
        out.defensiveDay = d;
        const next = defensiveTargets(state.assets.map((a) => a.targetBps), guard);
        state = { ...state, assets: state.assets.map((a, i) => ({ ...a, targetBps: next[i] })) };
      }
    }

    // The pilot gets a few chances a day, the cooldown apart.
    for (let k = 0; k < 4; k++) {
      const p = plan(state, o.planner ?? DEFAULT_PLANNER, policy());
      if (p.action === "hold") break;
      const sell = state.assets.find((a) => a.token === p.trade.tokenIn)!;
      const buy = state.assets.find((a) => a.token === p.trade.tokenOut)!;
      const valueIn = valueOf(p.trade.amountIn, sell.price, sell.decimals);
      const amountOut = amountFor((valueIn * (BPS - BigInt(o.venueFeeBps))) / BPS, buy.price, buy.decimals);
      const verdict = check(state, p.trade, amountOut, p.trade.minAmountOut);
      if (!verdict.ok) {
        out.rejected++;
        break;
      }
      state = afterSpend(state, verdict.valueIn);
      const valueOut = valueOf(amountOut, buy.price, buy.decimals);
      book?.dispose(sell.token, p.trade.amountIn, valueOut, Number(now), "trade", "0x");
      book?.acquire(buy.token, amountOut, valueOut, Number(now), true);
      state = {
        ...state,
        assets: state.assets.map((a) =>
          a.token === sell.token ? { ...a, balance: a.balance - p.trade.amountIn } : a.token === buy.token ? { ...a, balance: a.balance + amountOut } : a,
        ),
      };
      out.trades++;
      out.volumeUsd += fromWad(verdict.valueIn);
      now += cooldown;
      state = { ...state, now, assets: state.assets.map((a) => ({ ...a, priceUpdatedAt: now })) };
    }

    const pilotTotal = total(state.assets);
    out.pilot.push(pilotTotal);
    out.hold.push(total(state.assets.map((a, i) => ({ ...a, balance: holdBalances[i] }))));
    state.assets.forEach((a, i) => {
      const w = (fromWad(valueOf(a.balance, a.price, a.decimals)) / pilotTotal) * 10_000;
      out.maxDriftBps = Math.max(out.maxDriftBps, Math.abs(w - a.targetBps));
      if (o.assets[i].vol > 0) out.maxRiskyWeightPct = Math.max(out.maxRiskyWeightPct, w / 100);
    });
  }
  if (o.tax && book && holdBook) {
    const end = Number(now);
    const along = taxDue(book.sales, o.tax);
    const sellAll = (b: LotBook): Sale[] =>
      b.open().map((l) => {
        const a = state.assets.find((x) => x.token === l.token)!;
        const proceeds = valueOf(l.amount, a.price, a.decimals);
        return { ...l, symbol: a.symbol, sold: end, proceedsUsd: proceeds, gainUsd: proceeds - l.basisUsd, term: end - l.acquired > 365 * 86_400 ? "long" : "short", via: "trade", tx: "0x" };
      });
    out.tax = {
      alongTheWayUsd: fromWad(along.taxUsd),
      liquidationUsd: fromWad(taxDue([...book.sales, ...sellAll(book)], o.tax).taxUsd - along.taxUsd),
      holdLiquidationUsd: fromWad(taxDue(sellAll(holdBook), o.tax).taxUsd),
      shortGainUsd: fromWad(along.shortGainUsd),
      longGainUsd: fromWad(along.longGainUsd),
    };
  }
  return out;
}

export interface TaxStrategy {
  /** Medians across paths. */
  taxAlongTheWayUsd: number;
  afterTaxFinalUsd: number;
  tradesPerYear: number;
  /** 95th percentile of the largest drift from target, in bps: tax awareness must not cost discipline. */
  maxDriftBpsP95: number;
}

export interface TaxBacktestResult {
  plain: TaxStrategy;
  aware: TaxStrategy;
  hold: { afterTaxFinalUsd: number };
  /** Tax the tax-aware pilot saved along the way, on average per path (most paths see the same trades either way). */
  savedUsd: number;
  /** Share of paths where it paid less tax along the way, and where it paid more. */
  savedPathsPct: number;
  costlierPathsPct: number;
  /** Share of paths where the tax-aware pilot ends with at least as much after tax as the plain one. */
  awareWinsPct: number;
  rejected: number;
}

/** The plain pilot and the tax-aware pilot over the same price paths, before and after tax. */
export function taxBacktest(o: BacktestOptions, rates: Omit<TaxSettings, "aware">, onProgress?: Progress): TaxBacktestResult {
  const u = rng(o.seed);
  const plainRuns: PathResult[] = [];
  const awareRuns: PathResult[] = [];
  for (let i = 0; i < o.paths; i++) {
    const prices = simulatePrices(o.assets, o.days, u);
    plainRuns.push(runPath({ ...o, tax: { ...rates, aware: false } }, prices));
    awareRuns.push(runPath({ ...o, tax: { ...rates, aware: true } }, prices));
    onProgress?.(i + 1, o.paths);
  }
  const saved = plainRuns.map((r, i) => r.tax!.alongTheWayUsd - awareRuns[i].tax!.alongTheWayUsd);
  const afterTax = (r: PathResult) => r.pilot[r.pilot.length - 1] - r.tax!.alongTheWayUsd - r.tax!.liquidationUsd;
  const median = (xs: number[]) => percentiles(xs).p50;
  const years = o.days / 252;
  const summary = (runs: PathResult[]): TaxStrategy => ({
    taxAlongTheWayUsd: median(runs.map((r) => r.tax!.alongTheWayUsd)),
    afterTaxFinalUsd: median(runs.map(afterTax)),
    tradesPerYear: mean(runs.map((r) => r.trades)) / years,
    maxDriftBpsP95: percentiles(runs.map((r) => r.maxDriftBps)).p95,
  });
  return {
    plain: summary(plainRuns),
    aware: summary(awareRuns),
    hold: { afterTaxFinalUsd: median(plainRuns.map((r) => r.hold[r.hold.length - 1] - r.tax!.holdLiquidationUsd)) },
    savedUsd: mean(saved),
    savedPathsPct: (saved.filter((x) => x > 0.005).length / o.paths) * 100,
    costlierPathsPct: (saved.filter((x) => x < -0.005).length / o.paths) * 100,
    awareWinsPct: (awareRuns.filter((r, i) => afterTax(r) >= afterTax(plainRuns[i]) - 1e-6).length / o.paths) * 100,
    rejected: [...plainRuns, ...awareRuns].reduce((s, r) => s + r.rejected, 0),
  };
}

/** Called after each simulated path: how many are done, out of how many. */
export type Progress = (done: number, total: number) => void;

export function backtest(o: BacktestOptions, onProgress?: Progress): BacktestResult {
  const u = rng(o.seed);
  const runs: PathResult[] = [];
  const concentration = { pilot: [] as number[], hold: [] as number[] };
  for (let i = 0; i < o.paths; i++) {
    const prices = simulatePrices(o.assets, o.days, u);
    const r = runPath(o, prices);
    runs.push(r);
    // Largest single-asset weight reached along the way, for each strategy.
    concentration.pilot.push(r.maxRiskyWeightPct);
    concentration.hold.push(holdMaxRiskyWeight(prices, r.hold, o));
    onProgress?.(i + 1, o.paths);
  }
  const summarize = (key: "pilot" | "hold"): Summary => ({
    finalValue: percentiles(runs.map((r) => r[key][r[key].length - 1])),
    maxDrawdownPct: percentiles(runs.map((r) => maxDrawdown(r[key]) * 100)),
    volatilityPct: percentiles(runs.map((r) => annualVol(r[key]) * 100)),
    maxConcentrationPct: percentiles(concentration[key]),
  });
  const years = o.days / 252;
  const byPilot = [...runs].sort((a, b) => a.pilot[a.pilot.length - 1] - b.pilot[b.pilot.length - 1]);
  const median = byPilot[Math.floor(byPilot.length / 2)];
  return {
    pilot: summarize("pilot"),
    hold: summarize("hold"),
    pilotWinsPct: (runs.filter((r) => r.pilot[r.pilot.length - 1] > r.hold[r.hold.length - 1]).length / runs.length) * 100,
    tradesPerYear: mean(runs.map((r) => r.trades)) / years,
    volumeUsdPerYear: mean(runs.map((r) => r.volumeUsd)) / years,
    feesUsdPerYear: mean(runs.map((r) => r.feesUsd)) / years,
    rejected: runs.reduce((s, r) => s + r.rejected, 0),
    medianPath: { pilot: median.pilot, hold: median.hold },
  };
}

/** Buy-and-hold's largest single risky-asset weight, in percent: starting units at each day's price over that day's total. */
function holdMaxRiskyWeight(prices: number[][], totals: number[], o: BacktestOptions): number {
  const units = o.assets.map((a, i) => (o.startUsd * o.mandate.assets[i].targetBps) / 10_000 / a.price);
  let worst = 0;
  for (let d = 0; d < totals.length; d++) {
    o.assets.forEach((a, i) => {
      if (a.vol > 0) worst = Math.max(worst, ((units[i] * prices[i][d]) / totals[d]) * 100);
    });
  }
  return worst;
}

export function maxDrawdown(values: number[]) {
  let peak = values[0];
  let worst = 0;
  for (const v of values) {
    peak = Math.max(peak, v);
    worst = Math.max(worst, (peak - v) / peak);
  }
  return worst;
}

export function annualVol(values: number[]) {
  const r = values.slice(1).map((v, i) => Math.log(v / values[i]));
  if (r.length < 2) return 0;
  const m = mean(r);
  return Math.sqrt(r.reduce((s, x) => s + (x - m) ** 2, 0) / (r.length - 1)) * Math.sqrt(252);
}

function mean(xs: number[]) {
  return xs.reduce((s, x) => s + x, 0) / Math.max(xs.length, 1);
}

export function percentiles(xs: number[]): Percentiles {
  const s = [...xs].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))];
  return { p5: at(0.05), p50: at(0.5), p95: at(0.95) };
}

export function modelsFor(listings: readonly { symbol: string; decimals: number; price: number }[]): AssetModel[] {
  return listings.map((l) => ({ symbol: l.symbol, decimals: l.decimals, price: l.price, ...(DEFAULT_MODELS[l.symbol] ?? { vol: 0.3, beta: 0.6, drift: 0.07 }) }));
}

export { WAD };

/**
 * Defensive targets the vault accepts for a safe asset whose mandate target is `nowPct`: above it, at most 100%.
 * The default is 70% when allowed, else the next step up. Empty when the safe asset is already at 100%.
 */
export function safeTargetChoices(nowPct: number): { options: number[]; fallback: number | null } {
  const options = [50, 60, 70, 80, 90, 100].filter((t) => t > nowPct);
  return { options, fallback: options.find((t) => t >= 70) ?? options[0] ?? null };
}
