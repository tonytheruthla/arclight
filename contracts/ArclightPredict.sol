// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title ArclightPredict (v0.2)
/// @notice Parimutuel prediction markets on ArclightPump token graduations,
///         settled in native USDC (Arc's gas token).
///
///         The X factor: NO ORACLE. The launchpad itself is the source of
///         truth — a market resolves YES the moment the token's curve phase
///         reads Graduated on-chain, or NO once the deadline passes without
///         graduation. Resolution is permissionless and trustless.
///
///         Parimutuel mechanics: all YES stakes and NO stakes pool together;
///         winners split the entire pot pro-rata (minus a 2% platform fee).
///         Implied odds at any moment = yesPool / (yesPool + noPool).
contract ArclightPredict {
    // ----------------------------- external deps

    IArclightPump public immutable pump;

    // ----------------------------- config

    uint16 public constant FEE_BPS = 200; // 2% of the pot, taken at resolution
    address public owner;
    uint256 public accruedFees;

    // ----------------------------- state

    struct Market {
        address token;      // ArclightPump token this market tracks
        uint64 deadline;    // graduate before this time, or NO wins
        bool resolved;
        bool outcome;       // true = graduated (YES wins)
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

    error NotOwner();
    error TokenNotLive();
    error BadDeadline();
    error MarketClosed();
    error ZeroAmount();
    error NotResolvable();
    error AlreadyResolved();
    error NotResolved();
    error NothingToClaim();
    error TransferFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address pump_) {
        owner = msg.sender;
        pump = IArclightPump(pump_);
    }

    // ----------------------------- create

    /// @notice Open a market on any token still trading on its bonding curve.
    function createMarket(address token, uint64 deadline) external returns (uint256 id) {
        (, , , uint8 phase, , , ) = pump.curves(token);
        if (phase != 1) revert TokenNotLive(); // 1 = Phase.Trading
        if (deadline <= block.timestamp) revert BadDeadline();

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

    /// @notice Stake native USDC on YES (will graduate) or NO (won't in time).
    ///         Betting closes at the deadline or the moment the token graduates.
    function bet(uint256 id, bool onYes) external payable {
        Market storage m = markets[id];
        if (m.resolved || block.timestamp >= m.deadline) revert MarketClosed();
        if (msg.value == 0) revert ZeroAmount();
        (, , , uint8 phase, , , ) = pump.curves(m.token);
        if (phase != 1) revert MarketClosed(); // already graduated -> no late YES bets

        Position storage p = positions[id][msg.sender];
        if (onYes) {
            m.yesPool += msg.value;
            p.yes += msg.value;
        } else {
            m.noPool += msg.value;
            p.no += msg.value;
        }
        emit BetPlaced(id, msg.sender, onYes, msg.value);
    }

    /// @notice Implied YES probability in basis points (0-10000).
    function impliedYesBps(uint256 id) external view returns (uint256) {
        Market storage m = markets[id];
        uint256 total = m.yesPool + m.noPool;
        return total == 0 ? 5000 : (m.yesPool * 10_000) / total;
    }

    // ----------------------------- resolve (permissionless, oracle-free)

    /// @notice Anyone can resolve. YES if the token has graduated on the pump;
    ///         NO if the deadline has passed without graduation.
    function resolve(uint256 id) external {
        Market storage m = markets[id];
        if (m.resolved) revert AlreadyResolved();

        (, , , uint8 phase, , , ) = pump.curves(m.token);
        if (phase == 2) {
            m.outcome = true; // Graduated
        } else if (block.timestamp >= m.deadline) {
            m.outcome = false;
        } else {
            revert NotResolvable();
        }
        m.resolved = true;

        uint256 pot = m.yesPool + m.noPool;
        uint256 winPool = m.outcome ? m.yesPool : m.noPool;
        // Fee only if there are winners to pay; one-sided markets refund instead.
        if (winPool != 0 && winPool != pot) {
            accruedFees += (pot * FEE_BPS) / 10_000;
        }
        emit Resolved(id, m.outcome, pot);
    }

    // ----------------------------- claim

    /// @notice Winners take the pot pro-rata (minus fee). If nobody bet the
    ///         winning side, all stakes are refunded instead.
    function claim(uint256 id) external {
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

        (bool ok, ) = msg.sender.call{value: payout}("");
        if (!ok) revert TransferFailed();
        emit Claimed(id, msg.sender, payout);
    }

    // ----------------------------- admin

    function withdrawFees(address to) external onlyOwner {
        uint256 amount = accruedFees;
        accruedFees = 0;
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit FeesWithdrawn(to, amount);
    }
}

interface IArclightPump {
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
            bool creatorClaimed
        );
}
