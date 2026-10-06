# StockPilot on Solana (proof of concept)

The same product as the EVM vault: a portfolio the owner keeps custody of, which an AI pilot may rebalance only inside
an onchain mandate. Tokenized stocks trade on Solana too, so the mandate model should not be tied to one chain.

```bash
cargo test     # rules crate, conformance against the TypeScript model, and the program's native tests
```

## Two crates

**`mandate-core`** is the rules: band, slippage against oracle prices, the 24-hour trade budget that refills
continuously, cooldown, price freshness, trade size, pause. Pure `no_std` Rust with 256-bit `mulDiv`, checks in the EVM
contract's order, error names identical to the EVM contract's custom errors.

It also has the crash guard's two rules, `guard_step` (record a new peak, or trip past the drawdown) and
`defensive_target` (the safe asset's raised target, everyone else scaled down, rounding included), exactly the EVM
vault's `_guard` and `_target`.

It is proven equal to the other two implementations by a chain of tests:

1. `test/model.test.ts`: the TypeScript model (`agent/model.ts`) and the EVM `PilotVault` agree on 600 random trades,
   to the second and on the exact revert reason.
2. `mandate-core/tests/conformance.rs`: this crate reproduces 3,000 random verdicts from that TypeScript model (every
   rule, 2 to 8 assets, 6/8/9/18 decimals), including the exact USD values of accepted trades. The vectors come from
   `npm run vectors` at the repository root; CI regenerates them and fails if they drift.
3. `mandate-core/tests/guard_conformance.rs`: 2,000 crash-guard checks and defensive-target sets from the TypeScript
   functions the backtest and simulator use (which `test/crashguard.test.ts` checks against the contract's numbers).

**`program`** is a Solana program built on `mandate-core`:

| Instruction | Who | What |
|---|---|---|
| `InitVault`, `SetMandate` | Owner | Assets (mint, the vault's token account, price feed, target, band), limits. Every token account must belong to the vault authority PDA. Re-mandating keeps the spent budget. |
| `SetPilot`, `SetVenue`, `Unpause` | Owner | Replace the agent, choose the venue program trades go through, resume |
| `Pause` | Owner or pilot | The emergency brake |
| `Rebalance` | Pilot | Checks the pilot, the venue and that every token account and price feed is the one the mandate names; runs the fill-independent rules before touching the venue; lets the venue swap with the vault authority's PDA signature; requires the venue took exactly `amount_in`; then judges what actually arrived with the full mandate check. Any failure reverts the whole transaction, swap included. |
| `Withdraw` | Owner | Any amount of any vault token account, paused or not, signed by the vault authority PDA. Re-arms the crash guard |
| `SetHeir`, `CheckIn`, `ClaimInheritance` | Owner; heir | Inheritance as on the EVM vault: after 30 days to 10 years with no owner action (every owner instruction counts, the pilot's never do), the heir becomes the owner |
| `SetCrashGuard`, `Poke`, `ExitDefensive` | Owner; anyone; owner | The crash guard as on the EVM vault: past the set fall from the recorded peak, defensive targets; `Rebalance` runs the same check first, so a pilot that never pokes is judged on them anyway |
| `InitPriceFeed`, `SetPrice` | Feed authority | A demo USD price with 8 decimals and its update time, for local testing |

**Prices.** Each asset names its price account. A Pyth `PriceUpdateV2` account (owned by Pyth's receiver program
`rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ`) is read directly: the Anchor discriminator must match, the update
must be fully verified, it must carry the asset's configured Pyth feed id (so a pilot cannot pass another asset's
price), the price must be positive with a confidence interval within 1%, and its publish time must be within the
mandate's `max_price_age`. Demo feed accounts owned by this program are accepted for local testing.

**Account layout.** The vault account holds one borsh-serialized `Vault`; inheritance and the crash guard are
appended after the trading state (layout v2, `VAULT_SPACE` sized for it). No v1 vault was ever deployed, so there is
nothing to migrate; a deployed program would add a version tag and a `realloc` path before changing the layout again.

The vault authority is the PDA `["authority", vault]`: it owns the vault's token accounts and only this program can
sign for it, so no key, not even the pilot's, can move the vault's tokens outside `Rebalance` and `Withdraw`.

## How it is tested, and what is not proven yet

The Solana build toolchain (`cargo build-sbf`) downloads from GitHub, which the environment this was built in could not
reach, so the program runs **natively on the host** in `program/tests/native.rs`. The runtime is simulated with the
SDK's `program_stubs`: the SPL Token program's `Transfer`, a stand-in DEX venue, and the runtime's signer rule (every
signer of a cross-program call must have signed the transaction or be a PDA the caller proves with its seeds). The
tests cover: creating a vault, a rebalance after a rally, refusing to concentrate the portfolio, judging fills against
the oracle, a venue that takes too much, pilot-only trading through the owner's venue, a pilot substituting its own
price feed, feed authority, stale prices refused before any swap, cooldown and trade size, pause and resume, owner
withdrawal through the PDA even when paused, unsigned PDA transfers rejected, re-mandating without resetting the
budget, and Pyth accounts: a trade priced by Pyth, and partial verification, another feed's account, a wide confidence
interval and a stale publish time each refused.

Not yet shown, because it needs a real validator: compute-unit cost, rollback of the venue's transfers on failure
(the runtime guarantees it; the native tests never rely on state after an error), integration with a real DEX
(Jupiter), and reading live Pyth accounts (the parser follows Pyth's documented `PriceUpdateV2` layout and is tested
against accounts built to it, not against ones fetched from mainnet). Time is read from the Clock sysvar on-chain; host builds of the SDK cannot
read sysvars, so tests set `test_clock::NOW`, which is not compiled into the on-chain program.

Next steps: build with `cargo build-sbf`, run the same scenarios in LiteSVM or `solana-test-validator` with real Pyth
accounts cloned from mainnet, and route through Jupiter as the venue.
