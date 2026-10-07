// Give the deployment's demo vault its own pilot, separate from its owner, so the Attack Theater and the read-only
// view show a pilot that is kept from the owner's powers. Run once by the vault's owner:
//
//   npx hardhat run scripts/demo-pilot.ts --network robinhoodTestnet   (asks for nothing; PRIVATE_KEY = the owner)

import hre from "hardhat";
import { readFileSync } from "node:fs";
import type { Address } from "viem";
import { demoPilot, topUpPilot } from "./lib/demo-pilot";

async function main() {
  const d = JSON.parse(readFileSync(`deployments/${hre.network.name}.json`, "utf8"));
  if (!d.demoVault) throw new Error(`No demo vault in deployments/${hre.network.name}.json`);
  const vault = await hre.viem.getContractAt("PilotVault", d.demoVault as Address);
  const client = await hre.viem.getPublicClient();
  const [owner, pilot] = await Promise.all([vault.read.owner(), vault.read.pilot()]);
  const next = demoPilot(hre.network.name);
  if (pilot.toLowerCase() === next.toLowerCase()) {
    console.log(`The demo vault's pilot is already ${next}.`);
    return topUpPilot(hre, next);
  }
  if (pilot.toLowerCase() !== owner.toLowerCase()) return console.log(`The demo vault already has its own pilot, ${pilot}; leaving it.`);
  await client.waitForTransactionReceipt({ hash: await vault.write.setPilot([next]) });
  console.log(`Demo vault ${vault.address}: pilot is now ${next}, separate from its owner ${owner}.`);
  await topUpPilot(hre, next);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
