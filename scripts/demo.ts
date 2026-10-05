// The whole StockPilot story on a local chain, in about ten seconds:
//
//   npm run demo                         (offline: the strategist uses a preset)
//   ANTHROPIC_API_KEY=... npm run demo   (Claude drafts the mandate)
//   GOAL="..." npm run demo              (your own goal)

import hre from "hardhat";
import { time } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers";
import { BaseError, ContractFunctionRevertedError, getAddress, parseUnits, type Address } from "viem";
import { readVault, rationaleHash, sendTrade } from "../agent/chain";
import { appendLog } from "../agent/log";
import { drift, fmtUsd, pct, plan } from "../agent/planner";
import { propose } from "../agent/strategist";
import { LISTINGS, deployStack, universeOf } from "./lib/stack";

const GOAL =
  process.env.GOAL ??
  "I'm 30 and I believe in AI and big tech for the long term. I can handle swings, but I want some cash on hand.";
const PORTFOLIO_USD = 10_000;

async function main() {
  const [owner, pilotWallet] = await hre.viem.getWalletClients();
  const client = await hre.viem.getPublicClient();

  step("1. Deploy");
  const stack = await deployStack(hre);
  const universe = universeOf(stack);
  console.log(`   ${LISTINGS.length} assets, oracle feeds, a market maker and the vault factory are live.`);

  step("2. The strategist turns a goal into a mandate");
  console.log(`   Goal: "${GOAL}"`);
  const strategy = await propose(GOAL, universe, PORTFOLIO_USD);
  console.log(`   Drafted by: ${strategy.source === "claude" ? "Claude" : "offline preset (set ANTHROPIC_API_KEY for Claude)"}`);
  console.log(`   ${strategy.proposal.summary}`);
  for (const a of strategy.proposal.allocations) console.log(`     ${a.symbol.padEnd(5)} ${String(a.weight_percent).padStart(5)}%  ${a.reason}`);
  for (const note of strategy.adjustments) console.log(`   Adjusted: ${note}`);
  const { limits } = strategy.mandate;
  console.log(
    `   Guardrails: max ${fmtUsd(limits.maxTradeUsd)} per trade, ${fmtUsd(limits.dailyLimitUsd)} per day, ` +
      `${limits.maxSlippageBps / 100}% max slippage, ${limits.cooldown}s between trades.`,
  );

  step("3. The owner signs: create the vault and fund it");
  const factory = await hre.viem.getContractAt("PilotVaultFactory", stack.factory as Address);
  await client.waitForTransactionReceipt({
    hash: await factory.write.createVault([
      pilotWallet.account.address,
      stack.marketMaker as Address,
      strategy.mandate.assets,
      strategy.mandate.limits,
      pilotWallet.account.address, // the hosted pilot is paid
      50, // 0.5% a year, taken pro-rata
    ]),
  });
  const [vaultAddress] = await factory.read.vaultsOf([owner.account.address]);
  const vault = await hre.viem.getContractAt("PilotVault", vaultAddress);
  const asPilot = await hre.viem.getContractAt("PilotVault", vaultAddress, { client: { wallet: pilotWallet } });
  for (const [i, l] of LISTINGS.entries()) {
    const usd = (PORTFOLIO_USD * strategy.mandate.assets[i].targetBps) / 10_000;
    if (usd === 0) continue;
    const token = await hre.viem.getContractAt("MockERC20", stack.tokens[l.symbol] as Address);
    const amount = parseUnits((usd / l.price).toFixed(Math.min(l.decimals, 8)), l.decimals);
    await token.write.mint([owner.account.address, amount]);
    await token.write.approve([vault.address, amount]);
    await vault.write.deposit([token.address, amount]);
  }
  console.log(`   Vault ${vault.address}, owner ${short(owner.account.address)}, pilot ${short(pilotWallet.account.address)}`);
  await show();

  step("4. Markets move: NVDA +80%, TSLA -30%");
  await setPrice("NVDA", 180 * 1.8);
  await setPrice("TSLA", 250 * 0.7);
  await refreshFeeds();
  await show();

  step("5. The pilot rebalances, inside the mandate");
  for (let i = 0; i < 12; i++) {
    const state = await readVault(client, vault.abi, vault.address);
    const p = plan(state);
    if (p.action === "hold") {
      console.log(`   Pilot holds: ${p.reason}`);
      break;
    }
    const { hash } = await sendTrade(client, pilotWallet, vault.abi, vault.address, p.trade);
    console.log(`   Trade ${i + 1}: ${p.trade.rationale}`);
    appendLog(vault.address, { tx: hash, rationale: p.trade.rationale, rationaleHash: rationaleHash(p.trade.rationale) });
    await time.increase(limits.cooldown);
    await refreshFeeds();
  }
  await show();

  step("6. A rogue pilot tries to break the rules; the vault refuses");
  const s = await readVault(client, vault.abi, vault.address);
  const bySym = (sym: string) => s.assets.find((a) => a.symbol === sym)!;
  const nvda = bySym("NVDA");
  const biggest = [...s.assets].filter((a) => a.symbol !== "NVDA").sort((a, b) => (value(b) > value(a) ? 1 : -1))[0];
  const chunk = (a: typeof nvda, usd: bigint) => (usd * 10n ** BigInt(a.decimals)) / a.price;
  const attempts: [string, () => Promise<unknown>][] = [
    [
      `Pile ${fmtUsd(limits.maxTradeUsd)} of ${biggest.symbol} into NVDA`,
      () => asPilot.write.rebalance([biggest.token, nvda.token, chunk(biggest, limits.maxTradeUsd), 0n, "0x", rationaleHash("yolo")]),
    ],
    [
      `Sell ${fmtUsd(limits.maxTradeUsd * 3n)} in one trade`,
      () => asPilot.write.rebalance([biggest.token, nvda.token, chunk(biggest, limits.maxTradeUsd * 3n), 0n, "0x", rationaleHash("size")]),
    ],
    ["Withdraw NVDA to its own wallet", () => asPilot.write.withdraw([nvda.token, 1n, pilotWallet.account.address])],
    ["Swap the venue for one it controls", () => asPilot.write.setAdapter([pilotWallet.account.address])],
    ["Rewrite the mandate", () => asPilot.write.setMandate([strategy.mandate.assets, strategy.mandate.limits])],
  ];
  for (const [what, attempt] of attempts) {
    console.log(`   ${what.padEnd(42)} -> blocked: ${await revertReason(attempt)}`);
  }

  step("7. The owner pulls the brake");
  await vault.write.pause();
  const paused = plan(await readVault(client, vault.abi, vault.address));
  console.log(`   Pilot: ${paused.action === "hold" ? paused.reason : "?"} The owner can still withdraw everything.`);

  const events = await vault.getEvents.Rebalanced({}, { fromBlock: 0n });
  console.log(`\n${events.length} trades, each with its rationale hash onchain. Log: pilot-log/${vault.address}.jsonl\n`);

  async function show() {
    const state = await readVault(client, vault.abi, vault.address);
    const total = state.assets.reduce((t, a) => t + value(a), 0n);
    console.log(`\n   ${"Asset".padEnd(6)}${"Value".padStart(12)}${"Weight".padStart(9)}${"Target".padStart(9)}   Band`);
    for (const d of drift(state)) {
      const a = bySymbol(state, d.symbol);
      const flag = d.outOfBand ? "  <- outside band" : "";
      console.log(
        `   ${d.symbol.padEnd(6)}${fmtUsd(value(a)).padStart(12)}${pct(d.weightBps).padStart(9)}${pct(d.targetBps).padStart(9)}   ±${pct(d.bandBps)}${flag}`,
      );
    }
    console.log(`   ${"Total".padEnd(6)}${fmtUsd(total).padStart(12)}\n`);
  }

  async function setPrice(symbol: string, price: number) {
    const feed = await hre.viem.getContractAt("MockPriceFeed", stack.feeds[symbol] as Address);
    await feed.write.setPrice([parseUnits(price.toFixed(8), 8)]);
  }

  async function refreshFeeds() {
    for (const l of LISTINGS) {
      if ("stable" in l) continue;
      const feed = await hre.viem.getContractAt("MockPriceFeed", stack.feeds[l.symbol] as Address);
      const [, answer] = await feed.read.latestRoundData();
      await feed.write.setPrice([answer]);
    }
  }
}

function value(a: { balance: bigint; price: bigint; decimals: number }) {
  return (a.balance * a.price) / 10n ** BigInt(a.decimals);
}

function bySymbol<T extends { symbol: string }>(s: { assets: T[] }, sym: string) {
  return s.assets.find((a) => a.symbol === sym)!;
}

async function revertReason(attempt: () => Promise<unknown>) {
  try {
    await attempt();
    return "NOT BLOCKED (this is a bug)";
  } catch (e) {
    if (e instanceof BaseError) {
      const revert = e.walk((x) => x instanceof ContractFunctionRevertedError);
      if (revert instanceof ContractFunctionRevertedError && revert.data?.errorName) return revert.data.errorName;
    }
    const m = /custom error '?(\w+)/.exec(String((e as Error).message));
    return m ? m[1] : String((e as Error).message).split("\n")[0];
  }
}

function step(title: string) {
  console.log(`\n== ${title}`);
}

function short(a: string) {
  const x = getAddress(a);
  return `${x.slice(0, 6)}…${x.slice(-4)}`;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
