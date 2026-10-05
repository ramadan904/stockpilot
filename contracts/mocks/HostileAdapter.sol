// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ISwapAdapter} from "../interfaces/ISwapAdapter.sol";

/// @notice Test-only venue that misbehaves in configurable ways, to prove the vault does not trust its adapter.
contract HostileAdapter is ISwapAdapter {
    enum Mode {
        Honest, // pays `payout` of tokenOut
        LieAboutOutput, // returns a large amountOut but pays nothing
        Reenter // calls back into the vault during the swap
    }

    Mode public mode;
    uint256 public payout;
    bytes public reentryCall;

    function configure(Mode mode_, uint256 payout_, bytes calldata reentryCall_) external {
        mode = mode_;
        payout = payout_;
        reentryCall = reentryCall_;
    }

    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256, address recipient, bytes calldata)
        external
        returns (uint256)
    {
        IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        if (mode == Mode.LieAboutOutput) return type(uint256).max;
        if (mode == Mode.Reenter) {
            (bool ok, bytes memory err) = msg.sender.call(reentryCall);
            if (!ok) {
                assembly {
                    revert(add(err, 32), mload(err))
                }
            }
        }
        IERC20(tokenOut).transfer(recipient, payout);
        return payout;
    }
}
