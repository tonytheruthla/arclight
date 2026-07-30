// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title ArclightPumpV4
/// @notice Memecoin launchpad for Arc: one-click token deploys, a constant-product
///         bonding curve priced in NATIVE USDC (gas token on Arc, 18 decimals),
///         platform fees, graduation at a USDC raise target, and a creator
///         allocation locked until after graduation.
///
/// @dev v0.4 changes vs v0.3 (gas + data, no economics changed):
///      A. EIP-1167 MINIMAL PROXY CLONES. v0.3 deployed a complete ERC-20 per
///         launch — 555,210 gas measured on Arc testnet. v0.4 deploys the token
///         implementation once and clones it per launch, cutting createToken to
///         roughly a tenth. The implementation is initialised at construction so
///         nobody can claim it, and every clone's initialize() is one-shot.
///      B. `createdAt` is now returned by page(), so a client can show coin age
///         without a second read per token.
///
/// @dev v0.3 changes vs v0.2 (all safety, no economics changed):
///      1. GRADUATION NO LONGER TRAPS FUNDS. v0.2 froze buy/sell at graduation with an
///         empty `migrate()` stub, permanently locking holders and the raised USDC.
///         v0.3 gives the operator a bounded MIGRATION_GRACE window to move liquidity
///         to a DEX. If that window lapses, `redeem()` opens automatically and holders
///         take the reserve back pro-rata. There is no state in which funds are stuck.
///      2. Two-step ownership transfer. v0.2 had no transferOwnership at all, making the
///         deploying EOA the permanent, irrevocable controller of all revenue.
///      3. Fixed treasury. `withdrawFees()` takes no destination argument; fees can only
///         ever route to a pre-declared address.
///      4. Pausable on entry points (create/buy/sell) — never on exits (redeem/claim).
///      5. Reentrancy guards on every path that sends value.
///      6. Reserve solvency invariant: platform fees can never be withdrawn out of
///         user curve reserves.

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

    /// @dev Clones have no constructor, so state is set through initialize().
    ///      `initialized` makes it one-shot: a clone can never be re-initialised,
    ///      and the implementation itself is initialised at factory-construction
    ///      time so it cannot be claimed by anyone.
    bool public initialized;

    error AlreadyInitialized();

    function initialize(string memory name_, string memory symbol_, uint256 supply_, address to_)
        external
    {
        if (initialized) revert AlreadyInitialized();
        initialized = true;
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

contract ArclightPumpV4 {
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

    /// @notice Window after graduation in which the operator may migrate liquidity to a
    ///         DEX. Once it lapses without migration, holder redemption opens and
    ///         migration is permanently blocked for that token. This is the guarantee
    ///         that makes graduation non-custodial: the operator gets a deadline, not
    ///         indefinite control.
    uint256 public constant MIGRATION_GRACE = 7 days;

    // ----------------------------- access control

    address public owner;
    address public pendingOwner;
    address public treasury;
    bool public paused;

    uint256 public accruedFees;
    /// @notice Sum of all USDC owed to curves and graduation redemption pools.
    ///         Platform fees may never be withdrawn out of this.
    uint256 public totalReserves;

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
        // --- v0.3 graduation fields
        bool migrated;        // liquidity moved to DEX; redemption disabled
        uint256 redeemPool;   // USDC available to redeemers (set at graduation)
        uint256 redeemSupply; // tokens still eligible to redeem
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
    event Migrated(address indexed token, address indexed lpVault, uint256 usdc, uint256 tokens);
    event Redeemed(address indexed token, address indexed holder, uint256 tokensIn, uint256 usdcOut);
    event OwnershipTransferStarted(address indexed from, address indexed to);
    event OwnershipTransferred(address indexed from, address indexed to);
    event TreasuryUpdated(address indexed treasury);
    event LpVaultUpdated(address indexed lpVault);
    event PausedSet(bool paused);

    error NotOwner();
    error NotPendingOwner();
    error ZeroAddress();
    error Paused();
    error Reentrancy();
    error WrongFee();
    error NotTrading();
    error NotGraduated();
    error CurveSoldOut();
    error ZeroAmount();
    error StillLocked();
    error AlreadyClaimed();
    error NotCreator();
    error TransferFailed();
    error AlreadyMigrated();
    error MigrationWindowClosed();
    error RedemptionNotOpen();
    error Insolvent();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    uint256 private _lock = 1;
    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    address public lpVault; // destination for migrated liquidity (DEX pool / router)

    /// @notice The ERC-20 implementation every launched token is a clone of.
    address public immutable tokenImplementation;

    error CloneFailed();

    /// @dev Canonical EIP-1167 minimal proxy. 45 bytes of runtime that DELEGATECALLs
    ///      every call to `impl`. This is the single most-deployed contract pattern in
    ///      Ethereum and the bytecode below is verbatim from the EIP — do not modify it.
    function _clone(address impl) internal returns (address instance) {
        assembly {
            let ptr := mload(0x40)
            mstore(ptr, 0x3d602d80600a3d3981f3363d3d373d3d3d363d73000000000000000000000000)
            mstore(add(ptr, 0x14), shl(0x60, impl))
            mstore(add(ptr, 0x28), 0x5af43d82803e903d91602b57fd5bf30000000000000000000000000000000000)
            instance := create(0, ptr, 0x37)
        }
        if (instance == address(0)) revert CloneFailed();
    }

    constructor(uint256 deploymentFee_, uint256 graduationUsdc_, address treasury_) {
        if (treasury_ == address(0)) revert ZeroAddress();
        owner = msg.sender;
        // Deploy the implementation and immediately burn its initializer so the
        // template can never be initialised or hijacked.
        ArclightToken impl = new ArclightToken();
        impl.initialize("Arclight Token Implementation", "ARK-IMPL", 0, address(this));
        tokenImplementation = address(impl);
        treasury = treasury_;
        deploymentFee = deploymentFee_;
        graduationUsdc = graduationUsdc_;
        emit OwnershipTransferred(address(0), msg.sender);
        emit TreasuryUpdated(treasury_);
    }

    // ----------------------------- create

    /// @notice One-click memecoin deploy. Pay the flat deployment fee in native USDC.
    function createToken(string calldata name_, string calldata symbol_)
        external
        payable
        whenNotPaused
        returns (address token)
    {
        if (msg.value != deploymentFee) revert WrongFee();
        accruedFees += msg.value;

        token = _clone(tokenImplementation);
        ArclightToken(token).initialize(name_, symbol_, TOTAL_SUPPLY, address(this));
        Curve storage c = curves[token];
        c.creator = msg.sender;
        c.createdAt = uint64(block.timestamp);
        c.phase = Phase.Trading;

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
    function buy(address token, uint256 minTokensOut)
        external
        payable
        whenNotPaused
        nonReentrant
        returns (uint256 tokensOut)
    {
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
        totalReserves += usdcIn;

        ArclightToken(token).transfer(msg.sender, tokensOut);
        emit Bought(token, msg.sender, usdcIn, tokensOut);

        if (c.realUsdc >= graduationUsdc) _graduate(token, c);
    }

    /// @notice Sell back to the curve for native USDC. 1% fee.
    function sell(address token, uint256 tokensIn, uint256 minUsdcOut)
        external
        whenNotPaused
        nonReentrant
        returns (uint256 usdcOut)
    {
        Curve storage c = curves[token];
        if (c.phase != Phase.Trading) revert NotTrading();
        if (tokensIn == 0) revert ZeroAmount();

        usdcOut = quoteSell(token, tokensIn);
        uint256 fee = (usdcOut * TRADE_FEE_BPS) / 10_000;
        usdcOut -= fee;
        accruedFees += fee;
        require(usdcOut >= minUsdcOut, "slippage");

        uint256 gross = usdcOut + fee;
        c.soldTokens -= tokensIn;
        c.realUsdc -= gross;
        totalReserves -= gross;

        ArclightToken(token).transferFrom(msg.sender, address(this), tokensIn);
        _send(msg.sender, usdcOut);
        emit Sold(token, msg.sender, tokensIn, usdcOut);
    }

    // ----------------------------- graduation

    function _graduate(address token, Curve storage c) internal {
        c.phase = Phase.Graduated;
        c.graduatedAt = uint64(block.timestamp);
        // Freeze the reserve and the outstanding float. These two numbers define the
        // redemption rate if migration never happens.
        c.redeemPool = c.realUsdc;
        c.redeemSupply = c.soldTokens;
        emit Graduated(token, c.realUsdc, c.graduatedAt);
    }

    /// @notice Move a graduated token's liquidity to the DEX vault and burn the LP there.
    /// @dev Only callable inside MIGRATION_GRACE. Once that window closes, redemption
    ///      opens instead and migration is permanently blocked — the operator cannot
    ///      reach in and take a reserve that holders have already become entitled to.
    function migrate(address token) external onlyOwner nonReentrant {
        Curve storage c = curves[token];
        if (c.phase != Phase.Graduated) revert NotGraduated();
        if (c.migrated) revert AlreadyMigrated();
        if (block.timestamp >= c.graduatedAt + MIGRATION_GRACE) revert MigrationWindowClosed();
        if (lpVault == address(0)) revert ZeroAddress();

        uint256 usdc = c.redeemPool;
        c.migrated = true;
        c.redeemPool = 0;
        c.redeemSupply = 0;
        totalReserves -= usdc;

        ArclightToken(token).transfer(lpVault, LP_RESERVE);
        _send(lpVault, usdc);
        emit Migrated(token, lpVault, usdc, LP_RESERVE);
    }

    /// @notice If a graduated token was never migrated within MIGRATION_GRACE, holders
    ///         redeem their tokens pro-rata against the frozen reserve. This is the
    ///         escape hatch that guarantees graduation can never strand funds.
    /// @dev    Deliberately NOT pausable. Exits must always work.
    function redeem(address token, uint256 tokensIn) external nonReentrant returns (uint256 usdcOut) {
        Curve storage c = curves[token];
        if (c.phase != Phase.Graduated) revert NotGraduated();
        if (c.migrated) revert AlreadyMigrated();
        if (block.timestamp < c.graduatedAt + MIGRATION_GRACE) revert RedemptionNotOpen();
        if (tokensIn == 0) revert ZeroAmount();
        if (tokensIn > c.redeemSupply) revert ZeroAmount();

        usdcOut = (c.redeemPool * tokensIn) / c.redeemSupply;
        c.redeemPool -= usdcOut;
        c.redeemSupply -= tokensIn;
        totalReserves -= usdcOut;

        ArclightToken(token).transferFrom(msg.sender, address(this), tokensIn);
        _send(msg.sender, usdcOut);
        emit Redeemed(token, msg.sender, tokensIn, usdcOut);
    }

    /// @notice True once holders of a graduated, unmigrated token may redeem.
    function redemptionOpen(address token) external view returns (bool) {
        Curve storage c = curves[token];
        return c.phase == Phase.Graduated
            && !c.migrated
            && block.timestamp >= c.graduatedAt + MIGRATION_GRACE;
    }

    /// @notice Creator claims their 1% allocation, only after graduation + lock.
    ///         Anti-dump: no creator tokens circulate while the curve is live.
    /// @dev    Not pausable — this is an exit.
    function claimCreatorAllocation(address token) external nonReentrant {
        Curve storage c = curves[token];
        if (msg.sender != c.creator) revert NotCreator();
        if (c.phase != Phase.Graduated || block.timestamp < c.graduatedAt + CREATOR_LOCK) revert StillLocked();
        if (c.creatorClaimed) revert AlreadyClaimed();
        c.creatorClaimed = true;
        ArclightToken(token).transfer(c.creator, CREATOR_ALLOC);
        emit CreatorClaimed(token, c.creator, CREATOR_ALLOC);
    }

    // ----------------------------- admin

    /// @notice Withdraw accrued platform fees to the fixed treasury.
    /// @dev No destination argument by design. The solvency check makes it impossible
    ///      to withdraw fees out of user curve reserves even if fee accounting drifts.
    function withdrawFees() external onlyOwner nonReentrant {
        uint256 amount = accruedFees;
        if (amount == 0) revert ZeroAmount();
        accruedFees = 0;
        if (address(this).balance - amount < totalReserves) revert Insolvent();
        _send(treasury, amount);
        emit FeesWithdrawn(treasury, amount);
    }

    function setTreasury(address t) external onlyOwner {
        if (t == address(0)) revert ZeroAddress();
        treasury = t;
        emit TreasuryUpdated(t);
    }

    function setLpVault(address v) external onlyOwner {
        if (v == address(0)) revert ZeroAddress();
        lpVault = v;
        emit LpVaultUpdated(v);
    }

    function setPaused(bool p) external onlyOwner {
        paused = p;
        emit PausedSet(p);
    }

    /// @notice Step 1 of ownership transfer. The new owner must call acceptOwnership.
    ///         Two-step prevents handing control to a typo'd or uncontrolled address.
    function transferOwnership(address to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        pendingOwner = to;
        emit OwnershipTransferStarted(owner, to);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        address prev = owner;
        owner = pendingOwner;
        pendingOwner = address(0);
        emit OwnershipTransferred(prev, owner);
    }

    // ----------------------------- views / internal

    function tokenCount() external view returns (uint256) {
        return allTokens.length;
    }

    /// @notice Paginated curve read. Replaces the dapp's per-token N+1 RPC loop:
    ///         one call returns a whole page instead of one call per token.
    function page(uint256 offset, uint256 limit)
        external
        view
        returns (
            address[] memory tokens,
            uint8[] memory phases,
            uint256[] memory sold,
            uint256[] memory raised,
            address[] memory creators,
            uint64[] memory createdAt
        )
    {
        uint256 n = allTokens.length;
        if (offset >= n) {
            return (new address[](0), new uint8[](0), new uint256[](0),
                    new uint256[](0), new address[](0), new uint64[](0));
        }
        uint256 end = offset + limit;
        if (end > n) end = n;
        uint256 len = end - offset;

        tokens = new address[](len);
        phases = new uint8[](len);
        sold = new uint256[](len);
        raised = new uint256[](len);
        creators = new address[](len);
        createdAt = new uint64[](len);

        for (uint256 i = 0; i < len; i++) {
            address t = allTokens[offset + i];
            Curve storage c = curves[t];
            tokens[i] = t;
            phases[i] = uint8(c.phase);
            sold[i] = c.soldTokens;
            raised[i] = c.realUsdc;
            creators[i] = c.creator;
            createdAt[i] = c.createdAt;
        }
    }

    function _send(address to, uint256 amount) internal {
        if (amount == 0) return;
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
