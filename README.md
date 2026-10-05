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

## What's in it

| | Enforced by the contract | Built on it |
|---|---|---|
| **Mandate vault** | Target weights and bands, per-trade and 24-hour caps, cooldown, slippage at oracle prices, fresh prices; the pilot can only `rebalance` | An exact TypeScript model and a Rust core that reach the same verdicts, proven on thousands of random trades |
| **Crash guard** | Past a set fall from the peak, defensive targets; the pilot can only de-risk; only the owner lifts it | Fleet keeper, stress test of the trade-off before signing |
| **Inheritance** | An heir takes over after the owner's long silence; every owner action restarts the clock | Check-in reminders by email and webhook |
| **Pilot marketplace** | `PilotRegistry`: any agent lists itself with a fee; no rights granted | Track records computed from the chain, a picker, MCP tools for agents to get hired |
| **Fees** | At most 2% a year, in kind, paused with the vault, cancellable | Hosted fleet that serves only paying vaults |
| **Owner tools** | | Ask your vault (Claude, answers checked against the chain), taxes (FIFO lots, Form 8949-style CSV), performance against untraded deposits, activity feed, alerts, mandate diff, reports |
| **Operations** | | Docker image with health checks, metrics and graceful shutdown; a price relayer for testnets; an MCP server so any AI agent can fly a vault |
| **Solana** | Proof of concept: the same rules as a Solana program, with Pyth price accounts | Conformance-tested against the TypeScript model |

## Try it in ten seconds

```bash
npm install
npm test          # 165 tests: vault rules and fees, adapters, a randomized model check, planner, fleet, MCP, marketplace, inheritance, crash guard, taxes, Q&A, services, backtest
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

- **Take the 60-second tour**: one button walks through the whole story in the real simulator, with captions: a market
  shock, the pilot rebalancing, a hacked pilot blocked eight times, weeks of autopilot, and a written report.
- **Simulator** (no wallet): draft a mandate from a goal, move the market, run the pilot or let it fly on autopilot,
  start in cash and watch it invest, chart the vault against buy-and-hold, and try eight attacks a rogue pilot might
  make.
- **Backtest**: the mandate over 200 simulated markets against buy-and-hold: returns, drawdowns, volatility and how
  concentrated each gets. Plus a **stress test** through five shaped crashes and rallies, left alone, piloted, and
  piloted with the crash guard. The simulated vault runs the same `check()` the real pilot uses, and
  the randomized test proves `check()` agrees with the contract trade for trade, so what you see is what the chain does.
- **Live**: connect a wallet on Robinhood Chain testnet, Arbitrum Sepolia or a local node, create a vault with the
  drafted mandate (funded at targets, or in cash for the pilot to invest), set a pilot fee, run the pilot, pause it,
  change or revoke it, withdraw everything, get a written report, and follow an activity feed of every onchain event
  with "new since your last visit" markers. Pick a pilot from the **marketplace** by its onchain record, name an
  **heir**, arm the **crash guard**, **ask the vault** questions in plain words, see **performance** against your
  untraded deposits, and download **tax** lots as CSV. Refine the draft in plain words ("less Tesla, more cash"), review any
  mandate change side by side before signing it, and turn on alerts: in the browser, or by email and webhook from the
  hosted pilot with a daily digest. Networks appear once a `deployments/<network>.json` from `scripts/deploy.ts`
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

**Inheritance.** A brokerage account can name a beneficiary; a wallet can't, so self-custodied stocks die with their
key. The vault can: `setHeir(heir, period)` names an heir and an inactivity period (30 days to 10 years). Every owner
action restarts the clock (`checkIn()` does nothing else); the pilot's trades never do. After a full period of silence
the heir calls `claimInheritance()` and owns the vault, still managed, with its mandate and pilot. The fleet reminds
subscribed owners to check in during the last quarter of the period, and a change of owner clears the heir.

**Crash guard.** A stop-loss for the whole portfolio, enforced by the contract. `setCrashGuard(safeAsset,
safeTargetBps, drawdownBps)` arms it: when the vault's value falls more than `drawdownBps` (5% to 50%) below its
recorded peak, it switches to defensive targets (the safe asset, typically the stablecoin, rises to `safeTargetBps`;
everything else shrinks in proportion), and the band rule then only lets the pilot de-risk toward them. Anyone can
trip it with `poke()`, and the fleet does every tick; a trade attempted past the drop is judged on the defensive
targets anyway, so a pilot that never pokes still cannot dodge it. Owner withdrawals re-arm it (money leaving is not a
crash); only the owner can go back to normal targets. The rules engines need no change: the vault reports the targets
in force, and the model and planner follow them.

**Stress test before you sign.** The Backtest tab runs the draft mandate through five shaped markets ([`agent/stress.ts`](agent/stress.ts)):
a sharp crash with a fast recovery, a two-year bear market, a tech-only wreck, a flash crash and a melt-up. Each is
flown three ways, left alone, by the pilot, and by the pilot with the crash guard armed (simulated exactly as the vault
runs it, rounding included), with the same planner and rule model as the real thing. It shows the cost as plainly as
the benefit: the guard cuts the fall in a long bear market but can lock in the loss before a fast rebound. The
scenarios are stated as shapes, not history or forecasts.

**Performance, honestly measured.** A live vault's value over time, read from the chain at sampled blocks, against
"your deposits, never traded": the same deposits and withdrawals token for token, with no trades and no fee, at the
same oracle prices ([`agent/performance.ts`](agent/performance.ts)). The gap is what the pilot and its fee added or
cost, and money moving in or out cannot distort it.

**Taxes.** The web app rebuilds the vault's tax lots from its onchain history ([`agent/tax.ts`](agent/tax.ts)):
deposits priced by the vault's own oracles at that block, every trade, the fee paid in kind. Sales are matched first in,
first out, lot by lot, split into short and long term, with exact integer arithmetic, and download as a CSV in the
shape of Form 8949. Open lots under water are shown as loss-harvesting candidates, with the wash-sale caveat. Not tax
advice; every assumption is listed next to the numbers.

**Ask your vault.** Owners ask in plain words ("why did you sell NVDA?", "what happens if I lose my keys?") and get
answers built only from facts the page reads from the chain: holdings, limits, trades, settings, taxes, heir
([`agent/ask.ts`](agent/ask.ts)). Claude must cite the transactions it relies on, and any citation that is not in the
vault's history is removed before the answer is shown. A trade's written reason is used only when it hashes to the
`rationale` committed onchain with that trade, so the explanation is provably the one the pilot gave at the time.
Without an API key, the common questions are answered directly from the facts.

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
| [`agent/run.ts`](agent/run.ts) | The live pilot loop for one vault |
| [`agent/fleet.ts`](agent/fleet.ts) | The hosted pilot: flies every vault that names it, optionally only fee-paying ones, collects fees, posts trades to a Slack/Discord webhook (`npm run fleet`) |
| [`agent/alerts.ts`](agent/alerts.ts) | Owner alerts: each owner signs a subscription with the vault's owner key (email, webhook, daily digest written by Claude); the fleet honours only signatures from the vault's current owner |
| [`contracts/PilotRegistry.sol`](contracts/PilotRegistry.sol), [`agent/pilots.ts`](agent/pilots.ts) | The pilot marketplace: any agent lists itself with a name, link and fee; owners pick one by a track record read from the chain (vaults flown, their value, trades, pauses), not one the pilot reports |
| [`agent/mcp.ts`](agent/mcp.ts) | MCP server: any AI agent can fly a vault under the same onchain limits ([docs/MCP.md](docs/MCP.md), `npm run mcp`) |
| [`agent/relayer.ts`](agent/relayer.ts) | Testnet oracle relayer: real stock prices from Pyth's Hermes API onto the testnet feeds, with deviation and heartbeat rules, honest publish times, and no updates while the market is closed (`npm run relay`) |
| [`agent/backtest.ts`](agent/backtest.ts) | The real planner and rules over 200 simulated markets against buy-and-hold (the web app's Backtest tab) |
| [`agent/reporter.ts`](agent/reporter.ts) | Claude writes the owner's report from facts computed onchain, never inventing numbers |
| [`agent/ask.ts`](agent/ask.ts) | Ask your vault: answers from onchain facts, citations checked against the vault's history, trade reasons verified against their onchain hash |
| [`agent/tax.ts`](agent/tax.ts) | Tax lots from onchain events: FIFO, short and long term, fees in kind, Form 8949-style CSV, loss-harvesting candidates |
| [`agent/mandate.ts`](agent/mandate.ts) | Proposal schema, validation and presets; shared by the server, scripts and browser |
| [`web/`](web) | The web app: simulator and live mode (React, viem) |
| [`api/propose.ts`](api/propose.ts) | The strategist endpoint, as a Vercel function |
| [`agent/service.ts`](agent/service.ts) | What the fleet and relayer share: the tick loop, `/health` and Prometheus `/metrics`, graceful stop |
| [`Dockerfile`](Dockerfile), [`docker-compose.yml`](docker-compose.yml) | The services packaged for operators, plus a keyless local demo ([docs/OPERATIONS.md](docs/OPERATIONS.md)) |
| [`scripts/`](scripts) | `demo`, `deploy`, `create-vault`, `move-price`, `export-abi` |

**Why the AI drafts the mandate, but code flies the plane.** Choosing an allocation from someone's goals is a
judgment call, and Claude is good at it. The output is a draft the owner reads and signs. Executing trades is
arithmetic, and arithmetic should be deterministic and testable, so the pilot is plain code. Bring your own pilot if
you like: any agent with the pilot key gets the same onchain limits.

## How it is tested

- **Vault rules** ([`test/PilotVault.test.ts`](test/PilotVault.test.ts)): every limit, custody, pause, ownership, mandate
  validation, and a hostile venue that lies about output or tries to re-enter.
- **Model vs contract** ([`test/model.test.ts`](test/model.test.ts)): 600 random trades under random price moves, venue
  fees and clock jumps. For each one, the TypeScript model and the contract must agree, to the second, on whether it
  passes and, if not, on the exact error (bands, slippage, trade budget, cooldown, stale prices).
- **Fees and adapters** ([`test/PilotVault.test.ts`](test/PilotVault.test.ts), [`test/adapters.test.ts`](test/adapters.test.ts),
  [`test/production.test.ts`](test/production.test.ts)): pro-rata fees that leave weights untouched and stop while
  paused; Uniswap V3 routing and path checks; Pyth scaling and confidence; a full production deploy against mocks.
- **Browser** ([`e2e-web/`](e2e-web), `npm run e2e`): Playwright against a local chain and the real dev server: the
  guided tour, every attack blocked in the simulator, the backtest, plain-words refinement, listing and hiring a pilot
  in the marketplace, naming an heir who then claims the vault, a taxable sale exported as CSV, asking the vault why it
  sold, a market crash tripping the crash guard, the stress test, and a live vault created, piloted, paused and emptied from the
  browser.
- **Services** ([`test/fleet.test.ts`](test/fleet.test.ts), [`test/mcp.test.ts`](test/mcp.test.ts),
  [`test/reporter.test.ts`](test/reporter.test.ts), [`test/relayer.test.ts`](test/relayer.test.ts),
  [`test/backtest.test.ts`](test/backtest.test.ts), [`test/service.test.ts`](test/service.test.ts)): the fleet flies
  only its vaults and survives one failing; an MCP client drives the server end to end; reports never invent numbers;
  the relayer's push rules; the backtest never proposes a rejected trade; health goes stale when ticks stop.
- **Docker** ([`scripts/docker-smoke.sh`](scripts/docker-smoke.sh)): the service image against a chain in containers:
  the pilot reports healthy, trades after a rally, counts it in `/metrics`, and stops cleanly on SIGTERM.
- **Planner** ([`test/planner.test.ts`](test/planner.test.ts)): after market shocks, the pilot returns the portfolio near
  target using only trades the vault accepts, stops at the daily limit, and refuses to trade on stale prices.
- **Strategist** ([`test/strategist.test.ts`](test/strategist.test.ts)): a sloppy proposal (unknown assets, weights that
  don't add up, absurd bands) is repaired and every fix is reported; every preset mandate is accepted by the vault.

## Also on Solana (proof of concept)

[`solana/`](solana) has the same mandate rules as a `no_std` Rust crate, proven to reach the same verdicts as the
TypeScript model (and so the EVM contract) on 3,000 random scenarios, and a Solana program built on it: vault PDAs that
own the token accounts, pilot-only `Rebalance` through an owner-chosen venue judged on what actually arrived, owner-only
`Withdraw`, pause. Tested natively with a simulated runtime; see [solana/README.md](solana/README.md) for what that does
and does not prove.

## Gas

A trade with every mandate check costs 155k gas with 2 assets and 285k with 8, under a cent at typical L2 gas prices.
Full table for every action: [docs/GAS.md](docs/GAS.md) (`npm run gas`).

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

To run the hosted pilot and the price relayer as services (Docker, health checks, metrics), see
[docs/OPERATIONS.md](docs/OPERATIONS.md).

## Status and honest limits

This is a hackathon build. The contracts are tested but **not audited**; do not put real money in them.
[SECURITY.md](SECURITY.md) has the threat model, the invariants that are fuzzed, and the triaged Slither findings that CI
enforces.

- Prices come from oracles. A wrong oracle price is the main trust assumption: the slippage and band checks are only
  as good as the feed.
- Tokens dropped from a mandate stay in the vault, unpriced, until the owner withdraws them or lists them again.
- Market hours: tokenized stocks may trade around the clock, but feeds for some may pause. The vault refuses to trade
  on a price older than `maxPriceAge`, and the pilot holds.

## Roadmap

1. Live deployments on Robinhood Chain testnet and Arbitrum Sepolia, the relayer running, and the web app on Vercel.
2. Mainnet: real tokenized-stock tokens, feeds and DEX pools in a `deploy/` config, then an audit.
3. Run the hosted fleet pilot for other people's vaults (the image, health checks and metrics are ready).
4. More chains where tokenized stocks trade, including Solana.

## License

MIT
