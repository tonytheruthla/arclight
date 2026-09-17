#!/usr/bin/env node
/**
 * ownership-v5.js — two-step ownership handoff for the v5 pad, and nothing else.
 *
 * Scoped to ONE contract on purpose. handoff.js and accept-ownership.js both
 * act on the pad AND the predict market; predict is untouched by this work and
 * an accidental transfer of it is a bad afternoon.
 *
 * Step 0, read-only, no key. Run it first and again after each step:
 *   node ownership-v5.js verify
 *
 * Step 1, from the DEPLOYER (sets pendingOwner, changes nothing else):
 *   read -rs "DEPLOYER_KEY?deployer key: " && export DEPLOYER_KEY
 *   ADMIN=0xCDF74d039A0c259524c0A64e5bd56FceF492b246 node ownership-v5.js transfer
 *   unset DEPLOYER_KEY
 *
 * Step 2, from the ADMIN (this is the step that actually moves control):
 *   read -rs "ADMIN_KEY?admin key: " && export ADMIN_KEY
 *   node ownership-v5.js accept
 *   unset ADMIN_KEY
 *
 * Until step 2 runs, the deployer still owns the pad. That is the point of a
 * two-step handoff: a mistyped admin address cannot lock you out, because an
 * address that cannot sign cannot accept.
 */
'use strict';
const fs = require('fs');
const { ethers } = require('ethers');

const RPC = process.env.RPC || 'https://rpc.blockdaemon.mainnet.arc.io';
const CHAIN_ID = Number(process.env.CHAIN_ID || 5042);
const mode = (process.argv[2] || 'verify').toLowerCase();
const die = m => { console.error('\n  x ' + m + '\n'); process.exit(1); };

let PAD = process.env.PAD;
if (!PAD) {
  if (!fs.existsSync('deployment-v5.json')) die('deployment-v5.json not found. Pass PAD=0x... instead.');
  PAD = JSON.parse(fs.readFileSync('deployment-v5.json', 'utf8')).contracts.ArclitePumpV4.address;
}
if (!ethers.isAddress(PAD)) die('PAD is not a valid address.');

const ABI = [
  'function owner() view returns (address)',
  'function pendingOwner() view returns (address)',
  'function transferOwnership(address to) external',
  'function acceptOwnership() external',
];

(async () => {
  const provider = new ethers.JsonRpcProvider(RPC, new ethers.Network('arc', CHAIN_ID), { staticNetwork: true });
  const net = await provider.getNetwork();
  if (Number(net.chainId) !== CHAIN_ID) die(`RPC is chain ${net.chainId}, expected ${CHAIN_ID}.`);

  const pad = new ethers.Contract(PAD, ABI, provider);
  const show = async (label) => {
    const [o, p] = await Promise.all([pad.owner(), pad.pendingOwner()]);
    console.log(`\n  ${label}`);
    console.log('    pad            ' + PAD);
    console.log('    owner          ' + o);
    console.log('    pendingOwner   ' + (p === ethers.ZeroAddress ? '(none)' : p));
    return { o, p };
  };

  if (mode === 'verify') {
    const { o, p } = await show('current state');
    console.log('\n  ' + (p === ethers.ZeroAddress
      ? 'No transfer is pending. Owner is ' + o + '.'
      : o + ' still owns it. ' + p + ' must call accept.') + '\n');
    return;
  }

  if (mode === 'transfer') {
    const KEY = process.env.DEPLOYER_KEY;
    const ADMIN = process.env.ADMIN;
    if (!KEY) die('DEPLOYER_KEY is required for transfer.');
    if (!ADMIN || !ethers.isAddress(ADMIN)) die('ADMIN must be a valid address.');
    const before = await show('before');
    const w = new ethers.Wallet(KEY, provider);
    if (w.address.toLowerCase() !== before.o.toLowerCase())
      die(`This key is ${w.address}, but the owner is ${before.o}. Wrong key — nothing sent.`);
    if (ADMIN.toLowerCase() === before.o.toLowerCase()) die('ADMIN is already the owner. Nothing to do.');
    console.log('\n  transferOwnership -> ' + ADMIN);
    const tx = await pad.connect(w).transferOwnership(ADMIN);
    console.log('    tx ' + tx.hash);
    await tx.wait();
    await show('after');
    console.log('\n  NOT DONE. ' + ADMIN + ' must now run:  node ownership-v5.js accept\n');
    return;
  }

  if (mode === 'accept') {
    const KEY = process.env.ADMIN_KEY;
    if (!KEY) die('ADMIN_KEY is required for accept.');
    const before = await show('before');
    if (before.p === ethers.ZeroAddress) die('No transfer is pending. Run transfer first.');
    const w = new ethers.Wallet(KEY, provider);
    if (w.address.toLowerCase() !== before.p.toLowerCase())
      die(`This key is ${w.address}, but pendingOwner is ${before.p}. Wrong key — nothing sent.`);
    console.log('\n  acceptOwnership from ' + w.address);
    const tx = await pad.connect(w).acceptOwnership();
    console.log('    tx ' + tx.hash);
    await tx.wait();
    const after = await show('after');
    const done = after.o.toLowerCase() === w.address.toLowerCase() && after.p === ethers.ZeroAddress;
    console.log('\n  ' + (done ? 'Ownership moved. pendingOwner cleared.' : 'UNEXPECTED STATE — check the values above.') + '\n');
    if (!done) process.exit(1);
    return;
  }

  die('Unknown mode "' + mode + '". Use: verify | transfer | accept');
})().catch(e => { console.error('\n  FAILED: ' + (e.shortMessage || e.message) + '\n'); process.exit(1); });
