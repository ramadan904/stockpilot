// Add the Verified Mandate contract to a deployment that predates it, and record it in deployments/<network>.json.
// A no-op when the deployment already has one.
//
//   npx hardhat run scripts/deploy-credential.ts --network robinhoodTestnet   (PRIVATE_KEY = any funded testnet key)

import hre from "hardhat";
import { readFileSync, writeFileSync } from "node:fs";
import type { Address } from "viem";
import { CREDENTIAL_MIN_AGE } from "./lib/stack";

async function main() {
  const file = `deployments/${hre.network.name}.json`;
  const d = JSON.parse(readFileSync(file, "utf8"));
  if (d.credential) return console.log(`Verified Mandate already at ${d.credential}.`);
  const credential = await hre.viem.deployContract("MandateCredential", [d.factory as Address, CREDENTIAL_MIN_AGE]);
  writeFileSync(file, JSON.stringify({ ...d, credential: credential.address }, null, 2));
  console.log(`Verified Mandate deployed at ${credential.address}; recorded in ${file}.`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
