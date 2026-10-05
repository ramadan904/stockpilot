// The hosted pilot service, live:
//
//   PRIVATE_KEY=<pilot key> npx hardhat run agent/fleet-run.ts --network robinhoodTestnet
//
// Reads the factory from deployments/<network>.json (or FACTORY). Optional: INTERVAL (seconds, default 60),
// MIN_FEE_BPS (serve only vaults paying at least this to this pilot), WEBHOOK_URL (Slack, Discord or any JSON
// endpoint), FEE_EVERY_HOURS (collect fees this often, default 24), ONCE=1, HEALTH_PORT (serve /health and /metrics;
// see docs/OPERATIONS.md).
//
// Marketplace: with PILOT_NAME (and optionally PILOT_URI), the pilot lists itself in the PilotRegistry from
// deployments/<network>.json (or REGISTRY) at start-up, asking MIN_FEE_BPS, and updates the entry when these change.
//
// Owner alerts: SUBSCRIPTIONS points at a JSON array of subscriptions signed by vault owners (the web app produces
// them; see agent/alerts.ts). Each owner gets their vault's trades and errors, and a daily digest if they asked.
// Owners who named an heir are reminded to check in before the heir can claim.
// Email goes through Resend when RESEND_API_KEY is set (ALERT_FROM sets the sender); webhooks need nothing.

import hre from "hardhat";
import { existsSync, readFileSync } from "node:fs";
import type { Address } from "viem";
import { activeSubscriptions, checkInReminder, deliverDigest, deliverReminder, digestDue, routedNotifier, type EmailConfig, type Subscription } from "./alerts";
import { digestFacts } from "./digest";
import { collectFees, describe, fleetTick, webhookNotifier, type FleetConfig, type FleetEvent } from "./fleet";
import { writeReport } from "./reporter";
import { appendLog } from "./log";
import { registrationNeeded } from "./pilots";
import { count, runService } from "./service";

async function main() {
  const file = `deployments/${hre.network.name}.json`;
  const deployment = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const factory = (process.env.FACTORY ?? deployment.factory) as Address | undefined;
  if (!factory) throw new Error(`Set FACTORY, or deploy first so ${file} exists.`);
  const [wallet] = await hre.viem.getWalletClients();
  const client = await hre.viem.getPublicClient();
  const vaultAbi = (await hre.artifacts.readArtifact("PilotVault")).abi;
  const factoryAbi = (await hre.artifacts.readArtifact("PilotVaultFactory")).abi;
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
  const reminded = new Map<string, number>();

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

  const registry = (process.env.REGISTRY ?? deployment.registry) as Address | undefined;
  if (process.env.PILOT_NAME && registry) {
    const want = { name: process.env.PILOT_NAME, uri: process.env.PILOT_URI ?? "", feeBps: cfg.minFeeBps ?? 0 };
    const reg = await hre.viem.getContractAt("PilotRegistry", registry);
    const entry = await reg.read.pilotOf([wallet.account.address]);
    if (registrationNeeded(entry.registeredAt ? entry : null, want)) {
      await client.waitForTransactionReceipt({ hash: await reg.write.register([want.name, want.uri, want.feeBps]) });
      console.log(`Listed in the pilot registry ${registry} as "${want.name}", asking ${want.feeBps / 100}% a year`);
    }
  } else if (process.env.PILOT_NAME) {
    console.log("PILOT_NAME is set but this network has no registry; not listing.");
  }

  let lastFees = 0;
  await runService({
    name: "fleet",
    intervalMs: Number(process.env.INTERVAL ?? 60) * 1000,
    once: Boolean(process.env.ONCE),
    healthPort: process.env.HEALTH_PORT ? Number(process.env.HEALTH_PORT) : undefined,
    tick: async (state) => {
      await reloadSubs();
      const events = await fleetTick(cfg);
      state.gauges.vaults = events.length;
      for (const e of events) count(state, e.kind);
      console.log(`[${new Date().toISOString()}] ${events.length} vault(s)`);
      for (const e of events) console.log(`  ${describe(e)}`);
      if (Date.now() - lastFees > feeEvery) {
        for (const e of await collectFees(cfg)) {
          count(state, e.kind);
          console.log(`  ${describe(e)}`);
        }
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
        count(state, "digest");
        console.log(`  digest sent for ${sub.vault}: ${report.headline}`);
      }
      // Inheritance: remind subscribed owners to check in before their heir can claim.
      for (const sub of subs.values()) {
        const v = sub.vault as Address;
        const read = (functionName: "heir" | "inactivityPeriod" | "inheritanceClaimableAt") => client.readContract({ address: v, abi: vaultAbi, functionName });
        const [heir, period, claimableAt] = (await Promise.all([read("heir"), read("inactivityPeriod"), read("inheritanceClaimableAt")])) as [Address, number, bigint];
        const r = checkInReminder(v, { heir, period: Number(period), claimableAt: Number(claimableAt) }, now, reminded.get(v.toLowerCase()));
        if (!r) continue;
        await deliverReminder(sub, r, email);
        reminded.set(v.toLowerCase(), now);
        count(state, "check_in_reminder");
        console.log(`  check-in reminder for ${v}: ${r.subject}`);
      }
    },
  });
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
