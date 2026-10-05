//! Replays verdicts produced by StockPilot's TypeScript rule model (agent/model.ts), which test/model.test.ts proves
//! equal to the EVM PilotVault trade for trade. This crate must agree on every vector: the same accept or reject, the
//! same reason, and for accepted trades the same USD values to the last wei.
//!
//! Regenerate with `npm run vectors` at the repository root.

use serde_json::Value;
use stockpilot_mandate_core::{check, Asset, Clock, Limits, Trade};

fn u(v: &Value) -> u128 {
    v.as_str().expect("string").parse().expect("u128")
}

#[test]
fn agrees_with_the_typescript_model_and_the_evm_contract() {
    let raw = include_str!("vectors.json");
    let vectors: Vec<Value> = serde_json::from_str(raw).expect("vectors");
    assert!(vectors.len() >= 3_000);
    let mut ok = 0;
    for (i, v) in vectors.iter().enumerate() {
        let assets: Vec<Asset> = v["assets"]
            .as_array()
            .unwrap()
            .iter()
            .map(|a| Asset {
                balance: u(&a["balance"]),
                price: u(&a["price"]),
                decimals: a["decimals"].as_u64().unwrap() as u8,
                price_updated_at: a["price_updated_at"].as_i64().unwrap(),
                target_bps: a["target_bps"].as_u64().unwrap() as u16,
                band_bps: a["band_bps"].as_u64().unwrap() as u16,
            })
            .collect();
        let l = &v["limits"];
        let limits = Limits {
            max_trade_usd: u(&l["max_trade_usd"]),
            daily_limit_usd: u(&l["daily_limit_usd"]),
            max_slippage_bps: l["max_slippage_bps"].as_u64().unwrap() as u16,
            max_price_age: l["max_price_age"].as_u64().unwrap() as u32,
            cooldown: l["cooldown"].as_u64().unwrap() as u32,
        };
        let c = &v["clock"];
        let clock = Clock {
            now: c["now"].as_i64().unwrap(),
            last_trade_at: c["last_trade_at"].as_i64().unwrap(),
            budget_usd: u(&c["budget_usd"]),
            budget_updated_at: c["budget_updated_at"].as_i64().unwrap(),
        };
        let t = &v["trade"];
        let trade = Trade { sell: t["sell"].as_u64().unwrap() as usize, buy: t["buy"].as_u64().unwrap() as usize, amount_in: u(&t["amount_in"]) };
        let got = check(&assets, &limits, &clock, v["paused"].as_bool().unwrap(), &trade, u(&v["amount_out"]), u(&v["min_amount_out"]));
        let expected = v["expected"].as_str().unwrap();
        match got {
            Ok(acc) => {
                assert_eq!(expected, "ok", "vector {i}: Rust accepted, TypeScript said {expected}");
                assert_eq!(acc.value_in, u(&v["value_in"]), "vector {i}: value_in");
                assert_eq!(acc.value_out, u(&v["value_out"]), "vector {i}: value_out");
                ok += 1;
            }
            Err(reason) => assert_eq!(reason.name(), expected, "vector {i}: reasons differ"),
        }
    }
    assert!(ok > 300, "too few accepted trades exercised: {ok}");
}
