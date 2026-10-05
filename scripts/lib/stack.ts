// Deploys the testnet stack: stand-in stock tokens and feeds, a market maker that fills at oracle prices, and the
// vault factory. On a chain with real tokenized stocks, only PilotVaultFactory and a real venue adapter are needed.

import type { HardhatRuntimeEnvironment } from "hardhat/types";
import { parseUnits, type Address } from "viem";
import type { UniverseAsset } from "../../agent/strategist";

export const LISTINGS = [
  { symbol: "USDG", name: "Global Dollar", decimals: 6, price: 1, profile: "USD stablecoin; no price risk", stable: true },
  { symbol: "TSLA", name: "Tesla", decimals: 18, price: 250, profile: "EV and energy maker; very volatile" },
  { symbol: "AAPL", name: "Apple", decimals: 18, price: 230, profile: "consumer hardware and services; steady large-cap" },
  { symbol: "NVDA", name: "NVIDIA", decimals: 18, price: 180, profile: "AI and data-centre chips; volatile, high growth" },
  { symbol: "SPY", name: "S&P 500 ETF", decimals: 18, price: 660, profile: "broad US market index fund; diversified" },
] as const;

export async function deployStack(hre: HardhatRuntimeEnvironment) {
  const v = hre.viem;
  const tokens: Record<string, Address> = {};
  const feeds: Record<string, Address> = {};
  const mm = await v.deployContract("OracleMarketMaker", [10n]); // 0.1% fee

  for (const l of LISTINGS) {
    const token = await v.deployContract("MockERC20", [`${l.name} (StockPilot testnet)`, l.symbol, l.decimals]);
    const price = parseUnits(String(l.price), 8);
    const feed = "stable" in l
      ? await v.deployContract("FixedPriceFeed", [`${l.symbol} / USD`, 8, price])
      : await v.deployContract("MockPriceFeed", [`${l.symbol} / USD`, 8, price]);
    await mm.write.setFeed([token.address, feed.address]);
    // Inventory worth about $5M per asset, so the venue never runs dry.
    await token.write.mint([mm.address, parseUnits(String(Math.ceil(5_000_000 / l.price)), l.decimals)]);
    tokens[l.symbol] = token.address;
    feeds[l.symbol] = feed.address;
  }

  const factory = await v.deployContract("PilotVaultFactory");
  return { tokens, feeds, marketMaker: mm.address, factory: factory.address };
}

export type Stack = Awaited<ReturnType<typeof deployStack>>;

export function universeOf(stack: Stack): UniverseAsset[] {
  return LISTINGS.map((l) => ({
    symbol: l.symbol,
    name: l.name,
    token: stack.tokens[l.symbol] as Address,
    feed: stack.feeds[l.symbol] as Address,
    profile: l.profile,
    stable: "stable" in l,
  }));
}
