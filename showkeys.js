#!/usr/bin/env node
/**
 * showkeys.js — print the wallet file mkwallets.js wrote, in full.
 *
 *   node showkeys.js            addresses + which fields exist (safe to screen-share)
 *   node showkeys.js --secrets  the actual private keys and phrases
 *
 * The file is ~/arclite-mainnet-keys.json, chmod 600, outside the repo.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = os.homedir() + '/arclite-mainnet-keys.json';
if (!fs.existsSync(path)) { console.error('\n  ✗ ' + path + ' does not exist. Run: node mkwallets.js\n'); process.exit(1); }
const d = JSON.parse(fs.readFileSync(path, 'utf8'));
const secrets = process.argv.includes('--secrets');
const mask = v => v ? (secrets ? v : v.slice(0, 6) + '…' + v.slice(-4) + '  (node showkeys.js --secrets to reveal)') : '(not stored)';

console.log('\n  ' + path);
console.log('  created ' + d.created + '\n');
for (const name of ['ADMIN', 'TREASURY', 'OPERATOR']) {
  const w = d[name]; if (!w) continue;
  console.log('  ' + name);
  console.log('    address  ' + w.address);
  console.log('    key      ' + mask(w.key));
  if (w.phrase || secrets) console.log('    phrase   ' + (w.phrase ? mask(w.phrase) : '(none — this file predates phrase storage; the key alone is enough)'));
  console.log('');
}
console.log('  OPERATOR_SEED  ' + mask(d.seed));
console.log('\n  To import into MetaMask / Rabby: Add account → Import → Private Key,');
console.log('  and paste the "key" value (starts 0x, 66 characters).\n');
