// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IPyth} from "../interfaces/IPyth.sol";

/// @notice Test stand-in for the Pyth contract: prices are set directly.
contract MockPyth is IPyth {
    mapping(bytes32 => Price) private _prices;

    function setPrice(bytes32 id, int64 price, uint64 conf, int32 expo, uint256 publishTime) external {
        _prices[id] = Price(price, conf, expo, publishTime);
    }

    function getPriceUnsafe(bytes32 id) external view returns (Price memory) {
        return _prices[id];
    }
}
