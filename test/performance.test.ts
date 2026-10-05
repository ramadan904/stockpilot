import { expect } from "chai";
import { loadFixture, mine } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers";
import { parseUnits } from "viem";
import { readVault, sendTrade } from "../agent/chain";
import { plan } from "../agent/planner";
import { sampleBlocks, vaultPerformance } from "../agent/performance";
import { deployStockPilot, px, usd } from "./fixture";

describe("agent/performance", () => {
  it("samples blocks evenly, ends included", () => {
    expect(sampleBlocks(10n, 20n, 3)).to.deep.equal([10n, 15n, 20n]);
    expect(sampleBlocks(10n, 12n, 30)).to.deep.equal([10n, 11n, 12n]); // no duplicates
    expect(sampleBlocks(10n, 10n, 5)).to.deep.equal([10n]);
  });

  it("compares the vault with its deposits left untraded, unaffected by money moving in and out", async () => {
    const f = await loadFixture(deployStockPilot);
    const decimals = new Map([[f.usdg.address.toLowerCase(), 6], ...[f.tsla, f.aapl, f.nvda].map((t) => [t.address.toLowerCase(), 18] as [string, number])]);
    await mine(5);
    // NVDA doubles from $125: the pilot trims it. Then the owner takes out 1,000 USDG.
    await f.nvdaFeed.write.setPrice([px(250)]);
    const p = plan(await readVault(f.publicClient, f.vault.abi, f.vault.address));
    if (p.action !== "trade") throw new Error("expected a trade");
    await sendTrade(f.publicClient, f.pilot, f.vault.abi, f.vault.address, p.trade);
    await f.vault.write.withdraw([f.usdg.address, parseUnits("1000", 6), f.owner.account.address]);
    await mine(5);

    const points = await vaultPerformance(f.publicClient as never, f.vault.abi, f.vault.address, decimals, 10);
    const first = points[0];
    const last = points[points.length - 1];
    expect(points.length).to.be.at.least(5);
    const [, total] = await f.vault.read.portfolio();
    expect(last.valueUsd).to.equal(total);
    // Untraded: 2,500 USDG - 1,000 + 10 TSLA, 12.5 AAPL, 20 NVDA at today's prices = 1,500 + 2,500 + 2,500 + 5,000.
    expect(last.untradedUsd).to.equal(usd(11_500));
    // Deposited 10,000 (valued on deposit), withdrew 1,000.
    expect(last.netDepositedUsd).to.equal(usd(9_000));
    // Selling some NVDA after it doubled, at a 0.1% venue cost, left the vault a little under its untraded self.
    expect(last.valueUsd < last.untradedUsd).to.equal(true);
    expect(last.untradedUsd - last.valueUsd < usd(5)).to.equal(true);
    expect(first.time <= last.time).to.equal(true);
  });

  it("is empty for a vault with no deposits", async () => {
    const f = await loadFixture(deployStockPilot);
    const empty = await vaultPerformance(f.publicClient as never, f.vault.abi, f.factory.address, new Map(), 10);
    expect(empty).to.deep.equal([]);
  });
});
