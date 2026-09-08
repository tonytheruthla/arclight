#!/usr/bin/env node
/**
 * handoff.js — send transferOwnership(ADMIN) using the fewest possible RPC
 * calls, for when the endpoint is rate-limited and every extra read is a
 * chance to fail.
 *
 * deploy-v4.js does this properly: it reads owner() and pendingOwner() on each
 * contract first, so it can skip work already done and refuse to act from the
 * wrong key. That's ~10 calls. On a contended endpoint that's ~10 chances to
 * be refused. This script does the same job in 3 calls by not asking questions
 * it can survive not knowing the answer to:
 *
 *   - transferOwnership is idempotent. Sending it twice just sets pendingOwner
 *     to the same address again.
 *   - if the deployer is no longer the owner, the call reverts on-chain. That
 *     costs a few cents of gas and changes nothing — a safe way to be wrong.
 *   - gas is fixed, not estimated: these are two tiny state writes and 90k is
 *     roughly double what they need.
 *
 * It does NOT replace accept-ownership.js. That still verifies everything
 * afterwards, from the admin side, before you trust the result.
 *
 *   RPC=.. CHAIN_ID=5042 DEPLOYER_KEY=0x.. ADMIN=0x.. node handoff.js
 *   ... DRAW=0x<LuckyTrencher>            # include the draw contract too
 *   ... GAS_GWEI=30                       # override the gas price
 */
'use strict';
const { ethers } = require('ethers');
const { makeProvider } = require('./rpc-retry');
const fs = require('fs');

const { RPC, DEPLOYER_KEY, ADMIN } = process.env;
const CHAIN_ID = Number(process.env.CHAIN_ID || 0);
const GAS_LIMIT = BigInt(process.env.GAS_LIMIT || 90_000);
const die = m => { console.error('\n  ✗ ' + m + '\n'); process.exit(1); };

if (!RPC || !CHAIN_ID) die('RPC and CHAIN_ID are required.');
if (!DEPLOYER_KEY) die('DEPLOYER_KEY is required (the wallet that currently owns the contracts).');
if (!ADMIN || !ethers.isAddress(ADMIN)) die('ADMIN must be a valid address.');

// Targets: whatever was deployed, from the json files or from env.
const targets = [];
const add = (name, addr) => { if (addr && ethers.isAddress(addr)) targets.push({ name, addr }); };
const read = f => { try { return JSON.parse(fs.readFileSync(__dirname + '/' + f, 'utf8')); } catch { return null; } };
const v4 = read('deployment-v4.json'), draw = read('deployment-draw.json');
add('ArclitePumpV4', process.env.PUMP || (v4 && v4.contracts && v4.contracts.ArclitePumpV4 && v4.contracts.ArclitePumpV4.address));
add('ArclitePredictV4', process.env.PRED || (v4 && v4.contracts && v4.contracts.ArclitePredictV4 && v4.contracts.ArclitePredictV4.address));
add('LuckyTrencher', process.env.DRAW || (draw && draw.contracts && draw.contracts.LuckyTrencher && draw.contracts.LuckyTrencher.address));
if (!targets.length) die('No contract addresses found. Pass PUMP=/PRED=/DRAW= or run from the folder with deployment-v4.json.');

const SELECTOR = ethers.id('transferOwnership(address)').slice(0, 10);
const encode = to => SELECTOR + ethers.AbiCoder.defaultAbiCoder().encode(['address'], [to]).slice(2);

(async () => {
  const provider = makeProvider(RPC, CHAIN_ID);
  const wallet = new ethers.Wallet(DEPLOYER_KEY, provider);

  console.log('\n  handoff → ' + ADMIN);
  console.log('  from      ' + wallet.address);
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
    const tx = { to: t.addr, data: encode(ADMIN), nonce: nonce++, gasLimit: GAS_LIMIT, gasPrice, chainId: CHAIN_ID, type: 0 };
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

  console.log('\n  Next: ADMIN_KEY=0x<admin key> node accept-ownership.js');
  console.log('  That verifies pendingOwner and completes the two-step transfer.\n');
})().catch(e => die(e.shortMessage || e.message || e));
