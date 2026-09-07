#!/usr/bin/env node
/**
 * limit-keeper.js — fills ArcliteLimit orders when the curve crosses them.
 *
 * Permissionless by design: execute() pays 0.3% to whoever calls it, so this
 * is one of possibly many keepers. It just makes sure fills happen promptly.
 *
 * Credit-frugal: one spotPrice() read per distinct token per tick, then a
 * staticCall only for orders whose limit is within 2% of spot. An order that
 * is nowhere near its price costs nothing to watch.
 *
 *   RPC=https://rpc.arclite.fun CHAIN_ID=5042 LIMIT=0x<ArcliteLimit> PUMP=0x<pump> \
 *   KEEPER_KEY=0x<gas-only key> node limit-keeper.js
 */
'use strict';
require('dotenv').config();
const { ethers } = require('ethers');

const LIMIT_ABI = [
  'function count() view returns (uint256)',
  'function page(uint256,uint256) view returns (tuple(address owner,address token,bool isBuy,uint128 amountIn,uint128 limitPrice,uint64 expiry,uint8 status)[])',
  'function execute(uint256) returns (uint256)',
  'function cancel(uint256)',
  'event Placed(uint256 indexed id, address indexed owner, address indexed token, bool isBuy, uint256 amountIn, uint256 limitPrice, uint64 expiry)',
];
const PUMP_ABI = ['function spotPrice(address) view returns (uint256)'];
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), '[limit]', ...a);

async function start({ RPC, CHAIN_ID, LIMIT, PUMP, KEEPER_KEY, TICK_MS = 10_000 }) {
  const net = new ethers.Network('arc', Number(CHAIN_ID));
  const provider = new ethers.JsonRpcProvider(RPC, net, { staticNetwork: net, batchMaxCount: 1 });
  const wallet = new ethers.Wallet(KEEPER_KEY, provider);
  const book = new ethers.Contract(LIMIT, LIMIT_ABI, wallet);
  const pump = new ethers.Contract(PUMP, PUMP_ABI, provider);
  log(`keeper ${wallet.address} · book ${LIMIT} · pump ${PUMP}`);

  const open = new Map();   // id -> order
  let scanned = 0, inflight = false;

  const refresh = async () => {
    const n = Number(await book.count());
    for (let from = scanned; from < n; from += 100) {
      const pg = await book.page(from, 100);
      pg.forEach((o, i) => { if (o.status === 0n) open.set(from + i, o); });
    }
    scanned = n;
    // re-check status of what we hold open (fills/cancels by others)
    const ids = [...open.keys()];
    for (let i = 0; i < ids.length; i += 100) {
      const lo = Math.min(...ids.slice(i, i + 100)), hi = Math.max(...ids.slice(i, i + 100));
      const pg = await book.page(lo, hi - lo + 1);
      pg.forEach((o, j) => { const id = lo + j; if (open.has(id)) { if (o.status !== 0n) open.delete(id); else open.set(id, o); } });
    }
  };

  const tick = async () => {
    if (inflight) return; inflight = true;
    try {
      await refresh();
      const now = Math.floor(Date.now() / 1000);
      const spots = new Map();
      for (const [id, o] of open) {
        if (now > Number(o.expiry)) { // expired: return the escrow to its owner (anyone may)
          try { const tx = await book.cancel(id); await tx.wait(); log(`cancelled expired #${id}`); open.delete(id); } catch (e) { log(`cancel #${id} failed: ${String(e.shortMessage || e.message).slice(0, 80)}`); }
          continue;
        }
        let spot = spots.get(o.token);
        if (spot == null) { try { spot = await pump.spotPrice(o.token); } catch { spot = null; } spots.set(o.token, spot); }
        if (spot == null) continue;
        const near = o.isBuy ? spot <= o.limitPrice * 102n / 100n : spot >= o.limitPrice * 98n / 100n;
        if (!near) continue;
        try { await book.execute.staticCall(id); } catch { continue; }   // pump would revert on slippage → not fillable yet
        try { const tx = await book.execute(id); const rc = await tx.wait(); log(`filled #${id} (${o.isBuy ? 'buy' : 'sell'} ${ethers.formatEther(o.amountIn)} @ ≤${ethers.formatEther(o.limitPrice)}) block ${rc.blockNumber}`); open.delete(id); }
        catch (e) { log(`execute #${id} failed: ${String(e.shortMessage || e.message).slice(0, 80)}`); }
      }
    } catch (e) { log('tick error', String(e.message || e).slice(0, 120)); }
    finally { inflight = false; }
  };
  await tick();
  return setInterval(tick, TICK_MS);
}

if (require.main === module) {
  const { RPC, CHAIN_ID, LIMIT, PUMP, KEEPER_KEY } = process.env;
  for (const [k, v] of Object.entries({ RPC, CHAIN_ID, LIMIT, PUMP, KEEPER_KEY })) if (!v) { console.error(`✗ ${k} is required`); process.exit(1); }
  start({ RPC, CHAIN_ID, LIMIT, PUMP, KEEPER_KEY }).catch(e => { console.error(e); process.exit(1); });
}
module.exports = { start };
