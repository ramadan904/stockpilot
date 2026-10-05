// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PilotVault} from "./PilotVault.sol";

/// @title PilotVaultFactory
/// @notice Deploys one PilotVault per user, owned by the caller, and keeps a registry for frontends and agents.
contract PilotVaultFactory {
    mapping(address owner => address[]) private _vaultsOf;
    address[] private _allVaults;

    event VaultCreated(address indexed owner, address indexed vault, address indexed pilot, address adapter);

    /// @notice Create a vault owned by the caller, with its pilot, venue, first mandate and (optional, `feeBps = 0` for
    /// none) management fee, in one transaction.
    function createVault(
        address pilot,
        address adapter,
        PilotVault.AssetConfig[] calldata assets,
        PilotVault.Limits calldata limits,
        address feeRecipient,
        uint16 feeBps
    ) external returns (PilotVault vault) {
        vault = new PilotVault(msg.sender, pilot, adapter, assets, limits, feeRecipient, feeBps);
        _vaultsOf[msg.sender].push(address(vault));
        _allVaults.push(address(vault));
        emit VaultCreated(msg.sender, address(vault), pilot, adapter);
    }

    function vaultsOf(address owner) external view returns (address[] memory) {
        return _vaultsOf[owner];
    }

    function vaultCount() external view returns (uint256) {
        return _allVaults.length;
    }

    function vaultAt(uint256 index) external view returns (address) {
        return _allVaults[index];
    }
}
