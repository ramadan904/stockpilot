// Move a mock price feed on a local or testnet stack, e.g. to watch the pilot react:
//
//   SYMBOL=NVDA PCT=40 npx hardhat run scripts/move-price.ts --network localhost
//
// The signer must own the feed (the deployer). PCT is the change in percent, negative for a drop.

import hre from "hardhat";
import { readFileSync } from "node:fs";
import type { Address } from "viem";

async function main() {
  const d = JSON.parse(readFileSync(`deployments/${hre.network.name}.json`, "utf8")) as { feeds: Record<string, Address> };
  const symbol = process.env.SYMBOL ?? "NVDA";
  const pct = Number(process.env.PCT ?? 10);
  if (!d.feeds[symbol]) throw new Error(`No feed for ${symbol}; have ${Object.keys(d.feeds).join(", ")}`);
  const feed = await hre.viem.getContractAt("MockPriceFeed", d.feeds[symbol]);
  const [, before] = await feed.read.latestRoundData();
  const after = (before * BigInt(Math.round((100 + pct) * 100))) / 10_000n;
  const client = await hre.viem.getPublicClient();
  await client.waitForTransactionReceipt({ hash: await feed.write.setPrice([after]) });
  console.log(`${symbol}: $${(Number(before) / 1e8).toFixed(2)} -> $${(Number(after) / 1e8).toFixed(2)}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
