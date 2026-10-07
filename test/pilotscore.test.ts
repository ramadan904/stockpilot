import hre from "hardhat";
import { expect } from "chai";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers";
import { parseUnits, type Address } from "viem";
import { readVault, sendTrade } from "../agent/chain";
import { pilotScores } from "../agent/pilots";
import { plan } from "../agent/planner";
import { DEFAULT_LIMITS, deployStockPilot, px } from "./fixture";

describe("agent/pilots: value added, after fees, against what each pilot inherited", () => {
  /** Vault A flown by `pilot` through NVDA's round trip ($125 -> $200 -> $125); vault B by an idle pilot. */
  async function market() {
    const f = await deployStockPilot();
    const [, , , owner2, idle] = await hre.viem.getWalletClients();
    const factory = await hre.viem.getContractAt("PilotVaultFactory", f.factory.address, { client: { wallet: owner2 } });
    await factory.write.createVault([idle.account.address, f.mm.address, f.mandate, DEFAULT_LIMITS, owner2.account.address, 0]);
    const [b] = await f.factory.read.vaultsOf([owner2.account.address]);
    for (const [t, amt] of [[f.usdg, parseUnits("2500", 6)], [f.tsla, parseUnits("10", 18)], [f.aapl, parseUnits("12.5", 18)], [f.nvda, parseUnits("20", 18)]] as const) {
      await t.write.mint([owner2.account.address, amt]);
      await (await hre.viem.getContractAt("MockERC20", t.address, { client: { wallet: owner2 } })).write.approve([b, amt]);
      await (await hre.viem.getContractAt("PilotVault", b, { client: { wallet: owner2 } })).write.deposit([t.address, amt]);
    }
    const refresh = async () => {
      for (const feed of [f.tslaFeed, f.aaplFeed, f.nvdaFeed]) {
        const [, answer] = await feed.read.latestRoundData();
        await feed.write.setPrice([answer]);
      }
    };
    const fly = async () => {
      for (let i = 0; i < 20; i++) {
        const p = plan(await readVault(f.publicClient, f.vault.abi, f.vault.address));
        if (p.action === "hold") return;
        await sendTrade(f.publicClient, f.pilot, f.vault.abi, f.vault.address, p.trade);
        await time.increase(60);
        await refresh();
      }
    };
    await time.increase(86_400);
    await f.nvdaFeed.write.setPrice([px(200)]);
    await refresh();
    await fly();
    await time.increase(86_400);
    await f.nvdaFeed.write.setPrice([px(125)]);
    await refresh();
    await fly();
    const score = (pilots: Address[]) => pilotScores(f.publicClient, { factory: f.factory.abi, vault: f.vault.abi }, f.factory.address, pilots, 400);
    return { ...f, b, idle, score };
  }

  it("credits the pilot that sold the rally: value added after fees, and a shallower fall than holding", async () => {
    const f = await loadFixture(market);
    const s = (await f.score([f.pilot.account.address, f.idle.account.address])).get(f.pilot.account.address.toLowerCase())!;
    expect(s.vaults).to.equal(1);
    expect(s.addedBps).to.be.greaterThan(50); // it sold NVDA high and holds less of it after the fall
    expect(s.worstFallPct).to.be.lessThan(s.untradedWorstFallPct);
    expect(s.untradedWorstFallPct).to.be.closeTo(((11_500 - 10_000) / 11_500) * 100, 0.01); // $11,500 at the peak, $10,000 after
    expect(s.vaultDays).to.be.greaterThan(1.9);
  });

  it("an idle pilot added exactly nothing, and fell exactly as much as holding", async () => {
    const f = await loadFixture(market);
    const s = (await f.score([f.idle.account.address])).get(f.idle.account.address.toLowerCase())!;
    expect(s.vaults).to.equal(1);
    expect(s.addedBps).to.equal(0);
    expect(s.worstFallPct).to.equal(s.untradedWorstFallPct);
  });

  it("a vault's record moves to its new pilot, scored only from what it took over", async () => {
    const f = await loadFixture(market);
    await f.vault.write.setPilot([f.idle.account.address]);
    const scores = await f.score([f.pilot.account.address, f.idle.account.address]);
    expect(scores.get(f.pilot.account.address.toLowerCase())).to.include({ vaults: 0, addedBps: null });
    const idle = scores.get(f.idle.account.address.toLowerCase())!;
    expect(idle.vaults).to.equal(2);
    expect(idle.addedBps).to.equal(0); // it inherited the rebalanced vault and has done nothing since
  });
});
