# Gas

Measured by `npm run gas` on a local chain (Solidity 0.8.28, optimizer 200 runs, `cancun`). Trades and fee collection
price or touch every asset in the mandate, so they grow with the number of assets (at most 8).

The dollar columns are illustrative: execution gas only, at the given L2 gas price and ETH at $3,000.
Rollups also charge for posting data to Ethereum, which varies with L1 conditions. Check the chain's live prices.

| Mandate | Action | Gas | at 0.01 gwei | at 0.1 gwei |
|---|---|---:|---:|---:|
| Deploy | PilotVaultFactory | 5,504,379 | $0.165 | $1.651 |
| Deploy | PilotRegistry | 804,394 | $0.024 | $0.241 |
| Marketplace | List a pilot (name, link, fee) | 183,672 | $0.0055 | $0.055 |
| Marketplace | Update a listing | 42,580 | $0.0013 | $0.013 |
| Deploy | UniswapV3Adapter | 625,596 | $0.019 | $0.188 |
| Deploy | PythPriceFeed | 493,393 | $0.015 | $0.148 |
| 2 assets | Create a vault (with mandate and fee) | 517,086 | $0.016 | $0.155 |
| 2 assets | Deposit | 107,254 | $0.0032 | $0.032 |
| 2 assets | Rebalance (one trade, all checks) | 162,922 | $0.0049 | $0.049 |
| 2 assets | Collect fee (every asset) | 96,389 | $0.0029 | $0.029 |
| 2 assets | Replace the mandate | 140,819 | $0.0042 | $0.042 |
| 2 assets | Withdraw one asset | 120,471 | $0.0036 | $0.036 |
| 4 assets | Create a vault (with mandate and fee) | 594,077 | $0.018 | $0.178 |
| 4 assets | Deposit | 124,148 | $0.0037 | $0.037 |
| 4 assets | Rebalance (one trade, all checks) | 206,241 | $0.0062 | $0.062 |
| 4 assets | Collect fee (every asset) | 139,467 | $0.0042 | $0.042 |
| 4 assets | Replace the mandate | 207,120 | $0.0062 | $0.062 |
| 4 assets | Withdraw one asset | 163,549 | $0.0049 | $0.049 |
| 4 assets | Pause | 151,106 | $0.0045 | $0.045 |
| 4 assets | Unpause | 40,742 | $0.0012 | $0.012 |
| 4 assets | Set pilot | 35,172 | $0.0011 | $0.011 |
| 4 assets | Set or cancel fee | 131,891 | $0.0040 | $0.040 |
| 4 assets | Set up a recurring investment | 80,791 | $0.0024 | $0.024 |
| 4 assets | Pull a recurring investment | 68,939 | $0.0021 | $0.021 |
| 4 assets | Check in by signature (relayed) | 63,724 | $0.0019 | $0.019 |
| 4 assets | Set a glide path | 175,652 | $0.0053 | $0.053 |
| 4 assets | Arm the crash guard | 66,937 | $0.0020 | $0.020 |
| 4 assets | Poke: record a new peak | 142,793 | $0.0043 | $0.043 |
| 4 assets | Poke: crash guard trips | 127,266 | $0.0038 | $0.038 |
| 4 assets | Back to normal targets | 37,184 | $0.0011 | $0.011 |
| 4 assets | Name an heir | 34,000 | $0.0010 | $0.010 |
| 4 assets | Check in (proof of life) | 31,999 | $0.0010 | $0.0096 |
| 4 assets | Heir claims the vault | 44,304 | $0.0013 | $0.013 |
| 8 assets | Create a vault (with mandate and fee) | 816,496 | $0.024 | $0.245 |
| 8 assets | Deposit | 157,936 | $0.0047 | $0.047 |
| 8 assets | Rebalance (one trade, all checks) | 292,886 | $0.0088 | $0.088 |
| 8 assets | Collect fee (every asset) | 225,623 | $0.0068 | $0.068 |
| 8 assets | Replace the mandate | 339,761 | $0.010 | $0.102 |
| 8 assets | Withdraw one asset | 249,705 | $0.0075 | $0.075 |

## Notes

- Each vault is an EIP-1167 minimal proxy to one locked `PilotVault` implementation that the factory deploys once,
  so creating a vault costs about a sixth of deploying a full contract (about 3.07M gas before the change). Every
  later call pays a small `delegatecall` overhead, about 2.6k gas.
- `withdraw`, `pause`, `unpause`, `deposit`, `setFee` and `setMandate` first settle the management fee across every
  asset, which is why they grow with the mandate's size.
- A trade prices every asset in the mandate so it can check the band rule against the whole portfolio.
