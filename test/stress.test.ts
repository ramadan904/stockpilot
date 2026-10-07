import { expect } from "chai";
import { LISTINGS } from "../agent/listings";
import { defensiveTargets, modelsFor } from "../agent/backtest";
import { presetFor, toMandate } from "../agent/mandate";
import { SCENARIOS, marketLevel, scenarioPrices, stressTest } from "../agent/stress";

const universe = LISTINGS.map((l) => ({ ...l, token: "0x0000000000000000000000000000000000000001" as const, feed: "0x0000000000000000000000000000000000000002" as const, stable: "stable" in l }));
const { mandate } = toMandate(presetFor("balanced", universe), universe, 10_000);
const assets = modelsFor(LISTINGS);
const guard = { safeIndex: 0, safeTargetBps: 7_000, drawdownBps: 1_500 };
const run = (id: string) => stressTest({ assets, mandate, startUsd: 10_000, guard }, SCENARIOS.find((s) => s.id === id)!);

describe("agent/stress", () => {
  it("draws the market through its key points on a log scale", () => {
    const path: [number, number][] = [[0, 1], [10, 0.5], [20, 1]];
    expect(marketLevel(path, 0)).to.equal(1);
    expect(marketLevel(path, 10)).to.be.closeTo(0.5, 1e-12);
    expect(marketLevel(path, 5)).to.be.closeTo(Math.SQRT1_2, 1e-12); // halfway in log terms
    expect(marketLevel(path, 99)).to.equal(1);
  });

  it("is deterministic, and the stablecoin never moves", () => {
    const s = SCENARIOS[0];
    expect(scenarioPrices(s, assets)).to.deep.equal(scenarioPrices(s, assets));
    expect(new Set(scenarioPrices(s, assets)[0])).to.deep.equal(new Set([1]));
  });

  it("uses exactly the vault's defensive targets, rounding included", () => {
    // Same numbers as the contract test: 25% each, USDG to 70% -> 10% for each stock.
    expect(defensiveTargets([2_500, 2_500, 2_500, 2_500], { safeIndex: 0, safeTargetBps: 7_000, drawdownBps: 2_000 })).to.deep.equal([7_000, 1_000, 1_000, 1_000]);
    expect(defensiveTargets([3_000, 1_750, 1_750, 1_750, 1_750], guard)).to.deep.equal([7_000, 750, 750, 750, 750]); // 17.5% * 30/70
    expect(defensiveTargets([1_000, 3_000, 6_000], { safeIndex: 0, safeTargetBps: 5_000, drawdownBps: 2_000 })).to.deep.equal([5_000, 1_666, 3_333]);
  });

  it("never proposes a trade the vault would reject, in any scenario, with or without the guard", () => {
    for (const s of SCENARIOS) expect(run(s.id).rejected, s.id).to.equal(0);
  });

  it("in a long bear market the guard trips and cuts the drawdown", () => {
    const r = run("bear");
    expect(r.guarded.defensiveDay).to.be.a("number");
    expect(r.guarded.maxDrawdownPct).to.be.lessThan(r.hold.maxDrawdownPct - 5);
    expect(r.guarded.finalUsd).to.be.greaterThan(r.hold.finalUsd);
  });

  it("shows the cost too: after a fast V-shaped recovery the guard has locked in the loss", () => {
    const r = run("crash-recovery");
    expect(r.guarded.defensiveDay).to.be.a("number");
    expect(r.guarded.maxDrawdownPct).to.be.lessThan(r.hold.maxDrawdownPct);
    expect(r.guarded.finalUsd).to.be.lessThan(r.hold.finalUsd);
  });

  it("does not trip on a flash crash or a rally, where it changes nothing", () => {
    for (const id of ["flash", "melt-up"]) {
      const r = run(id);
      expect(r.guarded.defensiveDay, id).to.equal(null);
      expect(r.guarded.values, id).to.deep.equal(r.pilot.values);
    }
  });
});

describe("safe target choices", () => {
  it("offers only targets the vault accepts, defaulting to 70% when it can", async () => {
    const { safeTargetChoices } = await import("../agent/backtest");
    expect(safeTargetChoices(30)).to.deep.equal({ options: [50, 60, 70, 80, 90, 100], fallback: 70 });
    expect(safeTargetChoices(75)).to.deep.equal({ options: [80, 90, 100], fallback: 80 });
    expect(safeTargetChoices(95)).to.deep.equal({ options: [100], fallback: 100 });
    expect(safeTargetChoices(100)).to.deep.equal({ options: [], fallback: null });
  });
});
