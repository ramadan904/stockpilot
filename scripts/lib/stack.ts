// Deploys the testnet stack: stand-in stock tokens and feeds, a market maker that fills at oracle prices, and the
// vault factory. On a chain with real tokenized stocks, only PilotVaultFactory and a real venue adapter are needed.

import type { HardhatRuntimeEnvironment } from "hardhat/types";
import { parseUnits, type Address } from "viem";
import type { UniverseAsset } from "../../agent/mandate";
import { LISTINGS } from "../../agent/listings";

/** How long a mandate must stand, unchanged, before it can be verified (seconds). */
export const CREDENTIAL_MIN_AGE = 86_400n;

export { LISTINGS };


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
  const registry = await v.deployContract("PilotRegistry");
  // Verified Mandate: a mandate must stand a day, unchanged, on testnets.
  const credential = await v.deployContract("MandateCredential", [factory.address, CREDENTIAL_MIN_AGE]);
  const journal = await v.deployContract("PilotJournal", [factory.address]);
  const funds = await v.deployContract("PilotFundFactory", [factory.address]);
  return {
    tokens,
    feeds,
    marketMaker: mm.address,
    factory: factory.address,
    registry: registry.address,
    credential: credential.address,
    journal: journal.address,
    funds: funds.address,
  };
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
