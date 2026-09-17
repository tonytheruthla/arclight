#!/usr/bin/env node
/**
 * Arclite pad v5 deployer — ArclitePumpV4 with the graduation burn (task #59).
 *
 * Deploys the PAD ONLY. Predict, Draw and Limit are untouched and stay where
 * they are; there is no reason to move a contract that is correct.
 *
 * Refuses to run without an explicitly supplied key, treasury and graduation
 * target. It will never generate a key for you: the v0.2 deployment used a
 * sandbox-generated burner that became the permanent owner of two contracts,
 * and every deployer since exists to make that impossible to repeat.
 *
 *   DEPLOYER_KEY=0x...   private key, generated OUTSIDE any sandbox or repo
 *   TREASURY=0x...       receives platform fees
 *   LP_VAULT=0x...       receives LP_RESERVE + USDC at migrate()
 *   GRAD_TARGET=1500     whole USDC, stated out loud (immutable once deployed)
 *   ADMIN=0x...          optional: address to hand ownership to (two-step)
 *
 * Usage:
 *   DEPLOYER_KEY=0x.. TREASURY=0x.. LP_VAULT=0x.. GRAD_TARGET=1500 \
 *     node deploy-pad-v5.js
 *
 * The key is read from the environment, used to sign, and never printed,
 * logged or written to disk by this script.
 */
const { ethers } = require('ethers');
const fs = require('fs');

const RPC       = process.env.RPC || 'https://rpc.blockdaemon.mainnet.arc.io';
const CHAIN_ID  = Number(process.env.CHAIN_ID || 5042);
const KEY       = process.env.DEPLOYER_KEY;
const TREASURY  = process.env.TREASURY;
const LP_VAULT  = process.env.LP_VAULT;
const ADMIN     = process.env.ADMIN;
const OUT       = 'deployment-v5.json';

const die = m => { console.error('\n  ' + m + '\n'); process.exit(1); };
const ok  = m => console.log('  ok   ' + m);

if (!KEY) die('DEPLOYER_KEY is required. Generate it outside this repo and never commit it.');
if (!TREASURY || !ethers.isAddress(TREASURY)) die('TREASURY must be a valid address (where platform fees land).');
if (!LP_VAULT || !ethers.isAddress(LP_VAULT)) die(
  'LP_VAULT must be a valid address.\n' +
  '  The CURRENT live pad has lpVault = 0x0, which means migrate() reverts and a\n' +
  '  graduated token can only go to redemption. Set it deliberately this time.');

/* graduationUsdc is immutable. Get it wrong and the only remedy is redeploying
   the whole factory. So on a real chain the operator states the number. */
const KNOWN_TESTNETS = new Set([5042002]);
if (!process.env.GRAD_TARGET && !KNOWN_TESTNETS.has(CHAIN_ID))
  die('GRAD_TARGET must be stated explicitly on chain ' + CHAIN_ID + ' (it is immutable). The live pad uses 1500.');
const GRAD_TARGET = ethers.parseEther(process.env.GRAD_TARGET || '1500');
const DEPLOY_FEE  = ethers.parseEther(process.env.DEPLOY_FEE || '0');

(async () => {
  const build = JSON.parse(fs.readFileSync('build-pump-v5.json', 'utf8'));

  console.log('\n=== preflight ===');
  // The build must actually contain the fix, or this whole exercise is theatre.
  const src = fs.readFileSync('contracts/ArclitePumpV4.sol', 'utf8');
  if (!/uint256 unsold = CURVE_SUPPLY - c\.soldTokens/.test(src)) die('contracts/ArclitePumpV4.sol has no graduation burn — recompile from the fixed source.');
  if (/function burnFrom/.test(src)) die('source contains burnFrom — the burn must be self-only.');
  if (!build.ArclitePumpV4.abi.some(f => f.name === 'SupplyBurned')) die('build-pump-v5.json is stale: no SupplyBurned event. Run: node compile-pump.js');
  ok('source has the graduation burn, no burnFrom, ABI has SupplyBurned');
  console.log('  compiler  ' + (build.solcVersion || 'unknown — recompile to record it'));

  const provider = new ethers.JsonRpcProvider(RPC, new ethers.Network('arc', CHAIN_ID), { staticNetwork: true });
  const net = await provider.getNetwork();
  if (Number(net.chainId) !== CHAIN_ID) die(`RPC is chain ${net.chainId}, expected ${CHAIN_ID}. Wrong endpoint.`);
  ok(`connected to chain ${CHAIN_ID} at ${RPC}`);

  const wallet = new ethers.Wallet(KEY, provider);
  const bal = await provider.getBalance(wallet.address);
  console.log('  deployer  ' + wallet.address);
  console.log('  balance   ' + ethers.formatEther(bal) + ' USDC (native gas, 18dp)');
  if (bal === 0n) die('Deployer has no gas. Fund it and re-run.');
  ok('deployer funded');

  console.log('\n=== constructor arguments ===');
  console.log('  deploymentFee_   ' + DEPLOY_FEE.toString() + '   (' + ethers.formatEther(DEPLOY_FEE) + ' USDC)');
  console.log('  graduationUsdc_  ' + GRAD_TARGET.toString() + '   (' + ethers.formatEther(GRAD_TARGET) + ' USDC)');
  console.log('  treasury_        ' + TREASURY);
  console.log('  lpVault (after)  ' + LP_VAULT);

  console.log('\n=== deploying ArclitePumpV4 ===');
  const factory = new ethers.ContractFactory(build.ArclitePumpV4.abi, build.ArclitePumpV4.bytecode, wallet);
  const pad = await factory.deploy(DEPLOY_FEE, GRAD_TARGET, TREASURY);
  const tx = pad.deploymentTransaction();
  console.log('  tx        ' + tx.hash);
  await pad.waitForDeployment();
  const ADDR = await pad.getAddress();
  console.log('  address   ' + ADDR);

  console.log('\n=== setLpVault ===');
  const t2 = await pad.setLpVault(LP_VAULT);
  await t2.wait();
  ok('lpVault set, tx ' + t2.hash);

  console.log('\n=== read back from the chain ===');
  const checks = [
    ['tokenCount',      (await pad.tokenCount()).toString(),      '0'],
    ['deploymentFee',   (await pad.deploymentFee()).toString(),   DEPLOY_FEE.toString()],
    ['graduationUsdc',  (await pad.graduationUsdc()).toString(),  GRAD_TARGET.toString()],
    ['treasury',        (await pad.treasury()).toLowerCase(),     TREASURY.toLowerCase()],
    ['lpVault',         (await pad.lpVault()).toLowerCase(),      LP_VAULT.toLowerCase()],
    ['owner',           (await pad.owner()).toLowerCase(),        wallet.address.toLowerCase()],
  ];
  let bad = 0;
  for (const [n, got, want] of checks) {
    const good = got === want;
    if (!good) bad++;
    console.log(`  ${good ? 'ok  ' : 'BAD '} ${n.padEnd(16)} ${got}${good ? '' : '   expected ' + want}`);
  }

  // The strongest check available: the code actually on chain is the code we built.
  const onchain = await provider.getCode(ADDR);
  const expected = '0x' + build.ArclitePumpV4.bytecode.slice(2);
  const sameTail = onchain.length > 2 && expected.includes(onchain.slice(2, 130));
  console.log(`  ${sameTail ? 'ok  ' : 'BAD '} deployed bytecode ${((onchain.length - 2) / 2).toLocaleString()} bytes, matches local build: ${sameTail}`);
  if (!sameTail) bad++;
  if (bad) die(bad + ' check(s) failed. Do NOT point the site at this address.');

  fs.writeFileSync(OUT, JSON.stringify({
    version: '0.5', network: 'arc', chainId: CHAIN_ID,
    solcVersion: build.solcVersion || 'unknown',
    deployer: wallet.address, treasury: TREASURY, lpVault: LP_VAULT,
    graduationUsdc: GRAD_TARGET.toString(), deploymentFee: DEPLOY_FEE.toString(),
    contracts: { ArclitePumpV4: { address: ADDR, deployTx: tx.hash, setLpVaultTx: t2.hash } },
    note: 'Adds the graduation burn (task #59). Predict/Draw/Limit unchanged.',
    ownershipHandoff: null, timestamp: new Date().toISOString(),
  }, null, 2));
  ok('wrote ' + OUT);

  if (ADMIN) {
    if (!ethers.isAddress(ADMIN)) die('ADMIN is not a valid address.');
    console.log('\n=== ownership handoff (two-step) ===');
    const t3 = await pad.transferOwnership(ADMIN);
    await t3.wait();
    console.log('  transferOwnership -> ' + ADMIN + '  tx ' + t3.hash);
    console.log('  NOT DONE YET: ' + ADMIN + ' must now call acceptOwnership() itself.');
    console.log('  Until it does, ' + wallet.address + ' still owns the pad. That is intentional.');
  } else {
    console.log('\n  No ADMIN set, so the deployer owns the pad.');
    console.log('  The live pad is owned by 0xCDF74d039A0c259524c0A64e5bd56FceF492b246 —');
    console.log('  hand this one over the same way when you are ready.');
  }

  console.log('\n====================================================');
  console.log('  NEW PAD: ' + ADDR);
  console.log('  Next: PUMP_ADDRESS on Railway, then the three site files.');
  console.log('====================================================\n');
})().catch(e => { console.error('\nDEPLOY FAILED:', e.shortMessage || e.message); process.exit(1); });
