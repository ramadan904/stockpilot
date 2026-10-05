// The pilot, live. Run it with the pilot's key, never the owner's:
//
//   PRIVATE_KEY=<pilot key> VAULT=0x... npx hardhat run agent/run.ts --network robinhoodTestnet
//
// INTERVAL=60 sets seconds between checks; ONCE=1 runs a single check and exits.

import hre from "hardhat";
import type { Address } from "viem";
import { readVault, rationaleHash, sendTrade } from "./chain";
import { appendLog } from "./log";
import { drift, pct, plan } from "./planner";

async function main() {
  const vaultAddress = process.env.VAULT as Address | undefined;
  if (!vaultAddress) throw new Error("Set VAULT to the vault address.");
  const interval = Number(process.env.INTERVAL ?? 60) * 1000;
  const [pilot] = await hre.viem.getWalletClients();
  const client = await hre.viem.getPublicClient();
  const vault = await hre.viem.getContractAt("PilotVault", vaultAddress);

  const assigned = await vault.read.pilot();
  if (assigned.toLowerCase() !== pilot.account.address.toLowerCase()) {
    throw new Error(`This key (${pilot.account.address}) is not the vault's pilot (${assigned}).`);
  }
  console.log(`Piloting ${vaultAddress} on ${hre.network.name} as ${pilot.account.address}`);

  for (;;) {
    try {
      const state = await readVault(client, vault.abi, vault.address);
      const p = plan(state);
      const summary = drift(state)
        .map((d) => `${d.symbol} ${pct(d.weightBps)}/${pct(d.targetBps)}`)
        .join("  ");
      console.log(`[${new Date().toISOString()}] ${summary}`);
      if (p.action === "hold") {
        console.log(`  hold: ${p.reason}`);
      } else {
        console.log(`  trade: ${p.trade.rationale}`);
        const { hash } = await sendTrade(client, pilot, vault.abi, vault.address, p.trade);
        appendLog(vault.address, { tx: hash, rationale: p.trade.rationale, rationaleHash: rationaleHash(p.trade.rationale) });
        console.log(`  sent: ${hash}`);
      }
    } catch (e) {
      // A failed simulation or RPC hiccup must not kill the pilot; the next tick re-reads everything.
      console.error(`  error: ${(e as Error).message.split("\n")[0]}`);
    }
    if (process.env.ONCE) break;
    await new Promise((r) => setTimeout(r, interval));
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
