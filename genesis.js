#!/usr/bin/env node
/**
 * genesis.js — create the "Arclite Genesis" token on an Arclite launchpad.
 *
 * WHY THIS SCRIPT EXISTS
 * ----------------------
 * An ERC-20's `name` and `symbol` are written once, inside `initialize()`, and the
 * Arclite token has no setter for either. The token deployed on testnet is called
 * "Arklight V3 Genesis" and it will be called that for as long as the chain exists.
 * There is no rename. There is only a fresh mint under the correct name — which is
 * exactly what this does.
 *
 * That is fine, because the old one is on a testnet. Testnet tokens carry no value
 * and do not migrate to mainnet. Nothing is being thrown away.
 *
 * USAGE
 *   CREATOR_KEY=0x...  \
 *   PUMP=0x<launchpad address> \
 *   RPC=https://rpc.testnet.arc.network \
 *   CHAIN_ID=5042002 \
 *   node genesis.js
 *
 * Optional:
 *   NAME="Arclite Genesis"   SYMBOL="ARCLITE"
 *   SEED=0.5                 first buy in USDC, straight after creation (0 = skip)
 *   CONFIRM=yes              required when CHAIN_ID is not a known testnet
 *
 * REMEMBER: on Arc, gas is USDC with 18 decimals. Every number below is dollars.
 */

const { ethers } = require('ethers');
const { makeProvider } = require('./rpc-retry');
const fs = require('fs');

const KNOWN_TESTNETS = new Set([5042002]);

// The v0.2 sandbox burner. Never let it near anything again.
const BANNED = new Set(['0x8c992629ac35a229de6fe62b5364d1da813f661c']);

const PUMP_ABI = [
  'function createToken(string name_, string symbol_) payable returns (address)',
  'function buy(address token, uint256 minTokensOut) payable returns (uint256)',
  'function deploymentFee() view returns (uint256)',
  'function graduationUsdc() view returns (uint256)',
  'function paused() view returns (bool)',
  'function quoteBuy(address token, uint256 usdcIn) view returns (uint256)',
  'event TokenCreated(address indexed token, address indexed creator, string name, string symbol)',
];

const die = (m) => { console.error('\n  ✗ ' + m + '\n'); process.exit(1); };
const usd = (w) => ethers.formatEther(w);

(async () => {
  const {
    CREATOR_KEY, PUMP, RPC, CHAIN_ID,
    NAME = 'Arclite Genesis',
    SYMBOL = 'ARCLITE',
    SEED = '0',
    CONFIRM,
  } = process.env;

  if (!CREATOR_KEY) die('CREATOR_KEY is required.');
  if (!PUMP)        die('PUMP (launchpad address) is required.');
  if (!RPC)         die('RPC is required.');
  if (!CHAIN_ID)    die('CHAIN_ID is required — it is the guard against deploying to the wrong chain.');

  const chainId = Number(CHAIN_ID);

  // --- Guard 1: never silently touch a non-testnet ------------------------
  // "Arc mainnet" is a name several unrelated chains use. Chain 1243 on public
  // chain lists is NOT Circle's Arc. Getting this wrong means creating your
  // flagship token on a stranger's network, with a real fee, irreversibly.
  if (!KNOWN_TESTNETS.has(chainId) && CONFIRM !== 'yes') {
    die(`CHAIN_ID ${chainId} is not a known Arclite testnet.\n` +
        `    If this really is Circle's Arc mainnet, re-run with CONFIRM=yes.\n` +
        `    Before you do: confirm the chain ID against docs.arc.network directly,\n` +
        `    not a third-party chain list.`);
  }

  const provider = makeProvider(RPC, chainId);

  // --- Guard 2: the RPC must actually be the chain we think it is ---------
  const live = await provider.getNetwork();
  if (Number(live.chainId) !== chainId) {
    die(`RPC reports chain ${live.chainId}, you declared ${chainId}. Refusing to continue.`);
  }

  const wallet = new ethers.Wallet(CREATOR_KEY, provider);
  if (BANNED.has(wallet.address.toLowerCase())) {
    die('That is the old v0.2 sandbox burner. Its key has been in a sandbox. Use a fresh wallet.');
  }

  const pump = new ethers.Contract(PUMP, PUMP_ABI, wallet);

  console.log('\n  Arclite Genesis');
  console.log('  ' + '─'.repeat(52));
  console.log('  chain      ', chainId, KNOWN_TESTNETS.has(chainId) ? '(testnet)' : '(NOT a known testnet)');
  console.log('  launchpad  ', PUMP);
  console.log('  creator    ', wallet.address);
  console.log('  token      ', `${NAME}  ($${SYMBOL})`);

  // --- Guard 3: is the launchpad even accepting launches? -----------------
  let fee, gradTarget;
  try {
    fee = await pump.deploymentFee();
    gradTarget = await pump.graduationUsdc();
    if (await pump.paused()) die('The launchpad is paused. Unpause from the admin Safe first.');
  } catch (e) {
    die(`Could not read the launchpad at ${PUMP}. Wrong address, or no contract on this chain.\n` +
        `    ${e.shortMessage || e.message}`);
  }

  const seedWei = ethers.parseEther(String(SEED));
  const balance = await provider.getBalance(wallet.address);
  // Gas on Arc is USDC too, so leave headroom rather than budgeting to the cent.
  const needed = fee + seedWei + ethers.parseEther('0.5');

  console.log('  fee        ', '$' + usd(fee));
  console.log('  graduates at', '$' + usd(gradTarget));
  console.log('  seed buy   ', seedWei > 0n ? '$' + usd(seedWei) : 'none');
  console.log('  balance    ', '$' + usd(balance));

  if (balance < needed) {
    die(`Insufficient balance. Need about $${usd(needed)} (fee + seed + gas headroom), have $${usd(balance)}.\n` +
        `    Testnet: faucet.circle.com`);
  }

  // --- Create -------------------------------------------------------------
  console.log('\n  → createToken…');
  const tx = await pump.createToken(NAME, SYMBOL, { value: fee });
  console.log('    tx', tx.hash);
  const rc = await tx.wait();

  // Pull the address out of the event rather than guessing at the clone address.
  let token = null;
  for (const log of rc.logs) {
    try {
      const p = pump.interface.parseLog(log);
      if (p && p.name === 'TokenCreated') { token = p.args.token; break; }
    } catch { /* not ours */ }
  }
  if (!token) die('TokenCreated event not found. The tx landed — check the explorer before re-running, or you will mint a duplicate.');

  console.log('    ✓ token', token);
  console.log('      gas  ', rc.gasUsed.toString());

  // --- Optional seed buy --------------------------------------------------
  if (seedWei > 0n) {
    console.log('\n  → seed buy $' + usd(seedWei) + '…');
    const quote = await pump.quoteBuy(token, seedWei);
    const minOut = (quote * 97n) / 100n;              // 3% slippage floor
    const btx = await pump.buy(token, minOut, { value: seedWei });
    const brc = await btx.wait();
    console.log('    ✓', ethers.formatEther(quote), SYMBOL, '· tx', brc.hash);
  }

  // --- Record it ----------------------------------------------------------
  const out = {
    name: NAME, symbol: SYMBOL, token, chainId, launchpad: PUMP,
    creator: wallet.address, createTx: tx.hash,
    deploymentFee: usd(fee), graduationUsdc: usd(gradTarget),
    seedUsdc: usd(seedWei), createdAt: new Date().toISOString(),
    supersedes: chainId === 5042002
      ? { name: 'Arklight V3 Genesis', token: '0x68FC1a6D6bE5A55ed2a1D0E21E2Ee7CC25302f27',
          reason: 'ERC-20 name is immutable — rebrand required a fresh mint, not a rename.' }
      : undefined,
  };
  const file = `genesis-${chainId}.json`;
  fs.writeFileSync(file, JSON.stringify(out, null, 2));

  console.log('\n  ' + '─'.repeat(52));
  console.log('  ✓ ' + NAME + ' is live');
  console.log('  ' + token);
  console.log('  written to ' + file);
  console.log('\n  Next: add the address to app/terminal.html, and DO NOT open a');
  console.log('  prediction market on this token while you hold the pause switch.');
  console.log('  See arclite-genesis-and-mainnet.md §3.\n');
})().catch((e) => die(e.shortMessage || e.message || String(e)));
