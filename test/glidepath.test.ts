import { expect } from "chai";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers";
import { readVault, sendTrade } from "../agent/chain";
import { glideEndTargets, glidedTargets, readGlide } from "../agent/glide";
import { plan } from "../agent/planner";
import { DEFAULT_LIMITS, deployStockPilot } from "./fixture";

const DAY = 86_400;

describe("PilotVault glide path", () => {
  /** The standard $10,000 vault (25% each), set to glide to 70% USDG and 10% in each stock over 100 days. */
  async function gliding() {
    const f = await deployStockPilot();
    const start = await time.latest();
    await f.vault.write.setGlidePath([[7_000, 1_000, 1_000, 1_000], BigInt(start + 1 + 100 * DAY)]);
    const targets = async () => (await f.vault.read.portfolio())[0].map((h) => h.targetBps);
    /** Fresh prices at the same levels, after time has passed. */
    const refresh = async () => {
      for (const feed of [f.tslaFeed, f.aaplFeed, f.nvdaFeed]) {
        const [, answer] = await feed.read.latestRoundData();
        await feed.write.setPrice([answer]);
      }
    };
    return { ...f, start: start + 1, targets, refresh };
  }

  it("validates the path, and only the owner sets it", async () => {
    const f = await loadFixture(deployStockPilot);
    const later = BigInt((await time.latest()) + 30 * DAY);
    await expect(f.vault.write.setGlidePath([[7_000, 1_000, 2_000], later])).to.be.rejectedWith("InvalidGlidePath"); // one target per asset
    await expect(f.vault.write.setGlidePath([[7_000, 1_000, 1_000, 900], later])).to.be.rejectedWith("TargetsMustSumTo100Percent");
    await expect(f.vault.write.setGlidePath([[7_000, 1_000, 1_000, 1_000], BigInt(await time.latest())])).to.be.rejectedWith("InvalidGlidePath"); // in the past
    await expect(f.vaultAsPilot.write.setGlidePath([[7_000, 1_000, 1_000, 1_000], later])).to.be.rejectedWith("OwnableUnauthorizedAccount");
  });

  it("moves every target in a straight line, then holds the end targets", async () => {
    const f = await loadFixture(gliding);
    expect(await f.targets()).to.deep.equal([2_500, 2_500, 2_500, 2_500]);
    expect(await f.vault.read.glide([f.usdg.address])).to.deep.equal([2_500, 7_000]);
    await time.increaseTo(f.start + 50 * DAY);
    expect(await f.targets()).to.deep.equal([4_750, 1_750, 1_750, 1_750]);
    await time.increaseTo(f.start + 100 * DAY);
    expect(await f.targets()).to.deep.equal([7_000, 1_000, 1_000, 1_000]);
    await time.increase(365 * DAY);
    expect(await f.targets()).to.deep.equal([7_000, 1_000, 1_000, 1_000]);
  });

  it("the pilot follows it, and the vault judges every trade against where the path has reached", async () => {
    const f = await loadFixture(gliding);
    await time.increaseTo(f.start + 50 * DAY);
    await f.refresh();
    let trades = 0;
    for (let i = 0; i < 20; i++) {
      const p = plan(await readVault(f.publicClient, f.vault.abi, f.vault.address));
      if (p.action === "hold") break;
      expect(p.trade.tokenOut.toLowerCase()).to.equal(f.usdg.address.toLowerCase()); // de-risking only
      const { receipt } = await sendTrade(f.publicClient, f.pilot, f.vault.abi, f.vault.address, p.trade);
      expect(receipt.status).to.equal("success");
      trades++;
      await time.increase(60);
      await f.refresh();
    }
    expect(trades).to.be.greaterThan(0);
    const [holdings] = await f.vault.read.portfolio();
    for (const h of holdings) expect(Math.abs(Number(h.weightBps) - h.targetBps)).to.be.at.most(500 / 2); // within the pilot's trigger
    expect(Number(holdings[0].weightBps)).to.be.greaterThan(4_000);
  });

  it("a crash guard on top: defensive targets scale the glided ones, and the guard must stay above the path", async () => {
    const f = await loadFixture(gliding);
    // USDG glides to 70%: a defensive target at or below that would mean nothing at the end of the path.
    await expect(f.vault.write.setCrashGuard([f.usdg.address, 7_000, 2_000])).to.be.rejectedWith("InvalidSafeTarget");
    await f.vault.write.setCrashGuard([f.usdg.address, 8_000, 2_000]);
    await expect(f.vault.write.setGlidePath([[8_500, 500, 500, 500], BigInt(f.start + 200 * DAY)])).to.be.rejectedWith("InvalidSafeTarget");

    await time.increaseTo(f.start + 50 * DAY);
    await f.refresh();
    await f.vault.write.poke(); // peak
    for (const feed of [f.tslaFeed, f.aaplFeed, f.nvdaFeed]) {
      const [, answer] = await feed.read.latestRoundData();
      await feed.write.setPrice([(answer * 50n) / 100n]);
    }
    await f.vault.write.poke(); // trips
    expect(await f.vault.read.defensive()).to.equal(true);
    // USDG to 80%; each stock keeps its glided share of the rest: 17.5% * 20 / 52.5, rounded down.
    const t = await f.targets();
    expect(t[0]).to.equal(8_000);
    expect(t.slice(1)).to.deep.equal([666, 666, 666]);
  });

  it("ends when turned off or when a new mandate is signed", async () => {
    const f = await loadFixture(gliding);
    await time.increaseTo(f.start + 50 * DAY);
    await f.vault.write.setGlidePath([[], 0n]);
    expect(await f.targets()).to.deep.equal([2_500, 2_500, 2_500, 2_500]);

    await f.vault.write.setGlidePath([[4_000, 2_000, 2_000, 2_000], BigInt((await time.latest()) + 10 * DAY)]);
    await f.vault.write.setMandate([f.mandate.map((m) => ({ ...m, targetBps: 2_500 })), DEFAULT_LIMITS]);
    expect(await f.vault.read.glideEnd()).to.equal(0n);
    await time.increase(20 * DAY);
    expect(await f.targets()).to.deep.equal([2_500, 2_500, 2_500, 2_500]);
  });

  it("a new path starts from wherever the current one has reached, with no jump", async () => {
    const f = await loadFixture(gliding);
    await time.increaseTo(f.start + 50 * DAY);
    await f.vault.write.setGlidePath([[2_500, 2_500, 2_500, 2_500], BigInt(f.start + 150 * DAY)]); // change of plan: back to 25% each
    const t = await f.targets();
    expect(t[0]).to.be.within(4_740, 4_750); // a second later, where the old path was
    expect(await f.vault.read.glide([f.usdg.address])).to.deep.equal([t[0], 2_500]);
  });

  it("setting it is proof of life for inheritance", async () => {
    const f = await loadFixture(deployStockPilot);
    await time.increase(10 * DAY);
    await f.vault.write.setGlidePath([[7_000, 1_000, 1_000, 1_000], BigInt((await time.latest()) + 30 * DAY)]);
    expect(Number(await f.vault.read.lastOwnerActivity())).to.equal(await time.latest());
  });
});

describe("agent/glide", () => {
  it("reproduces the vault's targets exactly, second by second, rounding included", async () => {
    const f = await deployStockPilot();
    const start = (await time.latest()) + 1;
    // Uneven targets and an odd span, so rounding is exercised in both directions.
    await f.vault.write.setGlidePath([[7_333, 1_111, 777, 779], BigInt(start + 97 * DAY + 13)]);
    const tokens = [f.usdg.address, f.tsla.address, f.aapl.address, f.nvda.address];
    const g = await readGlide(f.publicClient, f.vault.abi, f.vault.address, tokens);
    expect(g).to.deep.equal({ start, end: start + 97 * DAY + 13, from: [2_500, 2_500, 2_500, 2_500], to: [7_333, 1_111, 777, 779] });
    for (const at of [1, 2, 7_777, 12 * DAY + 5, 50 * DAY, 96 * DAY + 86_399, 97 * DAY + 13, 200 * DAY]) {
      await time.increaseTo(start + at);
      const onchain = (await f.vault.read.portfolio())[0].map((h) => h.targetBps);
      expect(glidedTargets([2_500, 2_500, 2_500, 2_500], g, start + at), `t+${at}`).to.deep.equal(onchain);
    }
  });

  it("end targets put the safe asset where asked, scale the rest, and always sum to exactly 100%", () => {
    expect(glideEndTargets([2_500, 2_500, 2_500, 2_500], 0, 7_000)).to.deep.equal([7_000, 1_000, 1_000, 1_000]);
    expect(glideEndTargets([1_000, 3_000, 6_000], 0, 4_000)).to.deep.equal([4_000, 2_000, 4_000]);
    for (const [cur, safe, bps] of [[[1_000, 3_333, 3_334, 2_333], 0, 6_500], [[3_000, 1_750, 1_750, 1_750, 1_750], 0, 7_777], [[100, 4_950, 4_950], 2, 9_001]] as const) {
      const out = glideEndTargets([...cur], safe, bps);
      expect(out.reduce((s, x) => s + x, 0)).to.equal(10_000);
      expect(out[safe]).to.equal(bps);
    }
  });
});
