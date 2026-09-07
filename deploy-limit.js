#!/usr/bin/env node
/**
 * Deploy ArcliteLimit (limit orders on the curve). Ownerless, immutable, no admin.
 *   RPC=... CHAIN_ID=5042 DEPLOYER_KEY=0x.. PUMP=0x<ArclitePump> node deploy-limit.js
 * Writes deployment-limit.json. Then: Railway keepers service → LIMIT=<addr>, PUMP=<pump>, KEEPER_KEY=<gas-only key>;
 * terminal.html → NETWORKS.<net>.limit = '<addr>'.
 */
const { ethers } = require('ethers'); const fs = require('fs');
const die = m => { console.error('\n  ' + m + '\n'); process.exit(1); };
const { RPC, DEPLOYER_KEY, PUMP } = process.env; const CHAIN_ID = Number(process.env.CHAIN_ID || 0);
if (!RPC || !CHAIN_ID) die('RPC and CHAIN_ID are required.');
if (!DEPLOYER_KEY) die('DEPLOYER_KEY is required.');
if (!PUMP || !ethers.isAddress(PUMP)) die('PUMP must be the ArclitePump address on this chain.');
(async () => {
  const build = JSON.parse(fs.readFileSync(__dirname + '/build-limit.json', 'utf8'));
  const net = new ethers.Network('arc', CHAIN_ID);
  const provider = new ethers.JsonRpcProvider(RPC, net, { staticNetwork: net, batchMaxCount: 1 });
  const live = Number(await provider.send('eth_chainId', []));
  if (live !== CHAIN_ID) die(`RPC reports chain ${live}, you declared ${CHAIN_ID}.`);
  if ((await provider.getCode(PUMP)) === '0x') die('No contract at PUMP on this chain.');
  const wallet = new ethers.Wallet(DEPLOYER_KEY, provider);
  console.log(`\n  chain ${CHAIN_ID} · deployer ${wallet.address} · pump ${PUMP}`);
  const c = await new ethers.ContractFactory(build.abi, build.bytecode, wallet).deploy(PUMP);
  const rc = await c.deploymentTransaction().wait();
  const addr = await c.getAddress();
  console.log(`  ✓ ArcliteLimit at ${addr} (block ${rc.blockNumber})`);
  fs.writeFileSync(__dirname + '/deployment-limit.json', JSON.stringify({ chainId: CHAIN_ID, deployedAt: new Date().toISOString(), deployer: wallet.address, contracts: { ArcliteLimit: { address: addr, block: rc.blockNumber, pump: PUMP } } }, null, 2));
  console.log('\n  wrote deployment-limit.json\n  next: Railway keepers → LIMIT=' + addr + ' PUMP=' + PUMP + ' KEEPER_KEY=<gas-only>; terminal NETWORKS.*.limit');
})().catch(e => die(e.shortMessage || e.message || e));
