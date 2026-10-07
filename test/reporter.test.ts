import { expect } from "chai";
import type Anthropic from "@anthropic-ai/sdk";
import { handleReport } from "../agent/api";
import { basicReport, writeReport, type Report, type ReportFacts } from "../agent/reporter";

const facts: ReportFacts = {
  period: "the last 7 days",
  valueStartUsd: 10_000,
  valueNowUsd: 10_532.4,
  paused: false,
  budgetLeftUsd: 2_100,
  feeBps: 50,
  holdings: [
    { symbol: "USDG", valueUsd: 1500, weightPct: 14.2, targetPct: 15, bandPct: 7, priceChangePct: 0 },
    { symbol: "NVDA", valueUsd: 2736, weightPct: 26.0, targetPct: 21.25, bandPct: 7, priceChangePct: 80 },
    { symbol: "TSLA", valueUsd: 2350, weightPct: 22.3, targetPct: 21.25, bandPct: 7, priceChangePct: -30 },
  ],
  trades: [{ sold: "NVDA", bought: "TSLA", valueUsd: 863.28, reason: "NVDA was 34.6% against a 21.3% target." }],
  blocked: [{ attempt: "Withdraw to its own wallet", reason: "OwnableUnauthorizedAccount" }],
};

describe("agent/reporter", () => {
  it("writes a plain report from the facts without Claude", () => {
    const r = basicReport(facts);
    expect(r.headline).to.equal("1 rebalancing trade during the last 7 days, $863 in total.");
    expect(r.summary).to.include("from $10,000 to $10,532 (+5.32%)").and.include("$863 of NVDA into TSLA");
    expect(r.highlights.join(" ")).to.include("NVDA moved the most: +80.0%").and.include("blocked 1 trade attempt");
    expect(r.watch.join(" ")).to.include("NVDA is at 26.0%");
  });

  it("calls out a paused vault and an exhausted budget", () => {
    const r = basicReport({ ...facts, paused: true, budgetLeftUsd: 0, trades: [] });
    expect(r.headline).to.match(/^No trades/);
    expect(r.watch.join(" ")).to.include("paused").and.include("trading budget");
  });

  it("hands Claude the facts and returns its structured report", async () => {
    const written: Report = { headline: "A calm week.", summary: "…", highlights: ["a", "b"], watch: [] };
    let request: { model?: string; messages?: unknown } = {};
    const fake = {
      beta: { messages: { parse: async (p: typeof request) => ((request = p), { stop_reason: "end_turn", parsed_output: written }) } },
    } as unknown as Anthropic;
    const out = await writeReport(facts, fake);
    expect(out).to.deep.equal({ report: written, source: "claude" });
    expect(request.model).to.equal("claude-opus-5-5");
    expect(JSON.stringify(request.messages)).to.include("10532.4").and.include("OwnableUnauthorizedAccount");
  });

  it("falls back to the plain report if Claude declines", async () => {
    const fake = { beta: { messages: { parse: async () => ({ stop_reason: "refusal", parsed_output: null }) } } } as unknown as Anthropic;
    const out = await writeReport(facts, fake);
    expect(out.source).to.equal("basic");
    expect(out.report.headline).to.match(/rebalancing trade/);
  });

  it("the endpoint rejects malformed or oversized facts", async () => {
    expect((await handleReport({ period: "x" })).status).to.equal(400);
    expect((await handleReport({ ...facts, trades: Array(51).fill(facts.trades[0]) })).status).to.equal(400);
    const ok = await handleReport(facts);
    expect(ok.status).to.equal(200);
  });
});
