# StockPilot

**An AI autopilot for tokenized stock portfolios that can only trade inside the rules you sign.**

Tokenized stocks trade around the clock and settle onchain, but managing a portfolio still means watching it.
AI agents could do that, but today you either hand an agent your keys or let it make suggestions only.
StockPilot sits in between. Your portfolio lives in a vault you own. An AI pilot can rebalance it, and the vault
contract checks every trade against a **mandate** you set: which assets, what target weights, how far they may drift,
how much can trade per trade and per day, and how much slippage is acceptable. The pilot cannot withdraw, cannot change
the rules, and cannot concentrate your portfolio, because the contract won't let it.

Built for [Crypto World's Fair](https://colosseum.com/worldsfair) (Colosseum), targeting the Ethereum ecosystem tracks
(Robinhood Chain, Arbitrum). Judges: start with [SUBMISSION.md](SUBMISSION.md) and the 53-second
[demo video](media/simulator-demo.mp4).

```
"I'm 30, I believe in AI and big tech, I can handle swings but want some cash."
        │
        ▼  Strategist (Claude, structured output)       draft only, never touches funds
  targets, bands, limits ──► owner reviews and signs ──► PilotVault (onchain mandate)
                                                              ▲
        Pilot (deterministic planner) ── rebalance() ─────────┘  every trade checked against the mandate
```

## Try it in ten seconds

```bash
npm install
npm test          # 38 tests: vault rules, a hostile venue, a randomized model check, planner, strategist
npm run demo      # the whole story on a local chain
ANTHROPIC_API_KEY=... GOAL="your own goal" npm run demo   # Claude drafts the mandate
```

The demo deploys everything, turns a goal into a mandate, funds a $10,000 vault, crashes and rallies the market, lets
the pilot rebalance, and then has a rogue pilot try five ways to break the rules:

```
== 6. A rogue pilot tries to break the rules; the vault refuses
   Pile $1,000.00 of TSLA into NVDA           -> blocked: OutsideBand
   Sell $3,000.00 in one trade                -> blocked: TradeTooLarge
   Withdraw NVDA to its own wallet            -> blocked: OwnableUnauthorizedAccount
   Swap the venue for one it controls         -> blocked: OwnableUnauthorizedAccount
   Rewrite the mandate                        -> blocked: OwnableUnauthorizedAccount
```

No network, wallet, or API key needed. The compiler is the solc-js build pinned in `package.json`, so builds work
offline.

## The web app

```bash
npm run web       # http://localhost:5173
```

- **Simulator** (no wallet): draft a mandate from a goal, move the market, run the pilot or let it fly on autopilot,
  and try eight attacks a rogue pilot might make. The simulated vault runs the same `check()` the real pilot uses, and
  the randomized test proves `check()` agrees with the contract trade for trade, so what you see is what the chain does.
- **Live**: connect a wallet on Robinhood Chain testnet, Arbitrum Sepolia or a local node, create and fund a vault
  with the drafted mandate, run the pilot, pause it, change the pilot, withdraw everything, and read every trade's
  onchain record with its reason hash. Networks appear once a `deployments/<network>.json` from `scripts/deploy.ts`
  is committed.

The strategist runs server-side at `POST /api/propose`, so the Anthropic key never reaches the browser. In development
Vite serves it; on Vercel it is the function in [`api/propose.ts`](api/propose.ts). Deploy with the repository root as
the project root (`vercel.json` sets the build) and set `ANTHROPIC_API_KEY` in the project's environment. Without a
key the endpoint answers with the offline preset.

## What the vault guarantees

[`PilotVault`](contracts/PilotVault.sol) is owned by you. The pilot's only power is `rebalance()`, and a trade
goes through only if all of these hold, checked against oracle prices inside the transaction:

| Rule | Error if broken |
|---|---|
| Both assets are in the mandate, and the trade goes through the venue you chose | `AssetNotInMandate`, `NoAdapter` |
| The trade is at most `maxTradeUsd`, and fits a budget of `dailyLimitUsd` that refills continuously over 24 hours (no midnight reset to burst through) | `TradeTooLarge`, `DailyLimitExceeded` |
| At least `cooldown` seconds since the last trade | `CooldownActive` |
| Every price is younger than `maxPriceAge` (no trading on a closed market's stale price) | `StalePrice` |
| What arrived is worth at least `1 - maxSlippageBps` of what left, at oracle prices, measured from the vault's own balances (not the venue's word) | `SlippageExceeded`, `InsufficientOutput` |
| Neither asset ends outside its band around target, unless the trade moved it toward target without crossing it | `OutsideBand` |

The last rule is the core idea. Within the bands, the pilot has discretion. Outside them, it may only repair drift,
never create it. So the worst a compromised or confused pilot can do is trade within your bands, within your daily cap,
at near-oracle prices.

A hosted pilot can be paid by an optional management fee set in the vault: at most 2% a year, taken pro-rata from every
asset so it never moves the weights, paused while the vault is paused, settled before every withdrawal, and cancellable
by the owner at any time (`setFee(0, 0)`).

You keep custody: `withdraw` works at any time, even when paused. `pause` can be pulled by you or by the pilot itself;
only you can `unpause`. `setPilot(0)` revokes the agent in one transaction. Ownership moves in two steps and cannot be
renounced, so funds can't be locked by accident. Each trade emits `keccak256(rationale)`, the hash of the pilot's
written reason, so its logbook (`pilot-log/*.jsonl`) can be checked against the chain.

## The pieces

| Path | What it is |
|---|---|
| [`contracts/PilotVault.sol`](contracts/PilotVault.sol) | The vault and its mandate checks |
| [`contracts/PilotVaultFactory.sol`](contracts/PilotVaultFactory.sol) | One vault per user, created with its first mandate in one transaction, plus a registry |
| [`contracts/interfaces/ISwapAdapter.sol`](contracts/interfaces/ISwapAdapter.sol) | The venue interface. Any DEX or RFQ desk can sit behind it |
| [`contracts/adapters/UniswapV3Adapter.sol`](contracts/adapters/UniswapV3Adapter.sol) | Venue for any Uniswap V3-style DEX; the pilot may pass a multi-hop route, which is checked to start and end at the right tokens |
| [`contracts/adapters/PythPriceFeed.sol`](contracts/adapters/PythPriceFeed.sol) | A Pyth price as a Chainlink-style feed; refuses prices whose confidence interval is too wide |
| [`scripts/deploy-production.ts`](scripts/deploy-production.ts) | Config-driven deploy onto a chain with real assets, feeds and a DEX ([`deploy/`](deploy)) |
| [`contracts/mocks/`](contracts/mocks) | Testnet stand-ins: stock tokens, Chainlink-shaped feeds, an oracle-priced market maker, and a hostile adapter for tests |
| [`agent/model.ts`](agent/model.ts) | An exact BigInt model of the vault's checks, so the pilot knows before sending whether a trade will pass |
| [`agent/planner.ts`](agent/planner.ts) | The pilot's brain: deterministic threshold rebalancing that only proposes trades the model accepts |
| [`agent/strategist.ts`](agent/strategist.ts) | Claude turns a goal in plain words into a draft mandate; code validates it and converts it to onchain units |
| [`agent/run.ts`](agent/run.ts) | The live pilot loop for a testnet or mainnet vault |
| [`agent/mandate.ts`](agent/mandate.ts) | Proposal schema, validation and presets; shared by the server, scripts and browser |
| [`web/`](web) | The web app: simulator and live mode (React, viem) |
| [`api/propose.ts`](api/propose.ts) | The strategist endpoint, as a Vercel function |
| [`scripts/`](scripts) | `demo`, `deploy`, `create-vault`, `export-abi` |

**Why the AI drafts the mandate, but code flies the plane.** Choosing an allocation from someone's goals is a
judgment call, and Claude is good at it. The output is a draft the owner reads and signs. Executing trades is
arithmetic, and arithmetic should be deterministic and testable, so the pilot is plain code. Bring your own pilot if
you like: any agent with the pilot key gets the same onchain limits.

## How it is tested

- **Vault rules** ([`test/PilotVault.test.ts`](test/PilotVault.test.ts)): every limit, custody, pause, ownership, mandate
  validation, and a hostile venue that lies about output or tries to re-enter.
- **Model vs contract** ([`test/model.test.ts`](test/model.test.ts)): 360 random trades under random price moves and
  venue fees. For each one, the TypeScript model and the contract must agree on whether it passes and, if not, on the
  exact error.
- **Planner** ([`test/planner.test.ts`](test/planner.test.ts)): after market shocks, the pilot returns the portfolio near
  target using only trades the vault accepts, stops at the daily limit, and refuses to trade on stale prices.
- **Strategist** ([`test/strategist.test.ts`](test/strategist.test.ts)): a sloppy proposal (unknown assets, weights that
  don't add up, absurd bands) is repaired and every fix is reported; every preset mandate is accepted by the vault.

## Deploying to a testnet

```bash
PRIVATE_KEY=<deployer> npm run deploy:robinhood-testnet      # or deploy:arbitrum-sepolia
PRIVATE_KEY=<owner> PILOT=<pilot address> GOAL="..." USD=10000 \
  npx hardhat run scripts/create-vault.ts --network robinhoodTestnet
PRIVATE_KEY=<pilot> VAULT=<vault> npx hardhat run agent/run.ts --network robinhoodTestnet
```

Testnets have no tokenized-stock liquidity or stock price feeds, so `deploy` ships stand-ins behind the same
interfaces the vault uses in production: Chainlink-shaped `MockPriceFeed`s and an `OracleMarketMaker` venue. On
mainnet, the vault takes real stock tokens, real feeds and a real venue adapter, with no code changes.

## Status and honest limits

This is a hackathon build. The contracts are tested but **not audited**; do not put real money in them.

- Prices come from oracles. A wrong oracle price is the main trust assumption: the slippage and band checks are only
  as good as the feed.
- Tokens dropped from a mandate stay in the vault, unpriced, until the owner withdraws them or lists them again.
- Market hours: tokenized stocks may trade around the clock, but feeds for some may pause. The vault refuses to trade
  on a price older than `maxPriceAge`, and the pilot holds.

## Roadmap

1. Live deployments on Robinhood Chain testnet and Arbitrum Sepolia, and the web app on Vercel.
2. A hosted pilot service, so owners don't run `agent/run.ts` themselves.
3. A real venue adapter (DEX router) and production price feeds for tokenized stocks.
4. Pilot as an MCP server, so any agent can fly a vault under the same onchain limits.

## License

MIT
