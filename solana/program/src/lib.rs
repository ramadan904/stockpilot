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
pub const VAULT_SPACE: usize = 8 + 32 * 3 + 1 + 4 + 4 + MAX_ASSETS * (32 * 3 + 2 + 2 + 1) + (16 + 16 + 2 + 4 + 4) + 8 + 16 + 8 + 64;
pub const FEED_SPACE: usize = 8 + 32 + 8 + 8;
const PRICE_TO_WAD: u128 = 10_000_000_000; // 8-decimal feed price to 18 decimals

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct AssetConfig {
    pub mint: [u8; 32],
    /// The vault's token account for this mint, owned by the vault authority PDA.
    pub vault_token: [u8; 32],
    pub price_feed: [u8; 32],
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
    /// Accounts: [vault, owner (signer), vault authority, source (w, owned by the authority), destination (w), token program]
    Withdraw { amount: u64 },
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
    save(vault_info, &vault)
}

fn owner_update(program_id: &Pubkey, accounts: &[AccountInfo], f: impl FnOnce(&mut Vault)) -> ProgramResult {
    let it = &mut accounts.iter();
    let vault_info = next_account_info(it)?;
    let owner = next_account_info(it)?;
    let mut vault = load_vault(program_id, vault_info)?;
    require_signer(owner, &vault.owner, StockPilotError::NotOwner)?;
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
    let mut assets = Vec::with_capacity(n);
    for (i, cfg) in vault.assets.iter().enumerate() {
        if tokens[i].key.to_bytes() != cfg.vault_token || feeds[i].key.to_bytes() != cfg.price_feed {
            return Err(StockPilotError::WrongAccount.into());
        }
        let (_, owner, balance) = token_account(&tokens[i])?;
        if owner != authority_key.to_bytes() {
            return Err(StockPilotError::WrongAccount.into());
        }
        let feed = read_feed(program_id, &feeds[i])?;
        assets.push(core::Asset {
            balance: balance as u128,
            price: feed.price as u128 * PRICE_TO_WAD,
            decimals: cfg.decimals,
            price_updated_at: feed.updated_at,
            target_bps: cfg.target_bps,
            band_bps: cfg.band_bps,
        });
    }
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
    let vault = load_vault(program_id, vault_info)?;
    require_signer(owner, &vault.owner, StockPilotError::NotOwner)?;
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
