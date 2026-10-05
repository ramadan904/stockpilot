import hre from "hardhat";
import { expect } from "chai";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers";
import { parseUnits } from "viem";
import { readVault } from "../agent/chain";
import { check } from "../agent/model";
import { deployStockPilot, px, usd } from "./fixture";

/** Small seeded PRNG so a failure reproduces exactly. */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("agent/model matches PilotVault", () => {
  async function fixture() {
    const f = await deployStockPilot();
    await f.vault.write.setMandate([
      f.mandate.map((m, i) => ({ ...m, bandBps: [300, 500, 800, 1200][i] })),
      { maxTradeUsd: usd(3_000), dailyLimitUsd: usd(1_000_000), maxSlippageBps: 80, maxPriceAge: 3_600, cooldown: 0 },
    ]);
    return f;
  }

  /** Tight budget and a cooldown, with the clock jumping around: exercises the rolling budget, cooldown and staleness. */
  async function timeFixture() {
    const f = await deployStockPilot();
    await f.vault.write.setMandate([
      f.mandate.map((m) => ({ ...m, bandBps: 2000 })),
      { maxTradeUsd: usd(3_000), dailyLimitUsd: usd(2_500), maxSlippageBps: 80, maxPriceAge: 3_600, cooldown: 120 },
    ]);
    return f;
  }

  for (const [seed, fx, label] of [
    [1, fixture, "band and slippage"],
    [2, fixture, "band and slippage"],
    [3, fixture, "band and slippage"],
    [4, timeFixture, "budget, cooldown and stale prices"],
    [5, timeFixture, "budget, cooldown and stale prices"],
  ] as const) {
    it(`agrees on 120 random trades: ${label} (seed ${seed})`, async () => {
      const f = await loadFixture(fx);
      const rand = rng(seed);
      const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
      const stocks = [
        [f.tslaFeed, 250],
        [f.aaplFeed, 200],
        [f.nvdaFeed, 125],
      ] as const;
      const tokens = [f.usdg, f.tsla, f.aapl, f.nvda];
      const outcomes: Record<string, number> = {};

      for (let step = 0; step < 120; step++) {
        if (rand() < 0.25) {
          const [feed, base] = pick(stocks);
          await feed.write.setPrice([px((base * (0.6 + rand() * 0.8)).toFixed(4))]);
        }
        if (rand() < 0.15) await f.mm.write.setFee([BigInt(Math.floor(rand() * 120))]);
        if (fx === timeFixture && rand() < 0.35) {
          await time.increase(Math.floor(rand() * 5_400));
          // Usually the market is open and feeds keep updating; sometimes they go stale.
          if (rand() < 0.8) for (const [feed] of stocks) await feed.write.setPrice([(await feed.read.latestRoundData())[1]]);
        }

        const tokenIn = pick(tokens);
        let tokenOut = pick(tokens);
        while (tokenOut === tokenIn) tokenOut = pick(tokens);
        const balance = await tokenIn.read.balanceOf([f.vault.address]);
        if (balance === 0n) continue;
        const permille = rand() < 0.5 ? 1 + Math.floor(rand() * 100) : 1 + Math.floor(rand() * 600); // small or large
        const amountIn = (balance * BigInt(permille)) / 1000n;
        if (amountIn === 0n) continue;

        const state = await readVault(f.publicClient, f.vault.abi, f.vault.address);
        state.now += 1n; // the trade lands in the next block, at exactly this time
        await time.setNextBlockTimestamp(state.now);
        const amountOut = await f.mm.read.quote([tokenIn.address, tokenOut.address, amountIn]);
        const verdict = check(state, { tokenIn: tokenIn.address, tokenOut: tokenOut.address, amountIn }, amountOut);

        let error: string | undefined;
        try {
          await f.vaultAsPilot.write.rebalance([tokenIn.address, tokenOut.address, amountIn, 0n, "0x", `0x${"00".repeat(32)}`]);
        } catch (e) {
          error = (e as Error).message;
        }
        const label = verdict.ok ? "accepted" : verdict.reason;
        outcomes[label] = (outcomes[label] ?? 0) + 1;
        if (verdict.ok) expect(error, `step ${step}: model accepted, vault reverted`).to.equal(undefined);
        else expect(error, `step ${step}: model said ${verdict.reason}`).to.include(verdict.reason);
      }

      // Make sure the run exercised both sides of the rules, not just one.
      expect(outcomes.accepted ?? 0).to.be.greaterThan(10);
      if (fx === fixture) expect(outcomes.OutsideBand ?? 0).to.be.greaterThan(5);
      else for (const r of ["DailyLimitExceeded", "CooldownActive", "StalePrice"]) expect(outcomes[r] ?? 0, r).to.be.greaterThan(0);
    });
  }

  it("model and vault agree that a 1-wei-too-large trade is too large", async () => {
    const f = await loadFixture(fixture);
    const state = await readVault(f.publicClient, f.vault.abi, f.vault.address);
    const amountIn = parseUnits("12", 18) + 1n; // $3,000 of TSLA at $250, plus one wei
    const amountOut = await f.mm.read.quote([f.tsla.address, f.usdg.address, amountIn]);
    expect(check(state, { tokenIn: f.tsla.address, tokenOut: f.usdg.address, amountIn }, amountOut)).to.deep.include({
      ok: false,
      reason: "TradeTooLarge",
    });
    await expect(
      f.vaultAsPilot.write.rebalance([f.tsla.address, f.usdg.address, amountIn, 0n, "0x", `0x${"00".repeat(32)}`]),
    ).to.be.rejectedWith("TradeTooLarge");
    void hre;
  });
});
