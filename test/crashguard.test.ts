import hre from "hardhat";
import { expect } from "chai";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers";
import { keccak256, parseUnits, toHex, zeroAddress } from "viem";
import { readVault, sendTrade } from "../agent/chain";
import { plan } from "../agent/planner";
import { DEFAULT_LIMITS, deployStockPilot, px } from "./fixture";

const WHY = keccak256(toHex("test"));

describe("PilotVault crash guard", () => {
  /** The standard $10,000 vault (25% each), guarded: past a 20% drawdown, USDG goes to 70%. */
  async function guarded() {
    const f = await deployStockPilot();
    await f.vault.write.setCrashGuard([f.usdg.address, 7_000, 2_000]);
    await f.vault.write.poke(); // records the $10,000 peak
    const crash = async (pct: number) => {
      for (const feed of [f.tslaFeed, f.aaplFeed, f.nvdaFeed]) {
        const [, answer] = await feed.read.latestRoundData();
        await feed.write.setPrice([(answer * BigInt(100 - pct)) / 100n]);
      }
    };
    const targets = async () => (await f.vault.read.portfolio())[0].map((h) => h.targetBps);
    return { ...f, crash, targets };
  }

  it("validates its settings, and only the owner can set them", async () => {
    const f = await loadFixture(deployStockPilot);
    await expect(f.vault.write.setCrashGuard([f.usdg.address, 7_000, 499])).to.be.rejectedWith("DrawdownOutOfRange");
    await expect(f.vault.write.setCrashGuard([f.usdg.address, 7_000, 5_001])).to.be.rejectedWith("DrawdownOutOfRange");
    await expect(f.vault.write.setCrashGuard([f.usdg.address, 2_500, 2_000])).to.be.rejectedWith("InvalidSafeTarget"); // not above its target
    await expect(f.vault.write.setCrashGuard([f.usdg.address, 10_001, 2_000])).to.be.rejectedWith("InvalidSafeTarget");
    await expect(f.vault.write.setCrashGuard([f.stranger.account.address, 7_000, 2_000])).to.be.rejectedWith("AssetNotInMandate");
    await expect(f.vaultAsPilot.write.setCrashGuard([f.usdg.address, 7_000, 2_000])).to.be.rejectedWith("OwnableUnauthorizedAccount");
    await expect(f.vault.write.poke()).to.be.rejectedWith("CrashGuardOff");
  });

  it("records peaks, and past the drawdown switches to defensive targets", async () => {
    const f = await loadFixture(guarded);
    expect(await f.vault.read.peakValueUsd()).to.equal(10_000n * 10n ** 18n);
    await f.crash(15); // value $8,875: an 11% drawdown, under the 20% trigger
    await f.vault.write.poke();
    expect(await f.vault.read.defensive()).to.equal(false);
    expect(await f.targets()).to.deep.equal([2_500, 2_500, 2_500, 2_500]);

    await f.crash(20); // stocks now at 68% of where they started: value $7,600, a 24% drawdown
    await f.vaultAsStranger.write.poke(); // anyone can pull the trigger
    expect(await f.vault.read.defensive()).to.equal(true);
    // USDG rises to 70%; each stock shrinks from 25% to 25% * 30/75 = 10%.
    expect(await f.targets()).to.deep.equal([7_000, 1_000, 1_000, 1_000]);
    const [entered] = await f.vault.getEvents.DefensiveModeEntered({ fromBlock: 0n });
    expect(entered.args.peakUsd).to.equal(10_000n * 10n ** 18n);
  });

  it("in defensive mode the pilot can only de-risk, and the planner does it step by step", async () => {
    const f = await loadFixture(guarded);
    await f.crash(35);
    await f.vault.write.poke();
    // Buying a stock with USDG would move USDG away from its new 70% target: refused.
    await expect(f.vaultAsPilot.write.rebalance([f.usdg.address, f.tsla.address, parseUnits("100", 6), 0n, "0x", WHY])).to.be.rejectedWith("OutsideBand");
    // The planner sells stocks into USDG, inside the per-trade cap and daily budget, until within the bands.
    let trades = 0;
    for (let i = 0; i < 12; i++) {
      const p = plan(await readVault(f.publicClient, f.vault.abi, f.vault.address));
      if (p.action !== "trade") break;
      expect(p.trade.tokenOut.toLowerCase()).to.equal(f.usdg.address.toLowerCase());
      await sendTrade(f.publicClient, f.pilot, f.vault.abi, f.vault.address, p.trade);
      trades++;
      await time.increase(3_600);
      for (const feed of [f.tslaFeed, f.aaplFeed, f.nvdaFeed]) await feed.write.setPrice([(await feed.read.latestRoundData())[1]]);
    }
    const [holdings] = await f.vault.read.portfolio();
    expect(trades > 0).to.equal(true);
    expect(Number(holdings[0].weightBps)).to.be.within(6_000, 7_500); // USDG near its 70% defensive target
  });

  it("a pilot that never pokes cannot dodge it: a trade past the drawdown is judged on defensive targets", async () => {
    const f = await loadFixture(guarded);
    await f.crash(35); // nobody pokes
    // Under the normal targets this tilt toward TSLA would be allowed; past the drawdown it is not.
    await expect(f.vaultAsPilot.write.rebalance([f.usdg.address, f.tsla.address, parseUnits("100", 6), 0n, "0x", WHY])).to.be.rejectedWith("OutsideBand");
    expect(await f.vault.read.defensive()).to.equal(false); // the reverted attempt changed nothing
    // A de-risking trade goes through, and defensive mode sticks.
    await f.vaultAsPilot.write.rebalance([f.nvda.address, f.usdg.address, parseUnits("2", 18), 0n, "0x", WHY]);
    expect(await f.vault.read.defensive()).to.equal(true);
  });

  it("an owner's withdrawal is not a crash, and a stranger's deposit cannot block the guard", async () => {
    const f = await loadFixture(guarded);
    for (const t of [f.usdg, f.tsla, f.aapl, f.nvda]) await f.vault.write.withdraw([t.address, (await t.read.balanceOf([f.vault.address])) / 2n, f.owner.account.address]);
    await f.vault.write.poke();
    expect(await f.vault.read.defensive()).to.equal(false);
    expect(await f.vault.read.peakValueUsd()).to.equal(5_000n * 10n ** 18n); // re-armed at the new value

    // A stranger tops up USDG: the peak rises with it, and a later crash still trips the guard.
    await f.usdg.write.mint([f.stranger.account.address, parseUnits("1", 6)]);
    const asStrangerToken = await hre.viem.getContractAt("MockERC20", f.usdg.address, { client: { wallet: f.stranger } });
    await asStrangerToken.write.approve([f.vault.address, parseUnits("1", 6)]);
    await f.vaultAsStranger.write.deposit([f.usdg.address, parseUnits("1", 6)]);
    await f.crash(40);
    await f.vaultAsStranger.write.poke();
    expect(await f.vault.read.defensive()).to.equal(true);
  });

  it("only the owner leaves defensive mode; a mandate without the safe asset disarms the guard", async () => {
    const f = await loadFixture(guarded);
    await f.crash(35);
    await f.vault.write.poke();
    await expect(f.vaultAsPilot.write.exitDefensive()).to.be.rejectedWith("OwnableUnauthorizedAccount");
    await expect(f.vaultAsStranger.write.exitDefensive()).to.be.rejectedWith("OwnableUnauthorizedAccount");
    await f.vault.write.exitDefensive();
    expect(await f.targets()).to.deep.equal([2_500, 2_500, 2_500, 2_500]);
    expect(await f.vault.read.peakValueUsd()).to.equal(0n);

    const noUsdg = f.mandate.slice(1).map((m, i) => ({ ...m, targetBps: i === 0 ? 3_334 : 3_333 }));
    await f.vault.write.setMandate([noUsdg, DEFAULT_LIMITS]);
    expect(await f.vault.read.drawdownBps()).to.equal(0);
    expect(await f.vault.read.safeAsset()).to.equal(zeroAddress);
  });

  it("needs fresh prices to judge a crash", async () => {
    const f = await loadFixture(guarded);
    await time.increase(2 * 3_600);
    await expect(f.vault.write.poke()).to.be.rejectedWith("StalePrice");
  });
});

describe("fleet keeper for the crash guard", () => {
  it("records peaks sparingly and trips the guard when due", async () => {
    const { guardAction } = await import("../agent/fleet");
    const W = 10n ** 18n;
    expect(guardAction({ drawdownBps: 0, defensive: false, peakUsd: 0n }, 100n * W)).to.equal(null);
    expect(guardAction({ drawdownBps: 2_000, defensive: false, peakUsd: 0n }, 100n * W)).to.equal("record");
    expect(guardAction({ drawdownBps: 2_000, defensive: false, peakUsd: 100n * W }, 100n * W + W / 2n)).to.equal(null); // under 1% higher
    expect(guardAction({ drawdownBps: 2_000, defensive: false, peakUsd: 100n * W }, 101n * W)).to.equal("record");
    expect(guardAction({ drawdownBps: 2_000, defensive: false, peakUsd: 100n * W }, 80n * W)).to.equal(null); // exactly 20% is not past it
    expect(guardAction({ drawdownBps: 2_000, defensive: false, peakUsd: 100n * W }, 79n * W)).to.equal("trigger");
    expect(guardAction({ drawdownBps: 2_000, defensive: true, peakUsd: 100n * W }, 50n * W)).to.equal(null);
  });

  it("the fleet trips the guard, tells the owner, and starts de-risking in the same tick", async () => {
    const f = await loadFixture(deployStockPilot);
    const { fleetTick, describe: describeEvent } = await import("../agent/fleet");
    await f.vault.write.setCrashGuard([f.usdg.address, 7_000, 2_000]);
    const cfg = { client: f.publicClient as never, wallet: f.pilot as never, vaultAbi: f.vault.abi, factoryAbi: f.factory.abi, factory: f.factory.address };
    expect((await fleetTick(cfg)).map((e) => e.kind)).to.deep.equal(["hold"]); // records the peak quietly
    expect(await f.vault.read.peakValueUsd()).to.equal(10_000n * 10n ** 18n);

    for (const feed of [f.tslaFeed, f.aaplFeed, f.nvdaFeed]) await feed.write.setPrice([((await feed.read.latestRoundData())[1] * 65n) / 100n]);
    const events = await fleetTick(cfg);
    expect(events.map((e) => e.kind)).to.deep.equal(["defensive", "trade"]);
    expect(describeEvent(events[0])).to.match(/^Crash guard: vault 0x.+ is worth \$7,375\.00, 26\.2% below its \$10,000\.00 peak/);
    expect(events[1].kind === "trade" && events[1].rationale).to.match(/USDG/);
  });
});
