import { expect } from "chai";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers";
import { parseUnits, type Address, type Hash } from "viem";
import { harvestable, readTaxEvents, salesCsv, taxReport, YEAR_SECONDS, type AssetInfo, type TaxEvent } from "../agent/tax";
import { readVault, sendTrade } from "../agent/chain";
import { plan } from "../agent/planner";
import { deployStockPilot, px, usd } from "./fixture";

const USDG = "0x00000000000000000000000000000000000000a1" as Address;
const TSLA = "0x00000000000000000000000000000000000000b2" as Address;
const NVDA = "0x00000000000000000000000000000000000000c3" as Address;
const ASSETS = new Map<string, AssetInfo>([
  [USDG, { symbol: "USDG", decimals: 6, cash: true }],
  [TSLA, { symbol: "TSLA", decimals: 18, cash: false }],
  [NVDA, { symbol: "NVDA", decimals: 18, cash: false }],
]);
const T0 = Date.UTC(2025, 0, 10) / 1000;
const DAY = 86_400;
const tx = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hash;
const sh = (n: number | string) => parseUnits(String(n), 18);
// A buy of `shares` TSLA for `dollars` of USDG.
const buy = (t: number, token: Address, shares: number, dollars: number, n: number): TaxEvent => ({
  kind: "trade", time: t, tx: tx(n), tokenIn: USDG, tokenOut: token, amountIn: parseUnits(String(dollars), 6), amountOut: sh(shares), valueInUsd: usd(dollars), valueOutUsd: usd(dollars),
});
const sell = (t: number, token: Address, shares: number, dollars: number, n: number): TaxEvent => ({
  kind: "trade", time: t, tx: tx(n), tokenIn: token, tokenOut: USDG, amountIn: sh(shares), amountOut: parseUnits(String(dollars), 6), valueInUsd: usd(dollars), valueOutUsd: usd(dollars),
});

describe("agent/tax", () => {
  it("matches sales to lots first in, first out, splitting a lot and its basis exactly", () => {
    const r = taxReport(
      [
        buy(T0, TSLA, 10, 2_000, 1), // $200 a share
        buy(T0 + 30 * DAY, TSLA, 10, 3_000, 2), // $300 a share
        sell(T0 + 60 * DAY, TSLA, 15, 3_750, 3), // $250 a share
      ],
      ASSETS,
    );
    expect(r.sales.map((s) => [s.amount, s.basisUsd, s.proceedsUsd, s.gainUsd, s.term])).to.deep.equal([
      [sh(10), usd(2_000), usd(2_500), usd(500), "short"],
      [sh(5), usd(1_500), usd(1_250), usd(-250), "short"],
    ]);
    expect(r.open).to.have.length(1);
    expect(r.open[0].amount).to.equal(sh(5));
    expect(r.open[0].basisUsd).to.equal(usd(1_500));
    expect(r.years).to.deep.equal([{ year: 2025, shortTermUsd: usd(250), longTermUsd: 0n, proceedsUsd: usd(3_750), feesUsd: 0n, sales: 2 }]);
  });

  it("is long term only after more than a year, per lot", () => {
    const r = taxReport(
      [buy(T0, TSLA, 1, 100, 1), buy(T0 + 10 * DAY, TSLA, 1, 100, 2), sell(T0 + YEAR_SECONDS + 5 * DAY, TSLA, 2, 300, 3)],
      ASSETS,
    );
    expect(r.sales.map((s) => s.term)).to.deep.equal(["long", "short"]);
    expect(r.years[0].longTermUsd).to.equal(usd(50));
    expect(r.years[0].shortTermUsd).to.equal(usd(50));
    expect(taxReport([buy(T0, TSLA, 1, 100, 1), sell(T0 + YEAR_SECONDS, TSLA, 1, 90, 2)], ASSETS).sales[0].term).to.equal("short"); // exactly a year is not more
  });

  it("values deposits at market, withdraws lots with their basis, and treats the fee as a sale plus an expense", () => {
    const r = taxReport(
      [
        { kind: "deposit", time: T0, tx: tx(1), token: TSLA, amount: sh(4), priceUsd: usd(250) },
        { kind: "deposit", time: T0, tx: tx(2), token: USDG, amount: parseUnits("1000", 6), priceUsd: usd(1) },
        { kind: "fee", time: T0 + 100 * DAY, tx: tx(3), token: TSLA, amount: sh("0.01"), priceUsd: usd(300) },
        { kind: "withdraw", time: T0 + 200 * DAY, tx: tx(4), token: TSLA, amount: sh(1) },
        sell(T0 + 400 * DAY, TSLA, 2.99, 897, 5),
      ],
      ASSETS,
    );
    const [fee, sale] = r.sales;
    expect(fee.via).to.equal("fee");
    expect([fee.proceedsUsd, fee.basisUsd, fee.gainUsd]).to.deep.equal([usd(3), usd("2.5"), usd("0.5")]);
    expect(r.years[0].feesUsd).to.equal(usd(3));
    expect(r.withdrawn[0].amount).to.equal(sh(1));
    expect(r.withdrawn[0].basisUsd).to.equal(usd(250));
    expect(sale.amount).to.equal(sh("2.99"));
    expect(sale.basisUsd).to.equal(usd("747.5"));
    expect(sale.term).to.equal("long");
    expect(r.open).to.have.length(0);
    expect(r.sales.every((s) => s.symbol !== "USDG")).to.equal(true); // cash has no lots
  });

  it("flags what it cannot know instead of guessing quietly", () => {
    const r = taxReport(
      [{ kind: "deposit", time: T0, tx: tx(1), token: TSLA, amount: sh(1), priceUsd: null }, sell(T0 + DAY, TSLA, 2, 500, 2)],
      ASSETS,
    );
    expect(r.sales.map((s) => s.basisKnown)).to.deep.equal([false, false]);
    expect(r.warnings.join(" ")).to.include("no price at a deposit").and.include("no recorded acquisition");
  });

  it("finds loss-harvesting candidates and exports Form 8949-style CSV", () => {
    const r = taxReport([buy(T0, TSLA, 10, 3_000, 1), buy(T0, NVDA, 10, 1_000, 2), sell(T0 + DAY, NVDA, 5, 600, 3)], ASSETS);
    const prices = new Map([[TSLA, usd(250)], [NVDA, usd(120)]]);
    const h = harvestable(r.open, (t) => prices.get(t), ASSETS);
    expect(h.map((x) => [x.symbol, x.lossUsd])).to.deep.equal([["TSLA", usd(500)]]);

    const csv = salesCsv(r, ASSETS, 2025).trim().split("\n");
    expect(csv[0]).to.equal("Description,Date acquired,Date sold,Proceeds (USD),Cost basis (USD),Gain or loss (USD),Term,Basis source,Transaction");
    expect(csv[1]).to.equal(`5 NVDA,2025-01-10,2025-01-11,600.00,500.00,100.00,Short term,Onchain,${tx(3)}`);
    expect(salesCsv(r, ASSETS, 2024).trim().split("\n")).to.have.length(1);
  });

  it("reads a real vault's history: deposits priced by its oracles, the pilot's trades, and the fee", async () => {
    const f = await loadFixture(deployStockPilot);
    await f.vault.write.setFee([f.stranger.account.address, 100]);
    await f.nvdaFeed.write.setPrice([px(200)]); // NVDA rallies from $125: the pilot trims it at a gain
    const p = plan(await readVault(f.publicClient, f.vault.abi, f.vault.address));
    if (p.action !== "trade") throw new Error("expected a trade");
    await sendTrade(f.publicClient, f.pilot, f.vault.abi, f.vault.address, p.trade);
    await time.increase(30 * DAY);
    for (const feed of [f.tslaFeed, f.aaplFeed, f.nvdaFeed]) await feed.write.setPrice([(await feed.read.latestRoundData())[1]]);
    await f.vault.write.collectFee();

    const assets = new Map<string, AssetInfo>([
      [f.usdg.address.toLowerCase(), { symbol: "USDG", decimals: 6, cash: true }],
      [f.tsla.address.toLowerCase(), { symbol: "TSLA", decimals: 18, cash: false }],
      [f.aapl.address.toLowerCase(), { symbol: "AAPL", decimals: 18, cash: false }],
      [f.nvda.address.toLowerCase(), { symbol: "NVDA", decimals: 18, cash: false }],
    ]);
    const events = await readTaxEvents(f.publicClient as never, f.vault.abi, f.vault.address);
    expect(events.filter((e) => e.kind === "deposit")).to.have.length(4);
    const r = taxReport(events, assets);
    const trade = r.sales.find((s) => s.via === "trade")!;
    expect(trade.symbol).to.equal("NVDA");
    // Bought at $125 (the deposit price), sold at about $200 less 0.1% venue fee: a gain of about 60%.
    expect(trade.basisUsd).to.equal((trade.amount * 125n) / 1n);
    expect(trade.gainUsd > 0n).to.equal(true);
    expect(Number(trade.gainUsd * 1000n / trade.basisUsd)).to.be.within(595, 600);
    expect(r.sales.filter((s) => s.via === "fee").map((s) => s.symbol)).to.have.members(["TSLA", "AAPL", "NVDA"]);
    expect(r.years[0].feesUsd > 0n).to.equal(true);
    expect(r.warnings).to.deep.equal([]);
  });
});
