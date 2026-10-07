import { expect } from "chai";
import { LISTINGS } from "../agent/listings";
import { presetFor, toMandate } from "../agent/mandate";
import { backtest, maxDrawdown, modelsFor, percentiles, runPath, simulatePrices, rng, type BacktestOptions } from "../agent/backtest";

const universe = LISTINGS.map((l, i) => ({ ...l, token: `0x${(i + 1).toString(16).padStart(40, "0")}` as const, feed: `0x${"f".repeat(40)}` as const, stable: "stable" in l }));

function options(goal: string, extra: Partial<BacktestOptions> = {}): BacktestOptions {
  const { mandate } = toMandate(presetFor(goal, [...LISTINGS]), universe, 10_000);
  return { assets: modelsFor(LISTINGS), mandate, startUsd: 10_000, days: 252, paths: 40, seed: 7, venueFeeBps: 10, feeBps: 0, ...extra };
}

describe("agent/backtest", () => {
  it("is deterministic for a seed", () => {
    const a = backtest(options("balanced"));
    const b = backtest(options("balanced"));
    expect(a.pilot.finalValue).to.deep.equal(b.pilot.finalValue);
    expect(a.medianPath.pilot).to.deep.equal(b.medianPath.pilot);
  });

  it("never proposes a trade the vault's rules would reject", () => {
    for (const goal of ["retiring soon, keep it safe", "balanced", "aggressive, high risk"]) {
      expect(backtest(options(goal, { paths: 25 })).rejected, goal).to.equal(0);
    }
  });

  it("keeps the portfolio near its targets, while holding lets it concentrate", () => {
    const r = backtest(options("aggressive, high risk"));
    // Aggressive preset: 23.75% per stock, ±10% band. The pilot keeps every stock under its band edge.
    expect(r.pilot.maxConcentrationPct.p95).to.be.below(23.75 + 10 + 0.5);
    expect(r.hold.maxConcentrationPct.p95).to.be.above(r.pilot.maxConcentrationPct.p95);
    expect(r.tradesPerYear).to.be.above(0);
  });

  it("does nothing when prices do not move", () => {
    const flat = options("balanced", { assets: modelsFor(LISTINGS).map((a) => ({ ...a, vol: 0, drift: 0 })), paths: 3 });
    const r = backtest(flat);
    expect(r.tradesPerYear).to.equal(0);
    expect(r.pilot.finalValue.p50).to.be.closeTo(r.hold.finalValue.p50, 0.01);
  });

  it("charges the management fee", () => {
    const base = options("balanced", { assets: modelsFor(LISTINGS).map((a) => ({ ...a, vol: 0, drift: 0 })), paths: 1 });
    const free = backtest(base);
    const paid = backtest({ ...base, feeBps: 100 });
    expect(paid.feesUsdPerYear).to.be.closeTo(100, 2); // 1% of $10,000
    expect(free.pilot.finalValue.p50 - paid.pilot.finalValue.p50).to.be.closeTo(100, 2);
  });

  it("measures drawdowns and percentiles correctly", () => {
    expect(maxDrawdown([100, 120, 90, 130, 117])).to.be.closeTo(0.25, 1e-12);
    expect(percentiles([5, 1, 4, 2, 3])).to.deep.equal({ p5: 1, p50: 3, p95: 5 });
  });

  it("produces one value per day for both strategies", () => {
    const o = options("balanced", { days: 30 });
    const r = runPath(o, simulatePrices(o.assets, 30, rng(1)));
    expect(r.pilot).to.have.length(31);
    expect(r.hold).to.have.length(31);
  });
});
