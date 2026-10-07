// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Test token whose issuer can freeze an address, as regulated stablecoins and tokenized stocks can. Transfers
/// from a frozen address revert.
contract FreezableERC20 is ERC20 {
    mapping(address => bool) public frozen;

    error AccountFrozen(address account);

    constructor() ERC20("Frozen-able Dollar", "FUSD") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setFrozen(address account, bool value) external {
        frozen[account] = value;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (frozen[from]) revert AccountFrozen(from);
        super._update(from, to, value);
    }
}
