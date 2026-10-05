import { expect } from "chai";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers";
import { readVault, sendTrade, rationaleHash } from "../agent/chain";
import { plan } from "../agent/planner";
import { deployStockPilot, px, usd } from "./fixture";

type Fixture = Awaited<ReturnType<typeof deployStockPilot>>;

/** Let the pilot run until it holds; return what it did. Every trade it sends must be accepted. */
async function fly(f: Fixture, maxSteps = 20) {
  const trades: string[] = [];
  for (let i = 0; i < maxSteps; i++) {
    const state = await readVault(f.publicClient, f.vault.abi, f.vault.address);
    const p = plan(state);
    if (p.action === "hold") return { trades, hold: p.reason, drift: p.drift };
    const { receipt } = await sendTrade(f.publicClient, f.pilot, f.vault.abi, f.vault.address, p.trade);
    expect(receipt.status).to.equal("success");
    trades.push(p.trade.rationale);
    await time.increase(60); // cooldown
    for (const feed of [f.tslaFeed, f.aaplFeed, f.nvdaFeed]) {
      const [, answer] = await feed.read.latestRoundData();
      await feed.write.setPrice([answer]);
    }
  }
  throw new Error("pilot never settled");
}

describe("agent/planner", () => {
  it("holds while everything is inside its band", async () => {
    const f = await loadFixture(deployStockPilot);
    const p = plan(await readVault(f.publicClient, f.vault.abi, f.vault.address));
    expect(p.action).to.equal("hold");
    expect(p.action === "hold" && p.reason).to.match(/within its rebalancing trigger/);
  });

  it("brings a portfolio back near target after a rally, with only accepted trades", async () => {
    const f = await loadFixture(deployStockPilot);
    await f.nvdaFeed.write.setPrice([px(200)]); // +60%
    await f.tslaFeed.write.setPrice([px(190)]); // -24%
    const run = await fly(f);
    expect(run.trades.length).to.be.greaterThan(0);
    expect(run.hold).to.match(/within its rebalancing trigger/);
    for (const d of run.drift) expect(Math.abs(d.driftBps)).to.be.at.most(d.bandBps / 2);
  });

  it("commits the hash of each rationale onchain", async () => {
    const f = await loadFixture(deployStockPilot);
    await f.nvdaFeed.write.setPrice([px(200)]);
    const run = await fly(f);
    const events = await f.vault.getEvents.Rebalanced({}, { fromBlock: 0n });
    expect(events.map((e) => e.args.rationale)).to.deep.equal(run.trades.map(rationaleHash));
  });

  it("stops at the daily limit and says so", async () => {
    const f = await loadFixture(deployStockPilot);
    await f.vault.write.setMandate([f.mandate, { maxTradeUsd: usd(200), dailyLimitUsd: usd(500), maxSlippageBps: 100, maxPriceAge: 3600, cooldown: 60 }]);
    await time.increaseTo(Math.ceil((await time.latest()) / 86_400) * 86_400 + 60);
    for (const feed of [f.tslaFeed, f.aaplFeed]) {
      const [, answer] = await feed.read.latestRoundData();
      await feed.write.setPrice([answer]);
    }
    await f.nvdaFeed.write.setPrice([px(250)]); // NVDA doubles
    const run = await fly(f);
    expect(run.hold).to.match(/limit is used up/);
    expect(await f.vault.read.remainingToday() < usd(10)).to.equal(true);
  });

  it("will not trade on stale prices or while paused", async () => {
    const f = await loadFixture(deployStockPilot);
    await f.nvdaFeed.write.setPrice([px(200)]);
    await f.vault.write.pause();
    let p = plan(await readVault(f.publicClient, f.vault.abi, f.vault.address));
    expect(p.action === "hold" && p.reason).to.match(/paused/);

    await f.vault.write.unpause();
    await time.increase(3_601);
    p = plan(await readVault(f.publicClient, f.vault.abi, f.vault.address));
    expect(p.action === "hold" && p.reason).to.match(/stale/);
  });
});
