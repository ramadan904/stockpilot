import { expect } from "chai";
import type { Address } from "viem";
import { proposalFromVault, riskFromCash } from "../agent/copy";
import { toMandate, type UniverseAsset } from "../agent/mandate";
import type { VaultState } from "../agent/model";

const E18 = 10n ** 18n;
const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const asset = (n: number, symbol: string, usd: number, targetBps: number, bandBps: number, decimals = 18) => ({
  token: addr(n),
  symbol,
  decimals,
  balance: (BigInt(usd) * 10n ** BigInt(decimals)),
  price: E18,
  priceUpdatedAt: 0n,
  targetBps,
  bandBps,
});

function vault(totalUsd = 10_000): VaultState {
  const k = totalUsd / 10_000;
  return {
    address: addr(99),
    assets: [asset(1, "USDG", 3000 * k, 3000, 300, 6), asset(2, "NVDA", 4000 * k, 4000, 500), asset(3, "SPY", 3000 * k, 3000, 400)],
    limits: { maxTradeUsd: BigInt(1500 * k) * E18, dailyLimitUsd: BigInt(4000 * k) * E18, maxSlippageBps: 100, maxPriceAge: 3600, cooldown: 600 },
    lastTradeAt: 0n,
    budgetUsd: 0n,
    budgetUpdatedAt: 0n,
    paused: false,
    now: 0n,
  };
}

const from = { vault: "0xfFfEBea2C701CA2cfD406D89580aE984adb0a783", chain: "Robinhood Chain Testnet" };

describe("Copy a vault's mandate", () => {
  it("copies targets, the widest band, and limits as shares of the vault", () => {
    const p = proposalFromVault(vault(), from);
    expect(p.allocations.map((a) => [a.symbol, a.weight_percent])).to.deep.equal([
      ["USDG", 30],
      ["NVDA", 40],
      ["SPY", 30],
    ]);
    expect(p.band_percent).to.equal(5);
    expect(p.max_trade_percent).to.equal(15);
    expect(p.daily_turnover_percent).to.equal(40);
    expect(p.risk_level).to.equal("balanced");
    expect(p.summary).to.contain("0xfFfE…a783").and.contain("Robinhood Chain Testnet");
  });

  it("gives the same shares whatever the copied vault's size, so it fits a vault of any size", () => {
    const small = proposalFromVault(vault(1_000), from);
    const big = proposalFromVault(vault(1_000_000), from);
    expect([small.max_trade_percent, small.daily_turnover_percent]).to.deep.equal([big.max_trade_percent, big.daily_turnover_percent]);
  });

  it("falls back to the usual limits for an empty vault rather than dividing by zero", () => {
    const empty = vault();
    for (const a of empty.assets) a.balance = 0n;
    const p = proposalFromVault(empty, from);
    expect([p.max_trade_percent, p.daily_turnover_percent]).to.deep.equal([10, 30]);
  });

  it("round-trips through the validator: the copy signs into the same targets, scaled to the new vault", () => {
    const universe: UniverseAsset[] = [
      { symbol: "USDG", name: "Global Dollar", token: addr(1), feed: addr(11), profile: "stablecoin", stable: true },
      { symbol: "NVDA", name: "NVIDIA", token: addr(2), feed: addr(12), profile: "AI chips" },
      { symbol: "SPY", name: "S&P 500", token: addr(3), feed: addr(13), profile: "index" },
    ];
    const { mandate, adjustments } = toMandate(proposalFromVault(vault(), from), universe, 20_000);
    expect(mandate.assets.map((a) => a.targetBps)).to.deep.equal([3000, 4000, 3000]);
    expect(mandate.limits.maxTradeUsd).to.equal(3_000n * E18);
    expect(adjustments).to.deep.equal([]);
  });

  it("labels risk by the share in cash", () => {
    expect([60, 30, 15, 5].map(riskFromCash)).to.deep.equal(["conservative", "balanced", "growth", "aggressive"]);
  });
});
