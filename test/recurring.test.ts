import hre from "hardhat";
import { expect } from "chai";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers";
import { getAddress, parseUnits, zeroAddress, type Address } from "viem";
import { DEFAULT_LIMITS, deployStockPilot } from "./fixture";

const DAY = 86_400;
const WEEK = 7 * DAY;

describe("PilotVault recurring investment", () => {
  async function weekly() {
    const f = await deployStockPilot();
    await f.vault.write.setRecurringDeposit([f.usdg.address, parseUnits("100", 6), WEEK]);
    await f.usdg.write.mint([f.owner.account.address, parseUnits("1000", 6)]);
    await f.usdg.write.approve([f.vault.address, parseUnits("300", 6)]); // three weeks' worth
    return f;
  }

  it("validates its settings, and only the owner sets them", async () => {
    const f = await loadFixture(deployStockPilot);
    await expect(f.vault.write.setRecurringDeposit([f.stranger.account.address, 1n, WEEK])).to.be.rejectedWith("AssetNotInMandate");
    await expect(f.vault.write.setRecurringDeposit([f.usdg.address, 1n, DAY - 1])).to.be.rejectedWith("IntervalOutOfRange");
    await expect(f.vault.write.setRecurringDeposit([f.usdg.address, 1n, 366 * DAY])).to.be.rejectedWith("IntervalOutOfRange");
    await expect(f.vaultAsPilot.write.setRecurringDeposit([f.usdg.address, 1n, WEEK])).to.be.rejectedWith("OwnableUnauthorizedAccount");
    await expect(f.vault.write.pullRecurringDeposit()).to.be.rejectedWith("RecurringOff");
  });

  it("anyone can pull exactly the set amount when due, once per interval, without catching up", async () => {
    const f = await loadFixture(weekly);
    const before = await f.usdg.read.balanceOf([f.vault.address]);
    await f.vaultAsStranger.write.pullRecurringDeposit(); // the first is due at once
    expect((await f.usdg.read.balanceOf([f.vault.address])) - before).to.equal(parseUnits("100", 6));
    await expect(f.vaultAsStranger.write.pullRecurringDeposit()).to.be.rejectedWith("RecurringNotDue");

    await time.increase(WEEK);
    await f.vaultAsStranger.write.pullRecurringDeposit();
    // Three weeks pass unpulled: one pull, then the next is a full interval away.
    await time.increase(3 * WEEK);
    await f.vaultAsStranger.write.pullRecurringDeposit();
    expect(await f.vault.read.recurringNextAt()).to.equal(BigInt(await time.latest()) + BigInt(WEEK));
    expect((await f.usdg.read.balanceOf([f.vault.address])) - before).to.equal(parseUnits("300", 6));

    const pulls = await f.vault.getEvents.RecurringDepositPulled({}, { fromBlock: 0n });
    expect(pulls).to.have.length(3);
    const deposits = await f.vault.getEvents.Deposited({ from: f.owner.account.address }, { fromBlock: 0n });
    expect(deposits.at(-1)!.args.amount).to.equal(parseUnits("100", 6)); // shows up as an ordinary deposit too
  });

  it("never takes more than the owner allowed, and stops while paused", async () => {
    const f = await loadFixture(weekly);
    for (let i = 0; i < 3; i++) {
      await f.vaultAsStranger.write.pullRecurringDeposit();
      await time.increase(WEEK);
    }
    await expect(f.vaultAsStranger.write.pullRecurringDeposit()).to.be.rejectedWith("ERC20InsufficientAllowance");
    await f.usdg.write.approve([f.vault.address, parseUnits("100", 6)]);
    await f.vault.write.pause();
    await expect(f.vaultAsStranger.write.pullRecurringDeposit()).to.be.rejectedWith("EnforcedPause");
  });

  it("is not proof of life: automated pulls never keep an heir waiting", async () => {
    const f = await loadFixture(weekly);
    const [, , , heir] = await hre.viem.getWalletClients();
    await f.vault.write.setHeir([heir.account.address, 30 * DAY]);
    const claimableAt = await f.vault.read.inheritanceClaimableAt();
    await time.increase(WEEK);
    await f.vaultAsStranger.write.pullRecurringDeposit();
    expect(await f.vault.read.inheritanceClaimableAt()).to.equal(claimableAt);
  });

  it("stops when turned off or when the asset leaves the mandate", async () => {
    const f = await loadFixture(weekly);
    await f.vault.write.setRecurringDeposit([zeroAddress, 0n, 0]);
    await expect(f.vaultAsStranger.write.pullRecurringDeposit()).to.be.rejectedWith("RecurringOff");

    await f.vault.write.setRecurringDeposit([f.usdg.address, parseUnits("100", 6), WEEK]);
    const noUsdg = f.mandate.slice(1).map((m, i) => ({ ...m, targetBps: i === 0 ? 3_334 : 3_333 }));
    await f.vault.write.setMandate([noUsdg, DEFAULT_LIMITS]);
    expect(await f.vault.read.recurringAmount()).to.equal(0n);
  });
});

describe("PilotVault gasless check-in and pause", () => {
  async function signed() {
    const f = await deployStockPilot();
    const chainId = await f.publicClient.getChainId();
    const sign = async (kind: "CheckIn" | "Pause", deadline: bigint, opts: { by?: typeof f.owner; vault?: Address; nonce?: bigint } = {}) =>
      (opts.by ?? f.owner).signTypedData({
        account: (opts.by ?? f.owner).account!,
        domain: { name: "StockPilot Vault", version: "1", chainId, verifyingContract: opts.vault ?? f.vault.address },
        types: { [kind]: [{ name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
        primaryType: kind,
        message: { nonce: opts.nonce ?? (await f.vault.read.sigNonce()), deadline },
      });
    const soon = async () => BigInt(await time.latest()) + 3_600n;
    return { ...f, sign, soon };
  }

  it("a relayed signed check-in restarts the inheritance clock, and works once", async () => {
    const f = await loadFixture(signed);
    const [, , , heir] = await hre.viem.getWalletClients();
    await f.vault.write.setHeir([heir.account.address, 30 * DAY]);
    await time.increase(20 * DAY);
    const deadline = await f.soon();
    const sig = await f.sign("CheckIn", deadline);
    // The pilot (or anyone) submits it and pays the gas.
    await f.vaultAsPilot.write.checkInWithSig([deadline, sig]);
    expect(await f.vault.read.inheritanceClaimableAt()).to.equal(BigInt(await time.latest()) + BigInt(30 * DAY));
    expect(await f.vault.read.sigNonce()).to.equal(1n);
    await expect(f.vaultAsStranger.write.checkInWithSig([deadline, sig])).to.be.rejectedWith("InvalidSignature"); // no replay
  });

  it("a relayed signed pause stops trading; only the owner can resume", async () => {
    const f = await loadFixture(signed);
    const deadline = await f.soon();
    await f.vaultAsStranger.write.pauseWithSig([deadline, await f.sign("Pause", deadline)]);
    expect(await f.vault.read.paused()).to.equal(true);
    await expect(f.vaultAsPilot.write.unpause()).to.be.rejectedWith("OwnableUnauthorizedAccount");
    await f.vault.write.unpause();
  });

  it("refuses expired, mis-typed, someone else's, or another vault's signatures", async () => {
    const f = await loadFixture(signed);
    const deadline = await f.soon();
    await expect(f.vaultAsStranger.write.checkInWithSig([deadline, await f.sign("Pause", deadline)])).to.be.rejectedWith("InvalidSignature");
    await expect(f.vaultAsStranger.write.checkInWithSig([deadline, await f.sign("CheckIn", deadline, { by: f.pilot })])).to.be.rejectedWith("InvalidSignature");
    await expect(f.vaultAsStranger.write.checkInWithSig([deadline, await f.sign("CheckIn", deadline, { vault: f.factory.address })])).to.be.rejectedWith("InvalidSignature");
    await expect(f.vaultAsStranger.write.checkInWithSig([deadline, await f.sign("CheckIn", deadline, { nonce: 5n })])).to.be.rejectedWith("InvalidSignature");
    const past = BigInt(await time.latest()) - 1n;
    await expect(f.vaultAsStranger.write.pauseWithSig([past, await f.sign("Pause", past)])).to.be.rejectedWith("SignatureExpired");
    expect(await f.vault.read.paused()).to.equal(false);
  });

  it("the vault computes the same digest a wallet signs", async () => {
    const f = await loadFixture(signed);
    const { hashTypedData } = await import("viem");
    const deadline = await f.soon();
    const typehash = await f.vault.read.CHECK_IN_TYPEHASH();
    const expected = hashTypedData({
      domain: { name: "StockPilot Vault", version: "1", chainId: await f.publicClient.getChainId(), verifyingContract: getAddress(f.vault.address) },
      types: { CheckIn: [{ name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
      primaryType: "CheckIn",
      message: { nonce: 0n, deadline },
    });
    expect(await f.vault.read.signedActionDigest([typehash, deadline])).to.equal(expected);
  });
});

describe("relaying and keeping", () => {
  it("the relay endpoint submits a valid signed pause and refuses anything else", async () => {
    const f = await deployStockPilot();
    const { handleRelay, cloneCode } = await import("../agent/api");
    const implementation = await f.factory.read.implementation();
    const relayer = {
      // The real check: only a clone of this deployment's vault implementation.
      isVault: async (vault: Address) => (await f.publicClient.getCode({ address: vault }))?.toLowerCase() === cloneCode(implementation),
      send: (vault: Address, fn: "checkInWithSig" | "pauseWithSig", deadline: bigint, sig: `0x${string}`) => f.vaultAsPilot.write[fn]([deadline, sig]),
    };
    const deadline = BigInt(await time.latest()) + 3_600n;
    const signature = await f.owner.signTypedData({
      account: f.owner.account!,
      domain: { name: "StockPilot Vault", version: "1", chainId: await f.publicClient.getChainId(), verifyingContract: f.vault.address },
      types: { Pause: [{ name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
      primaryType: "Pause",
      message: { nonce: 0n, deadline },
    });
    const body = { chainId: 31337, vault: f.vault.address, action: "pause", deadline: deadline.toString(), signature };
    expect((await handleRelay({ ...body, action: "withdraw" }, () => relayer)).status).to.equal(400);
    expect((await handleRelay(body, () => null)).status).to.equal(501);
    const ok = await handleRelay(body, () => relayer);
    expect(ok.status).to.equal(200);
    expect(await f.vault.read.paused()).to.equal(true);
    expect((await handleRelay(body, () => relayer)).status).to.equal(422); // replay refused by the vault
    // A contract that merely has the right function names is not a vault: no gas is spent on it.
    expect((await handleRelay({ ...body, vault: f.mm.address }, () => relayer)).status).to.equal(400);
    // At most three relayed actions per vault an hour (refusals before relaying do not count).
    expect((await handleRelay(body, () => relayer)).status).to.equal(422);
    expect((await handleRelay(body, () => relayer)).status).to.equal(429);
    expect((await handleRelay(body, () => relayer, Date.now() + 3_700_000)).status).to.equal(422); // an hour later the vault itself decides
  });

  it("the fleet pulls a due recurring investment and invests it in the same tick", async () => {
    const f = await deployStockPilot();
    const { fleetTick, describe: describeEvent } = await import("../agent/fleet");
    await f.vault.write.setRecurringDeposit([f.usdg.address, parseUnits("3000", 6), WEEK]);
    await f.usdg.write.mint([f.owner.account.address, parseUnits("3000", 6)]);
    await f.usdg.write.approve([f.vault.address, parseUnits("3000", 6)]);
    const cfg = { client: f.publicClient as never, wallet: f.pilot as never, vaultAbi: f.vault.abi, factoryAbi: f.factory.abi, factory: f.factory.address };
    const events = await fleetTick(cfg);
    expect(events.map((e) => e.kind)).to.deep.equal(["deposit", "trade"]);
    expect(describeEvent(events[0])).to.match(/^Recurring investment: 3,000 USDG moved from the owner's wallet into vault 0x/);
    expect((await fleetTick(cfg)).map((e) => e.kind)).to.not.include("deposit"); // not due again for a week
  });
});

describe("review fixes", () => {
  it("a change of owner stops the old owner's recurring investment, so the new owner's wallet is never pulled", async () => {
    const f = await deployStockPilot();
    const [, , , heir] = await hre.viem.getWalletClients();
    await f.vault.write.setRecurringDeposit([f.usdg.address, parseUnits("100", 6), WEEK]);
    await f.vault.write.setHeir([heir.account.address, 30 * DAY]);
    await time.increase(31 * DAY);
    const asHeir = await hre.viem.getContractAt("PilotVault", f.vault.address, { client: { wallet: heir } });
    await asHeir.write.claimInheritance();
    expect(await f.vault.read.recurringAmount()).to.equal(0n);
    // Even if the heir approves the vault for an ordinary deposit, nobody can pull from their wallet.
    await f.usdg.write.mint([heir.account.address, parseUnits("1000", 6)]);
    const usdgAsHeir = await hre.viem.getContractAt("MockERC20", f.usdg.address, { client: { wallet: heir } });
    await usdgAsHeir.write.approve([f.vault.address, parseUnits("1000", 6)]);
    await expect(f.vaultAsStranger.write.pullRecurringDeposit()).to.be.rejectedWith("RecurringOff");
  });

  it("dropping an asset from the mandate re-arms the crash guard instead of tripping it", async () => {
    const f = await deployStockPilot();
    await f.vault.write.setCrashGuard([f.usdg.address, 7_000, 2_000]);
    await f.vault.write.poke(); // peak $10,000
    // Drop NVDA (25% of the value): the vault now measures $7,500, which must not count as a 25% crash.
    const withoutNvda = f.mandate.slice(0, 3).map((m, i) => ({ ...m, targetBps: i === 0 ? 3_334 : 3_333 }));
    await f.vault.write.setMandate([withoutNvda, DEFAULT_LIMITS]);
    expect(await f.vault.read.peakValueUsd()).to.equal(0n);
    await f.vault.write.poke();
    expect(await f.vault.read.defensive()).to.equal(false);
  });
});

describe("fleet review fixes", () => {
  it("spends no gas on a vault it refuses to serve", async () => {
    const f = await deployStockPilot();
    const { fleetTick } = await import("../agent/fleet");
    await f.vault.write.setRecurringDeposit([f.usdg.address, parseUnits("100", 6), WEEK]);
    await f.usdg.write.mint([f.owner.account.address, parseUnits("100", 6)]);
    await f.usdg.write.approve([f.vault.address, parseUnits("100", 6)]);
    const cfg = { client: f.publicClient as never, wallet: f.pilot as never, vaultAbi: f.vault.abi, factoryAbi: f.factory.abi, factory: f.factory.address, minFeeBps: 50 };
    const before = await f.publicClient.getTransactionCount({ address: f.pilot.account.address });
    expect((await fleetTick(cfg)).map((e) => e.kind)).to.deep.equal(["skip"]);
    expect(await f.publicClient.getTransactionCount({ address: f.pilot.account.address })).to.equal(before);
    expect(await f.vault.read.recurringNextAt()).to.not.equal(0n); // still due: nothing was pulled
  });

  it("reports a failing recurring pull once a day, not on every tick", async () => {
    const f = await deployStockPilot();
    const { fleetTick } = await import("../agent/fleet");
    await f.vault.write.setRecurringDeposit([f.usdg.address, parseUnits("100", 6), WEEK]); // no approval at all
    const cfg = { client: f.publicClient as never, wallet: f.pilot as never, vaultAbi: f.vault.abi, factoryAbi: f.factory.abi, factory: f.factory.address };
    const first = await fleetTick(cfg);
    expect(first.filter((e) => e.kind === "error")).to.have.length(1);
    const second = await fleetTick(cfg);
    expect(second.filter((e) => e.kind === "error")).to.have.length(0);
  });
});
