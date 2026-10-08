import { expect } from "chai";
import { MAX_HUBS, layoutConstellation, starMood, type StarVault } from "../agent/constellation";

const vault = (i: number, pilot: string | null, valueUsd = 1_000): StarVault => ({
  vault: `0x${i.toString(16).padStart(40, "0")}`,
  pilot,
  valueUsd,
  fund: false,
  mood: "calm",
  slices: [{ symbol: "USDG", share: 1 }],
  recent: false,
});

describe("The network constellation", () => {
  const size = { width: 800, height: 480 };

  it("gives every pilot a star, sets its vaults in orbit around it, and keeps every orb on the canvas", () => {
    const vaults = [...Array.from({ length: 25 }, (_, i) => vault(i, "0xA", 1_000 + i * 100)), ...Array.from({ length: 4 }, (_, i) => vault(100 + i, "0xB")), vault(200, null)];
    const { hubs, placed } = layoutConstellation(vaults, size);
    expect(hubs.map((h) => h.pilot)).to.deep.equal(["0xA", "0xB"]); // the larger pilot first
    expect(hubs[0].vaults).to.equal(25);
    expect(placed).to.have.length(vaults.length);
    for (const p of placed) {
      expect(Number.isFinite(p.x) && Number.isFinite(p.y)).to.equal(true);
      expect(p.x - p.r).to.be.at.least(0);
      expect(p.x + p.r).to.be.at.most(size.width);
      expect(p.y - p.r).to.be.at.least(0);
      expect(p.y + p.r).to.be.at.most(size.height);
    }
    expect(placed.find((p) => p.pilot === null)!.hub).to.equal(-1);
    // The biggest vault gets the biggest orb.
    const biggest = placed.filter((p) => p.pilot === "0xA").sort((a, b) => b.valueUsd - a.valueUsd)[0];
    expect(biggest.r).to.equal(Math.max(...placed.map((p) => p.r)));
  });

  it("is the same picture for every visitor, whatever order the vaults were read in", () => {
    const vaults = Array.from({ length: 12 }, (_, i) => vault(i, i % 3 === 0 ? "0xA" : "0xB", 500 * (i + 1)));
    const a = layoutConstellation(vaults, size);
    const b = layoutConstellation([...vaults].reverse(), size);
    expect(b.hubs).to.deep.equal(a.hubs);
    const key = (p: { vault: string }) => p.vault;
    expect([...b.placed].sort((x, y) => key(x).localeCompare(key(y)))).to.deep.equal([...a.placed].sort((x, y) => key(x).localeCompare(key(y))));
  });

  it("stars at most a handful of pilots; the vaults of the rest join the outer ring", () => {
    const vaults = Array.from({ length: MAX_HUBS + 3 }, (_, i) => vault(i, `0xP${i}`, 1_000 * (i + 1)));
    const { hubs, placed } = layoutConstellation(vaults, size);
    expect(hubs).to.have.length(MAX_HUBS);
    expect(placed.filter((p) => p.hub === -1)).to.have.length(3);
    expect(layoutConstellation([], size)).to.deep.equal({ hubs: [], placed: [] });
  });

  it("reads a vault's mood from its holdings, as its lamp does", () => {
    const at = (weightBps: number) => [{ weightBps, targetBps: 5_000, bandBps: 500 }];
    expect(starMood(at(5_100), false)).to.equal("calm");
    expect(starMood(at(5_300), false)).to.equal("drifting");
    expect(starMood(at(4_400), false)).to.equal("outside");
    expect(starMood(at(4_400), true)).to.equal("paused");
  });
});
