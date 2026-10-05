// npx hardhat run scripts/deploy.ts --network robinhoodTestnet   (PRIVATE_KEY in the environment)
import hre from "hardhat";
import { mkdirSync, writeFileSync } from "node:fs";
import { deployStack } from "./lib/stack";

async function main() {
  const [deployer] = await hre.viem.getWalletClients();
  const chainId = await (await hre.viem.getPublicClient()).getChainId();
  console.log(`Deploying StockPilot to ${hre.network.name} (chain ${chainId}) from ${deployer.account.address}`);
  const stack = await deployStack(hre);
  mkdirSync("deployments", { recursive: true });
  const file = `deployments/${hre.network.name}.json`;
  writeFileSync(file, JSON.stringify({ network: hre.network.name, chainId, deployedAt: new Date().toISOString(), ...stack }, null, 2));
  console.log(JSON.stringify(stack, null, 2));
  console.log(`Saved to ${file}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
