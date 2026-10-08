// Bring a deployment up to date with contracts added after it went out (Verified Mandate, the pilot journal), and
// record them in deployments/<network>.json. Each one is deployed only if missing, so this is safe to run every time.
//
//   npx hardhat run scripts/deploy-addons.ts --network robinhoodTestnet   (PRIVATE_KEY = any funded testnet key)

import hre from "hardhat";
import { readFileSync, writeFileSync } from "node:fs";
import type { Address } from "viem";
import { CREDENTIAL_MIN_AGE } from "./lib/stack";

async function main() {
  const file = `deployments/${hre.network.name}.json`;
  const d = JSON.parse(readFileSync(file, "utf8"));
  const factory = d.factory as Address;
  const addons: [field: string, name: string, deploy: () => Promise<{ address: Address }>][] = [
    ["credential", "Verified Mandate", () => hre.viem.deployContract("MandateCredential", [factory, CREDENTIAL_MIN_AGE])],
    ["journal", "Pilot journal", () => hre.viem.deployContract("PilotJournal", [factory])],
  ];
  for (const [field, name, deploy] of addons) {
    if (d[field]) {
      console.log(`${name} already at ${d[field]}.`);
      continue;
    }
    d[field] = (await deploy()).address;
    writeFileSync(file, JSON.stringify(d, null, 2));
    console.log(`${name} deployed at ${d[field]}; recorded in ${file}.`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
