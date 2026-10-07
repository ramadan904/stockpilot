import { expect } from "chai";
import { handleImport } from "../agent/api";
import { halfPercents, mapToUniverse, parseHoldingsText, type ExtractedHoldings } from "../agent/holdings";
import { LISTINGS } from "../agent/listings";

// A brokerage CSV export, as people paste it.
const CSV = `Symbol,Description,Quantity,Last Price,Current Value
AAPL,APPLE INC,50,$230.00,"$11,500.00"
VOO,VANGUARD S&P 500 ETF,20,$550.00,"$11,000.00"
MSFT,MICROSOFT CORP,10,$450.00,"$4,500.00"
SPAXX**,HELD IN MONEY MARKET,,,"$3,000.00"
IBIT,ISHARES BITCOIN TRUST,10,$50.00,$500.00
Total,,,,"$30,500.00"`;

const universe = [...LISTINGS];
const weight = (r: ReturnType<typeof mapToUniverse>, s: string) => r.proposal.allocations.find((a) => a.symbol === s)!.weight_percent;

describe("agent/holdings", () => {
  it("parses a pasted brokerage export: tickers, market values, money market as cash; totals skipped", () => {
    const { holdings } = parseHoldingsText(CSV);
    expect(holdings.map((h) => [h.ticker, h.asset_class, h.value_usd])).to.deep.equal([
      ["AAPL", "stock", 11_500],
      ["VOO", "stock", 11_000],
      ["MSFT", "stock", 4_500],
      ["SPAXX", "cash", 3_000],
      ["IBIT", "crypto", 500],
    ]);
  });

  it("parses free-form lines too, and says so when nothing is usable", () => {
    const { holdings } = parseHoldingsText("Cash $2,000\nNVDA 15 shares worth $2,700\nmy notes without numbers");
    expect(holdings.map((h) => [h.ticker, h.asset_class, h.value_usd])).to.deep.equal([
      [null, "cash", 2_000],
      ["NVDA", "stock", 2_700],
    ]);
    expect(parseHoldingsText("hello\nworld").note).to.match(/No lines/);
  });

  it("mirrors the portfolio on the vault's assets, line by line, with exact half-percent weights", () => {
    const r = mapToUniverse(parseHoldingsText(CSV), universe);
    expect(r.lines.map((l) => l.to)).to.deep.equal(["AAPL", "SPY", "SPY", "USDG", null]);
    expect(r.lines[2].why).to.match(/No tokenized version is listed/);
    expect(r.lines[4].why).to.match(/Crypto/);
    // $30,000 counted: USDG $3,000 = 10%, AAPL $11,500 = 38.33%, SPY $15,500 = 51.67%: rounded to halves, summing to 100.
    expect([weight(r, "USDG"), weight(r, "TSLA"), weight(r, "AAPL"), weight(r, "NVDA"), weight(r, "SPY")]).to.deep.equal([10, 0, 38.5, 0, 51.5]);
    expect(r.proposal.allocations.reduce((s, a) => s + a.weight_percent, 0)).to.equal(100);
    expect(r.totalUsd).to.equal(30_500);
    expect(r.leftOutUsd).to.equal(500);
    expect(r.proposal.risk_level).to.equal("growth");
    expect(r.proposal.allocations.find((a) => a.symbol === "SPY")!.reason).to.equal("From VOO, MSFT ($15,500).");
  });

  it("bonds go to the stablecoin as the nearest low-risk holding; unpriced lines and nothing mappable are reported", () => {
    const x: ExtractedHoldings = {
      holdings: [
        { name: "Total bond", ticker: "BND", asset_class: "bond", value_usd: 6_000 },
        { name: "Tesla", ticker: "TSLA", asset_class: "stock", value_usd: 4_000 },
        { name: "Unknown", ticker: "XYZ", asset_class: "stock", value_usd: null },
      ],
      note: "",
    };
    const r = mapToUniverse(x, universe);
    expect(weight(r, "USDG")).to.equal(60);
    expect(weight(r, "TSLA")).to.equal(40);
    expect(r.proposal.risk_level).to.equal("conservative");
    expect(r.lines[2]).to.include({ to: null, why: "No market value shown." });
    expect(() => mapToUniverse({ holdings: [{ name: "Bitcoin", ticker: "BTC", asset_class: "crypto", value_usd: 100 }], note: "" }, universe)).to.throw(/None of these holdings/);
  });

  it("half percents always add up to exactly 100", () => {
    for (const shares of [[1 / 3, 1 / 3, 1 / 3], [0.001, 0.999], [0.2, 0.2, 0.2, 0.2, 0.2], [0.123, 0.456, 0.421]]) {
      const w = halfPercents(shares);
      expect(w.reduce((s, x) => s + x, 0)).to.equal(100);
      for (const x of w) expect((x * 2) % 1).to.equal(0);
    }
  });
});

describe("POST /api/import", () => {
  const read: ExtractedHoldings = { holdings: [{ name: "Apple Inc", ticker: "AAPL", asset_class: "stock", value_usd: 1_000 }], note: "" };
  const stub = (reply: unknown, seen: unknown[] = []) => ({ beta: { messages: { parse: async (req: unknown) => (seen.push(req), reply) } } }) as never;

  it("parses pasted text without any credentials", async () => {
    const r = await handleImport({ text: CSV }, null);
    expect(r.status).to.equal(200);
    expect((r.json as { source: string; holdings: ExtractedHoldings }).holdings.holdings).to.have.length(5);
  });

  it("sends a screenshot to Claude as an image with a structured-output schema, and returns what it read", async () => {
    const seen: Record<string, unknown>[] = [];
    const r = await handleImport({ image: { media_type: "image/png", data: "iVBORw0KGgo=" } }, stub({ stop_reason: "end_turn", parsed_output: read }, seen));
    expect(r).to.deep.equal({ status: 200, json: { holdings: read, source: "claude" } });
    const req = seen[0] as { model: string; output_config: { format: unknown }; messages: { content: { type: string; source?: { media_type: string; data: string } }[] }[] };
    expect(req.model).to.equal("claude-opus-5-5");
    expect(req.output_config.format).to.be.an("object");
    expect(req.messages[0].content[0]).to.deep.include({ type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } });
  });

  it("refuses the wrong kind of upload, oversize or broken data, and screenshots without Claude configured", async () => {
    expect((await handleImport({ image: { media_type: "application/pdf", data: "AAAA" } }, null)).status).to.equal(400);
    expect((await handleImport({ image: { media_type: "image/png", data: "A".repeat(4_000_001) } }, null)).status).to.equal(400);
    expect((await handleImport({ image: { media_type: "image/png", data: "not base64!" } }, null)).status).to.equal(400);
    expect((await handleImport({ text: "x".repeat(20_001) }, null)).status).to.equal(400);
    const noClaude = await handleImport({ image: { media_type: "image/png", data: "iVBORw0KGgo=" } }, null);
    expect(noClaude.status).to.equal(400);
    expect((noClaude.json as { error: string }).error).to.match(/Paste your holdings as text/);
  });

  it("reports Claude declining rather than inventing holdings", async () => {
    const r = await handleImport({ image: { media_type: "image/jpeg", data: "/9j/4AAQ" } }, stub({ stop_reason: "refusal", stop_details: { explanation: "unclear" }, parsed_output: null }));
    expect(r.status).to.equal(502);
    expect((r.json as { error: string }).error).to.match(/declined.*unclear/);
  });
});
