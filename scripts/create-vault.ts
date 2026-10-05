// Create and fund a vault on a testnet where scripts/deploy.ts already ran. Funds come from the testnet faucet
// tokens, bought at the mandate's target weights.
//
//   PRIVATE_KEY=<owner key> PILOT=0x... GOAL="..." USD=10000 npx hardhat run scripts/create-vault.ts --network robinhoodTestnet

import hre from "hardhat";
import { readFileSync } from "node:fs";
import { parseUnits, zeroAddress, type Address } from "viem";
import { fmtUsd } from "../agent/planner";
import { propose } from "../agent/strategist";
import { LISTINGS, universeOf, type Stack } from "./lib/stack";

async function main() {
  const stack: Stack = JSON.parse(readFileSync(`deployments/${hre.network.name}.json`, "utf8"));
  const [owner] = await hre.viem.getWalletClients();
  const client = await hre.viem.getPublicClient();
  const pilot = (process.env.PILOT ?? owner.account.address) as Address;
  const goal = process.env.GOAL ?? "A balanced portfolio of big US tech with some cash.";
  const usd = Number(process.env.USD ?? 10_000);

  const strategy = await propose(goal, universeOf(stack), usd);
  console.log(`Mandate (${strategy.source}): ${strategy.proposal.summary}`);
  strategy.adjustments.forEach((a) => console.log(`  adjusted: ${a}`));

  const factory = await hre.viem.getContractAt("PilotVaultFactory", stack.factory as Address);
  await client.waitForTransactionReceipt({
    hash: await factory.write.createVault([pilot, stack.marketMaker as Address, strategy.mandate.assets, strategy.mandate.limits, zeroAddress, 0]),
  });
  const vaults = await factory.read.vaultsOf([owner.account.address]);
  const vault = await hre.viem.getContractAt("PilotVault", vaults[vaults.length - 1]);

  for (const [i, l] of LISTINGS.entries()) {
    const share = (usd * strategy.mandate.assets[i].targetBps) / 10_000;
    if (share === 0) continue;
    const token = await hre.viem.getContractAt("MockERC20", stack.tokens[l.symbol] as Address);
    const amount = parseUnits((share / l.price).toFixed(Math.min(l.decimals, 8)), l.decimals);
    await client.waitForTransactionReceipt({ hash: await token.write.mint([owner.account.address, amount]) });
    await client.waitForTransactionReceipt({ hash: await token.write.approve([vault.address, amount]) });
    await client.waitForTransactionReceipt({ hash: await vault.write.deposit([token.address, amount]) });
  }
  const [, total] = await vault.read.portfolio();
  console.log(`Vault ${vault.address} funded with ${fmtUsd(total)}; pilot ${pilot}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
