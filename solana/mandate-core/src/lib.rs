//! StockPilot's mandate rules, as pure Rust.
//!
//! The same checks, in the same order and with the same integer arithmetic, as `PilotVault.rebalance` on the EVM and
//! `agent/model.ts` in TypeScript. `tests/conformance.rs` replays thousands of verdicts produced by the TypeScript
//! model (itself checked trade-for-trade against the EVM contract) and requires this crate to agree on every one.
//!
//! USD values and prices use 18 decimals. Weights are 18-decimal fractions. Amounts are token base units.

#![no_std]

use ruint::aliases::U256;

pub const BPS: u128 = 10_000;
pub const WAD: u128 = 1_000_000_000_000_000_000;
pub const DAY: u128 = 86_400;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Asset {
    pub balance: u128,
    /// USD price, 18 decimals.
    pub price: u128,
    pub decimals: u8,
    pub price_updated_at: i64,
    pub target_bps: u16,
    pub band_bps: u16,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Limits {
    pub max_trade_usd: u128,
    pub daily_limit_usd: u128,
    pub max_slippage_bps: u16,
    pub max_price_age: u32,
    pub cooldown: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Clock {
    pub now: i64,
    pub last_trade_at: i64,
    /// Trade budget as of `budget_updated_at`; refills at `daily_limit_usd` per day, capped at it.
    pub budget_usd: u128,
    pub budget_updated_at: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Trade {
    pub sell: usize,
    pub buy: usize,
    pub amount_in: u128,
}

/// Why a trade is refused. Names match the EVM contract's custom errors.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reason {
    EnforcedPause,
    SameAsset,
    ZeroAmount,
    CooldownActive,
    StalePrice,
    AssetNotInMandate,
    TradeTooLarge,
    DailyLimitExceeded,
    InsufficientBalance,
    InsufficientOutput,
    SlippageExceeded,
    OutsideBand,
}

impl Reason {
    pub fn name(self) -> &'static str {
        match self {
            Reason::EnforcedPause => "EnforcedPause",
            Reason::SameAsset => "SameAsset",
            Reason::ZeroAmount => "ZeroAmount",
            Reason::CooldownActive => "CooldownActive",
            Reason::StalePrice => "StalePrice",
            Reason::AssetNotInMandate => "AssetNotInMandate",
            Reason::TradeTooLarge => "TradeTooLarge",
            Reason::DailyLimitExceeded => "DailyLimitExceeded",
            Reason::InsufficientBalance => "InsufficientBalance",
            Reason::InsufficientOutput => "InsufficientOutput",
            Reason::SlippageExceeded => "SlippageExceeded",
            Reason::OutsideBand => "OutsideBand",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Accepted {
    pub value_in: u128,
    pub value_out: u128,
}

/// floor(x * y / d) without intermediate overflow. Panics on d == 0 or a result above u128, which valid inputs never
/// produce.
pub fn mul_div(x: u128, y: u128, d: u128) -> u128 {
    let r = U256::from(x) * U256::from(y) / U256::from(d);
    u128::try_from(r).expect("mul_div overflow")
}

pub fn pow10(decimals: u8) -> u128 {
    10u128.pow(decimals as u32)
}

/// USD value (18 decimals) of `amount` base units at `price`.
pub fn value_of(amount: u128, price: u128, decimals: u8) -> u128 {
    mul_div(amount, price, pow10(decimals))
}

/// Base units worth `usd` at `price`.
pub fn amount_for(usd: u128, price: u128, decimals: u8) -> u128 {
    mul_div(usd, pow10(decimals), price)
}

pub fn total_value(assets: &[Asset]) -> u128 {
    assets.iter().map(|a| value_of(a.balance, a.price, a.decimals)).sum()
}

pub fn weight_wad(value: u128, total: u128) -> u128 {
    if total == 0 {
        0
    } else {
        mul_div(value, WAD, total)
    }
}

/// The trade budget available now.
pub fn available(limits: &Limits, clock: &Clock) -> u128 {
    let cap = limits.daily_limit_usd;
    let elapsed = (clock.now - clock.budget_updated_at).max(0) as u128;
    let refilled = clock.budget_usd + mul_div(cap, elapsed, DAY);
    refilled.min(cap)
}

fn abs_diff(a: u128, b: u128) -> u128 {
    a.abs_diff(b)
}

/// Inside the band after the trade, or moved toward target without crossing it.
pub fn band_allows(asset: &Asset, w_before: u128, w_after: u128) -> bool {
    let target = asset.target_bps as u128 * WAD / BPS;
    let band = asset.band_bps as u128 * WAD / BPS;
    if abs_diff(w_after, target) <= band {
        return true;
    }
    if w_before >= target {
        w_after <= w_before && w_after >= target
    } else {
        w_after >= w_before && w_after <= target
    }
}

/// Would the vault accept selling `trade.amount_in` of asset `trade.sell` if the venue pays `amount_out` of asset
/// `trade.buy`? Checks run in the EVM contract's order, so the first failure matches the error it would revert with.
pub fn check(assets: &[Asset], limits: &Limits, clock: &Clock, paused: bool, trade: &Trade, amount_out: u128, min_amount_out: u128) -> Result<Accepted, Reason> {
    if paused {
        return Err(Reason::EnforcedPause);
    }
    if trade.sell == trade.buy {
        return Err(Reason::SameAsset);
    }
    if trade.amount_in == 0 {
        return Err(Reason::ZeroAmount);
    }
    if clock.last_trade_at != 0 && clock.now < clock.last_trade_at + limits.cooldown as i64 {
        return Err(Reason::CooldownActive);
    }
    if assets.iter().any(|a| clock.now - a.price_updated_at > limits.max_price_age as i64) {
        return Err(Reason::StalePrice);
    }
    let (sell, buy) = match (assets.get(trade.sell), assets.get(trade.buy)) {
        (Some(s), Some(b)) => (s, b),
        _ => return Err(Reason::AssetNotInMandate),
    };

    let total_before = total_value(assets);
    let value_in = value_of(trade.amount_in, sell.price, sell.decimals);
    if value_in > limits.max_trade_usd {
        return Err(Reason::TradeTooLarge);
    }
    if value_in > available(limits, clock) {
        return Err(Reason::DailyLimitExceeded);
    }
    if trade.amount_in > sell.balance {
        return Err(Reason::InsufficientBalance);
    }
    if amount_out < min_amount_out {
        return Err(Reason::InsufficientOutput);
    }

    let value_out = value_of(amount_out, buy.price, buy.decimals);
    // valueOut * BPS < valueIn * (BPS - maxSlippage), in 256 bits.
    if U256::from(value_out) * U256::from(BPS) < U256::from(value_in) * U256::from(BPS - limits.max_slippage_bps as u128) {
        return Err(Reason::SlippageExceeded);
    }

    let sell_before = value_of(sell.balance, sell.price, sell.decimals);
    let buy_before = value_of(buy.balance, buy.price, buy.decimals);
    let sell_after = value_of(sell.balance - trade.amount_in, sell.price, sell.decimals);
    let buy_after = value_of(buy.balance + amount_out, buy.price, buy.decimals);
    let total_after = total_before + sell_after + buy_after - sell_before - buy_before;
    for (asset, before, after) in [(sell, sell_before, sell_after), (buy, buy_before, buy_after)] {
        if !band_allows(asset, weight_wad(before, total_before), weight_wad(after, total_after)) {
            return Err(Reason::OutsideBand);
        }
    }
    Ok(Accepted { value_in, value_out })
}

/// The budget and cooldown state after an accepted trade of `value_usd` lands at `clock.now`.
pub fn after_spend(limits: &Limits, clock: &Clock, value_usd: u128) -> Clock {
    Clock { budget_usd: available(limits, clock) - value_usd, budget_updated_at: clock.now, last_trade_at: clock.now, ..*clock }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LIMITS: Limits = Limits { max_trade_usd: 5_000 * WAD, daily_limit_usd: 20_000 * WAD, max_slippage_bps: 100, max_price_age: 3_600, cooldown: 60 };

    fn four() -> [Asset; 4] {
        let a = |balance: u128, price: u128, decimals: u8| Asset { balance, price, decimals, price_updated_at: 1_000, target_bps: 2_500, band_bps: 500 };
        // $2,500 each: USDG (6 decimals), and three stocks with 9 decimals.
        [a(2_500_000_000, WAD, 6), a(10_000_000_000, 250 * WAD, 9), a(12_500_000_000, 200 * WAD, 9), a(20_000_000_000, 125 * WAD, 9)]
    }

    fn clock() -> Clock {
        Clock { now: 1_000, last_trade_at: 0, budget_usd: 20_000 * WAD, budget_updated_at: 1_000 }
    }

    #[test]
    fn values_mixed_decimals() {
        assert_eq!(total_value(&four()), 10_000 * WAD);
    }

    #[test]
    fn allows_a_tilt_inside_the_bands() {
        let t = Trade { sell: 2, buy: 3, amount_in: 1_500_000_000 }; // $300 of the third asset
        let out = amount_for(300 * WAD * 999 / 1000, 125 * WAD, 9);
        assert!(check(&four(), &LIMITS, &clock(), false, &t, out, 0).is_ok());
    }

    #[test]
    fn refuses_to_concentrate() {
        let t = Trade { sell: 2, buy: 1, amount_in: 5_000_000_000 }; // $1,000: 15% vs 35%
        let out = amount_for(1_000 * WAD, 250 * WAD, 9);
        assert_eq!(check(&four(), &LIMITS, &clock(), false, &t, out, 0), Err(Reason::OutsideBand));
    }

    #[test]
    fn refills_the_budget_over_a_day() {
        let c = Clock { budget_usd: 0, budget_updated_at: 0, now: 43_200, last_trade_at: 0 };
        assert_eq!(available(&LIMITS, &c), 10_000 * WAD);
        assert_eq!(available(&LIMITS, &Clock { now: 999_999, ..c }), 20_000 * WAD);
    }

    #[test]
    fn mul_div_survives_large_products() {
        assert_eq!(mul_div(u64::MAX as u128 * 1_000, 10u128.pow(24), 10u128.pow(24)), u64::MAX as u128 * 1_000);
    }
}
