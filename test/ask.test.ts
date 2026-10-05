import { expect } from "chai";
import type Anthropic from "@anthropic-ai/sdk";
import { keccak256, toHex } from "viem";
import { askVault, attachRationales, basicAnswer, checkCitations, type VaultFacts } from "../agent/ask";
import { handleAsk } from "../agent/api";

const REASON = "NVDA is 22.9% of the portfolio against a 17.5% target. Selling $209.99 of NVDA for USDG to move both back toward target.";
const TX1 = `0x${"1".repeat(64)}` as const;
const TX2 = `0x${"2".repeat(64)}` as const;

const facts = (): VaultFacts => ({
  vault: "0x1111111111111111111111111111111111111111",
  chain: "Robinhood Chain testnet",
  asOf: "2026-10-05T12:00:00Z",
  status: { paused: false, totalUsd: 10_640, pilot: "0x2222222222222222222222222222222222222222", pilotName: "Claude fleet", feePercentPerYear: 0.5, nextMove: "Holding." },
  holdings: [
    { symbol: "USDG", valueUsd: 3_000, weightPct: 28.2, targetPct: 30, bandPct: 5, priceUsd: 1, priceAgeMinutes: 0 },
    { symbol: "NVDA", valueUsd: 2_400, weightPct: 22.6, targetPct: 17.5, bandPct: 5, priceUsd: 252, priceAgeMinutes: 3 },
  ],
  limits: { maxTradeUsd: 1_000, dailyLimitUsd: 3_000, budgetLeftUsd: 2_790, maxSlippagePct: 1, cooldownMinutes: 5, maxPriceAgeMinutes: 60 },
  trades: [
    { tx: TX1, time: "2026-10-05T11:00:00Z", sold: "NVDA", bought: "USDG", valueUsd: 209.99, rationaleHash: keccak256(toHex(REASON)), rationale: null },
  ],
  events: [{ tx: TX2, time: "2026-10-01T09:00:00Z", text: "Mandate version 1 signed" }],
  taxes: { year: 2026, shortTermGainUsd: 59.79, longTermGainUsd: 0, feesPaidUsd: 1.2, unrealizedGainUsd: 640 },
  inheritance: { heir: null, periodDays: 0, heirCanClaimFrom: null },
});

describe("agent/ask", () => {
  it("attaches the pilot's logged reason only when it hashes to the onchain commitment", () => {
    const withLog = attachRationales(facts(), [{ rationale: "something else" }, { rationale: REASON }]);
    expect(withLog.trades[0].rationale).to.equal(REASON);
    const tampered = attachRationales(facts(), [{ rationale: REASON + " (edited)" }]);
    expect(tampered.trades[0].rationale).to.equal(null);
  });

  it("keeps only citations that are transactions in the facts", () => {
    expect(checkCitations([TX1, TX1.toUpperCase().replace("0X", "0x"), `0x${"9".repeat(64)}`], facts())).to.deep.equal({ kept: [TX1], dropped: [`0x${"9".repeat(64)}`] });
  });

  it("asks Claude with the facts, strips unverified reasons first, and drops invented citations", async () => {
    let request: Record<string, unknown> = {};
    const fake = {
      beta: {
        messages: {
          parse: async (p: Record<string, unknown>) => (
            (request = p),
            { stop_reason: "end_turn", parsed_output: { answer: "It sold NVDA to get back toward target.", citations: [TX1, `0x${"9".repeat(64)}`], followUps: ["a", "b", "c", "d"] } }
          ),
        },
      },
    } as unknown as Anthropic;
    const f = facts();
    f.trades[0].rationale = "I felt like it"; // does not match the hash: must not reach the model
    const out = await askVault("Why did you sell NVDA?", f, [], fake);
    expect(out).to.deep.include({ source: "claude", citations: [TX1], dropped: [`0x${"9".repeat(64)}`] });
    expect(out.followUps).to.have.length(3);
    expect(request.model).to.equal("claude-opus-5-5");
    expect(request.fallbacks).to.equal("default");
    expect(request.betas).to.deep.equal(["server-side-fallback-2026-07-01"]);
    const sent = JSON.stringify(request.messages);
    expect(sent).to.include("Why did you sell NVDA?").and.include(TX1).and.not.include("I felt like it");
  });

  it("carries a short conversation, with the facts once at the start", async () => {
    let messages: { role: string; content: string }[] = [];
    const fake = {
      beta: { messages: { parse: async (p: { messages: typeof messages }) => ((messages = p.messages), { stop_reason: "end_turn", parsed_output: { answer: "ok", citations: [], followUps: [] } }) } },
    } as unknown as Anthropic;
    await askVault("And today?", facts(), [{ question: "What did you do yesterday?", answer: "Nothing." }], fake);
    expect(messages.map((m) => m.role)).to.deep.equal(["user", "assistant", "user"]);
    expect(messages[0].content).to.include("Facts about my vault").and.include("What did you do yesterday?");
    expect(messages[2].content).to.equal("And today?");
  });

  it("answers the common questions without Claude, from the facts alone", () => {
    const f = attachRationales(facts(), [{ rationale: REASON }]);
    const why = basicAnswer("why did you sell NVDA?", f);
    expect(why.answer).to.include("sold $210 of NVDA for USDG").and.include(REASON).and.include("matches the hash stored onchain");
    expect(why.citations).to.deep.equal([TX1]);
    expect(basicAnswer("what happens if I lose my keys?", f).answer).to.include("No heir is named");
    expect(basicAnswer("how much can the pilot trade today?", f).answer).to.include("$2,790");
    expect(basicAnswer("what are my taxes this year", f).answer).to.include("$59.79 short-term");
    expect(basicAnswer("how is my portfolio?", f).answer).to.include("$10,640").and.include("NVDA at 22.6% vs 17.5%");
  });

  it("the endpoint validates input and uses the logbook", async () => {
    expect((await handleAsk({ facts: facts() })).status).to.equal(400);
    expect((await handleAsk({ question: "x".repeat(501), facts: facts() })).status).to.equal(400);
    expect((await handleAsk({ question: "hi", facts: { vault: 1 } })).status).to.equal(400);
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const res = await handleAsk({ question: "Why did you sell NVDA?", facts: facts() }, () => [{ rationale: REASON }]);
      expect(res.status).to.equal(200);
      expect((res.json as { answer: string }).answer).to.include(REASON);
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
  });
});
