// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title PilotRegistry
/// @notice A permissionless directory of pilots: AI agents (or people) that offer to rebalance vaults. A pilot
/// registers its own address with a name, a link to what it is and how it trades, and the annual fee it asks.
/// Owners pick one when they create a vault, and can replace it at any time with `PilotVault.setPilot`.
/// @dev The registry holds no funds and grants no rights: a vault trusts its pilot only within the mandate the owner
/// signed, whatever the registry says. Names are self-described and not unique; frontends must show the address and
/// each pilot's onchain track record next to the name. No admin, no upgrade.
contract PilotRegistry {
    /// @notice The highest fee a pilot may ask, equal to `PilotVault.MAX_FEE_BPS`.
    uint16 public constant MAX_FEE_BPS = 200;
    uint256 public constant MAX_NAME_BYTES = 64;
    uint256 public constant MAX_URI_BYTES = 256;

    struct Pilot {
        string name;
        /// @notice Where to learn about the pilot: a website, an MCP endpoint, a repository.
        string uri;
        /// @notice The annual management fee the pilot asks, in basis points. Owners set the vault's fee themselves.
        uint16 feeBps;
        bool active;
        uint64 registeredAt;
        uint64 updatedAt;
    }

    mapping(address pilot => Pilot) private _pilots;
    address[] private _all;

    event PilotRegistered(address indexed pilot, string name, string uri, uint16 feeBps);
    event PilotRetired(address indexed pilot);

    error InvalidName();
    error UriTooLong();
    error FeeTooHigh();
    error NotRegistered();

    /// @notice Register the caller as a pilot, or update its entry (and reactivate it if retired).
    function register(string calldata name, string calldata uri, uint16 feeBps) external {
        uint256 n = bytes(name).length;
        if (n == 0 || n > MAX_NAME_BYTES) revert InvalidName();
        if (bytes(uri).length > MAX_URI_BYTES) revert UriTooLong();
        if (feeBps > MAX_FEE_BPS) revert FeeTooHigh();

        Pilot storage p = _pilots[msg.sender];
        if (p.registeredAt == 0) {
            p.registeredAt = uint64(block.timestamp);
            _all.push(msg.sender);
        }
        p.name = name;
        p.uri = uri;
        p.feeBps = feeBps;
        p.active = true;
        p.updatedAt = uint64(block.timestamp);
        emit PilotRegistered(msg.sender, name, uri, feeBps);
    }

    /// @notice Stop offering to pilot new vaults. Vaults that already name this pilot are unaffected.
    function retire() external {
        Pilot storage p = _pilots[msg.sender];
        if (p.registeredAt == 0) revert NotRegistered();
        p.active = false;
        p.updatedAt = uint64(block.timestamp);
        emit PilotRetired(msg.sender);
    }

    function pilotOf(address pilot) external view returns (Pilot memory) {
        return _pilots[pilot];
    }

    function isActive(address pilot) external view returns (bool) {
        return _pilots[pilot].active;
    }

    function pilotCount() external view returns (uint256) {
        return _all.length;
    }

    /// @notice A page of the directory, in registration order, retired pilots included.
    function pilots(uint256 start, uint256 count) external view returns (address[] memory addrs, Pilot[] memory entries) {
        uint256 end = start + count;
        if (end > _all.length) end = _all.length;
        if (start > end) start = end;
        addrs = new address[](end - start);
        entries = new Pilot[](end - start);
        for (uint256 i = start; i < end; i++) {
            addrs[i - start] = _all[i];
            entries[i - start] = _pilots[_all[i]];
        }
    }
}
