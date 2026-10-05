# Security and threat model

StockPilot's contracts are **tested but not audited**. Do not deposit real money until they are. This file states
what the vault is meant to guarantee, against whom, how that is checked, and what is out of scope.

## Roles and what each can do

| Role | Can | Cannot |
|---|---|---|
| **Owner** (the user) | Withdraw anything at any time (paused or not), set or replace the mandate, set the pilot and the venue, set or cancel the fee, pause and unpause, transfer ownership in two steps | Renounce ownership (it would lock funds) |
| **Pilot** (an agent or the hosted fleet) | Call `rebalance` within the mandate; pause (an emergency brake) | Withdraw, change the mandate, venue, pilot or fee, unpause |
| **Fee recipient** | Receive the fee, at most 2% a year | Anything else |
| **Anyone** | Deposit; trigger `collectFee` (which only ever pays the fee recipient) | Anything else |
| **Venue adapter** (chosen by the owner) | Swap the exact amount the vault approves for one trade | Move anything else; its claims about output are ignored |

## Threats and mitigations

| Threat | Mitigation | Where it is tested |
|---|---|---|
| A compromised or confused pilot drains the vault | The pilot can only call `rebalance`; every trade is checked against the mandate at oracle prices; custody functions are owner-only | `test/PilotVault.test.ts` (custody), `test/invariants.test.ts` (pilot never paid, over 450 random actions) |
| The pilot concentrates the portfolio | Band rule: no asset may end outside its band unless the trade moved it toward target without crossing | `test/PilotVault.test.ts`, `test/model.test.ts` (600 random trades, exact agreement) |
| Churn or bursts | Per-trade cap, a 24-hour budget that refills continuously (no midnight reset), cooldown | `test/PilotVault.test.ts`, `test/model.test.ts` |
| Sandwiching, a colluding venue, a venue that lies | Output measured from the vault's own balances and valued at oracle prices; `maxSlippageBps` capped at 10%; approvals reset to zero after each trade | `HostileAdapter` tests, `test/adapters.test.ts` |
| Reentrancy through the venue or a token | `nonReentrant` on every function that moves tokens; trade effects recorded before the external call | `HostileAdapter` re-entry test |
| Stale or broken prices (closed market, dead feed) | Trades revert on prices older than `maxPriceAge`; non-positive or future-dated answers revert; the Pyth adapter refuses wide confidence intervals | `test/PilotVault.test.ts`, `test/adapters.test.ts` |
| A token freezes the vault (regulated stablecoins and stock tokens can) | Fee collection skips a failing token, so it can never block withdrawing the other assets or pausing | `test/invariants.test.ts` (frozen token) |
| Excessive fees | Fee capped at 2%/yr in the contract, taken pro-rata (weights never move), not accrued while paused, settled before withdrawals and deposits so new money is never charged for past time, cancellable by the owner | `test/PilotVault.test.ts` (fees), `test/invariants.test.ts` (fee never above the cap) |
| A pilot rewrites its own limits by re-mandating | Only the owner can set the mandate; the spent budget carries over a re-mandate | `test/PilotVault.test.ts` |
| Funds locked forever | `renounceOwnership` reverts; ownership moves in two steps; `withdraw` clamps to the balance | `test/PilotVault.test.ts`, `test/invariants.test.ts` (owner always withdraws everything) |

## Trust assumptions (out of scope)

- **Oracles.** Prices come from feeds the owner chooses. A wrong price is the main trust assumption: the slippage and
  band checks are only as good as the feed.
- **Tokens.** Listed tokens are standard ERC-20s chosen by the owner (no fee-on-transfer, no rebasing, no transfer
  hooks). The vault measures balances, so an unusual token can at worst make trades revert.
- **The venue.** The owner chooses it. A malicious venue can make trades fail, but cannot take more than the amount
  approved for one trade, and cannot pass a bad fill (that is judged at oracle prices).
- **Plain transfers.** Tokens sent to the vault with a plain transfer instead of `deposit` skip fee settlement, so they
  may be charged the fee for the period since the last settlement.

## Static analysis

[Slither](https://github.com/crytic/slither) runs in CI over the production contracts (mocks excluded) and fails on any
finding not recorded in `slither.db.json`. The recorded findings, and why each is accepted:

| Detector | Finding | Why it is accepted |
|---|---|---|
| `reentrancy-balance` (high) | `rebalance` reads balances before the venue call and uses them after | That is the design: the pre-swap balance is the baseline for measuring what actually arrived. Every function that moves tokens is `nonReentrant`, and unsolicited transfers into the vault can only add to it. |
| `unused-return` | The venue's returned `amountOut` and the feed's round ids are ignored | Deliberate: the vault never trusts the venue's claim, and round ids carry no information the vault uses. |
| `incorrect-equality` | Comparisons with zero (`total == 0`, `amount == 0`, `feeBps == 0`) | Guards on exact zero, not on balances an attacker can nudge. |
| `calls-loop` | Loops over listed tokens call `balanceOf`, feeds and transfers | Bounded at 8 assets chosen by the owner; fee collection tolerates a failing token. |
| `timestamp` | Cooldown, budget, fee and staleness use `block.timestamp` | Intended; validator timestamp drift is seconds against windows of minutes to days. |
| `missing-zero-check` | `setPilot(0)` and `setAdapter(0)` | Zero is the documented way to revoke the pilot or stop trading. |
| `pyth-unchecked-publishtime` | `PythPriceFeed` does not check the publish time | The vault checks every price's age against the mandate's `maxPriceAge`; a second, different limit in the adapter would only confuse. |
| `pyth-unchecked-confidence` | Reported although the adapter does check confidence | False positive: `latestRoundData` reverts when `conf` exceeds `maxConfBps` of the price. |

## Reporting

Please report vulnerabilities privately through GitHub's security advisories for this repository rather than in a
public issue.
