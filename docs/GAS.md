# Gas

Measured by `npm run gas` on a local chain (Solidity 0.8.28, optimizer 200 runs, `cancun`). Trades and fee collection
price or touch every asset in the mandate, so they grow with the number of assets (at most 8).

The dollar columns are illustrative: execution gas only, at the given L2 gas price and ETH at $3,000.
Rollups also charge for posting data to Ethereum, which varies with L1 conditions. Check the chain's live prices.

| Mandate | Action | Gas | at 0.01 gwei | at 0.1 gwei |
|---|---|---:|---:|---:|
| Deploy | PilotVaultFactory | 3,457,699 | $0.104 | $1.037 |
| Deploy | PilotRegistry | 804,394 | $0.024 | $0.241 |
| Marketplace | List a pilot (name, link, fee) | 183,672 | $0.0055 | $0.055 |
| Marketplace | Update a listing | 42,580 | $0.0013 | $0.013 |
| Deploy | UniswapV3Adapter | 625,596 | $0.019 | $0.188 |
| Deploy | PythPriceFeed | 493,393 | $0.015 | $0.148 |
| 2 assets | Create a vault (with mandate and fee) | 485,804 | $0.015 | $0.146 |
| 2 assets | Deposit | 100,075 | $0.0030 | $0.030 |
| 2 assets | Rebalance (one trade, all checks) | 157,517 | $0.0047 | $0.047 |
| 2 assets | Collect fee (every asset) | 96,326 | $0.0029 | $0.029 |
| 2 assets | Replace the mandate | 126,900 | $0.0038 | $0.038 |
| 2 assets | Withdraw one asset | 111,018 | $0.0033 | $0.033 |
| 4 assets | Create a vault (with mandate and fee) | 562,795 | $0.017 | $0.169 |
| 4 assets | Deposit | 116,969 | $0.0035 | $0.035 |
| 4 assets | Rebalance (one trade, all checks) | 200,836 | $0.0060 | $0.060 |
| 4 assets | Collect fee (every asset) | 139,404 | $0.0042 | $0.042 |
| 4 assets | Replace the mandate | 193,201 | $0.0058 | $0.058 |
| 4 assets | Withdraw one asset | 154,096 | $0.0046 | $0.046 |
| 4 assets | Pause | 145,861 | $0.0044 | $0.044 |
| 4 assets | Unpause | 35,681 | $0.0011 | $0.011 |
| 4 assets | Set pilot | 30,020 | $0.0009 | $0.0090 |
| 4 assets | Set or cancel fee | 126,840 | $0.0038 | $0.038 |
| 8 assets | Create a vault (with mandate and fee) | 785,202 | $0.024 | $0.236 |
| 8 assets | Deposit | 150,757 | $0.0045 | $0.045 |
| 8 assets | Rebalance (one trade, all checks) | 287,481 | $0.0086 | $0.086 |
| 8 assets | Collect fee (every asset) | 225,560 | $0.0068 | $0.068 |
| 8 assets | Replace the mandate | 325,830 | $0.0098 | $0.098 |
| 8 assets | Withdraw one asset | 240,252 | $0.0072 | $0.072 |

## Notes

- Each vault is an EIP-1167 minimal proxy to one locked `PilotVault` implementation that the factory deploys once,
  so creating a vault costs about a sixth of deploying a full contract (about 3.07M gas before the change). Every
  later call pays a small `delegatecall` overhead, about 2.6k gas.
- `withdraw`, `pause`, `unpause`, `deposit`, `setFee` and `setMandate` first settle the management fee across every
  asset, which is why they grow with the mandate's size.
- A trade prices every asset in the mandate so it can check the band rule against the whole portfolio.
