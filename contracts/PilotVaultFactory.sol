// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {PilotVault} from "./PilotVault.sol";

/// @title PilotVaultFactory
/// @notice Creates one PilotVault per user, owned by the caller, and keeps a registry for frontends and agents.
/// @dev Each vault is an EIP-1167 minimal proxy to one locked implementation, created and initialised in a single
/// transaction. Clones are not upgradeable: the implementation address is fixed at deployment.
contract PilotVaultFactory {
    /// @notice The code every vault runs.
    address public immutable implementation;

    mapping(address owner => address[]) private _vaultsOf;
    address[] private _allVaults;

    event VaultCreated(address indexed owner, address indexed vault, address indexed pilot, address adapter);

    constructor() {
        implementation = address(new PilotVault());
    }

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
        vault = PilotVault(Clones.clone(implementation));
        // Record first, then initialise (which reads the tokens and feeds): if initialisation fails, all of it reverts.
        _vaultsOf[msg.sender].push(address(vault));
        _allVaults.push(address(vault));
        emit VaultCreated(msg.sender, address(vault), pilot, adapter);
        vault.initialize(msg.sender, pilot, adapter, assets, limits, feeRecipient, feeBps);
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
