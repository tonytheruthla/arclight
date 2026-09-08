#!/usr/bin/env node
/**
 * accept-ownership.js — step 2 of the two-step ownership handoff, for an
 * EOA admin. (A Safe admin would do this from the Safe UI; an EOA needs a
 * signed call, and this is it.)
 *
 * deploy-v3.js ends with transferOwnership(ADMIN) on both contracts, which
 * only sets pendingOwner. Nothing changes hands until ADMIN itself calls
 * acceptOwnership(). Until then the deployer still owns everything — so this
 * is the step that actually moves control, and the verification at the end
 * is the proof that it moved.
 *
 * VERIFY ONLY (no key, read-only, run this first and again after):
 *   RPC=<url> CHAIN_ID=5042 DEPLOYER=0x<deployer addr> node accept-ownership.js verify
 *
 * ACCEPT (signs two transactions from the admin key):
 *   RPC=<url> CHAIN_ID=5042 ADMIN_KEY=0x<admin private key> DEPLOYER=0x<deployer addr> node accept-ownership.js
 *
 * Contract addresses are read from deployment-v3.json (written by deploy-v3.js).
 * Override with PUMP=0x.. PRED=0x.. if needed.
 *
 * The admin key is used for two acceptOwnership() calls and nothing else.
 * Never paste it anywhere but your own shell.
 */
'use strict';
const fs = require('fs');
const { ethers } = require('ethers');
const { makeProvider } = require('./rpc-retry');

const die = (m) => { console.error(m); process.exit(1); };
const mode = process.argv[2] === 'verify' ? 'verify' : 'accept';

const { RPC, ADMIN_KEY, DEPLOYER } = process.env;
const CHAIN_ID = Number(process.env.CHAIN_ID || 0);
if (!RPC) die('✗ RPC is required.');
if (!CHAIN_ID) die('✗ CHAIN_ID is required (5042 for Arc mainnet).');
if (mode === 'accept' && !ADMIN_KEY) die('✗ ADMIN_KEY is required to accept. Use `verify` for a read-only check.');

let PUMP = process.env.PUMP, PRED = process.env.PRED;
if (!PUMP || !PRED) {
  const f4 = __dirname + '/deployment-v4.json', f3 = __dirname + '/deployment-v3.json';
  const f = fs.existsSync(f4) ? f4 : f3;
  if (!fs.existsSync(f)) die('✗ deployment-v4.json not found and PUMP/PRED not supplied.');
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (Number(d.chainId) !== CHAIN_ID) die(`✗ ${f.split('/').pop()} is for chain ${d.chainId}, you said ${CHAIN_ID}.`);
  const c = d.contracts || {};
  const pumpRec = c.ArclitePumpV4 || c.ArclightPumpV3, predRec = c.ArclitePredictV4 || c.ArclightPredictV3;
  if (!pumpRec) die(`✗ ${f.split('/').pop()} has no pump address yet — the deploy did not get that far. Re-run deploy-v4.js first.`);
  if (!predRec) die(`✗ ${f.split('/').pop()} has the pump but no predict contract — deploy-v4.js stopped partway. Re-run it; it resumes from the pump.`);
  PUMP = PUMP || pumpRec.address;
  PRED = PRED || predRec.address;
}
for (const [k, v] of [['PUMP', PUMP], ['PRED', PRED]]) if (!ethers.isAddress(v)) die(`✗ ${k} is not a valid address: ${v}`);

const OWN_ABI = [
  'function owner() view returns (address)',
  'function pendingOwner() view returns (address)',
  'function acceptOwnership()',
  'function setPaused(bool)',
];

(async () => {
  const provider = makeProvider(RPC, CHAIN_ID);

  // Refuse to do anything against a chain that isn't the one declared.
  const live = Number((await provider.send('eth_chainId', [])));
  if (live !== CHAIN_ID) die(`✗ RPC reports chain ${live}, you declared ${CHAIN_ID}. Stopping.`);

  const signer = mode === 'accept' ? new ethers.Wallet(ADMIN_KEY, provider) : null;
  const adminAddr = signer ? signer.address : null;

  const targets = [['ArclitePump', PUMP], ['ArclitePredict', PRED]];
  // Lucky Trencher uses the same two-step Ownable; include it when deployed.
  const DRAW = process.env.DRAW || (fs.existsSync(__dirname + '/deployment-draw.json') ? JSON.parse(fs.readFileSync(__dirname + '/deployment-draw.json','utf8')).contracts.LuckyTrencher.address : null);
  if (DRAW && ethers.isAddress(DRAW)) targets.push(['LuckyTrencher', DRAW]);
  const read = async (addr) => {
    const c = new ethers.Contract(addr, OWN_ABI, provider);
    const [owner, pending] = await Promise.all([c.owner(), c.pendingOwner()]);
    return { owner, pending };
  };

  console.log(`\n  chain ${CHAIN_ID} · mode: ${mode}${adminAddr ? ' · admin ' + adminAddr : ''}\n`);

  // ---- state before
  const before = {};
  for (const [name, addr] of targets) {
    before[name] = await read(addr);
    console.log(`  ${name.padEnd(16)} ${addr}`);
    console.log(`    owner          ${before[name].owner}`);
    console.log(`    pendingOwner   ${before[name].pending}`);
  }

  if (mode === 'accept') {
    for (const [name, addr] of targets) {
      const { owner, pending } = before[name];
      if (owner.toLowerCase() === adminAddr.toLowerCase()) {
        console.log(`\n  ${name}: already owned by admin — skipping.`);
        continue;
      }
      if (pending.toLowerCase() !== adminAddr.toLowerCase()) {
        die(`\n✗ ${name}: pendingOwner is ${pending}, not the admin key you supplied. ` +
            `Either deploy-v3.js was run with a different ADMIN, or this is the wrong key. Stopping before signing anything.`);
      }
      console.log(`\n  ${name}: accepting ownership…`);
      const c = new ethers.Contract(addr, OWN_ABI, signer);
      const tx = await c.acceptOwnership();
      console.log(`    tx ${tx.hash}`);
      const rc = await tx.wait();
      console.log(`    mined in block ${rc.blockNumber}`);
    }
  }

  // ---- verification — the part that matters
  console.log('\n  verification');
  let failures = 0;
  const check = (ok, label, detail) => { console.log(`    ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`); if (!ok) failures++; };

  for (const [name, addr] of targets) {
    const now = await read(addr);
    const expectedOwner = adminAddr || before[name].owner;
    check(now.pending === ethers.ZeroAddress, `${name}: no pending owner left`, now.pending);
    if (adminAddr) check(now.owner.toLowerCase() === adminAddr.toLowerCase(), `${name}: owner() is the admin`, now.owner);
    else console.log(`    · ${name}: owner() is ${now.owner}`);

    // The deploy doc's rule: setPaused from the deployer MUST revert. Checked
    // with eth_call impersonating the deployer, so it costs no gas and cannot
    // accidentally pause anything.
    if (DEPLOYER && ethers.isAddress(DEPLOYER)) {
      const c = new ethers.Contract(addr, OWN_ABI, provider);
      let reverted = false;
      try { await c.setPaused.staticCall(true, { from: DEPLOYER }); }
      catch { reverted = true; }
      const deployerIsOwner = now.owner.toLowerCase() === DEPLOYER.toLowerCase();
      check(reverted && !deployerIsOwner, `${name}: setPaused from deployer reverts`,
            deployerIsOwner ? 'deployer STILL OWNS this contract' : (reverted ? 'as it should' : 'it did NOT revert'));
    } else {
      console.log(`    · ${name}: DEPLOYER not supplied — skipped the "deployer can no longer pause" check`);
    }
  }

  console.log('\n  ' + '─'.repeat(58));
  if (failures) { console.log(`  ${failures} check${failures > 1 ? 's' : ''} failed. Ownership is NOT fully handed off.`); process.exit(1); }
  console.log(mode === 'accept'
    ? '  Handoff complete. The deployer key can no longer administer either contract.'
    : '  Read-only verify finished.');
})().catch(e => die('✗ ' + (e.shortMessage || e.message || e)));
