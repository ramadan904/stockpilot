// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {AggregatorV3Interface} from "./interfaces/AggregatorV3Interface.sol";
import {ISwapAdapter} from "./interfaces/ISwapAdapter.sol";

/// @title PilotVault
/// @notice A self-custodied portfolio of tokenized stocks and stablecoins that an AI agent (the "pilot") can trade,
/// but only inside a mandate the owner sets onchain.
///
/// The owner keeps custody: only the owner can withdraw, change the mandate, swap the pilot or the trading venue.
/// The pilot can only call `rebalance`, and every trade must pass these checks against oracle prices:
///
/// 1. Both assets are in the mandate, and the venue is the one the owner chose.
/// 2. The trade is no bigger than `maxTradeUsd`, and fits the trade budget: up to `dailyLimitUsd`, refilling
///    continuously over 24 hours, so there is no midnight reset to burst through.
/// 3. At least `cooldown` seconds have passed since the previous trade.
/// 4. Every price used is younger than `maxPriceAge`.
/// 5. What came back is worth at least `(1 - maxSlippageBps)` of what went out, at oracle prices.
/// 6. Neither asset ends up outside its band around its target weight, unless the trade moved it toward the target
///    (without crossing it).
///
/// Rule 6 is what turns an agent with trading rights into a pilot with a mandate: it may tilt the portfolio within
/// the bands, and it may always move an asset back toward its target, but it can never concentrate the portfolio.
///
/// A hosted pilot is paid by an optional management fee: at most 2% a year, taken pro-rata from every asset so it
/// never moves the weights, never accruing while the vault is paused, and cancellable by the owner at any time.
///
/// Inheritance: the owner may name an heir and an inactivity period (30 days to 10 years). Every owner action resets
/// the clock; if the owner does nothing for the whole period (lost keys, incapacity, death), the heir can take
/// ownership. The portfolio keeps being managed in the meantime. Ownership changing hands clears the heir.
contract PilotVault is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_ASSETS = 8;
    /// @notice Hard ceiling on the slippage an owner may allow, so a typo cannot hand the pilot a blank cheque.
    uint256 public constant MAX_SLIPPAGE_BPS = 1_000;
    /// @notice Hard ceiling on the annual management fee: 2%.
    uint256 public constant MAX_FEE_BPS = 200;
    uint256 private constant YEAR = 365 days;
    /// @notice Bounds on the inactivity period before an heir can take over.
    uint256 public constant MIN_INACTIVITY = 30 days;
    uint256 public constant MAX_INACTIVITY = 3650 days;
    uint256 private constant WAD = 1e18;

    /// @notice One asset of the mandate, as the owner passes it in.
    struct AssetConfig {
        address token;
        address feed; // Chainlink-compatible USD price feed
        uint16 targetBps; // target share of the portfolio's value; all targets sum to 10_000
        uint16 bandBps; // how far the pilot may let the weight drift from target, either way
    }

    /// @notice Trading limits. USD amounts have 18 decimals.
    struct Limits {
        uint128 maxTradeUsd;
        uint128 dailyLimitUsd;
        uint16 maxSlippageBps;
        uint32 maxPriceAge;
        uint32 cooldown;
    }

    struct Asset {
        address feed;
        uint8 tokenDecimals;
        uint8 feedDecimals;
        uint16 targetBps;
        uint16 bandBps;
        bool listed;
    }

    /// @dev One side of a trade, priced once at the start of `rebalance`.
    struct Leg {
        address token;
        uint8 decimals;
        uint16 targetBps;
        uint16 bandBps;
        uint256 price;
        uint256 balance;
        uint256 value;
    }

    /// @notice One row of `portfolio()`.
    struct Holding {
        address token;
        uint256 balance;
        uint256 priceUsd; // 18 decimals
        uint256 priceUpdatedAt;
        uint256 valueUsd; // 18 decimals
        uint256 weightBps;
        uint16 targetBps;
        uint16 bandBps;
    }

    address[] private _tokens;
    mapping(address token => Asset) public assets;
    Limits public limits;

    address public pilot;
    address public adapter;
    uint256 public mandateVersion;

    uint64 public lastTradeAt;
    /// @notice Trade budget (USD, 18 decimals) as of `budgetUpdatedAt`; see `tradeBudget()` for the live figure.
    uint128 public budgetUsd;
    uint64 public budgetUpdatedAt;

    address public feeRecipient;
    uint16 public feeBps;
    uint64 public feeAccruedAt;

    bool private _initialized;

    /// @notice Who may take ownership after `inactivityPeriod` seconds without any action by the owner.
    address public heir;
    uint32 public inactivityPeriod;
    /// @notice When the owner last did anything with the vault (or became its owner).
    uint64 public lastOwnerActivity;

    event MandateSet(uint256 indexed version, AssetConfig[] assets, Limits limits);
    event PilotSet(address indexed pilot);
    event AdapterSet(address indexed adapter);
    event Deposited(address indexed from, address indexed token, uint256 amount);
    event Withdrawn(address indexed to, address indexed token, uint256 amount);
    event FeeSet(address indexed recipient, uint256 feeBps);
    event FeeCollected(address indexed recipient, address indexed token, uint256 amount);
    event HeirSet(address indexed heir, uint32 inactivityPeriod);
    event OwnerCheckedIn();
    event InheritanceClaimed(address indexed previousOwner, address indexed heir);
    /// @param rationale Hash of the pilot's written reasoning for the trade, so its log can be checked against the chain.
    event Rebalanced(
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        uint256 valueInUsd,
        uint256 valueOutUsd,
        bytes32 indexed rationale
    );

    error NotPilot();
    error NotOwnerOrPilot();
    error ZeroAddress();
    error EmptyMandate();
    error TooManyAssets();
    error DuplicateAsset(address token);
    error TargetsMustSumTo100Percent(uint256 sum);
    error BandTooWide(address token);
    error UnsupportedDecimals(address tokenOrFeed);
    error SlippageCapTooHigh();
    error ZeroLimit();
    error NoAdapter();
    error AssetNotInMandate(address token);
    error SameAsset();
    error ZeroAmount();
    error CooldownActive(uint256 nextTradeAt);
    error TradeTooLarge(uint256 valueUsd, uint256 maxTradeUsd);
    error DailyLimitExceeded(uint256 valueUsd, uint256 availableUsd);
    error FeeTooHigh();
    error InvalidPrice(address feed);
    error StalePrice(address feed, uint256 updatedAt);
    error AdapterOverspent(uint256 spent, uint256 amountIn);
    error InsufficientOutput(uint256 amountOut, uint256 minAmountOut);
    error SlippageExceeded(uint256 valueInUsd, uint256 valueOutUsd);
    error OutsideBand(address token, uint256 weightBeforeWad, uint256 weightAfterWad);
    error RenounceDisabled();
    error AlreadyInitialized();
    error NotHeir();
    error InvalidHeir();
    error InactivityOutOfRange();
    error OwnerStillActive(uint256 claimableAt);

    modifier onlyPilot() {
        if (msg.sender != pilot) revert NotPilot();
        _;
    }

    /// @dev Owner-only, and proof of life for inheritance.
    modifier ownerAction() {
        _checkOwner();
        lastOwnerActivity = uint64(block.timestamp);
        _;
    }

    /// @dev The implementation behind every vault clone. It is locked: it can never be initialised or hold a mandate.
    /// Its own owner is the deployer (the factory) and is irrelevant to clones, which have their own storage.
    constructor() Ownable(msg.sender) {
        _initialized = true;
    }

    /// @notice Set up a vault clone. The factory calls this in the same transaction that creates the clone, so no one
    /// else can initialise it first, and it can only ever run once.
    function initialize(
        address owner_,
        address pilot_,
        address adapter_,
        AssetConfig[] calldata assets_,
        Limits calldata limits_,
        address feeRecipient_,
        uint16 feeBps_
    ) external {
        if (_initialized) revert AlreadyInitialized();
        _initialized = true;
        if (owner_ == address(0)) revert ZeroAddress();
        _transferOwnership(owner_);
        pilot = pilot_;
        adapter = adapter_;
        emit PilotSet(pilot_);
        emit AdapterSet(adapter_);
        _setMandate(assets_, limits_);
        feeAccruedAt = uint64(block.timestamp);
        _setFee(feeRecipient_, feeBps_);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Owner
    // ------------------------------------------------------------------------------------------------------------

    /// @notice Replace the whole mandate. Tokens dropped from it stay in the vault, unpriced and untradeable by the
    /// pilot, until the owner withdraws them or lists them again.
    function setMandate(AssetConfig[] calldata assets_, Limits calldata limits_) external ownerAction nonReentrant {
        _collectFee(); // settle on the old asset list
        _setMandate(assets_, limits_);
    }

    /// @notice Set or cancel the management fee. Fees accrued so far are paid at the old rate first.
    function setFee(address recipient, uint16 bps) external ownerAction nonReentrant {
        _collectFee();
        _setFee(recipient, bps);
    }

    /// @notice Set the agent allowed to trade. `address(0)` revokes it.
    function setPilot(address pilot_) external ownerAction {
        pilot = pilot_;
        emit PilotSet(pilot_);
    }

    /// @notice Set the venue the pilot trades through. `address(0)` stops all trading.
    function setAdapter(address adapter_) external ownerAction {
        adapter = adapter_;
        emit AdapterSet(adapter_);
    }

    /// @notice Withdraw any token, any time, paused or not.
    function withdraw(address token, uint256 amount, address to) external ownerAction nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        _collectFee(); // pay what is owed before the balance shrinks
        if (amount > IERC20(token).balanceOf(address(this))) amount = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransfer(to, amount);
        emit Withdrawn(to, token, amount);
    }

    /// @notice Stop the pilot. The owner or the pilot itself can pull this brake; only the owner can release it.
    function pause() external nonReentrant {
        if (msg.sender != owner() && msg.sender != pilot) revert NotOwnerOrPilot();
        if (msg.sender == owner()) lastOwnerActivity = uint64(block.timestamp);
        _collectFee(); // fees stop accruing from here
        _pause();
    }

    function unpause() external ownerAction nonReentrant {
        _collectFee(); // restarts the fee clock without charging for the pause
        _unpause();
    }

    /// @dev Renouncing would lock the funds in the vault forever.
    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }

    /// @notice Start handing the vault to `newOwner` (who must accept). Counts as owner activity.
    function transferOwnership(address newOwner) public override ownerAction {
        super.transferOwnership(newOwner);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Inheritance
    // ------------------------------------------------------------------------------------------------------------

    /// @notice Name an heir who may take ownership after `period` seconds without any owner action, or clear it with
    /// `address(0)`. The clock restarts now.
    function setHeir(address heir_, uint32 period) external ownerAction {
        if (heir_ == address(0)) {
            period = 0;
        } else {
            if (heir_ == owner()) revert InvalidHeir();
            if (period < MIN_INACTIVITY || period > MAX_INACTIVITY) revert InactivityOutOfRange();
        }
        heir = heir_;
        inactivityPeriod = period;
        emit HeirSet(heir_, period);
    }

    /// @notice Proof of life: restarts the inactivity clock without changing anything else.
    function checkIn() external ownerAction {
        emit OwnerCheckedIn();
    }

    /// @notice The heir takes ownership once the owner has been inactive for the whole period. The pilot, mandate and
    /// fee stay as they were; the new owner can change any of them, or withdraw everything.
    function claimInheritance() external {
        address h = heir;
        if (h == address(0) || msg.sender != h) revert NotHeir();
        uint256 at = inheritanceClaimableAt();
        if (block.timestamp < at) revert OwnerStillActive(at);
        address previous = owner();
        _transferOwnership(h);
        emit InheritanceClaimed(previous, h);
    }

    /// @notice When the heir may claim, if the owner does nothing until then; 0 without an heir.
    function inheritanceClaimableAt() public view returns (uint256) {
        return heir == address(0) ? 0 : uint256(lastOwnerActivity) + inactivityPeriod;
    }

    /// @dev Every change of owner (creation, a two-step transfer, an inheritance) restarts the clock and clears the
    /// heir: the previous owner's choice of heir is not the new owner's.
    function _transferOwnership(address newOwner) internal override {
        super._transferOwnership(newOwner);
        lastOwnerActivity = uint64(block.timestamp);
        if (heir != address(0)) {
            heir = address(0);
            inactivityPeriod = 0;
            emit HeirSet(address(0), 0);
        }
    }

    // ------------------------------------------------------------------------------------------------------------
    // Anyone
    // ------------------------------------------------------------------------------------------------------------

    /// @notice Pay the management fee accrued so far. Anyone can call it; the fee only ever goes to `feeRecipient`.
    function collectFee() external nonReentrant {
        _collectFee();
    }

    /// @notice Add funds. Plain transfers work too, but skip the fee settlement below, so prefer this.
    function deposit(address token, uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (msg.sender == owner()) lastOwnerActivity = uint64(block.timestamp);
        _collectFee(); // settle first, so new money is never charged for time it was not in the vault
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(msg.sender, token, amount);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Pilot
    // ------------------------------------------------------------------------------------------------------------

    /// @notice Sell `amountIn` of `tokenIn` for `tokenOut` through the owner's adapter, subject to the mandate.
    /// @param route Venue-specific routing data, passed through to the adapter.
    /// @param rationale Hash of the pilot's explanation for this trade.
    function rebalance(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        bytes calldata route,
        bytes32 rationale
    ) external onlyPilot whenNotPaused nonReentrant returns (uint256 amountOut) {
        address venue = adapter;
        if (venue == address(0)) revert NoAdapter();
        if (tokenIn == tokenOut) revert SameAsset();
        if (amountIn == 0) revert ZeroAmount();
        _checkCooldown();

        // Price everything once; the same prices judge the trade before and after.
        (Leg memory sell, Leg memory buy, uint256 totalBefore) = _legs(tokenIn, tokenOut);

        uint256 valueIn = _value(amountIn, sell.price, sell.decimals);
        _checkSizeAndSpend(valueIn);

        lastTradeAt = uint64(block.timestamp); // effects before the external call; a revert undoes it
        amountOut = _swap(venue, sell, buy, amountIn, minAmountOut, route);

        uint256 valueOut = _value(amountOut, buy.price, buy.decimals);
        if (valueOut * BPS < valueIn * (BPS - limits.maxSlippageBps)) revert SlippageExceeded(valueIn, valueOut);

        _checkBands(sell, buy, totalBefore);

        emit Rebalanced(tokenIn, tokenOut, amountIn, amountOut, valueIn, valueOut, rationale);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------------------------------------------------

    function tokens() external view returns (address[] memory) {
        return _tokens;
    }

    /// @notice Every asset in the mandate with its balance, price, value and weight. Stale prices are reported, not
    /// rejected, so a dashboard keeps working when markets are closed; check `priceUpdatedAt`.
    function portfolio() external view returns (Holding[] memory holdings, uint256 totalUsd) {
        uint256 n = _tokens.length;
        holdings = new Holding[](n);
        for (uint256 i; i < n; ++i) {
            address token = _tokens[i];
            Asset memory asset = assets[token];
            (uint256 price, uint256 updatedAt) = _price(asset.feed, asset.feedDecimals, 0);
            uint256 balance = IERC20(token).balanceOf(address(this));
            uint256 value = _value(balance, price, asset.tokenDecimals);
            holdings[i] = Holding(token, balance, price, updatedAt, value, 0, asset.targetBps, asset.bandBps);
            totalUsd += value;
        }
        if (totalUsd > 0) {
            for (uint256 i; i < n; ++i) {
                holdings[i].weightBps = (holdings[i].valueUsd * BPS) / totalUsd;
            }
        }
    }

    /// @notice USD volume (18 decimals) the pilot can trade right now. Refills at `dailyLimitUsd` per 24 hours, up to
    /// `dailyLimitUsd`.
    function tradeBudget() external view returns (uint256) {
        return _available(limits.dailyLimitUsd);
    }

    /// @notice Fee owed right now, per asset in mandate order, at current balances.
    function feeOwed() external view returns (uint256[] memory owed) {
        uint256 n = _tokens.length;
        owed = new uint256[](n);
        uint256 elapsed = block.timestamp - feeAccruedAt;
        if (feeBps == 0 || paused()) return owed;
        for (uint256 i; i < n; ++i) {
            owed[i] = _feeOn(IERC20(_tokens[i]).balanceOf(address(this)), elapsed);
        }
    }

    // ------------------------------------------------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------------------------------------------------

    function _setMandate(AssetConfig[] memory cfg, Limits memory lim) internal {
        uint256 n = cfg.length;
        if (n == 0) revert EmptyMandate();
        if (n > MAX_ASSETS) revert TooManyAssets();
        if (lim.maxSlippageBps > MAX_SLIPPAGE_BPS) revert SlippageCapTooHigh();
        if (lim.maxTradeUsd == 0 || lim.dailyLimitUsd == 0 || lim.maxPriceAge == 0) revert ZeroLimit();

        uint256 old = _tokens.length;
        for (uint256 i; i < old; ++i) {
            delete assets[_tokens[i]];
        }
        delete _tokens;

        uint256 sum = 0;
        for (uint256 i; i < n; ++i) {
            AssetConfig memory c = cfg[i];
            if (c.token == address(0) || c.feed == address(0)) revert ZeroAddress();
            if (assets[c.token].listed) revert DuplicateAsset(c.token);
            if (c.bandBps > BPS / 2) revert BandTooWide(c.token);
            uint8 tokenDecimals = IERC20Metadata(c.token).decimals();
            uint8 feedDecimals = AggregatorV3Interface(c.feed).decimals();
            if (tokenDecimals > 36) revert UnsupportedDecimals(c.token);
            if (feedDecimals > 18) revert UnsupportedDecimals(c.feed);
            assets[c.token] = Asset(c.feed, tokenDecimals, feedDecimals, c.targetBps, c.bandBps, true);
            _tokens.push(c.token);
            sum += c.targetBps;
        }
        if (sum != BPS) revert TargetsMustSumTo100Percent(sum);

        // The budget carries over (capped at the new limit), so re-mandating can't be used to reset it.
        uint256 budget = mandateVersion == 0 ? lim.dailyLimitUsd : _available(limits.dailyLimitUsd);
        budgetUsd = uint128(budget > lim.dailyLimitUsd ? lim.dailyLimitUsd : budget);
        budgetUpdatedAt = uint64(block.timestamp);
        limits = lim;
        emit MandateSet(++mandateVersion, cfg, lim);
    }

    function _available(uint256 cap) internal view returns (uint256) {
        uint256 refilled = uint256(budgetUsd) + (cap * (block.timestamp - budgetUpdatedAt)) / 1 days;
        return refilled > cap ? cap : refilled;
    }

    function _spend(uint256 valueUsd, uint256 dailyLimit) internal {
        uint256 available = _available(dailyLimit);
        if (valueUsd > available) revert DailyLimitExceeded(valueUsd, available);
        budgetUsd = uint128(available - valueUsd);
        budgetUpdatedAt = uint64(block.timestamp);
    }

    function _setFee(address recipient, uint16 bps) internal {
        if (bps > MAX_FEE_BPS) revert FeeTooHigh();
        if (bps != 0 && recipient == address(0)) revert ZeroAddress();
        feeRecipient = recipient;
        feeBps = bps;
        emit FeeSet(recipient, bps);
    }

    /// @dev Pays the fee accrued since `feeAccruedAt` in kind, the same fraction of every listed asset, so weights are
    /// untouched. Nothing accrues while paused.
    function _collectFee() internal {
        uint256 elapsed = block.timestamp - feeAccruedAt;
        feeAccruedAt = uint64(block.timestamp);
        address recipient = feeRecipient;
        if (feeBps == 0 || elapsed == 0 || paused()) return;
        uint256 n = _tokens.length;
        for (uint256 i; i < n; ++i) {
            IERC20 token = IERC20(_tokens[i]);
            // A token that misbehaves (frozen, paused, reverting) is skipped, never allowed to block a withdrawal or a
            // pause: the fee on it for this period is simply forgone.
            try token.balanceOf(address(this)) returns (uint256 balance) {
                uint256 amount = _feeOn(balance, elapsed);
                if (amount != 0 && token.trySafeTransfer(recipient, amount)) emit FeeCollected(recipient, address(token), amount);
            } catch {}
        }
    }

    function _feeOn(uint256 balance, uint256 elapsed) internal view returns (uint256) {
        return Math.mulDiv(balance, uint256(feeBps) * elapsed, BPS * YEAR);
    }

    function _checkCooldown() internal view {
        uint256 last = lastTradeAt;
        if (last != 0 && block.timestamp < last + limits.cooldown) revert CooldownActive(last + limits.cooldown);
    }

    function _checkSizeAndSpend(uint256 valueUsd) internal {
        uint256 maxTrade = limits.maxTradeUsd;
        if (valueUsd > maxTrade) revert TradeTooLarge(valueUsd, maxTrade);
        _spend(valueUsd, limits.dailyLimitUsd);
    }

    /// @dev Fresh prices for every listed asset; returns the two traded legs and the vault's total USD value.
    function _legs(address tokenIn, address tokenOut)
        internal
        view
        returns (Leg memory sell, Leg memory buy, uint256 total)
    {
        uint256 maxAge = limits.maxPriceAge;
        uint256 n = _tokens.length;
        for (uint256 i; i < n; ++i) {
            address token = _tokens[i];
            Asset memory asset = assets[token];
            (uint256 price,) = _price(asset.feed, asset.feedDecimals, maxAge);
            uint256 balance = IERC20(token).balanceOf(address(this));
            uint256 value = _value(balance, price, asset.tokenDecimals);
            total += value;
            if (token == tokenIn || token == tokenOut) {
                Leg memory leg = Leg(token, asset.tokenDecimals, asset.targetBps, asset.bandBps, price, balance, value);
                if (token == tokenIn) sell = leg;
                else buy = leg;
            }
        }
        if (sell.token == address(0)) revert AssetNotInMandate(tokenIn);
        if (buy.token == address(0)) revert AssetNotInMandate(tokenOut);
    }

    /// @dev Trades through the adapter and measures the result from the vault's own balances.
    function _swap(
        address venue,
        Leg memory sell,
        Leg memory buy,
        uint256 amountIn,
        uint256 minAmountOut,
        bytes calldata route
    ) internal returns (uint256 amountOut) {
        IERC20(sell.token).forceApprove(venue, amountIn);
        ISwapAdapter(venue).swap(sell.token, buy.token, amountIn, minAmountOut, address(this), route);
        IERC20(sell.token).forceApprove(venue, 0);

        uint256 spent = sell.balance - IERC20(sell.token).balanceOf(address(this));
        if (spent > amountIn) revert AdapterOverspent(spent, amountIn);
        amountOut = IERC20(buy.token).balanceOf(address(this)) - buy.balance;
        if (amountOut < minAmountOut) revert InsufficientOutput(amountOut, minAmountOut);
    }

    function _checkBands(Leg memory sell, Leg memory buy, uint256 totalBefore) internal view {
        uint256 sellAfter = _value(IERC20(sell.token).balanceOf(address(this)), sell.price, sell.decimals);
        uint256 buyAfter = _value(IERC20(buy.token).balanceOf(address(this)), buy.price, buy.decimals);
        uint256 totalAfter = totalBefore + sellAfter + buyAfter - sell.value - buy.value;
        _checkBand(sell, totalBefore, sellAfter, totalAfter);
        _checkBand(buy, totalBefore, buyAfter, totalAfter);
    }

    /// @dev Price scaled to 18 decimals. `maxAge == 0` skips the freshness check.
    function _price(address feed, uint8 feedDecimals, uint256 maxAge)
        internal
        view
        returns (uint256 price, uint256 updatedAt)
    {
        int256 answer;
        (, answer,, updatedAt,) = AggregatorV3Interface(feed).latestRoundData();
        if (answer <= 0 || updatedAt == 0 || updatedAt > block.timestamp) revert InvalidPrice(feed);
        if (maxAge != 0 && block.timestamp - updatedAt > maxAge) revert StalePrice(feed, updatedAt);
        price = uint256(answer) * 10 ** (18 - feedDecimals);
    }

    function _value(uint256 amount, uint256 price, uint8 tokenDecimals) internal pure returns (uint256) {
        return Math.mulDiv(amount, price, 10 ** tokenDecimals);
    }

    /// @dev Allowed when the asset ends within its band, or when it moved toward its target without crossing it.
    /// So an asset already outside its band can be repaired step by step, but never flipped to the other side.
    function _checkBand(Leg memory leg, uint256 totalBefore, uint256 valueAfter, uint256 totalAfter) internal pure {
        uint256 target = (uint256(leg.targetBps) * WAD) / BPS;
        uint256 band = (uint256(leg.bandBps) * WAD) / BPS;
        uint256 wBefore = totalBefore == 0 ? 0 : Math.mulDiv(leg.value, WAD, totalBefore);
        uint256 wAfter = totalAfter == 0 ? 0 : Math.mulDiv(valueAfter, WAD, totalAfter);
        if (_absDiff(wAfter, target) <= band) return;
        bool towardTarget = wBefore >= target
            ? (wAfter <= wBefore && wAfter >= target)
            : (wAfter >= wBefore && wAfter <= target);
        if (towardTarget) return;
        revert OutsideBand(leg.token, wBefore, wAfter);
    }

    function _absDiff(uint256 x, uint256 y) internal pure returns (uint256) {
        return x > y ? x - y : y - x;
    }
}
