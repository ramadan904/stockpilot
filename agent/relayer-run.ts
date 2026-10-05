// Run the testnet oracle relayer with the key that deployed the stack (it owns the MockPriceFeeds):
//
//   PRIVATE_KEY=<deployer> npx hardhat run agent/relayer-run.ts --network robinhoodTestnet
//
// Optional: INTERVAL (seconds, default 30), DEVIATION_BPS (20), HEARTBEAT (1800), PYTH_IDS ('{"TSLA":"0x..."}') to
// skip the Hermes symbol search, HERMES_URL, ONCE=1.

import hre from "hardhat";
import { readFileSync } from "node:fs";
import type { Address } from "viem";
import { DEFAULT_POLICY, HERMES, decide, fetchQuotes, resolveEquityIds } from "./relayer";

async function main() {
  const d = JSON.parse(readFileSync(`deployments/${hre.network.name}.json`, "utf8")) as { feeds: Record<string, Address>; production?: boolean };
  if (d.production) throw new Error("This network uses real price feeds; the relayer is only for testnet mock feeds.");
  const base = process.env.HERMES_URL ?? HERMES;
  const policy = {
    ...DEFAULT_POLICY,
    deviationBps: Number(process.env.DEVIATION_BPS ?? DEFAULT_POLICY.deviationBps),
    heartbeatSec: Number(process.env.HEARTBEAT ?? DEFAULT_POLICY.heartbeatSec),
  };
  const client = await hre.viem.getPublicClient();
  const stocks = Object.keys(d.feeds).filter((s) => s !== "USDG");
  const ids: Record<string, string> = process.env.PYTH_IDS ? JSON.parse(process.env.PYTH_IDS) : await resolveEquityIds(stocks, fetch, base);
  console.log(`Relaying ${stocks.join(", ")} from ${base} to ${hre.network.name}`);
  for (const s of stocks) console.log(`  ${s}: ${ids[s]}`);

  for (;;) {
    try {
      const quotes = await fetchQuotes(stocks.map((s) => ids[s]), fetch, base);
      const now = Math.floor(Date.now() / 1000);
      for (const s of stocks) {
        const q = quotes.find((x) => x.id.toLowerCase() === ids[s].toLowerCase());
        if (!q) continue;
        const feed = await hre.viem.getContractAt("MockPriceFeed", d.feeds[s]);
        const [, answer, , updatedAt] = await feed.read.latestRoundData();
        const decision = decide({ answer, updatedAt: Number(updatedAt) }, q, now, policy);
        if (decision.push) {
          const hash = await feed.write.setPriceAt([q.answer, BigInt(q.publishTime)]);
          await client.waitForTransactionReceipt({ hash });
        }
        console.log(`  ${s} $${(Number(q.answer) / 1e8).toFixed(2)}: ${decision.push ? "pushed" : "skipped"} (${decision.why})`);
      }
    } catch (e) {
      console.error(`  relay failed: ${(e as Error).message.split("\n")[0]}`);
    }
    if (process.env.ONCE) break;
    await new Promise((r) => setTimeout(r, Number(process.env.INTERVAL ?? 30) * 1000));
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
