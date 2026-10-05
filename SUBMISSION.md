# StockPilot: Crypto World's Fair submission

> **An AI autopilot for tokenized stock portfolios that can only trade inside the rules you sign.**

| | |
|---|---|
| **Track** | Ethereum ecosystem: Robinhood Chain (primary), Arbitrum |
| **Repository** | https://github.com/ramadan904/stockpilot |
| **Live app** | _add the Vercel URL after deploying_ |
| **Contracts** | _add the Robinhood Chain testnet addresses from `deployments/robinhoodTestnet.json`_ |
| **Demo** | [`media/simulator-demo.mp4`](media/simulator-demo.mp4) (53 s, captioned), or run `npm run demo` |
| **Built** | From an empty repository during the hackathon (first commit 5 October 2026) |

## TL;DR for judges

- **The problem:** people want AI to manage their portfolios, but today an AI agent either holds your keys (one bug
  or prompt injection away from draining you) or only makes suggestions you execute by hand.
- **The product:** you describe your goal in plain words. Claude drafts a *mandate* (target weights, how far each may
  drift, how much may trade per trade and per day). You sign it into a vault you own. A pilot keeps the portfolio on
  target, and **the vault contract checks every trade against your mandate**, so even a fully compromised pilot
  cannot withdraw, change the rules, concentrate your portfolio or take a bad price.
- **Proof, not promises:** 162 tests, including 600 random trades on which an exact TypeScript model of the rules and
  the deployed contract must agree to the second. In the demo, a rogue pilot tries eight attacks and the contract
  stops all eight.
- **A business, not just a contract:** a capped onchain management fee pays a hosted pilot fleet; an onchain pilot
  marketplace where any AI agent lists itself and owners hire by a track record read from the chain; any agent can fly
  a vault through our MCP server; Claude writes the owner's reports; a backtest shows what the mandate does to risk.
- **Try it in one click:** the web app's simulator needs no wallet. Live mode creates, funds, pilots, pauses and
  withdraws from a real vault on Robinhood Chain testnet.

## The problem

Tokenized stocks bring equities onchain: they trade around the clock, settle in seconds and compose with the rest of
crypto. What they don't come with is portfolio management. Someone holding five stock tokens still has to watch
prices, notice drift and rebalance by hand, at any hour.

AI agents are the obvious answer, and the obvious risk. To trade for you, an agent needs signing power. Signing power
over a wallet means the agent (or anyone who compromises it, its prompts, or its dependencies) can do anything with
your money. Existing answers are either full custody (trust the agent completely) or advice only (do the work
yourself).

## The solution

StockPilot splits the job three ways, so that no single piece has to be trusted with everything:

1. **The strategist (Claude) decides *what* you want.** It turns "I'm 30, I believe in AI, I can handle swings but
   want some cash" into a draft mandate with a short explanation per position. Plain code validates the draft
   (renormalizes weights to exactly 100%, clamps bands and limits, reports every fix). The draft is shown to you; the
   AI never touches keys or funds.
2. **You sign the mandate into a vault you own.** `PilotVault` holds your tokens. Only you can withdraw, change the
   mandate, choose the trading venue, or replace the pilot. You can pause the pilot at any time.
3. **The pilot decides *when* to trade, and the contract decides *whether it may*.** The pilot is deterministic code
   that rebalances when an asset drifts halfway to its band edge. Every trade it sends is checked onchain:

| Rule, enforced inside the transaction | Blocks |
|---|---|
| Only assets in the mandate, only through the owner's venue | Buying a rug, routing through a pilot-controlled contract |
| Per-trade and per-day USD caps | Draining the portfolio in one go |
| Cooldown between trades | Churning |
| Price freshness | Trading on a closed market's stale price |
| Output worth at least `1 - slippage` of input **at oracle prices**, measured from the vault's own balances | Sandwiching, colluding venues, adapters that lie about output |
| **Band rule:** no asset may leave its band around target, unless the trade moves it toward target without crossing it | Concentrating the portfolio, flipping overweight to underweight |

The band rule is the key idea. Inside the bands the pilot has discretion; outside them it can only repair drift,
never create it. The worst a compromised pilot can do is trade within your bands, under your daily cap, at
near-oracle prices.

Every trade also commits `keccak256(reason)`: the pilot's plain-English explanation is logged offchain, and anyone
can check it against the hash in the onchain event.

## Why it has to be onchain

The guarantee is the product. If the limits lived in the agent's code or on our server, you'd be trusting us and the
agent again. Because they live in a contract you own, they hold even if the pilot's key leaks, the model is
prompt-injected, or StockPilot the company disappears. You can always withdraw.

## What was built during the hackathon

Everything; the repository started empty.

- **Contracts** (Solidity 0.8.28, OpenZeppelin 5): `PilotVault`, `PilotVaultFactory` (one vault per user, created with
  its first mandate in one transaction), the `ISwapAdapter` venue interface, and testnet stand-ins (stock tokens,
  Chainlink-shaped feeds, an oracle-priced market maker, and a hostile adapter used in tests).
- **Agent** (TypeScript): an exact BigInt model of the vault's rules, a deterministic threshold-rebalancing planner that
  only proposes trades the model accepts, the Claude strategist (structured output, server-side refusal fallback), a
  live pilot loop, and a JSONL logbook of the rationale behind each hash.
- **Web app** (React, viem): a no-wallet simulator with market controls, autopilot and eight attack buttons; and a live
  mode to create, fund, pilot, pause, re-mandate and withdraw from a vault, with the onchain trade history.
- **Business and services:** an onchain management fee (max 2%/yr, pro-rata in kind, paused with the vault,
  cancellable); a hosted fleet pilot that flies every vault naming it, can require a fee, collects it and posts to
  Slack/Discord; an MCP server so any AI agent can pilot a vault under the same limits; Claude-written owner reports
  built from onchain facts; a backtest against buy-and-hold; a relayer that brings real stock prices to testnet; a pilot
  marketplace (onchain registry, track records computed from vault events, a picker in the web app, MCP tools for
  agents to list themselves). The fleet and relayer ship as a Docker image with health checks, Prometheus metrics and graceful shutdown, checked end
  to end in CI ([docs/OPERATIONS.md](docs/OPERATIONS.md)).
- **Inheritance:** an owner names an heir and an inactivity period (30 days to 10 years); every owner action restarts
  the clock and the pilot's never do; after a full period of silence the heir takes the vault over, still managed.
  The contract enforces it; the fleet sends check-in reminders; the web app shows the clock and lets the heir claim.
  Self-custody's biggest everyday risk, losing the key or the person, finally has the answer a brokerage account has.
- **Crash guard:** a drawdown circuit breaker the vault enforces. Past a set fall from its peak, the targets switch to
  a defensive mix and the pilot can only de-risk; anyone can trip it, the fleet does each tick, a pilot that ignores
  it is judged on the defensive targets anyway, and only the owner can lift it. Robo-advisors promise this kind of
  protection; here the contract guarantees it.
- **Stress test before you sign:** the draft mandate through five shaped crashes and rallies, left alone, piloted,
  and piloted with the crash guard, using the real planner and rules. Honest about the trade-off: the guard wins a
  long bear market and loses a V-shaped rebound.
- **Taxes:** the vault's tax lots rebuilt from onchain events, FIFO, short and long term, the fee treated as a sale in
  kind, a Form 8949-style CSV and loss-harvesting candidates, all in the browser with exact integer arithmetic. The
  boring thing every stock investor needs in April, and almost no crypto app gets right.
- **Ask your vault:** plain-words questions answered by Claude from facts read from the chain, never from memory.
  Every cited transaction is checked against the vault's history (invented ones are removed and flagged), and a
  trade's explanation is shown as the pilot's own only when it hashes to the commitment stored with the trade.
- **Security:** Slither in CI (fails on any untriaged finding), stateful invariant fuzzing (600 random owner, pilot,
  heir and stranger actions over three seeds), and a threat model ([SECURITY.md](SECURITY.md)). This work found and
  fixed two real issues: a token that freezes the vault could have blocked withdrawals of every other asset, and
  deposits could be charged fees for time before they arrived.
- **For judges:** a one-click 60-second guided tour in the web app, a backtest tab, and an owner activity feed.
- **For owners:** refine a draft in plain words ("less Tesla, more cash"), review any mandate change side by side before
  signing, and alerts by browser, email or webhook with a daily digest written by Claude. Alert subscriptions are
  signed by the vault's owner, so nobody can redirect them. Gas for every action is in [docs/GAS.md](docs/GAS.md).
- **Multi-chain:** the mandate rules also exist as a Rust crate that reproduces 3,000 random verdicts of the TypeScript
  model exactly (which is itself proven equal to the EVM contract), and a Solana program built on it: vault PDAs,
  pilot-only rebalancing through an owner-chosen venue, owner-only withdrawals. A proof of concept, tested natively
  ([solana/README.md](solana/README.md)).
- **Mainnet path:** a Uniswap V3 venue adapter (pilot-chosen multi-hop routes, path-checked), a Pyth price adapter
  that refuses wide confidence intervals, and a config-driven production deploy.
- **Testing:** 162 tests. Vault rules, fees, custody, pause and ownership; a hostile venue that lies or re-enters; 600
  randomized trades where the model and the contract must agree on success *and* on the exact revert reason; planner
  convergence after market shocks; strategist repair of malformed drafts. CI also builds the site, checks the web
  ABIs match the contracts, and runs the end-to-end demo.

## Who it is for, and how it makes money

**Users.** Holders of tokenized stocks who want the discipline of a managed portfolio without handing over custody.
That starts with crypto-native investors buying stock tokens and extends to anyone a brokerage or wallet onboards to
onchain equities.

**Distribution.** Two paths:
- **Direct:** a consumer app. You describe a goal, sign once, and the pilot runs.
- **Embedded:** the vault and pilot are infrastructure. A wallet, neobank or brokerage app offers "autopilot" to its
  users, under its own brand, on contracts that keep users in custody.

**Revenue (built).** A management fee on vaults run by the hosted pilot, taken onchain by the vault: transparent,
capped at 2% a year, charged pro-rata so it never moves the weights, paused while the vault is paused, and cancellable
by the owner at any time. The fleet pilot can serve only vaults that pay it. The pilot marketplace (`PilotRegistry`)
opens this to other agents: anyone can list a pilot and its fee, and owners compare pilots by what they have actually
done onchain, so good strategies compete on results under the same guardrails. Next: B2B licensing for embedded use.
Self-hosting the pilot, or flying it with your own agent over MCP, stays free.
The open contracts are the trust anchor; the hosted pilot, strategist and UX are the business.

## Honest limits

- The contracts are tested but **not audited**. Testnet only.
- Testnets have no tokenized-stock liquidity or stock feeds, so the testnet deployment uses stand-in tokens, mock
  feeds and an oracle-priced market maker behind the same interfaces a mainnet deployment would use.
- Oracle prices are the main trust assumption: the slippage and band checks are only as good as the feed.

## Roadmap

1. Mainnet on Robinhood Chain: real token, feed and pool addresses in a `deploy/` config (the adapters and deploy
   script are built), then an audit.
2. Run the hosted fleet for other people's vaults (the service image is ready), with owner alerts by email and webhook.
3. Embedded "autopilot" for wallets and apps, under their brand, on the same contracts.
4. Take the Solana program from proof of concept to devnet: build for SBF, Pyth price accounts, Jupiter as the venue.

## Run it

```bash
npm install
npm test          # 162 tests
npm run demo      # the whole story on a local chain, about ten seconds
npm run web       # the web app at http://localhost:5173
```

## Team

_Add your name, background, and links here._
