#!/usr/bin/env node
/**
 * Deploy Lucky Trencher (LuckyTrencher.sol).
 *
 *   RPC=... CHAIN_ID=5042 DEPLOYER_KEY=0x.. OPERATOR=0x.. TREASURY=0x.. ADMIN=0x.. node deploy-draw.js
 *
 *   OPERATOR  — the keeper's gas-only wallet (see draw-keeper.js). Holds no funds.
 *   TREASURY  — where withdrawFees() sends the 2% platform cut.
 *   ADMIN     — (optional) owner after the two-step handoff; same rule as the pump:
 *               this script calls transferOwnership(ADMIN); ADMIN must acceptOwnership().
 *
 * Writes deployment-draw.json. The contract is immutable: no upgrade path, no
 * way for anyone to withdraw pots or the jackpot. The owner can only pause
 * SALES, change operator/treasury, and withdraw accrued fees.
 */
const { ethers } = require('ethers');
const { makeProvider } = require('./rpc-retry');
const fs = require('fs');
const die = m => { console.error('\n  ' + m + '\n'); process.exit(1); };

const { RPC, DEPLOYER_KEY, OPERATOR, TREASURY, ADMIN } = process.env;
const CHAIN_ID = Number(process.env.CHAIN_ID || 0);
if (!RPC || !CHAIN_ID) die('RPC and CHAIN_ID are required (5042 for Arc mainnet).');
if (!DEPLOYER_KEY) die('DEPLOYER_KEY is required. Generate it outside this repo and never commit it.');
for (const [k, v] of [['OPERATOR', OPERATOR], ['TREASURY', TREASURY]]) if (!v || !ethers.isAddress(v)) die(`${k} must be a valid address.`);
if (ADMIN && !ethers.isAddress(ADMIN)) die('ADMIN must be a valid address if provided.');

(async () => {
  const build = JSON.parse(fs.readFileSync(__dirname + '/build-draw.json', 'utf8'));
  const provider = makeProvider(RPC, CHAIN_ID);
  const live = Number(await provider.send('eth_chainId', []));
  if (live !== CHAIN_ID) die(`RPC reports chain ${live}, you declared ${CHAIN_ID}. Stopping.`);
  const wallet = new ethers.Wallet(DEPLOYER_KEY, provider);
  const bal = await provider.getBalance(wallet.address);
  console.log(`\n  chain ${CHAIN_ID} · deployer ${wallet.address} · balance ${ethers.formatEther(bal)} USDC`);
  if (bal < ethers.parseEther('0.05')) die('Deployer needs at least 0.05 USDC for gas.');
  if (OPERATOR.toLowerCase() === wallet.address.toLowerCase()) die('OPERATOR must be a different key from the deployer (the keeper runs unattended).');

  const f = new ethers.ContractFactory(build.abi, build.bytecode, wallet);
  console.log('  deploying LuckyTrencher(operator, treasury)…');
  const c = await f.deploy(OPERATOR, TREASURY);
  const rc = await c.deploymentTransaction().wait();
  const addr = await c.getAddress();
  console.log(`  ✓ LuckyTrencher at ${addr} (block ${rc.blockNumber})`);

  const out = { chainId: CHAIN_ID, deployedAt: new Date().toISOString(), deployer: wallet.address,
    contracts: { LuckyTrencher: { address: addr, block: rc.blockNumber, operator: OPERATOR, treasury: TREASURY } } };
  if (ADMIN) {
    console.log(`  transferOwnership(${ADMIN}) — two-step; ADMIN must acceptOwnership()`);
    await (await c.transferOwnership(ADMIN)).wait();
    out.contracts.LuckyTrencher.pendingOwner = ADMIN;
  }
  fs.writeFileSync(__dirname + '/deployment-draw.json', JSON.stringify(out, null, 2));
  console.log('\n  wrote deployment-draw.json');
  console.log('\n  next:');
  console.log(`    1. Railway: new service from this repo (root /), start "node draw-keeper.js", vars RPC, CHAIN_ID, DRAW=${addr}, OPERATOR_KEY, OPERATOR_SEED`);
  console.log(`    2. terminal.html: NETWORKS.mainnet.draw = '${addr}'`);
  if (ADMIN) console.log(`    3. from ADMIN: acceptOwnership() on ${addr}`);
  console.log('');
})().catch(e => die(e.shortMessage || e.message || e));
