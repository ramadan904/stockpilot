import hre from "hardhat";
import { expect } from "chai";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers";
import { encodeFunctionData, getAddress, keccak256, parseUnits, toHex, zeroAddress } from "viem";
import { DEFAULT_LIMITS, deployStockPilot, px, usd } from "./fixture";

const NO_ROUTE = "0x" as const;
const WHY = keccak256(toHex("TSLA drifted above its band after a rally; trimming back toward 25%."));

describe("PilotVault", () => {
  describe("setup", () => {
    it("values a mixed-decimals portfolio at oracle prices", async () => {
      const { vault } = await loadFixture(deployStockPilot);
      const [holdings, total] = await vault.read.portfolio();
      expect(total).to.equal(usd(10_000));
      for (const h of holdings) {
        expect(h.valueUsd).to.equal(usd(2_500));
        expect(h.weightBps).to.equal(2500n);
        expect(h.targetBps).to.equal(2500);
      }
    });

    it("is owned by the caller of the factory and registered there", async () => {
      const { vault, factory, owner, pilot, mm } = await loadFixture(deployStockPilot);
      expect(await vault.read.owner()).to.equal(getAddress(owner.account.address));
      expect(await vault.read.pilot()).to.equal(getAddress(pilot.account.address));
      expect(await vault.read.adapter()).to.equal(getAddress(mm.address));
      expect(await vault.read.mandateVersion()).to.equal(1n);
      expect(await factory.read.vaultCount()).to.equal(1n);
      expect(await factory.read.vaultAt([0n])).to.equal(vault.address);
    });
  });

  describe("rebalancing inside the mandate", () => {
    it("lets the pilot trim an asset that rallied out of its band", async () => {
      const { vault, vaultAsPilot, tsla, usdg, tslaFeed, publicClient } = await loadFixture(deployStockPilot);
      await tslaFeed.write.setPrice([px(350)]); // +40%: TSLA is now 3500 / 11000 = 31.8%, outside 25% ± 5%

      const hash = await vaultAsPilot.write.rebalance([
        tsla.address,
        usdg.address,
        parseUnits("2", 18), // $700
        parseUnits("690", 6),
        NO_ROUTE,
        WHY,
      ]);
      await publicClient.waitForTransactionReceipt({ hash });

      const events = await vault.getEvents.Rebalanced();
      expect(events).to.have.length(1);
      expect(events[0].args.rationale).to.equal(WHY);
      expect(events[0].args.valueInUsd).to.equal(usd(700));
      expect(events[0].args.amountOut).to.equal(parseUnits("699.3", 6)); // 0.1% venue fee

      const [holdings] = await vault.read.portfolio();
      const tslaRow = holdings.find((h) => h.token === getAddress(tsla.address))!;
      expect(Number(tslaRow.weightBps)).to.be.within(2500, 3000);
      expect(await vault.read.remainingToday()).to.equal(usd(20_000 - 700));
    });

    it("allows discretionary tilts that stay inside the bands", async () => {
      const { vaultAsPilot, aapl, nvda } = await loadFixture(deployStockPilot);
      // Sell $300 of AAPL for NVDA: AAPL 22%, NVDA ~28%. Both within 25% ± 5%.
      await vaultAsPilot.write.rebalance([aapl.address, nvda.address, parseUnits("1.5", 18), 0n, NO_ROUTE, WHY]);
    });

    it("rejects a trade that concentrates the portfolio", async () => {
      const { vaultAsPilot, aapl, tsla } = await loadFixture(deployStockPilot);
      // Sell $1,000 of AAPL for TSLA: AAPL would fall to 15%, TSLA rise to 35%.
      await expect(
        vaultAsPilot.write.rebalance([aapl.address, tsla.address, parseUnits("5", 18), 0n, NO_ROUTE, WHY]),
      ).to.be.rejectedWith("OutsideBand");
    });

    it("lets an out-of-band asset move partway back, but never overshoot to the other side", async () => {
      const { vaultAsPilot, tsla, usdg, tslaFeed } = await loadFixture(deployStockPilot);
      await tslaFeed.write.setPrice([px(500)]); // TSLA 5000 / 12500 = 40%, USDG 20%

      // Too far: selling $3,000 of TSLA leaves it at 16% (under 20%) and puts USDG at 44%.
      await expect(
        vaultAsPilot.write.rebalance([tsla.address, usdg.address, parseUnits("6", 18), 0n, NO_ROUTE, WHY]),
      ).to.be.rejectedWith("OutsideBand");

      // A small step toward target is fine even though TSLA is still outside its band afterwards.
      await vaultAsPilot.write.rebalance([tsla.address, usdg.address, parseUnits("1", 18), 0n, NO_ROUTE, WHY]);
    });

    it("lets the pilot fully exit an asset whose target is zero", async () => {
      const { vault, vaultAsPilot, owner, mandate, tsla, usdg } = await loadFixture(deployStockPilot);
      const exitTsla = mandate.map((m) =>
        m.token === tsla.address
          ? { ...m, targetBps: 0, bandBps: 0 }
          : m.token === usdg.address
            ? { ...m, targetBps: 5000, bandBps: 2500 }
            : m,
      );
      await vault.write.setMandate([exitTsla, { ...DEFAULT_LIMITS, cooldown: 0 }], { account: owner.account });
      await vaultAsPilot.write.rebalance([tsla.address, usdg.address, parseUnits("10", 18), 0n, NO_ROUTE, WHY]);
      expect(await tsla.read.balanceOf([vault.address])).to.equal(0n);
    });
  });

  describe("limits", () => {
    it("caps the size of a single trade", async () => {
      const { vault, vaultAsPilot, mandate, tsla, usdg } = await loadFixture(deployStockPilot);
      await vault.write.setMandate([wide(mandate), { ...DEFAULT_LIMITS, maxTradeUsd: usd(500) }]);
      await expect(
        vaultAsPilot.write.rebalance([tsla.address, usdg.address, parseUnits("2.1", 18), 0n, NO_ROUTE, WHY]),
      ).to.be.rejectedWith("TradeTooLarge");
      await vaultAsPilot.write.rebalance([tsla.address, usdg.address, parseUnits("2", 18), 0n, NO_ROUTE, WHY]);
    });

    it("caps daily volume and resets it the next day", async () => {
      const { vault, vaultAsPilot, mandate, aapl, nvda, tslaFeed, aaplFeed, nvdaFeed } =
        await loadFixture(deployStockPilot);
      const feeds = [tslaFeed, aaplFeed, nvdaFeed];
      await vault.write.setMandate([wide(mandate), { ...DEFAULT_LIMITS, dailyLimitUsd: usd(1_000), cooldown: 0 }]);
      await time.increaseTo(Math.ceil((await time.latest()) / 86_400) * 86_400 + 60); // start of a fresh day
      await refresh(feeds);

      await vaultAsPilot.write.rebalance([aapl.address, nvda.address, parseUnits("3", 18), 0n, NO_ROUTE, WHY]); // $600
      await expect(
        vaultAsPilot.write.rebalance([aapl.address, nvda.address, parseUnits("2.5", 18), 0n, NO_ROUTE, WHY]), // $500
      ).to.be.rejectedWith("DailyLimitExceeded");
      await vaultAsPilot.write.rebalance([aapl.address, nvda.address, parseUnits("2", 18), 0n, NO_ROUTE, WHY]); // $400
      expect(await vault.read.remainingToday()).to.equal(0n);

      await time.increase(86_400);
      await refresh(feeds);
      expect(await vault.read.remainingToday()).to.equal(usd(1_000));
      await vaultAsPilot.write.rebalance([aapl.address, nvda.address, parseUnits("2.5", 18), 0n, NO_ROUTE, WHY]);
    });

    it("enforces a cooldown between trades", async () => {
      const { vaultAsPilot, aapl, nvda } = await loadFixture(deployStockPilot);
      await vaultAsPilot.write.rebalance([aapl.address, nvda.address, parseUnits("0.5", 18), 0n, NO_ROUTE, WHY]);
      await expect(
        vaultAsPilot.write.rebalance([aapl.address, nvda.address, parseUnits("0.5", 18), 0n, NO_ROUTE, WHY]),
      ).to.be.rejectedWith("CooldownActive");
      await time.increase(60);
      await vaultAsPilot.write.rebalance([aapl.address, nvda.address, parseUnits("0.5", 18), 0n, NO_ROUTE, WHY]);
    });

    it("refuses to trade on stale prices", async () => {
      const { vaultAsPilot, aapl, nvda } = await loadFixture(deployStockPilot);
      await time.increase(3_601);
      await expect(
        vaultAsPilot.write.rebalance([aapl.address, nvda.address, parseUnits("0.5", 18), 0n, NO_ROUTE, WHY]),
      ).to.be.rejectedWith("StalePrice");
    });

    it("rejects fills worse than the slippage cap, measured against the oracle", async () => {
      const { vaultAsPilot, mm, aapl, nvda } = await loadFixture(deployStockPilot);
      await mm.write.setFee([150n]); // venue now pays 1.5% under oracle; the cap is 1%
      await expect(
        vaultAsPilot.write.rebalance([aapl.address, nvda.address, parseUnits("0.5", 18), 0n, NO_ROUTE, WHY]),
      ).to.be.rejectedWith("SlippageExceeded");
    });

    it("rejects assets outside the mandate", async () => {
      const { vaultAsPilot, aapl } = await loadFixture(deployStockPilot);
      const rogue = await hre.viem.deployContract("MockERC20", ["Rogue", "RUG", 18]);
      await expect(
        vaultAsPilot.write.rebalance([aapl.address, rogue.address, 1n, 0n, NO_ROUTE, WHY]),
      ).to.be.rejectedWith("AssetNotInMandate");
    });
  });

  describe("custody", () => {
    it("only the pilot can trade", async () => {
      const { vault, vaultAsStranger, aapl, nvda } = await loadFixture(deployStockPilot);
      for (const v of [vault, vaultAsStranger]) {
        await expect(
          v.write.rebalance([aapl.address, nvda.address, parseUnits("0.5", 18), 0n, NO_ROUTE, WHY]),
        ).to.be.rejectedWith("NotPilot");
      }
    });

    it("the pilot cannot withdraw, rewrite the mandate, or change the venue", async () => {
      const { vaultAsPilot, pilot, mandate, aapl } = await loadFixture(deployStockPilot);
      const to = pilot.account.address;
      await expect(vaultAsPilot.write.withdraw([aapl.address, 1n, to])).to.be.rejectedWith("OwnableUnauthorizedAccount");
      await expect(vaultAsPilot.write.setMandate([mandate, DEFAULT_LIMITS])).to.be.rejectedWith(
        "OwnableUnauthorizedAccount",
      );
      await expect(vaultAsPilot.write.setAdapter([to])).to.be.rejectedWith("OwnableUnauthorizedAccount");
      await expect(vaultAsPilot.write.setPilot([to])).to.be.rejectedWith("OwnableUnauthorizedAccount");
    });

    it("either side can pause; only the owner can unpause; the owner can always withdraw", async () => {
      const { vault, vaultAsPilot, owner, aapl, nvda } = await loadFixture(deployStockPilot);
      await vaultAsPilot.write.pause();
      await expect(
        vaultAsPilot.write.rebalance([aapl.address, nvda.address, parseUnits("0.5", 18), 0n, NO_ROUTE, WHY]),
      ).to.be.rejectedWith("EnforcedPause");
      await expect(vaultAsPilot.write.unpause()).to.be.rejectedWith("OwnableUnauthorizedAccount");

      await vault.write.withdraw([aapl.address, parseUnits("12.5", 18), owner.account.address]);
      expect(await aapl.read.balanceOf([owner.account.address])).to.equal(parseUnits("12.5", 18));

      await vault.write.unpause();
      await vaultAsPilot.write.rebalance([nvda.address, aapl.address, parseUnits("0.5", 18), 0n, NO_ROUTE, WHY]);
    });

    it("revoking the pilot stops it immediately", async () => {
      const { vault, vaultAsPilot, aapl, nvda } = await loadFixture(deployStockPilot);
      await vault.write.setPilot([zeroAddress]);
      await expect(
        vaultAsPilot.write.rebalance([aapl.address, nvda.address, parseUnits("0.5", 18), 0n, NO_ROUTE, WHY]),
      ).to.be.rejectedWith("NotPilot");
    });

    it("ownership cannot be renounced, and transfers take two steps", async () => {
      const { vault, stranger, vaultAsStranger } = await loadFixture(deployStockPilot);
      await expect(vault.read.renounceOwnership()).to.be.rejectedWith("RenounceDisabled");
      await vault.write.transferOwnership([stranger.account.address]);
      expect(await vault.read.pendingOwner()).to.equal(getAddress(stranger.account.address));
      await vaultAsStranger.write.acceptOwnership();
      expect(await vault.read.owner()).to.equal(getAddress(stranger.account.address));
    });
  });

  describe("an adapter that misbehaves", () => {
    async function withHostileAdapter() {
      const f = await deployStockPilot();
      const hostile = await hre.viem.deployContract("HostileAdapter");
      await f.nvda.write.mint([hostile.address, parseUnits("1000", 18)]);
      await f.vault.write.setAdapter([hostile.address]);
      return { ...f, hostile };
    }

    it("is judged by what arrives, not what it claims", async () => {
      const { vaultAsPilot, hostile, aapl, nvda } = await loadFixture(withHostileAdapter);
      await hostile.write.configure([1, 0n, "0x"]); // LieAboutOutput
      await expect(
        vaultAsPilot.write.rebalance([aapl.address, nvda.address, parseUnits("1", 18), 1n, NO_ROUTE, WHY]),
      ).to.be.rejectedWith("InsufficientOutput");
      await expect(
        vaultAsPilot.write.rebalance([aapl.address, nvda.address, parseUnits("1", 18), 0n, NO_ROUTE, WHY]),
      ).to.be.rejectedWith("SlippageExceeded");
    });

    it("cannot re-enter the vault", async () => {
      const { vaultAsPilot, hostile, aapl, nvda } = await loadFixture(withHostileAdapter);
      const reentry = encodeFunctionData({
        abi: vaultAsPilot.abi,
        functionName: "deposit",
        args: [nvda.address, 1n],
      });
      await hostile.write.configure([2, parseUnits("1.6", 18), reentry]); // Reenter
      await expect(
        vaultAsPilot.write.rebalance([aapl.address, nvda.address, parseUnits("1", 18), 0n, NO_ROUTE, WHY]),
      ).to.be.rejectedWith("ReentrancyGuardReentrantCall");
    });

    it("an honest fill through the same adapter goes through", async () => {
      const { vaultAsPilot, hostile, aapl, nvda } = await loadFixture(withHostileAdapter);
      await hostile.write.configure([0, parseUnits("1.6", 18), "0x"]); // $200 of AAPL for $200 of NVDA
      await vaultAsPilot.write.rebalance([aapl.address, nvda.address, parseUnits("1", 18), 0n, NO_ROUTE, WHY]);
    });
  });

  describe("mandate validation", () => {
    it("rejects malformed mandates", async () => {
      const { vault, mandate } = await loadFixture(deployStockPilot);
      const set = (m: typeof mandate, l = DEFAULT_LIMITS) => vault.write.setMandate([m, l]);

      await expect(set([])).to.be.rejectedWith("EmptyMandate");
      await expect(set(mandate.map((m) => ({ ...m, targetBps: 2000 })))).to.be.rejectedWith(
        "TargetsMustSumTo100Percent",
      );
      await expect(set([mandate[0], { ...mandate[0] }, mandate[2], mandate[3]])).to.be.rejectedWith("DuplicateAsset");
      await expect(set(mandate.map((m) => ({ ...m, bandBps: 5001 })))).to.be.rejectedWith("BandTooWide");
      await expect(set([{ ...mandate[0], feed: zeroAddress }, ...mandate.slice(1)])).to.be.rejectedWith(
        "ZeroAddress",
      );
      await expect(set(mandate, { ...DEFAULT_LIMITS, maxSlippageBps: 1001 })).to.be.rejectedWith(
        "SlippageCapTooHigh",
      );
      await expect(set(mandate, { ...DEFAULT_LIMITS, dailyLimitUsd: 0n })).to.be.rejectedWith("ZeroLimit");

      const nine = await Promise.all(
        Array.from({ length: 9 }, (_, i) => hre.viem.deployContract("MockERC20", [`T${i}`, `T${i}`, 18])),
      );
      const tooMany = nine.map((t, i) => ({
        token: t.address,
        feed: mandate[1].feed,
        targetBps: i === 0 ? 2000 : 1000,
        bandBps: 0,
      }));
      await expect(set(tooMany)).to.be.rejectedWith("TooManyAssets");
    });

    it("replaces the whole asset list and bumps the version", async () => {
      const { vault, vaultAsPilot, mandate, tsla, usdg } = await loadFixture(deployStockPilot);
      await vault.write.setMandate([
        [
          { ...mandate[0], targetBps: 5000 },
          { ...mandate[2], targetBps: 5000 },
        ],
        DEFAULT_LIMITS,
      ]);
      expect(await vault.read.mandateVersion()).to.equal(2n);
      expect(await vault.read.tokens()).to.deep.equal([getAddress(mandate[0].token), getAddress(mandate[2].token)]);
      await expect(
        vaultAsPilot.write.rebalance([tsla.address, usdg.address, parseUnits("1", 18), 0n, NO_ROUTE, WHY]),
      ).to.be.rejectedWith("AssetNotInMandate");
    });
  });
});

/** Same targets, bands wide enough that only the limit under test can bind. */
function wide<T extends { bandBps: number }>(mandate: T[]): T[] {
  return mandate.map((m) => ({ ...m, bandBps: 5000 }));
}

type Feed = { read: { latestRoundData: () => Promise<readonly [bigint, bigint, bigint, bigint, bigint]> }; write: { setPrice: (a: [bigint]) => Promise<unknown> } };

/** Re-publish each mock feed's current price, so it is fresh again after the clock moved. */
async function refresh(feeds: Feed[]) {
  for (const feed of feeds) {
    const [, answer] = await feed.read.latestRoundData();
    await feed.write.setPrice([answer]);
  }
}
