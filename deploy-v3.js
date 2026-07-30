#!/usr/bin/env node
/**
 * Arclite v0.3 deployer.
 *
 * Deliberately refuses to run without an explicitly supplied key and treasury.
 * The v0.2 deployment used a sandbox-generated burner key that ended up as the
 * permanent owner of both contracts; v0.3 exists partly to make that
 * unrecoverable situation impossible, so this script will not silently
 * generate a key for you.
 *
 *   DEPLOYER_KEY=0x...        private key, generated OUTSIDE any sandbox
 *   TREASURY=0x...            address that receives all platform fees
 *   ADMIN=0x...               (optional) Safe multisig to hand ownership to
 *
 * Usage:
 *   DEPLOYER_KEY=0x.. TREASURY=0x.. ADMIN=0x.. node deploy-v3.js
 *
 * After deploying, ownership transfer is TWO-STEP: this script calls
 * transferOwnership(ADMIN), then ADMIN must call acceptOwnership() itself.
 * Until it does, the deployer still holds control — that is intentional.
 */
const { ethers } = require('ethers');
const fs = require('fs');

const RPC = process.env.RPC || 'https://rpc.testnet.arc.network';
const CHAIN_ID = Number(process.env.CHAIN_ID || 5042002);
const DEPLOY_FEE = ethers.parseEther(process.env.DEPLOY_FEE || '1');
const GRAD_TARGET = ethers.parseEther(process.env.GRAD_TARGET || '8000');

function die(msg) { console.error('\n  ' + msg + '\n'); process.exit(1); }

const KEY = process.env.DEPLOYER_KEY;
const TREASURY = process.env.TREASURY;
const ADMIN = process.env.ADMIN;

if (!KEY) die('DEPLOYER_KEY is required. Generate it outside this repo and never commit it.');
if (!TREASURY || !ethers.isAddress(TREASURY)) die('TREASURY must be a valid address (where fees land).');
if (ADMIN && !ethers.isAddress(ADMIN)) die('ADMIN must be a valid address if provided.');

const BANNED = '0x8c992629ac35a229de6fe62b5364d1da813f661c'; // the v0.2 sandbox burner

(async () => {
  const net = new ethers.Network('arc', BigInt(CHAIN_ID));
  const provider = new ethers.JsonRpcProvider(RPC, net, { staticNetwork: net, batchMaxCount: 1 });
  const wallet = new ethers.Wallet(KEY, provider);

  if (wallet.address.toLowerCase() === BANNED) {
    die('Refusing to deploy from the v0.2 sandbox burner key. Generate a fresh key.');
  }

  const bal = await provider.getBalance(wallet.address);
  console.log('\nArclite v0.3 deploy');
  console.log('  chain      ', CHAIN_ID, '(' + RPC + ')');
  console.log('  deployer   ', wallet.address);
  console.log('  balance    ', ethers.formatEther(bal), 'USDC');
  console.log('  treasury   ', TREASURY);
  console.log('  admin      ', ADMIN || '(not set — ownership stays with deployer)');
  console.log('  deploy fee ', ethers.formatEther(DEPLOY_FEE), 'USDC');
  console.log('  graduation ', ethers.formatEther(GRAD_TARGET), 'USDC\n');

  if (bal === 0n) die('Deployer has no balance. Fund it at https://faucet.circle.com (Arc Testnet).');

  const pumpB = JSON.parse(fs.readFileSync(__dirname + '/build-pump-v3.json'));
  const predB = JSON.parse(fs.readFileSync(__dirname + '/build-predict-v3.json'));

  console.log('deploying ArclightPumpV3 ...');
  const pumpF = new ethers.ContractFactory(pumpB.abi, pumpB.bytecode, wallet);
  const pump = await pumpF.deploy(DEPLOY_FEE, GRAD_TARGET, TREASURY);
  await pump.waitForDeployment();
  const pumpAddr = await pump.getAddress();
  console.log('  ->', pumpAddr);

  console.log('deploying ArclightPredictV3 ...');
  const predF = new ethers.ContractFactory(predB.abi, predB.bytecode, wallet);
  const pred = await predF.deploy(pumpAddr, TREASURY);
  await pred.waitForDeployment();
  const predAddr = await pred.getAddress();
  console.log('  ->', predAddr);

  let handoff = null;
  if (ADMIN) {
    console.log('\nstarting ownership handoff to', ADMIN, '...');
    const t1 = await pump.transferOwnership(ADMIN); await t1.wait();
    const t2 = await pred.transferOwnership(ADMIN); await t2.wait();
    handoff = { pending: ADMIN, pumpTx: t1.hash, predictTx: t2.hash };
    console.log('  pending. ADMIN must now call acceptOwnership() on BOTH contracts.');
  }

  const out = {
    version: '0.3',
    network: CHAIN_ID === 5042002 ? 'arc-testnet' : 'arc',
    chainId: CHAIN_ID,
    deployer: wallet.address,
    treasury: TREASURY,
    contracts: {
      ArclightPumpV3: { address: pumpAddr, deployTx: pump.deploymentTransaction().hash },
      ArclightPredictV3: { address: predAddr, deployTx: pred.deploymentTransaction().hash }
    },
    ownershipHandoff: handoff,
    timestamp: new Date().toISOString()
  };
  fs.writeFileSync(__dirname + '/deployment-v3.json', JSON.stringify(out, null, 2));
  console.log('\nwrote deployment-v3.json');

  console.log('\nremaining manual steps:');
  console.log('  1. ADMIN calls acceptOwnership() on both contracts');
  console.log('  2. setLpVault(<dex pool>) — required before any token can migrate');
  console.log('  3. run a keeper against resolvable(id) so markets actually settle');
  console.log('  4. external audit before real USDC touches these contracts\n');
})().catch(e => { console.error('\nDEPLOY FAILED:', e.message || e, '\n'); process.exit(1); });
