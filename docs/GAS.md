# Gas

Measured by `npm run gas` on a local chain (Solidity 0.8.28, optimizer 200 runs, `cancun`). Trades and fee collection
price or touch every asset in the mandate, so they grow with the number of assets (at most 8).

The dollar columns are illustrative: execution gas only, at the given L2 gas price and ETH at $3,000.
Rollups also charge for posting data to Ethereum, which varies with L1 conditions. Check the chain's live prices.

| Mandate | Action | Gas | at 0.01 gwei | at 0.1 gwei |
|---|---|---:|---:|---:|
| Deploy | PilotVaultFactory | 3,917,169 | $0.118 | $1.175 |
| Deploy | UniswapV3Adapter | 625,596 | $0.019 | $0.188 |
| Deploy | PythPriceFeed | 493,393 | $0.015 | $0.148 |
| 2 assets | Create a vault (with mandate and fee) | 3,072,899 | $0.092 | $0.922 |
| 2 assets | Deposit | 77,412 | $0.0023 | $0.023 |
| 2 assets | Rebalance (one trade, all checks) | 154,831 | $0.0046 | $0.046 |
| 2 assets | Collect fee (every asset) | 93,685 | $0.0028 | $0.028 |
| 2 assets | Replace the mandate | 124,082 | $0.0037 | $0.037 |
| 2 assets | Withdraw one asset | 108,359 | $0.0033 | $0.033 |
| 4 assets | Create a vault (with mandate and fee) | 3,149,722 | $0.094 | $0.945 |
| 4 assets | Deposit | 94,306 | $0.0028 | $0.028 |
| 4 assets | Rebalance (one trade, all checks) | 198,150 | $0.0059 | $0.059 |
| 4 assets | Collect fee (every asset) | 136,763 | $0.0041 | $0.041 |
| 4 assets | Replace the mandate | 190,346 | $0.0057 | $0.057 |
| 4 assets | Withdraw one asset | 151,437 | $0.0045 | $0.045 |
| 4 assets | Pause | 143,220 | $0.0043 | $0.043 |
| 4 assets | Unpause | 33,018 | $0.0010 | $0.0099 |
| 4 assets | Set pilot | 27,373 | $0.0008 | $0.0082 |
| 4 assets | Set or cancel fee | 124,165 | $0.0037 | $0.037 |
| 8 assets | Create a vault (with mandate and fee) | 3,371,744 | $0.101 | $1.012 |
| 8 assets | Deposit | 128,094 | $0.0038 | $0.038 |
| 8 assets | Rebalance (one trade, all checks) | 284,795 | $0.0085 | $0.085 |
| 8 assets | Collect fee (every asset) | 222,919 | $0.0067 | $0.067 |
| 8 assets | Replace the mandate | 322,865 | $0.0097 | $0.097 |
| 8 assets | Withdraw one asset | 237,581 | $0.0071 | $0.071 |
## Notes

- Creating a vault deploys a full `PilotVault` (about 3M gas). Minimal-proxy clones (EIP-1167) would cut that roughly
  sevenfold; at L2 prices it costs cents to about a dollar today, so the simpler, constructor-initialised contract is
  kept for now.
- `withdraw`, `pause`, `unpause`, `deposit`, `setFee` and `setMandate` first settle the management fee across every
  asset, which is why they grow with the mandate's size.
- A trade prices every asset in the mandate so it can check the band rule against the whole portfolio.
