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
  await store.upsertToken(db, { address: token, name: 'Test Coin', symbol: 'TST', decimals: 18, dex: 'v3', poolRef: v3PoolAddr, fee: 3000, usdcIsToken0: true, block: 100, metaOk: true });
  const known = await store.getKnownTokens(db, 'v3');
  ok(known.length === 1 && known[0].symbol === 'TST', 'upsertToken + getKnownTokens round-trip');

  await store.upsertToken(db, { address: token, name: 'dup', symbol: 'DUP', decimals: 18, dex: 'v3', poolRef: v3PoolAddr, fee: 3000, usdcIsToken0: true, block: 100, metaOk: true });
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

  // --- meta_ok gating: a token whose decimals we never read must not publish a price ---
  console.log('\n=== meta_ok gating (unverified decimals must not produce a price) ===');
  const ghost = A(0x9f9f);
  await store.upsertToken(db, { address: ghost, name: '', symbol: '', decimals: 18, dex: 'v3', poolRef: A(0x9e9e), fee: 3000, usdcIsToken0: true, block: 101, metaOk: false });
  await store.insertSwap(db, ghost, { block: 101, blockTime: new Date(), txHash: '0xfeed', logIndex: 1, trader: A(0x2222), side: 'buy', usdcAmount: 10, tokenAmount: 5, price: 999 });

  const missing = await store.getTokensMissingMeta(db, 10);
  ok(missing.length === 1 && missing[0].toLowerCase() === ghost.toLowerCase(),
     'getTokensMissingMeta finds only the token with unread metadata');

  const rowsGated = await listTokens(db, { sort: 'new', limit: 10, offset: 0 });
  const ghostRow = rowsGated.find(r => r.address.toLowerCase() === ghost.toLowerCase());
  ok(ghostRow && ghostRow.price === null,
     'price is NULL while decimals is unverified, not a confidently wrong number: got ' + (ghostRow && ghostRow.price));

  const goodRow = rowsGated.find(r => r.address.toLowerCase() === token.toLowerCase());
  ok(goodRow && Number(goodRow.price) === 2.5,
     'a verified token still reports its real price alongside: got ' + (goodRow && goodRow.price));

  await store.updateTokenMeta(db, ghost, { name: 'Late Coin', symbol: 'LATE', decimals: 6 });
  const afterFix = (await listTokens(db, { sort: 'new', limit: 10, offset: 0 }))
    .find(r => r.address.toLowerCase() === ghost.toLowerCase());
  ok(afterFix && afterFix.symbol === 'LATE' && Number(afterFix.decimals) === 6 && Number(afterFix.price) === 999,
     'once metadata is backfilled the token gains its symbol, real decimals and a published price');

  ok((await store.getTokensMissingMeta(db, 10)).length === 0,
     'backfilled token no longer appears in the missing-metadata queue');

  // --- processChunk end-to-end against a MOCK provider: proves the single merged
  //     getLogs call yields the same rows as the old five, including the edge
  //     case of a pool created and traded inside the same chunk.
  console.log('\n=== worker.processChunk: merged log fetch (2 getLogs per chunk, not 5) ===');
  const { processChunk } = require('./worker');
  const db2 = freshDb();
  const sqrt = 79228162514264337593543950336n; // 2^96 -> price 1.0 before decimals
  const T_OLD = A(0x5001), P_OLD = A(0x5002);   // known pool, discovered in an earlier chunk
  const T_NEW = A(0x6001), P_NEW = A(0x6002);   // created AND traded in this chunk
  await store.upsertToken(db2, { address: T_OLD, name:'Old', symbol:'OLD', decimals:18, dex:'v3', poolRef:P_OLD, fee:3000, usdcIsToken0:true, block:50, metaOk:true });

  const chainLogs = [
    fakeLog(IFACES.v3Pool,    'Swap',        [A(0x9), A(0x9), 1_000_000n, -5n*10n**18n, sqrt, 0n, 0], { address:P_OLD, blockNumber:120, txHash:'0x'+'a1'.repeat(32), logIndex:0 }),
    fakeLog(IFACES.v3Factory, 'PoolCreated', [usdc, T_NEW, 3000, 60, P_NEW],                              { address:ARC.v3Factory, blockNumber:121, txHash:'0x'+'a2'.repeat(32), logIndex:0 }),
    fakeLog(IFACES.v3Pool,    'Swap',        [A(0x9), A(0x9), 2_000_000n, -7n*10n**18n, sqrt, 0n, 0], { address:P_NEW, blockNumber:122, txHash:'0x'+'a3'.repeat(32), logIndex:0 }),
    fakeLog(IFACES.erc20,     'Transfer',    [A(0x9), A(0x8), 5n*10n**18n],                                { address:T_OLD, blockNumber:120, txHash:'0x'+'a1'.repeat(32), logIndex:1 }),
    fakeLog(IFACES.erc20,     'Transfer',    [A(0x9), A(0x7), 2n*10n**18n],                                { address:T_OLD, blockNumber:123, txHash:'0x'+'a4'.repeat(32), logIndex:0 }),
  ];
  const calls = [];
  const mockProvider = {
    async getLogs(f) {
      calls.push(f);
      const addrs = (Array.isArray(f.address) ? f.address : [f.address]).map(a => a.toLowerCase());
      const topics = Array.isArray(f.topics[0]) ? f.topics[0] : [f.topics[0]];
      return chainLogs.filter(l => addrs.includes(l.address.toLowerCase()) && topics.includes(l.topics[0])
        && l.blockNumber >= f.fromBlock && l.blockNumber <= f.toBlock);
    },
    async getBlock(n) { return { timestamp: 1_700_000_000 + n }; },
  };
  const stats = await processChunk(db2, mockProvider, 100, 200);

  const logCalls = calls.length;
  ok(logCalls === 3, 'chunk with a new pool costs 3 getLogs (merged + follow-up for the new pool + transfers), got ' + logCalls);
  ok(Array.isArray(calls[0].topics[0]) && calls[0].topics[0].length === 4, 'first call ORs all four discovery/swap topics in one request');
  ok(calls[0].address.map(a=>a.toLowerCase()).includes(P_OLD.toLowerCase()), 'first call includes the already-known pool address');
  const swaps = (await db2.query('SELECT token_address, usdc_amount FROM swaps ORDER BY block_number')).rows;
  ok(swaps.length === 2, 'both swaps stored, got ' + swaps.length);
  ok(swaps.some(s => s.token_address === T_NEW.toLowerCase() && Number(s.usdc_amount) === 2),
     'swap on the pool created in the SAME chunk is captured (follow-up call worked)');
  ok(swaps.some(s => s.token_address === T_OLD.toLowerCase() && Number(s.usdc_amount) === 1),
     'swap on the previously-known pool captured from the merged call');
  const bal = (await db2.query("SELECT holder, balance FROM balances WHERE token_address=$1 ORDER BY holder", [T_OLD.toLowerCase()])).rows;
  const b = Object.fromEntries(bal.map(r => [r.holder, Number(r.balance)]));
  ok(b[A(0x8).toLowerCase()] === 5 && b[A(0x7).toLowerCase()] === 2, 'transfer credits recipients (+5, +2)');
  ok(b[A(0x9).toLowerCase()] === -7, 'sender debited across INSERT then UPDATE paths (-5 then -2 = -7), got ' + b[A(0x9).toLowerCase()]);
  ok(bal.filter(r => Number(r.balance) > 0).length === 2, 'holders = 2 (sender is net negative, never counted)');
  ok((await store.getKnownTokens(db2,'v3')).length === 2, 'new pool discovered and stored');

  // a quiet chunk (nothing new) must be exactly 2 calls
  calls.length = 0;
  await processChunk(db2, mockProvider, 300, 400);
  ok(calls.length === 2, 'quiet chunk costs exactly 2 getLogs, got ' + calls.length);

  // --- getLogsAdaptive: Infura's 20k-result cap, reproduced verbatim, must be
  //     survived by splitting — and nothing may be lost or duplicated in the seam.
  console.log('\n=== getLogsAdaptive: provider result cap -> split, no loss, no duplicates ===');
  const { getLogsAdaptive } = require('./worker');
  // 30 swap logs spread over blocks 1000..1029 on the known pool; provider refuses
  // any query whose range would return more than 12 of them, with Infura's phrasing
  // and a suggested end block, exactly like the live error.
  const dense = Array.from({ length: 30 }, (_, i) =>
    fakeLog(IFACES.v3Pool, 'Swap', [A(0x9), A(0x9), 1_000_000n, -1n*10n**18n, sqrt, 0n, 0],
      { address: P_OLD, blockNumber: 1000 + i, txHash: '0x' + (0xb0 + i).toString(16).padStart(2,'0').repeat(32), logIndex: 0 }));
  const capCalls = [];
  const cappedProvider = {
    async getLogs(f) {
      capCalls.push([Number(f.fromBlock), Number(f.toBlock)]);
      const hits = dense.filter(l => l.blockNumber >= Number(f.fromBlock) && l.blockNumber <= Number(f.toBlock));
      if (hits.length > 12) {
        const suggestedEnd = Number(f.fromBlock) + 11;   // what Infura does: "retry with the range A-B"
        const err = new Error(`could not coalesce error (error={ "code": -32602, "message": "query exceeds max results 20000, retry with the range ${f.fromBlock}-${suggestedEnd}" })`);
        throw err;
      }
      return hits;
    },
  };
  const got = await getLogsAdaptive(cappedProvider, { address: [P_OLD], topics: [[TOPICS.v3Swap]], fromBlock: 1000, toBlock: 1029 });
  ok(got.length === 30, 'all 30 logs recovered across the splits, got ' + got.length);
  ok(new Set(got.map(l => l.transactionHash)).size === 30, 'no duplicates at the split seams');
  ok(got.every((l, i) => i === 0 || l.blockNumber >= got[i-1].blockNumber), 'results come back in block order');
  ok(capCalls.some(([a, b]) => b - a + 1 === 12), 'used the provider\'s suggested range (12 blocks), not blind halving');
  ok(capCalls.length <= 8, 'bounded number of calls for a 30-log range, got ' + capCalls.length);

  // a transient error must still be retried, and a non-cap error must not be split
  let flaky = 0;
  const flakyProvider = { async getLogs(f) { if (++flaky < 3) throw new Error('ECONNRESET'); return [dense[0]]; } };
  ok((await getLogsAdaptive(flakyProvider, { address:[P_OLD], topics:[[TOPICS.v3Swap]], fromBlock:1000, toBlock:1000 })).length === 1 && flaky === 3,
     'transient network error is retried (3 attempts), not split');

  console.log('\n' + '='.repeat(52));
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(1); });
