// Seed the deployment's demo fund: "StockPilot House Fund", a pooled vault with the demo vault's mandate, flown by the
// same house pilot, with a first $1,000 purchase in cash for the pilot to invest. Judges can open it read-only, or
// connect a testnet wallet and buy in. Recorded as demoFund / demoFundVault in deployments/<network>.json.
//
//   npx hardhat run scripts/demo-fund.ts --network robinhoodTestnet   (PRIVATE_KEY = any funded testnet key)
//   REDEMO=1 seeds a new one. Run again any time: it makes the first purchase if that has not happened yet.

import hre from "hardhat";
import { readFileSync, writeFileSync } from "node:fs";
import { parseUnits, zeroAddress, type Address } from "viem";
import { demoPilot } from "./lib/demo-pilot";

async function main() {
  const file = `deployments/${hre.network.name}.json`;
  const d = JSON.parse(readFileSync(file, "utf8"));
  if (!d.funds || !d.demoVault) return console.log("No fund factory or demo vault in this deployment; run deploy-addons and create-vault first.");
  if (d.production) return console.log("Not seeding a demo fund on a production deployment.");
  const client = await hre.viem.getPublicClient();
  const [me] = await hre.viem.getWalletClients();
  const wait = async (hash: `0x${string}`) => void (await client.waitForTransactionReceipt({ hash }));

  let fundAddress = d.demoFund as Address | undefined;
  // The hourly workflow (FINISH_ONLY=1) only finishes a seeding; creating a fund there would give it a pilot key no one keeps.
  if (!fundAddress && process.env.FINISH_ONLY) return console.log("No demo fund recorded; go-live creates it.");
  if (!fundAddress || process.env.REDEMO) {
    // The demo vault's mandate, as it stands.
    const demo = await hre.viem.getContractAt("PilotVault", d.demoVault as Address);
    const tokens = await demo.read.tokens();
    const assets = await Promise.all(
      tokens.map(async (token) => {
        const [feed, , , targetBps, bandBps] = await demo.read.assets([token]);
        return { token, feed, targetBps, bandBps };
      }),
    );
    const [maxTradeUsd, dailyLimitUsd, maxSlippageBps, maxPriceAge, cooldown] = await demo.read.limits();
    const cfg = {
      pilot: demoPilot(hre.network.name),
      adapter: await demo.read.adapter(),
      assets,
      limits: { maxTradeUsd, dailyLimitUsd, maxSlippageBps, maxPriceAge, cooldown },
      feeRecipient: zeroAddress,
      feeBps: 0,
    };
    const factory = await hre.viem.getContractAt("PilotFundFactory", d.funds as Address);
    await wait(await factory.write.createFund(["StockPilot House Fund", "SPHF", cfg]));
    const list = await factory.read.funds();
    fundAddress = list[list.length - 1];
    const vault = await (await hre.viem.getContractAt("PilotFund", fundAddress)).read.vault();
    Object.assign(d, { demoFund: fundAddress, demoFundVault: vault });
    writeFileSync(file, JSON.stringify(d, null, 2));
    console.log(`Demo fund ${fundAddress} (vault ${vault}), flown by ${cfg.pilot}; recorded in ${file}.`);
  }

  const fund = await hre.viem.getContractAt("PilotFund", fundAddress);
  if ((await fund.read.totalSupply()) > 0n) return console.log(`Demo fund ${fund.address} already has holders.`);
  // The first purchase, in cash: the pilot invests it toward the targets over the following days. Shares are only sold
  // at fresh prices, so while the market is closed this waits for the next run.
  try {
    const usdg = await hre.viem.getContractAt("MockERC20", d.tokens.USDG as Address);
    const amount = parseUnits(process.env.FUND_USD ?? "1000", 6);
    await wait(await usdg.write.mint([me.account.address, amount]));
    await wait(await usdg.write.approve([fund.address, amount]));
    await wait(await fund.write.buy([usdg.address, amount, 0n]));
    console.log(`First purchase: $${Number(amount) / 1e6} in USDG.`);
  } catch (e) {
    console.log(`First purchase not made yet (${e instanceof Error ? e.message.split("\n")[0] : e}); run this again once prices are fresh.`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
