// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Votes} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {PilotVault} from "./PilotVault.sol";
import {PilotVaultFactory} from "./PilotVaultFactory.sol";

/// @title PilotFund
/// @notice A StockPilot vault many people own together. Anyone buys shares with any asset in the mandate, valued at
/// fresh oracle prices; any holder leaves at any time with their exact share of every holding, in kind, which needs no
/// price at all, so it works while the vault is paused, the oracle is down or the pilot is gone.
/// @dev The fund owns one vault created by the StockPilot factory, so the vault enforces the mandate on every trade as
/// it does for anyone. The fund never exposes the vault's owner powers that could hurt holders: the mandate, fee,
/// venue, heir and owner can never change. Its manager can pause and unpause, and replace the pilot only after a
/// notice period long enough for any holder to leave first. Holders of a majority of the shares can fire the pilot:
/// shares vote as they stood when the motion began, so votes cannot be bought for the occasion.
contract PilotFund is ERC20Votes, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice The smallest purchase, in USD (18 decimals). Keeps share prices meaningful from the first purchase on.
    uint256 public constant MIN_PURCHASE_USD = 1e18;
    uint256 private constant BPS = 10_000;
    /// @notice A holder's signed request to redeem, so anyone (a relay paying the gas) can submit it for them.
    bytes32 public constant REDEEM_TYPEHASH = keccak256("Redeem(address holder,uint256 shares,address to,uint256 nonce,uint256 deadline)");
    /// @notice How long holders have to leave before a new pilot takes over.
    uint256 public constant PILOT_NOTICE = 3 days;
    /// @notice How long a motion to fire the pilot stays open.
    uint256 public constant MOTION_PERIOD = 3 days;
    /// @notice The share of all shares (basis points) a holder needs to start a motion.
    uint256 public constant MOTION_STAKE_BPS = 100;
    /// @notice Shares vote as they stood this long before a motion began: buying in for the vote, then leaving, is
    /// not enough; a voter must have held through that time.
    uint256 public constant VOTE_RECORD_AGE = 1 days;

    /// @notice The vault this fund owns.
    PilotVault public immutable vault;
    /// @notice Who may pause the fund's vault and propose a new pilot. Set at creation; it can never move funds.
    address public immutable manager;

    address public pendingPilot;
    uint64 public pilotChangeAt;

    /// @notice A motion by holders to fire the pilot. It passes the moment votes exceed half of `supply`, both counted
    /// as shares stood `VOTE_RECORD_AGE` before `start`.
    struct Motion {
        uint48 start;
        uint48 end;
        bool passed;
        uint256 supply;
        uint256 votes;
    }

    uint256 public motionCount;
    mapping(uint256 id => Motion) public motions;
    mapping(uint256 id => mapping(address holder => bool)) public hasVoted;

    /// @notice The vault a fund is created with: its pilot, venue, mandate (fixed for the fund's life) and fee.
    struct VaultConfig {
        address pilot;
        address adapter;
        PilotVault.AssetConfig[] assets;
        PilotVault.Limits limits;
        address feeRecipient;
        uint16 feeBps;
    }

    event Bought(address indexed buyer, address indexed token, uint256 amount, uint256 valueUsd, uint256 shares);
    event Redeemed(address indexed holder, address indexed to, uint256 shares);
    /// @notice A holding the vault would not release (a frozen or reverting token); it stays with the other holders.
    event RedemptionSkipped(address indexed holder, address indexed token, uint256 amount);
    event PilotChangeProposed(address indexed pilot, uint256 effectiveAt);
    event PilotChangeCancelled(address indexed pilot);
    event PilotChanged(address indexed pilot);
    event MotionStarted(uint256 indexed id, address indexed by, uint256 endsAt, uint256 supply);
    event Voted(uint256 indexed id, address indexed holder, uint256 shares);
    event PilotFired(uint256 indexed id, address indexed pilot);

    error NotManager();
    error ZeroAddress();
    error ZeroAmount();
    error FundPaused();
    error NotInMandate(address token);
    error StalePrice(address token, uint256 updatedAt);
    error PurchaseTooSmall(uint256 valueUsd);
    error TooFewShares(uint256 shares, uint256 minShares);
    error WipedOut();
    error NoPilotChange();
    error NoticeRunning(uint256 effectiveAt);
    error NoPilot();
    error SignatureExpired();
    error InvalidSignature();
    error MotionOpen(uint256 id);
    error TooFewSharesToMove(uint256 shares, uint256 needed);
    error NoMotion(uint256 id);
    error MotionClosed(uint256 id);
    error AlreadyVoted(uint256 id);
    error NoVotes(uint256 id);

    modifier onlyManager() {
        if (msg.sender != manager) revert NotManager();
        _;
    }

    /// @dev Called by PilotFundFactory, which records the fund; the vault is created here so the fund is its owner.
    constructor(string memory name_, string memory symbol_, address manager_, PilotVaultFactory factory, VaultConfig memory cfg)
        ERC20(name_, symbol_)
        EIP712(name_, "1")
    {
        if (manager_ == address(0)) revert ZeroAddress();
        manager = manager_;
        vault = factory.createVault(cfg.pilot, cfg.adapter, cfg.assets, cfg.limits, cfg.feeRecipient, cfg.feeBps);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Holders
    // ------------------------------------------------------------------------------------------------------------

    /// @notice Buy shares with `amount` of `token` (any asset in the mandate), at the vault's value at fresh prices.
    /// @param minShares The fewest shares to accept; the purchase reverts below it. Use `quote` and allow for prices.
    function buy(address token, uint256 amount, uint256 minShares) external nonReentrant returns (uint256 shares) {
        return _buy(msg.sender, token, amount, minShares);
    }

    /// @notice Buy shares for `receiver`, paid by the caller: a gift, or a sponsor buying for someone without gas.
    function buyFor(address receiver, address token, uint256 amount, uint256 minShares) external nonReentrant returns (uint256 shares) {
        if (receiver == address(0)) revert ZeroAddress();
        return _buy(receiver, token, amount, minShares);
    }

    /// @notice Burn `shares` and receive the same fraction of every holding in the vault, sent to `to`. Works at any
    /// time, paused or not, and needs no prices.
    function redeem(uint256 shares, address to) external nonReentrant {
        _redeem(msg.sender, shares, to);
    }

    /// @notice Redeem for `holder` with their EIP-712 signature (`REDEEM_TYPEHASH`, this fund's domain, their next
    /// `nonces`), so a holder with no gas can still leave: anyone may submit it, and the holdings go only to `to`.
    function redeemWithSig(address holder, uint256 shares, address to, uint256 deadline, bytes calldata signature) external nonReentrant {
        if (block.timestamp > deadline) revert SignatureExpired();
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(REDEEM_TYPEHASH, holder, shares, to, _useNonce(holder), deadline)));
        if (!SignatureChecker.isValidSignatureNow(holder, digest, signature)) revert InvalidSignature();
        _redeem(holder, shares, to);
    }

    /// @notice Shares `amount` of `token` would buy now, and its value in USD (18 decimals). Paying the fee owed first
    /// lowers the vault's value, so a purchase gets at least this many shares at unchanged prices.
    function quote(address token, uint256 amount) external view returns (uint256 shares, uint256 valueUsd) {
        (uint256 price, uint256 nav) = _prices(token);
        valueUsd = Math.mulDiv(amount, price, 10 ** IERC20Metadata(token).decimals());
        shares = _sharesFor(valueUsd, nav);
    }

    /// @notice The vault's value per share, in USD (18 decimals), at the prices it reads now (fresh or not).
    function navPerShare() external view returns (uint256) {
        (, uint256 nav) = vault.portfolio();
        uint256 supply = totalSupply();
        return supply == 0 ? 1e18 : Math.mulDiv(nav, 1e18, supply);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Holders' motion to fire the pilot
    // ------------------------------------------------------------------------------------------------------------

    /// @notice Start a motion to fire the pilot, and vote for it. Needs 1% of the shares as they stood a day ago.
    function startMotion() external returns (uint256 id) {
        if (vault.pilot() == address(0)) revert NoPilot();
        uint256 last = motionCount;
        if (last != 0 && !motions[last].passed && block.timestamp < motions[last].end) revert MotionOpen(last);
        uint256 before = _recordTime(block.timestamp);
        uint256 supply = getPastTotalSupply(before);
        uint256 stake = getPastVotes(msg.sender, before);
        uint256 needed = Math.mulDiv(supply, MOTION_STAKE_BPS, BPS, Math.Rounding.Ceil);
        if (stake == 0 || stake < needed) revert TooFewSharesToMove(stake, needed);
        id = last + 1;
        motionCount = id;
        uint256 end = block.timestamp + MOTION_PERIOD;
        motions[id] = Motion(uint48(block.timestamp), uint48(end), false, supply, 0);
        emit MotionStarted(id, msg.sender, end, supply);
        _vote(id, msg.sender);
    }

    /// @notice Vote to fire the pilot, with the shares you held when the motion began.
    function vote(uint256 id) external {
        _vote(id, msg.sender);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Manager
    // ------------------------------------------------------------------------------------------------------------

    function pause() external onlyManager {
        vault.pause();
    }

    function unpause() external onlyManager {
        vault.unpause();
    }

    /// @notice Announce a new pilot. It takes over after `PILOT_NOTICE`, when anyone may apply the change.
    function proposePilot(address pilot) external onlyManager {
        pendingPilot = pilot;
        uint256 at = block.timestamp + PILOT_NOTICE;
        pilotChangeAt = uint64(at);
        emit PilotChangeProposed(pilot, at);
    }

    function cancelPilotChange() external onlyManager {
        if (pilotChangeAt == 0) revert NoPilotChange();
        emit PilotChangeCancelled(pendingPilot);
        delete pendingPilot;
        delete pilotChangeAt;
    }

    /// @notice Hand the vault to the announced pilot once the notice has run. Anyone can call it.
    function applyPilotChange() external {
        uint256 at = pilotChangeAt;
        if (at == 0) revert NoPilotChange();
        if (block.timestamp < at) revert NoticeRunning(at);
        address pilot = pendingPilot;
        delete pendingPilot;
        delete pilotChangeAt;
        emit PilotChanged(pilot);
        vault.setPilot(pilot);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Votes: shares are counted by timestamp, and every holder votes with their own shares without having to ask
    // ------------------------------------------------------------------------------------------------------------

    function clock() public view override returns (uint48) {
        return uint48(block.timestamp);
    }

    // solhint-disable-next-line func-name-mixedcase
    function CLOCK_MODE() public pure override returns (string memory) {
        return "mode=timestamp";
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (to != address(0) && delegates(to) == address(0)) _delegate(to, to);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Internal
    // ------------------------------------------------------------------------------------------------------------

    function _buy(address receiver, address token, uint256 amount, uint256 minShares) internal returns (uint256 shares) {
        if (amount == 0) revert ZeroAmount();
        if (vault.paused()) revert FundPaused();
        vault.collectFee(); // the fee owed so far is the existing holders' cost, not the buyer's
        (uint256 price, uint256 nav) = _prices(token);

        IERC20 t = IERC20(token);
        uint256 before = t.balanceOf(address(this));
        t.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = t.balanceOf(address(this)) - before;

        uint256 valueUsd = Math.mulDiv(received, price, 10 ** IERC20Metadata(token).decimals());
        shares = _sharesFor(valueUsd, nav);
        if (shares == 0 || shares < minShares) revert TooFewShares(shares, minShares);
        _mint(receiver, shares);
        emit Bought(receiver, token, received, valueUsd, shares);

        t.forceApprove(address(vault), received);
        vault.deposit(token, received);
    }

    function _redeem(address holder, uint256 shares, address to) internal {
        if (shares == 0) revert ZeroAmount();
        if (to == address(0)) revert ZeroAddress();
        uint256 supply = totalSupply();
        _burn(holder, shares);
        emit Redeemed(holder, to, shares);

        vault.collectFee(); // settle first, so every holder bears the fee up to now
        address[] memory list = vault.tokens();
        for (uint256 i; i < list.length; ++i) {
            uint256 amount = Math.mulDiv(IERC20(list[i]).balanceOf(address(vault)), shares, supply);
            if (amount == 0) continue;
            // One token that will not move must never trap the rest.
            try vault.withdraw(list[i], amount, to) {}
            catch {
                emit RedemptionSkipped(holder, list[i], amount);
            }
        }
    }

    /// @dev The moment shares are counted at for a motion starting at `start`.
    function _recordTime(uint256 start) internal pure returns (uint256) {
        return start > VOTE_RECORD_AGE ? start - VOTE_RECORD_AGE : 0;
    }

    function _vote(uint256 id, address holder) internal {
        Motion storage m = motions[id];
        if (m.start == 0) revert NoMotion(id);
        if (m.passed || block.timestamp >= m.end) revert MotionClosed(id);
        if (hasVoted[id][holder]) revert AlreadyVoted(id);
        uint256 shares = getPastVotes(holder, _recordTime(m.start));
        if (shares == 0) revert NoVotes(id);
        hasVoted[id][holder] = true;
        m.votes += shares;
        emit Voted(id, holder, shares);
        if (m.votes * 2 <= m.supply) return;
        // A majority: the pilot goes now, and any announced replacement with it. The manager can announce a new one,
        // with the usual notice, and holders can fire that one too.
        m.passed = true;
        delete pendingPilot;
        delete pilotChangeAt;
        address fired = vault.pilot();
        emit PilotFired(id, fired);
        vault.setPilot(address(0));
    }

    /// @dev The price of `token` and the vault's value, refusing any price older than the mandate allows: a purchase
    /// at a stale price would let a buyer take value from the holders.
    function _prices(address token) internal view returns (uint256 price, uint256 nav) {
        PilotVault.Holding[] memory holdings;
        (holdings, nav) = vault.portfolio();
        (,,, uint32 maxPriceAge,) = vault.limits();
        bool listed = false;
        for (uint256 i; i < holdings.length; ++i) {
            if (holdings[i].priceUpdatedAt + maxPriceAge < block.timestamp) revert StalePrice(holdings[i].token, holdings[i].priceUpdatedAt);
            if (holdings[i].token == token) (price, listed) = (holdings[i].priceUsd, true);
        }
        if (!listed) revert NotInMandate(token);
    }

    /// @dev The first purchase sets one share to one dollar, and takes anything already in the vault with it. After
    /// that, shares are issued at the vault's value per share, rounded down, so buyers never dilute holders.
    function _sharesFor(uint256 valueUsd, uint256 nav) internal view returns (uint256) {
        if (valueUsd < MIN_PURCHASE_USD) revert PurchaseTooSmall(valueUsd);
        uint256 supply = totalSupply();
        if (supply == 0) return valueUsd;
        if (nav == 0) revert WipedOut();
        return Math.mulDiv(valueUsd, supply, nav);
    }
}
