#!/usr/bin/env node
/**
 * draw-keeper.js — runs Lucky Trencher's clock.
 *
 * Every 10 seconds:
 *   1. COMMIT  — if the NEXT round has no commitment, commit keccak(secret, round).
 *               Secrets are derived: secret(r) = keccak(OPERATOR_SEED, r). Nothing to
 *               store, nothing to lose; the seed never leaves this process.
 *   2. SEAL    — once sales have closed (:58), seal the round if nobody has.
 *               Anyone can seal and is paid for it; we just make sure it happens.
 *   3. DRAW    — at the hour, reveal secret(r) and settle.
 *   4. FORCE   — any older round that is sealed but unsettled past the grace
 *               period gets forceDraw()'d, so nothing is ever stranded.
 *
 * Keys: OPERATOR_KEY is a GAS-ONLY wallet. It can't touch pots, fees, or the
 * jackpot — the contract has no path for that. Worst case if it leaks: someone
 * else can reveal our secrets... which they can't compute without OPERATOR_SEED.
 * Keep both in Railway variables, never in the repo.
 *
 *   RPC=https://rpc.arclite.fun CHAIN_ID=5042 DRAW=0x<contract> \
 *   OPERATOR_KEY=0x<gas-only key> OPERATOR_SEED=<long random string> node draw-keeper.js
 */
'use strict';
require('dotenv').config();
const { ethers } = require('ethers');
const { makeProvider } = require('./rpc-retry');

const { RPC, DRAW, OPERATOR_KEY, OPERATOR_SEED } = process.env;
const CHAIN_ID = Number(process.env.CHAIN_ID || 5042);
const TICK_MS = Number(process.env.TICK_MS || 10_000);
for (const [k, v] of Object.entries({ RPC, DRAW, OPERATOR_KEY, OPERATOR_SEED })) if (!v) { console.error(`✗ ${k} is required`); process.exit(1); }
if (OPERATOR_SEED.length < 32) { console.error('✗ OPERATOR_SEED must be at least 32 characters'); process.exit(1); }

const ABI = [
  'function currentRound() view returns (uint256)',
  'function roundState(uint256) view returns (uint256[3] pots, uint256[3] tickets, uint32[3] wallets, bool open, bool isSealed, bool isSettled, bool committed, uint256 closeAt, uint256 endAt)',
  'function commitments(uint256) view returns (bytes32)',
  'function sealedHash(uint256) view returns (bytes32)',
  'function settled(uint256) view returns (bool)',
  'function operator() view returns (address)',
  'function REVEAL_GRACE() view returns (uint256)',
  'function commit(uint256,bytes32)',
  'function seal(uint256)',
  'function draw(uint256,bytes32)',
  'function forceDraw(uint256)',
];
const abi = ethers.AbiCoder.defaultAbiCoder();
const secretFor = r => ethers.keccak256(abi.encode(['string', 'uint256'], [OPERATOR_SEED, r]));
const commitmentFor = r => ethers.keccak256(abi.encode(['bytes32', 'uint256'], [secretFor(r), r]));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

(async () => {
  const provider = makeProvider(RPC, CHAIN_ID);
  const wallet = new ethers.Wallet(OPERATOR_KEY, provider);
  const c = new ethers.Contract(DRAW, ABI, wallet);
  const op = await c.operator();
  if (op.toLowerCase() !== wallet.address.toLowerCase()) { console.error(`✗ contract operator is ${op}, this key is ${wallet.address}`); process.exit(1); }
  const grace = Number(await c.REVEAL_GRACE());
  log(`[keeper] operator ${wallet.address} · draw ${DRAW} · chain ${CHAIN_ID}`);

  let inflight = false;
  const send = async (label, fn) => {
    try { const tx = await fn(); log(`[${label}] sent ${tx.hash}`); const rc = await tx.wait(); log(`[${label}] mined block ${rc.blockNumber}`); return true; }
    catch (e) { log(`[${label}] failed: ${String(e.shortMessage || e.message || e).slice(0, 160)}`); return false; }
  };

  const tick = async () => {
    if (inflight) return; inflight = true;
    try {
      const now = Math.floor(Date.now() / 1000);
      const r = Number(await c.currentRound());

      // 1. commit next round (and this one, if it's still empty — the deploy hour)
      for (const rr of [r, r + 1]) {
        if ((await c.commitments(rr)) === ethers.ZeroHash) {
          const st = await c.roundState(rr);
          const empty = st.tickets.every(t => t === 0n);
          if (rr > r || empty) await send(`commit ${rr}`, () => c.commit(rr, commitmentFor(rr)));
        }
      }

      // 2. seal + 3. draw — this round and the previous few, in case we were down
      for (let rr = r - 3; rr <= r; rr++) {
        if (rr < 0) continue;
        const st = await c.roundState(rr);
        if (st.isSettled) continue;
        const anyTickets = st.tickets.some(t => t > 0n);
        if (!st.isSealed && now >= Number(st.closeAt) && anyTickets) { await send(`seal ${rr}`, () => c.seal(rr)); continue; }
        if (st.isSealed && now >= Number(st.endAt)) {
          if (st.committed) await send(`draw ${rr}`, () => c.draw(rr, secretFor(rr)));
          else if (now >= Number(st.endAt) + grace) await send(`forceDraw ${rr}`, () => c.forceDraw(rr));
        }
      }
    } catch (e) { log('[tick] error', String(e.message || e).slice(0, 160)); }
    finally { inflight = false; }
  };
  await tick();
  setInterval(tick, TICK_MS);
})().catch(e => { console.error(e); process.exit(1); });
