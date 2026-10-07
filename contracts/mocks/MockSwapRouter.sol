// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {OracleMarketMaker} from "./OracleMarketMaker.sol";
import {ISwapRouter02} from "../interfaces/ISwapRouter02.sol";

/// @notice Test stand-in for Uniswap's SwapRouter02: fills `exactInput` at oracle prices, charging each hop's pool
/// fee (in hundredths of a bip, like Uniswap), from its own inventory. Records the last path it was given.
contract MockSwapRouter is ISwapRouter02 {
    using SafeERC20 for IERC20;

    OracleMarketMaker public immutable pricer; // used only for its oracle quotes (with zero fee)
    bytes public lastPath;

    error TooLittleReceived(uint256 amountOut, uint256 minimum);

    constructor(OracleMarketMaker pricer_) {
        pricer = pricer_;
    }

    function exactInput(ExactInputParams calldata p) external payable returns (uint256 amountOut) {
        lastPath = p.path;
        (address tokenIn, address tokenOut, uint256 feePpm) = _walk(p.path);
        amountOut = pricer.quote(tokenIn, tokenOut, p.amountIn);
        amountOut = (amountOut * (1e6 - feePpm)) / 1e6;
        if (amountOut < p.amountOutMinimum) revert TooLittleReceived(amountOut, p.amountOutMinimum);
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), p.amountIn);
        IERC20(tokenOut).safeTransfer(p.recipient, amountOut);
    }

    /// @dev First token, last token, and the sum of the hop fees (a fine approximation for tests).
    function _walk(bytes calldata path) internal pure returns (address first, address last, uint256 fees) {
        first = address(bytes20(path[:20]));
        last = address(bytes20(path[path.length - 20:]));
        for (uint256 i = 20; i < path.length; i += 23) {
            fees += uint24(bytes3(path[i:i + 3]));
        }
    }
}
