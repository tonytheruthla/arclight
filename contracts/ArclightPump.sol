// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title ArclightPump (v0.2 skeleton)
/// @notice Memecoin launchpad for Arc: one-click token deploys, a constant-product
///         bonding curve priced in NATIVE USDC (gas token on Arc, 18 decimals),
///         platform fees, graduation at a USDC raise target, and a creator
///         allocation that stays locked until after graduation.
/// @dev    v0.2 scope. Deliberately deferred to v0.3+:
///         - sealed-bid fair-launch window (Arc privacy primitives)
///         - DEX liquidity migration at graduation (stubbed via `migrate`)
///         - holder fee-share streaming and graduation betting markets

// ---------------------------------------------------------------------------
//                                token
// ---------------------------------------------------------------------------

contract ArclightToken {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory name_, string memory symbol_, uint256 supply_, address to_) {
        name = name_;
        symbol = symbol_;
        totalSupply = supply_;
        balanceOf[to_] = supply_;
        emit Transfer(address(0), to_, supply_);
    }

    function transfer(address to, uint256 value) external returns (bool) {
        return _transfer(msg.sender, to, value);
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        require(a >= value, "allowance");
        if (a != type(uint256).max) allowance[from][msg.sender] = a - value;
        return _transfer(from, to, value);
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function _transfer(address from, address to, uint256 value) internal returns (bool) {
        require(balanceOf[from] >= value, "balance");
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
        return true;
    }
}

// ---------------------------------------------------------------------------
//                               launchpad
// ---------------------------------------------------------------------------

contract ArclightPump {
    // ----------------------------- config

    uint256 public constant TOTAL_SUPPLY = 1_000_000_000e18; // 1B per token
    uint256 public constant CURVE_SUPPLY = 800_000_000e18;   // sold on the curve
    uint256 public constant LP_RESERVE = 190_000_000e18;     // for DEX at graduation
    uint256 public constant CREATOR_ALLOC = 10_000_000e18;   // 1%, locked
    uint256 public constant VIRTUAL_USDC = 3_000e18;         // curve seed (virtual)
    uint256 public constant VIRTUAL_TOKENS = 1_080_000_000e18;

    uint256 public immutable deploymentFee;   // flat, native USDC
    uint256 public immutable graduationUsdc;  // real USDC raised to graduate
    uint16 public constant TRADE_FEE_BPS = 100; // 1%
    uint256 public constant CREATOR_LOCK = 30 days;

    address public owner;
    uint256 public accruedFees;

    // ----------------------------- state

    enum Phase { None, Trading, Graduated }

    struct Curve {
        address creator;
        uint64 createdAt;
        uint64 graduatedAt;
        Phase phase;
        uint256 soldTokens;   // real tokens sold from curve
        uint256 realUsdc;     // real USDC held by curve (net of fees)
        bool creatorClaimed;
    }

    mapping(address => Curve) public curves; // token => curve
    address[] public allTokens;

    // ----------------------------- events / errors

    event TokenCreated(address indexed token, address indexed creator, string name, string symbol);
    event Bought(address indexed token, address indexed buyer, uint256 usdcIn, uint256 tokensOut);
    event Sold(address indexed token, address indexed seller, uint256 tokensIn, uint256 usdcOut);
    event Graduated(address indexed token, uint256 raisedUsdc, uint64 at);
    event CreatorClaimed(address indexed token, address indexed creator, uint256 amount);
    event FeesWithdrawn(address indexed to, uint256 amount);

    error NotOwner();
    error WrongFee();
    error NotTrading();
    error CurveSoldOut();
    error ZeroAmount();
    error StillLocked();
    error AlreadyClaimed();
    error NotCreator();
    error TransferFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(uint256 deploymentFee_, uint256 graduationUsdc_) {
        owner = msg.sender;
        deploymentFee = deploymentFee_;
        graduationUsdc = graduationUsdc_;
    }

    // ----------------------------- create

    /// @notice One-click memecoin deploy. Pay the flat deployment fee in native USDC.
    function createToken(string calldata name_, string calldata symbol_)
        external
        payable
        returns (address token)
    {
        if (msg.value != deploymentFee) revert WrongFee();
        accruedFees += msg.value;

        token = address(new ArclightToken(name_, symbol_, TOTAL_SUPPLY, address(this)));
        curves[token] = Curve({
            creator: msg.sender,
            createdAt: uint64(block.timestamp),
            graduatedAt: 0,
            phase: Phase.Trading,
            soldTokens: 0,
            realUsdc: 0,
            creatorClaimed: false
        });
        allTokens.push(token);
        emit TokenCreated(token, msg.sender, name_, symbol_);
    }

    // ----------------------------- curve math

    /// @dev Constant product over virtual reserves:
    ///      usdcReserve = VIRTUAL_USDC + realUsdc, tokenReserve = VIRTUAL_TOKENS - soldTokens
    function quoteBuy(address token, uint256 usdcIn) public view returns (uint256 tokensOut) {
        Curve storage c = curves[token];
        uint256 uR = VIRTUAL_USDC + c.realUsdc;
        uint256 tR = VIRTUAL_TOKENS - c.soldTokens;
        tokensOut = tR - (uR * tR) / (uR + usdcIn);
    }

    function quoteSell(address token, uint256 tokensIn) public view returns (uint256 usdcOut) {
        Curve storage c = curves[token];
        uint256 uR = VIRTUAL_USDC + c.realUsdc;
        uint256 tR = VIRTUAL_TOKENS - c.soldTokens;
        usdcOut = uR - (uR * tR) / (tR + tokensIn);
    }

    /// @notice Spot price in USDC wei per whole token (1e18 units).
    function spotPrice(address token) external view returns (uint256) {
        Curve storage c = curves[token];
        return ((VIRTUAL_USDC + c.realUsdc) * 1e18) / (VIRTUAL_TOKENS - c.soldTokens);
    }

    // ----------------------------- trade

    /// @notice Buy on the curve with native USDC. 1% fee. Priced in real dollars.
    function buy(address token, uint256 minTokensOut) external payable returns (uint256 tokensOut) {
        Curve storage c = curves[token];
        if (c.phase != Phase.Trading) revert NotTrading();
        if (msg.value == 0) revert ZeroAmount();

        uint256 fee = (msg.value * TRADE_FEE_BPS) / 10_000;
        uint256 usdcIn = msg.value - fee;
        accruedFees += fee;

        tokensOut = quoteBuy(token, usdcIn);
        if (tokensOut > CURVE_SUPPLY - c.soldTokens) revert CurveSoldOut();
        require(tokensOut >= minTokensOut, "slippage");

        c.soldTokens += tokensOut;
        c.realUsdc += usdcIn;
        ArclightToken(token).transfer(msg.sender, tokensOut);
        emit Bought(token, msg.sender, usdcIn, tokensOut);

        if (c.realUsdc >= graduationUsdc) _graduate(token, c);
    }

    /// @notice Sell back to the curve for native USDC. 1% fee.
    function sell(address token, uint256 tokensIn, uint256 minUsdcOut) external returns (uint256 usdcOut) {
        Curve storage c = curves[token];
        if (c.phase != Phase.Trading) revert NotTrading();
        if (tokensIn == 0) revert ZeroAmount();

        usdcOut = quoteSell(token, tokensIn);
        uint256 fee = (usdcOut * TRADE_FEE_BPS) / 10_000;
        usdcOut -= fee;
        accruedFees += fee;
        require(usdcOut >= minUsdcOut, "slippage");

        c.soldTokens -= tokensIn;
        c.realUsdc -= (usdcOut + fee);
        ArclightToken(token).transferFrom(msg.sender, address(this), tokensIn);
        (bool ok, ) = msg.sender.call{value: usdcOut}("");
        if (!ok) revert TransferFailed();
        emit Sold(token, msg.sender, tokensIn, usdcOut);
    }

    // ----------------------------- graduation

    function _graduate(address token, Curve storage c) internal {
        c.phase = Phase.Graduated;
        c.graduatedAt = uint64(block.timestamp);
        emit Graduated(token, c.realUsdc, c.graduatedAt);
        // v0.3: migrate LP_RESERVE tokens + realUsdc into a DEX pool and burn LP.
    }

    /// @notice Creator claims their 1% allocation, only after graduation + lock.
    ///         Anti-dump: no creator tokens circulate while the curve is live.
    function claimCreatorAllocation(address token) external {
        Curve storage c = curves[token];
        if (msg.sender != c.creator) revert NotCreator();
        if (c.phase != Phase.Graduated || block.timestamp < c.graduatedAt + CREATOR_LOCK) revert StillLocked();
        if (c.creatorClaimed) revert AlreadyClaimed();
        c.creatorClaimed = true;
        ArclightToken(token).transfer(c.creator, CREATOR_ALLOC);
        emit CreatorClaimed(token, c.creator, CREATOR_ALLOC);
    }

    /// @dev v0.3 stub: DEX migration hook for graduated tokens.
    function migrate(address token) external onlyOwner {
        // intentionally empty in v0.2
    }

    // ----------------------------- admin / views

    function withdrawFees(address to) external onlyOwner {
        uint256 amount = accruedFees;
        accruedFees = 0;
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit FeesWithdrawn(to, amount);
    }

    function tokenCount() external view returns (uint256) {
        return allTokens.length;
    }
}
