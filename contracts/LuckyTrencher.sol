// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/**
 * LuckyTrencher — the hourly draw on Arc.
 *
 *   Every UTC hour is a round. Three tiers run side by side: Degen ($1),
 *   Trencher ($5), Whale ($50). Tickets are bought with native USDC (18dp on
 *   Arc — it's the gas token). Sales close 2 minutes before the hour; the draw
 *   happens at the top of the hour. One winning ticket per tier takes the
 *   whole pot minus a 2.5% fee. Of that fee, 0.5% of the pot feeds a
 *   progressive MEGA JACKPOT that any winning ticket also takes with 1-in-20
 *   odds — the thing that keeps growing on screen between hits.
 *
 *   Max 10 tickets per wallet per tier per round. A tier with fewer than two
 *   distinct wallets doesn't draw: every ticket is refunded (claimable), no
 *   fee. One wallet can't play against itself and can't fund strangers.
 *
 * RANDOMNESS — who can steer the outcome, and why nobody can alone:
 *   1. Before a round starts, the operator COMMITS keccak(secret, roundId).
 *   2. When sales close, ANYONE calls seal(): the contract records
 *      blockhash(block.number - 1). The sealer is paid for it, so bots race
 *      to seal at the first eligible block — the operator can't wait for a
 *      hash it likes.
 *   3. At the hour, the operator REVEALS the secret. winner index =
 *      keccak(secret, sealedHash, roundId, tier) % tickets.
 *   The operator can't change the sealed hash. A sealer doesn't know the
 *   secret. Validators don't know the secret either. If the operator never
 *   reveals (it drew a losing hand), anyone can forceDraw() after a 1 hour
 *   grace using the sealed hash alone — and the operator's fee is forfeited
 *   to the winners. Not revealing costs the operator, never the players.
 *
 *   Every number the UI shows can be recomputed from the events.
 *
 * TRUST: owner can pause SALES (never draws or claims), set the operator and
 * treasury, and withdraw accrued FEES only. Pots and the jackpot are not
 * withdrawable by anyone. No upgrade path. No token.
 */
contract LuckyTrencher {
    // ----------------------------- constants
    uint256 public constant ROUND        = 1 hours;
    uint256 public constant CLOSE_BEFORE = 2 minutes;   // sales stop at :58
    uint256 public constant REVEAL_GRACE = 1 hours;     // then anyone may forceDraw
    uint8   public constant TIERS        = 3;
    uint8   public constant MAX_TICKETS  = 10;          // per wallet, per tier, per round
    uint16  public constant FEE_BPS      = 250;         // 2.5% of pot
    uint16  public constant JACKPOT_BPS  = 50;          // 0.5% of pot, carved out of the fee
    uint16  public constant SEAL_BPS     = 5;           // 0.05% of the round's pots to whoever seals, out of the fee
    uint256 public constant JACKPOT_ODDS = 20;          // 1 in 20 winning tickets also take the jackpot

    // ----------------------------- config
    address public owner;
    address public pendingOwner;
    address public operator;     // commits + reveals. Gas-only key; it holds no funds.
    address public treasury;
    bool    public paused;       // stops new ticket sales only
    uint256[3] public tierPrice = [uint256(1e18), 5e18, 50e18];

    // ----------------------------- state
    struct TierRound {
        address[] tickets;   // one entry per ticket; index = ticket number
        uint256   pot;
        uint32    wallets;   // distinct buyers
        bool      drawn;
        bool      refunded;
        address   winner;
        uint256   prize;
        bool      hitJackpot;
    }
    mapping(uint256 => mapping(uint8 => TierRound)) private _rounds;                 // roundId => tier
    mapping(uint256 => mapping(uint8 => mapping(address => uint8))) public ticketsOf; // roundId => tier => wallet => count

    mapping(uint256 => bytes32) public commitments;   // roundId => keccak(secret, roundId)
    mapping(uint256 => bytes32) public sealedHash;    // roundId => blockhash captured at close
    mapping(uint256 => address) public sealer;
    mapping(uint256 => uint64)  public sealedAt;
    mapping(uint256 => bool)    public settled;       // all tiers of the round resolved
    mapping(uint256 => bytes32) public revealedSecret;

    uint256 public jackpot;                  // progressive side-pot
    uint256 public accruedFees;              // withdrawable by owner → treasury
    mapping(address => uint256) public claimable;   // refunds + prizes that couldn't be pushed
    uint256 public totalPaid;                // lifetime prizes, for the wall
    uint256 public biggestPot;

    // ----------------------------- events
    event TicketsBought(uint256 indexed roundId, uint8 indexed tier, address indexed buyer, uint8 count, uint256 pot, uint32 wallets);
    event Committed(uint256 indexed roundId, bytes32 commitment);
    event Sealed(uint256 indexed roundId, bytes32 hash, address sealer, uint256 blockNumber);
    event Settled(uint256 indexed roundId, bytes32 seed, bool forced);
    event Drawn(uint256 indexed roundId, uint8 indexed tier, address indexed winner, uint256 winningIndex, uint256 tickets, uint256 prize, bool hitJackpot);
    event Refunded(uint256 indexed roundId, uint8 indexed tier, uint256 pot, uint32 wallets);
    event JackpotGrew(uint256 jackpot);
    event Claimed(address indexed who, uint256 amount);
    event Paused(bool paused);
    event OwnershipTransferred(address indexed from, address indexed to);

    // ----------------------------- errors
    error NotOwner(); error NotOperator(); error SalesClosed(); error BadTier(); error BadCount();
    error WrongValue(); error TooMany(); error AlreadyCommitted(); error RoundStarted(); error NotClosed();
    error AlreadySealed(); error NotSealed(); error NotOver(); error AlreadySettled(); error BadReveal();
    error NoCommitment(); error GraceNotOver(); error Nothing(); error Transfer(); error IsPaused(); error ZeroAddress();

    modifier onlyOwner() { if (msg.sender != owner) revert NotOwner(); _; }
    modifier onlyOperator() { if (msg.sender != operator) revert NotOperator(); _; }

    constructor(address operator_, address treasury_) {
        if (operator_ == address(0) || treasury_ == address(0)) revert ZeroAddress();
        owner = msg.sender; operator = operator_; treasury = treasury_;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    // ----------------------------- time
    function currentRound() public view returns (uint256) { return block.timestamp / ROUND; }
    function roundStart(uint256 r) public pure returns (uint256) { return r * ROUND; }
    function roundClose(uint256 r) public pure returns (uint256) { return (r + 1) * ROUND - CLOSE_BEFORE; }
    function roundEnd(uint256 r)   public pure returns (uint256) { return (r + 1) * ROUND; }
    function salesOpen(uint256 r) public view returns (bool) {
        return !paused && block.timestamp >= roundStart(r) && block.timestamp < roundClose(r);
    }

    // ----------------------------- play
    /// @notice Buy `count` tickets in `tier` for the current round. Pay exactly price × count.
    function buy(uint8 tier, uint8 count) external payable {
        if (paused) revert IsPaused();
        if (tier >= TIERS) revert BadTier();
        if (count == 0) revert BadCount();
        uint256 r = currentRound();
        if (!salesOpen(r)) revert SalesClosed();
        if (msg.value != tierPrice[tier] * count) revert WrongValue();
        uint8 have = ticketsOf[r][tier][msg.sender];
        if (have + count > MAX_TICKETS) revert TooMany();

        TierRound storage t = _rounds[r][tier];
        if (have == 0) t.wallets += 1;
        ticketsOf[r][tier][msg.sender] = have + count;
        for (uint8 i = 0; i < count; i++) t.tickets.push(msg.sender);
        t.pot += msg.value;
        if (t.pot > biggestPot) biggestPot = t.pot;
        emit TicketsBought(r, tier, msg.sender, count, t.pot, t.wallets);
    }

    // ----------------------------- randomness protocol
    /// @notice Operator commits keccak256(abi.encode(secret, roundId)) BEFORE the round starts.
    function commit(uint256 roundId, bytes32 commitment) external onlyOperator {
        if (commitments[roundId] != bytes32(0)) revert AlreadyCommitted();
        // Must land before any ticket exists for that round: either before the
        // round starts, or during it while nobody has bought yet (the deploy hour).
        if (block.timestamp >= roundStart(roundId) && _ticketCount(roundId) != 0) revert RoundStarted();
        if (block.timestamp >= roundClose(roundId)) revert RoundStarted();
        if (commitment == bytes32(0)) revert BadReveal();
        commitments[roundId] = commitment;
        emit Committed(roundId, commitment);
    }

    /// @notice Anyone, once sales have closed. Captures the previous block's hash as the
    ///         round's entropy and records who sealed (they're paid at settlement).
    function seal(uint256 roundId) external {
        if (block.timestamp < roundClose(roundId)) revert NotClosed();
        if (sealedHash[roundId] != bytes32(0)) revert AlreadySealed();
        bytes32 h = blockhash(block.number - 1);
        if (h == bytes32(0)) h = keccak256(abi.encode(block.number, block.timestamp, roundId)); // never on a real chain; keeps tests honest
        sealedHash[roundId] = h;
        sealer[roundId] = msg.sender;
        sealedAt[roundId] = uint64(block.timestamp);
        emit Sealed(roundId, h, msg.sender, block.number);
    }

    /// @notice Operator reveals; settles every tier. Fee is taken.
    function draw(uint256 roundId, bytes32 secret) external onlyOperator {
        if (block.timestamp < roundEnd(roundId)) revert NotOver();
        if (settled[roundId]) revert AlreadySettled();
        if (sealedHash[roundId] == bytes32(0)) revert NotSealed();
        bytes32 c = commitments[roundId];
        if (c == bytes32(0)) revert NoCommitment();
        if (keccak256(abi.encode(secret, roundId)) != c) revert BadReveal();
        revealedSecret[roundId] = secret;
        _settle(roundId, keccak256(abi.encode(secret, sealedHash[roundId], roundId)), false);
    }

    /// @notice Anyone, if the operator hasn't revealed one hour after the round ended.
    ///         Seed is the sealed hash alone; the operator's fee goes to the winners.
    function forceDraw(uint256 roundId) external {
        if (block.timestamp < roundEnd(roundId) + REVEAL_GRACE) revert GraceNotOver();
        if (settled[roundId]) revert AlreadySettled();
        if (sealedHash[roundId] == bytes32(0)) revert NotSealed();
        _settle(roundId, keccak256(abi.encode(sealedHash[roundId], roundId)), true);
    }

    function _settle(uint256 roundId, bytes32 seed, bool forced) internal {
        settled[roundId] = true;
        emit Settled(roundId, seed, forced);
        uint256 totalPots;
        for (uint8 tier = 0; tier < TIERS; tier++) {
            totalPots += _settleTier(roundId, tier, seed, forced);
        }
        emit JackpotGrew(jackpot);

        // Sealer's reward comes out of accrued fees (whatever is there — a forced
        // round adds none, so the sealer of a forced round is paid from earlier fees).
        uint256 reward = (totalPots * SEAL_BPS) / 10_000;
        if (reward > accruedFees) reward = accruedFees;
        if (reward > 0 && sealer[roundId] != address(0)) { accruedFees -= reward; _pay(sealer[roundId], reward); }
    }

    /// @dev One tier of one round. Returns the tier's pot (for the sealer reward).
    function _settleTier(uint256 roundId, uint8 tier, bytes32 seed, bool forced) internal returns (uint256) {
        TierRound storage t = _rounds[roundId][tier];
        t.drawn = true;
        uint256 n = t.tickets.length;
        if (n == 0) return 0;

        if (t.wallets < 2) {
            // one wallet: no game. Every ticket back, no fee.
            t.refunded = true;
            claimable[t.tickets[0]] += t.pot;
            emit Refunded(roundId, tier, t.pot, t.wallets);
            return t.pot;
        }

        bytes32 tierSeed = keccak256(abi.encode(seed, tier));
        uint256 idx = uint256(tierSeed) % n;
        uint256 prize;
        {
            uint256 jp  = (t.pot * JACKPOT_BPS) / 10_000;              // always grows, even when forced
            uint256 fee = forced ? jp : (t.pot * FEE_BPS) / 10_000;    // forced: only the jackpot cut leaves the pot
            prize = t.pot - fee;
            accruedFees += fee - jp;
            jackpot += jp;
        }
        bool hit = uint256(keccak256(abi.encode(tierSeed, "jackpot"))) % JACKPOT_ODDS == 0;
        if (hit && jackpot > 0) { prize += jackpot; jackpot = 0; }

        t.winner = t.tickets[idx]; t.prize = prize; t.hitJackpot = hit;
        totalPaid += prize;
        _pay(t.winner, prize);
        emit Drawn(roundId, tier, t.winner, idx, n, prize, hit);
        return t.pot;
    }

    /// @dev Push the payment; if the recipient can't take it, park it as claimable.
    function _pay(address to, uint256 amount) internal {
        if (amount == 0) return;
        (bool ok, ) = to.call{value: amount, gas: 30_000}("");
        if (!ok) claimable[to] += amount;
    }

    function claim() external {
        uint256 amt = claimable[msg.sender];
        if (amt == 0) revert Nothing();
        claimable[msg.sender] = 0;
        (bool ok, ) = msg.sender.call{value: amt}("");
        if (!ok) revert Transfer();
        emit Claimed(msg.sender, amt);
    }

    function _ticketCount(uint256 roundId) internal view returns (uint256 n) {
        for (uint8 i = 0; i < TIERS; i++) n += _rounds[roundId][i].tickets.length;
    }

    // ----------------------------- views for the UI
    function tierState(uint256 roundId, uint8 tier) external view returns (
        uint256 pot, uint256 tickets, uint32 wallets, bool drawn, bool refunded, address winner, uint256 prize, bool hitJackpot
    ) {
        TierRound storage t = _rounds[roundId][tier];
        return (t.pot, t.tickets.length, t.wallets, t.drawn, t.refunded, t.winner, t.prize, t.hitJackpot);
    }
    function ticketOwner(uint256 roundId, uint8 tier, uint256 index) external view returns (address) {
        return _rounds[roundId][tier].tickets[index];
    }
    /// @notice The whole round in one call: pots, ticket counts, wallets, plus phase flags.
    function roundState(uint256 roundId) external view returns (
        uint256[3] memory pots, uint256[3] memory tickets, uint32[3] memory wallets,
        bool open, bool isSealed, bool isSettled, bool committed, uint256 closeAt, uint256 endAt
    ) {
        for (uint8 i = 0; i < TIERS; i++) {
            TierRound storage t = _rounds[roundId][i];
            pots[i] = t.pot; tickets[i] = t.tickets.length; wallets[i] = t.wallets;
        }
        open = salesOpen(roundId);
        isSealed = sealedHash[roundId] != bytes32(0);
        isSettled = settled[roundId];
        committed = commitments[roundId] != bytes32(0);
        closeAt = roundClose(roundId); endAt = roundEnd(roundId);
    }

    // ----------------------------- admin (fees only; pots are untouchable)
    function withdrawFees(address to) external onlyOwner {
        uint256 amt = accruedFees; if (amt == 0) revert Nothing();
        accruedFees = 0;
        (bool ok, ) = to.call{value: amt}(""); if (!ok) revert Transfer();
    }
    function setOperator(address o) external onlyOwner { if (o == address(0)) revert ZeroAddress(); operator = o; }
    function setTreasury(address t) external onlyOwner { if (t == address(0)) revert ZeroAddress(); treasury = t; }
    function setPaused(bool p) external onlyOwner { paused = p; emit Paused(p); }
    function transferOwnership(address to) external onlyOwner { pendingOwner = to; }
    function acceptOwnership() external { if (msg.sender != pendingOwner) revert NotOwner(); emit OwnershipTransferred(owner, msg.sender); owner = msg.sender; pendingOwner = address(0); }

    receive() external payable { revert WrongValue(); }
}
