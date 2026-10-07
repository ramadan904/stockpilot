// Stress test a mandate before signing it: run it through stylized market crashes three ways (left alone, flown by
// the pilot, and flown with the crash guard armed) using the real planner and the real rule model.
//
// The scenarios are shapes, not history: each is a market path drawn through a few key points (a fall of a third in a
// month, a two-year grind lower, a tech-only wreck...) with each stock moving by its own sensitivity and a little
// seeded noise. They show how the rules behave under stress; they do not forecast anything.

import { type AssetModel, type GuardConfig, maxDrawdown, rng, runPath } from "./backtest";
import type { Mandate } from "./mandate";

export interface Scenario {
  id: string;
  name: string;
  description: string;
  days: number;
  /** The market factor's key points, [trading day, level vs start]; straight lines between them on a log scale. */
  path: [number, number][];
  /** How strongly each stock follows the market factor (in log terms); defaults below. */
  sensitivity?: Record<string, number>;
}

/** How strongly each listing follows the market in these scenarios. The stablecoin does not move. */
export const SENSITIVITY: Record<string, number> = { USDG: 0, SPY: 1, AAPL: 1.1, NVDA: 1.5, TSLA: 1.6 };

export const SCENARIOS: Scenario[] = [
  {
    id: "crash-recovery",
    name: "Sharp crash, fast recovery",
    description: "The market falls a third in about a month, then claws it back over the next few months.",
    days: 160,
    path: [[0, 1], [23, 0.66], [60, 0.8], [110, 0.95], [160, 1.04]],
  },
  {
    id: "bear",
    name: "Long bear market",
    description: "A two-year grind down with rallies that fail, ending about 40% lower with no recovery in sight.",
    days: 500,
    path: [[0, 1], [60, 0.9], [90, 0.97], [200, 0.75], [230, 0.82], [400, 0.55], [500, 0.6]],
  },
  {
    id: "tech-wreck",
    name: "Tech wreck",
    description: "High-flying tech falls by half or more while the broad market loses a fifth, then bounces a little.",
    days: 300,
    path: [[0, 1], [200, 0.75], [300, 0.82]],
    sensitivity: { USDG: 0, SPY: 0.8, AAPL: 1.4, NVDA: 2.3, TSLA: 2.4 },
  },
  {
    id: "flash",
    name: "Flash crash",
    description: "A 10% plunge in one day, recovered within three.",
    days: 40,
    path: [[0, 1], [10, 1], [11, 0.9], [14, 1], [40, 1.01]],
  },
  {
    id: "melt-up",
    name: "Melt-up",
    description: "A year-long rally led by tech, up about half. Rebalancing sells winners along the way.",
    days: 250,
    path: [[0, 1], [250, 1.45]],
  },
];

/** The market factor's level on a day, interpolated between key points on a log scale. */
export function marketLevel(path: [number, number][], day: number) {
  for (let k = 1; k < path.length; k++) {
    const [d0, l0] = path[k - 1];
    const [d1, l1] = path[k];
    if (day <= d1) return Math.exp(Math.log(l0) + ((day - d0) / (d1 - d0)) * (Math.log(l1) - Math.log(l0)));
  }
  return path[path.length - 1][1];
}

/** Daily prices for every asset: the market path to the power of each stock's sensitivity, with seeded noise. */
export function scenarioPrices(s: Scenario, assets: AssetModel[], seed = 7): number[][] {
  const u = rng(seed);
  const noise = () => (u() + u() + u() - 1.5) * 0.012; // about 1% a day, the same draws every run
  return assets.map((a) => {
    const beta = (s.sensitivity ?? SENSITIVITY)[a.symbol] ?? 1;
    const prices: number[] = [];
    let wobble = 0;
    for (let d = 0; d <= s.days; d++) {
      if (beta !== 0 && d > 0) wobble = 0.8 * wobble + noise() * beta;
      prices.push(a.price * Math.pow(marketLevel(s.path, d), beta) * Math.exp(beta === 0 || d === 0 ? 0 : wobble));
    }
    return prices;
  });
}

export interface StrategyOutcome {
  values: number[];
  finalUsd: number;
  lowestUsd: number;
  maxDrawdownPct: number;
  trades: number;
  defensiveDay: number | null;
}

export interface StressResult {
  scenario: Scenario;
  hold: StrategyOutcome;
  pilot: StrategyOutcome;
  guarded: StrategyOutcome;
  /** Trades the rule model rejected; the planner only proposes accepted ones, so always 0. */
  rejected: number;
}

export function stressTest(o: { assets: AssetModel[]; mandate: Mandate; startUsd: number; guard: GuardConfig; feeBps?: number; venueFeeBps?: number }, scenario: Scenario): StressResult {
  const prices = scenarioPrices(scenario, o.assets);
  const opts = { assets: o.assets, mandate: o.mandate, startUsd: o.startUsd, days: scenario.days, paths: 1, seed: 1, venueFeeBps: o.venueFeeBps ?? 10, feeBps: o.feeBps ?? 0 };
  const plain = runPath(opts, prices);
  const withGuard = runPath(opts, prices, o.guard);
  const outcome = (values: number[], trades: number, defensiveDay: number | null): StrategyOutcome => ({
    values,
    finalUsd: values[values.length - 1],
    lowestUsd: Math.min(...values),
    maxDrawdownPct: maxDrawdown(values) * 100,
    trades,
    defensiveDay,
  });
  return {
    scenario,
    hold: outcome(plain.hold, 0, null),
    pilot: outcome(plain.pilot, plain.trades, null),
    guarded: outcome(withGuard.pilot, withGuard.trades, withGuard.defensiveDay),
    rejected: plain.rejected + withGuard.rejected,
  };
}
