// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {PilotVault} from "./PilotVault.sol";
import {PilotVaultFactory} from "./PilotVaultFactory.sol";

/// @title MandateCredential
/// @notice A soulbound "Verified Mandate": proof that a StockPilot vault has flown under one mandate, unchanged, for at
/// least `minAge`. Every trade in that time was checked against those rules by the vault itself, so the credential
/// vouches for the rules, not for anyone's word. Other protocols and agents can read it, and ask `isCurrent` whether
/// the vault still flies the same rules today.
/// @dev The owner enrolls the vault, which starts the clock on its current mandate version; once `minAge` has passed
/// with the version unchanged, the owner issues the credential to themselves. A new mandate restarts the clock and
/// marks earlier credentials as no longer current. Tokens can't be transferred (ERC-5192: always locked).
contract MandateCredential is ERC721 {
    using Strings for uint256;
    using Strings for address;

    struct Credential {
        address vault;
        uint64 version;
        uint64 enrolledAt;
        uint64 issuedAt;
        bytes32 mandateHash;
    }

    struct Enrollment {
        uint64 version;
        uint64 at;
    }

    /// @notice How long a mandate must stand, unchanged, before it can be verified.
    uint256 public immutable minAge;
    /// @notice The vault code every StockPilot vault runs: only genuine clones of it can be enrolled.
    address public immutable implementation;
    bytes32 private immutable _cloneCodeHash;

    mapping(uint256 tokenId => Credential) private _credentials;
    mapping(address vault => Enrollment) public enrollments;
    /// @notice The credential issued for a vault's mandate version, if any.
    mapping(address vault => mapping(uint256 version => uint256 tokenId)) public credentialOf;
    uint256 public issued;

    event Enrolled(address indexed vault, uint256 indexed version, uint256 at);
    event Issued(uint256 indexed tokenId, address indexed vault, address indexed owner, uint256 version, bytes32 mandateHash);
    /// @notice ERC-5192: this token is bound to its holder.
    event Locked(uint256 tokenId);

    error NotAStockPilotVault(address vault);
    error NotVaultOwner();
    error NotEnrolled();
    error MandateChanged(uint256 enrolledVersion, uint256 currentVersion);
    error TooSoon(uint256 eligibleAt);
    error AlreadyIssued(uint256 tokenId);
    error Soulbound();

    constructor(PilotVaultFactory factory, uint256 minAge_) ERC721("StockPilot Verified Mandate", "MANDATE") {
        minAge = minAge_;
        implementation = factory.implementation();
        // EIP-1167 minimal proxy runtime code pointing at the implementation.
        _cloneCodeHash = keccak256(abi.encodePacked(hex"363d3d373d3d3d363d73", implementation, hex"5af43d82803e903d91602b57fd5bf3"));
    }

    // ------------------------------------------------------------------------------------------------------------
    // Owner actions
    // ------------------------------------------------------------------------------------------------------------

    /// @notice Start (or restart) the clock on the vault's current mandate.
    function enroll(PilotVault vault) external {
        _checkOwner(vault);
        uint256 version = vault.mandateVersion();
        enrollments[address(vault)] = Enrollment(uint64(version), uint64(block.timestamp));
        emit Enrolled(address(vault), version, block.timestamp);
    }

    /// @notice Issue the credential once the enrolled mandate has stood unchanged for `minAge`.
    function issue(PilotVault vault) external returns (uint256 tokenId) {
        _checkOwner(vault);
        Enrollment memory e = enrollments[address(vault)];
        if (e.at == 0) revert NotEnrolled();
        uint256 version = vault.mandateVersion();
        if (version != e.version) revert MandateChanged(e.version, version);
        if (block.timestamp < e.at + minAge) revert TooSoon(e.at + minAge);
        uint256 existing = credentialOf[address(vault)][version];
        if (existing != 0) revert AlreadyIssued(existing);

        tokenId = ++issued;
        _credentials[tokenId] = Credential(address(vault), uint64(version), e.at, uint64(block.timestamp), mandateHash(vault));
        credentialOf[address(vault)][version] = tokenId;
        _mint(msg.sender, tokenId);
        emit Issued(tokenId, address(vault), msg.sender, version, _credentials[tokenId].mandateHash);
        emit Locked(tokenId);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------------------------------------------------

    function credential(uint256 tokenId) external view returns (Credential memory) {
        _requireOwned(tokenId);
        return _credentials[tokenId];
    }

    /// @notice Whether the vault still flies exactly the mandate this credential verified.
    function isCurrent(uint256 tokenId) public view returns (bool) {
        _requireOwned(tokenId);
        Credential memory c = _credentials[tokenId];
        PilotVault vault = PilotVault(c.vault);
        return vault.mandateVersion() == c.version && mandateHash(vault) == c.mandateHash;
    }

    /// @notice A fingerprint of the vault's rules: every asset with its feed, decimals, target and band, and every limit.
    function mandateHash(PilotVault vault) public view returns (bytes32) {
        address[] memory tokens = vault.tokens();
        bytes memory packed = "";
        for (uint256 i; i < tokens.length; ++i) {
            (address feed, uint8 tokenDecimals, uint8 feedDecimals, uint16 targetBps, uint16 bandBps, bool listed) = vault.assets(tokens[i]);
            packed = abi.encodePacked(packed, tokens[i], feed, tokenDecimals, feedDecimals, targetBps, bandBps, listed);
        }
        (uint128 maxTradeUsd, uint128 dailyLimitUsd, uint16 maxSlippageBps, uint32 maxPriceAge, uint32 cooldown) = vault.limits();
        return keccak256(abi.encodePacked(packed, maxTradeUsd, dailyLimitUsd, maxSlippageBps, maxPriceAge, cooldown));
    }

    /// @notice ERC-5192: every credential is locked to its holder.
    function locked(uint256 tokenId) external view returns (bool) {
        _requireOwned(tokenId);
        return true;
    }

    function supportsInterface(bytes4 interfaceId) public view override returns (bool) {
        return interfaceId == 0xb45a3c0e || super.supportsInterface(interfaceId); // ERC-5192
    }

    /// @notice Fully onchain metadata: the vault, its mandate version and fingerprint, how long it stood, and whether it
    /// still does.
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        Credential memory c = _credentials[tokenId];
        bool current = isCurrent(tokenId);
        uint256 daysStood = (uint256(c.issuedAt) - c.enrolledAt) / 1 days;
        string memory json = string.concat(
            '{"name":"Verified Mandate #',
            tokenId.toString(),
            '","description":"This StockPilot vault flew one mandate, unchanged, with every trade checked against it by the vault contract.",',
            _attributes(c, daysStood, current),
            ',"image":"data:image/svg+xml;base64,',
            Base64.encode(bytes(_svg(c, daysStood, current))),
            '"}'
        );
        return string.concat("data:application/json;base64,", Base64.encode(bytes(json)));
    }

    // ------------------------------------------------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------------------------------------------------

    function _attributes(Credential memory c, uint256 daysStood, bool current) internal pure returns (string memory) {
        string memory head = string.concat(
            '"attributes":[{"trait_type":"Vault","value":"',
            c.vault.toHexString(),
            '"},{"trait_type":"Mandate version","value":',
            uint256(c.version).toString(),
            '},{"trait_type":"Days under the mandate","value":',
            daysStood.toString()
        );
        return string.concat(
            head,
            '},{"trait_type":"Mandate hash","value":"',
            uint256(c.mandateHash).toHexString(32),
            '"},{"trait_type":"Status","value":"',
            current ? "Current" : "Superseded",
            '"}]'
        );
    }

    function _svg(Credential memory c, uint256 daysStood, bool current) internal pure returns (string memory) {
        string memory head = string.concat(
            '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="340" viewBox="0 0 600 340" font-family="system-ui,sans-serif">',
            '<rect width="600" height="340" rx="24" fill="#0b1016"/>',
            '<circle cx="90" cy="70" r="160" fill="#3987e5" opacity="0.18"/><circle cx="540" cy="300" r="170" fill="#199e70" opacity="0.18"/>',
            '<text x="40" y="70" font-size="15" font-weight="700" letter-spacing="3" fill="#2dd4bf">VERIFIED MANDATE</text>',
            '<text x="40" y="118" font-size="34" font-weight="800" fill="#e6edf5">Rules kept for ',
            daysStood.toString(),
            daysStood == 1 ? " day</text>" : " days</text>"
        );
        string memory body = string.concat(
            '<text x="40" y="160" font-size="16" fill="#8b9bb0">Vault ',
            c.vault.toHexString(),
            "</text>",
            '<text x="40" y="188" font-size="16" fill="#8b9bb0">Mandate version ',
            uint256(c.version).toString(),
            ", every trade checked onchain</text>"
        );
        return string.concat(
            head,
            body,
            current
                ? '<text x="40" y="270" font-size="20" font-weight="700" fill="#2dd4bf">&#9679; Still in force</text>'
                : '<text x="40" y="270" font-size="20" font-weight="700" fill="#fbbf24">&#9679; Superseded by a newer mandate</text>',
            '<text x="40" y="306" font-size="15" fill="#8b9bb0">StockPilot &#183; soulbound</text></svg>'
        );
    }

    function _checkOwner(PilotVault vault) internal view {
        if (address(vault).codehash != _cloneCodeHash) revert NotAStockPilotVault(address(vault));
        if (vault.owner() != msg.sender) revert NotVaultOwner();
    }

    /// @dev Minting only: a credential stays with the owner it was issued to.
    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        if (_ownerOf(tokenId) != address(0)) revert Soulbound();
        return super._update(to, tokenId, auth);
    }
}
