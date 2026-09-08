#!/usr/bin/env node
/**
 * preflight.js — can Arclite go to mainnet today? Answers honestly.
 *
 * Run this before day zero. It checks the things that are actually checkable
 * and refuses to be reassuring about the things that aren't.
 *
 *   RPC=<arc mainnet rpc> CHAIN_ID=<id> ADMIN=0x.. TREASURY=0x.. node preflight.js
 *
 * Everything is optional — omitted checks report as UNKNOWN rather than passing.
 * A check that cannot run is never a check that passed.
 */

const { ethers } = require('ethers');
const fs = require('fs');

const R = { pass: '  ✓', fail: '  ✗', warn: '  !', unknown: '  ?' };
const results = [];
const add = (level, label, detail) => { results.push({ level, label, detail }); };

// Chains that are definitely NOT Circle's Arc, but are called "Arc" somewhere.
// Deploying to one of these would be an expensive, irreversible embarrassment.
const IMPOSTORS = { 1243: 'a different chain listed as "ARC Mainnet" on public chain lists' };

(async () => {
  const { RPC, CHAIN_ID, ADMIN, TREASURY, DEPLOYER } = process.env;
  // Operator acknowledgments. Each turns a hard block into a recorded decision.
  // They exist so the guard stays on by default for anyone else running this,
  // while the person who has actually decided can state it once and proceed.
  const ACCEPT_EOA_OWNERS = process.env.ACCEPT_EOA_OWNERS === 'yes';
  const ACCEPT_NO_AUDIT   = process.env.ACCEPT_NO_AUDIT === 'yes';

  console.log('\n  Arclite — mainnet preflight');
  console.log('  ' + '─'.repeat(58));

  // ---- 1. Chain identity -------------------------------------------------
  if (!RPC || !CHAIN_ID) {
    add('unknown', 'Chain identity', 'RPC and CHAIN_ID not supplied — cannot verify.');
  } else {
    const declared = Number(CHAIN_ID);
    if (IMPOSTORS[declared]) {
      add('fail', 'Chain identity', `Chain ${declared} is ${IMPOSTORS[declared]}. This is NOT Circle's Arc.`);
    } else {
      try {
        const net = new ethers.Network('arc', declared);
        const p = new ethers.JsonRpcProvider(RPC, net, { staticNetwork: net, batchMaxCount: 1 });
        const live = await p.getNetwork();
        if (Number(live.chainId) !== declared) {
          add('fail', 'Chain identity', `RPC reports ${live.chainId}, you declared ${declared}.`);
        } else {
          const bn = await p.getBlockNumber();
          add('pass', 'Chain identity', `chain ${declared} reachable, head ${bn}`);
          // Native token sanity: on Arc, gas is USDC at 18dp. If a funded
          // account's balance looks like ETH-scale, something is wrong.
          if (DEPLOYER) {
            const b = await p.getBalance(DEPLOYER);
            add(b > 0n ? 'pass' : 'warn', 'Deployer funded',
                `$${ethers.formatEther(b)} (native USDC, 18dp)`);
          } else {
            add('unknown', 'Deployer funded', 'DEPLOYER not supplied.');
          }
        }
      } catch (e) {
        add('fail', 'Chain identity', `RPC unreachable: ${(e.shortMessage || e.message || '').slice(0, 70)}`);
      }
    }
  }

  // ---- 2. Contracts audited ---------------------------------------------
  // There is no way to check this from code. Look for a report on disk and be
  // explicit that its presence is not the same as it being clean.
  const auditFiles = fs.existsSync('.')
    ? fs.readdirSync('.').filter(f => /audit.*report|report.*audit/i.test(f) && /\.(pdf|md)$/i.test(f))
    : [];
  if (auditFiles.length) {
    add('warn', 'External audit', `Found ${auditFiles.join(', ')} — a human must confirm findings are RESOLVED, not just delivered.`);
  } else if (ACCEPT_NO_AUDIT) {
    add('pass', 'External audit', 'none — proceeding on internal review (AUDIT.md), acknowledged via ACCEPT_NO_AUDIT.');
  } else {
    add('fail', 'External audit', 'No audit report found. AUDIT.md is the brief, not the result. Set ACCEPT_NO_AUDIT=yes to proceed on internal review.');
  }

  // ---- 3. Ownership wiring -----------------------------------------------
  // Two roles: ADMIN owns the contracts (pause, migrate, setTreasury), TREASURY
  // receives fees. They can be Safes or EOAs; what matters is that they are
  // distinct from each other and from the deployer.
  if (!ADMIN || !TREASURY) {
    add('fail', 'Ownership', 'ADMIN and TREASURY not supplied. Deploying without them means one hot key owns everything.');
  } else if (ADMIN.toLowerCase() === TREASURY.toLowerCase()) {
    add('fail', 'Ownership', 'ADMIN and TREASURY are the same address — keep the owner role and the fee sink separate.');
  } else if (DEPLOYER && [ADMIN, TREASURY].some(a => a.toLowerCase() === DEPLOYER.toLowerCase())) {
    add('fail', 'Ownership', 'ADMIN or TREASURY equals DEPLOYER. The post-deploy check that setPaused reverts from the deployer only means something if they differ.');
  } else if (RPC && CHAIN_ID) {
    try {
      const declared = Number(CHAIN_ID);
      const net = new ethers.Network('arc', declared);
      const p = new ethers.JsonRpcProvider(RPC, net, { staticNetwork: net, batchMaxCount: 1 });
      for (const [label, addr] of [['Admin', ADMIN], ['Treasury', TREASURY]]) {
        const code = await p.getCode(addr);
        const isContract = code && code !== '0x';
        if (isContract) {
          add('pass', label, `contract at ${addr} (${(code.length - 2) / 2} bytes)`);
        } else if (ACCEPT_EOA_OWNERS) {
          add('pass', label, `EOA ${addr} — operator-managed key, acknowledged via ACCEPT_EOA_OWNERS.`);
        } else {
          add('fail', label, `${addr} is an EOA (no code). Set ACCEPT_EOA_OWNERS=yes if that is the intended custody model.`);
        }
      }
    } catch (e) {
      add('unknown', 'Ownership', 'Could not read code: ' + (e.shortMessage || e.message || '').slice(0, 50));
    }
  } else {
    add('unknown', 'Ownership', 'Addresses supplied but no RPC to verify them against.');
  }

  // ---- 4. Deployer hygiene ----------------------------------------------
  const SANDBOX_KEYS = [
    '0x8c992629ac35a229de6fe62b5364d1da813f661c',  // v0.2 burner
    '0x4208614338af544c5152e38c8c8da41d3710c8f1',  // v0.3 testnet deployer
  ];
  if (DEPLOYER && SANDBOX_KEYS.includes(DEPLOYER.toLowerCase())) {
    add('fail', 'Deployer hygiene', `${DEPLOYER} is a sandbox-generated testnet key. Its private key has existed in a sandbox. Generate a mainnet key offline.`);
  } else if (DEPLOYER) {
    add('warn', 'Deployer hygiene', 'Address is not a known sandbox key. Only you can confirm it was generated offline.');
  } else {
    add('unknown', 'Deployer hygiene', 'DEPLOYER not supplied.');
  }

  // ---- 5. Params are mainnet, not testnet -------------------------------
  add('warn', 'Launch params',
      'Mainnet must be deploymentFee=0 (free launch, cooldown-gated), graduationUsdc=2500, ' +
      'CREATOR_FEE_SHARE_BPS=8000 (80% to creator) baked into the compiled bytecode. Verify before deploying.');

  // ---- 6. LP vault -------------------------------------------------------
  add('warn', 'LP vault',
      'migrate() sends to lpVault. Until that is a real DEX position, "LP burned at graduation" is a claim the contract does not enforce. Get the router address from Circle or the DEX directly.');

  // ---- Report ------------------------------------------------------------
  console.log();
  for (const r of results) console.log(`${R[r.level]}  ${r.label.padEnd(20)} ${r.detail}`);

  const fails = results.filter(r => r.level === 'fail').length;
  const unknowns = results.filter(r => r.level === 'unknown').length;

  console.log('\n  ' + '─'.repeat(58));
  if (fails) {
    console.log(`  NOT READY — ${fails} blocking item${fails > 1 ? 's' : ''}.`);
    process.exit(1);
  }
  if (unknowns) {
    console.log(`  INCONCLUSIVE — ${unknowns} check${unknowns > 1 ? 's' : ''} could not run.`);
    console.log('  Supply the missing inputs. Do not treat silence as a pass.');
    process.exit(2);
  }
  console.log('  All automated checks pass. The judgement calls are still yours.\n');
})().catch(e => { console.error('\n  ✗ ' + (e.message || e) + '\n'); process.exit(1); });
