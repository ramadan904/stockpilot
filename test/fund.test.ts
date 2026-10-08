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

  it("a sponsor can buy shares for someone, who can leave with a signature alone, no gas", async () => {
    const f = await loadFixture(deployFund);
    const [, , , , , carol, relay] = await hre.viem.getWalletClients();
    // The sponsor pays; carol gets the shares.
    await f.usdg.write.mint([relay.account.address, parseUnits("100", 6)]);
    await (await hre.viem.getContractAt("MockERC20", f.usdg.address, { client: { wallet: relay } })).write.approve([f.fund.address, parseUnits("100", 6)]);
    const asRelay = await f.as(relay);
    await asRelay.write.buyFor([carol.account.address, f.usdg.address, parseUnits("100", 6), shares(100)]);
    expect(await f.fund.read.balanceOf([carol.account.address])).to.equal(shares(100));
    expect(await f.fund.read.balanceOf([relay.account.address])).to.equal(0n);

    const sign = async (who: typeof carol, msg: { holder: Address; shares: bigint; to: Address; nonce: bigint; deadline: bigint }) =>
      who.signTypedData({
        account: who.account,
        domain: { name: "House Fund", version: "1", chainId: await f.publicClient.getChainId(), verifyingContract: f.fund.address },
        types: { Redeem: [{ name: "holder", type: "address" }, { name: "shares", type: "uint256" }, { name: "to", type: "address" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
        primaryType: "Redeem",
        message: msg,
      });
    const deadline = BigInt(await time.latest()) + 3600n;
    const msg = { holder: carol.account.address, shares: shares(100), to: carol.account.address, nonce: 0n, deadline };
    const sig = await sign(carol, msg);
    // Only the holder's own signature, for exactly these terms, works.
    await expect(asRelay.write.redeemWithSig([carol.account.address, shares(100), relay.account.address, deadline, sig])).to.be.rejectedWith("InvalidSignature");
    await expect(asRelay.write.redeemWithSig([carol.account.address, shares(100), carol.account.address, deadline, await sign(relay, msg)])).to.be.rejectedWith("InvalidSignature");
    await asRelay.write.redeemWithSig([carol.account.address, shares(100), carol.account.address, deadline, sig]);
    expect(await f.usdg.read.balanceOf([carol.account.address])).to.equal(parseUnits("100", 6));
    expect(await f.fund.read.nonces([carol.account.address])).to.equal(1n);
    // Not twice, and not late.
    await expect(asRelay.write.redeemWithSig([carol.account.address, shares(100), carol.account.address, deadline, sig])).to.be.rejectedWith("InvalidSignature");
    await expect(asRelay.write.redeemWithSig([carol.account.address, 1n, carol.account.address, 1n, sig])).to.be.rejectedWith("SignatureExpired");
  });

  it("the fund relay gives one free trial per wallet a day, and submits only a valid signed redemption", async () => {
    const f = await loadFixture(deployFund);
    const { handleFund } = await import("../agent/api");
    const [, , , , , carol, relay] = await hre.viem.getWalletClients();
    const asRelay = await f.as(relay);
    const relayer = {
      isFund: (fund: Address) => f.funds.read.isFund([fund]),
      async trial(fund: Address, holder: Address) {
        const usdg = await hre.viem.getContractAt("MockERC20", f.usdg.address, { client: { wallet: relay } });
        await usdg.write.mint([relay.account.address, parseUnits("100", 6)]);
        await usdg.write.approve([fund, parseUnits("100", 6)]);
        return asRelay.write.buyFor([holder, f.usdg.address, parseUnits("100", 6), 0n]);
      },
      redeem: (_fund: Address, holder: Address, n: bigint, to: Address, deadline: bigint, sig: `0x${string}`) => asRelay.write.redeemWithSig([holder, n, to, deadline, sig]),
    };
    const trial = { chainId: 31337, fund: f.fund.address, action: "trial", holder: carol.account.address };
    expect((await handleFund({ ...trial, action: "withdraw" }, () => relayer)).status).to.equal(400);
    expect((await handleFund(trial, () => null)).status).to.equal(501);
    expect((await handleFund({ ...trial, fund: f.vault.address }, () => relayer)).status).to.equal(400); // not a fund
    expect((await handleFund(trial, () => relayer)).status).to.equal(200);
    expect(await f.fund.read.balanceOf([carol.account.address])).to.equal(shares(100));
    expect((await handleFund(trial, () => relayer)).status).to.equal(429); // one a day
    expect((await handleFund(trial, () => relayer, Date.now() + 86_500_000)).status).to.equal(200);

    const deadline = BigInt(await time.latest()) + 3600n;
    const signature = await carol.signTypedData({
      account: carol.account,
      domain: { name: "House Fund", version: "1", chainId: 31337, verifyingContract: f.fund.address },
      types: { Redeem: [{ name: "holder", type: "address" }, { name: "shares", type: "uint256" }, { name: "to", type: "address" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
      primaryType: "Redeem",
      message: { holder: carol.account.address, shares: shares(200), to: carol.account.address, nonce: 0n, deadline },
    });
    const redeem = { chainId: 31337, fund: f.fund.address, action: "redeem", holder: carol.account.address, shares: shares(200).toString(), to: carol.account.address, deadline: deadline.toString(), signature };
    expect((await handleFund({ ...redeem, to: relay.account.address }, () => relayer)).status).to.equal(422); // the fund rejects altered terms
    expect((await handleFund(redeem, () => relayer)).status).to.equal(200);
    expect(await f.fund.read.balanceOf([carol.account.address])).to.equal(0n);
    expect(await f.usdg.read.balanceOf([carol.account.address])).to.equal(parseUnits("200", 6));
  });

  describe("holders can fire the pilot", () => {
    const DAY = 24 * 3600;
    /** Let time pass, with the stock feeds updated as a live relayer would keep them. */
    async function later(f: Awaited<ReturnType<typeof deployFund>>, seconds: number) {
      await time.increase(seconds);
      for (const [feed, p] of [[f.tslaFeed, 250], [f.aaplFeed, 200], [f.nvdaFeed, 125]] as const) await feed.write.setPrice([px(p)]);
    }

    it("holders of a majority fire it at once; shares bought for the vote count for nothing", async () => {
      const f = await loadFixture(deployFund);
      const [, , , , , carol, eve] = await hre.viem.getWalletClients();
      await f.buy(f.alice, f.usdg, parseUnits("600", 6));
      await f.buy(f.bob, f.usdg, parseUnits("400", 6));
      await later(f, DAY + 1); // shares vote as they stood a day before the motion

      const asBob = await f.as(f.bob);
      const hash = await asBob.write.startMotion();
      const [started] = parseEventLogs({ abi: f.fund.abi, logs: (await f.publicClient.getTransactionReceipt({ hash })).logs, eventName: "MotionStarted" });
      expect(started.args).to.include({ id: 1n, supply: shares(1000) });
      const [, , passed0, , votes0] = await f.fund.read.motions([1n]);
      expect([passed0, votes0]).to.deep.equal([false, shares(400)]); // 40%: not yet

      // A whale buys in after the record date: no votes, however many shares.
      await f.buy(carol, f.usdg, parseUnits("5000", 6));
      await expect((await f.as(carol)).write.vote([1n])).to.be.rejectedWith("NoVotes");
      // Shares handed on after the record date don't vote twice.
      await expect(asBob.write.vote([1n])).to.be.rejectedWith("AlreadyVoted");
      await (await f.as(f.bob)).write.transfer([eve.account.address, shares(400)]);
      await expect((await f.as(eve)).write.vote([1n])).to.be.rejectedWith("NoVotes");

      const fired = await (await f.as(f.alice)).write.vote([1n]); // 100% of the recorded shares
      const [event] = parseEventLogs({ abi: f.fund.abi, logs: (await f.publicClient.getTransactionReceipt({ hash: fired })).logs, eventName: "PilotFired" });
      expect(getAddress(event.args.pilot)).to.equal(getAddress(f.pilot.account.address));
      expect(await f.vault.read.pilot()).to.equal(zeroAddress);
      const asPilot = await hre.viem.getContractAt("PilotVault", f.vault.address, { client: { wallet: f.pilot } });
      await expect(asPilot.write.rebalance([f.usdg.address, f.nvda.address, parseUnits("100", 6), 0n, "0x", ("0x" + "11".repeat(32)) as Address])).to.be.rejectedWith("NotPilot");
      await expect((await f.as(f.alice)).write.vote([1n])).to.be.rejectedWith("MotionClosed");
      await expect(asBob.write.startMotion()).to.be.rejectedWith("NoPilot");
      // Holders keep every right: leaving still works, and the manager can announce a new pilot, with notice.
      await (await f.as(f.alice)).write.redeem([shares(600), f.alice.account.address]);
      await f.fund.write.proposePilot([f.pilot.account.address]);
    });

    it("a firing also cancels a replacement the manager announced", async () => {
      const f = await loadFixture(deployFund);
      await f.buy(f.alice, f.usdg, parseUnits("1000", 6));
      await later(f, DAY + 1);
      await f.fund.write.proposePilot([f.bob.account.address]);
      await (await f.as(f.alice)).write.startMotion(); // alice alone is a majority: passes as it starts
      expect(await f.vault.read.pilot()).to.equal(zeroAddress);
      expect(await f.fund.read.pendingPilot()).to.equal(zeroAddress);
      await expect((await f.as(f.alice)).write.applyPilotChange()).to.be.rejectedWith("NoPilotChange");
    });

    it("needs 1% held a day before, allows one motion at a time, and a motion lapses after three days", async () => {
      const f = await loadFixture(deployFund);
      const [, , , , , carol] = await hre.viem.getWalletClients();
      await f.buy(f.alice, f.usdg, parseUnits("990", 6));
      await f.buy(f.bob, f.usdg, parseUnits("5", 6)); // 0.5%
      await expect((await f.as(f.alice)).write.startMotion()).to.be.rejectedWith("TooFewSharesToMove"); // bought today
      await later(f, DAY + 1);
      await f.buy(carol, f.usdg, parseUnits("20", 6)); // 2%, but bought today
      await expect((await f.as(f.bob)).write.startMotion()).to.be.rejectedWith("TooFewSharesToMove");
      await expect((await f.as(carol)).write.startMotion()).to.be.rejectedWith("TooFewSharesToMove");

      // A day on, carol's shares have their record and can move a motion.
      await later(f, DAY + 1);
      await (await f.as(carol)).write.startMotion();
      await expect((await f.as(f.bob)).write.startMotion()).to.be.rejectedWith("MotionOpen");
      await (await f.as(f.bob)).write.vote([1n]);
      await later(f, 3 * DAY);
      await expect((await f.as(f.alice)).write.vote([1n])).to.be.rejectedWith("MotionClosed");
      expect(getAddress(await f.vault.read.pilot())).to.equal(getAddress(f.pilot.account.address)); // it lapsed
      await (await f.as(carol)).write.startMotion(); // a new one may start
      expect(await f.fund.read.motionCount()).to.equal(2n);
      await expect((await f.as(f.bob)).write.vote([9n])).to.be.rejectedWith("NoMotion");
    });
  });
});
