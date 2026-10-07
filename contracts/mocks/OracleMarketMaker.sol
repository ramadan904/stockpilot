// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {AggregatorV3Interface} from "../interfaces/AggregatorV3Interface.sol";
import {ISwapAdapter} from "../interfaces/ISwapAdapter.sol";

/// @notice Testnet trading venue: fills any swap from its own inventory at oracle prices minus a fee. Tokenized
/// stocks have no testnet liquidity, so this stands in for a real venue behind the same ISwapAdapter interface.
contract OracleMarketMaker is ISwapAdapter, Ownable {
    using SafeERC20 for IERC20;

    uint256 public constant BPS = 10_000;

    mapping(address token => address feed) public feedOf;
    uint256 public feeBps;

    event FeedSet(address indexed token, address indexed feed);
    event FeeSet(uint256 feeBps);
    event Swapped(address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut);

    error NoFeed(address token);
    error BadPrice(address feed);
    error InsufficientOutput(uint256 amountOut, uint256 minAmountOut);
    error FeeTooHigh();

    constructor(uint256 feeBps_) Ownable(msg.sender) {
        _setFee(feeBps_);
    }

    function setFeed(address token, address feed) external onlyOwner {
        feedOf[token] = feed;
        emit FeedSet(token, feed);
    }

    function setFee(uint256 feeBps_) external onlyOwner {
        _setFee(feeBps_);
    }

    function quote(address tokenIn, address tokenOut, uint256 amountIn) public view returns (uint256) {
        uint256 valueIn = Math.mulDiv(amountIn, _price(tokenIn), 10 ** IERC20Metadata(tokenIn).decimals());
        uint256 valueOut = (valueIn * (BPS - feeBps)) / BPS;
        return Math.mulDiv(valueOut, 10 ** IERC20Metadata(tokenOut).decimals(), _price(tokenOut));
    }

    function swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        address recipient,
        bytes calldata
    ) external returns (uint256 amountOut) {
        amountOut = quote(tokenIn, tokenOut, amountIn);
        if (amountOut < minAmountOut) revert InsufficientOutput(amountOut, minAmountOut);
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        IERC20(tokenOut).safeTransfer(recipient, amountOut);
        emit Swapped(tokenIn, tokenOut, amountIn, amountOut);
    }

    function withdraw(address token, uint256 amount) external onlyOwner {
        IERC20(token).safeTransfer(msg.sender, amount);
    }

    function _setFee(uint256 feeBps_) internal {
        if (feeBps_ >= BPS) revert FeeTooHigh();
        feeBps = feeBps_;
        emit FeeSet(feeBps_);
    }

    /// @dev 18-decimal USD price.
    function _price(address token) internal view returns (uint256) {
        address feed = feedOf[token];
        if (feed == address(0)) revert NoFeed(token);
        (, int256 answer,,,) = AggregatorV3Interface(feed).latestRoundData();
        if (answer <= 0) revert BadPrice(feed);
        return uint256(answer) * 10 ** (18 - AggregatorV3Interface(feed).decimals());
    }
}
