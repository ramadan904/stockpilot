import { expect } from "chai";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers";
import { parseUnits } from "viem";
import { readVault, sendTrade } from "../agent/chain";
import { plan } from "../agent/planner";
import { blockAt, buildStatement, monthsBetween } from "../agent/statement";
import { readTaxEvents, type AssetInfo } from "../agent/tax";
import { deployStockPilot, px, usd } from "./fixture";

describe("agent/statement", () => {
  it("finds the last block at or before a time", async () => {
    const f = await loadFixture(deployStockPilot);
    const t0 = await time.latest();
    await time.increase(1_000);
    await f.usdg.write.mint([f.owner.account.address, 1n]); // a block at t0 + ~1000
    const at = await blockAt(f.publicClient as never, t0 + 500);
    expect(at.time <= t0 + 500).to.equal(true);
    const next = await f.publicClient.getBlock({ blockNumber: at.block + 1n });
    expect(Number(next.timestamp) > t0 + 500).to.equal(true);
  });

  it("reconciles: opening + deposits - withdrawals - fees + markets and trading = closing, all read from the chain", async () => {
    const f = await loadFixture(deployStockPilot);
    const assets = new Map<string, AssetInfo>([
      [f.usdg.address.toLowerCase(), { symbol: "USDG", decimals: 6, cash: true }],
      ...[["TSLA", f.tsla], ["AAPL", f.aapl], ["NVDA", f.nvda]].map(([s, t]) => [(t as typeof f.tsla).address.toLowerCase(), { symbol: s as string, decimals: 18, cash: false }] as [string, AssetInfo]),
    ]);
    await f.vault.write.setFee([f.stranger.account.address, 100]);
    const start = await time.latest();
    await time.increase(86_400);

    // During the period: NVDA rallies, the pilot sells some, the owner adds and takes out money, the fee is paid.
    await f.nvdaFeed.write.setPrice([px(200)]);
    for (const feed of [f.tslaFeed, f.aaplFeed]) await feed.write.setPrice([(await feed.read.latestRoundData())[1]]);
    const p = plan(await readVault(f.publicClient, f.vault.abi, f.vault.address));
    if (p.action !== "trade") throw new Error("expected a trade");
    await sendTrade(f.publicClient, f.pilot, f.vault.abi, f.vault.address, p.trade);
    await f.usdg.write.mint([f.owner.account.address, parseUnits("1000", 6)]);
    await f.usdg.write.approve([f.vault.address, parseUnits("1000", 6)]);
    await f.vault.write.deposit([f.usdg.address, parseUnits("1000", 6)]);
    await f.vault.write.withdraw([f.tsla.address, parseUnits("2", 18), f.owner.account.address]);
    const end = await time.latest();

    const s = await buildStatement(f.publicClient as never, f.vault.abi, f.vault.address, assets, start, end, await readTaxEvents(f.publicClient as never, f.vault.abi, f.vault.address));
    expect(s.openingUsd).to.equal(usd(10_000));
    expect(s.depositsUsd).to.equal(usd(1_000));
    expect(s.withdrawalsUsd).to.equal(usd(500)); // 2 TSLA at $250
    expect(s.feesUsd > 0n).to.equal(true);
    expect(s.openingUsd + s.depositsUsd - s.withdrawalsUsd - s.feesUsd + s.marketAndTradingUsd).to.equal(s.closingUsd);
    // NVDA's 60% rally on $2,500 is most of what markets and trading did.
    expect(s.marketAndTradingUsd > usd(1_490) && s.marketAndTradingUsd < usd(1_500)).to.equal(true);
    expect(s.trades).to.equal(1);
    expect(s.lines.map((l) => l.kind)).to.include.members(["trade", "deposit", "withdrawal", "fee"]);
    expect(s.realized.shortTermUsd > 0n).to.equal(true); // the NVDA sold at a gain
    const [, closing] = await f.vault.read.portfolio();
    expect(s.closingUsd).to.equal(closing);
    expect(s.holdings.map((h) => h.symbol)).to.deep.equal(["USDG", "TSLA", "AAPL", "NVDA"]);
  });

  it("lists calendar months newest first, the current one ending now", () => {
    const months = monthsBetween(Date.UTC(2026, 7, 20) / 1000, Date.UTC(2026, 9, 6) / 1000);
    expect(months.map((m) => m.label)).to.deep.equal(["October 2026", "September 2026", "August 2026"]);
    expect(months[0].end).to.equal(Date.UTC(2026, 9, 6) / 1000);
    expect(months[1].start).to.equal(Date.UTC(2026, 8, 1) / 1000);
  });
});
