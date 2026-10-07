// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AggregatorV3Interface} from "../interfaces/AggregatorV3Interface.sol";

/// @notice A constant price that is always fresh, for pricing a stablecoin at par where no USD feed exists.
contract FixedPriceFeed is AggregatorV3Interface {
    uint8 public immutable override decimals;
    int256 public immutable answer;
    string public override description;

    constructor(string memory description_, uint8 decimals_, int256 answer_) {
        description = description_;
        decimals = decimals_;
        answer = answer_;
    }

    function latestRoundData() external view override returns (uint80, int256, uint256, uint256, uint80) {
        return (1, answer, block.timestamp, block.timestamp, 1);
    }
}
