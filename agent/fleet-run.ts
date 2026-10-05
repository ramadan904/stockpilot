// The hosted pilot service, live:
//
//   PRIVATE_KEY=<pilot key> npx hardhat run agent/fleet-run.ts --network robinhoodTestnet
//
// Reads the factory from deployments/<network>.json (or FACTORY). Optional: INTERVAL (seconds, default 60),
// MIN_FEE_BPS (serve only vaults paying at least this to this pilot), WEBHOOK_URL (Slack, Discord or any JSON
// endpoint), FEE_EVERY_HOURS (collect fees this often, default 24), ONCE=1.

import hre from "hardhat";
import { existsSync, readFileSync } from "node:fs";
import type { Address } from "viem";
import { collectFees, describe, fleetTick, webhookNotifier, type FleetConfig } from "./fleet";
import { appendLog } from "./log";

async function main() {
  const file = `deployments/${hre.network.name}.json`;
  const factory = (process.env.FACTORY ?? (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).factory : undefined)) as Address | undefined;
  if (!factory) throw new Error(`Set FACTORY, or deploy first so ${file} exists.`);
  const [wallet] = await hre.viem.getWalletClients();
  const client = await hre.viem.getPublicClient();
  const vaultAbi = (await hre.artifacts.readArtifact("PilotVault")).abi;
  const factoryAbi = (await hre.artifacts.readArtifact("PilotVaultFactory")).abi;
  const interval = Number(process.env.INTERVAL ?? 60) * 1000;
  const feeEvery = Number(process.env.FEE_EVERY_HOURS ?? 24) * 3_600_000;

  const cfg: FleetConfig = {
    client: client as never,
    wallet: wallet as never,
    vaultAbi,
    factoryAbi,
    factory,
    minFeeBps: Number(process.env.MIN_FEE_BPS ?? 0),
    notify: process.env.WEBHOOK_URL ? webhookNotifier(process.env.WEBHOOK_URL) : undefined,
    onTrade: (t) => appendLog(t.vault, { tx: t.tx, rationale: t.rationale, rationaleHash: t.rationaleHash }),
  };
  console.log(`Fleet pilot ${wallet.account.address} on ${hre.network.name}, factory ${factory}`);

  let lastFees = 0;
  for (;;) {
    try {
      const events = await fleetTick(cfg);
      console.log(`[${new Date().toISOString()}] ${events.length} vault(s)`);
      for (const e of events) console.log(`  ${describe(e)}`);
      if (Date.now() - lastFees > feeEvery) {
        for (const e of await collectFees(cfg)) console.log(`  ${describe(e)}`);
        lastFees = Date.now();
      }
    } catch (e) {
      console.error(`  tick failed: ${(e as Error).message.split("\n")[0]}`);
    }
    if (process.env.ONCE) break;
    await new Promise((r) => setTimeout(r, interval));
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
