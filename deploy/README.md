# Production deployment configs

`scripts/deploy-production.ts` deploys StockPilot onto a chain with real assets from one of these files:

```bash
CONFIG=deploy/robinhood.json PRIVATE_KEY=... npx hardhat run scripts/deploy-production.ts --network <network>
```

Copy `production.example.json` and fill in:

- `swapRouter`: the chain's Uniswap V3 SwapRouter02 (or a fork with the same `exactInput`).
- `pyth`: the Pyth contract, if any asset is priced by Pyth.
- `assets`: each token and where its USD price comes from: `pyth` (a 32-byte price id, optional `maxConfBps`,
  default 1%), `chainlink` (an existing feed), or `fixed` (a stablecoin at par). Symbols must be listed in
  `agent/listings.ts`, which also gives the strategist its one-line description of each asset.
- `pools`: default fee tiers for routeless trades. The pilot can still pass any multi-hop route; the vault judges every
  fill against oracle prices either way.

The zero addresses in the example are placeholders: look up the real token, router and feed addresses for the target
chain from their official sources before deploying. The script validates the file before deploying anything.
