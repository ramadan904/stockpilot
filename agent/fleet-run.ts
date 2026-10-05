// The hosted pilot service, live:
//
//   PRIVATE_KEY=<pilot key> npx hardhat run agent/fleet-run.ts --network robinhoodTestnet
//
// Reads the factory from deployments/<network>.json (or FACTORY). Optional: INTERVAL (seconds, default 60),
// MIN_FEE_BPS (serve only vaults paying at least this to this pilot), WEBHOOK_URL (Slack, Discord or any JSON
// endpoint), FEE_EVERY_HOURS (collect fees this often, default 24), ONCE=1.
//
// Owner alerts: SUBSCRIPTIONS points at a JSON array of subscriptions signed by vault owners (the web app produces
// them; see agent/alerts.ts). Each owner gets their vault's trades and errors, and a daily digest if they asked.
// Email goes through Resend when RESEND_API_KEY is set (ALERT_FROM sets the sender); webhooks need nothing.

import hre from "hardhat";
import { existsSync, readFileSync } from "node:fs";
import type { Address } from "viem";
import { activeSubscriptions, deliverDigest, digestDue, routedNotifier, type EmailConfig, type Subscription } from "./alerts";
import { digestFacts } from "./digest";
import { collectFees, describe, fleetTick, webhookNotifier, type FleetConfig, type FleetEvent } from "./fleet";
import { writeReport } from "./reporter";
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

  const email: EmailConfig = { apiKey: process.env.RESEND_API_KEY, from: process.env.ALERT_FROM ?? "StockPilot <alerts@example.com>" };
  let subs = new Map<string, Subscription>();
  const readOwner = (v: Address) => client.readContract({ address: v, abi: vaultAbi, functionName: "owner" }) as Promise<Address>;
  const reloadSubs = async () => {
    if (!process.env.SUBSCRIPTIONS || !existsSync(process.env.SUBSCRIPTIONS)) return;
    subs = await activeSubscriptions(JSON.parse(readFileSync(process.env.SUBSCRIPTIONS, "utf8")), readOwner);
  };
  const operator = process.env.WEBHOOK_URL ? webhookNotifier(process.env.WEBHOOK_URL) : undefined;
  const owners = routedNotifier(() => subs, email);
  const digestSent = new Map<string, number>();
  const digestFrom = new Map<string, bigint>();

  const cfg: FleetConfig = {
    client: client as never,
    wallet: wallet as never,
    vaultAbi,
    factoryAbi,
    factory,
    minFeeBps: Number(process.env.MIN_FEE_BPS ?? 0),
    notify: async (e: FleetEvent) => {
      await operator?.(e);
      await owners(e);
    },
    onTrade: (t) => appendLog(t.vault, { tx: t.tx, rationale: t.rationale, rationaleHash: t.rationaleHash }),
  };
  console.log(`Fleet pilot ${wallet.account.address} on ${hre.network.name}, factory ${factory}`);

  let lastFees = 0;
  for (;;) {
    try {
      await reloadSubs();
      const events = await fleetTick(cfg);
      console.log(`[${new Date().toISOString()}] ${events.length} vault(s)`);
      for (const e of events) console.log(`  ${describe(e)}`);
      if (Date.now() - lastFees > feeEvery) {
        for (const e of await collectFees(cfg)) console.log(`  ${describe(e)}`);
        lastFees = Date.now();
      }
      const now = Math.floor(Date.now() / 1000);
      for (const sub of subs.values()) {
        if (!sub.digest || !digestDue(digestSent, sub.vault, now)) continue;
        const head = await client.getBlockNumber();
        const from = digestFrom.get(sub.vault.toLowerCase()) ?? (head > 50_000n ? head - 50_000n : 0n);
        const { facts, head: upTo } = await digestFacts(client as never, vaultAbi, sub.vault as Address, from);
        const { report } = await writeReport(facts);
        await deliverDigest(sub, report, email);
        digestSent.set(sub.vault.toLowerCase(), now);
        digestFrom.set(sub.vault.toLowerCase(), upTo + 1n);
        console.log(`  digest sent for ${sub.vault}: ${report.headline}`);
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
