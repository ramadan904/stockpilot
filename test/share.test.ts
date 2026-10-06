import { expect } from "chai";
import { LISTINGS } from "../agent/listings";
import { presetFor, toMandate } from "../agent/mandate";
import { decodeStrategy, encodeStrategy, MAX_SHARED_CHARS } from "../agent/share";

describe("agent/share", () => {
  it("round-trips a strategy through a compact, URL-safe link", () => {
    const p = presetFor("aggressive growth, mostly tech", [...LISTINGS]);
    const code = encodeStrategy(p);
    expect(code).to.match(/^[A-Za-z0-9_-]+$/);
    expect(code.length).to.be.lessThan(500);
    const back = decodeStrategy(code, LISTINGS)!;
    expect(back.risk_level).to.equal(p.risk_level);
    expect(back.allocations.map((a) => [a.symbol, a.weight_percent])).to.deep.equal(p.allocations.map((a) => [a.symbol, a.weight_percent]));
    expect([back.band_percent, back.max_trade_percent, back.daily_turnover_percent]).to.deep.equal([p.band_percent, p.max_trade_percent, p.daily_turnover_percent]);
  });

  it("keeps non-ASCII text intact", () => {
    const p = { ...presetFor("balanced", [...LISTINGS]), summary: "Équilibré — pour la retraite ☀️" };
    expect(decodeStrategy(encodeStrategy(p), LISTINGS)!.summary).to.equal(p.summary);
  });

  it("refuses malformed or oversized links, and the vault's rules still repair whatever a link says", () => {
    expect(decodeStrategy("not-base64!!", LISTINGS)).to.equal(null);
    expect(decodeStrategy("a".repeat(MAX_SHARED_CHARS + 1), LISTINGS)).to.equal(null);
    expect(decodeStrategy(Buffer.from(JSON.stringify({ s: "x", r: "reckless", w: [], b: 5, t: 10, d: 30 })).toString("base64url"), LISTINGS)).to.equal(null);
    // A link may claim anything; converting it to a mandate validates and normalizes it like any draft.
    const wild = Buffer.from(JSON.stringify({ s: "all in", r: "aggressive", w: [["TSLA", 300], ["DOGE", 50]], b: 90, t: 500, d: 900 })).toString("base64url");
    const p = decodeStrategy(wild, LISTINGS)!;
    const universe = LISTINGS.map((l) => ({ ...l, token: "0x0000000000000000000000000000000000000001" as const, feed: "0x0000000000000000000000000000000000000002" as const, stable: "stable" in l }));
    const { mandate } = toMandate(p, universe, 10_000);
    expect(mandate.assets.reduce((t, a) => t + a.targetBps, 0)).to.equal(10_000);
    expect(mandate.assets.every((a) => a.bandBps <= 5_000)).to.equal(true);
  });
});
