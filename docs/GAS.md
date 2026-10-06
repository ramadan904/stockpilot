# Gas

Measured by `npm run gas` on a local chain (Solidity 0.8.28, optimizer 200 runs, `cancun`). Trades and fee collection
price or touch every asset in the mandate, so they grow with the number of assets (at most 8).

The dollar columns are illustrative: execution gas only, at the given L2 gas price and ETH at $3,000.
Rollups also charge for posting data to Ethereum, which varies with L1 conditions. Check the chain's live prices.

| Mandate | Action | Gas | at 0.01 gwei | at 0.1 gwei |
|---|---|---:|---:|---:|
| Deploy | PilotVaultFactory | 5,075,510 | $0.152 | $1.523 |
| Deploy | PilotRegistry | 804,394 | $0.024 | $0.241 |
| Marketplace | List a pilot (name, link, fee) | 183,672 | $0.0055 | $0.055 |
| Marketplace | Update a listing | 42,580 | $0.0013 | $0.013 |
| Deploy | UniswapV3Adapter | 625,596 | $0.019 | $0.188 |
| Deploy | PythPriceFeed | 493,393 | $0.015 | $0.148 |
| 2 assets | Create a vault (with mandate and fee) | 514,931 | $0.015 | $0.154 |
| 2 assets | Deposit | 107,232 | $0.0032 | $0.032 |
| 2 assets | Rebalance (one trade, all checks) | 160,518 | $0.0048 | $0.048 |
| 2 assets | Collect fee (every asset) | 96,389 | $0.0029 | $0.029 |
| 2 assets | Replace the mandate | 138,664 | $0.0042 | $0.042 |
| 2 assets | Withdraw one asset | 120,427 | $0.0036 | $0.036 |
| 4 assets | Create a vault (with mandate and fee) | 591,922 | $0.018 | $0.178 |
| 4 assets | Deposit | 124,126 | $0.0037 | $0.037 |
| 4 assets | Rebalance (one trade, all checks) | 203,837 | $0.0061 | $0.061 |
| 4 assets | Collect fee (every asset) | 139,467 | $0.0042 | $0.042 |
| 4 assets | Replace the mandate | 204,965 | $0.0061 | $0.061 |
| 4 assets | Withdraw one asset | 163,505 | $0.0049 | $0.049 |
| 4 assets | Pause | 151,084 | $0.0045 | $0.045 |
| 4 assets | Unpause | 40,720 | $0.0012 | $0.012 |
| 4 assets | Set pilot | 35,172 | $0.0011 | $0.011 |
| 4 assets | Set or cancel fee | 131,958 | $0.0040 | $0.040 |
| 4 assets | Set up a recurring investment | 80,747 | $0.0024 | $0.024 |
| 4 assets | Pull a recurring investment | 68,917 | $0.0021 | $0.021 |
| 4 assets | Check in by signature (relayed) | 63,702 | $0.0019 | $0.019 |
| 4 assets | Arm the crash guard | 61,114 | $0.0018 | $0.018 |
| 4 assets | Poke: record a new peak | 142,771 | $0.0043 | $0.043 |
| 4 assets | Poke: crash guard trips | 127,244 | $0.0038 | $0.038 |
| 4 assets | Back to normal targets | 37,184 | $0.0011 | $0.011 |
| 4 assets | Name an heir | 33,978 | $0.0010 | $0.010 |
| 4 assets | Check in (proof of life) | 31,977 | $0.0010 | $0.0096 |
| 4 assets | Heir claims the vault | 44,304 | $0.0013 | $0.013 |
| 8 assets | Create a vault (with mandate and fee) | 814,353 | $0.024 | $0.244 |
| 8 assets | Deposit | 157,914 | $0.0047 | $0.047 |
| 8 assets | Rebalance (one trade, all checks) | 290,482 | $0.0087 | $0.087 |
| 8 assets | Collect fee (every asset) | 225,623 | $0.0068 | $0.068 |
| 8 assets | Replace the mandate | 337,618 | $0.010 | $0.101 |
| 8 assets | Withdraw one asset | 249,661 | $0.0075 | $0.075 |

## Notes

- Each vault is an EIP-1167 minimal proxy to one locked `PilotVault` implementation that the factory deploys once,
  so creating a vault costs about a sixth of deploying a full contract (about 3.07M gas before the change). Every
  later call pays a small `delegatecall` overhead, about 2.6k gas.
- `withdraw`, `pause`, `unpause`, `deposit`, `setFee` and `setMandate` first settle the management fee across every
  asset, which is why they grow with the mandate's size.
- A trade prices every asset in the mandate so it can check the band rule against the whole portfolio.
