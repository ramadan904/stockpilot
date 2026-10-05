import { expect } from "chai";
import type Anthropic from "@anthropic-ai/sdk";
import { LISTINGS } from "../agent/listings";
import { handleRefine } from "../agent/api";
import { diffProposals, presetFor, refine, refineOffline, type Proposal } from "../agent/strategist";

const base = presetFor("balanced", [...LISTINGS]); // USDG 30, four stocks at 17.5, band 5
const weight = (p: Proposal, s: string) => p.allocations.find((a) => a.symbol === s)!.weight_percent;
const total = (p: Proposal) => p.allocations.reduce((t, a) => t + a.weight_percent, 0);

describe("refining a mandate", () => {
  it("understands more, less, none and exact targets offline, keeping the total at 100%", () => {
    // A matched pair moves points directly, leaving everything else alone.
    const less = refineOffline(base, "less Tesla, more cash")!;
    expect([weight(less, "TSLA"), weight(less, "USDG"), weight(less, "AAPL")]).to.deep.equal([12.5, 35, 17.5]);
    expect(total(less)).to.equal(100);

    const none = refineOffline(base, "no NVDA please")!;
    expect(weight(none, "NVDA")).to.equal(0);
    expect(total(none)).to.equal(100);

    const exact = refineOffline(base, "SPY to 40%")!;
    expect(weight(exact, "SPY")).to.equal(40);
    expect(total(exact)).to.equal(100);
  });

  it("handles safer, riskier and band changes", () => {
    expect(weight(refineOffline(base, "make it safer")!, "USDG")).to.equal(40);
    expect(weight(refineOffline(base, "a bit riskier")!, "USDG")).to.equal(20);
    expect(refineOffline(base, "wider bands")!.band_percent).to.equal(7);
    expect(refineOffline(base, "tighter bands")!.band_percent).to.equal(3);
  });

  it("returns null when it understands nothing, and refine() explains what it can do", async () => {
    expect(refineOffline(base, "buy a house")).to.equal(null);
    let err = "";
    await refine(base, "buy a house", [...LISTINGS], 10_000, null).catch((e) => (err = (e as Error).message));
    expect(err).to.include("less TSLA").and.include("ANTHROPIC_API_KEY");
  });

  it("lists what changed in plain words", () => {
    const after = refineOffline(base, "no TSLA, wider bands")!;
    const changes = diffProposals(base, after);
    expect(changes).to.include("TSLA: 17.5% → 0%");
    expect(changes).to.include("Drift band: ±5 → ±7 points");
  });

  it("sends Claude the current draft and the instruction, and diffs its revision", async () => {
    const revised: Proposal = { ...base, allocations: base.allocations.map((a) => (a.symbol === "NVDA" ? { ...a, weight_percent: 27.5 } : a.symbol === "USDG" ? { ...a, weight_percent: 20 } : a)) };
    let sent = "";
    const fake = {
      beta: { messages: { parse: async (p: { messages: { content: string }[]; system: string }) => ((sent = p.messages[0].content + p.system), { stop_reason: "end_turn", parsed_output: revised }) } },
    } as unknown as Anthropic;
    const out = await refine(base, "I trust NVIDIA more than cash", [...LISTINGS], 10_000, fake);
    expect(out.source).to.equal("claude");
    expect(out.changes).to.deep.equal(["USDG: 30% → 20%", "NVDA: 17.5% → 27.5%"]);
    expect(sent).to.include("I trust NVIDIA more than cash").and.include('"weight_percent":17.5').and.include("revising a portfolio draft");
  });

  it("the endpoint validates its input", async () => {
    expect((await handleRefine({ proposal: { nope: 1 }, instruction: "x" })).status).to.equal(400);
    expect((await handleRefine({ proposal: base, instruction: "  " })).status).to.equal(400);
    expect((await handleRefine({ proposal: base, instruction: "buy a house" })).status).to.equal(422);
    const ok = await handleRefine({ proposal: base, instruction: "less AAPL" });
    expect(ok.status).to.equal(200);
    expect((ok.json as { changes: string[] }).changes[0]).to.match(/AAPL: 17\.5% → 12\.5%|USDG/);
  });
});
