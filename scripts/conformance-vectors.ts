// Generates solana/mandate-core/tests/vectors.json: random scenarios judged by agent/model.ts, which
// test/model.test.ts proves equal to the EVM contract. The Rust crate must reproduce every verdict.
//
//   npm run vectors     (deterministic: the same seed always writes the same file)

import { writeFileSync } from "node:fs";
import { BPS, WAD, amountFor, check, valueOf, type AssetState, type VaultState } from "../agent/model";
import { largestRemainder } from "../agent/mandate";

let seed = 20261012;
const rand = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
const usd = (x: number) => BigInt(Math.round(x * 1e6)) * 10n ** 12n;
const addr = (i: number) => `0x${(i + 1).toString(16).padStart(40, "0")}` as const;

const vectors: unknown[] = [];
const counts: Record<string, number> = {};
const N = 3_000;
for (let v = 0; v < N; v++) {
  const n = int(2, 8);
  const now = BigInt(int(2_000_000, 3_000_000));
  const maxPriceAge = int(60, 7_200);
  const targets = largestRemainder(Array.from({ length: n }, () => rand() * 10 + (rand() < 0.15 ? 0 : 0.5)), 10_000);
  const assets: AssetState[] = Array.from({ length: n }, (_, i) => {
    const decimals = pick([6, 8, 9, 18]);
    const price = usd(i === 0 ? 1 : 0.5 + rand() * 1500);
    return {
      token: addr(i),
      symbol: `A${i}`,
      decimals,
      balance: amountFor(usd(rand() < 0.02 ? 0 : rand() * 6_000), price, decimals),
      price,
      priceUpdatedAt: now - BigInt(rand() < 0.015 ? maxPriceAge + int(1, 5_000) : int(0, maxPriceAge)),
      targetBps: targets[i],
      bandBps: int(0, 3_000),
    };
  });
  const daily = usd(int(500, 30_000));
  const state: VaultState = {
    address: addr(99),
    assets,
    limits: { maxTradeUsd: usd(int(100, 10_000)), dailyLimitUsd: daily, maxSlippageBps: int(0, 1_000), maxPriceAge, cooldown: int(0, 600) },
    lastTradeAt: rand() < 0.4 ? 0n : now - BigInt(int(0, 1_200)),
    budgetUsd: (daily * BigInt(int(0, 1000))) / 1000n,
    budgetUpdatedAt: now - BigInt(int(0, 200_000)),
    paused: rand() < 0.04,
    now,
  };
  const sellIdx = int(0, n - 1);
  let buyIdx = rand() < 0.03 ? sellIdx : int(0, n - 1);
  while (buyIdx === sellIdx && rand() > 0.03) buyIdx = int(0, n - 1);
  if (rand() < 0.02) buyIdx = n + int(0, 2); // not in the mandate
  const sell = assets[sellIdx];
  const r = rand();
  const amountIn = r < 0.02 ? 0n : r < 0.06 ? sell.balance + 1n + BigInt(int(0, 1000)) : (sell.balance * BigInt(int(1, 700))) / 1000n;
  const buy = assets[buyIdx];
  const feeBps = BigInt(int(-20, 200));
  const amountOut = buy ? amountFor((valueOf(amountIn, sell.price, sell.decimals) * (BPS - feeBps)) / BPS, buy.price, buy.decimals) : 0n;
  const minAmountOut = rand() < 0.05 ? amountOut + 1n : rand() < 0.5 ? 0n : (amountOut * 99n) / 100n;

  const verdict = check(state, { tokenIn: sell.token, tokenOut: buy?.token ?? addr(50 + buyIdx), amountIn }, amountOut, minAmountOut);
  const expected = verdict.ok ? "ok" : verdict.reason;
  counts[expected] = (counts[expected] ?? 0) + 1;
  vectors.push({
    assets: assets.map((a) => ({ balance: String(a.balance), price: String(a.price), decimals: a.decimals, price_updated_at: Number(a.priceUpdatedAt), target_bps: a.targetBps, band_bps: a.bandBps })),
    limits: { max_trade_usd: String(state.limits.maxTradeUsd), daily_limit_usd: String(state.limits.dailyLimitUsd), max_slippage_bps: state.limits.maxSlippageBps, max_price_age: state.limits.maxPriceAge, cooldown: state.limits.cooldown },
    clock: { now: Number(now), last_trade_at: Number(state.lastTradeAt), budget_usd: String(state.budgetUsd), budget_updated_at: Number(state.budgetUpdatedAt) },
    paused: state.paused,
    trade: { sell: sellIdx, buy: buyIdx, amount_in: String(amountIn) },
    amount_out: String(amountOut),
    min_amount_out: String(minAmountOut),
    expected,
    value_in: verdict.ok ? String(verdict.valueIn) : null,
    value_out: verdict.ok ? String(verdict.valueOut) : null,
  });
}
writeFileSync("solana/mandate-core/tests/vectors.json", JSON.stringify(vectors));
console.log(`wrote ${N} vectors:`, counts);
void WAD;
