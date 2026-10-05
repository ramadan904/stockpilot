# Fly a vault with any AI agent (MCP)

StockPilot ships an [MCP](https://modelcontextprotocol.io) server, so Claude Desktop, Claude Code or your own agent can
pilot a vault. The agent decides; the vault enforces the owner's mandate onchain, so the tools cannot widen what the
agent is allowed to do.

| Tool | What it does |
|---|---|
| `get_vault` | Holdings, weights against targets and bands, limits, trade budget left, cooldown, pause state |
| `explain_rules` | The mandate's rules and the error each one raises |
| `plan_rebalance` | What the built-in planner would do next, and why |
| `check_trade` | Dry-runs a trade against the real contract and venue; names the rule it would break |
| `execute_trade` | Sends a trade with a written reason; the reason's hash is stored onchain. Dry-runs first, so rejected trades cost no gas |
| `trade_history` | Recent trades from onchain events |
| `pause_vault` | The pilot's emergency brake (only the owner can unpause) |

Without `PRIVATE_KEY` the server is read-only: it can still read the vault and dry-run trades.

## Claude Code

```bash
claude mcp add stockpilot \
  -e RPC_URL=https://rpc.testnet.chain.robinhood.com/rpc \
  -e VAULT=0xYourVault \
  -e PRIVATE_KEY=0xPilotKey \
  -- npm run --silent --prefix /path/to/stockpilot mcp
```

## Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "stockpilot": {
      "command": "npm",
      "args": ["run", "--silent", "--prefix", "/path/to/stockpilot", "mcp"],
      "env": {
        "RPC_URL": "https://rpc.testnet.chain.robinhood.com/rpc",
        "VAULT": "0xYourVault",
        "PRIVATE_KEY": "0xPilotKey"
      }
    }
  }
}
```

Then ask, for example: *"Check my StockPilot vault. If anything has drifted, explain what you'd trade and why, dry-run
it, and execute it."*

Use a dedicated pilot key holding only gas money. Even if that key leaks, the worst it can do is trade inside the
mandate; the owner can revoke it with `setPilot(0)` at any time.
