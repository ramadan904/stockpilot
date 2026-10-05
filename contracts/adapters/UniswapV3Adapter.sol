// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {ISwapAdapter} from "../interfaces/ISwapAdapter.sol";
import {ISwapRouter02} from "../interfaces/ISwapRouter02.sol";

/// @title UniswapV3Adapter
/// @notice Lets a PilotVault trade on any Uniswap V3-style DEX. The pilot may pass a multi-hop path as `route`, or an
/// empty route to use the single-hop pool the operator configured for the pair.
/// @dev The adapter never decides whether a fill is good enough; the vault does that against oracle prices after the
/// swap. This contract only checks that the path really goes from `tokenIn` to `tokenOut` and holds nothing between
/// calls.
contract UniswapV3Adapter is ISwapAdapter, Ownable {
    using SafeERC20 for IERC20;

    ISwapRouter02 public immutable router;
    mapping(address tokenA => mapping(address tokenB => uint24 fee)) private _poolFee;

    uint256 private constant ADDR = 20;
    uint256 private constant HOP = 23; // fee (3) + address (20)

    event PoolFeeSet(address indexed tokenA, address indexed tokenB, uint24 fee);

    error BadPath();
    error NoPool(address tokenIn, address tokenOut);

    constructor(ISwapRouter02 router_) Ownable(msg.sender) {
        router = router_;
    }

    /// @notice The pool fee tier (e.g. 500, 3000) used when the pilot sends no route. Applies in both directions.
    function setPoolFee(address tokenA, address tokenB, uint24 fee) external onlyOwner {
        _poolFee[tokenA][tokenB] = fee;
        _poolFee[tokenB][tokenA] = fee;
        emit PoolFeeSet(tokenA, tokenB, fee);
    }

    function poolFee(address tokenA, address tokenB) external view returns (uint24) {
        return _poolFee[tokenA][tokenB];
    }

    function swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        address recipient,
        bytes calldata route
    ) external returns (uint256 amountOut) {
        bytes memory path = route.length == 0 ? _defaultPath(tokenIn, tokenOut) : route;
        _checkPath(path, tokenIn, tokenOut);

        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        IERC20(tokenIn).forceApprove(address(router), amountIn);
        amountOut = router.exactInput(
            ISwapRouter02.ExactInputParams({
                path: path,
                recipient: recipient,
                amountIn: amountIn,
                amountOutMinimum: minAmountOut
            })
        );
        IERC20(tokenIn).forceApprove(address(router), 0);
    }

    function _defaultPath(address tokenIn, address tokenOut) internal view returns (bytes memory) {
        uint24 fee = _poolFee[tokenIn][tokenOut];
        if (fee == 0) revert NoPool(tokenIn, tokenOut);
        return abi.encodePacked(tokenIn, fee, tokenOut);
    }

    /// @dev A valid path is address (fee address)+, starting at tokenIn and ending at tokenOut.
    function _checkPath(bytes memory path, address tokenIn, address tokenOut) internal pure {
        uint256 len = path.length;
        if (len < ADDR + HOP || (len - ADDR) % HOP != 0) revert BadPath();
        address first;
        address last;
        assembly {
            first := shr(96, mload(add(path, 32)))
            last := shr(96, mload(add(add(path, 32), sub(len, 20))))
        }
        if (first != tokenIn || last != tokenOut) revert BadPath();
    }
}
