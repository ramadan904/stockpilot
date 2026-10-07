import { expect } from "chai";
import { DEFAULT_POLICY, decide, fetchQuotes, resolveEquityIds, toEightDecimals } from "../agent/relayer";

const quote = (answer: bigint, publishTime: number, conf = 1_000_000n) => ({ id: "0xabc", answer, conf, publishTime });
const NOW = 1_800_000_000;

describe("agent/relayer", () => {
  it("pushes a price that moved past the deviation threshold", () => {
    const d = decide({ answer: 25_000_000_000n, updatedAt: NOW - 60 }, quote(25_100_000_000n, NOW - 5), NOW);
    expect(d).to.deep.equal({ push: true, why: "moved 0.40%" });
  });

  it("skips small moves until the heartbeat is due", () => {
    const onchain = { answer: 25_000_000_000n, updatedAt: NOW - 60 };
    expect(decide(onchain, quote(25_010_000_000n, NOW - 5), NOW).push).to.equal(false);
    expect(decide({ ...onchain, updatedAt: NOW - DEFAULT_POLICY.heartbeatSec }, quote(25_010_000_000n, NOW - 5), NOW)).to.deep.equal({
      push: true,
      why: "heartbeat",
    });
  });

  it("lets the onchain price age when the market is closed, so the vault stops trading", () => {
    const d = decide({ answer: 25_000_000_000n, updatedAt: NOW - 7_200 }, quote(26_000_000_000n, NOW - 3_600), NOW);
    expect(d.push).to.equal(false);
    expect(d.why).to.match(/market closed/);
  });

  it("replaces a newer-stamped placeholder with a fresh real price, but ignores older small moves", () => {
    // Feed deployed a moment ago at a $250 placeholder; the real price is $262.40, published 2 seconds earlier.
    expect(decide({ answer: 25_000_000_000n, updatedAt: NOW }, quote(26_240_000_000n, NOW - 2), NOW).push).to.equal(true);
    expect(decide({ answer: 25_000_000_000n, updatedAt: NOW }, quote(25_010_000_000n, NOW - 2), NOW).why).to.equal("onchain price is as new");
  });

  it("refuses unreliable quotes", () => {
    expect(decide({ answer: 25_000_000_000n, updatedAt: NOW - 600 }, quote(26_000_000_000n, NOW - 1, 1_000_000_000n), NOW).why).to.equal(
      "confidence interval too wide",
    );
    expect(decide({ answer: 25_000_000_000n, updatedAt: NOW - 600 }, quote(0n, NOW - 1), NOW).push).to.equal(false);
  });

  it("scales Pyth exponents to 8 decimals", () => {
    expect(toEightDecimals(25_012_345n, -5)).to.equal(25_012_345_000n);
    expect(toEightDecimals(2_501_234_567_890n, -10)).to.equal(25_012_345_678n);
  });

  it("reads Hermes's search and price responses", async () => {
    const calls: string[] = [];
    const fake = (async (url: string) => {
      calls.push(url);
      if (url.includes("/v2/price_feeds")) {
        return Response.json([
          { id: "aaaa", attributes: { symbol: "Equity.GB.TSLA/USD", asset_type: "Equity" } },
          { id: "bbbb", attributes: { symbol: "Equity.US.TSLA/USD", asset_type: "Equity" } },
        ]);
      }
      return Response.json({
        binary: { encoding: "hex", data: [] },
        parsed: [{ id: "bbbb", price: { price: "25012345", conf: "12000", expo: -5, publish_time: NOW - 3 } }],
      });
    }) as unknown as typeof fetch;

    const ids = await resolveEquityIds(["TSLA"], fake, "https://hermes.test");
    expect(ids).to.deep.equal({ TSLA: "0xbbbb" });
    const [q] = await fetchQuotes([ids.TSLA], fake, "https://hermes.test");
    expect(q).to.deep.equal({ id: "0xbbbb", answer: 25_012_345_000n, conf: 12_000_000n, publishTime: NOW - 3 });
    expect(calls[1]).to.equal("https://hermes.test/v2/updates/price/latest?ids[]=0xbbbb&parsed=true");
  });

  it("explains when a symbol has no US equity feed", async () => {
    const fake = (async () => Response.json([])) as unknown as typeof fetch;
    let err = "";
    await resolveEquityIds(["XYZ"], fake).catch((e) => (err = (e as Error).message));
    expect(err).to.include("Equity.US.XYZ/USD").and.include("PYTH_IDS");
  });
});
