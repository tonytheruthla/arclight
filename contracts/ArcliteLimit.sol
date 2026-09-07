// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/**
 * ArcliteLimit — limit orders on the Arclite bonding curve.
 *
 *   BUY limit:  escrow USDC now, get filled at an AVERAGE price ≤ your limit, or not at all.
 *   SELL limit: escrow tokens now, get filled at an AVERAGE price ≥ your limit, or not at all.
 *
 * No oracle, no price feed, no trust in the executor. The guarantee comes from
 * the pump's own slippage check: execute() computes the minimum output your
 * limit implies and passes it as the pump's minOut. If the curve can't deliver
 * that, the pump reverts and nothing moves. The executor can only ever fill you
 * at your limit or better.
 *
 * Execution is permissionless. Whoever calls execute() on a fillable order is
 * paid TIP_BPS of the order's USDC for the gas and the bother — we run a keeper,
 * but anyone can (and should, if we're slow). Orders expire; after expiry anyone
 * can cancel to return the escrow to its owner. The owner can cancel any time.
 *
 * Price is quoted like the pump's spotPrice(): USDC wei per whole token (1e18).
 * Native USDC on Arc is 18dp.
 */
interface IPump {
    function buy(address token, uint256 minTokensOut) external payable returns (uint256 tokensOut);
    function sell(address token, uint256 tokensIn, uint256 minUsdcOut) external returns (uint256 usdcOut);
}
interface IERC20 {
    function transfer(address to, uint256 v) external returns (bool);
    function transferFrom(address from, address to, uint256 v) external returns (bool);
    function approve(address spender, uint256 v) external returns (bool);
    function balanceOf(address a) external view returns (uint256);
}

contract ArcliteLimit {
    uint16  public constant TIP_BPS = 30;          // 0.3% of the order's USDC to the executor
    uint256 public constant MIN_ORDER = 1e18;      // $1 minimum, so a tip is never dust
    uint256 public constant MAX_TTL = 30 days;

    IPump public immutable pump;

    struct Order {
        address owner;
        address token;
        bool    isBuy;
        uint128 amountIn;      // USDC wei (buy) or tokens (sell)
        uint128 limitPrice;    // USDC wei per whole token
        uint64  expiry;
        uint8   status;        // 0 open, 1 filled, 2 cancelled
    }
    Order[] public orders;
    mapping(address => uint256[]) private _byOwner;

    event Placed(uint256 indexed id, address indexed owner, address indexed token, bool isBuy, uint256 amountIn, uint256 limitPrice, uint64 expiry);
    event Filled(uint256 indexed id, address indexed executor, uint256 amountIn, uint256 amountOut, uint256 tip);
    event Cancelled(uint256 indexed id, address indexed by);

    error BadPrice(); error BadAmount(); error BadExpiry(); error NotOpen(); error NotOwner(); error NotExpired();
    error TransferFailed(); error Reentrancy();

    uint256 private _lock = 1;
    modifier nonReentrant() { if (_lock != 1) revert Reentrancy(); _lock = 2; _; _lock = 1; }

    constructor(address pump_) { pump = IPump(pump_); }

    // ----------------------------- place
    /// @notice Escrow msg.value USDC; fill when the curve can sell at ≤ limitPrice on average.
    function placeBuy(address token, uint256 limitPrice, uint64 expiry) external payable returns (uint256 id) {
        if (msg.value < MIN_ORDER) revert BadAmount();
        if (limitPrice == 0) revert BadPrice();
        _checkExpiry(expiry);
        id = _push(token, true, msg.value, limitPrice, expiry);
    }

    /// @notice Escrow `tokensIn` (approve this contract first); fill when the curve pays ≥ limitPrice on average.
    function placeSell(address token, uint256 tokensIn, uint256 limitPrice, uint64 expiry) external returns (uint256 id) {
        if (tokensIn == 0) revert BadAmount();
        if (limitPrice == 0) revert BadPrice();
        // the USDC this would return at the limit must clear MIN_ORDER, or the tip could be dust
        if ((tokensIn * limitPrice) / 1e18 < MIN_ORDER) revert BadAmount();
        _checkExpiry(expiry);
        if (!IERC20(token).transferFrom(msg.sender, address(this), tokensIn)) revert TransferFailed();
        id = _push(token, false, tokensIn, limitPrice, expiry);
    }

    function _checkExpiry(uint64 expiry) internal view {
        if (expiry <= block.timestamp || expiry > block.timestamp + MAX_TTL) revert BadExpiry();
    }
    function _push(address token, bool isBuy, uint256 amountIn, uint256 limitPrice, uint64 expiry) internal returns (uint256 id) {
        id = orders.length;
        orders.push(Order(msg.sender, token, isBuy, uint128(amountIn), uint128(limitPrice), expiry, 0));
        _byOwner[msg.sender].push(id);
        emit Placed(id, msg.sender, token, isBuy, amountIn, limitPrice, expiry);
    }

    // ----------------------------- execute (anyone)
    /// @notice Fill an open order if the curve honours its limit. Reverts otherwise — never a partial or worse fill.
    function execute(uint256 id) external nonReentrant returns (uint256 amountOut) {
        Order storage o = orders[id];
        if (o.status != 0) revert NotOpen();
        if (block.timestamp > o.expiry) revert NotExpired(); // expired: cancel instead
        o.status = 1;
        uint256 tip;
        if (o.isBuy) {
            tip = (uint256(o.amountIn) * TIP_BPS) / 10_000;
            uint256 spend = o.amountIn - tip;
            // avg price ≤ limit  ⇔  tokensOut ≥ spend / limit
            uint256 minOut = (spend * 1e18) / o.limitPrice;
            amountOut = pump.buy{value: spend}(o.token, minOut);       // pump reverts on slippage → whole tx reverts
            if (!IERC20(o.token).transfer(o.owner, amountOut)) revert TransferFailed();
        } else {
            // avg price ≥ limit  ⇔  usdcOut ≥ tokensIn × limit
            uint256 minOut = (uint256(o.amountIn) * o.limitPrice) / 1e18;
            IERC20(o.token).approve(address(pump), o.amountIn);
            amountOut = pump.sell(o.token, o.amountIn, minOut);         // USDC lands here via receive()
            tip = (amountOut * TIP_BPS) / 10_000;
            _send(o.owner, amountOut - tip);
        }
        _send(msg.sender, tip);
        emit Filled(id, msg.sender, o.amountIn, amountOut, tip);
    }

    // ----------------------------- cancel
    /// @notice Owner: any time. Anyone: after expiry (returns the escrow to the owner).
    function cancel(uint256 id) external nonReentrant {
        Order storage o = orders[id];
        if (o.status != 0) revert NotOpen();
        if (msg.sender != o.owner && block.timestamp <= o.expiry) revert NotOwner();
        o.status = 2;
        if (o.isBuy) _send(o.owner, o.amountIn);
        else if (!IERC20(o.token).transfer(o.owner, o.amountIn)) revert TransferFailed();
        emit Cancelled(id, msg.sender);
    }

    // ----------------------------- views
    function count() external view returns (uint256) { return orders.length; }
    function ordersOf(address owner) external view returns (uint256[] memory) { return _byOwner[owner]; }
    /// @notice Batched read for the UI/keeper: every order in [from, from+n).
    function page(uint256 from, uint256 n) external view returns (Order[] memory out) {
        uint256 end = from + n; if (end > orders.length) end = orders.length;
        out = new Order[](end > from ? end - from : 0);
        for (uint256 i = from; i < end; i++) out[i - from] = orders[i];
    }

    function _send(address to, uint256 amt) internal {
        if (amt == 0) return;
        (bool ok, ) = to.call{value: amt}("");
        if (!ok) revert TransferFailed();
    }
    receive() external payable {}   // the pump pays sells here
}
