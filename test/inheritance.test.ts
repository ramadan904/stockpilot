import hre from "hardhat";
import { expect } from "chai";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers";
import { getAddress, parseUnits, zeroAddress } from "viem";
import { deployStockPilot, px } from "./fixture";

const DAY = 86_400;

describe("PilotVault inheritance", () => {
  async function withHeir() {
    const f = await deployStockPilot();
    const [, , , heir, other] = await hre.viem.getWalletClients();
    const asHeir = await hre.viem.getContractAt("PilotVault", f.vault.address, { client: { wallet: heir } });
    await f.vault.write.setHeir([heir.account.address, 90 * DAY]);
    return { ...f, heir, other, asHeir };
  }

  it("lets the heir take over only after the owner has been inactive for the whole period", async () => {
    const { vault, asHeir, heir, owner, publicClient } = await loadFixture(withHeir);
    expect(getAddress(await vault.read.heir())).to.equal(getAddress(heir.account.address));
    const claimableAt = await vault.read.inheritanceClaimableAt();
    expect(claimableAt).to.equal(BigInt(await time.latest()) + BigInt(90 * DAY));

    await expect(asHeir.write.claimInheritance()).to.be.rejectedWith("OwnerStillActive");
    await time.increaseTo(claimableAt - 2n);
    await expect(asHeir.write.claimInheritance()).to.be.rejectedWith("OwnerStillActive");
    await time.increaseTo(claimableAt);
    const hash = await asHeir.write.claimInheritance();
    await publicClient.waitForTransactionReceipt({ hash });

    expect(getAddress(await vault.read.owner())).to.equal(getAddress(heir.account.address));
    // The heir is now a plain owner: no heir of its own until it names one, and the old owner is out.
    expect(await vault.read.heir()).to.equal(zeroAddress);
    expect(await vault.read.inheritanceClaimableAt()).to.equal(0n);
    await expect(vault.write.withdraw([zeroAddress, 1n, owner.account.address])).to.be.rejectedWith("OwnableUnauthorizedAccount");
    const events = await vault.getEvents.InheritanceClaimed({}, { fromBlock: 0n });
    expect(getAddress(events[0].args.previousOwner!)).to.equal(getAddress(owner.account.address));
  });

  it("the heir inherits a working portfolio and can empty it", async () => {
    const { vault, asHeir, heir, tsla } = await loadFixture(withHeir);
    await time.increase(90 * DAY);
    await asHeir.write.claimInheritance();
    await asHeir.write.withdraw([tsla.address, parseUnits("10", 18), heir.account.address]);
    expect(await tsla.read.balanceOf([heir.account.address])).to.equal(parseUnits("10", 18));
    expect(await tsla.read.balanceOf([vault.address])).to.equal(0n);
  });

  it("every owner action is proof of life and restarts the clock", async () => {
    const f = await loadFixture(withHeir);
    const { vault, asHeir, usdg, owner } = f;
    const actions: [string, () => Promise<unknown>][] = [
      ["checkIn", () => vault.write.checkIn()],
      ["withdraw", () => vault.write.withdraw([usdg.address, 1n, owner.account.address])],
      ["deposit", async () => {
        await usdg.write.mint([owner.account.address, 1n]);
        await usdg.write.approve([vault.address, 1n]);
        return vault.write.deposit([usdg.address, 1n]);
      }],
      ["pause", () => vault.write.pause()],
      ["unpause", () => vault.write.unpause()],
      ["setPilot", () => vault.write.setPilot([f.pilot.account.address])],
      ["setFee", () => vault.write.setFee([zeroAddress, 0])],
      ["setAdapter", () => vault.write.setAdapter([f.mm.address])],
      ["setMandate", () => vault.write.setMandate([f.mandate, { maxTradeUsd: 5_000n * 10n ** 18n, dailyLimitUsd: 20_000n * 10n ** 18n, maxSlippageBps: 100, maxPriceAge: 3_600, cooldown: 60 }])],
    ];
    for (const [name, act] of actions) {
      await time.increase(80 * DAY);
      await f.tslaFeed.write.setPrice([px(250)]); // keep prices fresh for the fee settlement
      await act();
      const at = await vault.read.inheritanceClaimableAt();
      expect(at, name).to.equal(BigInt(await time.latest()) + BigInt(90 * DAY));
      await time.increase(20 * DAY); // 100 days since the setHeir call, but only 20 since this action
      await expect(asHeir.write.claimInheritance(), name).to.be.rejectedWith("OwnerStillActive");
    }
  });

  it("the pilot's activity is not the owner's: a running pilot never keeps the clock alive", async () => {
    const { vault, vaultAsPilot, asHeir, nvdaFeed } = await loadFixture(withHeir);
    await time.increase(89 * DAY);
    await nvdaFeed.write.setPrice([px(200)]);
    await vaultAsPilot.write.pause(); // the pilot's brake
    expect((await vault.read.inheritanceClaimableAt()) <= BigInt(await time.latest()) + BigInt(DAY)).to.equal(true);
    await time.increase(DAY);
    await asHeir.write.claimInheritance();
  });

  it("only the named heir can claim, and the owner can change or revoke the heir at any time", async () => {
    const { vault, asHeir, other, heir } = await loadFixture(withHeir);
    const asOther = await hre.viem.getContractAt("PilotVault", vault.address, { client: { wallet: other } });
    await time.increase(91 * DAY);
    await expect(asOther.write.claimInheritance()).to.be.rejectedWith("NotHeir");

    await vault.write.setHeir([other.account.address, 30 * DAY]); // also proof of life
    await expect(asHeir.write.claimInheritance()).to.be.rejectedWith("NotHeir");
    await vault.write.setHeir([zeroAddress, 0]);
    expect(await vault.read.inactivityPeriod()).to.equal(0);
    await time.increase(4000 * DAY);
    await expect(asOther.write.claimInheritance()).to.be.rejectedWith("NotHeir");
    await expect(asHeir.write.claimInheritance()).to.be.rejectedWith("NotHeir");
    expect(heir.account.address).to.not.equal(other.account.address);
  });

  it("refuses periods outside 30 days to 10 years, the owner as heir, and strangers", async () => {
    const { vault, owner, heir, vaultAsStranger, vaultAsPilot } = await loadFixture(withHeir);
    await expect(vault.write.setHeir([heir.account.address, 30 * DAY - 1])).to.be.rejectedWith("InactivityOutOfRange");
    await expect(vault.write.setHeir([heir.account.address, 3650 * DAY + 1])).to.be.rejectedWith("InactivityOutOfRange");
    await expect(vault.write.setHeir([owner.account.address, 90 * DAY])).to.be.rejectedWith("InvalidHeir");
    await expect(vaultAsStranger.write.setHeir([heir.account.address, 90 * DAY])).to.be.rejectedWith("OwnableUnauthorizedAccount");
    await expect(vaultAsPilot.write.setHeir([heir.account.address, 90 * DAY])).to.be.rejectedWith("OwnableUnauthorizedAccount");
    await expect(vaultAsPilot.write.checkIn()).to.be.rejectedWith("OwnableUnauthorizedAccount");
    await vault.write.setHeir([heir.account.address, 30 * DAY]);
    await vault.write.setHeir([heir.account.address, 3650 * DAY]);
  });

  it("a normal change of owner clears the heir, so the old owner's choice cannot take the vault from the new one", async () => {
    const { vault, asHeir, other } = await loadFixture(withHeir);
    const asOther = await hre.viem.getContractAt("PilotVault", vault.address, { client: { wallet: other } });
    await vault.write.transferOwnership([other.account.address]);
    await asOther.write.acceptOwnership();
    expect(await vault.read.heir()).to.equal(zeroAddress);
    await time.increase(4000 * DAY);
    await expect(asHeir.write.claimInheritance()).to.be.rejectedWith("NotHeir");
  });

  it("claiming cancels a pending two-step transfer the old owner had started", async () => {
    const { vault, asHeir, other } = await loadFixture(withHeir);
    const asOther = await hre.viem.getContractAt("PilotVault", vault.address, { client: { wallet: other } });
    await vault.write.transferOwnership([other.account.address]);
    await time.increase(90 * DAY);
    await asHeir.write.claimInheritance();
    await expect(asOther.write.acceptOwnership()).to.be.rejectedWith("OwnableUnauthorizedAccount");
  });
});
