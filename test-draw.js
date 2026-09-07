// LuckyTrencher tests — in-process EVM (@ethereumjs/vm), controllable clock and
// block number. Proves the whole protocol end to end: ticket rules, the :58
// close, permissionless seal, commit/reveal, the exact winner formula, fee /
// jackpot accounting, thin-round refunds, the forced draw with forfeited fee,
// a jackpot hit, and push-payment fallback to claimable.
const { createVM } = require('@ethereumjs/vm');
const { Common, Mainnet, Hardfork } = require('@ethereumjs/common');
const { createAddressFromString, Account, hexToBytes, bytesToHex } = require('@ethereumjs/util');
const { ethers } = require('ethers');
const fs = require('fs');

const build = JSON.parse(fs.readFileSync(__dirname + '/build-draw.json'));
const I = new ethers.Interface(build.abi);
const A = n => createAddressFromString('0x' + n.toString(16).padStart(40, '0'));
const OWNER = A(0xA1), OPER = A(0xA2), TREAS = A(0xA3), SEALER = A(0xA4);
const P = [A(0xB1), A(0xB2), A(0xB3), A(0xB4), A(0xB5)];
const USDC = n => BigInt(n) * 10n ** 18n;
const HOUR = 3600n;
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  PASS ' + m)) : (fail++, console.log('  FAIL ' + m)); };

(async () => {
  let TIME = 1_800_000_000n; TIME -= TIME % HOUR;   // start exactly on an hour
  let BLOCK = 1000n;
  // Deterministic, non-zero blockhashes so seal() takes the real BLOCKHASH path.
  const fakeHash = n => hexToBytes(ethers.keccak256(ethers.toBeHex(n, 32)));
  const blockchain = { getBlock: async (n) => ({ hash: () => fakeHash(BigInt(n)), header: { number: BigInt(n) } }), shallowCopy() { return this; },
    getIteratorHead: async () => null, getCanonicalHeadBlock: async () => null, putBlock: async () => {}, validateHeader: async () => {}, consensus: {}, getTotalDifficulty: async () => 0n, events: { on() {} } };
  const vm = await createVM({ common: new Common({ chain: Mainnet, hardfork: Hardfork.Paris }), blockchain });
  const raw = vm.evm.runCall.bind(vm.evm);
  const run = o => raw({ ...o, block: { header: { timestamp: TIME, number: BLOCK, difficulty: 0n, gasLimit: 30000000n,
    baseFeePerGas: 0n, coinbase: OWNER, prevRandao: new Uint8Array(32), getBlobGasPrice: () => 0n } } });
  const bal = async a => ((await vm.stateManager.getAccount(a)) || new Account()).balance;
  const fund = async (a, w) => { const acc = (await vm.stateManager.getAccount(a)) || new Account(); acc.balance = w; await vm.stateManager.putAccount(a, acc); };
  for (const a of [OWNER, OPER, SEALER, ...P]) await fund(a, USDC(100_000));
  const call = async (to, from, fn, args = [], value = 0n) => {
    const r = await run({ caller: from, origin: from, to: typeof to === 'string' ? createAddressFromString(to) : to, gasLimit: 30_000_000n, data: hexToBytes(I.encodeFunctionData(fn, args)), value });
    const err = r.execResult.exceptionError && r.execResult.exceptionError.error;
    let revert = null;
    if (err) { try { revert = I.parseError(bytesToHex(r.execResult.returnValue)); revert = revert && revert.name; } catch { revert = err; } }
    const logs = (r.execResult.logs || []).map(l => { try { return I.parseLog({ topics: l[1].map(bytesToHex), data: bytesToHex(l[2]) }); } catch { return null; } }).filter(Boolean);
    return { err: revert, ret: bytesToHex(r.execResult.returnValue), logs, gas: r.execResult.executionGasUsed };
  };
  const view = async (to, fn, args = []) => { const r = await call(to, OWNER, fn, args); if (r.err) throw new Error(fn + ' reverted: ' + r.err); return I.decodeFunctionResult(fn, r.ret); };
  const deploy = async (args) => { const r = await run({ caller: OWNER, origin: OWNER, gasLimit: 30_000_000n, data: hexToBytes(build.bytecode + I.encodeDeploy(args).slice(2)), value: 0n }); return r.createdAddress; };

  console.log('\n=== deploy ===');
  const D = await deploy([OPER.toString(), TREAS.toString()]);
  ok(!!D, 'deploys');
  const r0 = (await view(D, 'currentRound'))[0];
  ok(r0 === TIME / HOUR, 'currentRound = timestamp / 3600');
  ok((await view(D, 'tierPrice', [0]))[0] === USDC(1) && (await view(D, 'tierPrice', [2]))[0] === USDC(50), 'tiers are $1 / $5 / $50');

  console.log('\n=== commit (operator, before tickets exist) ===');
  const secret = ethers.keccak256(ethers.toUtf8Bytes('round-' + r0));
  const commitment = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['bytes32', 'uint256'], [secret, r0]));
  ok((await call(D, P[0], 'commit', [r0, commitment])).err === 'NotOperator', 'only the operator can commit');
  ok(!(await call(D, OPER, 'commit', [r0, commitment])).err, 'operator commits for the deploy hour while no ticket exists');
  ok((await call(D, OPER, 'commit', [r0, commitment])).err === 'AlreadyCommitted', 'cannot commit twice');
  // next round can be committed any time before it starts
  const secret1 = ethers.keccak256(ethers.toUtf8Bytes('round-' + (r0 + 1n)));
  const commitment1 = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['bytes32', 'uint256'], [secret1, r0 + 1n]));
  ok(!(await call(D, OPER, 'commit', [r0 + 1n, commitment1])).err, 'operator pre-commits the next round');

  console.log('\n=== buying tickets ===');
  ok((await call(D, P[0], 'buy', [0, 1], USDC(2))).err === 'WrongValue', 'must pay exactly price × count');
  ok((await call(D, P[0], 'buy', [3, 1], USDC(1))).err === 'BadTier', 'tier must be 0..2');
  ok((await call(D, P[0], 'buy', [0, 0], 0n)).err === 'BadCount', 'count must be > 0');
  ok((await call(D, P[0], 'buy', [0, 11], USDC(11))).err === 'TooMany', 'max 10 per wallet per tier');
  let r = await call(D, P[0], 'buy', [0, 4], USDC(4));
  ok(!r.err && r.logs[0].name === 'TicketsBought' && r.logs[0].args.count === 4n, 'P0 buys 4 Degen tickets');
  ok((await call(D, P[0], 'buy', [0, 7], USDC(7))).err === 'TooMany', '4 + 7 > 10 rejected');
  ok(!(await call(D, P[0], 'buy', [0, 6], USDC(6))).err, '4 + 6 = 10 allowed');
  ok(!(await call(D, P[1], 'buy', [0, 3], USDC(3))).err, 'P1 buys 3');
  ok(!(await call(D, P[2], 'buy', [0, 2], USDC(2))).err, 'P2 buys 2');
  ok(!(await call(D, P[0], 'buy', [1, 10], USDC(50))).err, 'P0 buys 10 Trencher ($5) tickets — tiers are independent');
  ok(!(await call(D, P[3], 'buy', [1, 1], USDC(5))).err, 'P3 buys 1 Trencher ticket');
  ok(!(await call(D, P[4], 'buy', [2, 1], USDC(50))).err, 'P4 alone buys 1 Whale ticket (thin tier)');
  ok((await call(D, OPER, 'commit', [r0, commitment])).err === 'AlreadyCommitted', 'still cannot re-commit once tickets exist');
  let ts = await view(D, 'tierState', [r0, 0]);
  ok(ts.pot === USDC(15) && ts.tickets === 15n && ts.wallets === 3n, 'Degen: pot $15, 15 tickets, 3 wallets');
  ok((await view(D, 'ticketOwner', [r0, 0, 10]))[0].toLowerCase() === P[1].toString().toLowerCase(), 'ticket #10 belongs to P1 (indices are purchase order)');
  ok((await view(D, 'biggestPot'))[0] === USDC(55), 'biggestPot tracks the Trencher pot ($55)');
  ok((await call(D, SEALER, 'seal', [r0])).err === 'NotClosed', 'cannot seal while sales are open');
  ok((await call(D, OPER, 'draw', [r0, secret])).err === 'NotOver', 'cannot draw before the hour');

  console.log('\n=== :58 — sales close, anyone seals ===');
  TIME += HOUR - 120n; BLOCK += 7000n;
  ok((await call(D, P[1], 'buy', [0, 1], USDC(1))).err === 'SalesClosed', 'buying after :58 is rejected');
  const rs = await view(D, 'roundState', [r0]);
  ok(rs.open === false && rs.isSealed === false && rs.committed === true, 'roundState: closed, unsealed, committed');
  r = await call(D, SEALER, 'seal', [r0]);
  ok(!r.err && r.logs[0].name === 'Sealed', 'a third party seals');
  const sealed = (await view(D, 'sealedHash', [r0]))[0];
  ok(sealed === ethers.hexlify(fakeHash(BLOCK - 1n)), 'sealed hash is blockhash(block.number - 1)');
  ok((await call(D, OPER, 'seal', [r0])).err === 'AlreadySealed', 'cannot re-seal');
  ok((await call(D, OPER, 'draw', [r0, secret])).err === 'NotOver', 'still cannot draw at :58');

  console.log('\n=== :00 — reveal + draw ===');
  TIME += 120n; BLOCK += 240n;
  ok((await call(D, OPER, 'draw', [r0, ethers.ZeroHash])).err === 'BadReveal', 'wrong secret is rejected');
  ok((await call(D, P[0], 'forceDraw', [r0])).err === 'GraceNotOver', 'forceDraw not available yet');
  const balBefore = {}; for (const p of P) balBefore[p.toString()] = await bal(p);
  const sealerBefore = await bal(SEALER);
  r = await call(D, OPER, 'draw', [r0, secret]);
  ok(!r.err, 'operator reveals and draws');
  const drawn = r.logs.filter(l => l.name === 'Drawn'), refunded = r.logs.filter(l => l.name === 'Refunded');
  ok(drawn.length === 2 && refunded.length === 1, 'two tiers drawn, the thin Whale tier refunded');
  // exact winner formula, recomputed independently
  const seed = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['bytes32', 'bytes32', 'uint256'], [secret, sealed, r0]));
  ok(r.logs.find(l => l.name === 'Settled').args.seed === seed, 'Settled emits seed = keccak(secret, sealedHash, roundId)');
  const tierSeed0 = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['bytes32', 'uint8'], [seed, 0]));
  const idx0 = BigInt(tierSeed0) % 15n;
  const d0 = drawn.find(l => l.args.tier === 0n);
  ok(d0.args.winningIndex === idx0, 'Degen winning index = keccak(seed, tier) % tickets (' + idx0 + ')');
  const owner0 = (await view(D, 'ticketOwner', [r0, 0, idx0]))[0];
  ok(d0.args.winner.toLowerCase() === owner0.toLowerCase(), 'winner is the owner of that ticket');
  ok(d0.args.prize === USDC(15) * 9750n / 10000n, 'Degen prize = pot − 2.5% = $14.625');
  const d1 = drawn.find(l => l.args.tier === 1n);
  ok(d1.args.prize === USDC(55) * 9750n / 10000n, 'Trencher prize = $53.625');
  ok((await view(D, 'jackpot'))[0] === (USDC(15) + USDC(55)) * 50n / 10000n, 'jackpot grew by 0.5% of each drawn pot ($0.35)');
  const fees = (await view(D, 'accruedFees'))[0];
  const expectedFees = (USDC(15) + USDC(55)) * 200n / 10000n - (USDC(15) + USDC(55) + USDC(50)) * 5n / 10000n;
  ok(fees === expectedFees, 'accrued fees = 2% of drawn pots − sealer reward (0.05% of all pots)');
  ok((await bal(SEALER)) - sealerBefore === (USDC(120)) * 5n / 10000n, 'sealer was paid 0.05% of the round\'s pots');
  ok((await bal(d0.args.winner === owner0 ? createAddressFromString(owner0) : createAddressFromString(owner0))) > balBefore[createAddressFromString(owner0).toString()], 'winner\'s balance went up (push payment)');
  ok((await view(D, 'claimable', [P[4].toString()]))[0] === USDC(50), 'thin Whale tier: P4\'s $50 is claimable, no fee taken');
  ok((await call(D, OPER, 'draw', [r0, secret])).err === 'AlreadySettled', 'cannot settle twice');
  ok((await view(D, 'settled', [r0]))[0] === true && (await view(D, 'revealedSecret', [r0]))[0] === secret, 'round marked settled, secret published');
  const p4b = await bal(P[4]);
  ok(!(await call(D, P[4], 'claim')).err && (await bal(P[4])) - p4b === USDC(50), 'P4 claims the refund');
  ok((await call(D, P[4], 'claim')).err === 'Nothing', 'nothing left to claim');

  console.log('\n=== next round: forced draw when the operator never reveals ===');
  const r1 = r0 + 1n;
  ok((await view(D, 'currentRound'))[0] === r1, 'clock rolled into round r0+1');
  ok(!(await call(D, P[0], 'buy', [0, 5], USDC(5))).err && !(await call(D, P[1], 'buy', [0, 5], USDC(5))).err, 'two wallets buy 5 each');
  TIME += HOUR - 120n; BLOCK += 7000n;
  ok(!(await call(D, P[2], 'seal', [r1])).err, 'P2 seals');
  TIME += 120n; BLOCK += 240n;
  ok((await call(D, P[2], 'forceDraw', [r1])).err === 'GraceNotOver', 'forceDraw needs the 1h grace');
  TIME += HOUR; BLOCK += 7200n;
  const jpBefore = (await view(D, 'jackpot'))[0], feesBefore = (await view(D, 'accruedFees'))[0];
  r = await call(D, P[3], 'forceDraw', [r1]);
  ok(!r.err && r.logs.find(l => l.name === 'Settled').args.forced === true, 'anyone forces the draw after grace');
  const fd = r.logs.find(l => l.name === 'Drawn');
  ok(fd.args.prize === USDC(10) - USDC(10) * 50n / 10000n, 'forced: prize = pot − only the 0.5% jackpot cut (operator fee forfeited)');
  ok((await view(D, 'jackpot'))[0] === jpBefore + USDC(10) * 50n / 10000n, 'jackpot still grew');
  const sealed1 = (await view(D, 'sealedHash', [r1]))[0];
  const forcedSeed = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['bytes32', 'uint256'], [sealed1, r1]));
  ok(r.logs.find(l => l.name === 'Settled').args.seed === forcedSeed, 'forced seed = keccak(sealedHash, roundId) — no secret involved');
  ok((await view(D, 'accruedFees'))[0] <= feesBefore, 'no platform fee accrued on a forced round');
  ok((await call(D, OPER, 'draw', [r1, secret1])).err === 'AlreadySettled', 'late reveal is useless once forced');

  console.log('\n=== jackpot hit: find a round where the formula hits, prove the payout ===');
  // Brute-force a secret whose seed hits the 1-in-20 for tier 0, then run that round for real.
  let r2 = (await view(D, 'currentRound'))[0];
  ok(r2 === r1 + 2n, 'clock is two rounds past r1 (the grace hour elapsed)');
  ok(!(await call(D, P[0], 'buy', [0, 2], USDC(2))).err && !(await call(D, P[1], 'buy', [0, 2], USDC(2))).err, 'two wallets in');
  TIME += HOUR - 120n; BLOCK += 7000n;
  ok(!(await call(D, SEALER, 'seal', [r2])).err, 'sealed');
  const sealed2 = (await view(D, 'sealedHash', [r2]))[0];
  // the commitment had to exist before tickets — so for THIS test we pre-commit r3 with a hitting secret and play r3 instead
  let hitSecret = null, r3 = r2 + 1n;
  // r3's sealed hash will be blockhash(BLOCK_at_seal - 1); we know our own clock, so compute it now
  const sealBlock3 = BLOCK + 240n + 7000n;               // :00 of r3 then :58
  const sealed3 = ethers.hexlify(fakeHash(sealBlock3 - 1n));
  for (let i = 0; i < 5000 && !hitSecret; i++) {
    const s = ethers.keccak256(ethers.toUtf8Bytes('hit-' + i));
    const sd = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['bytes32', 'bytes32', 'uint256'], [s, sealed3, r3]));
    const tsd = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['bytes32', 'uint8'], [sd, 0]));
    const hit = BigInt(ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['bytes32', 'string'], [tsd, 'jackpot']))) % 20n === 0n;
    if (hit) hitSecret = s;
  }
  ok(!!hitSecret, 'found a secret that hits the jackpot for r3 (search proves the odds are real, ~1 in 20)');
  const commitment3 = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['bytes32', 'uint256'], [hitSecret, r3]));
  ok(!(await call(D, OPER, 'commit', [r3, commitment3])).err, 'operator commits r3');
  // finish r2 quietly (no commitment → force later); move to r3
  TIME += 120n; BLOCK += 240n;
  ok((await view(D, 'currentRound'))[0] === r3, 'clock in r3');
  ok(!(await call(D, P[0], 'buy', [0, 1], USDC(1))).err && !(await call(D, P[1], 'buy', [0, 1], USDC(1))).err, 'two wallets buy in r3');
  TIME += HOUR - 120n; BLOCK += 7000n;
  ok(BLOCK === sealBlock3, 'test clock landed on the predicted seal block');
  ok(!(await call(D, SEALER, 'seal', [r3])).err && (await view(D, 'sealedHash', [r3]))[0] === sealed3, 'r3 sealed with the predicted hash');
  TIME += 120n; BLOCK += 240n;
  const jp3 = (await view(D, 'jackpot'))[0];
  ok(jp3 > 0n, 'jackpot is non-zero going in (' + ethers.formatEther(jp3) + ' USDC)');
  r = await call(D, OPER, 'draw', [r3, hitSecret]);
  const hd = r.logs.find(l => l.name === 'Drawn');
  ok(!r.err && hd.args.hitJackpot === true, 'JACKPOT HIT flagged in the event');
  ok(hd.args.prize === (USDC(2) - USDC(2) * 250n / 10000n) + jp3 + USDC(2) * 50n / 10000n, 'prize = pot − fee + entire jackpot (incl. this round\'s cut)');
  ok((await view(D, 'jackpot'))[0] === 0n, 'jackpot resets to zero after a hit');

  console.log('\n=== push-payment fallback: a winner that cannot receive ===');
  // A "wallet" whose code is INVALID: any call to it reverts. Fund it, let it buy, force it to win.
  const BRICK = createAddressFromString('0x000000000000000000000000000000000000bad1');
  await fund(BRICK, USDC(100_000));
  { const acc = (await vm.stateManager.getAccount(BRICK)) || new Account(); await vm.stateManager.putAccount(BRICK, acc); await vm.stateManager.putCode(BRICK, hexToBytes('0xfe')); }
  ok((await view(D, 'currentRound'))[0] === r3 + 1n, 'clock in r4');
  // two wallets, but only BRICK can win tier 2 if it holds every ticket... it can't (needs 2 wallets). So: BRICK 10 tickets, P0 1 ticket → 10/11 odds; loop rounds until BRICK wins.
  let brickWon = false, guard = 0;
  while (!brickWon && guard++ < 12) {
    const rr = (await view(D, 'currentRound'))[0];
    const s = ethers.keccak256(ethers.toUtf8Bytes('brick-' + rr));
    const c = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['bytes32', 'uint256'], [s, rr]));
    await call(D, OPER, 'commit', [rr, c]);
    const bb = await call(D, BRICK, 'buy', [2, 10], USDC(500));
    ok(!bb.err, 'brick buys 10 Whale tickets (round ' + rr + ')' + (bb.err ? ' — ' + bb.err : ''));
    ok(!(await call(D, P[0], 'buy', [2, 1], USDC(50))).err, 'P0 buys 1');
    TIME += HOUR - 120n; BLOCK += 7000n; await call(D, SEALER, 'seal', [rr]);
    TIME += 120n; BLOCK += 240n;
    const rr2 = await call(D, OPER, 'draw', [rr, s]);
    const w = rr2.logs.find(l => l.name === 'Drawn' && l.args.tier === 2n);
    if (w && w.args.winner.toLowerCase() === BRICK.toString().toLowerCase()) brickWon = true;
  }
  ok(brickWon, 'brick eventually wins a Whale round');
  const parked = (await view(D, 'claimable', [BRICK.toString()]))[0];
  ok(parked > 0n, 'prize could not be pushed → parked as claimable (' + ethers.formatEther(parked) + ' USDC), draw did not revert');

  console.log('\n=== admin: fees only, pots untouchable ===');
  const fee = (await view(D, 'accruedFees'))[0];
  ok((await call(D, P[0], 'withdrawFees', [P[0].toString()])).err === 'NotOwner', 'only owner withdraws fees');
  const tb = await bal(TREAS);
  ok(!(await call(D, OWNER, 'withdrawFees', [TREAS.toString()])).err && (await bal(TREAS)) - tb === fee, 'owner withdraws exactly the accrued fees to treasury');
  ok(!(await call(D, OWNER, 'setPaused', [true])).err && (await call(D, P[0], 'buy', [0, 1], USDC(1))).err === 'IsPaused', 'pause stops sales');
  ok(!(await call(D, OWNER, 'setPaused', [false])).err, 'unpause');
  const contractBal = await bal(D);
  const jpNow = (await view(D, 'jackpot'))[0], feesNow = (await view(D, 'accruedFees'))[0];
  // open pots right now (current round) + jackpot + fees + parked claimables must equal the balance
  // Every USDC in the contract must be accounted for: pots of rounds not yet
  // settled (the current one, plus r2 which was sealed but never drawn — its
  // $4 waits for a forceDraw), the jackpot, withdrawable fees, and parked prizes.
  const cur = (await view(D, 'currentRound'))[0];
  let unsettledPots = 0n;
  for (const rr of [cur, r2]) for (let t = 0; t < 3; t++) unsettledPots += (await view(D, 'tierState', [rr, t])).pot;
  ok(contractBal === unsettledPots + jpNow + feesNow + parked, 'solvency: balance = unsettled pots + jackpot + fees + claimable (nothing leaks, nothing is stuck)');
  ok((await view(D, 'owner'))[0].toLowerCase() === OWNER.toString().toLowerCase(), 'owner is the deployer');
  // r2 can still be force-drawn by anyone — nothing is ever stranded
  const fr = await call(D, P[1], 'forceDraw', [r2]);
  ok(!fr.err && fr.logs.some(l => l.name === 'Drawn'), 'the orphaned round r2 is force-drawn and paid out');

  console.log('\n' + '='.repeat(52));
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(1); });
