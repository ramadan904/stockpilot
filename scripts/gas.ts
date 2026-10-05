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
  const registry = await deployGas("PilotRegistry");
  rows.push(["Marketplace", "List a pilot (name, link, fee)", await gas(await registry.write.register(["Claude fleet", "https://example.com/stockpilot-fleet", 50], { account: pilot.account }))]);
  rows.push(["Marketplace", "Update a listing", await gas(await registry.write.register(["Claude fleet", "https://example.com/stockpilot-fleet", 75], { account: pilot.account }))]);
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
      const cashToken = await hre.viem.getContractAt("MockERC20", tokens[0]);
      await cashToken.write.mint([owner.account.address, parseUnits("1000", 18)]);
      await cashToken.write.approve([vault.address, parseUnits("1000", 18)]);
      rows.push([`${n} assets`, "Set up a recurring investment", await gas(await vault.write.setRecurringDeposit([tokens[0], parseUnits("100", 18), 7 * 86_400]))]);
      rows.push([`${n} assets`, "Pull a recurring investment", await gas(await asPilot.write.pullRecurringDeposit())]);
      const chainId = await client.getChainId();
      const deadline = BigInt((await client.getBlock()).timestamp) + 3_600n;
      const sig = await owner.signTypedData({
        account: owner.account!,
        domain: { name: "StockPilot Vault", version: "1", chainId, verifyingContract: vault.address },
        types: { CheckIn: [{ name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
        primaryType: "CheckIn",
        message: { nonce: await vault.read.sigNonce(), deadline },
      });
      rows.push([`${n} assets`, "Check in by signature (relayed)", await gas(await asPilot.write.checkInWithSig([deadline, sig]))]);
      rows.push([`${n} assets`, "Arm the crash guard", await gas(await vault.write.setCrashGuard([tokens[0], 7_000, 2_000]))]);
      rows.push([`${n} assets`, "Poke: record a new peak", await gas(await asPilot.write.poke())]);
      for (const m of mandate.slice(1)) await (await hre.viem.getContractAt("MockPriceFeed", m.feed)).write.setPrice([px(60)]);
      rows.push([`${n} assets`, "Poke: crash guard trips", await gas(await asPilot.write.poke())]);
      rows.push([`${n} assets`, "Back to normal targets", await gas(await vault.write.exitDefensive())]);
      rows.push([`${n} assets`, "Name an heir", await gas(await vault.write.setHeir([recipient.account.address, 90 * 86_400]))]);
      rows.push([`${n} assets`, "Check in (proof of life)", await gas(await vault.write.checkIn())]);
      await hre.network.provider.send("evm_increaseTime", [90 * 86_400]);
      const asHeir = await hre.viem.getContractAt("PilotVault", vault.address, { client: { wallet: recipient } });
      rows.push([`${n} assets`, "Heir claims the vault", await gas(await asHeir.write.claimInheritance())]);
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
    "## Notes",
    "",
    "- Each vault is an EIP-1167 minimal proxy to one locked `PilotVault` implementation that the factory deploys once,",
    "  so creating a vault costs about a sixth of deploying a full contract (about 3.07M gas before the change). Every",
    "  later call pays a small `delegatecall` overhead, about 2.6k gas.",
    "- `withdraw`, `pause`, `unpause`, `deposit`, `setFee` and `setMandate` first settle the management fee across every",
    "  asset, which is why they grow with the mandate's size.",
    "- A trade prices every asset in the mandate so it can check the band rule against the whole portfolio.",
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
