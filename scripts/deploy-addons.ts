// Bring a deployment up to date with contracts added after it went out (Verified Mandate, the pilot journal, pilot funds), and
// record them in deployments/<network>.json. Each one is deployed only if missing, so this is safe to run every time.
// The journal, which holds no funds, is also replaced when its code no longer matches this build; the old address is
// kept in `pastJournals`, so the app still shows the trade reasons published there. Older files also get `startBlock`.
//
//   npx hardhat run scripts/deploy-addons.ts --network robinhoodTestnet   (PRIVATE_KEY = any funded testnet key)

import hre from "hardhat";
import { readFileSync, writeFileSync } from "node:fs";
import type { Address } from "viem";
import { checkCode } from "../agent/codecheck";
import { blockAtOrBefore } from "../agent/history";
import { CODE_PRINTS } from "../web/src/codeprints";
import { CREDENTIAL_MIN_AGE } from "./lib/stack";

async function main() {
  const file = `deployments/${hre.network.name}.json`;
  const d = JSON.parse(readFileSync(file, "utf8"));
  const save = () => writeFileSync(file, JSON.stringify(d, null, 2));
  const client = await hre.viem.getPublicClient();
  const factory = d.factory as Address;

  if (d.startBlock === undefined && d.deployedAt) {
    // An hour's margin: the file is written as the deploy finishes, after its first transactions.
    d.startBlock = Number(await blockAtOrBefore(client, Date.parse(d.deployedAt) / 1000 - 3_600));
    save();
    console.log(`History starts at block ${d.startBlock}; recorded in ${file}.`);
  }

  if (d.journal && (await checkCode(client, d.journal, CODE_PRINTS.PilotJournal)) === "different") {
    console.log(`Pilot journal at ${d.journal} runs older code; deploying this build's.`);
    d.pastJournals = [...(d.pastJournals ?? []), d.journal];
    delete d.journal;
    save();
  }

  const addons: [field: string, name: string, deploy: () => Promise<{ address: Address }>][] = [
    ["credential", "Verified Mandate", () => hre.viem.deployContract("MandateCredential", [factory, CREDENTIAL_MIN_AGE])],
    ["journal", "Pilot journal", () => hre.viem.deployContract("PilotJournal", [factory])],
    ["funds", "Pilot funds", () => hre.viem.deployContract("PilotFundFactory", [factory])],
  ];
  for (const [field, name, deploy] of addons) {
    if (d[field]) {
      console.log(`${name} already at ${d[field]}.`);
      continue;
    }
    d[field] = (await deploy()).address;
    save();
    console.log(`${name} deployed at ${d[field]}; recorded in ${file}.`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
