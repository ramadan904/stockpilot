import hre from "hardhat";
import { expect } from "chai";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers";
import { getAddress, parseEventLogs, parseUnits, zeroAddress, type Address } from "viem";
import { DEFAULT_LIMITS, deployStockPilot, px, usd } from "./fixture";

const shares = (n: number | string) => parseUnits(String(n), 18);

describe("PilotFund: one vault, many owners", () => {
  async function deployFund() {
    const f = await deployStockPilot();
    const [, , , alice, bob] = await hre.viem.getWalletClients();
    const funds = await hre.viem.deployContract("PilotFundFactory", [f.factory.address]);
    const cfg = { pilot: f.pilot.account.address, adapter: f.mm.address, assets: f.mandate, limits: DEFAULT_LIMITS, feeRecipient: zeroAddress, feeBps: 0 };
    await f.publicClient.waitForTransactionReceipt({ hash: await funds.write.createFund(["House Fund", "HOUSE", cfg]) });
    const [fundAddress] = await funds.read.funds();
    const fund = await hre.viem.getContractAt("PilotFund", fundAddress);
    const vault = await hre.viem.getContractAt("PilotVault", await fund.read.vault());
    const as = (who: typeof alice) => hre.viem.getContractAt("PilotFund", fundAddress, { client: { wallet: who } });

    /** Mint `amount` of `token` to `who` and buy fund shares with it. */
    async function buy(who: typeof alice, token: typeof f.usdg, amount: bigint, minShares = 0n) {
      await token.write.mint([who.account.address, amount]);
      const t = await hre.viem.getContractAt("MockERC20", token.address, { client: { wallet: who } });
      await t.write.approve([fundAddress, amount]);
      return (await as(who)).write.buy([token.address, amount, minShares]);
    }
    return { ...f, alice, bob, funds, fund, vault, as, buy, cfg };
  }

  it("owns a genuine StockPilot vault, flown by its pilot under a mandate no one can change", async () => {
    const f = await loadFixture(deployFund);
    expect(getAddress(await f.vault.read.owner())).to.equal(getAddress(f.fund.address));
    expect(await f.factory.read.vaultsOf([f.fund.address])).to.deep.equal([f.vault.address]);
    expect(await f.funds.read.isFund([f.fund.address])).to.equal(true);
    expect(getAddress(await f.fund.read.manager())).to.equal(getAddress(f.owner.account.address));
    expect(getAddress(await f.vault.read.pilot())).to.equal(getAddress(f.pilot.account.address));
    // The fund exposes no way to change the mandate, fee, venue, heir or owner, or to move funds other than redeem.
    const names = f.fund.abi.filter((x) => x.type === "function").map((x) => x.name);
    for (const banned of ["setMandate", "setFee", "setAdapter", "setHeir", "withdraw", "transferOwnership", "setGlidePath", "setCrashGuard"]) {
      expect(names).not.to.include(banned);
    }
    // And no one reaches the vault's owner powers around the fund.
    const vaultAsStranger = await hre.viem.getContractAt("PilotVault", f.vault.address, { client: { wallet: f.stranger } });
    await expect(vaultAsStranger.write.withdraw([f.usdg.address, 1n, f.stranger.account.address])).to.be.rejectedWith("OwnableUnauthorizedAccount");
  });

  it("sells shares at the vault's value per share: the first dollar is one share, later buyers pay the going rate", async () => {
    const f = await loadFixture(deployFund);
    await f.buy(f.alice, f.usdg, parseUnits("1000", 6));
    await f.buy(f.alice, f.tsla, parseUnits("4", 18)); // $1,000 at $250
    expect(await f.fund.read.balanceOf([f.alice.account.address])).to.equal(shares(2000));
    expect(await f.fund.read.navPerShare()).to.equal(usd(1));

    await f.tslaFeed.write.setPrice([px(500)]); // TSLA doubles: $3,000 for 2,000 shares
    expect(await f.fund.read.navPerShare()).to.equal(usd(1.5));
    const [quoted, value] = await f.fund.read.quote([f.usdg.address, parseUnits("300", 6)]);
    expect([quoted, value]).to.deep.equal([shares(200), usd(300)]);
    const hash = await f.buy(f.bob, f.usdg, parseUnits("300", 6), quoted);
    const [bought] = parseEventLogs({ abi: f.fund.abi, logs: (await f.publicClient.getTransactionReceipt({ hash })).logs, eventName: "Bought" });
    expect(bought.args).to.include({ token: getAddress(f.usdg.address), valueUsd: usd(300), shares: shares(200) });
    expect(await f.fund.read.balanceOf([f.bob.account.address])).to.equal(shares(200));
    // The money went into the vault, where the mandate governs it.
    expect(await f.usdg.read.balanceOf([f.vault.address])).to.equal(parseUnits("1300", 6));
    expect(await f.usdg.read.balanceOf([f.fund.address])).to.equal(0n);
  });

  it("lets any holder leave with their exact share of every holding, even paused and with stale prices", async () => {
    const f = await loadFixture(deployFund);
    await f.buy(f.alice, f.usdg, parseUnits("1000", 6));
    await f.buy(f.alice, f.tsla, parseUnits("4", 18));
    await f.buy(f.bob, f.usdg, parseUnits("1000", 6));
    await f.fund.write.pause();
    await time.increase(DEFAULT_LIMITS.maxPriceAge + 1); // TSLA's price is stale now

    await (await f.as(f.bob)).write.redeem([shares(1000), f.bob.account.address]); // a third of 3,000 shares
    expect(await f.usdg.read.balanceOf([f.bob.account.address])).to.equal(parseUnits("2000", 6) / 3n);
    expect(await f.tsla.read.balanceOf([f.bob.account.address])).to.equal(parseUnits("4", 18) / 3n);
    expect(await f.fund.read.totalSupply()).to.equal(shares(2000));

    // Buying needs fresh prices and an unpaused vault; leaving needs neither.
    await expect(f.buy(f.bob, f.usdg, parseUnits("10", 6))).to.be.rejectedWith("FundPaused");
    await f.fund.write.unpause();
    await expect(f.buy(f.bob, f.usdg, parseUnits("10", 6))).to.be.rejectedWith("StalePrice");
    await expect((await f.as(f.bob)).write.redeem([shares(1), f.bob.account.address])).to.be.rejectedWith("ERC20InsufficientBalance");
  });

  it("refuses purchases that would cost the holders: unknown assets, dust, and fewer shares than asked", async () => {
    const f = await loadFixture(deployFund);
    const other = await hre.viem.deployContract("MockERC20", ["Other", "OTH", 18]);
    await expect(f.buy(f.alice, other, shares(10))).to.be.rejectedWith("NotInMandate");
    await expect(f.buy(f.alice, f.usdg, parseUnits("0.99", 6))).to.be.rejectedWith("PurchaseTooSmall");
    await expect(f.buy(f.alice, f.usdg, 0n)).to.be.rejectedWith("ZeroAmount");
    await expect(f.buy(f.alice, f.usdg, parseUnits("100", 6), shares(101))).to.be.rejectedWith("TooFewShares");
  });

  it("an early buyer cannot steal from the next one by donating to the vault", async () => {
    const f = await loadFixture(deployFund);
    // A gift before the first purchase belongs to the first buyer, so the fund can never be bricked by one.
    await f.usdg.write.mint([f.owner.account.address, parseUnits("50", 6)]);
    await f.usdg.write.approve([f.vault.address, parseUnits("50", 6)]);
    await f.vault.write.deposit([f.usdg.address, parseUnits("50", 6)]);
    await f.buy(f.alice, f.usdg, parseUnits("1", 6)); // the attacker: $1 for one share, and the $50 gift
    expect(await f.fund.read.balanceOf([f.alice.account.address])).to.equal(shares(1));
    // Then a huge donation, hoping the victim's shares round down to nothing.
    await f.usdg.write.mint([f.owner.account.address, parseUnits("10000", 6)]);
    await f.usdg.write.approve([f.vault.address, parseUnits("10000", 6)]);
    await f.vault.write.deposit([f.usdg.address, parseUnits("10000", 6)]);

    const [quoted] = await f.fund.read.quote([f.usdg.address, parseUnits("5000", 6)]);
    await f.buy(f.bob, f.usdg, parseUnits("5000", 6), quoted);
    const bobShares = await f.fund.read.balanceOf([f.bob.account.address]);
    await (await f.as(f.bob)).write.redeem([bobShares, f.bob.account.address]);
    // Bob gets his $5,000 back, short by rounding only.
    expect(Number(await f.usdg.read.balanceOf([f.bob.account.address]))).to.be.closeTo(5_000e6, 1);
  });

  it("charges the management fee to everyone who held, never to a buyer for time before they arrived", async () => {
    const f = await loadFixture(deployFund);
    const cfg = { ...f.cfg, feeRecipient: f.stranger.account.address, feeBps: 200 };
    await f.funds.write.createFund(["Fee Fund", "FEE", cfg]);
    const fund = await hre.viem.getContractAt("PilotFund", (await f.funds.read.funds())[1]);
    const asAlice = await hre.viem.getContractAt("PilotFund", fund.address, { client: { wallet: f.alice } });
    const asBob = await hre.viem.getContractAt("PilotFund", fund.address, { client: { wallet: f.bob } });
    const buyIn = async (who: typeof f.alice, c: typeof asAlice) => {
      await f.usdg.write.mint([who.account.address, parseUnits("1000", 6)]);
      await (await hre.viem.getContractAt("MockERC20", f.usdg.address, { client: { wallet: who } })).write.approve([fund.address, parseUnits("1000", 6)]);
      await c.write.buy([f.usdg.address, parseUnits("1000", 6), 0n]);
    };
    await buyIn(f.alice, asAlice);
    await time.increase(365 * 24 * 3600); // a year at 2%: $20 owed by Alice's holding
    for (const [feed, p] of [[f.tslaFeed, 250], [f.aaplFeed, 200], [f.nvdaFeed, 125]] as const) await feed.write.setPrice([px(p)]);
    await buyIn(f.bob, asBob);
    // Bob paid $1,000 into a fund worth $980: his shares are worth his $1,000, not less.
    const nav = await fund.read.navPerShare();
    const bobValue = ((await fund.read.balanceOf([f.bob.account.address])) * nav) / 10n ** 18n;
    expect(Number(bobValue) / 1e18).to.be.closeTo(1000, 0.01);
    expect(Number(await f.usdg.read.balanceOf([f.stranger.account.address])) / 1e6).to.be.closeTo(20, 0.01);
  });

  it("a frozen token never traps the rest of a holder's share", async () => {
    const f = await loadFixture(deployFund);
    const fusd = await hre.viem.deployContract("FreezableERC20");
    const feed = await hre.viem.deployContract("FixedPriceFeed", ["FUSD / USD", 8, px(1)]);
    const cfg = { ...f.cfg, assets: [{ token: fusd.address, feed: feed.address, targetBps: 5000, bandBps: 500 }, { ...f.mandate[1], targetBps: 5000 }] };
    await f.funds.write.createFund(["Frozen", "FRZ", cfg]);
    const fund = await hre.viem.getContractAt("PilotFund", (await f.funds.read.funds())[1], { client: { wallet: f.alice } });
    const vault = await fund.read.vault();
    for (const [token, amount] of [[fusd.address, parseUnits("500", 6)], [f.tsla.address, parseUnits("2", 18)]] as const) {
      const t = await hre.viem.getContractAt("MockERC20", token, { client: { wallet: f.alice } });
      await t.write.mint([f.alice.account.address, amount]);
      await t.write.approve([fund.address, amount]);
      await fund.write.buy([token, amount, 0n]);
    }
    await fusd.write.setFrozen([vault, true]); // the issuer freezes the vault
    const hash = await fund.write.redeem([shares(500), f.alice.account.address]); // half
    expect(await f.tsla.read.balanceOf([f.alice.account.address])).to.equal(parseUnits("1", 18));
    const [skipped] = parseEventLogs({ abi: fund.abi, logs: (await f.publicClient.getTransactionReceipt({ hash })).logs, eventName: "RedemptionSkipped" });
    expect(skipped.args).to.include({ token: getAddress(fusd.address), amount: parseUnits("250", 6) });
  });

  it("the manager can pause, and replace the pilot only after holders have had three days to leave", async () => {
    const f = await loadFixture(deployFund);
    const asAlice = await f.as(f.alice);
    await expect(asAlice.write.pause()).to.be.rejectedWith("NotManager");
    await expect(asAlice.write.proposePilot([f.alice.account.address])).to.be.rejectedWith("NotManager");
    await expect(asAlice.write.applyPilotChange()).to.be.rejectedWith("NoPilotChange");

    await f.fund.write.proposePilot([f.bob.account.address]);
    expect(getAddress(await f.fund.read.pendingPilot())).to.equal(getAddress(f.bob.account.address));
    await expect(asAlice.write.applyPilotChange()).to.be.rejectedWith("NoticeRunning");
    await f.fund.write.cancelPilotChange();
    await expect(asAlice.write.applyPilotChange()).to.be.rejectedWith("NoPilotChange");

    await f.fund.write.proposePilot([f.bob.account.address]);
    await time.increase(3 * 24 * 3600);
    await asAlice.write.applyPilotChange(); // anyone can apply it once due
    expect(getAddress(await f.vault.read.pilot())).to.equal(getAddress(f.bob.account.address));
    expect(await f.fund.read.pilotChangeAt()).to.equal(0n);
  });

  it("the pilot flies the fund's vault under the same mandate as any other", async () => {
    const f = await loadFixture(deployFund);
    await f.buy(f.alice, f.usdg, parseUnits("10000", 6)); // all cash: far from the 25% targets
    const asPilot = await hre.viem.getContractAt("PilotVault", f.vault.address, { client: { wallet: f.pilot } });
    const nvdaOut = (parseUnits("2000", 18) * 99n) / 100n / 125n;
    await asPilot.write.rebalance([f.usdg.address, f.nvda.address, parseUnits("2000", 6), nvdaOut, "0x", ("0x" + "11".repeat(32)) as Address]);
    expect((await f.nvda.read.balanceOf([f.vault.address])) > 0n).to.equal(true);
    await expect(asPilot.write.rebalance([f.usdg.address, f.nvda.address, parseUnits("6000", 6), 0n, "0x", ("0x" + "11".repeat(32)) as Address])).to.be.rejectedWith(
      /TradeTooLarge|CooldownActive/,
    );
  });
});
