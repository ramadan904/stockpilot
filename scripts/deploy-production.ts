// CONFIG=deploy/robinhood.json PRIVATE_KEY=... npx hardhat run scripts/deploy-production.ts --network robinhood
import hre from "hardhat";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { deployProduction, type ProductionConfig } from "./lib/production";

async function main() {
  const path = process.env.CONFIG;
  if (!path) throw new Error("Set CONFIG to a deploy/*.json file (see deploy/production.example.json).");
  const config: ProductionConfig = JSON.parse(readFileSync(path, "utf8"));
  const chainId = await (await hre.viem.getPublicClient()).getChainId();
  console.log(`Deploying StockPilot (production) to ${hre.network.name}, chain ${chainId}`);
  const out = await deployProduction(hre, config);
  mkdirSync("deployments", { recursive: true });
  const file = `deployments/${hre.network.name}.json`;
  writeFileSync(file, JSON.stringify({ network: hre.network.name, chainId, production: true, deployedAt: new Date().toISOString(), ...out }, null, 2));
  console.log(JSON.stringify(out, null, 2));
  console.log(`Saved to ${file}. The contracts are unaudited: keep deposits small until they are.`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
