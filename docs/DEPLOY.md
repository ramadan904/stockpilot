# Going live

One command takes StockPilot from a fresh clone to live on Robinhood Chain testnet and Arbitrum Sepolia, with the web
app on Vercel:

```bash
npm ci
./scripts/go-live.sh
```

It asks for the deploy key (a throwaway testnet key) and a Vercel token, hidden, so neither lands on screen or
in shell history; set `PRIVATE_KEY` and `VERCEL_TOKEN` beforehand to skip the questions (CI).

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

## Publishing the app again

After code changes, with the contracts already deployed:

```bash
bash scripts/publish.sh
```

It asks for a Vercel token, hidden (an empty line is asked again, so a pasted command's own Enter does no harm), and
deploys to production. Delete the token afterwards.

## Keeping the demo vault alive

The demo vault is meant to be watched, so it should be flying. `.github/workflows/demo-pilot.yml` does that without a
server: every hour it pushes real stock prices onto the testnet feeds, then runs one check by the demo vault's own
pilot, which makes the one trade (if any) its planner and the contract allow. About once a day the same pilot also
publishes a letter to the owner in the pilot journal (`scripts/pilot-letter.ts`).

1. Start the demo in cash, so there is something to watch: `REDEMO=1 DEMO_CASH=1 NETWORKS=robinhoodTestnet ./scripts/go-live.sh`.
   The pilot then invests it over the following days, a capped, explained trade at a time.
2. Add two repository secrets (Settings > Secrets and variables > Actions):
   - `RELAYER_KEY`: the key that deployed the contracts (it owns the price feeds).
   - `DEMO_PILOT_KEY`: the demo vault's pilot, from `.secrets/demo-pilot-robinhoodTestnet.key` (created by go-live,
     never committed). On Windows, `clip < .secrets/demo-pilot-robinhoodTestnet.key` copies it without showing it.
3. Run the workflow once from the Actions tab (Demo pilot > Run workflow) to check it; after that it runs hourly
   from the default branch.

Optionally add `ANTHROPIC_API_KEY` too, so Claude writes the letters; without it they are written plainly from the
same onchain figures.

Both keys are testnet keys. Without the secrets the workflow skips its steps and succeeds.
