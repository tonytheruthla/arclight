// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title ArclitePredictV4
/// @notice Parimutuel prediction markets on ArclitePump token graduations,
///         settled in native USDC (Arc's gas token).
///
///         The X factor: NO ORACLE. The launchpad itself is the source of truth —
///         a market resolves YES if the token's curve graduated on-chain before the
///         deadline, or NO once the deadline passes without graduation. Resolution
///         is permissionless and trustless.
///
/// @dev v0.4 is v0.3 logic, renamed for the Arclite brand. NO functional change.
///      The v0.3 contracts stay live on testnet under their original names.
///
/// @dev v0.3 changes vs v0.2:
///      1. RESOLUTION CORRECTNESS FIX. v0.2 resolved YES whenever the token read
///         `Graduated`, regardless of *when* it graduated. A token that graduated a
///         month after a 7-day market's deadline still paid YES — the market question
///         ("will X graduate within 7 days?") was not actually what settled. v0.3
///         compares `graduatedAt` against the deadline.
///      2. Two-step ownership transfer (v0.2 had none at all).
///      3. Fixed treasury; `withdrawFees()` takes no destination.
///      4. Pausable on createMarket/bet — never on resolve/claim.
///      5. Reentrancy guards on all value-sending paths.
///      6. Fee solvency invariant so platform fees can never eat unclaimed stakes.
///      7. Paginated market reads to kill the frontend's N+1 RPC loop.
contract ArclitePredictV4 {
    // ----------------------------- external deps

    IArclitePumpV4 public immutable pump;

    // ----------------------------- config

    uint16 public constant FEE_BPS = 200; // 2% of the pot, taken at resolution
    uint64 public constant MIN_DURATION = 1 hours;
    uint64 public constant MAX_DURATION = 90 days;

    address public owner;
    address public pendingOwner;
    address public treasury;
    bool public paused;

    uint256 public accruedFees;
    /// @notice Total staked USDC still owed to bettors. Fees may never dip into this.
    uint256 public totalStaked;

    // ----------------------------- state

    struct Market {
        address token;      // ArclitePump token this market tracks
        uint64 deadline;    // graduate before this time, or NO wins
        bool resolved;
        bool outcome;       // true = graduated in time (YES wins)
        uint256 yesPool;
        uint256 noPool;
    }

    struct Position {
        uint256 yes;
        uint256 no;
        bool claimed;
    }

    uint256 public marketCount;
    mapping(uint256 => Market) public markets;
    mapping(uint256 => mapping(address => Position)) public positions;

    // ----------------------------- events / errors

    event MarketCreated(uint256 indexed id, address indexed token, uint64 deadline);
    event BetPlaced(uint256 indexed id, address indexed bettor, bool side, uint256 amount);
    event Resolved(uint256 indexed id, bool outcome, uint256 pot);
    event Claimed(uint256 indexed id, address indexed bettor, uint256 payout);
    event FeesWithdrawn(address indexed to, uint256 amount);
    event OwnershipTransferStarted(address indexed from, address indexed to);
    event OwnershipTransferred(address indexed from, address indexed to);
    event TreasuryUpdated(address indexed treasury);
    event PausedSet(bool paused);

    error NotOwner();
    error NotPendingOwner();
    error ZeroAddress();
    error Paused();
    error Reentrancy();
    error TokenNotLive();
    error BadDeadline();
    error MarketClosed();
    error ZeroAmount();
    error NotResolvable();
    error AlreadyResolved();
    error NotResolved();
    error NothingToClaim();
    error TransferFailed();
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

    constructor(address pump_, address treasury_) {
        if (pump_ == address(0) || treasury_ == address(0)) revert ZeroAddress();
        owner = msg.sender;
        treasury = treasury_;
        pump = IArclitePumpV4(pump_);
        emit OwnershipTransferred(address(0), msg.sender);
        emit TreasuryUpdated(treasury_);
    }

    // ----------------------------- create

    /// @notice Open a market on any token still trading on its bonding curve.
    function createMarket(address token, uint64 deadline)
        external
        whenNotPaused
        returns (uint256 id)
    {
        (, , , uint8 phase, , , , , , ) = pump.curves(token);
        if (phase != 1) revert TokenNotLive(); // 1 = Phase.Trading
        if (deadline < block.timestamp + MIN_DURATION) revert BadDeadline();
        if (deadline > block.timestamp + MAX_DURATION) revert BadDeadline();

        id = ++marketCount;
        markets[id] = Market({
            token: token,
            deadline: deadline,
            resolved: false,
            outcome: false,
            yesPool: 0,
            noPool: 0
        });
        emit MarketCreated(id, token, deadline);
    }

    // ----------------------------- bet

    /// @notice Stake native USDC on YES (will graduate in time) or NO.
    ///         Betting closes at the deadline or the moment the token graduates.
    function bet(uint256 id, bool onYes) external payable whenNotPaused nonReentrant {
        Market storage m = markets[id];
        if (m.token == address(0)) revert MarketClosed();
        if (m.resolved || block.timestamp >= m.deadline) revert MarketClosed();
        if (msg.value == 0) revert ZeroAmount();
        (, , , uint8 phase, , , , , , ) = pump.curves(m.token);
        if (phase != 1) revert MarketClosed(); // already graduated -> no late YES bets

        Position storage p = positions[id][msg.sender];
        if (onYes) {
            m.yesPool += msg.value;
            p.yes += msg.value;
        } else {
            m.noPool += msg.value;
            p.no += msg.value;
        }
        totalStaked += msg.value;
        emit BetPlaced(id, msg.sender, onYes, msg.value);
    }

    /// @notice Implied YES probability in basis points (0-10000).
    function impliedYesBps(uint256 id) external view returns (uint256) {
        Market storage m = markets[id];
        uint256 total = m.yesPool + m.noPool;
        return total == 0 ? 5000 : (m.yesPool * 10_000) / total;
    }

    // ----------------------------- resolve (permissionless, oracle-free)

    /// @notice Anyone can resolve. YES if the token graduated *at or before* the
    ///         deadline; NO once the deadline has passed without that happening.
    /// @dev    Not pausable — settlement must always be possible.
    function resolve(uint256 id) external {
        Market storage m = markets[id];
        if (m.token == address(0)) revert NotResolvable();
        if (m.resolved) revert AlreadyResolved();

        (, , uint64 graduatedAt, uint8 phase, , , , , , ) = pump.curves(m.token);

        if (phase == 2 && graduatedAt <= m.deadline) {
            // Graduated, and it happened in time.
            m.outcome = true;
        } else if (block.timestamp >= m.deadline) {
            // Deadline passed. Either never graduated, or graduated too late.
            m.outcome = false;
        } else {
            revert NotResolvable();
        }
        m.resolved = true;

        uint256 pot = m.yesPool + m.noPool;
        uint256 winPool = m.outcome ? m.yesPool : m.noPool;
        // Fee only if there are winners to pay; one-sided markets refund instead.
        if (winPool != 0 && winPool != pot) {
            uint256 fee = (pot * FEE_BPS) / 10_000;
            accruedFees += fee;
            totalStaked -= fee;
        }
        emit Resolved(id, m.outcome, pot);
    }

    // ----------------------------- claim

    /// @notice Winners take the pot pro-rata (minus fee). If nobody bet the
    ///         winning side, all stakes are refunded instead.
    /// @dev    Not pausable — this is an exit.
    function claim(uint256 id) external nonReentrant {
        Market storage m = markets[id];
        if (!m.resolved) revert NotResolved();
        Position storage p = positions[id][msg.sender];
        if (p.claimed) revert NothingToClaim();
        p.claimed = true;

        uint256 pot = m.yesPool + m.noPool;
        uint256 winPool = m.outcome ? m.yesPool : m.noPool;
        uint256 stake = m.outcome ? p.yes : p.no;

        uint256 payout;
        if (winPool == 0 || winPool == pot) {
            // one-sided market: full refund of whatever was staked
            payout = p.yes + p.no;
        } else {
            if (stake == 0) revert NothingToClaim();
            uint256 potAfterFee = pot - (pot * FEE_BPS) / 10_000;
            payout = (potAfterFee * stake) / winPool;
        }
        if (payout == 0) revert NothingToClaim();

        totalStaked -= payout;
        _send(msg.sender, payout);
        emit Claimed(id, msg.sender, payout);
    }

    // ----------------------------- admin

    function withdrawFees() external onlyOwner nonReentrant {
        uint256 amount = accruedFees;
        if (amount == 0) revert ZeroAmount();
        accruedFees = 0;
        if (address(this).balance - amount < totalStaked) revert Insolvent();
        _send(treasury, amount);
        emit FeesWithdrawn(treasury, amount);
    }

    function setTreasury(address t) external onlyOwner {
        if (t == address(0)) revert ZeroAddress();
        treasury = t;
        emit TreasuryUpdated(t);
    }

    function setPaused(bool p) external onlyOwner {
        paused = p;
        emit PausedSet(p);
    }

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

    // ----------------------------- views

    /// @notice True when resolve(id) would succeed right now. Lets a keeper find
    ///         work in one call instead of trial-and-error transactions.
    function resolvable(uint256 id) external view returns (bool) {
        Market storage m = markets[id];
        if (m.token == address(0) || m.resolved) return false;
        (, , uint64 graduatedAt, uint8 phase, , , , , , ) = pump.curves(m.token);
        if (phase == 2 && graduatedAt <= m.deadline) return true;
        return block.timestamp >= m.deadline;
    }

    /// @notice Paginated market read — replaces per-market RPC round-trips.
    function page(uint256 offset, uint256 limit)
        external
        view
        returns (
            uint256[] memory ids,
            address[] memory tokens,
            uint64[] memory deadlines,
            bool[] memory resolvedFlags,
            bool[] memory outcomes,
            uint256[] memory yesPools,
            uint256[] memory noPools
        )
    {
        uint256 n = marketCount;
        if (offset >= n) {
            return (
                new uint256[](0), new address[](0), new uint64[](0),
                new bool[](0), new bool[](0), new uint256[](0), new uint256[](0)
            );
        }
        uint256 end = offset + limit;
        if (end > n) end = n;
        uint256 len = end - offset;

        ids = new uint256[](len);
        tokens = new address[](len);
        deadlines = new uint64[](len);
        resolvedFlags = new bool[](len);
        outcomes = new bool[](len);
        yesPools = new uint256[](len);
        noPools = new uint256[](len);

        for (uint256 i = 0; i < len; i++) {
            uint256 id = offset + i + 1; // markets are 1-indexed
            Market storage m = markets[id];
            ids[i] = id;
            tokens[i] = m.token;
            deadlines[i] = m.deadline;
            resolvedFlags[i] = m.resolved;
            outcomes[i] = m.outcome;
            yesPools[i] = m.yesPool;
            noPools[i] = m.noPool;
        }
    }

    function _send(address to, uint256 amount) internal {
        if (amount == 0) return;
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}

interface IArclitePumpV4 {
    function curves(address token)
        external
        view
        returns (
            address creator,
            uint64 createdAt,
            uint64 graduatedAt,
            uint8 phase,
            uint256 soldTokens,
            uint256 realUsdc,
            bool creatorClaimed,
            bool migrated,
            uint256 redeemPool,
            uint256 redeemSupply
        );
}
