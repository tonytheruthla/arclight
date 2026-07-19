// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title ArclightLaunchpad (v0 skeleton)
/// @notice Revenue-backed launchpad with milestone-gated escrow, built for Arc.
///         On Arc, the native gas token IS USDC (18 decimals), so escrow is held
///         in native value — no ERC-20 approvals needed to back a launch.
/// @dev    v0 scope: launch registry, native-USDC escrow, milestone tranches,
///         refunds on failed milestones. Milestone resolution is a trusted
///         resolver in v0; replaced by optimistic-oracle prediction markets in v1.
contract ArclightLaunchpad {
    // ---------------------------------------------------------------- types

    enum LaunchStatus {
        Funding,
        Active,
        Completed,
        Failed
    }

    struct Milestone {
        bytes32 descriptionHash; // keccak256 of the objective milestone statement
        uint64 deadline;         // unix time by which the milestone must resolve
        uint16 trancheBps;       // share of the raise released on YES (basis points)
        bool resolved;
        bool outcome;            // true = YES (achieved)
    }

    struct Launch {
        address creator;
        uint256 fundingTarget;   // in native USDC (18 decimals on Arc)
        uint256 raised;
        uint256 released;        // total streamed to creator so far
        uint256 refunded;        // total refunded to backers so far
        uint64 fundingDeadline;
        LaunchStatus status;
        Milestone[] milestones;
        uint256 nextMilestone;   // index of the next unresolved milestone
    }

    // ---------------------------------------------------------------- state

    address public resolver; // v0: trusted resolver; v1: prediction-market oracle
    uint256 public launchCount;

    mapping(uint256 => Launch) private _launches;
    mapping(uint256 => mapping(address => uint256)) public backed; // launchId => backer => amount

    // ---------------------------------------------------------------- events

    event LaunchCreated(uint256 indexed id, address indexed creator, uint256 fundingTarget, uint256 milestoneCount);
    event Backed(uint256 indexed id, address indexed backer, uint256 amount);
    event MilestoneResolved(uint256 indexed id, uint256 indexed index, bool outcome);
    event TrancheReleased(uint256 indexed id, uint256 indexed index, uint256 amount);
    event Refunded(uint256 indexed id, address indexed backer, uint256 amount);

    // ---------------------------------------------------------------- errors

    error NotResolver();
    error BadMilestones();
    error FundingClosed();
    error TargetExceeded();
    error NotFailed();
    error NothingToRefund();
    error TransferFailed();

    modifier onlyResolver() {
        if (msg.sender != resolver) revert NotResolver();
        _;
    }

    constructor() {
        resolver = msg.sender;
    }

    // ---------------------------------------------------------------- create

    /// @param fundingTarget   raise target in native USDC (18 decimals)
    /// @param fundingDeadline unix time when the funding window closes
    /// @param descriptionHashes keccak256 hashes of objective milestone statements
    /// @param deadlines       per-milestone resolution deadlines
    /// @param trancheBps      per-milestone escrow share in bps; must sum to 10_000
    function createLaunch(
        uint256 fundingTarget,
        uint64 fundingDeadline,
        bytes32[] calldata descriptionHashes,
        uint64[] calldata deadlines,
        uint16[] calldata trancheBps
    ) external returns (uint256 id) {
        uint256 n = descriptionHashes.length;
        if (n == 0 || n != deadlines.length || n != trancheBps.length) revert BadMilestones();

        uint256 bpsSum;
        id = ++launchCount;
        Launch storage l = _launches[id];
        l.creator = msg.sender;
        l.fundingTarget = fundingTarget;
        l.fundingDeadline = fundingDeadline;
        l.status = LaunchStatus.Funding;

        for (uint256 i; i < n; ++i) {
            bpsSum += trancheBps[i];
            l.milestones.push(
                Milestone({
                    descriptionHash: descriptionHashes[i],
                    deadline: deadlines[i],
                    trancheBps: trancheBps[i],
                    resolved: false,
                    outcome: false
                })
            );
        }
        if (bpsSum != 10_000) revert BadMilestones();

        emit LaunchCreated(id, msg.sender, fundingTarget, n);
    }

    // ---------------------------------------------------------------- back

    /// @notice Back a launch with native USDC. Held in escrow; released only
    ///         as milestones resolve YES, refundable if they resolve NO.
    function back(uint256 id) external payable {
        Launch storage l = _launches[id];
        if (l.status != LaunchStatus.Funding || block.timestamp > l.fundingDeadline) revert FundingClosed();
        if (l.raised + msg.value > l.fundingTarget) revert TargetExceeded();

        l.raised += msg.value;
        backed[id][msg.sender] += msg.value;
        if (l.raised == l.fundingTarget) l.status = LaunchStatus.Active;

        emit Backed(id, msg.sender, msg.value);
    }

    // ---------------------------------------------------------------- resolve

    /// @notice v0: trusted resolver settles milestones. v1 replaces this with
    ///         optimistic-oracle resolution driven by Arclight milestone markets.
    function resolveMilestone(uint256 id, bool outcome) external onlyResolver {
        Launch storage l = _launches[id];
        uint256 i = l.nextMilestone;
        Milestone storage m = l.milestones[i];

        m.resolved = true;
        m.outcome = outcome;
        l.nextMilestone = i + 1;
        emit MilestoneResolved(id, i, outcome);

        if (outcome) {
            uint256 amount = (l.raised * m.trancheBps) / 10_000;
            l.released += amount;
            if (l.nextMilestone == l.milestones.length) l.status = LaunchStatus.Completed;
            (bool ok, ) = l.creator.call{value: amount}("");
            if (!ok) revert TransferFailed();
            emit TrancheReleased(id, i, amount);
        } else {
            // Any NO kills the launch; remaining escrow becomes refundable.
            l.status = LaunchStatus.Failed;
        }
    }

    // ---------------------------------------------------------------- refund

    /// @notice After a failed milestone, backers reclaim their pro-rata share
    ///         of the unreleased escrow.
    function refund(uint256 id) external {
        Launch storage l = _launches[id];
        if (l.status != LaunchStatus.Failed) revert NotFailed();

        uint256 stake = backed[id][msg.sender];
        if (stake == 0) revert NothingToRefund();
        backed[id][msg.sender] = 0;

        uint256 remaining = l.raised - l.released;
        uint256 amount = (remaining * stake) / l.raised;
        l.refunded += amount;

        (bool ok, ) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Refunded(id, msg.sender, amount);
    }

    // ---------------------------------------------------------------- views

    function getLaunch(uint256 id)
        external
        view
        returns (
            address creator,
            uint256 fundingTarget,
            uint256 raised,
            uint256 released,
            LaunchStatus status,
            uint256 milestoneCount,
            uint256 nextMilestone
        )
    {
        Launch storage l = _launches[id];
        return (l.creator, l.fundingTarget, l.raised, l.released, l.status, l.milestones.length, l.nextMilestone);
    }

    function getMilestone(uint256 id, uint256 index) external view returns (Milestone memory) {
        return _launches[id].milestones[index];
    }
}
