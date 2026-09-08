#!/usr/bin/env node
/**
 * fund.js — send gas money from the deployer to ADMIN and OPERATOR, and show
 * every balance. Read-only unless you pass SEND=yes.
 *
 *   RPC=.. CHAIN_ID=5042 DEPLOYER_KEY=0x.. ADMIN=0x.. OPERATOR=0x.. node fund.js
 *   ... same line with SEND=yes                       # actually sends
 *
 * ADMIN signs 3 acceptOwnership() calls; OPERATOR is the keeper's gas-only key.
 * Amounts are deliberately small — neither wallet is meant to hold funds.
 */
'use strict';
const { ethers } = require('ethers');

const { RPC, DEPLOYER_KEY, ADMIN, OPERATOR, SEND } = process.env;
const CHAIN_ID = Number(process.env.CHAIN_ID || 0);
const ADMIN_TOP_UP = process.env.ADMIN_USDC || '1';
const OPERATOR_TOP_UP = process.env.OPERATOR_USDC || '2';
const die = m => { console.error('\n  ✗ ' + m + '\n'); process.exit(1); };

if (!RPC || !CHAIN_ID) die('RPC and CHAIN_ID are required.');
if (!DEPLOYER_KEY) die('DEPLOYER_KEY is required.');
for (const [k, v] of [['ADMIN', ADMIN], ['OPERATOR', OPERATOR]]) if (!v || !ethers.isAddress(v)) die(`${k} must be a valid address.`);

(async () => {
  const net = new ethers.Network('arc', BigInt(CHAIN_ID));
  const provider = new ethers.JsonRpcProvider(RPC, net, { staticNetwork: net, batchMaxCount: 1, cacheTimeout: -1 });
  const live = Number((await provider.getNetwork()).chainId);
  if (live !== CHAIN_ID) die(`RPC reports chain ${live}, you declared ${CHAIN_ID}. Stopping.`);

  const wallet = new ethers.Wallet(DEPLOYER_KEY, provider);
  const bal = async a => ethers.formatEther(await provider.getBalance(a));
  const targets = [['ADMIN', ADMIN, ADMIN_TOP_UP], ['OPERATOR', OPERATOR, OPERATOR_TOP_UP]];

  console.log('\n  chain      ', CHAIN_ID);
  console.log('  DEPLOYER   ', wallet.address, '$' + (await bal(wallet.address)));
  for (const [name, addr] of targets) console.log('  ' + name.padEnd(11), addr, '$' + (await bal(addr)));
  if (process.env.TREASURY) console.log('  TREASURY   ', process.env.TREASURY, '$' + (await bal(process.env.TREASURY)), '(never needs gas)');

  if (SEND !== 'yes') {
    console.log('\n  Dry run. Re-run the same command with SEND=yes to send:');
    for (const [name, , amt] of targets) console.log(`    → ${name}  $${amt}`);
    console.log('');
    return;
  }

  for (const [name, addr, amt] of targets) {
    const have = Number(await bal(addr));
    if (have >= Number(amt)) { console.log(`\n  ${name} already has $${have} — skipping`); continue; }
    const send = (Number(amt) - have).toFixed(6);
    console.log(`\n  → ${name} $${send} ...`);
    const tx = await wallet.sendTransaction({ to: addr, value: ethers.parseEther(send) });
    console.log('    tx', tx.hash);
    await tx.wait();
    console.log('    ✓ now $' + (await bal(addr)));
  }
  console.log('\n  deployer left with $' + (await bal(wallet.address)) + '\n');
})().catch(e => die(e.shortMessage || e.message || e));
