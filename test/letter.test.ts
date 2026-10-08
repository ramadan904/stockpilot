import { expect } from "chai";
import { MAX_LETTER_BYTES, composeLetter } from "../agent/letter";
import { basicReport } from "../agent/report";

const facts = {
  period: "the last day",
  valueStartUsd: null,
  valueNowUsd: 10_000,
  paused: false,
  budgetLeftUsd: 3_000,
  feeBps: 0,
  holdings: [
    { symbol: "USDG", weightPct: 30, targetPct: 30, bandPct: 5, priceChangePct: null, valueUsd: 3_000 },
    { symbol: "NVDA", weightPct: 70, targetPct: 70, bandPct: 5, priceChangePct: 2.5, valueUsd: 7_000 },
  ],
  trades: [{ sold: "USDG", bought: "NVDA", valueUsd: 1_000, reason: null }],
  blocked: [],
};

describe("Letters from the pilot", () => {
  it("reads as a letter: greeting, what happened, the guarantee, a signature", () => {
    const text = composeLetter(basicReport(facts as never), { vault: "0xfFfEBea2C701CA2cfD406D89580aE984adb0a783", pilotName: "StockPilot House Pilot", written: "basic" });
    expect(text.startsWith("Dear owner,\n")).to.equal(true);
    expect(text).to.contain("1 rebalancing trade during the last day, $1,000 in total.");
    expect(text).to.contain("$1,000 of USDG into NVDA");
    expect(text).to.contain("checked by vault 0xfFfE…a783 against the mandate you signed");
    expect(text.trimEnd().endsWith("StockPilot House Pilot")).to.equal(true);
  });

  it("credits Claude when Claude wrote it", () => {
    const text = composeLetter(basicReport(facts as never), { vault: "0x" + "1".repeat(40), pilotName: "P", written: "claude" });
    expect(text).to.contain("written with Claude from figures read onchain");
  });

  it("always fits the contract's limit, dropping the extras before cutting the summary", () => {
    const long = { headline: "H", summary: "S".repeat(1_000), highlights: Array(40).fill("x".repeat(120)), watch: [] };
    const text = composeLetter(long, { vault: "0x" + "1".repeat(40), pilotName: "P", written: "basic" });
    expect(new TextEncoder().encode(text).length).to.be.at.most(MAX_LETTER_BYTES);
    expect(text).to.contain("S".repeat(1_000));
    expect(text).not.to.contain("x".repeat(120));
    const huge = { headline: "H", summary: "é".repeat(5_000), highlights: [], watch: [] };
    expect(new TextEncoder().encode(composeLetter(huge, { vault: "0x" + "1".repeat(40), pilotName: "P", written: "basic" })).length).to.be.at.most(MAX_LETTER_BYTES);
  });
});
