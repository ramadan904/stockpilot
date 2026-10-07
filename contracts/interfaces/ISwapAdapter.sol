// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice A venue the vault trades through. The adapter pulls `amountIn` of `tokenIn` from the caller with
/// transferFrom and sends at least `minAmountOut` of `tokenOut` to `recipient`.
/// @dev The vault never trusts the return value: it measures its own balances before and after the call.
interface ISwapAdapter {
    function swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        address recipient,
        bytes calldata route
    ) external returns (uint256 amountOut);
}
