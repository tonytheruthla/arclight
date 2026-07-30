#!/usr/bin/env node
/**
 * Arklight market keeper.
 *
 * Market resolution is permissionless by design — but permissionless means
 * "anyone CAN", not "someone WILL". An unresolved market is a user who staked
 * USDC and got silence. In v0.2 market #1 sat expired and unresolved for days;
 * this exists so that never happens again.
 *
 * One pass:
 *   marketCount()  ->  resolvable(id) for each  ->  resolve(id) where true
 *
 * Deliberately boring. It holds gas and nothing else, so a compromised keeper
 * key costs a few dollars of gas, never control or user funds.
 *
 *   KEEPER_KEY=0x…            hot EOA, gas only, auto-refilled
 *   PREDICT=0x…               ArclightPredict address (defaults to v0.3 testnet)
 *   RPC=…                     defaults to Arc testnet
 *   ONCE=1                    single pass then exit (CI mode)
 *   DRY=1                     report only, send nothing
 */
const { ethers } = require('ethers');

const RPC      = process.env.RPC || 'https://rpc.testnet.arc.network';
const CHAIN_ID = Number(process.env.CHAIN_ID || 5042002);
const PREDICT  = process.env.PREDICT || '0x1DC7fAe3157b9Ef003903599762fe8842478bE0b';
const EXPLORER = process.env.EXPLORER || 'https://testnet.arcscan.app';
const INTERVAL = Number(process.env.INTERVAL_MS || 300000);   // 5 min
const ONCE     = !!process.env.ONCE;
const DRY      = !!process.env.DRY;
const MIN_GAS  = ethers.parseEther(process.env.MIN_GAS || '0.05');

const ABI = [
  'function marketCount() view returns (uint256)',
  'function resolvable(uint256) view returns (bool)',
  'function resolve(uint256)',
  'function markets(uint256) view returns (address,uint64,bool,bool,uint256,uint256)'
];

const log = (...a) => console.log(new Date().toISOString().slice(11,19), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** The public Arc RPC rate-limits readily (-32011). Always back off. */
async function retry(fn, tries = 6) {
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) {
      if (i === tries - 1) throw e;
      const m = String(e && (e.message || e));
      await sleep(m.includes('limit') ? 1200 * (i + 1) : 400 * (i + 1));
    }
  }
}

async function main() {
  if (!process.env.KEEPER_KEY) {
    console.error('\n  KEEPER_KEY is required. Use a dedicated hot EOA that holds gas only.\n');
    process.exit(1);
  }
  const net = new ethers.Network('arc', BigInt(CHAIN_ID));
  const provider = new ethers.JsonRpcProvider(RPC, net, { staticNetwork: net, batchMaxCount: 1 });
  const wallet = new ethers.Wallet(process.env.KEEPER_KEY, provider);
  const predict = new ethers.Contract(PREDICT, ABI, wallet);

  log(`keeper up · ${wallet.address} · predict ${PREDICT}${DRY ? ' · DRY RUN' : ''}`);

  async function pass() {
    const bal = await retry(() => provider.getBalance(wallet.address));
    if (bal < MIN_GAS) {
      log(`LOW GAS ${ethers.formatEther(bal)} USDC — top the keeper up`);
      if (bal === 0n) return;
    }

    const n = Number(await retry(() => predict.marketCount()));
    if (n === 0) { log('no markets yet'); return; }

    // Serialised on purpose: a burst of reads trips the public RPC's rate limit,
    // and a keeper that hammers itself into a 429 is worse than a slow one.
    const work = [];
    for (let id = 1; id <= n; id++) {
      const can = await retry(() => predict.resolvable(id));
      if (can) work.push(id);
      await sleep(120);
    }

    if (!work.length) { log(`scanned ${n} markets · nothing to resolve`); return; }
    log(`scanned ${n} markets · ${work.length} resolvable: ${work.join(', ')}`);

    for (const id of work) {
      if (DRY) { log(`  [dry] would resolve #${id}`); continue; }
      try {
        const tx = await predict.resolve(id);
        log(`  resolving #${id} → ${tx.hash}`);
        const r = await tx.wait();
        const m = await retry(() => predict.markets(id));
        log(`  #${id} settled ${m[3] ? 'YES' : 'NO'} · gas ${r.gasUsed} · ${EXPLORER}/tx/${tx.hash}`);
      } catch (e) {
        // Losing a race to another resolver is a success, not a failure.
        const msg = String(e.shortMessage || e.message || e);
        if (/AlreadyResolved/i.test(msg)) log(`  #${id} already resolved by someone else — fine`);
        else log(`  #${id} FAILED: ${msg.slice(0, 140)}`);
      }
      await sleep(400);
    }
  }

  if (ONCE) { await pass(); return; }
  for (;;) {
    try { await pass(); } catch (e) { log('pass error:', String(e.message || e).slice(0, 160)); }
    await sleep(INTERVAL);
  }
}

main().catch(e => { console.error('KEEPER FATAL:', e.message || e); process.exit(1); });
