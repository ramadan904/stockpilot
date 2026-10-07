// Before a testnet deploy: who is deploying, on which chain, with how much gas money. Fails early with a faucet hint
// instead of halfway through a deploy.
//
//   PRIVATE_KEY=<deployer> npx hardhat run scripts/preflight.ts --network robinhoodTestnet

import hre from "hardhat";
import { formatEther } from "viem";

async function main() {
  const [deployer] = await hre.viem.getWalletClients();
  const client = await hre.viem.getPublicClient();
  const chainId = await client.getChainId();
  const balance = await client.getBalance({ address: deployer.account.address });
  console.log(`${hre.network.name} (chain ${chainId}): deployer ${deployer.account.address} has ${formatEther(balance)} ETH`);
  // A full deploy plus a funded demo vault costs well under 0.01 ETH at testnet gas prices.
  if (balance < 10n ** 15n) {
    console.error(`Not enough gas money on ${hre.network.name}. Send testnet ETH to ${deployer.account.address} from the network's faucet and run again.`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
