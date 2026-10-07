// A demo vault's pilot must not be its owner: otherwise "the pilot" holds the owner's powers and the vault can't show
// what a pilot is kept from doing. A fresh pilot key is made for it and kept out of the repository, in .secrets/, so
// the fleet can fly the vault later (PILOT_KEY) without the owner's key.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createWalletClient, custom, formatEther, parseEther, type Address, type Hex } from "viem";
import type { HardhatRuntimeEnvironment } from "hardhat/types";

export function demoPilot(network: string): Address {
  return demoPilotAccount(network).address;
}

/** The demo pilot's account (its key stays in .secrets/). */
export function demoPilotAccount(network: string) {
  const dir = ".secrets";
  const file = `${dir}/demo-pilot-${network}.key`;
  let key: Hex;
  if (existsSync(file)) key = readFileSync(file, "utf8").trim() as Hex;
  else {
    key = generatePrivateKey();
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, `${key}\n`, { mode: 0o600 });
    console.log(`New demo pilot key saved to ${file} (not committed). Give it to the fleet as PILOT_KEY to fly the demo vault.`);
  }
  return privateKeyToAccount(key);
}

/** Keep the demo pilot able to pay for its trades: top it up from the caller when it runs low. */
export async function topUpPilot(hre: HardhatRuntimeEnvironment, pilot: Address, min = parseEther("0.002"), amount = parseEther("0.005")) {
  const client = await hre.viem.getPublicClient();
  const balance = await client.getBalance({ address: pilot });
  if (balance >= min) return;
  const [from] = await hre.viem.getWalletClients();
  await client.waitForTransactionReceipt({ hash: await from.sendTransaction({ to: pilot, value: amount }) });
  console.log(`Sent ${formatEther(amount)} ETH to the demo pilot ${pilot} for gas (it had ${formatEther(balance)}).`);
}

/**
 * List the demo pilot in the onchain pilot registry, signed with its own key, so the marketplace shows a pilot that
 * really flies a vault (and its record in the leaderboard is real). A no-op once listed.
 */
export async function listDemoPilot(hre: HardhatRuntimeEnvironment, registry: Address) {
  const account = demoPilotAccount(hre.network.name);
  const reg = await hre.viem.getContractAt("PilotRegistry", registry);
  if (await reg.read.isActive([account.address])) return;
  const client = await hre.viem.getPublicClient();
  const wallet = createWalletClient({ account, chain: client.chain, transport: custom(hre.network.provider) });
  const hash = await wallet.writeContract({
    address: registry,
    abi: reg.abi,
    functionName: "register",
    args: ["StockPilot House Pilot", "https://github.com/ramadan904/stockpilot", 0],
  });
  await client.waitForTransactionReceipt({ hash });
  console.log(`Listed the demo pilot ${account.address} in the pilot registry as "StockPilot House Pilot".`);
}

