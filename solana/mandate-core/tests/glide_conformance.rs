//! Replays glide-path targets produced by agent/glide.ts, which test/glidepath.test.ts checks second by second against
//! the EVM vault's `_base`, rounding included.
//!
//! Regenerate with `npm run vectors` at the repository root.

use serde_json::Value;
use stockpilot_mandate_core::glide_target;

#[test]
fn glide_agrees_with_the_typescript_model() {
    let vectors: Vec<Value> = serde_json::from_str(include_str!("glide-vectors.json")).expect("vectors");
    assert!(vectors.len() >= 1_000);
    let (mut arrived, mut midway) = (0, 0);
    for (i, v) in vectors.iter().enumerate() {
        let list = |k: &str| v[k].as_array().unwrap().iter().map(|t| t.as_u64().unwrap() as u16).collect::<Vec<_>>();
        let (from, to, expected) = (list("from"), list("to"), list("expected"));
        let (start, end, now) = (v["start"].as_i64().unwrap(), v["end"].as_i64().unwrap(), v["now"].as_i64().unwrap());
        for k in 0..from.len() {
            assert_eq!(glide_target(from[k], to[k], start, end, now), expected[k], "vector {i}: asset {k}");
        }
        if now >= end { arrived += 1 } else if now > start { midway += 1 }
    }
    assert!(arrived > 50 && midway > 600, "too few arrived ({arrived}) or midway ({midway}) paths exercised");
}
