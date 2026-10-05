// Measures the gas of every vault action on a local chain and writes docs/GAS.md.
//
//   npm run gas
//
// Costs scale with the number of assets in the mandate (each trade prices every asset), so trades and fee
// collection are measured at 2, 4 and 8 assets.

import hre from "hardhat";
import { time } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers";
import { mkdirSync, writeFileSync } from "node:fs";
import { keccak256, parseUnits, toHex, zeroAddress, type Address, type Hash } from "viem";

const usd = (n: number) => parseUnits(String(n), 18);
const px = (n: number) => parseUnits(String(n), 8);
const LIMITS = { maxTradeUsd: usd(100_000), dailyLimitUsd: usd(1_000_000), maxSlippageBps: 100, maxPriceAge: 86_400, cooldown: 0 };

async function main() {
  const [owner, pilot, recipient] = await hre.viem.getWalletClients();
  const client = await hre.viem.getPublicClient();
  const gas = async (hash: Hash) => Number((await client.waitForTransactionReceipt({ hash })).gasUsed);

  const mm = await hre.viem.deployContract("OracleMarketMaker", [10n]);
  const factory = await hre.viem.deployContract("PilotVaultFactory");
  const rows: [string, string, number][] = [];
  const deployGas = async (name: string, args: unknown[] = []) => {
    const { contract, deploymentTransaction } = await hre.viem.sendDeploymentTransaction(name, args as never);
    rows.push(["Deploy", name, await gas(deploymentTransaction.hash)]);
    return contract;
  };
  await deployGas("PilotVaultFactory");
  await deployGas("UniswapV3Adapter", [zeroAddress]);
  await deployGas("PythPriceFeed", [zeroAddress, `0x${"11".repeat(32)}`, 100n, "TSLA / USD"]);

  for (const n of [2, 4, 8]) {
    const tokens: Address[] = [];
    const mandate = [];
    for (let i = 0; i < n; i++) {
      const t = await hre.viem.deployContract("MockERC20", [`T${i}`, `T${i}`, 18]);
      const f = await hre.viem.deployContract("MockPriceFeed", [`T${i}`, 8, px(100)]);
      await mm.write.setFeed([t.address, f.address]);
      await t.write.mint([mm.address, parseUnits("1000000", 18)]);
      tokens.push(t.address);
      const target = i === 0 ? 10_000 - Math.floor(10_000 / n) * (n - 1) : Math.floor(10_000 / n);
      mandate.push({ token: t.address, feed: f.address, targetBps: target, bandBps: 5_000 });
    }
    const create = await factory.write.createVault([pilot.account.address, mm.address, mandate, LIMITS, recipient.account.address, 50]);
    rows.push([`${n} assets`, "Create a vault (with mandate and fee)", await gas(create)]);
    const list = await factory.read.vaultsOf([owner.account.address]);
    const vault = await hre.viem.getContractAt("PilotVault", list[list.length - 1]);
    const asPilot = await hre.viem.getContractAt("PilotVault", vault.address, { client: { wallet: pilot } });

    let first = true;
    for (const t of tokens) {
      const token = await hre.viem.getContractAt("MockERC20", t);
      await token.write.mint([owner.account.address, parseUnits("1000", 18)]);
      await token.write.approve([vault.address, parseUnits("1000", 18)]);
      const g = await gas(await vault.write.deposit([t, parseUnits("1000", 18)]));
      if (first) rows.push([`${n} assets`, "Deposit", g]);
      first = false;
    }
    await time.increase(3_600);
    // An hour passes so the fee has something to collect; refresh the feeds so prices stay fresh.
    for (const m of mandate) await (await hre.viem.getContractAt("MockPriceFeed", m.feed)).write.setPrice([px(100)]);
    rows.push([`${n} assets`, "Rebalance (one trade, all checks)", await gas(await asPilot.write.rebalance([tokens[0], tokens[1], parseUnits("10", 18), 0n, "0x", keccak256(toHex("gas"))]))]);
    rows.push([`${n} assets`, "Collect fee (every asset)", await gas(await vault.write.collectFee())]);
    rows.push([`${n} assets`, "Replace the mandate", await gas(await vault.write.setMandate([mandate, LIMITS]))]);
    rows.push([`${n} assets`, "Withdraw one asset", await gas(await vault.write.withdraw([tokens[2 % n], parseUnits("1", 18), owner.account.address]))]);
    if (n === 4) {
      rows.push([`${n} assets`, "Pause", await gas(await vault.write.pause())]);
      rows.push([`${n} assets`, "Unpause", await gas(await vault.write.unpause())]);
      rows.push([`${n} assets`, "Set pilot", await gas(await vault.write.setPilot([pilot.account.address]))]);
      rows.push([`${n} assets`, "Set or cancel fee", await gas(await vault.write.setFee([zeroAddress, 0]))]);
    }
  }

  // Illustrative fees: L2 execution gas prices are typically a small fraction of a gwei; check the chain's current
  // price before relying on these.
  const ETH_USD = 3_000;
  const cost = (g: number, gwei: number) => `$${((g * gwei * 1e-9) * ETH_USD).toFixed(g * gwei * 1e-9 * ETH_USD < 0.01 ? 4 : 3)}`;
  const lines = [
    "# Gas",
    "",
    "Measured by `npm run gas` on a local chain (Solidity 0.8.28, optimizer 200 runs, `cancun`). Trades and fee collection",
    "price or touch every asset in the mandate, so they grow with the number of assets (at most 8).",
    "",
    `The dollar columns are illustrative: execution gas only, at the given L2 gas price and ETH at $${ETH_USD.toLocaleString()}.`,
    "Rollups also charge for posting data to Ethereum, which varies with L1 conditions. Check the chain's live prices.",
    "",
    "| Mandate | Action | Gas | at 0.01 gwei | at 0.1 gwei |",
    "|---|---|---:|---:|---:|",
    ...rows.map(([m, a, g]) => `| ${m} | ${a} | ${g.toLocaleString("en-US")} | ${cost(g, 0.01)} | ${cost(g, 0.1)} |`),
    "",
  ];
  mkdirSync("docs", { recursive: true });
  writeFileSync("docs/GAS.md", lines.join("\n"));
  console.log(lines.join("\n"));
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
