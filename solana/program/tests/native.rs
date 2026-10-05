//! Native tests of the StockPilot Solana program.
//!
//! The program runs on the host. The Solana runtime is simulated through `program_stubs`: the clock, the SPL Token
//! program's `Transfer`, and a test venue (a stand-in DEX). Cross-program invocations are checked the way the runtime
//! checks them: every account the callee needs as a signer must have signed the transaction or be a PDA that the
//! calling program proves with its seeds. So the vault authority's PDA signing is exercised for real.
//!
//! What this cannot show: compute-unit usage, account size limits at deployment, and rollback. On a real cluster a
//! failed instruction undoes everything it did, including the venue's transfers; here the tests only assert the
//! error, and never rely on state after a failure.

#![allow(clippy::inconsistent_digit_grouping, clippy::too_many_arguments)] // prices read as dollars_8-decimal-cents; test helpers

use std::{
    collections::HashMap,
    sync::{
        atomic::Ordering,
        Mutex, Once,
    },
};

use solana_program::{
    account_info::AccountInfo,
    entrypoint::ProgramResult,
    instruction::Instruction,
    program_error::ProgramError,
    program_stubs::{set_syscall_stubs, SyscallStubs},
    pubkey::Pubkey,
};
use stockpilot_mandate_core::WAD;
use stockpilot_solana::{
    process_instruction, vault_authority, AssetConfig, LimitsConfig, PriceFeed, StockPilotInstruction, Vault, FEED_SPACE, ID, TOKEN_PROGRAM_ID,
    VAULT_SPACE,
};

// ---------------------------------------------------------------------------------------------------------------------
// The simulated runtime
// ---------------------------------------------------------------------------------------------------------------------

use stockpilot_solana::test_clock::NOW;
static SERIAL: Mutex<()> = Mutex::new(());
static INSTALL: Once = Once::new();
const VENUE: Pubkey = Pubkey::new_from_array([7; 32]);

struct Runtime;

fn amount_of(info: &AccountInfo) -> u64 {
    u64::from_le_bytes(info.data.borrow()[64..72].try_into().unwrap())
}

fn set_amount(info: &AccountInfo, amount: u64) {
    info.data.borrow_mut()[64..72].copy_from_slice(&amount.to_le_bytes());
}

/// SPL Token `Transfer`: the authority must own the source and must be a signer of this invocation.
fn token_transfer(src: &AccountInfo, dst: &AccountInfo, authority: &Pubkey, amount: u64) -> ProgramResult {
    if src.data.borrow()[32..64] != authority.to_bytes() {
        return Err(ProgramError::IllegalOwner);
    }
    let have = amount_of(src);
    if have < amount {
        return Err(ProgramError::InsufficientFunds);
    }
    set_amount(src, have - amount);
    set_amount(dst, amount_of(dst) + amount);
    Ok(())
}

impl SyscallStubs for Runtime {
    fn sol_log(&self, _message: &str) {}

    fn sol_invoke_signed(&self, ix: &Instruction, infos: &[AccountInfo], seeds: &[&[&[u8]]]) -> ProgramResult {
        // The runtime's signer rule.
        for meta in ix.accounts.iter().filter(|m| m.is_signer) {
            let signed = infos.iter().any(|i| i.key == &meta.pubkey && i.is_signer);
            let proven = seeds.iter().any(|s| Pubkey::create_program_address(s, &ID).map(|pda| pda == meta.pubkey).unwrap_or(false));
            if !signed && !proven {
                return Err(ProgramError::MissingRequiredSignature);
            }
        }
        let find = |key: &Pubkey| infos.iter().find(|i| i.key == key).ok_or(ProgramError::NotEnoughAccountKeys);
        let acct = |n: usize| find(&ix.accounts[n].pubkey);
        if ix.program_id == TOKEN_PROGRAM_ID && ix.data.first() == Some(&3) {
            let amount = u64::from_le_bytes(ix.data[1..9].try_into().unwrap());
            return token_transfer(acct(0)?, acct(1)?, &ix.accounts[2].pubkey, amount);
        }
        if ix.program_id == VENUE {
            // Accounts: authority, vault sell, vault buy, venue reserve (sell), venue reserve (buy).
            // Data: mode, amount_in, amount_out. Mode 0 is honest; 1 takes one unit more than amount_in.
            let mode = ix.data[0];
            let amount_in = u64::from_le_bytes(ix.data[1..9].try_into().unwrap());
            let amount_out = u64::from_le_bytes(ix.data[9..17].try_into().unwrap());
            let take = if mode == 1 { amount_in + 1 } else { amount_in };
            token_transfer(acct(1)?, acct(3)?, &ix.accounts[0].pubkey, take)?;
            let reserve = acct(4)?;
            let owner = Pubkey::new_from_array(reserve.data.borrow()[32..64].try_into().unwrap());
            return token_transfer(reserve, acct(2)?, &owner, amount_out);
        }
        Err(ProgramError::IncorrectProgramId)
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Test world
// ---------------------------------------------------------------------------------------------------------------------

struct Acc {
    owner: Pubkey,
    lamports: u64,
    data: Vec<u8>,
    executable: bool,
}

struct World {
    accounts: HashMap<Pubkey, Acc>,
    owner: Pubkey,
    pilot: Pubkey,
    feed_authority: Pubkey,
    vault: Pubkey,
    authority: Pubkey,
    tokens: Vec<Pubkey>,
    feeds: Vec<Pubkey>,
    mints: Vec<Pubkey>,
    reserves: Vec<Pubkey>,
    decimals: Vec<u8>,
    _guard: std::sync::MutexGuard<'static, ()>,
}

fn key(n: u8) -> Pubkey {
    Pubkey::new_from_array([n; 32])
}

fn token_data(mint: &Pubkey, owner: &Pubkey, amount: u64) -> Vec<u8> {
    let mut d = vec![0u8; 165];
    d[0..32].copy_from_slice(mint.as_ref());
    d[32..64].copy_from_slice(owner.as_ref());
    d[64..72].copy_from_slice(&amount.to_le_bytes());
    d
}

/// Signer (s) and writable (w) flags for an account in an instruction.
#[derive(Clone, Copy)]
struct Meta(Pubkey, bool, bool);

fn s(k: Pubkey) -> Meta {
    Meta(k, true, false)
}
fn w(k: Pubkey) -> Meta {
    Meta(k, false, true)
}
fn r(k: Pubkey) -> Meta {
    Meta(k, false, false)
}

const LIMITS: LimitsConfig = LimitsConfig { max_trade_usd: 5_000 * WAD, daily_limit_usd: 20_000 * WAD, max_slippage_bps: 100, max_price_age: 3_600, cooldown: 60 };

impl World {
    /// Four assets worth $2,500 each, like the EVM fixture: USDG (6 decimals) and three stocks (9 decimals).
    fn new() -> World {
        let guard = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        INSTALL.call_once(|| {
            set_syscall_stubs(Box::new(Runtime));
        });
        NOW.store(1_000_000, Ordering::SeqCst);
        let vault = key(10);
        let (authority, _) = vault_authority(&vault, &ID);
        let mut world = World {
            accounts: HashMap::new(),
            owner: key(1),
            pilot: key(2),
            feed_authority: key(3),
            vault,
            authority,
            tokens: vec![],
            feeds: vec![],
            mints: vec![],
            reserves: vec![],
            decimals: vec![6, 9, 9, 9],
            _guard: guard,
        };
        let system = Pubkey::default();
        for k in [world.owner, world.pilot, world.feed_authority, key(4)] {
            world.accounts.insert(k, Acc { owner: system, lamports: 1_000_000_000, data: vec![], executable: false });
        }
        world.accounts.insert(VENUE, Acc { owner: system, lamports: 1, data: vec![], executable: true });
        world.accounts.insert(TOKEN_PROGRAM_ID, Acc { owner: system, lamports: 1, data: vec![], executable: true });
        world.accounts.insert(vault, Acc { owner: ID, lamports: 1, data: vec![0; VAULT_SPACE], executable: false });
        world.accounts.insert(authority, Acc { owner: system, lamports: 0, data: vec![], executable: false });

        let prices = [1_00000000u64, 250_00000000, 200_00000000, 125_00000000];
        let balances = [2_500_000_000u64, 10_000_000_000, 12_500_000_000, 20_000_000_000];
        for i in 0..4u8 {
            let (mint, token, feed, reserve) = (key(20 + i), key(30 + i), key(40 + i), key(50 + i));
            world.accounts.insert(token, Acc { owner: TOKEN_PROGRAM_ID, lamports: 1, data: token_data(&mint, &authority, balances[i as usize]), executable: false });
            world.accounts.insert(reserve, Acc { owner: TOKEN_PROGRAM_ID, lamports: 1, data: token_data(&mint, &VENUE, u64::MAX / 4), executable: false });
            world.accounts.insert(feed, Acc { owner: ID, lamports: 1, data: vec![0; FEED_SPACE], executable: false });
            world.mints.push(mint);
            world.tokens.push(token);
            world.feeds.push(feed);
            world.reserves.push(reserve);
            let fa = world.feed_authority;
            world.call(StockPilotInstruction::InitPriceFeed { price: prices[i as usize] }, &[w(feed), s(fa)]).unwrap();
        }
        let assets = world.mandate(2_500, 500);
        let mut metas = vec![w(vault), s(world.owner)];
        metas.extend(world.tokens.iter().map(|t| r(*t)));
        world.call(StockPilotInstruction::InitVault { pilot: world.pilot.to_bytes(), venue: VENUE.to_bytes(), assets, limits: LIMITS }, &metas).unwrap();
        world
    }

    fn mandate(&self, target: u16, band: u16) -> Vec<AssetConfig> {
        (0..4)
            .map(|i| AssetConfig {
                mint: self.mints[i].to_bytes(),
                vault_token: self.tokens[i].to_bytes(),
                price_feed: self.feeds[i].to_bytes(),
                pyth_feed_id: [0; 32],
                target_bps: target,
                band_bps: band,
                decimals: self.decimals[i],
            })
            .collect()
    }

    /// Run one instruction against the program, with these accounts in this order.
    fn call(&mut self, ix: StockPilotInstruction, metas: &[Meta]) -> ProgramResult {
        let data = borsh::to_vec(&ix).unwrap();
        let keys: Vec<Pubkey> = metas.iter().map(|m| m.0).collect();
        let mut refs: HashMap<Pubkey, &mut Acc> = self.accounts.iter_mut().filter(|(k, _)| keys.contains(k)).map(|(k, a)| (*k, a)).collect();
        let mut owned: Vec<(Pubkey, &mut Acc, bool, bool)> = Vec::new();
        for m in metas {
            let acc = refs.remove(&m.0).expect("account listed twice or missing");
            owned.push((m.0, acc, m.1, m.2));
        }
        let infos: Vec<AccountInfo> = owned
            .iter_mut()
            .map(|(k, a, signer, writable)| AccountInfo::new(k, *signer, *writable, &mut a.lamports, &mut a.data, &a.owner, a.executable))
            .collect();
        process_instruction(&ID, &infos, &data)
    }

    fn balance(&self, k: &Pubkey) -> u64 {
        u64::from_le_bytes(self.accounts[k].data[64..72].try_into().unwrap())
    }

    fn vault_state(&self) -> Vault {
        borsh::BorshDeserialize::deserialize(&mut &self.accounts[&self.vault].data[..]).unwrap()
    }

    fn set_price(&mut self, i: usize, price: u64) -> ProgramResult {
        let (feed, fa) = (self.feeds[i], self.feed_authority);
        self.call(StockPilotInstruction::SetPrice { price }, &[w(feed), s(fa)])
    }

    fn refresh_prices(&mut self) {
        for i in 0..4 {
            let feed: PriceFeed = borsh::BorshDeserialize::deserialize(&mut &self.accounts[&self.feeds[i]].data[..]).unwrap();
            self.set_price(i, feed.price).unwrap();
        }
    }

    /// The venue's quote at feed prices minus `fee_bps`.
    fn fair_out(&self, sell: usize, buy: usize, amount_in: u64, fee_bps: u64) -> u64 {
        let price = |i: usize| -> u128 {
            let f: PriceFeed = borsh::BorshDeserialize::deserialize(&mut &self.accounts[&self.feeds[i]].data[..]).unwrap();
            f.price as u128
        };
        let value = amount_in as u128 * price(sell) * 10u128.pow(self.decimals[buy] as u32) / 10u128.pow(self.decimals[sell] as u32);
        (value / price(buy) * (10_000 - fee_bps as u128) / 10_000) as u64
    }

    fn trade_as(&mut self, signer: Pubkey, sell: usize, buy: usize, amount_in: u64, amount_out: u64, mode: u8, venue: Pubkey, feeds: Option<Vec<Pubkey>>) -> ProgramResult {
        let mut venue_data = vec![mode];
        venue_data.extend_from_slice(&amount_in.to_le_bytes());
        venue_data.extend_from_slice(&amount_out.to_le_bytes());
        let mut metas = vec![w(self.vault), s(signer), r(self.authority), r(venue)];
        metas.extend(self.tokens.iter().map(|t| w(*t)));
        metas.extend(feeds.unwrap_or_else(|| self.feeds.clone()).iter().map(|f| r(*f)));
        metas.push(w(self.reserves[sell]));
        metas.push(w(self.reserves[buy]));
        self.call(StockPilotInstruction::Rebalance { sell: sell as u8, buy: buy as u8, amount_in, min_amount_out: 0, rationale: [9; 32], venue_data }, &metas)
    }

    fn trade(&mut self, sell: usize, buy: usize, amount_in: u64, fee_bps: u64) -> ProgramResult {
        let out = self.fair_out(sell, buy, amount_in, fee_bps);
        self.trade_as(self.pilot, sell, buy, amount_in, out, 0, VENUE, None)
    }

    fn withdraw_as(&mut self, signer: Pubkey, source: Pubkey, amount: u64) -> ProgramResult {
        let dest = key(60);
        self.accounts.entry(dest).or_insert(Acc { owner: TOKEN_PROGRAM_ID, lamports: 1, data: token_data(&self.mints[1], &self.owner, 0), executable: false });
        let metas = [r(self.vault), s(signer), r(self.authority), w(source), w(dest), r(TOKEN_PROGRAM_ID)];
        self.call(StockPilotInstruction::Withdraw { amount }, &metas)
    }
}

fn code(e: ProgramResult) -> u32 {
    match e {
        Err(ProgramError::Custom(c)) => c,
        other => panic!("expected a custom error, got {other:?}"),
    }
}

// Mandate reasons share the EVM contract's names; their codes are the order of `Reason`.
const ENFORCED_PAUSE: u32 = 0;
const COOLDOWN: u32 = 3;
const STALE: u32 = 4;
const TOO_LARGE: u32 = 6;
const SLIPPAGE: u32 = 10;
const OUTSIDE_BAND: u32 = 11;
const NOT_OWNER: u32 = 100;
const NOT_PILOT: u32 = 101;
const WRONG_ACCOUNT: u32 = 103;
const VENUE_MISMATCH: u32 = 104;
const VENUE_SPENT_WRONG: u32 = 105;
const ALREADY_INIT: u32 = 106;
const INVALID_MANDATE: u32 = 107;
const NOT_FEED_AUTHORITY: u32 = 108;

// ---------------------------------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------------------------------

#[test]
fn creates_a_vault_with_its_mandate() {
    let w = World::new();
    let v = w.vault_state();
    assert_eq!(v.owner, w.owner.to_bytes());
    assert_eq!(v.pilot, w.pilot.to_bytes());
    assert_eq!(v.assets.len(), 4);
    assert_eq!(v.budget_usd, 20_000 * WAD);
    assert_eq!(v.mandate_version, 1);
}

#[test]
fn rejects_a_second_init_and_malformed_mandates() {
    let mut w = World::new();
    let (vault, owner) = (w.vault, w.owner);
    let mut metas = vec![self::w(vault), s(owner)];
    metas.extend(w.tokens.iter().map(|t| r(*t)));
    let assets = w.mandate(2_500, 500);
    assert_eq!(code(w.call(StockPilotInstruction::InitVault { pilot: [0; 32], venue: [0; 32], assets: assets.clone(), limits: LIMITS }, &metas)), ALREADY_INIT);
    // Targets that do not add up to 100%.
    assert_eq!(code(w.call(StockPilotInstruction::SetMandate { assets: w.mandate(2_000, 500), limits: LIMITS }, &metas)), INVALID_MANDATE);
    // A token account the vault authority does not own.
    let foreign = key(61);
    w.accounts.insert(foreign, Acc { owner: TOKEN_PROGRAM_ID, lamports: 1, data: token_data(&w.mints[0], &owner, 5), executable: false });
    let mut bad = assets.clone();
    bad[0].vault_token = foreign.to_bytes();
    let mut metas2 = vec![self::w(vault), s(owner), r(foreign)];
    metas2.extend(w.tokens[1..].iter().map(|t| r(*t)));
    assert_eq!(code(w.call(StockPilotInstruction::SetMandate { assets: bad, limits: LIMITS }, &metas2)), WRONG_ACCOUNT);
}

#[test]
fn the_pilot_rebalances_after_a_rally_and_the_budget_is_spent() {
    let mut w = World::new();
    w.set_price(3, 200_00000000).unwrap(); // NVDA +60%
    let nvda_before = w.balance(&w.tokens[3]);
    let usdg_before = w.balance(&w.tokens[0]);
    // Sell 4 NVDA ($800) for USDG at a 0.1% venue fee.
    w.trade(3, 0, 4_000_000_000, 10).unwrap();
    assert_eq!(w.balance(&w.tokens[3]), nvda_before - 4_000_000_000);
    assert_eq!(w.balance(&w.tokens[0]), usdg_before + 799_200_000);
    let v = w.vault_state();
    assert_eq!(v.last_trade_at, NOW.load(Ordering::SeqCst));
    assert_eq!(v.budget_usd, 20_000 * WAD - 800 * WAD);
}

#[test]
fn refuses_to_concentrate_the_portfolio() {
    let mut w = World::new();
    // $1,000 of AAPL into TSLA: AAPL 15%, TSLA 35%, both outside 25% +/- 5%.
    assert_eq!(code(w.trade(2, 1, 5_000_000_000, 10)), OUTSIDE_BAND);
}

#[test]
fn judges_fills_against_the_oracle() {
    let mut w = World::new();
    assert_eq!(code(w.trade(2, 3, 1_000_000_000, 200)), SLIPPAGE); // venue pays 2% under the oracle; cap is 1%
}

#[test]
fn a_venue_that_takes_more_than_agreed_is_rejected() {
    let mut w = World::new();
    let out = w.fair_out(2, 3, 1_000_000_000, 10);
    let pilot = w.pilot;
    assert_eq!(code(w.trade_as(pilot, 2, 3, 1_000_000_000, out, 1, VENUE, None)), VENUE_SPENT_WRONG);
}

#[test]
fn only_the_pilot_trades_and_only_through_the_owners_venue() {
    let mut w = World::new();
    let out = w.fair_out(2, 3, 1_000_000_000, 10);
    let (owner, pilot) = (w.owner, w.pilot);
    assert_eq!(code(w.trade_as(owner, 2, 3, 1_000_000_000, out, 0, VENUE, None)), NOT_PILOT);
    let rogue = key(4);
    w.accounts.get_mut(&rogue).unwrap().executable = true;
    assert_eq!(code(w.trade_as(pilot, 2, 3, 1_000_000_000, out, 0, rogue, None)), VENUE_MISMATCH);
}

#[test]
fn a_pilot_cannot_bring_its_own_price_feed() {
    let mut w = World::new();
    // The pilot makes a feed that says AAPL is worth $10,000, and passes it in place of the real one.
    let fake = key(70);
    w.accounts.insert(fake, Acc { owner: ID, lamports: 1, data: vec![0; FEED_SPACE], executable: false });
    let pilot = w.pilot;
    w.call(StockPilotInstruction::InitPriceFeed { price: 10_000_00000000 }, &[self::w(fake), s(pilot)]).unwrap();
    let mut feeds = w.feeds.clone();
    feeds[2] = fake;
    let out = w.fair_out(2, 3, 1_000_000_000, 10);
    assert_eq!(code(w.trade_as(pilot, 2, 3, 1_000_000_000, out, 0, VENUE, Some(feeds))), WRONG_ACCOUNT);
}

#[test]
fn only_a_feeds_authority_moves_its_price() {
    let mut w = World::new();
    let (feed, pilot) = (w.feeds[3], w.pilot);
    assert_eq!(code(w.call(StockPilotInstruction::SetPrice { price: 1 }, &[self::w(feed), s(pilot)])), NOT_FEED_AUTHORITY);
}

#[test]
fn refuses_stale_prices_before_any_swap() {
    let mut w = World::new();
    NOW.fetch_add(3_601, Ordering::SeqCst);
    let before = w.balance(&w.tokens[2]);
    assert_eq!(code(w.trade(2, 3, 1_000_000_000, 10)), STALE);
    assert_eq!(w.balance(&w.tokens[2]), before, "nothing was swapped");
}

#[test]
fn enforces_cooldown_and_trade_size() {
    let mut w = World::new();
    w.trade(2, 3, 1_000_000_000, 10).unwrap();
    assert_eq!(code(w.trade(2, 3, 1_000_000_000, 10)), COOLDOWN);
    NOW.fetch_add(60, Ordering::SeqCst);
    w.refresh_prices();
    w.trade(3, 2, 1_000_000_000, 10).unwrap();
    NOW.fetch_add(60, Ordering::SeqCst);
    w.refresh_prices();
    // $6,000 of USDG: over the $5,000 per-trade cap.
    let mut wide = w.mandate(2_500, 5_000);
    wide.iter_mut().for_each(|a| a.band_bps = 5_000);
    assert_eq!(code(w.trade(0, 1, 6_000_000_000, 10)), TOO_LARGE);
}

#[test]
fn pause_stops_the_pilot_and_only_the_owner_resumes() {
    let mut w = World::new();
    let (vault, owner, pilot) = (w.vault, w.owner, w.pilot);
    w.call(StockPilotInstruction::Pause, &[self::w(vault), s(pilot)]).unwrap();
    assert_eq!(code(w.trade(2, 3, 1_000_000_000, 10)), ENFORCED_PAUSE);
    assert_eq!(code(w.call(StockPilotInstruction::Unpause, &[self::w(vault), s(pilot)])), NOT_OWNER);
    w.call(StockPilotInstruction::Unpause, &[self::w(vault), s(owner)]).unwrap();
    w.trade(2, 3, 1_000_000_000, 10).unwrap();
}

#[test]
fn the_owner_withdraws_through_the_vault_authority_even_when_paused() {
    let mut w = World::new();
    let (vault, owner, pilot, tsla) = (w.vault, w.owner, w.pilot, w.tokens[1]);
    w.call(StockPilotInstruction::Pause, &[self::w(vault), s(owner)]).unwrap();
    w.withdraw_as(owner, tsla, 3_000_000_000).unwrap();
    assert_eq!(w.balance(&tsla), 7_000_000_000);
    assert_eq!(w.balance(&key(60)), 3_000_000_000);
    assert_eq!(code(w.withdraw_as(pilot, tsla, 1)), NOT_OWNER);
}

#[test]
fn the_runtime_rejects_a_transfer_the_vault_authority_did_not_sign() {
    // Belt and braces for the harness itself: the simulated runtime refuses a token transfer whose authority neither
    // signed nor was proven by seeds, so the withdraw test above really exercises PDA signing.
    let w = World::new();
    let mut src = Acc { owner: TOKEN_PROGRAM_ID, lamports: 1, data: token_data(&w.mints[0], &w.authority, 10), executable: false };
    let mut dst = Acc { owner: TOKEN_PROGRAM_ID, lamports: 1, data: token_data(&w.mints[0], &w.owner, 0), executable: false };
    let mut auth = Acc { owner: Pubkey::default(), lamports: 0, data: vec![], executable: false };
    let (ks, kd, ka) = (key(80), key(81), w.authority);
    let infos = [
        AccountInfo::new(&ks, false, true, &mut src.lamports, &mut src.data, &src.owner, false),
        AccountInfo::new(&kd, false, true, &mut dst.lamports, &mut dst.data, &dst.owner, false),
        AccountInfo::new(&ka, false, false, &mut auth.lamports, &mut auth.data, &auth.owner, false),
    ];
    let mut data = vec![3u8];
    data.extend_from_slice(&5u64.to_le_bytes());
    let ix = Instruction {
        program_id: TOKEN_PROGRAM_ID,
        accounts: vec![
            solana_program::instruction::AccountMeta::new(ks, false),
            solana_program::instruction::AccountMeta::new(kd, false),
            solana_program::instruction::AccountMeta::new_readonly(ka, true),
        ],
        data,
    };
    assert_eq!(solana_program::program::invoke_signed(&ix, &infos, &[&[b"authority", b"wrong-vault-seed", &[255]]]), Err(ProgramError::MissingRequiredSignature));
}

#[test]
fn re_mandating_keeps_the_spent_budget() {
    let mut w = World::new();
    w.trade(3, 2, 4_000_000_000, 10).unwrap(); // $500
    let (vault, owner) = (w.vault, w.owner);
    let mut metas = vec![self::w(vault), s(owner)];
    metas.extend(w.tokens.iter().map(|t| r(*t)));
    let assets = w.mandate(2_500, 1_000);
    w.call(StockPilotInstruction::SetMandate { assets, limits: LIMITS }, &metas).unwrap();
    let v = w.vault_state();
    assert_eq!(v.mandate_version, 2);
    assert!(v.budget_usd < 20_000 * WAD - 400 * WAD, "budget was reset by re-mandating");
}

// ---------------------------------------------------------------------------------------------------------------------
// Pyth price accounts
// ---------------------------------------------------------------------------------------------------------------------

use stockpilot_solana::{PRICE_UPDATE_V2_DISCRIMINATOR, PYTH_RECEIVER_ID};

const TSLA_FEED_ID: [u8; 32] = [0x16; 32];
const PRICE_UNVERIFIED: u32 = 109;
const PRICE_UNCERTAIN: u32 = 110;

/// A `PriceUpdateV2` account as Pyth's receiver program writes it.
fn pyth_data(feed_id: [u8; 32], price: i64, conf: u64, exponent: i32, publish_time: i64, full: bool) -> Vec<u8> {
    let mut d = PRICE_UPDATE_V2_DISCRIMINATOR.to_vec();
    d.extend_from_slice(&[9u8; 32]); // write authority
    if full {
        d.push(1);
    } else {
        d.extend_from_slice(&[0, 3]); // Partial { num_signatures: 3 }
    }
    d.extend_from_slice(&feed_id);
    d.extend_from_slice(&price.to_le_bytes());
    d.extend_from_slice(&conf.to_le_bytes());
    d.extend_from_slice(&exponent.to_le_bytes());
    d.extend_from_slice(&publish_time.to_le_bytes());
    d.extend_from_slice(&publish_time.to_le_bytes()); // prev publish time
    d.extend_from_slice(&price.to_le_bytes()); // ema price
    d.extend_from_slice(&conf.to_le_bytes()); // ema conf
    d.extend_from_slice(&0u64.to_le_bytes()); // posted slot
    d
}

impl World {
    /// Re-mandate TSLA (asset 1) to be priced by a Pyth account carrying `TSLA_FEED_ID`.
    fn use_pyth_for_tsla(&mut self, data: Vec<u8>) {
        let account = key(90);
        self.accounts.insert(account, Acc { owner: PYTH_RECEIVER_ID, lamports: 1, data, executable: false });
        self.feeds[1] = account;
        let mut assets = self.mandate(2_500, 500);
        assets[1].pyth_feed_id = TSLA_FEED_ID;
        let (vault, owner) = (self.vault, self.owner);
        let mut metas = vec![w(vault), s(owner)];
        metas.extend(self.tokens.iter().map(|t| r(*t)));
        self.call(StockPilotInstruction::SetMandate { assets, limits: LIMITS }, &metas).unwrap();
    }

    fn set_pyth(&mut self, data: Vec<u8>) {
        self.accounts.get_mut(&key(90)).unwrap().data = data;
    }
}

#[test]
fn prices_an_asset_with_a_pyth_account() {
    let mut w = World::new();
    let now = NOW.load(Ordering::SeqCst);
    // TSLA rallied to $350 per Pyth (price 35_000_000 with exponent -5), confidence 0.1%.
    w.use_pyth_for_tsla(pyth_data(TSLA_FEED_ID, 35_000_000, 35_000, -5, now - 2, true));
    // TSLA is now 3,500 / 11,000 = 31.8%: trimming $700 back to USDG is allowed.
    let out = 699_300_000; // $700 less the 0.1% venue fee, in 6-decimal USDG
    let pilot = w.pilot;
    w.trade_as(pilot, 1, 0, 2_000_000_000, out, 0, VENUE, None).unwrap();
    assert_eq!(w.balance(&w.tokens[1]), 8_000_000_000);
}

#[test]
fn refuses_pyth_prices_that_are_unverified_for_another_feed_uncertain_or_stale() {
    let mut w = World::new();
    let now = NOW.load(Ordering::SeqCst);
    let pilot = w.pilot;
    w.use_pyth_for_tsla(pyth_data(TSLA_FEED_ID, 25_000_000, 25_000, -5, now, false));
    let attempt = |w: &mut World| w.trade_as(pilot, 1, 0, 1_000_000_000, 249_000_000, 0, VENUE, None);
    assert_eq!(code(attempt(&mut w)), PRICE_UNVERIFIED);

    w.set_pyth(pyth_data([0x99; 32], 25_000_000, 25_000, -5, now, true)); // a different feed's price
    assert_eq!(code(attempt(&mut w)), WRONG_ACCOUNT);

    w.set_pyth(pyth_data(TSLA_FEED_ID, 25_000_000, 500_000, -5, now, true)); // +/- 2%
    assert_eq!(code(attempt(&mut w)), PRICE_UNCERTAIN);

    w.set_pyth(pyth_data(TSLA_FEED_ID, 25_000_000, 25_000, -5, now - 3_601, true)); // market closed an hour ago
    assert_eq!(code(attempt(&mut w)), STALE);
}

#[test]
fn reads_pyth_exponents_exactly() {
    let key = key(91);
    let (mut lamports, owner) = (1u64, PYTH_RECEIVER_ID);
    let mut data = pyth_data(TSLA_FEED_ID, 2_501_234_567_890, 1_000_000_000, -10, 5, true);
    let info = AccountInfo::new(&key, false, false, &mut lamports, &mut data, &owner, false);
    let p = stockpilot_solana::read_pyth(&info).unwrap();
    assert_eq!(p.price_wad, 250_123_456_789_000_000_000); // $250.123456789
    assert_eq!(p.publish_time, 5);
    assert_eq!(p.feed_id, TSLA_FEED_ID);
}
