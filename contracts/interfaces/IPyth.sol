// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice The part of the Pyth price oracle that StockPilot reads.
interface IPyth {
    struct Price {
        int64 price;
        uint64 conf;
        int32 expo;
        uint256 publishTime;
    }

    function getPriceUnsafe(bytes32 id) external view returns (Price memory price);
}
