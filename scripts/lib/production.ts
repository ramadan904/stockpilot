// Deploys StockPilot onto a chain with real assets: the factory, a Uniswap V3 venue adapter, and one price feed per
// asset (Pyth, an existing Chainlink feed, or a fixed $1 for a stablecoin). Driven by a JSON config so the same code
// deploys to any chain; see deploy/production.example.json.

import type { HardhatRuntimeEnvironment } from "hardhat/types";
import { getAddress, isAddress, isHex, parseUnits, type Address, type Hex } from "viem";
import { LISTINGS } from "../../agent/listings";

export type FeedSource =
  | { type: "chainlink"; address: Address }
  | { type: "pyth"; id: Hex; maxConfBps?: number }
  | { type: "fixed"; usd: number };

export interface ProductionConfig {
  network: string;
  swapRouter: Address;
  pyth?: Address;
  assets: { symbol: string; token: Address; feed: FeedSource }[];
  /** Default single-hop pools for routeless trades, by symbol. */
  pools: { a: string; b: string; fee: number }[];
}

export function validateConfig(c: ProductionConfig): string[] {
  const errors: string[] = [];
  const known = new Set<string>(LISTINGS.map((l) => l.symbol));
  if (!isAddress(c.swapRouter)) errors.push("swapRouter is not an address");
  for (const a of c.assets) {
    if (!known.has(a.symbol)) errors.push(`${a.symbol}: not in agent/listings.ts (add it there first)`);
    if (!isAddress(a.token)) errors.push(`${a.symbol}: token is not an address`);
    if (a.feed.type === "chainlink" && !isAddress(a.feed.address)) errors.push(`${a.symbol}: feed address invalid`);
    if (a.feed.type === "pyth" && (!c.pyth || !isAddress(c.pyth))) errors.push(`${a.symbol}: a Pyth feed needs "pyth" set`);
    if (a.feed.type === "pyth" && !(isHex(a.feed.id) && a.feed.id.length === 66)) errors.push(`${a.symbol}: Pyth id must be 32 bytes`);
  }
  const symbols = new Set(c.assets.map((a) => a.symbol));
  for (const p of c.pools) {
    if (!symbols.has(p.a) || !symbols.has(p.b)) errors.push(`pool ${p.a}/${p.b}: unknown symbol`);
    if (![100, 500, 3000, 10000].includes(p.fee)) errors.push(`pool ${p.a}/${p.b}: unusual fee tier ${p.fee}`);
  }
  return errors;
}

export async function deployProduction(hre: HardhatRuntimeEnvironment, c: ProductionConfig) {
  const errors = validateConfig(c);
  if (errors.length) throw new Error(`Invalid config:\n- ${errors.join("\n- ")}`);
  const v = hre.viem;

  const factory = await v.deployContract("PilotVaultFactory");
  const registry = await v.deployContract("PilotRegistry");
  const adapter = await v.deployContract("UniswapV3Adapter", [c.swapRouter]);
  const tokens: Record<string, Address> = {};
  const feeds: Record<string, Address> = {};

  for (const a of c.assets) {
    tokens[a.symbol] = getAddress(a.token);
    if (a.feed.type === "chainlink") {
      feeds[a.symbol] = getAddress(a.feed.address);
    } else if (a.feed.type === "pyth") {
      const feed = await v.deployContract("PythPriceFeed", [c.pyth!, a.feed.id, BigInt(a.feed.maxConfBps ?? 100), `${a.symbol} / USD (Pyth)`]);
      feeds[a.symbol] = feed.address;
    } else {
      const feed = await v.deployContract("FixedPriceFeed", [`${a.symbol} / USD (fixed)`, 8, parseUnits(String(a.feed.usd), 8)]);
      feeds[a.symbol] = feed.address;
    }
  }
  for (const p of c.pools) await adapter.write.setPoolFee([tokens[p.a], tokens[p.b], p.fee]);

  return { factory: factory.address, registry: registry.address, venue: adapter.address, marketMaker: adapter.address, tokens, feeds };
}
