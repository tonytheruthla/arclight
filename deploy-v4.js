#!/usr/bin/env node
/**
 * Arclite v0.4 deployer — ArclitePumpV4 (creator fee share 80%, first-buy lock,
 * clone factory) + ArclitePredictV4. Same guards as v0.3.
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
const { makeProvider } = require('./rpc-retry');
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

/* ---------------------------------------------------------------------
   IMMUTABLE-PARAMETER GUARD

   `graduationUsdc` is `immutable`. Set it wrong and the only remedy is
   redeploying the whole factory — every token, curve and market with it.

   Measured on Arc mainnet: every Uniswap V3 USDC pool on the chain holds
   $75 combined, largest $57. A target of 8000 is ~107x the entire
   ecosystem's realised volume, which means nothing ever graduates, which
   means no market ever resolves YES. The default below is inherited from
   pump.fun economics on a chain with billions in liquidity. It does not
   transfer.

   So: on a non-testnet chain, the operator must state the number out loud.
--------------------------------------------------------------------- */
const KNOWN_TESTNETS = new Set([5042002]);
const IMPOSTOR_CHAINS = { 1243: 'a different chain listed as "ARC Mainnet" on public chain lists' };

if (IMPOSTOR_CHAINS[CHAIN_ID]) {
  die(`✗ CHAIN_ID ${CHAIN_ID} is ${IMPOSTOR_CHAINS[CHAIN_ID]}.\n` +
      `    This is NOT Circle's Arc. Circle's Arc mainnet is 5042.`);
}

if (!KNOWN_TESTNETS.has(CHAIN_ID)) {
  const grad = Number(process.env.GRAD_TARGET || '8000');
  if (!process.env.GRAD_TARGET) {
    die('✗ GRAD_TARGET must be set explicitly on a non-testnet chain.\n' +
        '    It is IMMUTABLE. The 8000 default is inherited from another chain\'s\n' +
        '    liquidity and will make graduation unreachable on Arc.\n' +
        '    See arclite-launch-runbook.md — measured recommendation is 250.');
  }
  if (grad > 1000 && process.env.I_UNDERSTAND_GRAD_TARGET !== 'yes') {
    die(`✗ GRAD_TARGET=${grad} is above $1,000.\n` +
        `    Every memecoin pool on Arc mainnet holds $75 combined (largest $57).\n` +
        `    At this target nothing will graduate and no prediction market will\n` +
        `    ever resolve YES — and the value cannot be changed after deployment.\n\n` +
        `    If that is genuinely what you want, re-run with:\n` +
        `      I_UNDERSTAND_GRAD_TARGET=yes`);
  }
}

(async () => {
  const provider = makeProvider(RPC, CHAIN_ID);
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

  const pumpB = JSON.parse(fs.readFileSync(__dirname + '/build-pump-v4.json'));
  const predB = JSON.parse(fs.readFileSync(__dirname + '/build-predict-v4.json'));

  /* -------------------------------------------------------------------
     RESUMABLE. The RPC we deploy through can drop mid-sequence. So:
       - every address is predicted from (deployer, nonce) BEFORE sending,
         and printed, so a lost receipt is never a lost contract;
       - progress is written to deployment-v4.json after EVERY step;
       - PUMP=0x.. / PRED=0x.. skip a deploy that already landed (the script
         verifies code exists at the address before trusting it).
     Re-running after a failure is therefore safe: it never redeploys a
     contract that exists, and never sends a handoff that's already pending.
  ------------------------------------------------------------------- */
  const outFile = __dirname + '/deployment-v4.json';
  const prior = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, 'utf8')) : null;
  const priorOk = prior && Number(prior.chainId) === CHAIN_ID && prior.deployer && prior.deployer.toLowerCase() === wallet.address.toLowerCase();
  const out = priorOk ? prior : {
    version: '0.4', network: CHAIN_ID === 5042002 ? 'arc-testnet' : 'arc', chainId: CHAIN_ID,
    deployer: wallet.address, treasury: TREASURY, contracts: {}, ownershipHandoff: null, timestamp: null,
  };
  const save = () => { out.timestamp = new Date().toISOString(); fs.writeFileSync(outFile, JSON.stringify(out, null, 2)); };
  const hasCode = async a => (await provider.getCode(a)) !== '0x';

  let pumpAddr = process.env.PUMP || (out.contracts.ArclitePumpV4 && out.contracts.ArclitePumpV4.address) || null;
  let predAddr = process.env.PRED || (out.contracts.ArclitePredictV4 && out.contracts.ArclitePredictV4.address) || null;
  if (pumpAddr && !(await hasCode(pumpAddr))) die(`PUMP=${pumpAddr} has no code on chain ${CHAIN_ID}. Do not pass an address that never landed.`);
  if (predAddr && !(await hasCode(predAddr))) die(`PRED=${predAddr} has no code on chain ${CHAIN_ID}.`);

  let nonce = await provider.getTransactionCount(wallet.address, 'pending');
  if (!pumpAddr) console.log('  pump will be at    ', ethers.getCreateAddress({ from: wallet.address, nonce }), '(nonce ' + nonce + ')');
  if (!predAddr) console.log('  predict will be at ', ethers.getCreateAddress({ from: wallet.address, nonce: nonce + (pumpAddr ? 0 : 1) }), '(nonce ' + (nonce + (pumpAddr ? 0 : 1)) + ')');
  console.log('  if this run dies after a send: check getCode at the predicted address, then re-run with PUMP=/PRED= to resume.\n');

  let pump, pred;
  if (pumpAddr) {
    console.log('ArclitePumpV4 already deployed at', pumpAddr, '— skipping');
    pump = new ethers.Contract(pumpAddr, pumpB.abi, wallet);
  } else {
    console.log('deploying ArclitePumpV4 ...');
    const pumpF = new ethers.ContractFactory(pumpB.abi, pumpB.bytecode, wallet);
    pump = await pumpF.deploy(DEPLOY_FEE, GRAD_TARGET, TREASURY);
    const sentAt = pump.deploymentTransaction().hash;
    console.log('  sent', sentAt);
    await pump.waitForDeployment();
    pumpAddr = await pump.getAddress();
    out.contracts.ArclitePumpV4 = { address: pumpAddr, deployTx: sentAt }; save();
    console.log('  ->', pumpAddr, '(saved)');
  }

  if (predAddr) {
    console.log('ArclitePredictV4 already deployed at', predAddr, '— skipping');
    pred = new ethers.Contract(predAddr, predB.abi, wallet);
  } else {
    console.log('deploying ArclitePredictV4 ...');
    const predF = new ethers.ContractFactory(predB.abi, predB.bytecode, wallet);
    pred = await predF.deploy(pumpAddr, TREASURY);
    const sentAt = pred.deploymentTransaction().hash;
    console.log('  sent', sentAt);
    await pred.waitForDeployment();
    predAddr = await pred.getAddress();
    out.contracts.ArclitePredictV4 = { address: predAddr, deployTx: sentAt }; save();
    console.log('  ->', predAddr, '(saved)');
  }

  if (ADMIN) {
    console.log('\nownership handoff to', ADMIN, '...');
    const handoff = out.ownershipHandoff && out.ownershipHandoff.pending && out.ownershipHandoff.pending.toLowerCase() === ADMIN.toLowerCase()
      ? out.ownershipHandoff : { pending: ADMIN, pumpTx: null, predictTx: null };
    for (const [name, c, key] of [['pump', pump, 'pumpTx'], ['predict', pred, 'predictTx']]) {
      const owner = (await c.owner()).toLowerCase(), pending = (await c.pendingOwner()).toLowerCase();
      if (owner === ADMIN.toLowerCase()) { console.log(`  ${name}: ADMIN already owns it`); continue; }
      if (pending === ADMIN.toLowerCase()) { console.log(`  ${name}: already pending on ADMIN`); continue; }
      if (owner !== wallet.address.toLowerCase()) die(`${name}: owner is ${owner}, not the deployer — cannot hand off from here.`);
      const t = await c.transferOwnership(ADMIN); await t.wait();
      handoff[key] = t.hash; out.ownershipHandoff = handoff; save();
      console.log(`  ${name}: transferOwnership sent`, t.hash);
    }
    out.ownershipHandoff = handoff; save();
    console.log('  pending. ADMIN must now call acceptOwnership() on BOTH contracts (node accept-ownership.js).');
  }

  save();
  console.log('\nwrote deployment-v4.json');

  console.log('\nremaining manual steps:');
  console.log('  1. ADMIN calls acceptOwnership() on both contracts  (ADMIN_KEY=.. node accept-ownership.js)');
  console.log('  2. deploy-limit.js (PUMP=' + pumpAddr + ') and deploy-draw.js, then accept-ownership.js again for the draw');
  console.log('  3. genesis.js — the first token');
  console.log('  4. PUMP_ADDRESS on both Railway services; NETWORKS.mainnet.* in terminal.html\n');
})().catch(e => { console.error('\nDEPLOY FAILED:', e.message || e, '\n'); process.exit(1); });
