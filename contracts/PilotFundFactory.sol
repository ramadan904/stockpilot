// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PilotFund} from "./PilotFund.sol";
import {PilotVaultFactory} from "./PilotVaultFactory.sol";

/// @title PilotFundFactory
/// @notice Creates pooled StockPilot funds, each owning one vault from the StockPilot factory, and lists them so
/// frontends and agents can tell a genuine fund from a lookalike.
contract PilotFundFactory {
    PilotVaultFactory public immutable vaultFactory;

    address[] private _funds;
    mapping(address fund => bool) public isFund;

    event FundCreated(address indexed manager, address indexed fund, address indexed vault, string name, string symbol);

    constructor(PilotVaultFactory vaultFactory_) {
        vaultFactory = vaultFactory_;
    }

    /// @notice Create a fund managed by the caller, with its pilot, venue, mandate (fixed for the fund's life) and fee.
    function createFund(string calldata name, string calldata symbol, PilotFund.VaultConfig calldata cfg)
        external
        returns (PilotFund fund)
    {
        fund = new PilotFund(name, symbol, msg.sender, vaultFactory, cfg);
        _funds.push(address(fund));
        isFund[address(fund)] = true;
        emit FundCreated(msg.sender, address(fund), address(fund.vault()), name, symbol);
    }

    function fundCount() external view returns (uint256) {
        return _funds.length;
    }

    function funds() external view returns (address[] memory) {
        return _funds;
    }
}
