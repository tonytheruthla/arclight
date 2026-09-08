#!/usr/bin/env node
/**
 * accept.js — send acceptOwnership() from ADMIN in the fewest possible RPC
 * calls. The mirror of handoff.js, for the same reason: a rate-limited
 * endpoint turns every verification read into another chance to stall.
 *
 * accept-ownership.js is still the script to trust: it reads owner() and
 * pendingOwner() on every contract, sends the accepts, then re-reads and also
 * proves the deployer can no longer pause anything. Use this one only when
 * that script cannot get its reads answered. Safety comes from the contract,
 * not the script: acceptOwnership() reverts unless the caller IS the
 * pendingOwner, so the worst case is a few cents of wasted gas.
 *
 * Verify the result afterwards — with accept-ownership.js when the endpoint
 * recovers, or on a block explorer.
 *
 *   RPC=.. CHAIN_ID=5042 ADMIN_KEY=0x.. node accept.js
 *   ... DRAW=0x<LuckyTrencher>            # include the draw contract too
 *   ... GAS_GWEI=30                       # override the gas price
 */
'use strict';
const { ethers } = require('ethers');
const { makeProvider } = require('./rpc-retry');
const fs = require('fs');

const { RPC, ADMIN_KEY } = process.env;
const CHAIN_ID = Number(process.env.CHAIN_ID || 0);
const GAS_LIMIT = BigInt(process.env.GAS_LIMIT || 90_000);
const die = m => { console.error('\n  ✗ ' + m + '\n'); process.exit(1); };

if (!RPC || !CHAIN_ID) die('RPC and CHAIN_ID are required.');
if (!ADMIN_KEY) die('ADMIN_KEY is required (the wallet that transferOwnership pointed at).');

// Targets: whatever was deployed, from the json files or from env.
const targets = [];
const add = (name, addr) => { if (addr && ethers.isAddress(addr)) targets.push({ name, addr }); };
const read = f => { try { return JSON.parse(fs.readFileSync(__dirname + '/' + f, 'utf8')); } catch { return null; } };
const v4 = read('deployment-v4.json'), draw = read('deployment-draw.json');
add('ArclitePumpV4', process.env.PUMP || (v4 && v4.contracts && v4.contracts.ArclitePumpV4 && v4.contracts.ArclitePumpV4.address));
add('ArclitePredictV4', process.env.PRED || (v4 && v4.contracts && v4.contracts.ArclitePredictV4 && v4.contracts.ArclitePredictV4.address));
add('LuckyTrencher', process.env.DRAW || (draw && draw.contracts && draw.contracts.LuckyTrencher && draw.contracts.LuckyTrencher.address));
if (!targets.length) die('No contract addresses found. Pass PUMP=/PRED=/DRAW= or run from the folder with deployment-v4.json.');

// ONLY=draw (or a name/address substring) narrows the list — acceptOwnership()
// on a contract you already own reverts and wastes the gas, so when a later
// deploy adds one contract, accept just that one.
if (process.env.ONLY) {
  // Aliases so the short words used in the runbook work as well as the
  // contract names — "draw" is what we call LuckyTrencher everywhere else.
  const ALIAS = { draw: 'luckytrencher', trencher: 'luckytrencher', lucky: 'luckytrencher',
                  pump: 'arclitepumpv4', pred: 'arclitepredictv4', predict: 'arclitepredictv4' };
  const want = process.env.ONLY.toLowerCase().split(',').map(x => x.trim()).filter(Boolean).map(w => ALIAS[w] || w);
  const kept = targets.filter(t => want.some(w => t.name.toLowerCase().includes(w) || t.addr.toLowerCase() === w));
  if (!kept.length) die(`ONLY=${process.env.ONLY} matched none of: ` + targets.map(t => t.name).join(', '));
  targets.length = 0; targets.push(...kept);
}

const DATA = ethers.id('acceptOwnership()').slice(0, 10);   // no arguments

(async () => {
  const provider = makeProvider(RPC, CHAIN_ID);
  const wallet = new ethers.Wallet(ADMIN_KEY, provider);

  console.log('\n  acceptOwnership() as ' + wallet.address);
  targets.forEach(t => console.log('  ' + t.name.padEnd(17) + t.addr));
  console.log('');

  // Call 1: the nonce. Incremented locally from here — no further reads.
  let nonce = await provider.getTransactionCount(wallet.address, 'pending');
  // Call 2: gas price, with a fixed fallback so even this is optional.
  let gasPrice;
  try { gasPrice = (await provider.getFeeData()).gasPrice; } catch { gasPrice = null; }
  if (process.env.GAS_GWEI) gasPrice = ethers.parseUnits(process.env.GAS_GWEI, 'gwei');
  if (!gasPrice) gasPrice = ethers.parseUnits('30', 'gwei');
  console.log('  nonce ' + nonce + ' · gas ' + ethers.formatUnits(gasPrice, 'gwei') + ' gwei · limit ' + GAS_LIMIT + '\n');

  const sent = [];
  for (const t of targets) {
    // Sign locally, then ONE raw call. wallet.sendTransaction() would wrap the
    // send in a TransactionResponse and make several follow-up reads — on a
    // refusing endpoint each of those is another place to stall. A legacy
    // type-0 tx also avoids the getBlock that EIP-1559 fee logic needs.
    const tx = { to: t.addr, data: DATA, nonce: nonce++, gasLimit: GAS_LIMIT, gasPrice, chainId: CHAIN_ID, type: 0 };
    const raw = await wallet.signTransaction(tx);
    const hash = ethers.keccak256(raw);
    try {
      await provider.send('eth_sendRawTransaction', [raw]);
      sent.push({ name: t.name, hash });
      console.log('  → ' + t.name.padEnd(17) + hash);
    } catch (e) {
      const msg = String(e.shortMessage || e.message || e);
      // "already known" / "nonce too low" mean it is already on-chain: success.
      if (/already known|known transaction|nonce too low|already imported/i.test(msg)) {
        sent.push({ name: t.name, hash }); console.log('  → ' + t.name.padEnd(17) + hash + '  (already sent)');
      } else {
        console.error('  ✗ ' + t.name.padEnd(17) + msg.slice(0, 90));
        console.error('    hash would be ' + hash + ' — check it before re-running');
      }
    }
  }

  if (!sent.length) die('Nothing was sent. The endpoint refused every attempt — try again in a few minutes.');

  console.log('\n  ' + sent.length + '/' + targets.length + ' sent.');
  if (process.env.WAIT === 'yes') {
    for (const s of sent) {
      try {
        const rc = await provider.waitForTransaction(s.hash, 1, 90_000);
        console.log('  ' + (rc && rc.status === 1 ? '✓' : '✗') + ' ' + s.name.padEnd(17) + (rc ? 'block ' + rc.blockNumber : 'no receipt'));
      } catch { console.log('  ? ' + s.name.padEnd(17) + 'receipt unread — check ' + s.hash); }
    }
  } else {
    console.log('  Not waiting for receipts (every read is a chance to be refused).');
    console.log('  accept-ownership.js verifies the result properly in a moment.');
  }

  console.log('\n  Verify when the endpoint allows it:  node accept-ownership.js verify');
  console.log('  owner() should be ' + wallet.address + ' on every contract above.\n');
})().catch(e => die(e.shortMessage || e.message || e));
