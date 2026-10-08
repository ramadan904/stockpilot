// Move the demo vault toward its Verified Mandate: start the clock if it isn't running on the current mandate, and
// mint the credential once it has stood long enough. Safe to run often (the hourly demo pilot does); PRIVATE_KEY is the
// demo vault's owner.
//
//   npx hardhat run scripts/demo-credential.ts --network robinhoodTestnet

import hre from "hardhat";
import { readFileSync } from "node:fs";
import type { Address } from "viem";

async function main() {
  const d = JSON.parse(readFileSync(`deployments/${hre.network.name}.json`, "utf8"));
  if (!d.demoVault || !d.credential) return console.log("No demo vault or no Verified Mandate contract in this deployment.");
  const client = await hre.viem.getPublicClient();
  const [me] = await hre.viem.getWalletClients();
  const vault = await hre.viem.getContractAt("PilotVault", d.demoVault as Address);
  const credential = await hre.viem.getContractAt("MandateCredential", d.credential as Address);
  if ((await vault.read.owner()).toLowerCase() !== me.account.address.toLowerCase()) return console.log("This key doesn't own the demo vault.");

  const version = await vault.read.mandateVersion();
  const existing = await credential.read.credentialOf([vault.address, version]);
  if (existing > 0n) return console.log(`Verified Mandate #${existing} already issued for version ${version}.`);
  const [enrolledVersion, at] = await credential.read.enrollments([vault.address]);
  if (at === 0n || enrolledVersion !== version) {
    await client.waitForTransactionReceipt({ hash: await credential.write.enroll([vault.address]) });
    return console.log(`Started the Verified Mandate clock on version ${version}.`);
  }
  const eligibleAt = at + (await credential.read.minAge());
  const now = (await client.getBlock()).timestamp;
  if (now < eligibleAt) return console.log(`Clock running; the credential can be minted in ${Math.ceil(Number(eligibleAt - now) / 3600)} h.`);
  await client.waitForTransactionReceipt({ hash: await credential.write.issue([vault.address]) });
  console.log(`Minted the Verified Mandate for the demo vault, version ${version}.`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
