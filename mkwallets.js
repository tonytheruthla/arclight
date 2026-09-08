#!/usr/bin/env node
/**
 * mkwallets.js — generate ADMIN, TREASURY and OPERATOR offline, plus the
 * OPERATOR_SEED the draw keeper derives its secrets from.
 *
 *   node mkwallets.js
 *
 * Writes ~/arclite-mainnet-keys.json (chmod 600, outside the repo and outside
 * the outputs folder). Prints addresses and the seed; never prints a key.
 * Re-running refuses to overwrite an existing file — that file is the only
 * copy of keys that may already own contracts.
 */
'use strict';
const { ethers } = require('ethers');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const path = os.homedir() + '/arclite-mainnet-keys.json';
if (fs.existsSync(path)) {
  console.error('\n  ✗ ' + path + ' already exists.');
  console.error('    Refusing to overwrite — those keys may already own contracts.');
  console.error('    Delete it yourself first if you are certain it is unused.\n');
  process.exit(1);
}

const out = { created: new Date().toISOString(), seed: crypto.randomBytes(32).toString('hex') };
console.log('');
for (const name of ['ADMIN', 'TREASURY', 'OPERATOR']) {
  const w = ethers.Wallet.createRandom();
  // Store the 12-word phrase as well as the key: the key is what the deploy
  // scripts use, the phrase is what a wallet app asks for on restore. Same
  // wallet either way — a phrase is just a friendlier encoding of the key.
  out[name] = { address: w.address, key: w.privateKey, phrase: w.mnemonic ? w.mnemonic.phrase : null };
  console.log('  ' + name.padEnd(9), w.address);
}
fs.writeFileSync(path, JSON.stringify(out, null, 2), { mode: 0o600 });

console.log('\n  OPERATOR_SEED  ' + out.seed);
console.log('\n  keys written to ' + path + ' (chmod 600)');
console.log('  Back up OPERATOR_SEED somewhere separate — losing it means every');
console.log('  later draw is force-drawn after a 1h grace with our fee forfeited.\n');
console.log('  Next, in the same terminal:\n');
console.log('    export ADMIN=' + out.ADMIN.address);
console.log('    export TREASURY=' + out.TREASURY.address);
console.log('    export OPERATOR=' + out.OPERATOR.address + '\n');
