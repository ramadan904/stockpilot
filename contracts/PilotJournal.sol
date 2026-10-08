// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PilotVault} from "./PilotVault.sol";
import {PilotVaultFactory} from "./PilotVaultFactory.sol";

/// @title PilotJournal
/// @notice Letters from a vault's pilot to its owner, published onchain: what it did, why, and how the vault stands.
/// Only the vault's current pilot can post for it, so a letter is a public, permanent statement signed by the agent
/// that trades, which anyone can hold against the vault's own trade history. The pilot also publishes the reason for
/// each trade: a trade carries only the hash of its reason, so the published text is checkable against it, word for word.
/// @dev The full text lives in the event (cheap on a rollup and readable forever); only counts are stored.
contract PilotJournal {
    /// @notice Longest letter accepted, in bytes.
    uint256 public constant MAX_LETTER = 4_000;

    bytes32 private immutable _cloneCodeHash;

    /// @notice How many letters each vault has received.
    mapping(address vault => uint256) public letterCount;
    /// @notice When each vault's latest letter was posted.
    mapping(address vault => uint64) public lastLetterAt;

    /// @param fromBlock First block the letter covers.
    /// @param toBlock Last block the letter covers.
    event Letter(
        address indexed vault, address indexed pilot, uint256 indexed number, uint64 fromBlock, uint64 toBlock, bytes32 textHash, string text
    );

    /// @notice The full reason for a trade. `rationale` is its hash, the value the vault recorded in `Rebalanced`.
    event Reason(address indexed vault, bytes32 indexed rationale, address indexed pilot, string text);

    error NotAStockPilotVault(address vault);
    error NotPilot();
    error EmptyLetter();
    error LetterTooLong(uint256 length);
    error BadRange();

    constructor(PilotVaultFactory factory) {
        // EIP-1167 minimal proxy runtime code pointing at the factory's implementation: genuine vaults only.
        _cloneCodeHash = keccak256(abi.encodePacked(hex"363d3d373d3d3d363d73", factory.implementation(), hex"5af43d82803e903d91602b57fd5bf3"));
    }

    /// @notice Publish a letter about `vault`, covering blocks `fromBlock` to `toBlock`. Only its current pilot may.
    function post(PilotVault vault, uint64 fromBlock, uint64 toBlock, string calldata text) external returns (uint256 number) {
        _checkPilotAndText(vault, text);
        if (fromBlock > toBlock || toBlock > block.number) revert BadRange();

        number = ++letterCount[address(vault)];
        lastLetterAt[address(vault)] = uint64(block.timestamp);
        emit Letter(address(vault), msg.sender, number, fromBlock, toBlock, keccak256(bytes(text)), text);
    }

    /// @notice Publish the full reason for a trade on `vault`. Its hash is what the trade recorded, so the text matches
    /// a trade exactly or matches none. Only the vault's current pilot may.
    function explain(PilotVault vault, string calldata text) external returns (bytes32 rationale) {
        _checkPilotAndText(vault, text);
        rationale = keccak256(bytes(text));
        emit Reason(address(vault), rationale, msg.sender, text);
    }

    function _checkPilotAndText(PilotVault vault, string calldata text) internal view {
        if (address(vault).codehash != _cloneCodeHash) revert NotAStockPilotVault(address(vault));
        if (vault.pilot() != msg.sender) revert NotPilot();
        uint256 length = bytes(text).length;
        if (length == 0) revert EmptyLetter();
        if (length > MAX_LETTER) revert LetterTooLong(length);
    }
}
