// What an AI agent sees through StockPilot's MCP server, in one command and without a key: this starts the real server
// (agent/mcp-main.ts) over stdio, connects to it as an MCP client would, and prints the conversation. It reads the live
// demo vault, asks what the planner would do, then tries the trade a hijacked agent would want (everything into one
// stock) and shows the contract refusing it. Read-only: nothing is signed or sent.
//
//   npm run mcp:demo                         (the Robinhood Chain testnet demo vault)
//   NETWORK=arbitrumSepolia npm run mcp:demo
//   RPC_URL=... VAULT=0x... npm run mcp:demo (any vault)

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync, readFileSync } from "node:fs";
import { createPublicClient, http, type Address } from "viem";
import { pilotVaultAbi } from "../web/src/abi";
import { readVault } from "../agent/chain";
import { valueOf } from "../agent/model";

const RPC: Record<string, string> = {
  robinhoodTestnet: process.env.ROBINHOOD_TESTNET_RPC ?? "https://rpc.testnet.chain.robinhood.com/rpc",
  arbitrumSepolia: process.env.ARBITRUM_SEPOLIA_RPC ?? "https://sepolia-rollup.arbitrum.io/rpc",
  localhost: "http://127.0.0.1:8545",
};

async function main() {
  const network = process.env.NETWORK ?? "robinhoodTestnet";
  const file = `deployments/${network}.json`;
  const d = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const rpc = process.env.RPC_URL ?? RPC[network];
  const vault = (process.env.VAULT ?? d.demoVault) as Address | undefined;
  if (!rpc || !vault) throw new Error(`No vault to show: set VAULT and RPC_URL, or NETWORK to one of ${Object.keys(RPC).join(", ")} with a demo vault.`);

  const env: Record<string, string> = { ...(process.env as Record<string, string>), RPC_URL: rpc, VAULT: vault };
  delete env.PRIVATE_KEY; // read-only, whatever the shell holds
  if (d.registry && d.factory && !process.env.VAULT) Object.assign(env, { REGISTRY: d.registry, FACTORY: d.factory });
  const transport = new StdioClientTransport({ command: "npx", args: ["ts-node", "--transpile-only", "agent/mcp-main.ts"], env, stderr: "pipe" });
  // The server logs to stderr; kept back, and shown only if it fails.
  let serverLog = "";
  transport.stderr?.on("data", (b: Buffer) => void (serverLog += b.toString()));
  const client = new Client({ name: "stockpilot-mcp-demo", version: "1.0.0" });
  try {
    await client.connect(transport);
  } catch (e) {
    throw new Error(`The MCP server did not start (${e instanceof Error ? e.message : e}).\n${serverLog.split("\n").find((l) => /Error|Details|status:/.test(l))?.trim() ?? ""}\nIs ${rpc} reachable from here?`);
  }

  const say = (who: string, s: string) => console.log(`\n\x1b[1m${who}\x1b[0m ${s}`);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    say("agent →", `${name}(${Object.keys(args).length ? JSON.stringify(args) : ""})`);
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    const out = r.content.map((c) => c.text).join("\n");
    console.log(out.replace(/^/gm, "  "));
    return out;
  };

  try {
    console.log(`StockPilot MCP server, read-only, on vault ${vault} (${network}). Nothing below is signed or sent.`);
    const { tools } = await client.listTools();
    say("server →", `${tools.length} tools: ${tools.map((t) => t.name).join(", ")}`);
    await call("get_vault");
    await call("plan_rebalance");

    // The trade a hijacked or careless agent would want: the vault's largest holding, all of it, into another asset.
    const state = await readVault(createPublicClient({ transport: http(rpc) }) as never, pilotVaultAbi, vault);
    const byValue = [...state.assets].sort((a, b) => Number(valueOf(b.balance, b.price, b.decimals) - valueOf(a.balance, a.price, a.decimals)));
    const [big, other] = [byValue[0], byValue.find((a) => a !== byValue[0] && a.targetBps > 0) ?? byValue[1]];
    const usd = Math.floor(Number(valueOf(big.balance, big.price, big.decimals)) / 1e18);
    if (usd > 0 && other) {
      say("note:", `now the trade a hijacked agent would want: all $${usd.toLocaleString("en-US")} of ${big.symbol} into ${other.symbol}.`);
      const verdict = await call("check_trade", { sell: big.symbol, buy: other.symbol, usd_amount: usd });
      say("result:", /REJECTED/.test(verdict) ? "the vault contract refuses it, whatever the agent decides." : "this one would go through: it fits the mandate.");
    }
    if (env.REGISTRY) await call("list_pilots");
  } finally {
    await client.close();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
