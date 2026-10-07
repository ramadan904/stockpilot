import { expect } from "chai";
import { auraLights, vaultMood } from "../agent/mood";
import type { Drift } from "../agent/planner";
import { LISTINGS } from "../agent/listings";

const d = (symbol: string, driftBps: number, bandBps = 500, trigger = 0.5): Drift => ({
  symbol,
  weightBps: 2000 + driftBps,
  targetBps: 2000,
  bandBps,
  driftBps,
  outOfBand: Math.abs(driftBps) > bandBps,
  triggered: Math.abs(driftBps) > bandBps * trigger,
});

describe("Vault mood light", () => {
  it("is calm on target, drifting past the trigger, outside past a band", () => {
    expect(vaultMood([d("AAPL", 100), d("SPY", -100)])).to.deep.equal({ mood: "calm", label: "On target", intensity: 0.2 });
    expect(vaultMood([d("AAPL", 300), d("SPY", -100)]).mood).to.equal("drifting");
    const out = vaultMood([d("AAPL", 600), d("SPY", -100)]);
    expect(out.mood).to.equal("outside");
    expect(out.intensity).to.equal(1.2);
  });

  it("caps intensity, and lets pause and defensive targets outrank drift", () => {
    expect(vaultMood([d("TSLA", 5000)]).intensity).to.equal(1.5);
    expect(vaultMood([d("TSLA", 5000)], { paused: true })).to.deep.equal({ mood: "paused", label: "Paused", intensity: 0 });
    expect(vaultMood([d("TSLA", 600)], { defensive: true }).mood).to.equal("defensive");
    expect(vaultMood([d("TSLA", 600)], { paused: true, defensive: true }).mood).to.equal("paused");
  });

  it("treats a zero band as no drift signal rather than dividing by zero", () => {
    expect(vaultMood([d("USDG", 0, 0)]).intensity).to.equal(0);
  });
});

describe("Portfolio aura", () => {
  it("gives one light per held asset, coloured by listing order, sized by weight", () => {
    const lights = auraLights(
      [
        { symbol: "NVDA", percent: 40 },
        { symbol: "USDG", percent: 10 },
        { symbol: "TSLA", percent: 0 },
        { symbol: "SPY", percent: 50 },
      ],
      LISTINGS,
    );
    expect(lights.map((l) => [l.symbol, l.slot])).to.deep.equal([
      ["USDG", 1],
      ["NVDA", 4],
      ["SPY", 5],
    ]);
    const size = (s: string) => lights.find((l) => l.symbol === s)!.size;
    expect(size("SPY")).to.be.greaterThan(size("NVDA"));
    expect(size("NVDA")).to.be.greaterThan(size("USDG"));
  });

  it("keeps an asset's colour and place when the rest of the draft changes", () => {
    const a = auraLights([{ symbol: "AAPL", percent: 100 }], LISTINGS)[0];
    const b = auraLights([{ symbol: "AAPL", percent: 20 }, { symbol: "USDG", percent: 80 }], LISTINGS).find((l) => l.symbol === "AAPL")!;
    expect([a.slot, a.x, a.y]).to.deep.equal([b.slot, b.x, b.y]);
  });

  it("is dark for an empty draft and ignores assets outside the listing", () => {
    expect(auraLights([], LISTINGS)).to.deep.equal([]);
    expect(auraLights([{ symbol: "XYZ", percent: 100 }], LISTINGS)).to.deep.equal([]);
  });
});
