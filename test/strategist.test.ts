import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers";
import type Anthropic from "@anthropic-ai/sdk";
import { largestRemainder, presetFor, propose, toMandate, type Proposal, type UniverseAsset } from "../agent/strategist";
import { deployStockPilot } from "./fixture";

async function universe(): Promise<{ f: Awaited<ReturnType<typeof deployStockPilot>>; assets: UniverseAsset[] }> {
  const f = await loadFixture(deployStockPilot);
  const assets: UniverseAsset[] = [
    { symbol: "USDG", name: "Global Dollar", token: f.usdg.address, feed: f.usdgFeed.address, profile: "stablecoin", stable: true },
    { symbol: "TSLA", name: "Tesla", token: f.tsla.address, feed: f.tslaFeed.address, profile: "EV maker; volatile" },
    { symbol: "AAPL", name: "Apple", token: f.aapl.address, feed: f.aaplFeed.address, profile: "consumer tech; steady" },
    { symbol: "NVDA", name: "NVIDIA", token: f.nvda.address, feed: f.nvdaFeed.address, profile: "AI chips; volatile" },
  ];
  return { f, assets };
}

describe("agent/strategist", () => {
  it("splits weights into integer bps that sum to exactly 10,000", () => {
    expect(largestRemainder([1, 1, 1], 10_000)).to.deep.equal([3334, 3333, 3333]);
    expect(largestRemainder([33.3, 33.3, 33.4], 10_000).reduce((a, b) => a + b)).to.equal(10_000);
    expect(largestRemainder([0, 70, 30], 10_000)).to.deep.equal([0, 7000, 3000]);
  });

  it("repairs a sloppy proposal and reports every fix", async () => {
    const { assets } = await universe();
    const sloppy: Proposal = {
      summary: "x",
      risk_level: "growth",
      allocations: [
        { symbol: "usdg", weight_percent: 20, reason: "" },
        { symbol: "TSLA", weight_percent: 50, reason: "" },
        { symbol: "AAPL", weight_percent: 50, reason: "" },
        { symbol: "DOGE", weight_percent: 10, reason: "" },
        { symbol: "NVDA", weight_percent: -5, reason: "" },
      ],
      band_percent: 45,
      max_trade_percent: 0,
      daily_turnover_percent: 5,
    };
    const { mandate, adjustments } = toMandate(sloppy, assets, 10_000);
    const targets = mandate.assets.map((a) => a.targetBps);
    expect(targets.reduce((a, b) => a + b)).to.equal(10_000);
    [1667, 4167, 4167, 0].forEach((t, i) => expect(Math.abs(targets[i] - t)).to.be.at.most(1));
    expect(mandate.assets.map((a) => a.bandBps)).to.deep.equal([2000, 2000, 2000, 0]);
    expect(adjustments.join(" ")).to.match(/DOGE/).and.match(/scaled to 100%/).and.match(/band 45% clamped to 20%/);
  });

  it("produces mandates the vault accepts, for every preset risk level", async () => {
    const { f, assets } = await universe();
    for (const goal of [
      "I'm retiring in two years and want it safe",
      "balanced please",
      "long-term growth over a decade",
      "aggressive, I can take high risk",
    ]) {
      const s = await propose(goal, assets, 10_000, null);
      expect(s.source).to.equal("preset");
      await f.vault.write.setMandate([s.mandate.assets, s.mandate.limits]);
    }
    expect(await f.vault.read.mandateVersion()).to.equal(5n);
  });

  it("reads conservative goals as conservative", async () => {
    const { assets } = await universe();
    const p = presetFor("I need this money for a house deposit soon", assets);
    expect(p.risk_level).to.equal("conservative");
    expect(p.allocations.find((a) => a.symbol === "USDG")!.weight_percent).to.equal(60);
  });

  it("uses Claude's structured proposal when a client is available", async () => {
    const { assets } = await universe();
    let request: Record<string, unknown> = {};
    const proposal: Proposal = {
      summary: "Tech growth with a cash cushion.",
      risk_level: "growth",
      allocations: [
        { symbol: "USDG", weight_percent: 15, reason: "cushion" },
        { symbol: "TSLA", weight_percent: 20, reason: "EV" },
        { symbol: "AAPL", weight_percent: 30, reason: "steady" },
        { symbol: "NVDA", weight_percent: 35, reason: "AI" },
      ],
      band_percent: 6,
      max_trade_percent: 10,
      daily_turnover_percent: 25,
    };
    const fake = {
      beta: {
        messages: {
          parse: async (params: Record<string, unknown>) => {
            request = params;
            return { stop_reason: "end_turn", parsed_output: proposal };
          },
        },
      },
    } as unknown as Anthropic;

    const s = await propose("Mostly tech, I'm 30 and patient", assets, 50_000, fake);
    expect(s.source).to.equal("claude");
    expect(s.adjustments).to.deep.equal([]);
    expect(s.mandate.assets.map((a) => a.targetBps)).to.deep.equal([1500, 2000, 3000, 3500]);
    expect(s.mandate.limits.maxTradeUsd).to.equal(5_000n * 10n ** 18n);
    expect(request.model).to.equal("claude-opus-5-5");
    expect(JSON.stringify(request.messages)).to.include("Mostly tech, I'm 30 and patient");
  });

  it("surfaces a refusal instead of inventing a mandate", async () => {
    const { assets } = await universe();
    const fake = {
      beta: { messages: { parse: async () => ({ stop_reason: "refusal", stop_details: { explanation: "nope" }, parsed_output: null }) } },
    } as unknown as Anthropic;
    await expect(propose("…", assets, 1_000, fake)).to.be.rejectedWith(/declined.*nope/);
  });
});
