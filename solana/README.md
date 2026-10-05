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

It is proven equal to the other two implementations by a chain of tests:

1. `test/model.test.ts`: the TypeScript model (`agent/model.ts`) and the EVM `PilotVault` agree on 600 random trades,
   to the second and on the exact revert reason.
2. `mandate-core/tests/conformance.rs`: this crate reproduces 3,000 random verdicts from that TypeScript model (every
   rule, 2 to 8 assets, 6/8/9/18 decimals), including the exact USD values of accepted trades. The vectors come from
   `npm run vectors` at the repository root; CI regenerates them and fails if they drift.

**`program`** is a Solana program built on `mandate-core`:

| Instruction | Who | What |
|---|---|---|
| `InitVault`, `SetMandate` | Owner | Assets (mint, the vault's token account, price feed, target, band), limits. Every token account must belong to the vault authority PDA. Re-mandating keeps the spent budget. |
| `SetPilot`, `SetVenue`, `Unpause` | Owner | Replace the agent, choose the venue program trades go through, resume |
| `Pause` | Owner or pilot | The emergency brake |
| `Rebalance` | Pilot | Checks the pilot, the venue and that every token account and price feed is the one the mandate names; runs the fill-independent rules before touching the venue; lets the venue swap with the vault authority's PDA signature; requires the venue took exactly `amount_in`; then judges what actually arrived with the full mandate check. Any failure reverts the whole transaction, swap included. |
| `Withdraw` | Owner | Any amount of any vault token account, paused or not, signed by the vault authority PDA |
| `InitPriceFeed`, `SetPrice` | Feed authority | A USD price with 8 decimals and its update time |

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
withdrawal through the PDA even when paused, unsigned PDA transfers rejected, and re-mandating without resetting the
budget.

Not yet shown, because it needs a real validator: compute-unit cost, rollback of the venue's transfers on failure
(the runtime guarantees it; the native tests never rely on state after an error), and integration with a real DEX
(Jupiter) and real price accounts (Pyth). Time is read from the Clock sysvar on-chain; host builds of the SDK cannot
read sysvars, so tests set `test_clock::NOW`, which is not compiled into the on-chain program.

Next steps: build with `cargo build-sbf`, run the same scenarios in LiteSVM or `solana-test-validator`, read Pyth
`PriceUpdateV2` accounts instead of the demo feed, and route through Jupiter as the venue.
