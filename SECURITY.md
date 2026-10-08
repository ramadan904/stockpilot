# Security and threat model

StockPilot's contracts are **tested but not audited**. Do not deposit real money until they are. This file states
what the vault is meant to guarantee, against whom, how that is checked, and what is out of scope.

## Roles and what each can do

| Role | Can | Cannot |
|---|---|---|
| **Owner** (the user) | Withdraw anything at any time (paused or not), set or replace the mandate, set the pilot and the venue, set or cancel the fee, pause and unpause, transfer ownership in two steps | Renounce ownership (it would lock funds) |
| **Pilot** (an agent or the hosted fleet) | Call `rebalance` within the mandate; pause (an emergency brake) | Withdraw, change the mandate, venue, pilot or fee, unpause |
| **Heir** (optional, named by the owner) | Take ownership after the owner has done nothing with the vault for the whole inactivity period (30 days to 10 years) | Anything before then; anything at all once the owner acts, renames or removes the heir, or hands the vault to someone else |
| **Fee recipient** | Receive the fee, at most 2% a year | Anything else |
| **Anyone** | Deposit; trigger `collectFee` (which only ever pays the fee recipient) | Anything else |
| **Venue adapter** (chosen by the owner) | Swap the exact amount the vault approves for one trade | Move anything else; its claims about output are ignored |

## Threats and mitigations

| Threat | Mitigation | Where it is tested |
|---|---|---|
| A compromised or confused pilot drains the vault | The pilot can only call `rebalance`; every trade is checked against the mandate at oracle prices; custody functions are owner-only | `test/PilotVault.test.ts` (custody), `test/invariants.test.ts` (pilot never paid, over 600 random actions) |
| The pilot concentrates the portfolio | Band rule: no asset may end outside its band unless the trade moved it toward target without crossing | `test/PilotVault.test.ts`, `test/model.test.ts` (600 random trades, exact agreement) |
| Churn or bursts | Per-trade cap, a 24-hour budget that refills continuously (no midnight reset), cooldown | `test/PilotVault.test.ts`, `test/model.test.ts` |
| Sandwiching, a colluding venue, a venue that lies | Output measured from the vault's own balances and valued at oracle prices; `maxSlippageBps` capped at 10%; approvals reset to zero after each trade | `HostileAdapter` tests, `test/adapters.test.ts` |
| Reentrancy through the venue or a token | `nonReentrant` on every function that moves tokens; trade effects recorded before the external call | `HostileAdapter` re-entry test |
| Stale or broken prices (closed market, dead feed) | Trades revert on prices older than `maxPriceAge`; non-positive or future-dated answers revert; the Pyth adapter refuses wide confidence intervals | `test/PilotVault.test.ts`, `test/adapters.test.ts` |
| A token freezes the vault (regulated stablecoins and stock tokens can) | Fee collection skips a failing token, so it can never block withdrawing the other assets or pausing | `test/invariants.test.ts` (frozen token) |
| Excessive fees | Fee capped at 2%/yr in the contract, taken pro-rata (weights never move), not accrued while paused, settled before withdrawals and deposits so new money is never charged for past time, cancellable by the owner | `test/PilotVault.test.ts` (fees), `test/invariants.test.ts` (fee never above the cap) |
| A pilot rewrites its own limits by re-mandating | Only the owner can set the mandate; the spent budget carries over a re-mandate | `test/PilotVault.test.ts` |
| Someone redirects an owner's alerts | Subscriptions are signed messages; the fleet and `/api/subscribe` accept only signatures by the vault's current onchain owner, and edits after signing invalidate them | `test/alerts.test.ts` |
| A pilot lies in the marketplace (a fake name, an inflated record) | `PilotRegistry` grants nothing: a vault trusts only the address its owner set, within the mandate. Names are self-described, so the web app shows each pilot's address and a track record computed from vault events and balances, never one the pilot reports; trades count only after the vault's latest `PilotSet` | `test/registry.test.ts` |
| An heir takes the vault while the owner is alive and well | The heir can claim only after a full inactivity period (at least 30 days) with no owner action; every owner action restarts the clock, and the pilot's activity never does; the fleet emails and posts check-in reminders in the last quarter of the period; a change of owner clears the heir | `test/inheritance.test.ts`, `test/invariants.test.ts` (claims succeed exactly when allowed, over 600 random actions), `test/alerts.test.ts` |
| A pilot (or nobody) ignores a crash | Past the owner's drawdown, anyone can `poke()` the vault into defensive targets, and any trade attempted while the condition holds is judged against them, so the pilot can only de-risk; the fleet pokes every tick; only the owner exits defensive mode | `test/crashguard.test.ts`, `test/invariants.test.ts` (defensive mode only ever entered past the drawdown) |
| Someone trips or blocks the crash guard falsely | Owner withdrawals re-arm the peak, so taking money out is never a crash; deposits by anyone only raise the peak; the check uses fresh oracle prices, so a stale price cannot trip it | `test/crashguard.test.ts` |
| A recurring investment drains the owner's wallet | Pulls move exactly the owner's preset amount, at most once per interval (missed periods are not caught up), only into the owner's own vault, never while paused, and never beyond the allowance the owner gave; they are not owner activity, so they cannot keep an heir waiting | `test/recurring.test.ts`, `test/invariants.test.ts` (a pull is never early and never the wrong amount) |
| A relayed signature is replayed or misused | Signed actions are limited to check-in and pause; each EIP-712 signature names the vault and chain, carries a nonce and a deadline, and works once; ERC-1271 smart wallets are supported through `SignatureChecker` | `test/recurring.test.ts` |
| Someone drains the operator's relay key | The relay pays only for genuine vaults (the address must run the exact EIP-1167 clone code of a deployment factory's implementation), dry-runs every call so invalid signatures cost nothing, and relays at most three actions per vault an hour | `test/recurring.test.ts` |
| A new owner's wallet is pulled on the old owner's schedule | Any change of owner (a transfer or an inheritance) stops the recurring investment, as it clears the heir | `test/recurring.test.ts` |
| A vault clone taken over by initialising it | Each vault is a minimal proxy created and initialised in one factory transaction; `initialize` runs once; the shared implementation is locked in its constructor and can never be initialised | `test/PilotVault.test.ts` (clones) |
| A fund buyer, redeemer or donor takes value from other holders | Shares are sold at the vault's value at fresh prices, rounded down; redemptions pay a pro-rata slice in kind, rounded down, after settling the fee; a gift before the first purchase goes to the first buyer, and a $1 minimum keeps share prices meaningful | `test/fund.test.ts`, `test/fund-invariants.test.ts` (450 random purchases, redemptions, transfers, gifts, price moves, pilot trades and stale periods over three seeds: a purchase never lowers the value per share, a buyer never gets more than they paid, a redemption pays exactly its slice and never more, purchases at stale prices are refused, supply and votes always match the holders, and the fund itself never keeps money) |
| Funds locked forever | `renounceOwnership` reverts; ownership moves in two steps; `withdraw` clamps to the balance | `test/PilotVault.test.ts`, `test/invariants.test.ts` (owner always withdraws everything) |

## Trust assumptions (out of scope)

- **Oracles.** Prices come from feeds the owner chooses. A wrong price is the main trust assumption: the slippage and
  band checks are only as good as the feed.
- **Tokens.** Listed tokens are standard ERC-20s chosen by the owner (no fee-on-transfer, no rebasing, no transfer
  hooks). The vault measures balances, so an unusual token can at worst make trades revert.
- **The venue.** The owner chooses it. A malicious venue can make trades fail, but cannot take more than the amount
  approved for one trade, and cannot pass a bad fill (that is judged at oracle prices).
- **Pilot funds.** Shares are bought at the vault's value at oracle prices no older than the mandate's `maxPriceAge`.
  If the market has moved and the feed has not caught up yet, a buyer can pay the old price and later leave in kind at
  the new one, at the other holders' expense. The window is the feed's lag, bounded by `maxPriceAge`; tight feeds and
  a short `maxPriceAge` keep it small. Leaving never depends on prices.
- **Gas-free fund actions.** The operator's relay (`/api/fund`, paid by `SIGNATURE_RELAY_KEY`) can buy trial shares
  for a wallet on testnets and submit a holder's signed redemption. It cannot do anything else with a fund: a
  redemption signature binds the holder, the number of shares, where the holdings go, a one-time nonce and a deadline,
  and the fund checks it. Trials are rate-limited (one per wallet per fund a day, 30 an hour in all) so nobody can
  drain the relay's gas; the limits live in memory, so a restarted relay forgets them.
- **Firing the pilot.** Holders of a majority of a fund's shares, as they stood a day before a motion began, can
  remove its pilot at once. Shares bought after that record time never vote, so votes cannot be bought for the
  occasion; a holder who had the shares a day earlier may vote and then leave. A firing only removes the pilot: it
  moves no funds, and the manager can announce a new one with the usual notice.
- **Plain transfers.** Tokens sent to the vault with a plain transfer instead of `deposit` skip fee settlement, so they
  may be charged the fee for the period since the last settlement.

## Static analysis

[Slither](https://github.com/crytic/slither) runs in CI over the production contracts (mocks excluded) and fails on any
finding not recorded in `slither.db.json`. The recorded findings, and why each is accepted:

| Detector | Finding | Why it is accepted |
|---|---|---|
| `reentrancy-balance` (high) | `rebalance` reads balances before the venue call and uses them after | That is the design: the pre-swap balance is the baseline for measuring what actually arrived. Every function that moves tokens is `nonReentrant`, and unsolicited transfers into the vault can only add to it. |
| `arbitrary-send-erc20` (high) | `pullRecurringDeposit` calls `transferFrom` on behalf of an address other than the caller | The `from` is always the vault's owner, the destination is always the vault, and the amount and timing are the owner's own settings, capped by the allowance the owner gave. A caller can only move the owner's money into the owner's vault on the owner's schedule; tested in `test/recurring.test.ts` and fuzzed. |
| `unused-return` | The venue's returned `amountOut` and the feed's round ids are ignored | Deliberate: the vault never trusts the venue's claim, and round ids carry no information the vault uses. |
| `incorrect-equality` | Comparisons with zero (`total == 0`, `amount == 0`, `feeBps == 0`) | Guards on exact zero, not on balances an attacker can nudge. |
| `calls-loop` | Loops over listed tokens call `balanceOf`, feeds and transfers | Bounded at 8 assets chosen by the owner; fee collection tolerates a failing token. |
| `timestamp` | Cooldown, budget, fee, staleness, the inheritance deadline and the glide path (and so every target the vault judges trades by) use `block.timestamp` | Intended; validator timestamp drift is seconds against windows of minutes to days (30 days at least for inheritance). A glide path moves targets over days to years, so a few seconds of drift moves a target by a negligible fraction of a basis point. |
| `missing-zero-check` | `setPilot(0)`, `setAdapter(0)`, and the same two in `initialize` | Zero is the documented way to revoke the pilot or stop trading, from creation onwards. |
| `calls-loop` (credential) | `MandateCredential.mandateHash` reads each asset of the vault in a loop | View-only reads from a genuine StockPilot vault (its clone code hash is checked), bounded at 8 assets. |
| `timestamp` (credential) | `MandateCredential.issue` compares `block.timestamp` with the enrollment time plus `minAge` | That is the point: how long a mandate stood. Drift of seconds against a minimum of a day or more is immaterial. |
| `incorrect-equality`, `calls-loop` (fund) | `PilotFund` guards on exact zero (supply, shares, amounts, no pending pilot, no motion, no pilot to fire) and redeems by looping over the vault's tokens | Zero guards cannot be nudged into a wrong branch: a donation before the first purchase goes to the first buyer, and after it shares are priced by the value per share. The loop is bounded at 8 assets, and a token that will not move is skipped, so it can never trap a holder's other assets. |
| `unused-return` (fund) | `PilotFund` reads only the total from `portfolio()` and only `maxPriceAge` from `limits()` | The other fields are not needed there. |
| `missing-zero-check` (fund) | `proposePilot(0)` | As for the vault, zero removes the pilot, and the same three days' notice applies. |
| `timestamp` (fund) | The pilot-change notice, the price-age check on purchases, holders' motions (the one-day vote record, the three-day window), and the deadline on a signed redemption | Intended; seconds of drift against windows of a day or more and the mandate's price age. Votes are counted from checkpoints by timestamp (`clock()` is `block.timestamp`). |
| `reentrancy-benign`, `reentrancy-events` (fund factory) | `createFund` records the fund after `new PilotFund` | The only external code run is the fund's own constructor and the StockPilot vault factory, both ours. |
| `pyth-unchecked-publishtime` | `PythPriceFeed` does not check the publish time | The vault checks every price's age against the mandate's `maxPriceAge`; a second, different limit in the adapter would only confuse. |
| `pyth-unchecked-confidence` | Reported although the adapter does check confidence | False positive: `latestRoundData` reverts when `conf` exceeds `maxConfBps` of the price. |

## Reporting

Please report vulnerabilities privately through GitHub's security advisories for this repository rather than in a
public issue.
