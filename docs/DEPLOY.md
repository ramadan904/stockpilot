# Going live

One command takes StockPilot from a fresh clone to live on Robinhood Chain testnet and Arbitrum Sepolia, with the web
app on Vercel:

```bash
npm ci
PRIVATE_KEY=<throwaway testnet key> VERCEL_TOKEN=<token> ./scripts/go-live.sh
```

For each network it:

1. **Checks** the deployer has testnet ETH (`scripts/preflight.ts`), and stops early if not.
2. **Deploys** the vault implementation and factory, the pilot registry, the testnet stand-ins (stock tokens,
   Chainlink-shaped feeds, the oracle market maker) and writes `deployments/<network>.json`. Skipped if that file
   exists (`REDEPLOY=1` to deploy again).
3. **Pushes real stock prices** from Pyth's Hermes API onto the feeds, once.
4. **Seeds a funded demo vault**, recorded as `demoVault` in the deployment file (`REDEMO=1` for a new one). The app's
   Live tab then offers judges **Open the demo vault**: a read-only view, no wallet needed.

Then it builds the web app with every deployment baked in, publishes it on Vercel, and prints the app URL, each
network's contract addresses and a read-only link to each demo vault, ready for SUBMISSION.md.

| Variable | Needed | What for |
|---|---|---|
| `PRIVATE_KEY` | yes | A **throwaway** key with testnet ETH on each network. Never a key holding real funds: the contracts are unaudited. |
| `VERCEL_TOKEN` | to publish | Without it the script stops after the build (`web/dist`). |
| `ANTHROPIC_API_KEY` | no | Claude drafts the demo vault's mandate; without it the offline preset does. |
| `NETWORKS` | no | Default `robinhoodTestnet arbitrumSepolia`. |
| `DEMO_GOAL`, `DEMO_USD` | no | The demo vault's goal and size. |
| `ROBINHOOD_TESTNET_RPC`, `ARBITRUM_SEPOLIA_RPC` | no | Other RPC endpoints than the public ones. |

After it runs:

- **Commit `deployments/*.json`** so every later build carries the addresses.
- **Keep prices fresh and the pilot flying**: `docker compose up -d relayer fleet` ([OPERATIONS.md](OPERATIONS.md)).
  Vaults refuse to trade on prices older than their mandate allows, so without the relayer the demo vault's pilot holds.
- **On Vercel**, set `ANTHROPIC_API_KEY` (Claude drafts mandates, reads statement screenshots, answers questions and
  writes reports) and `SIGNATURE_RELAY_KEY` (a small funded key that pays gas for owners' signed check-ins and pauses)
  in the project's environment variables.

The script is safe to re-run: finished steps are skipped. It was rehearsed end to end against a local chain
(`NETWORKS=localhost`), and CI's browser tests seed and open a demo vault the same way.
