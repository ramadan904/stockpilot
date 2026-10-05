// Run StockPilot's MCP server over stdio, for Claude Desktop, Claude Code or any MCP client.
//
//   RPC_URL=https://rpc.testnet.chain.robinhood.com/rpc VAULT=0x... PRIVATE_KEY=<pilot key> npm run mcp
//
// Leave PRIVATE_KEY unset for a read-only server. Logs go to stderr; stdout carries the protocol.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createPublicClient, createWalletClient, http, isAddress, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { pilotVaultAbi } from "../web/src/abi";
import { appendLog } from "./log";
import { createStockPilotServer } from "./mcp";

async function main() {
  const rpc = process.env.RPC_URL;
  const vault = process.env.VAULT;
  if (!rpc || !vault || !isAddress(vault)) throw new Error("Set RPC_URL and VAULT (and PRIVATE_KEY for the pilot, or leave it unset for read-only).");
  const transport = http(rpc);
  const client = createPublicClient({ transport });
  const chainId = await client.getChainId();
  const chain = { id: chainId, name: `chain-${chainId}`, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } };
  const key = process.env.PRIVATE_KEY as `0x${string}` | undefined;
  const wallet = key ? createWalletClient({ account: privateKeyToAccount(key), chain, transport }) : undefined;

  const server = createStockPilotServer({
    client: client as never,
    wallet,
    vault: vault as Address,
    vaultAbi: pilotVaultAbi,
    onTrade: (t) => appendLog(vault, t),
  });
  await server.connect(new StdioServerTransport());
  console.error(`StockPilot MCP server: vault ${vault} on chain ${chainId}${wallet ? ` as pilot ${wallet.account.address}` : " (read-only)"}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
