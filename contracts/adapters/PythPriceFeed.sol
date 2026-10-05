// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AggregatorV3Interface} from "../interfaces/AggregatorV3Interface.sol";
import {IPyth} from "../interfaces/IPyth.sol";

/// @title PythPriceFeed
/// @notice Presents one Pyth price (for example Equity.US.TSLA/USD) as a Chainlink-style feed with 8 decimals, so a
/// PilotVault can price an asset with Pyth wherever Pyth is deployed.
/// @dev Reverts when Pyth's confidence interval is wider than `maxConfBps` of the price, which happens when a market
/// is closed or thinly traded. The vault treats a reverting feed as "no trade", which is the right answer then.
/// Freshness is not checked here: the vault already rejects prices older than its mandate's `maxPriceAge`.
contract PythPriceFeed is AggregatorV3Interface {
    uint8 public constant override decimals = 8;
    uint256 private constant BPS = 10_000;

    IPyth public immutable pyth;
    bytes32 public immutable priceId;
    uint256 public immutable maxConfBps;
    string public override description;

    error NegativePrice(int64 price);
    error ConfidenceTooWide(uint64 conf, int64 price);
    error UnsupportedExponent(int32 expo);

    constructor(IPyth pyth_, bytes32 priceId_, uint256 maxConfBps_, string memory description_) {
        pyth = pyth_;
        priceId = priceId_;
        maxConfBps = maxConfBps_;
        description = description_;
    }

    function latestRoundData() external view override returns (uint80, int256, uint256, uint256, uint80) {
        IPyth.Price memory p = pyth.getPriceUnsafe(priceId);
        if (p.price <= 0) revert NegativePrice(p.price);
        if (uint256(p.conf) * BPS > uint256(uint64(p.price)) * maxConfBps) revert ConfidenceTooWide(p.conf, p.price);
        int256 answer = _scale(int256(p.price), p.expo);
        uint80 round = uint80(p.publishTime);
        return (round, answer, p.publishTime, p.publishTime, round);
    }

    /// @dev price * 10^expo, expressed with 8 decimals.
    function _scale(int256 price, int32 expo) internal pure returns (int256) {
        int256 shift = int256(expo) + int256(uint256(decimals));
        if (shift < -30 || shift > 30) revert UnsupportedExponent(expo);
        if (shift >= 0) return price * int256(10 ** uint256(shift));
        return price / int256(10 ** uint256(-shift));
    }
}
