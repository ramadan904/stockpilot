# StockPilot: Crypto World's Fair submission

> **An AI autopilot for tokenized stock portfolios that can only trade inside the rules you sign.**
>
> The AI does the work. The contract keeps it honest. Proven live by the Attack Theater, and by 600 randomized
> trades on which an exact model of the rules and the deployed contract agree.

| | |
|---|---|
| **Track** | Ethereum ecosystem: Robinhood Chain (primary), Arbitrum |
| **Repository** | https://github.com/ramadan904/stockpilot |
| **Live app** | https://stockpilot-six-virid.vercel.app (simulator, backtest, stress test and tour need no wallet) |
| **Live vault** | [A funded demo vault on Robinhood Chain testnet](https://stockpilot-six-virid.vercel.app/?chain=46630&vault=0xDBc0d40a791eEefB7E210c889F465b855DafD303) and [one on Arbitrum Sepolia](https://stockpilot-six-virid.vercel.app/?chain=421614&vault=0xfFfEBea2C701CA2cfD406D89580aE984adb0a783), read-only, no wallet needed |
| **Live fund** | [The demo fund on Robinhood Chain testnet](https://stockpilot-six-virid.vercel.app/?chain=46630&vault=0xB0Ba256d27902611c4A6C2f9f6df5CCd1F7c8362) and [on Arbitrum Sepolia](https://stockpilot-six-virid.vercel.app/?chain=421614&vault=0xDBc0d40a791eEefB7E210c889F465b855DafD303): buy in free, no gas |
| **Contracts** | Robinhood Chain testnet (chain 46630): factory [`0x318259c1153aa118733b5914e45bd53caf984664`](https://explorer.testnet.chain.robinhood.com/address/0x318259c1153aa118733b5914e45bd53caf984664), pilot registry [`0x12e02f0b852274948859c8ed8e10a414f5febeeb`](https://explorer.testnet.chain.robinhood.com/address/0x12e02f0b852274948859c8ed8e10a414f5febeeb), fund factory [`0x9da047114924f48d5351f11b5704fbd2cc48a61d`](https://explorer.testnet.chain.robinhood.com/address/0x9da047114924f48d5351f11b5704fbd2cc48a61d), pilot journal [`0x8d165798dfd3a9fade85a3d6defcf61f0b7b4475`](https://explorer.testnet.chain.robinhood.com/address/0x8d165798dfd3a9fade85a3d6defcf61f0b7b4475), Verified Mandate [`0x68f5d170de04e0d6459e05f3099c7d20e7eb70cb`](https://explorer.testnet.chain.robinhood.com/address/0x68f5d170de04e0d6459e05f3099c7d20e7eb70cb), demo vault [`0xDBc0d40a791eEefB7E210c889F465b855DafD303`](https://explorer.testnet.chain.robinhood.com/address/0xDBc0d40a791eEefB7E210c889F465b855DafD303), demo fund [`0xe314456Fc476bF48d605a703D102edc75B2231e7`](https://explorer.testnet.chain.robinhood.com/address/0xe314456Fc476bF48d605a703D102edc75B2231e7). Arbitrum Sepolia (chain 421614): factory [`0x318259c1153aa118733b5914e45bd53caf984664`](https://sepolia.arbiscan.io/address/0x318259c1153aa118733b5914e45bd53caf984664), fund factory [`0x8a03e482f0408ec9f1bcd7480d6069741fc46918`](https://sepolia.arbiscan.io/address/0x8a03e482f0408ec9f1bcd7480d6069741fc46918), pilot journal [`0xe146f77054d48fdffd4e42dcc04f152f3b749dd9`](https://sepolia.arbiscan.io/address/0xe146f77054d48fdffd4e42dcc04f152f3b749dd9), demo vault [`0xfFfEBea2C701CA2cfD406D89580aE984adb0a783`](https://sepolia.arbiscan.io/address/0xfFfEBea2C701CA2cfD406D89580aE984adb0a783), demo fund [`0x3E87cA2496cc9cd8d8Ada7868D2ea3a5d10A5D5D`](https://sepolia.arbiscan.io/address/0x3E87cA2496cc9cd8d8Ada7868D2ea3a5d10A5D5D). Every address and its source: `deployments/*.json`; check the live code against this repository with the app's Code check or `npm run check-code` |
| **Demo** | [`media/live-demo.mp4`](media/live-demo.mp4) (98 s, captioned): the live vault, the Attack Theater, a Verified Mandate, the pilot's letter, the demo fund, copying the rules into the simulator, a backtest, the Network tab. Recorded by `npm run video` against a local chain running the same contracts. Also [`media/simulator-demo.mp4`](media/simulator-demo.mp4) (53 s), or run `npm run demo` |
| **Built** | From an empty repository during the hackathon (first commit 5 October 2026) |

## Judges: start here (no wallet, under two minutes)

1. **Watch the [100-second demo](media/live-demo.mp4)**, captioned, recorded straight from the running app.
2. **[Open the live app](https://stockpilot-six-virid.vercel.app)** and press **Take the 60-second tour**. Then the
   **[Network](https://stockpilot-six-virid.vercel.app/?view=network&chain=46630)** tab: every vault, fund, pilot and
   trade on Robinhood Chain testnet, read straight from the chain, drawn as a constellation: pilots are stars, their
   vaults orbit them, glowing with their mood. Below it, the **Code check** shows every live contract matching this
   repository's code, instruction for instruction.
3. **[Open the live demo vault](https://stockpilot-six-virid.vercel.app/?chain=46630&vault=0xDBc0d40a791eEefB7E210c889F465b855DafD303)** on Robinhood Chain testnet, read
   straight from the chain: its mood lamp, its last rebalance, its activity.
4. On that page press **Simulate a compromised pilot**: the **Attack Theater** sends nine attacks to the live contract
   from the pilot's own address and shows the contract's own refusals. Nothing is signed or spent.
5. Below it, the vault's **Verified Mandate**: a soulbound credential, fully onchain, that it kept its rules.
   Then **Letters from the pilot**: the pilot's daily letter to the owner, published onchain and signed by the key
   that trades, its text checked against the hash the contract recorded.
6. Press **Copy this mandate**: its rules become your draft in the simulator. Move the market, run the pilot, try the
   attacks yourself, then open **Backtest**.
7. Back on the Live tab, **Open the demo fund**: the same pilot flies a pooled vault anyone can buy into and leave at
   any time with their share of every holding. Connect any wallet and press **Try it free**: $100 of shares, and
   **Redeem without gas** to leave. No testnet ETH needed for either.
8. Optional, in a terminal: `npm install && npm run mcp:demo` shows what an AI agent sees through our MCP server on
   that same vault, read-only and without a key, ending with the contract refusing a hijacked agent's trade.

Testnet software, unaudited: do not use real money.

## TL;DR for judges

- **The problem:** people want AI to manage their portfolios, but today an AI agent either holds your keys (one bug
  or prompt injection away from draining you) or only makes suggestions you execute by hand.
- **The product:** you describe your goal in plain words. Claude drafts a *mandate* (target weights, how far each may
  drift, how much may trade per trade and per day). You sign it into a vault you own. A pilot keeps the portfolio on
  target, and **the vault contract checks every trade against your mandate**, so even a fully compromised pilot
  cannot withdraw, change the rules, concentrate your portfolio or take a bad price.
- **Proof, not promises:** 294 unit and contract tests, including 600 random trades on which an exact TypeScript model
  of the rules and the deployed contract must agree to the second; 33 browser tests against a real local chain; 40
  Rust tests for the Solana port; Slither in CI and stateful invariant fuzzing. On the live vault, the Attack Theater
  lets anyone watch the contract refuse nine attacks from the pilot's own address.
- **A business, not just a contract:** a management fee of up to 2% a year, taken onchain, paused with the vault and
  cancellable by the owner, pays a hosted pilot fleet; an onchain pilot
  marketplace where any AI agent lists itself and owners hire by a track record read from the chain; any agent can fly
  a vault through our MCP server; Claude writes the owner's reports; a backtest shows what the mandate does to risk.
  Owners pay their pilot onchain and nobody else; StockPilot earns as the House Pilot, one pilot among many
  ([business model](README.md#business-model)).
- **Try it in one click:** the web app's simulator needs no wallet. Live mode creates, funds, pilots, pauses and
  withdraws from a real vault on Robinhood Chain testnet.

## For the submission form

- **One line:** An AI autopilot for tokenized stocks that cannot drain you, because the contract won't let it.
- **What's different:** other AI trading agents either hold your keys or only make suggestions. StockPilot's pilot can
  only rebalance, inside a mandate the owner signed, and anyone can watch the live contract refuse a stolen pilot key.
- **Why Robinhood Chain:** tokenized stocks trade around the clock, so they need a manager that never sleeps and never
  needs your keys; every trade is checked against oracle prices and freshness onchain.
- **Live:** https://stockpilot-six-virid.vercel.app · demo video `media/live-demo.mp4` · contracts linked above.

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
  Its light carries meaning: the aurora behind the page is the draft's own allocation (one light per asset, sized by
  weight), each vault's lamp glows with its worst drift against its band, and every attack the contract refuses lands
  as a red shield flash. All of it stills for readers who ask for reduced motion.
  Any strategy or live vault becomes a **share card**: a 1200x630 image of its allocation as light, its rules and
  (for a vault) its mood, saved as PNG for social posts or SVG.
  **Copy-trading by mandate:** any live vault's targets, bands and limits (as shares of the vault, so they fit any
  size) become a visitor's draft in one click. The rules are copied; the funds, owner and pilot never are.
  **Verified Mandate:** a soulbound credential (ERC-721, ERC-5192 locked) a vault's owner can mint once the vault has flown one
  mandate, unchanged, for a day; fully onchain metadata and image, only for genuine StockPilot vaults, and `isCurrent`
  tells any protocol or agent whether the vault still flies those exact rules.
  **Pilot funds:** a vault many people own together (`PilotFund`, an ERC-20 share token). Buy in with any mandate
  asset at the vault's value at fresh oracle prices; leave at any time with your exact share of every holding, in
  kind, which needs no prices and works while paused. The mandate, fee and venue can never change, and a new pilot
  takes over only after three days' notice, so holders can always leave first. And the holders can fire the AI:
  a majority of the shares, as they stood a day before the motion (so votes can't be bought for it), removes the
  pilot at once. An AI-managed fund whose rules are
  enforced by the contract, not promised in a prospectus.
  **Every AI decision explained, onchain:** each trade records the hash of the pilot's reason, and the pilot then
  publishes the full text in the journal, which hashes it itself. The vault's activity feed shows each trade with
  its reason, matched word for word; a reason can't be swapped or edited afterwards.
  **Letters from the pilot:** about once a day the pilot writes to the owner (what it did, why, what to watch; in
  Claude's words from figures read onchain) and publishes it in `PilotJournal`. Only the vault's current pilot can
  post, only for a genuine vault, so every letter is a public, attributable statement by the agent that trades, and
  the page checks each text against its onchain hash.
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
- **Recurring investment:** "invest $100 every week", enforced by the vault: only the owner's set amount, at most
  once per period, within their allowance; the fleet pulls it and invests it the same tick.
- **Gasless safety actions:** check in or pause by signature (EIP-712, ERC-1271 smart wallets too), relayed by the
  operator, so proof of life and the emergency brake never depend on holding gas.
- **Stress test before you sign:** the draft mandate through five shaped crashes and rallies, left alone, piloted,
  and piloted with the crash guard, using the real planner and rules. Honest about the trade-off: the guard wins a
  long bear market and loses a V-shaped rebound.
- **Performance, honestly measured:** a live vault against its own deposits left untraded, both read from the
  chain at sampled blocks, so what the pilot added (or cost) is shown net of fees and undistorted by deposits and
  withdrawals.
- **Monthly statements:** broker-style, built only from the chain, reconciling exactly and naming the blocks they
  read; printable or saved as PDF. Plus shareable strategy links that anyone can simulate, stress-test and copy.
- **Taxes:** the vault's tax lots rebuilt from onchain events, FIFO, short and long term, the fee treated as a sale in
  kind, a Form 8949-style CSV and loss-harvesting candidates, all in the browser with exact integer arithmetic. The
  boring thing every stock investor needs in April, and almost no crypto app gets right.
- **Pilot leaderboard:** pilots ranked by what they added after fees against holding what they took over, with
  each side's worst fall and how many vault-days of evidence back it, all read from the chain; agents see the same
  through MCP.
- **Explained trades:** every planned trade is drawn with its band math before it runs (target, band, trigger, the
  weight now and after), in plain words, and the prediction matches the vault's own weights afterwards.
- **Start from what you own:** drop a statement screenshot (Claude reads it) or paste holdings, see how every
  line maps onto the vault's assets, and get a draft that mirrors your portfolio, ready to refine and sign.
- **Household:** every vault an owner has, one per goal, added up like a broker's all-accounts view: total, share in
  stocks, combined allocation, and each goal's safeguards at a glance.
- **Glide path:** a target-date fund you hold yourself. The vault moves its own targets toward the owner's end mix
  by a date, every trade judged against where the path has reached; the crash guard works on top. Backtested with and
  without it: lower drawdowns, a lower typical ending value, both shown.
- **Tax-aware pilot:** the vault sells FIFO, so the pilot knows what every sale realizes before making it. It picks the
  cheapest sale among the trades that still rebalance, avoids wash sales, and keeps within the owner's yearly gains
  budget unless a band forces a sale; the mandate stays exactly as strict. Backtested after tax over the same markets:
  with a $0 budget, about 40% less tax along the way for a balanced mandate, at the cost of more drift (shown).
- **Ask your vault:** plain-words questions answered by Claude from facts read from the chain, never from memory.
  Every cited transaction is checked against the vault's history (invented ones are removed and flagged), and a
  trade's explanation is shown as the pilot's own only when it hashes to the commitment stored with the trade.
- **Security:** Slither in CI (fails on any untriaged finding), stateful invariant fuzzing (600 random owner, pilot,
  heir and stranger actions over three seeds, and 450 random actions on a fund by several holders), and a threat model ([SECURITY.md](SECURITY.md)). This work found and
  fixed two real issues: a token that freezes the vault could have blocked withdrawals of every other asset, and
  deposits could be charged fees for time before they arrived.
- **For judges:** a one-click 60-second guided tour in the web app, a backtest tab, and an owner activity feed.
- **For owners:** refine a draft in plain words ("less Tesla, more cash"), review any mandate change side by side before
  signing, and alerts by browser, email or webhook with a daily digest written by Claude. Alert subscriptions are
  signed by the vault's owner, so nobody can redirect them. Gas for every action is in [docs/GAS.md](docs/GAS.md).
- **Multi-chain:** the mandate rules also exist as a Rust crate that reproduces 3,000 random verdicts of the TypeScript
  model exactly (which is itself proven equal to the EVM contract), and a Solana program built on it: vault PDAs,
  pilot-only rebalancing through an owner-chosen venue, owner-only withdrawals, Pyth price accounts, and the same
  inheritance, crash guard, recurring investments and glide paths as the EVM vault (the guard's rules match the TypeScript model on 2,000 more vectors).
  A proof of concept, tested natively ([solana/README.md](solana/README.md)).
- **Mainnet path:** a Uniswap V3 venue adapter (pilot-chosen multi-hop routes, path-checked), a Pyth price adapter
  that refuses wide confidence intervals, and a config-driven production deploy.
- **Testing:** 294 tests. Vault rules, fees, custody, pause and ownership; a hostile venue that lies or re-enters; 600
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
npm test          # 294 tests
npm run demo      # the whole story on a local chain, about ten seconds
npm run web       # the web app at http://localhost:5173
```

## Team

_Add your name, background, and links here._
