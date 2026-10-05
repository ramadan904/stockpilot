# Gas

Measured by `npm run gas` on a local chain (Solidity 0.8.28, optimizer 200 runs, `cancun`). Trades and fee collection
price or touch every asset in the mandate, so they grow with the number of assets (at most 8).

The dollar columns are illustrative: execution gas only, at the given L2 gas price and ETH at $3,000.
Rollups also charge for posting data to Ethereum, which varies with L1 conditions. Check the chain's live prices.

| Mandate | Action | Gas | at 0.01 gwei | at 0.1 gwei |
|---|---|---:|---:|---:|
| Deploy | PilotVaultFactory | 3,785,014 | $0.114 | $1.136 |
| Deploy | PilotRegistry | 804,394 | $0.024 | $0.241 |
| Marketplace | List a pilot (name, link, fee) | 183,672 | $0.0055 | $0.055 |
| Marketplace | Update a listing | 42,580 | $0.0013 | $0.013 |
| Deploy | UniswapV3Adapter | 625,596 | $0.019 | $0.188 |
| Deploy | PythPriceFeed | 493,393 | $0.015 | $0.148 |
| 2 assets | Create a vault (with mandate and fee) | 508,090 | $0.015 | $0.152 |
| 2 assets | Deposit | 107,190 | $0.0032 | $0.032 |
| 2 assets | Rebalance (one trade, all checks) | 157,539 | $0.0047 | $0.047 |
| 2 assets | Collect fee (every asset) | 96,370 | $0.0029 | $0.029 |
| 2 assets | Replace the mandate | 131,986 | $0.0040 | $0.040 |
| 2 assets | Withdraw one asset | 116,126 | $0.0035 | $0.035 |
| 4 assets | Create a vault (with mandate and fee) | 585,081 | $0.018 | $0.176 |
| 4 assets | Deposit | 124,084 | $0.0037 | $0.037 |
| 4 assets | Rebalance (one trade, all checks) | 200,858 | $0.0060 | $0.060 |
| 4 assets | Collect fee (every asset) | 139,448 | $0.0042 | $0.042 |
| 4 assets | Replace the mandate | 198,287 | $0.0059 | $0.059 |
| 4 assets | Withdraw one asset | 159,204 | $0.0048 | $0.048 |
| 4 assets | Pause | 151,064 | $0.0045 | $0.045 |
| 4 assets | Unpause | 40,767 | $0.0012 | $0.012 |
| 4 assets | Set pilot | 35,128 | $0.0011 | $0.011 |
| 4 assets | Set or cancel fee | 131,938 | $0.0040 | $0.040 |
| 4 assets | Name an heir | 34,043 | $0.0010 | $0.010 |
| 4 assets | Check in (proof of life) | 31,999 | $0.0010 | $0.0096 |
| 4 assets | Heir claims the vault | 41,972 | $0.0013 | $0.013 |
| 8 assets | Create a vault (with mandate and fee) | 807,500 | $0.024 | $0.242 |
| 8 assets | Deposit | 157,872 | $0.0047 | $0.047 |
| 8 assets | Rebalance (one trade, all checks) | 287,503 | $0.0086 | $0.086 |
| 8 assets | Collect fee (every asset) | 225,604 | $0.0068 | $0.068 |
| 8 assets | Replace the mandate | 330,928 | $0.0099 | $0.099 |
| 8 assets | Withdraw one asset | 245,360 | $0.0074 | $0.074 |

## Notes

- Each vault is an EIP-1167 minimal proxy to one locked `PilotVault` implementation that the factory deploys once,
  so creating a vault costs about a sixth of deploying a full contract (about 3.07M gas before the change). Every
  later call pays a small `delegatecall` overhead, about 2.6k gas.
- `withdraw`, `pause`, `unpause`, `deposit`, `setFee` and `setMandate` first settle the management fee across every
  asset, which is why they grow with the mandate's size.
- A trade prices every asset in the mandate so it can check the band rule against the whole portfolio.
