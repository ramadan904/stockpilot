// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice The part of Uniswap's SwapRouter02 that StockPilot uses. Forks with the same interface work too.
interface ISwapRouter02 {
    struct ExactInputParams {
        bytes path; // tokenIn, fee, token, fee, ..., tokenOut (20 + 3 + 20 + ... bytes)
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);
}
