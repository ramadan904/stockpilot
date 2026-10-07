// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {AggregatorV3Interface} from "../interfaces/AggregatorV3Interface.sol";

/// @notice Chainlink-shaped feed whose price an updater pushes. Used on testnets that have no stock feeds, and in
/// tests to move markets and age prices.
contract MockPriceFeed is AggregatorV3Interface, Ownable {
    uint8 public immutable override decimals;
    string public override description;

    uint80 private _roundId;
    int256 private _answer;
    uint256 private _updatedAt;

    event PriceUpdated(uint80 indexed roundId, int256 answer, uint256 updatedAt);

    constructor(string memory description_, uint8 decimals_, int256 initialAnswer) Ownable(msg.sender) {
        description = description_;
        decimals = decimals_;
        _set(initialAnswer, block.timestamp);
    }

    function setPrice(int256 answer) external onlyOwner {
        _set(answer, block.timestamp);
    }

    /// @notice Set a price as of an earlier time, to simulate a feed that stopped updating.
    function setPriceAt(int256 answer, uint256 updatedAt) external onlyOwner {
        _set(answer, updatedAt);
    }

    function latestRoundData() external view override returns (uint80, int256, uint256, uint256, uint80) {
        return (_roundId, _answer, _updatedAt, _updatedAt, _roundId);
    }

    function _set(int256 answer, uint256 updatedAt) internal {
        _roundId++;
        _answer = answer;
        _updatedAt = updatedAt;
        emit PriceUpdated(_roundId, answer, updatedAt);
    }
}
