//! Replays crash-guard checks and defensive targets produced by agent/backtest.ts, which reproduce the EVM vault's
//! `_guard` and `_target` (the same numbers are checked against the contract in test/crashguard.test.ts).
//!
//! Regenerate with `npm run vectors` at the repository root.

use serde_json::Value;
use stockpilot_mandate_core::{defensive_target, guard_step};

fn u(v: &Value) -> u128 {
    v.as_str().expect("string").parse().expect("u128")
}

#[test]
fn guard_agrees_with_the_typescript_model() {
    let vectors: Vec<Value> = serde_json::from_str(include_str!("guard-vectors.json")).expect("vectors");
    assert!(vectors.len() >= 2_000);
    let (mut trips, mut peaks) = (0, 0);
    for (i, v) in vectors.iter().enumerate() {
        let got = guard_step(u(&v["total"]), u(&v["peak"]), v["drawdown_bps"].as_u64().unwrap() as u16, v["defensive"].as_bool().unwrap());
        assert_eq!(got.peak, u(&v["expected_peak"]), "vector {i}: peak");
        assert_eq!(got.trip, v["expected_trip"].as_bool().unwrap(), "vector {i}: trip");
        trips += got.trip as usize;
        peaks += (got.peak != u(&v["peak"])) as usize;

        let targets: Vec<u16> = v["targets"].as_array().unwrap().iter().map(|t| t.as_u64().unwrap() as u16).collect();
        let safe = v["safe"].as_u64().unwrap() as usize;
        let safe_target = v["safe_target_bps"].as_u64().unwrap() as u16;
        for (k, expected) in v["expected_targets"].as_array().unwrap().iter().enumerate() {
            assert_eq!(defensive_target(&targets, safe, safe_target, k), expected.as_u64().unwrap() as u16, "vector {i}: target {k}");
        }
    }
    assert!(trips > 300 && peaks > 300, "too few trips ({trips}) or new peaks ({peaks}) exercised");
}
