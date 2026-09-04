// Indexer tests. No live RPC or Postgres — pg-mem stands in for Postgres
// (same schema.sql runs against it unmodified) and synthetic ethers-encoded
// logs stand in for chain data, same approach used to verify the V4 topics
// before they shipped in app/terminal.html.
//
// What this DOES prove: the decode logic is correct against real event
// encodings, the SQL schema is valid Postgres, and the aggregation math
// (volume/txns/traders/holders/24h change) is correct against known inputs.
// What this does NOT prove: that worker.js's actual RPC calls (getLogs,
// getBlock, tokenMeta) behave correctly against the real Arc RPC — there's
// no way to test that without a live connection, which this sandbox
// doesn't have. First real backfill against mainnet is that test.
const { newDb } = require('pg-mem');
const fs = require('fs');
const { ethers } = require('ethers');
const { IFACES, TOPICS, ARC } = require('./chain');
const { decodePoolCreatedV3, decodeInitializeV4, decodeSwapV3, decodeSwapV4, decodeTransfer } = require('./process');
const store = require('./store');
const { listTokens, getToken } = require('./queries');

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  PASS ' + m)) : (fail++, console.log('  FAIL ' + m)); };
const A = n => ethers.getAddress('0x' + n.toString(16).padStart(40, '0'));

function freshDb() {
  const db = newDb({ autoCreateForeignKeyIndices: true });
  db.public.registerFunction({ name: 'now', returns: 'timestamptz', implementation: () => new Date() });
  db.public.none(fs.readFileSync(__dirname + '/schema.sql', 'utf8'));
  const { Pool } = db.adapters.createPg();
  return new Pool();
}

/** Build a fake ethers Log object the way provider.getLogs would return one,
 *  from an interface-encoded event. */
function fakeLog(iface, eventName, args, overrides = {}) {
  const enc = iface.encodeEventLog(eventName, args);
  return {
    topics: enc.topics, data: enc.data,
    address: overrides.address || '0x0000000000000000000000000000000000000001',
    blockNumber: overrides.blockNumber ?? 100,
    transactionHash: overrides.txHash || '0x' + '11'.repeat(32),
    index: overrides.logIndex ?? 0,
  };
}

(async () => {
  console.log('\n=== process.js: decode functions against real-encoded logs ===');

  // --- V3 pool discovery, USDC as token0
  const usdc = ARC.usdc;
  const token = A(0x2222);
  const v3PoolAddr = A(0x3333);
  const pcLog = fakeLog(IFACES.v3Factory, 'PoolCreated', [usdc, token, 3000, 60, v3PoolAddr]);
  const v3Info = decodePoolCreatedV3(pcLog, usdc);
  ok(!!v3Info, 'V3 PoolCreated decodes');
  ok(v3Info.token.toLowerCase() === token.toLowerCase(), 'V3 discovery picks the non-USDC side as the token');
  ok(v3Info.usdcIsToken0 === true, 'V3 discovery correctly flags USDC as token0');

  const notUsdc = decodePoolCreatedV3(fakeLog(IFACES.v3Factory, 'PoolCreated',
    [A(0x4444), token, 3000, 60, v3PoolAddr]), usdc);
  ok(notUsdc === null, 'V3 discovery ignores pools not paired with USDC');

  // --- V3 swap: buyer sends USDC in (token0, positive), receives token out (token1, negative)
  const sqrtPriceX96 = 79228162514264337593543950336n; // 1:1 in Q96, before decimal adjustment
  const TRADER = A(0x7777);
  const swapLog = fakeLog(IFACES.v3Pool, 'Swap',
    [TRADER, TRADER, 100_000000n, -100n*10n**18n, sqrtPriceX96, 0n, 0],
    { address: v3PoolAddr });
  const blockTime = new Date('2026-09-04T00:00:00Z');
  const swap = decodeSwapV3(swapLog, { usdcIsToken0: true }, 6, 18, blockTime);
  ok(!!swap, 'V3 Swap decodes');
  ok(swap.side === 'buy', 'positive USDC delta (token0) decodes as a buy');
  ok(Math.abs(swap.usdcAmount - 100) < 1e-6, 'V3 swap usdcAmount decimal-adjusted correctly (6dp)');

  // --- V4 pool discovery + swap
  const poolId = ethers.zeroPadValue('0xabcdef', 32);
  const initLog = fakeLog(IFACES.v4PoolManager, 'Initialize',
    [poolId, usdc, token, 3000, 60, ethers.ZeroAddress, sqrtPriceX96, 0]);
  const v4Info = decodeInitializeV4(initLog, usdc);
  ok(!!v4Info, 'V4 Initialize decodes');
  ok(v4Info.poolRef === poolId, 'V4 discovery captures the poolId');

  const v4SwapLog = fakeLog(IFACES.v4PoolManager, 'Swap',
    [poolId, A(0x8888), 50_000000n, -50n*10n**18n, sqrtPriceX96, 0n, 0, 3000],
    { address: ARC.v4PoolManager });
  const v4Swap = decodeSwapV4(v4SwapLog, { usdcIsToken0: true, poolRef: poolId }, 6, 18, blockTime);
  ok(!!v4Swap, 'V4 Swap decodes');
  ok(v4Swap.side === 'buy', 'V4 swap side decodes correctly');
  ok(Math.abs(v4Swap.usdcAmount - 50) < 1e-6, 'V4 swap usdcAmount decimal-adjusted correctly');

  const wrongPool = decodeSwapV4(v4SwapLog, { usdcIsToken0: true, poolRef: ethers.zeroPadValue('0x0999', 32) }, 6, 18, blockTime);
  ok(wrongPool === null, 'V4 swap decode rejects a log for a different poolId');

  // --- ERC20 transfer
  const trLog = fakeLog(IFACES.erc20, 'Transfer', [A(0xf1), A(0xf2), 25n*10n**18n]);
  const tr = decodeTransfer(trLog, 18);
  ok(!!tr && Math.abs(tr.amount - 25) < 1e-9, 'ERC20 Transfer decodes and decimal-adjusts');

  console.log('\n=== schema + store.js against pg-mem ===');
  const db = freshDb();
  await store.upsertToken(db, { address: token, name: 'Test Coin', symbol: 'TST', decimals: 18, dex: 'v3', poolRef: v3PoolAddr, fee: 3000, usdcIsToken0: true, block: 100 });
  const known = await store.getKnownTokens(db, 'v3');
  ok(known.length === 1 && known[0].symbol === 'TST', 'upsertToken + getKnownTokens round-trip');

  await store.upsertToken(db, { address: token, name: 'dup', symbol: 'DUP', decimals: 18, dex: 'v3', poolRef: v3PoolAddr, fee: 3000, usdcIsToken0: true, block: 100 });
  const known2 = await store.getKnownTokens(db, 'v3');
  ok(known2.length === 1 && known2[0].symbol === 'TST', 'upsertToken is idempotent on the primary key (ON CONFLICT DO NOTHING)');

  console.log('\n=== queries.js: aggregation correctness ===');
  const now = new Date();
  const dayAgo = new Date(now.getTime() - 25 * 3600 * 1000);
  // three swaps: two inside the 24h window, one outside — 24h stats must exclude the old one
  await store.insertSwap(db, token, { block: 200, blockTime: dayAgo, txHash: '0xold', logIndex: 0, trader: '0xA', side: 'buy', usdcAmount: 1000, tokenAmount: 500, price: 2 });
  await store.insertSwap(db, token, { block: 201, blockTime: now, txHash: '0xnew1', logIndex: 0, trader: '0xB', side: 'buy', usdcAmount: 100, tokenAmount: 40, price: 2.5 });
  await store.insertSwap(db, token, { block: 202, blockTime: now, txHash: '0xnew2', logIndex: 0, trader: '0xC', side: 'sell', usdcAmount: 50, tokenAmount: 20, price: 2.5 });

  const rows = await listTokens(db, { sort: 'new', limit: 10, offset: 0 });
  ok(rows.length === 1, 'listTokens returns the one known token');
  const r = rows[0];
  ok(Math.abs(Number(r.volume_24h) - 150) < 1e-6, '24h volume excludes the swap from >24h ago (150, not 1150): got ' + r.volume_24h);
  ok(Number(r.txns_24h) === 2, '24h txns counts only the two recent swaps');
  ok(Number(r.traders_24h) === 2, '24h unique traders counts B and C, not A');
  ok(Math.abs(Number(r.price) - 2.5) < 1e-6, 'latest price is the most recent swap (2.5), not the oldest');

  // holders: two live balances, one zeroed out, one burned — only the two live ones should count
  await store.applyTransfer(db, token, { from: store.ZERO, to: '0xHolder1', amount: 100 });
  await store.applyTransfer(db, token, { from: store.ZERO, to: '0xHolder2', amount: 50 });
  await store.applyTransfer(db, token, { from: store.ZERO, to: '0xHolder3', amount: 10 });
  await store.applyTransfer(db, token, { from: '0xHolder3', to: store.DEAD, amount: 10 }); // holder3 burns their whole balance
  const rows2 = await listTokens(db, { sort: 'new', limit: 10, offset: 0 });
  ok(Number(rows2[0].holders) === 2, 'holders excludes zero-balance and burn-address rows: got ' + rows2[0].holders);

  // 24h % change: needs a snapshot from >24h ago to compare against
  await store.takeSnapshot(db, token, 2.0, dayAgo);
  const rows3 = await listTokens(db, { sort: 'change', limit: 10, offset: 0 });
  const pct = Number(rows3[0].change_24h);
  ok(Math.abs(pct - 25) < 0.01, '24h change computed correctly: (2.5-2.0)/2.0*100 = 25%, got ' + pct);

  const single = await getToken(db, token);
  ok(single && single.symbol === 'TST', 'getToken single-lookup uses the same aggregation and returns the right row');

  console.log('\n' + '='.repeat(52));
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(1); });
