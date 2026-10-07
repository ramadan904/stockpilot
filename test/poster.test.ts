import { expect } from "chai";
import { escapeXml, posterSvg, wrap } from "../agent/poster";
import { LISTINGS } from "../agent/listings";

const input = {
  kicker: "Strategy · balanced",
  title: "Balanced, with cash on hand",
  summary: "A balanced mix: 30% in the stablecoin, the rest spread evenly across 4 stocks.",
  allocations: [
    { symbol: "USDG", percent: 30 },
    { symbol: "TSLA", percent: 17.5 },
    { symbol: "AAPL", percent: 17.5 },
    { symbol: "NVDA", percent: 17.5 },
    { symbol: "SPY", percent: 17.5 },
  ],
  rules: ["Drift band ±5 pts", "Max trade 10%", "Daily turnover 30%", "Enforced onchain by the vault"],
  site: "stockpilot-six-virid.vercel.app",
};

describe("Shareable card", () => {
  it("draws every held asset with its weight, the rules and where to find it", () => {
    const svg = posterSvg(input, LISTINGS);
    expect(svg.startsWith("<svg")).to.equal(true);
    expect(svg).to.contain('width="1200" height="630"');
    for (const a of input.allocations) expect(svg).to.contain(`>${a.symbol}</text>`);
    expect(svg).to.contain(">30%</text>");
    expect(svg).to.contain(">17.5%</text>");
    for (const r of input.rules) expect(svg).to.contain(escapeXml(r));
    expect(svg).to.contain("STRATEGY · BALANCED");
    expect(svg).to.contain(input.site);
    // One aurora light per held asset.
    expect(svg.match(/<radialGradient/g)).to.have.length(5);
  });

  it("sizes bars by weight and leaves out assets at 0%", () => {
    const svg = posterSvg({ ...input, allocations: [{ symbol: "SPY", percent: 80 }, { symbol: "USDG", percent: 20 }, { symbol: "TSLA", percent: 0 }] }, LISTINGS);
    const widths = [...svg.matchAll(/<rect x="820" y="\d+" width="(\d+)" height="20" rx="10" fill="#[0-9a-f]{6}" filter=/g)].map((m) => Number(m[1]));
    expect(widths).to.deep.equal([240, 60]);
    expect(svg).not.to.contain(">TSLA</text>");
  });

  it("escapes text it did not write: a summary from a model or a user can't inject markup", () => {
    const svg = posterSvg({ ...input, title: 'Mine <script>alert("x")</script>', summary: "Tom & Jerry's <b>fund</b>" }, LISTINGS);
    expect(svg).not.to.contain("<script");
    expect(svg).not.to.contain("<b>");
    expect(svg).to.contain("&lt;script&gt;");
    expect(svg).to.contain("Tom &amp; Jerry&apos;s");
  });

  it("shows the vault's mood when it has one", () => {
    const svg = posterSvg({ ...input, status: { label: "On target", mood: "calm" } }, LISTINGS);
    expect(svg).to.contain(">On target</text>");
    expect(svg).to.contain("#2dd4bf");
  });

  it("wraps long text to a few lines and marks what it cut", () => {
    expect(wrap("one two three", 20, 3)).to.deep.equal(["one two three"]);
    const lines = wrap("alpha beta gamma delta epsilon zeta eta theta iota kappa", 12, 2);
    expect(lines).to.have.length(2);
    expect(lines[1].endsWith("…")).to.equal(true);
    for (const l of lines) expect(l.length).to.be.at.most(13);
    expect(wrap("", 10, 2)).to.deep.equal([]);
    expect(wrap("supercalifragilistic", 8, 1)).to.deep.equal(["superca…"]);
  });
});
