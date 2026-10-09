// The pilot writes to the owner: what it did since its last letter, from figures read onchain (in Claude's words when
// ANTHROPIC_API_KEY is set, plainly otherwise), published in the pilot journal and signed with the pilot's own key.
// At most one letter per MIN_HOURS (default 20), so the hourly demo pilot writes about once a day.
//
//   PRIVATE_KEY=<pilot key> [VAULT=0x...] npx hardhat run scripts/pilot-letter.ts --network robinhoodTestnet
//   (VAULT defaults to the deployment's demo vault)

import hre from "hardhat";
import { readFileSync } from "node:fs";
import type { Abi, Address } from "viem";
import { digestFacts } from "../agent/digest";
import { blockAtOrBefore, logsInRange } from "../agent/history";
import { composeLetter } from "../agent/letter";
import { writeReport } from "../agent/reporter";

async function main() {
  const d = JSON.parse(readFileSync(`deployments/${hre.network.name}.json`, "utf8"));
  const vaultAddress = (process.env.VAULT ?? d.demoVault) as Address | undefined;
  if (!d.journal || !vaultAddress) return console.log("No pilot journal or no vault for this deployment; nothing to write.");
  const client = await hre.viem.getPublicClient();
  const [me] = await hre.viem.getWalletClients();
  const vault = await hre.viem.getContractAt("PilotVault", vaultAddress);
  const journal = await hre.viem.getContractAt("PilotJournal", d.journal as Address);
  if ((await vault.read.pilot()).toLowerCase() !== me.account.address.toLowerCase()) return console.log("This key isn't the vault's pilot; only its pilot may write.");

  const minHours = Number(process.env.MIN_HOURS ?? 20);
  const last = Number(await journal.read.lastLetterAt([vault.address]));
  const now = Number((await client.getBlock()).timestamp);
  if (last && now - last < minHours * 3600) return console.log(`Last letter ${Math.round((now - last) / 3600)} h ago; the next one is due after ${minHours} h.`);

  // Cover the blocks since the last letter, or since the deployment went out (found by time in older deployment files).
  const head = await client.getBlockNumber();
  const start =
    d.startBlock !== undefined ? BigInt(d.startBlock) : d.deployedAt ? await blockAtOrBefore(client, Date.parse(d.deployedAt) / 1000 - 3_600) : 0n;
  const letters = await logsInRange((fromBlock, toBlock) => journal.getEvents.Letter({ vault: vault.address }, { fromBlock, toBlock }), start, head);
  const fromBlock = letters.length ? letters[letters.length - 1].args.toBlock! + 1n : start;

  const { facts } = await digestFacts(client, vault.abi as Abi, vault.address, fromBlock);
  facts.period = letters.length ? "the time since my last letter" : "the time since this vault opened";
  const { report, source } = await writeReport(facts);
  let pilotName = "Your pilot";
  if (d.registry) {
    const registry = await hre.viem.getContractAt("PilotRegistry", d.registry as Address);
    const entry = await registry.read.pilotOf([me.account.address]);
    if (entry.name) pilotName = entry.name;
  }
  const text = composeLetter(report, { vault: vault.address, pilotName, written: source });
  await client.waitForTransactionReceipt({ hash: await journal.write.post([vault.address, fromBlock, head, text]) });
  console.log(`Letter #${await journal.read.letterCount([vault.address])} published (${source}), covering blocks ${fromBlock}-${head}:\n\n${text}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
