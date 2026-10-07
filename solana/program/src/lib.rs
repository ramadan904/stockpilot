//! StockPilot on Solana (proof of concept).
//!
//! The same product as the EVM `PilotVault`: an owner's portfolio of tokenized stocks that an AI pilot may rebalance,
//! but only inside an onchain mandate. The rules themselves are `stockpilot-mandate-core`, the crate proven to reach the
//! same verdicts as the EVM contract.
//!
//! Accounts:
//! - `Vault`: owner, pilot, the venue program trades go through, the mandate, and the trade budget and cooldown state.
//!   A program-owned account the owner creates.
//! - Vault authority: the PDA `["authority", vault]`. It owns the vault's SPL token accounts and signs every transfer
//!   out of them; only this program can sign for it.
//! - `PriceFeed`: a USD price with 8 decimals and an update time, set by its authority. (On mainnet this would read Pyth
//!   price accounts; the feed account keeps the proof of concept self-contained.)
//!
//! A trade: the pilot calls `Rebalance`; the program checks the pilot, the venue and every account against the
//! mandate, reads balances, lets the venue program swap with the authority's signature, reads balances again, requires
//! the venue took exactly `amount_in`, and only then runs the mandate check on what actually arrived. Any failure
//! reverts the whole transaction, swap included.

use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint::ProgramResult,
    instruction::{AccountMeta, Instruction},
    msg,
    program::invoke_signed,
    program_error::ProgramError,
    pubkey::Pubkey,
};
use stockpilot_mandate_core as core;

solana_program::declare_id!("GhRBWshwP8cGjuqCT1quHW23dWEGrTUQqPMpVXcqyTAX");

/// The SPL Token program.
pub const TOKEN_PROGRAM_ID: Pubkey = solana_program::pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

pub const MAX_ASSETS: usize = 8;
pub const VAULT_TAG: [u8; 8] = *b"SPVAULT1";
pub const FEED_TAG: [u8; 8] = *b"SPPRICE1";
/// Enough for a vault with the maximum number of assets.
pub const VAULT_SPACE: usize = 8 + 32 * 3 + 1 + 4 + 4 + MAX_ASSETS * (32 * 4 + 2 + 2 + 1) + (16 + 16 + 2 + 4 + 4) + 8 + 16 + 8 + INHERITANCE_SPACE + GUARD_SPACE + RECURRING_SPACE + 64;
const INHERITANCE_SPACE: usize = 32 + 4 + 8;
const GUARD_SPACE: usize = 32 + 2 + 2 + 1 + 16;
const RECURRING_SPACE: usize = 32 + 32 + 8 + 4 + 8;
/// Inheritance periods, as on the EVM vault: 30 days to 10 years.
pub const MIN_INACTIVITY: u32 = 30 * 86_400;
pub const MAX_INACTIVITY: u32 = 3_650 * 86_400;
/// Crash guard trigger, as on the EVM vault: a 5% to 50% fall from the peak.
pub const MIN_DRAWDOWN_BPS: u16 = 500;
pub const MAX_DRAWDOWN_BPS: u16 = 5_000;
/// Recurring investment interval, as on the EVM vault: daily to yearly.
pub const MIN_RECURRING_INTERVAL: u32 = 86_400;
pub const MAX_RECURRING_INTERVAL: u32 = 365 * 86_400;
pub const FEED_SPACE: usize = 8 + 32 + 8 + 8;
const PRICE_TO_WAD: u128 = 10_000_000_000; // 8-decimal feed price to 18 decimals

/// Pyth's Solana receiver program, which owns the `PriceUpdateV2` accounts it verifies and posts.
pub const PYTH_RECEIVER_ID: Pubkey = solana_program::pubkey!("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");
/// Anchor discriminator of `PriceUpdateV2`: the first 8 bytes of sha256("account:PriceUpdateV2").
pub const PRICE_UPDATE_V2_DISCRIMINATOR: [u8; 8] = [34, 241, 35, 99, 157, 126, 244, 205];
/// Refuse a Pyth price whose confidence interval is wider than this share of the price (1%).
pub const MAX_CONF_BPS: u128 = 100;

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct AssetConfig {
    pub mint: [u8; 32],
    /// The vault's token account for this mint, owned by the vault authority PDA.
    pub vault_token: [u8; 32],
    /// Either a Pyth `PriceUpdateV2` account (owned by the Pyth receiver program) or a demo `PriceFeed` account.
    pub price_feed: [u8; 32],
    /// The Pyth feed id the price account must carry (e.g. Equity.US.TSLA/USD); zero for a demo feed.
    pub pyth_feed_id: [u8; 32],
    pub target_bps: u16,
    pub band_bps: u16,
    pub decimals: u8,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct LimitsConfig {
    pub max_trade_usd: u128,
    pub daily_limit_usd: u128,
    pub max_slippage_bps: u16,
    pub max_price_age: u32,
    pub cooldown: u32,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct Vault {
    pub tag: [u8; 8],
    pub owner: [u8; 32],
    pub pilot: [u8; 32],
    pub venue: [u8; 32],
    pub paused: bool,
    pub mandate_version: u32,
    pub assets: Vec<AssetConfig>,
    pub limits: LimitsConfig,
    pub last_trade_at: i64,
    pub budget_usd: u128,
    pub budget_updated_at: i64,
    /// Inheritance: who may take ownership after `inactivity_period` seconds without any owner action.
    pub heir: [u8; 32],
    pub inactivity_period: u32,
    pub last_owner_activity: i64,
    /// Crash guard: past a `drawdown_bps` fall from `peak_usd`, the asset with `safe_mint` goes to `safe_target_bps`
    /// and the rest shrink in proportion. `drawdown_bps == 0` means off.
    pub safe_mint: [u8; 32],
    pub safe_target_bps: u16,
    pub drawdown_bps: u16,
    pub defensive: bool,
    pub peak_usd: u128,
    /// Recurring investment: `recurring_amount` of `recurring_mint` from the owner's token account `recurring_source`
    /// (which the owner approves the vault authority PDA as delegate of), at most once per `recurring_interval`, next
    /// due at `recurring_next_at`. Zero amount means off.
    pub recurring_mint: [u8; 32],
    pub recurring_source: [u8; 32],
    pub recurring_amount: u64,
    pub recurring_interval: u32,
    pub recurring_next_at: i64,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct PriceFeed {
    pub tag: [u8; 8],
    pub authority: [u8; 32],
    /// USD, 8 decimals.
    pub price: u64,
    pub updated_at: i64,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub enum StockPilotInstruction {
    /// Accounts: [feed (w, program-owned, empty), authority (signer)]
    InitPriceFeed { price: u64 },
    /// Accounts: [feed (w), authority (signer)]
    SetPrice { price: u64 },
    /// Accounts: [vault (w, program-owned, empty), owner (signer), ...each asset's vault token account]
    InitVault { pilot: [u8; 32], venue: [u8; 32], assets: Vec<AssetConfig>, limits: LimitsConfig },
    /// Accounts: [vault (w), owner (signer), ...each asset's vault token account]
    SetMandate { assets: Vec<AssetConfig>, limits: LimitsConfig },
    /// Accounts: [vault (w), owner (signer)]
    SetPilot { pilot: [u8; 32] },
    /// Accounts: [vault (w), owner (signer)]
    SetVenue { venue: [u8; 32] },
    /// Accounts: [vault (w), owner or pilot (signer)]
    Pause,
    /// Accounts: [vault (w), owner (signer)]
    Unpause,
    /// Accounts: [vault (w), pilot (signer), vault authority, venue program, ...n vault token accounts (w) in mandate
    /// order, ...n price feeds in mandate order, ...extra accounts the venue needs]
    Rebalance { sell: u8, buy: u8, amount_in: u64, min_amount_out: u64, rationale: [u8; 32], venue_data: Vec<u8> },
    /// Accounts: [vault (w), owner (signer), vault authority, source (w, owned by the authority), destination (w), token program]
    Withdraw { amount: u64 },
    /// Accounts: [vault (w), owner (signer)]. A zero heir clears it.
    SetHeir { heir: [u8; 32], period: u32 },
    /// Accounts: [vault (w), owner (signer)]. Proof of life: restarts the inheritance clock.
    CheckIn,
    /// Accounts: [vault (w), heir (signer)]
    ClaimInheritance,
    /// Accounts: [vault (w), owner (signer)]. `drawdown_bps == 0` turns it off.
    SetCrashGuard { safe_mint: [u8; 32], safe_target_bps: u16, drawdown_bps: u16 },
    /// Accounts: [vault (w), ...n vault token accounts in mandate order, ...n price feeds in mandate order]. Anyone.
    Poke,
    /// Accounts: [vault (w), owner (signer)]
    ExitDefensive,
    /// Accounts: [vault (w), owner (signer), source (the owner's token account of `mint`)]. `amount == 0` turns it off.
    /// The owner then approves the vault authority PDA as the source's delegate (SPL Token `Approve`), which caps
    /// what can ever be pulled. The first pull is due now.
    SetRecurringDeposit { mint: [u8; 32], amount: u64, interval: u32 },
    /// Accounts: [vault (w), vault authority, source (w), the mint's vault token account (w), token program]. Anyone,
    /// when due; missed periods are not caught up.
    PullRecurringDeposit,
}

/// Program errors. Codes 0 to 11 are the mandate reasons, in the same names the EVM contract uses.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StockPilotError {
    Mandate(core::Reason),
    NotOwner,
    NotPilot,
    NotOwnerOrPilot,
    WrongAccount,
    VenueMismatch,
    VenueSpentWrongAmount,
    AlreadyInitialized,
    InvalidMandate,
    NotFeedAuthority,
    PriceUnverified,
    PriceUncertain,
    NotHeir,
    OwnerStillActive,
    InvalidHeir,
    InactivityOutOfRange,
    DrawdownOutOfRange,
    InvalidSafeTarget,
    CrashGuardOff,
    IntervalOutOfRange,
    RecurringOff,
    RecurringNotDue,
}

impl StockPilotError {
    pub fn code(self) -> u32 {
        match self {
            StockPilotError::Mandate(r) => r as u32,
            StockPilotError::NotOwner => 100,
            StockPilotError::NotPilot => 101,
            StockPilotError::NotOwnerOrPilot => 102,
            StockPilotError::WrongAccount => 103,
            StockPilotError::VenueMismatch => 104,
            StockPilotError::VenueSpentWrongAmount => 105,
            StockPilotError::AlreadyInitialized => 106,
            StockPilotError::InvalidMandate => 107,
            StockPilotError::NotFeedAuthority => 108,
            StockPilotError::PriceUnverified => 109,
            StockPilotError::PriceUncertain => 110,
            StockPilotError::NotHeir => 111,
            StockPilotError::OwnerStillActive => 112,
            StockPilotError::InvalidHeir => 113,
            StockPilotError::InactivityOutOfRange => 114,
            StockPilotError::DrawdownOutOfRange => 115,
            StockPilotError::InvalidSafeTarget => 116,
            StockPilotError::CrashGuardOff => 117,
            StockPilotError::IntervalOutOfRange => 118,
            StockPilotError::RecurringOff => 119,
            StockPilotError::RecurringNotDue => 120,
        }
    }
}

impl From<StockPilotError> for ProgramError {
    fn from(e: StockPilotError) -> Self {
        ProgramError::Custom(e.code())
    }
}

#[cfg(not(feature = "no-entrypoint"))]
solana_program::entrypoint!(process_instruction);

pub fn process_instruction(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let ix = StockPilotInstruction::try_from_slice(data).map_err(|_| ProgramError::InvalidInstructionData)?;
    match ix {
        StockPilotInstruction::InitPriceFeed { price } => init_price_feed(program_id, accounts, price),
        StockPilotInstruction::SetPrice { price } => set_price(program_id, accounts, price),
        StockPilotInstruction::InitVault { pilot, venue, assets, limits } => init_vault(program_id, accounts, pilot, venue, assets, limits),
        StockPilotInstruction::SetMandate { assets, limits } => set_mandate(program_id, accounts, assets, limits),
        StockPilotInstruction::SetPilot { pilot } => owner_update(program_id, accounts, |v| v.pilot = pilot),
        StockPilotInstruction::SetVenue { venue } => owner_update(program_id, accounts, |v| v.venue = venue),
        StockPilotInstruction::Pause => pause(program_id, accounts),
        StockPilotInstruction::Unpause => owner_update(program_id, accounts, |v| v.paused = false),
        StockPilotInstruction::Rebalance { sell, buy, amount_in, min_amount_out, rationale, venue_data } => {
            rebalance(program_id, accounts, sell as usize, buy as usize, amount_in, min_amount_out, rationale, venue_data)
        }
        StockPilotInstruction::Withdraw { amount } => withdraw(program_id, accounts, amount),
        StockPilotInstruction::SetHeir { heir, period } => set_heir(program_id, accounts, heir, period),
        StockPilotInstruction::CheckIn => owner_update(program_id, accounts, |_| {}),
        StockPilotInstruction::ClaimInheritance => claim_inheritance(program_id, accounts),
        StockPilotInstruction::SetCrashGuard { safe_mint, safe_target_bps, drawdown_bps } => set_crash_guard(program_id, accounts, safe_mint, safe_target_bps, drawdown_bps),
        StockPilotInstruction::Poke => poke(program_id, accounts),
        StockPilotInstruction::ExitDefensive => owner_update(program_id, accounts, |v| {
            v.defensive = false;
            v.peak_usd = 0;
        }),
        StockPilotInstruction::SetRecurringDeposit { mint, amount, interval } => set_recurring(program_id, accounts, mint, amount, interval),
        StockPilotInstruction::PullRecurringDeposit => pull_recurring(program_id, accounts),
    }
}

/// Current unix time: the Clock sysvar on-chain. Host builds of the SDK cannot read sysvars at all, so native tests
/// drive time through `test_clock` instead; nothing else differs between the two builds.
fn now() -> Result<i64, ProgramError> {
    #[cfg(target_os = "solana")]
    {
        use solana_program::{clock::Clock, sysvar::Sysvar};
        Ok(Clock::get()?.unix_timestamp)
    }
    #[cfg(not(target_os = "solana"))]
    {
        Ok(test_clock::NOW.load(std::sync::atomic::Ordering::SeqCst))
    }
}

/// The clock native tests set. Not compiled into the on-chain program.
#[cfg(not(target_os = "solana"))]
pub mod test_clock {
    pub static NOW: std::sync::atomic::AtomicI64 = std::sync::atomic::AtomicI64::new(0);
}

/// The PDA that owns the vault's token accounts.
pub fn vault_authority(vault: &Pubkey, program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"authority", vault.as_ref()], program_id)
}

// ---------------------------------------------------------------------------------------------------------------------
// Account helpers
// ---------------------------------------------------------------------------------------------------------------------

fn load_vault(program_id: &Pubkey, info: &AccountInfo) -> Result<Vault, ProgramError> {
    if info.owner != program_id {
        return Err(StockPilotError::WrongAccount.into());
    }
    let vault = Vault::deserialize(&mut &info.data.borrow()[..]).map_err(|_| ProgramError::InvalidAccountData)?;
    if vault.tag != VAULT_TAG {
        return Err(ProgramError::UninitializedAccount);
    }
    Ok(vault)
}

fn save<T: BorshSerialize>(info: &AccountInfo, value: &T) -> ProgramResult {
    let mut data = info.data.borrow_mut();
    let bytes = borsh::to_vec(value).map_err(|_| ProgramError::InvalidAccountData)?;
    if bytes.len() > data.len() {
        return Err(ProgramError::AccountDataTooSmall);
    }
    data[..bytes.len()].copy_from_slice(&bytes);
    // Zero what a longer earlier state left behind, so no stale bytes ever sit past the end of the account's state.
    data[bytes.len()..].fill(0);
    Ok(())
}

fn is_empty(info: &AccountInfo) -> bool {
    info.data.borrow().iter().all(|b| *b == 0)
}

fn require_signer(info: &AccountInfo, expected: &[u8; 32], err: StockPilotError) -> ProgramResult {
    if !info.is_signer || info.key.to_bytes() != *expected {
        return Err(err.into());
    }
    Ok(())
}

/// (mint, owner, amount) of an SPL token account, checked to belong to the Token program.
fn token_account(info: &AccountInfo) -> Result<([u8; 32], [u8; 32], u64), ProgramError> {
    if *info.owner != TOKEN_PROGRAM_ID {
        return Err(StockPilotError::WrongAccount.into());
    }
    let data = info.data.borrow();
    if data.len() < 72 {
        return Err(ProgramError::InvalidAccountData);
    }
    let mint: [u8; 32] = data[0..32].try_into().unwrap();
    let owner: [u8; 32] = data[32..64].try_into().unwrap();
    let amount = u64::from_le_bytes(data[64..72].try_into().unwrap());
    Ok((mint, owner, amount))
}

fn read_feed(program_id: &Pubkey, info: &AccountInfo) -> Result<PriceFeed, ProgramError> {
    if info.owner != program_id {
        return Err(StockPilotError::WrongAccount.into());
    }
    let feed = PriceFeed::deserialize(&mut &info.data.borrow()[..]).map_err(|_| ProgramError::InvalidAccountData)?;
    if feed.tag != FEED_TAG {
        return Err(ProgramError::UninitializedAccount);
    }
    Ok(feed)
}

/// A USD price with 18 decimals and its publish time, from either kind of price account.
fn read_price(program_id: &Pubkey, info: &AccountInfo, cfg: &AssetConfig) -> Result<(u128, i64), ProgramError> {
    if *info.owner == PYTH_RECEIVER_ID {
        let p = read_pyth(info)?;
        if p.feed_id != cfg.pyth_feed_id {
            return Err(StockPilotError::WrongAccount.into());
        }
        return Ok((p.price_wad, p.publish_time));
    }
    let feed = read_feed(program_id, info)?;
    Ok((feed.price as u128 * PRICE_TO_WAD, feed.updated_at))
}

/// The parts of a Pyth `PriceUpdateV2` account StockPilot uses.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PythPrice {
    pub feed_id: [u8; 32],
    pub price_wad: u128,
    pub publish_time: i64,
}

/// Parses a `PriceUpdateV2` account: discriminator, write authority (32), verification level (Borsh enum: 0 =
/// Partial { num_signatures: u8 }, 1 = Full), then the price message: feed id (32), price i64, conf u64, exponent
/// i32, publish time i64, and fields StockPilot does not need. Only fully verified, positive prices with a confidence
/// interval within `MAX_CONF_BPS` are accepted; freshness is the mandate's `max_price_age`, checked by the rules.
pub fn read_pyth(info: &AccountInfo) -> Result<PythPrice, ProgramError> {
    let data = info.data.borrow();
    if data.len() < 8 + 32 + 1 || data[..8] != PRICE_UPDATE_V2_DISCRIMINATOR {
        return Err(ProgramError::InvalidAccountData);
    }
    let mut at = 8 + 32;
    match data[at] {
        1 => at += 1,
        _ => return Err(StockPilotError::PriceUnverified.into()),
    }
    if data.len() < at + 32 + 8 + 8 + 4 + 8 {
        return Err(ProgramError::InvalidAccountData);
    }
    let feed_id: [u8; 32] = data[at..at + 32].try_into().unwrap();
    at += 32;
    let price = i64::from_le_bytes(data[at..at + 8].try_into().unwrap());
    let conf = u64::from_le_bytes(data[at + 8..at + 16].try_into().unwrap());
    let exponent = i32::from_le_bytes(data[at + 16..at + 20].try_into().unwrap());
    let publish_time = i64::from_le_bytes(data[at + 20..at + 28].try_into().unwrap());
    if price <= 0 {
        return Err(StockPilotError::PriceUncertain.into());
    }
    if conf as u128 * core::BPS > price as u128 * MAX_CONF_BPS {
        return Err(StockPilotError::PriceUncertain.into());
    }
    // price * 10^exponent dollars, as 18 decimals.
    let shift = 18 + exponent;
    if !(0..=18).contains(&shift) {
        return Err(ProgramError::InvalidAccountData);
    }
    Ok(PythPrice { feed_id, price_wad: price as u128 * 10u128.pow(shift as u32), publish_time })
}

fn validate_mandate(program_id: &Pubkey, vault: &Pubkey, assets: &[AssetConfig], limits: &LimitsConfig, token_accounts: &[AccountInfo]) -> ProgramResult {
    let (authority, _) = vault_authority(vault, program_id);
    let sum: u32 = assets.iter().map(|a| a.target_bps as u32).sum();
    if assets.is_empty() || assets.len() > MAX_ASSETS || sum != 10_000 || limits.max_slippage_bps > 1_000 || limits.max_trade_usd == 0 || limits.daily_limit_usd == 0 || limits.max_price_age == 0 {
        return Err(StockPilotError::InvalidMandate.into());
    }
    if token_accounts.len() != assets.len() {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    for (i, a) in assets.iter().enumerate() {
        if a.band_bps > 5_000 || a.decimals > 18 || assets[..i].iter().any(|b| b.mint == a.mint) {
            return Err(StockPilotError::InvalidMandate.into());
        }
        let info = &token_accounts[i];
        let (mint, owner, _) = token_account(info)?;
        if info.key.to_bytes() != a.vault_token || mint != a.mint || owner != authority.to_bytes() {
            return Err(StockPilotError::WrongAccount.into());
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------------------------------
// Instructions
// ---------------------------------------------------------------------------------------------------------------------

fn init_price_feed(program_id: &Pubkey, accounts: &[AccountInfo], price: u64) -> ProgramResult {
    let it = &mut accounts.iter();
    let feed = next_account_info(it)?;
    let authority = next_account_info(it)?;
    if feed.owner != program_id || !authority.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if !is_empty(feed) {
        return Err(StockPilotError::AlreadyInitialized.into());
    }
    save(feed, &PriceFeed { tag: FEED_TAG, authority: authority.key.to_bytes(), price, updated_at: now()? })
}

fn set_price(program_id: &Pubkey, accounts: &[AccountInfo], price: u64) -> ProgramResult {
    let it = &mut accounts.iter();
    let feed_info = next_account_info(it)?;
    let authority = next_account_info(it)?;
    let mut feed = read_feed(program_id, feed_info)?;
    require_signer(authority, &feed.authority, StockPilotError::NotFeedAuthority)?;
    feed.price = price;
    feed.updated_at = now()?;
    save(feed_info, &feed)
}

fn init_vault(program_id: &Pubkey, accounts: &[AccountInfo], pilot: [u8; 32], venue: [u8; 32], assets: Vec<AssetConfig>, limits: LimitsConfig) -> ProgramResult {
    let it = &mut accounts.iter();
    let vault_info = next_account_info(it)?;
    let owner = next_account_info(it)?;
    if vault_info.owner != program_id || !owner.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if !is_empty(vault_info) {
        return Err(StockPilotError::AlreadyInitialized.into());
    }
    validate_mandate(program_id, vault_info.key, &assets, &limits, &accounts[2..])?;
    let now = now()?;
    let vault = Vault {
        tag: VAULT_TAG,
        owner: owner.key.to_bytes(),
        pilot,
        venue,
        paused: false,
        mandate_version: 1,
        assets,
        budget_usd: limits.daily_limit_usd,
        limits,
        last_trade_at: 0,
        budget_updated_at: now,
        heir: [0; 32],
        inactivity_period: 0,
        last_owner_activity: now,
        safe_mint: [0; 32],
        safe_target_bps: 0,
        drawdown_bps: 0,
        defensive: false,
        peak_usd: 0,
        recurring_mint: [0; 32],
        recurring_source: [0; 32],
        recurring_amount: 0,
        recurring_interval: 0,
        recurring_next_at: 0,
    };
    save(vault_info, &vault)
}

fn set_mandate(program_id: &Pubkey, accounts: &[AccountInfo], assets: Vec<AssetConfig>, limits: LimitsConfig) -> ProgramResult {
    let it = &mut accounts.iter();
    let vault_info = next_account_info(it)?;
    let owner = next_account_info(it)?;
    let mut vault = load_vault(program_id, vault_info)?;
    require_signer(owner, &vault.owner, StockPilotError::NotOwner)?;
    validate_mandate(program_id, vault_info.key, &assets, &limits, &accounts[2..])?;
    let now = now()?;
    // The spent budget carries over, capped at the new limit, so re-mandating can't reset it.
    let current = core::available(&core_limits(&vault.limits), &clock_of(&vault, now));
    vault.budget_usd = current.min(limits.daily_limit_usd);
    vault.budget_updated_at = now;
    vault.assets = assets;
    vault.limits = limits;
    vault.mandate_version += 1;
    vault.last_owner_activity = now;
    // The guard needs its safe asset listed, below its defensive target.
    if vault.drawdown_bps != 0 && safe_index(&vault).map(|i| vault.assets[i].target_bps >= vault.safe_target_bps).unwrap_or(true) {
        disarm(&mut vault);
    } else if !vault.defensive {
        // Dropped assets are unpriced, which lowers the measured value without any crash: re-arm.
        vault.peak_usd = 0;
    }
    // A recurring investment into an asset no longer in the mandate stops.
    if vault.recurring_amount != 0 && !vault.assets.iter().any(|a| a.mint == vault.recurring_mint) {
        stop_recurring(&mut vault);
    }
    save(vault_info, &vault)
}

fn safe_index(v: &Vault) -> Option<usize> {
    v.assets.iter().position(|a| a.mint == v.safe_mint)
}

fn disarm(v: &mut Vault) {
    v.safe_mint = [0; 32];
    v.safe_target_bps = 0;
    v.drawdown_bps = 0;
    v.defensive = false;
    v.peak_usd = 0;
}

fn set_heir(program_id: &Pubkey, accounts: &[AccountInfo], heir: [u8; 32], period: u32) -> ProgramResult {
    if heir != [0; 32] && !(MIN_INACTIVITY..=MAX_INACTIVITY).contains(&period) {
        return Err(StockPilotError::InactivityOutOfRange.into());
    }
    let mut invalid = false;
    owner_update(program_id, accounts, |v| {
        if heir == v.owner {
            invalid = true;
            return;
        }
        v.heir = heir;
        v.inactivity_period = if heir == [0; 32] { 0 } else { period };
    })?;
    if invalid {
        return Err(StockPilotError::InvalidHeir.into());
    }
    Ok(())
}

/// The heir takes ownership once the owner has done nothing for the whole period. Pilot, mandate and venue stay.
fn claim_inheritance(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let it = &mut accounts.iter();
    let vault_info = next_account_info(it)?;
    let heir = next_account_info(it)?;
    let mut vault = load_vault(program_id, vault_info)?;
    if vault.heir == [0; 32] || !heir.is_signer || heir.key.to_bytes() != vault.heir {
        return Err(StockPilotError::NotHeir.into());
    }
    let now = now()?;
    if now < vault.last_owner_activity + vault.inactivity_period as i64 {
        return Err(StockPilotError::OwnerStillActive.into());
    }
    msg!("Inheritance claimed: {} succeeds {}", heir.key, Pubkey::new_from_array(vault.owner));
    vault.owner = vault.heir;
    vault.heir = [0; 32];
    vault.inactivity_period = 0;
    vault.last_owner_activity = now;
    // Pulls must never come from a wallet whose owner did not set them up.
    stop_recurring(&mut vault);
    save(vault_info, &vault)
}

fn set_crash_guard(program_id: &Pubkey, accounts: &[AccountInfo], safe_mint: [u8; 32], safe_target_bps: u16, drawdown_bps: u16) -> ProgramResult {
    let mut err = None;
    owner_update(program_id, accounts, |v| {
        if drawdown_bps == 0 {
            disarm(v);
            return;
        }
        let Some(safe) = v.assets.iter().position(|a| a.mint == safe_mint) else {
            err = Some(StockPilotError::Mandate(core::Reason::AssetNotInMandate));
            return;
        };
        if !(MIN_DRAWDOWN_BPS..=MAX_DRAWDOWN_BPS).contains(&drawdown_bps) {
            err = Some(StockPilotError::DrawdownOutOfRange);
            return;
        }
        if safe_target_bps <= v.assets[safe].target_bps || safe_target_bps as u128 > core::BPS {
            err = Some(StockPilotError::InvalidSafeTarget);
            return;
        }
        v.safe_mint = safe_mint;
        v.safe_target_bps = safe_target_bps;
        v.drawdown_bps = drawdown_bps;
        v.defensive = false;
        v.peak_usd = 0;
    })?;
    match err {
        Some(e) => Err(e.into()),
        None => Ok(()),
    }
}

/// Reads every asset's balance and price, checking each account is the one the mandate names.
fn read_assets(program_id: &Pubkey, vault_key: &Pubkey, vault: &Vault, tokens: &[AccountInfo], feeds: &[AccountInfo]) -> Result<Vec<core::Asset>, ProgramError> {
    let (authority_key, _) = vault_authority(vault_key, program_id);
    let mut assets = Vec::with_capacity(vault.assets.len());
    for (i, cfg) in vault.assets.iter().enumerate() {
        if tokens[i].key.to_bytes() != cfg.vault_token || feeds[i].key.to_bytes() != cfg.price_feed {
            return Err(StockPilotError::WrongAccount.into());
        }
        let (_, owner, balance) = token_account(&tokens[i])?;
        if owner != authority_key.to_bytes() {
            return Err(StockPilotError::WrongAccount.into());
        }
        let (price, price_updated_at) = read_price(program_id, &feeds[i], cfg)?;
        assets.push(core::Asset { balance: balance as u128, price, decimals: cfg.decimals, price_updated_at, target_bps: cfg.target_bps, band_bps: cfg.band_bps });
    }
    Ok(assets)
}

/// The crash guard at these assets' value: a new peak or a trip. Then, in defensive mode, the targets in force.
fn apply_guard(vault: &mut Vault, assets: &mut [core::Asset]) {
    let g = core::guard_step(core::total_value(assets), vault.peak_usd, vault.drawdown_bps, vault.defensive);
    vault.peak_usd = g.peak;
    if g.trip {
        vault.defensive = true;
        msg!("Crash guard tripped: defensive targets in force");
    }
    if vault.defensive {
        if let Some(safe) = safe_index(vault) {
            let targets: Vec<u16> = vault.assets.iter().map(|a| a.target_bps).collect();
            for (i, a) in assets.iter_mut().enumerate() {
                a.target_bps = core::defensive_target(&targets, safe, vault.safe_target_bps, i);
            }
        }
    }
}

/// Anyone records the vault's value at fresh prices: a new peak, or past the drawdown, defensive mode.
fn poke(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let vault_info = accounts.first().ok_or(ProgramError::NotEnoughAccountKeys)?;
    let mut vault = load_vault(program_id, vault_info)?;
    if vault.drawdown_bps == 0 {
        return Err(StockPilotError::CrashGuardOff.into());
    }
    let n = vault.assets.len();
    if accounts.len() < 1 + 2 * n {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let mut assets = read_assets(program_id, vault_info.key, &vault, &accounts[1..1 + n], &accounts[1 + n..1 + 2 * n])?;
    let now = now()?;
    if assets.iter().any(|a| now - a.price_updated_at > vault.limits.max_price_age as i64) {
        return Err(StockPilotError::Mandate(core::Reason::StalePrice).into());
    }
    apply_guard(&mut vault, &mut assets);
    save(vault_info, &vault)
}

fn owner_update(program_id: &Pubkey, accounts: &[AccountInfo], f: impl FnOnce(&mut Vault)) -> ProgramResult {
    let it = &mut accounts.iter();
    let vault_info = next_account_info(it)?;
    let owner = next_account_info(it)?;
    let mut vault = load_vault(program_id, vault_info)?;
    require_signer(owner, &vault.owner, StockPilotError::NotOwner)?;
    vault.last_owner_activity = now()?; // every owner action is proof of life
    f(&mut vault);
    save(vault_info, &vault)
}

fn pause(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let it = &mut accounts.iter();
    let vault_info = next_account_info(it)?;
    let caller = next_account_info(it)?;
    let mut vault = load_vault(program_id, vault_info)?;
    let key = caller.key.to_bytes();
    if !caller.is_signer || (key != vault.owner && key != vault.pilot) {
        return Err(StockPilotError::NotOwnerOrPilot.into());
    }
    if key == vault.owner {
        vault.last_owner_activity = now()?;
    }
    vault.paused = true;
    save(vault_info, &vault)
}

fn core_limits(l: &LimitsConfig) -> core::Limits {
    core::Limits { max_trade_usd: l.max_trade_usd, daily_limit_usd: l.daily_limit_usd, max_slippage_bps: l.max_slippage_bps, max_price_age: l.max_price_age, cooldown: l.cooldown }
}

fn clock_of(v: &Vault, now: i64) -> core::Clock {
    core::Clock { now, last_trade_at: v.last_trade_at, budget_usd: v.budget_usd, budget_updated_at: v.budget_updated_at }
}

#[allow(clippy::too_many_arguments)]
fn rebalance(program_id: &Pubkey, accounts: &[AccountInfo], sell: usize, buy: usize, amount_in: u64, min_amount_out: u64, rationale: [u8; 32], venue_data: Vec<u8>) -> ProgramResult {
    let it = &mut accounts.iter();
    let vault_info = next_account_info(it)?;
    let pilot = next_account_info(it)?;
    let authority = next_account_info(it)?;
    let venue = next_account_info(it)?;
    let mut vault = load_vault(program_id, vault_info)?;
    require_signer(pilot, &vault.pilot, StockPilotError::NotPilot)?;
    if venue.key.to_bytes() != vault.venue || !venue.executable {
        return Err(StockPilotError::VenueMismatch.into());
    }
    let (authority_key, bump) = vault_authority(vault_info.key, program_id);
    if *authority.key != authority_key {
        return Err(StockPilotError::WrongAccount.into());
    }

    let n = vault.assets.len();
    let rest = &accounts[4..];
    if rest.len() < 2 * n {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let (tokens, rest) = rest.split_at(n);
    let (feeds, venue_accounts) = rest.split_at(n);

    // Every account must be the one the mandate names: a pilot cannot swap in its own token account or price feed.
    let mut assets = read_assets(program_id, vault_info.key, &vault, tokens, feeds)?;
    // A trade attempted past the drawdown is judged against the defensive targets (and records a new peak otherwise).
    apply_guard(&mut vault, &mut assets);
    if sell >= n || buy >= n {
        return Err(StockPilotError::Mandate(core::Reason::AssetNotInMandate).into());
    }
    let now = now()?;
    let limits = core_limits(&vault.limits);
    let clock = clock_of(&vault, now);
    let trade = core::Trade { sell, buy, amount_in: amount_in as u128 };
    // Fail fast, before any swap, on everything that does not depend on the fill.
    core::check_before_fill(&assets, &limits, &clock, vault.paused, &trade).map_err(StockPilotError::Mandate)?;

    // The swap: the venue moves tokens with the vault authority's signature.
    let mut metas = vec![AccountMeta::new_readonly(authority_key, true), AccountMeta::new(*tokens[sell].key, false), AccountMeta::new(*tokens[buy].key, false)];
    metas.extend(venue_accounts.iter().map(|a| if a.is_writable { AccountMeta::new(*a.key, a.is_signer) } else { AccountMeta::new_readonly(*a.key, a.is_signer) }));
    let mut infos = vec![authority.clone(), tokens[sell].clone(), tokens[buy].clone()];
    infos.extend(venue_accounts.iter().cloned());
    infos.push(venue.clone());
    invoke_signed(&Instruction { program_id: *venue.key, accounts: metas, data: venue_data }, &infos, &[&[b"authority", vault_info.key.as_ref(), &[bump]]])?;

    // Judge the trade by what actually moved.
    let (_, _, sell_after) = token_account(&tokens[sell])?;
    let (_, _, buy_after) = token_account(&tokens[buy])?;
    let spent = (assets[sell].balance as u64).saturating_sub(sell_after);
    if spent != amount_in || sell_after > assets[sell].balance as u64 {
        return Err(StockPilotError::VenueSpentWrongAmount.into());
    }
    let amount_out = buy_after.saturating_sub(assets[buy].balance as u64);
    let accepted = core::check(&assets, &limits, &clock, vault.paused, &trade, amount_out as u128, min_amount_out as u128).map_err(StockPilotError::Mandate)?;

    let next = core::after_spend(&limits, &clock, accepted.value_in);
    vault.last_trade_at = next.last_trade_at;
    vault.budget_usd = next.budget_usd;
    vault.budget_updated_at = next.budget_updated_at;
    save(vault_info, &vault)?;
    msg!("Rebalanced: sold {} of asset {} for {} of asset {} (${} in), rationale {:?}", amount_in, sell, amount_out, buy, accepted.value_in / core::WAD, rationale);
    Ok(())
}

fn withdraw(program_id: &Pubkey, accounts: &[AccountInfo], amount: u64) -> ProgramResult {
    let it = &mut accounts.iter();
    let vault_info = next_account_info(it)?;
    let owner = next_account_info(it)?;
    let authority = next_account_info(it)?;
    let source = next_account_info(it)?;
    let destination = next_account_info(it)?;
    let token_program = next_account_info(it)?;
    let mut vault = load_vault(program_id, vault_info)?;
    require_signer(owner, &vault.owner, StockPilotError::NotOwner)?;
    vault.last_owner_activity = now()?;
    if !vault.defensive {
        vault.peak_usd = 0; // money leaving is not a crash: re-arm from the next recorded value
    }
    save(vault_info, &vault)?;
    let (authority_key, bump) = vault_authority(vault_info.key, program_id);
    let (_, source_owner, _) = token_account(source)?;
    if *authority.key != authority_key || source_owner != authority_key.to_bytes() || *token_program.key != TOKEN_PROGRAM_ID {
        return Err(StockPilotError::WrongAccount.into());
    }
    // SPL Token `Transfer` (instruction 3): source, destination, authority.
    let mut data = vec![3u8];
    data.extend_from_slice(&amount.to_le_bytes());
    let ix = Instruction {
        program_id: TOKEN_PROGRAM_ID,
        accounts: vec![AccountMeta::new(*source.key, false), AccountMeta::new(*destination.key, false), AccountMeta::new_readonly(authority_key, true)],
        data,
    };
    invoke_signed(&ix, &[source.clone(), destination.clone(), authority.clone(), token_program.clone()], &[&[b"authority", vault_info.key.as_ref(), &[bump]]])
}

// ---------------------------------------------------------------------------------------------------------------------
// Recurring investment
// ---------------------------------------------------------------------------------------------------------------------

fn stop_recurring(v: &mut Vault) {
    v.recurring_mint = [0; 32];
    v.recurring_source = [0; 32];
    v.recurring_amount = 0;
    v.recurring_interval = 0;
    v.recurring_next_at = 0;
}

fn set_recurring(program_id: &Pubkey, accounts: &[AccountInfo], mint: [u8; 32], amount: u64, interval: u32) -> ProgramResult {
    // Turning it off needs no source account.
    let source = if amount == 0 { None } else { Some(accounts.get(2).ok_or(ProgramError::NotEnoughAccountKeys)?) };
    let source_key = source.map(|a| a.key.to_bytes()).unwrap_or_default();
    let source_account = source.map(token_account).transpose()?;
    let mut err = None;
    owner_update(program_id, accounts, |v| {
        let Some((source_mint, source_owner, _)) = source_account else {
            stop_recurring(v);
            return;
        };
        if !v.assets.iter().any(|a| a.mint == mint) {
            err = Some(StockPilotError::Mandate(core::Reason::AssetNotInMandate));
        } else if !(MIN_RECURRING_INTERVAL..=MAX_RECURRING_INTERVAL).contains(&interval) {
            err = Some(StockPilotError::IntervalOutOfRange);
        } else if source_mint != mint || source_owner != v.owner {
            // Only the owner's own account of that mint: never someone else's wallet, never another token.
            err = Some(StockPilotError::WrongAccount);
        } else {
            v.recurring_mint = mint;
            v.recurring_source = source_key;
            v.recurring_amount = amount;
            v.recurring_interval = interval;
            v.recurring_next_at = 0; // due now
        }
    })?;
    match err {
        Some(e) => Err(e.into()),
        None => Ok(()),
    }
}

/// Moves the owner's recurring investment into the vault with the vault authority's delegated signature.
fn pull_recurring(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let it = &mut accounts.iter();
    let vault_info = next_account_info(it)?;
    let authority = next_account_info(it)?;
    let source = next_account_info(it)?;
    let destination = next_account_info(it)?;
    let token_program = next_account_info(it)?;
    let mut vault = load_vault(program_id, vault_info)?;
    if vault.paused {
        return Err(StockPilotError::Mandate(core::Reason::EnforcedPause).into());
    }
    if vault.recurring_amount == 0 {
        return Err(StockPilotError::RecurringOff.into());
    }
    let now = now()?;
    if now < vault.recurring_next_at {
        return Err(StockPilotError::RecurringNotDue.into());
    }
    let (authority_key, bump) = vault_authority(vault_info.key, program_id);
    let asset = vault.assets.iter().find(|a| a.mint == vault.recurring_mint).ok_or(StockPilotError::Mandate(core::Reason::AssetNotInMandate))?;
    // Still the owner's account the owner chose, and the mandate's own vault account for that mint.
    let (source_mint, source_owner, _) = token_account(source)?;
    let (dest_mint, dest_owner, _) = token_account(destination)?;
    if *authority.key != authority_key
        || *token_program.key != TOKEN_PROGRAM_ID
        || source.key.to_bytes() != vault.recurring_source
        || source_mint != vault.recurring_mint
        || source_owner != vault.owner
        || destination.key.to_bytes() != asset.vault_token
        || dest_mint != vault.recurring_mint
        || dest_owner != authority_key.to_bytes()
    {
        return Err(StockPilotError::WrongAccount.into());
    }
    let amount = vault.recurring_amount;
    vault.recurring_next_at = now + vault.recurring_interval as i64;
    save(vault_info, &vault)?;
    // SPL Token `Transfer` (instruction 3) as the source's delegate: source, destination, authority.
    let mut data = vec![3u8];
    data.extend_from_slice(&amount.to_le_bytes());
    let ix = Instruction {
        program_id: TOKEN_PROGRAM_ID,
        accounts: vec![AccountMeta::new(*source.key, false), AccountMeta::new(*destination.key, false), AccountMeta::new_readonly(authority_key, true)],
        data,
    };
    invoke_signed(&ix, &[source.clone(), destination.clone(), authority.clone(), token_program.clone()], &[&[b"authority", vault_info.key.as_ref(), &[bump]]])?;
    msg!("Recurring deposit: {} into {}, next due at {}", amount, destination.key, vault.recurring_next_at);
    Ok(())
}
