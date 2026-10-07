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
    // Untraded: the $12,500 the deposits are worth today, less the share of the vault the withdrawal took (about 8%).
    expect(last.untradedUsd > usd(11_490) && last.untradedUsd < usd(11_510)).to.equal(true);
    // Deposited 10,000 (valued on deposit), withdrew 1,000.
    expect(last.netDepositedUsd).to.equal(usd(9_000));
    // Selling some NVDA after it doubled, at a 0.1% venue cost, left the vault a little under its untraded self.
    expect(last.valueUsd < last.untradedUsd).to.equal(true);
    expect(last.untradedUsd - last.valueUsd < usd(5)).to.equal(true);
    expect(first.time <= last.time).to.equal(true);
  });

  it("is not biased by withdrawing a stock the pilot bought (more than was ever deposited)", async () => {
    const f = await loadFixture(deployStockPilot);
    const decimals = new Map([[f.usdg.address.toLowerCase(), 6], ...[f.tsla, f.aapl, f.nvda].map((t) => [t.address.toLowerCase(), 18] as [string, number])]);
    // NVDA halves: the pilot buys NVDA with USDG, ending with more than the 20 deposited. The owner takes 22 out.
    await f.nvdaFeed.write.setPrice([px(62.5)]);
    for (let i = 0; i < 3; i++) {
      const p = plan(await readVault(f.publicClient, f.vault.abi, f.vault.address));
      if (p.action !== "trade") break;
      await sendTrade(f.publicClient, f.pilot, f.vault.abi, f.vault.address, p.trade);
      await mine(1, { interval: 120 });
    }
    expect((await f.nvda.read.balanceOf([f.vault.address])) > parseUnits("22", 18)).to.equal(true);
    await f.vault.write.withdraw([f.nvda.address, parseUnits("22", 18), f.owner.account.address]); // 20 were deposited
    const last = (await vaultPerformance(f.publicClient as never, f.vault.abi, f.vault.address, decimals, 10)).at(-1)!;
    // Without trades the two would be equal; the pilot's trades at a 0.1% venue cost leave only a few dollars' gap.
    const gap = last.untradedUsd > last.valueUsd ? last.untradedUsd - last.valueUsd : last.valueUsd - last.untradedUsd;
    expect(gap < usd(10)).to.equal(true);
  });

  it("is empty for a vault with no deposits", async () => {
    const f = await loadFixture(deployStockPilot);
    const empty = await vaultPerformance(f.publicClient as never, f.vault.abi, f.factory.address, new Map(), 10);
    expect(empty).to.deep.equal([]);
  });
});
