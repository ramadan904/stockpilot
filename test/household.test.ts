import hre from "hardhat";
import { expect } from "chai";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers";
import { getAddress, parseUnits, type Address } from "viem";
import { combine, readHousehold } from "../agent/household";
import { DEFAULT_LIMITS, deployStockPilot, usd } from "./fixture";

describe("agent/household", () => {
  /**
   * One owner, three vaults: the standard $10,000 one (25% each, crash guard armed); a $2,000 "retirement" vault
   * (USDG and NVDA) gliding toward cash with an heir named; and a third the owner has since handed to someone else.
   */
  async function household() {
    const f = await deployStockPilot();
    const factory = f.factory;
    const create = async () => {
      await factory.write.createVault([f.pilot.account.address, f.mm.address, f.mandate, DEFAULT_LIMITS, f.owner.account.address, 0]);
      const list = await factory.read.vaultsOf([f.owner.account.address]);
      return hre.viem.getContractAt("PilotVault", list[list.length - 1]);
    };
    const fund = async (vault: Address, token: typeof f.usdg, amount: bigint) => {
      await token.write.mint([f.owner.account.address, amount]);
      await token.write.approve([vault, amount]);
      await (await hre.viem.getContractAt("PilotVault", vault)).write.deposit([token.address, amount]);
    };

    await f.vault.write.setCrashGuard([f.usdg.address, 7_000, 2_000]);

    const retirement = await create();
    await fund(retirement.address, f.usdg, parseUnits("1000", 6));
    await fund(retirement.address, f.nvda, parseUnits("8", 18)); // $1,000 at $125
    await retirement.write.setGlidePath([[7_000, 1_000, 1_000, 1_000], BigInt((await time.latest()) + 3_650 * 86_400)]);
    await retirement.write.setHeir([f.stranger.account.address, 365 * 86_400]);

    const given = await create();
    await fund(given.address, f.usdg, parseUnits("500", 6));
    await given.write.transferOwnership([f.stranger.account.address]);
    await (await hre.viem.getContractAt("PilotVault", given.address, { client: { wallet: f.stranger } })).write.acceptOwnership();

    const vaults = await factory.read.vaultsOf([f.owner.account.address]);
    return { ...f, retirement, given, vaults };
  }

  it("reads each vault's goal-relevant status", async () => {
    const f = await loadFixture(household);
    const h = await readHousehold(f.publicClient, f.vault.abi, [...f.vaults], f.owner.account.address);
    expect(h.vaults.map((v) => v.vault)).to.deep.equal(f.vaults.map((v) => getAddress(v)));
    const [standard, retirement, given] = h.vaults;
    expect(standard).to.include({ totalUsd: usd(10_000), stocksBps: 7_500, guard: "armed", heir: null, glide: null, stillYours: true, paused: false });
    expect(retirement.totalUsd).to.equal(usd(2_000));
    expect(retirement.stocksBps).to.equal(5_000);
    expect(retirement.glide?.progress).to.be.lessThan(0.001);
    expect(retirement.heir).to.equal(getAddress(f.stranger.account.address));
    expect(given.stillYours).to.equal(false);
  });

  it("adds up only the vaults still yours: total, combined allocation, share in stocks", async () => {
    const f = await loadFixture(household);
    const h = await readHousehold(f.publicClient, f.vault.abi, [...f.vaults], f.owner.account.address);
    expect(h.totalUsd).to.equal(usd(12_000)); // the vault handed on is shown, not counted
    expect(h.allocation.map((a) => [a.symbol, a.valueUsd])).to.deep.equal([
      ["NVDA", usd(3_500)],
      ["USDG", usd(3_500)],
      ["AAPL", usd(2_500)],
      ["TSLA", usd(2_500)],
    ]);
    expect(h.allocation.reduce((s, a) => s + a.bps, 0)).to.be.within(9_996, 10_000);
    expect(h.stocksBps).to.equal(7_083); // $8,500 of $12,000
  });

  it("leaves out a vault it cannot read rather than failing, and is empty for no vaults", async () => {
    const f = await loadFixture(household);
    const h = await readHousehold(f.publicClient, f.vault.abi, [f.vault.address, f.stranger.account.address], f.owner.account.address);
    expect(h.vaults).to.have.length(1);
    expect(combine([])).to.deep.equal({ vaults: [], totalUsd: 0n, allocation: [], stocksBps: 0 });
  });
});
