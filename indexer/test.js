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
  // pg-mem ships very few builtins; FLOOR is real Postgres, register it so the
  // points SQL runs unmodified here.
  const { DataType } = require('pg-mem');
  db.public.registerFunction({ name: 'floor', args: [DataType.decimal], returns: DataType.decimal, implementation: x => Math.floor(Number(x)) });
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

  // --- block timestamps are only fetched for swaps we keep. The V4 PoolManager
  //     emits Swap for every pool on the chain; the ones on unknown (non-USDC)
  //     poolIds must not cost a getBlock each.
  console.log('\n=== blockTimeCache scope: only kept swaps cost a getBlock ===');
  const db3 = freshDb();
  const KNOWN_ID = '0x' + '11'.repeat(32), UNKNOWN_ID = '0x' + '22'.repeat(32);
  await store.upsertToken(db3, { address: A(0x7001), name:'V4', symbol:'VFOUR', decimals:18, dex:'v4', poolRef:KNOWN_ID, fee:3000, usdcIsToken0:true, block:50, metaOk:true });
  const v4swap = (id, bn) => fakeLog(IFACES.v4PoolManager, 'Swap', [id, A(0x9), 1_000_000n, -1n*10n**18n, sqrt, 0n, 0, 3000],
    { address: ARC.v4PoolManager, blockNumber: bn, txHash: '0x' + bn.toString(16).padStart(2,'0').repeat(32), logIndex: 0 });
  const v4Logs = [ v4swap(KNOWN_ID, 500), v4swap(KNOWN_ID, 501), ...Array.from({length: 40}, (_, i) => v4swap(UNKNOWN_ID, 600 + i)) ];
  const blockCalls = [];
  const p3 = {
    async getLogs(f) {
      const addrs=(Array.isArray(f.address)?f.address:[f.address]).map(a=>a.toLowerCase()); const tps=Array.isArray(f.topics[0])?f.topics[0]:[f.topics[0]];
      return v4Logs.filter(l=>addrs.includes(l.address.toLowerCase())&&tps.includes(l.topics[0]));
    },
    async getBlock(n) { blockCalls.push(n); return { timestamp: 1_700_000_000 + n }; },
  };
  const st3 = await processChunk(db3, p3, 400, 700);
  ok(JSON.stringify([...blockCalls].sort()) === JSON.stringify([400, 700]), 'block timestamps come from the 2 chunk boundaries only — not one per swap, not the 40 discarded swaps: got ' + JSON.stringify(blockCalls));
  ok(st3.swaps === 2, 'stats report kept swaps (2), not raw log count (42): got ' + st3.swaps);
  ok((await db3.query('SELECT count(*)::int AS n FROM swaps')).rows[0].n === 2, '2 swaps stored for the known USDC pool');

  // --- retry(): quota exhaustion fails fast; rate limits still back off
  console.log('\n=== retry: quota exhaustion is not retried, 429 is ===');
  const { retry: retryFn } = require('./worker');
  let quotaAttempts = 0; const t0 = Date.now();
  await retryFn(() => { quotaAttempts++; throw new Error('could not coalesce error (error={ "code": -32600, "message": "project ID exceeded quota" })'); }, 5, 50).catch(() => {});
  ok(quotaAttempts === 1, 'quota-exhausted call attempted exactly once, not 5: got ' + quotaAttempts);
  ok(Date.now() - t0 < 200, 'and returned immediately, no backoff sleep');
  let rlAttempts = 0;
  await retryFn(() => { rlAttempts++; if (rlAttempts < 3) throw new Error('429 Too Many Requests'); return 'ok'; }, 5, 5);
  ok(rlAttempts === 3, 'rate-limited call was retried until it succeeded (3 attempts)');

  // --- blockTimes: interpolation is exact for evenly spaced blocks, 2 calls max, 0 when idle
  console.log('\n=== blockTimes: 2 boundary fetches + linear interpolation ===');
  const { blockTimes, runChunk } = require('./worker');
  const bt = []; const p4 = { async getBlock(n) { bt.push(n); return { timestamp: 1_700_000_000 + n * 2 }; } }; // 2s blocks
  const m4 = await blockTimes(p4, 1000, 1100, [1000, 1050, 1099, 1100, 1050]);
  ok(bt.length === 2 && bt.includes(1000) && bt.includes(1100), 'fetched exactly the two boundary blocks: ' + JSON.stringify(bt));
  ok(m4.get(1050).getTime() === (1_700_000_000 + 1050 * 2) * 1000, 'interior block interpolated exactly on a regular chain');
  ok(m4.get(1099).getTime() === (1_700_000_000 + 1099 * 2) * 1000, 'block next to the boundary interpolated exactly');
  ok(m4.size === 4, 'duplicate block numbers collapse to one entry');
  bt.length = 0;
  ok((await blockTimes(p4, 1000, 1100, [])).size === 0 && bt.length === 0, 'no swaps -> no getBlock calls at all');
  bt.length = 0;
  const one = await blockTimes(p4, 500, 500, [500]);
  ok(bt.length === 1 && one.get(500).getTime() === (1_700_000_000 + 1000) * 1000, 'single-block chunk fetches once');

  // --- runChunk: BEGIN ... COMMIT on success, ROLLBACK on failure, client always released
  console.log('\n=== runChunk: one transaction per chunk ===');
  const mkPool = (failOn) => {
    const log = []; let released = 0;
    const client = { async query(sql, params) { const head = String(sql).trim().split(/\s+/).slice(0,2).join(' '); log.push(head);
        if (failOn && head.startsWith(failOn)) throw new Error('boom at ' + failOn); return { rows: [] }; }, release() { released++; } };
    return { pool: { async connect() { return client; } }, log, get released() { return released; } };
  };
  const okProv = { async getLogs() { return []; }, async getBlock() { return { timestamp: 1 }; } };
  const good = mkPool(null);
  await runChunk(good.pool, okProv, 10, 20);
  ok(good.log[0] === 'BEGIN' && good.log[good.log.length-1] === 'COMMIT', 'success path: BEGIN first, COMMIT last: ' + good.log[0] + ' … ' + good.log[good.log.length-1]);
  ok(good.log.some(h => h.startsWith('INSERT INTO')), 'setState ran inside the transaction');
  ok(good.released === 1, 'client released after success');
  const bad = mkPool('INSERT INTO');   // make the setState / any insert blow up
  let threw = false;
  try { await runChunk(bad.pool, okProv, 10, 20); } catch { threw = true; }
  ok(threw, 'failure propagates so the main loop logs and retries the chunk');
  ok(bad.log.includes('ROLLBACK') && !bad.log.includes('COMMIT'), 'failure path: ROLLBACK, never COMMIT: ' + bad.log.join(','));
  ok(bad.released === 1, 'client released after failure too');

  // --- memory bound: dense fetch aborts the chunk before processing; chunk size adapts
  console.log('\n=== memory bound: TooDense aborts early, chunk size halves then recovers ===');
  const { nextChunkSize, TooDense, MAX_LOGS_PER_CHUNK } = require('./worker');
  ok(nextChunkSize(9500, { tooDense: true }) === 4750, 'TooDense halves the chunk (9500 -> 4750)');
  ok(nextChunkSize(300, { tooDense: true }) === 200, 'never shrinks below MIN_CHUNK (200)');
  ok(nextChunkSize(4750, { logs: 100 }) === 9500, 'a quiet chunk doubles back, capped at LOG_CHUNK');
  ok(nextChunkSize(4750, { logs: MAX_LOGS_PER_CHUNK - 1 }) === 4750, 'a busy-but-OK chunk holds its size');
  ok(nextChunkSize(9500, { logs: 10 }) === 9500, 'already at max stays at max');

  // a provider whose first fetch returns MAX+1 logs: processChunk must throw TooDense
  // having done NO discovery, NO DB writes and NO further RPC calls.
  const db5 = freshDb();
  await store.upsertToken(db5, { address: T_OLD, name:'Old', symbol:'OLD', decimals:18, dex:'v3', poolRef:P_OLD, fee:3000, usdcIsToken0:true, block:50, metaOk:true });
  const flood = Array.from({ length: MAX_LOGS_PER_CHUNK + 1 }, (_, i) =>
    fakeLog(IFACES.v3Pool, 'Swap', [A(0x9), A(0x9), 1_000_000n, -1n*10n**18n, sqrt, 0n, 0], { address: P_OLD, blockNumber: 2000 + (i % 50), txHash: '0x' + i.toString(16).padStart(64, '0'), logIndex: i }));
  let fetches = 0, blockFetches = 0;
  const floodProvider = { async getLogs() { fetches++; return flood; }, async getBlock() { blockFetches++; return { timestamp: 1 }; } };
  let denseErr = null;
  try { await processChunk(db5, floodProvider, 2000, 2100); } catch (e) { denseErr = e; }
  ok(denseErr && denseErr.tooDense, 'processChunk throws TooDense on a flood: ' + (denseErr && denseErr.message));
  ok(fetches === 1, 'aborted after the FIRST getLogs — no follow-up, no transfers fetch: ' + fetches);
  ok(blockFetches === 0, 'no block timestamps fetched for a chunk that was abandoned');
  ok((await db5.query('SELECT count(*)::int n FROM swaps')).rows[0].n === 0, 'nothing written to the DB for the abandoned chunk');

  // runChunk surfaces TooDense unchanged (so the loop can shrink) and still rolls back
  const tp = mkPool(null);
  let surfaced = null;
  try { await runChunk(tp.pool, floodProvider, 2000, 2100); } catch (e) { surfaced = e; }
  ok(surfaced && surfaced.tooDense && tp.log.includes('ROLLBACK') && tp.released === 1, 'runChunk passes TooDense through after ROLLBACK + release');

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

  // =====================================================================
  //  LAUNCHPAD + POINTS
  // =====================================================================
  console.log('\n=== process.js: ArclitePump events decode (18dp native USDC) ===');
  const { decodeTokenCreated, decodeLaunchTrade } = require('./process');
  const PUMP = A(0xabc0);
  const LT = A(0xabc1), BUYER = A(0xb001), SELLER = A(0xb002), CREATOR = A(0xc001);
  const tp0 = new Date("2026-09-06T00:00:00Z");
  const createdLog = fakeLog(IFACES.pump, 'TokenCreated', [LT, CREATOR, 'Launch Token', 'LT'], { address: PUMP, blockNumber: 500, txHash: '0x'+'c1'.repeat(32), logIndex: 0 });
  const lt = decodeTokenCreated(createdLog, tp0);
  ok(lt && lt.address === LT.toLowerCase() && lt.creator === CREATOR.toLowerCase() && lt.symbol === 'LT', 'TokenCreated decodes token, creator, symbol');
  const boughtLog = fakeLog(IFACES.pump, 'Bought', [LT, BUYER, 12n * 10n**18n + 5n * 10n**17n, 1000n * 10n**18n], { address: PUMP, blockNumber: 501, txHash: '0x'+'c2'.repeat(32), logIndex: 0 });
  const b1 = decodeLaunchTrade(boughtLog, tp0);
  ok(b1 && b1.side === 'buy' && b1.trader === BUYER.toLowerCase(), 'Bought decodes as a buy by the buyer');
  ok(b1 && Math.abs(b1.usdcAmount - 12.5) < 1e-9, 'Bought usdcIn formatted with 18 decimals (12.5 USDC), got ' + (b1 && b1.usdcAmount));
  const soldLog = fakeLog(IFACES.pump, 'Sold', [LT, SELLER, 400n * 10n**18n, 3n * 10n**18n], { address: PUMP, blockNumber: 502, txHash: '0x'+'c3'.repeat(32), logIndex: 1 });
  const s1 = decodeLaunchTrade(soldLog, tp0);
  ok(s1 && s1.side === 'sell' && s1.trader === SELLER.toLowerCase() && s1.usdcAmount === 3, 'Sold decodes as a sell with usdcOut = 3');
  ok(decodeLaunchTrade(createdLog, tp0) === null, 'decodeLaunchTrade ignores non-trade pump events');
  ok(decodeLaunchTrade(fakeLog(IFACES.v3Pool, 'Swap', [A(9), A(9), 1n, -1n, 1n, 0n, 0]), tp0) === null, 'decodeLaunchTrade ignores a Uniswap swap');

  console.log('\n=== worker.processChunk: launchpad rides in the merged call when PUMP_ADDRESS is set ===');
  process.env.PUMP_ADDRESS = PUMP;
  const dbp = freshDb();
  const pumpChain = [
    createdLog, boughtLog, soldLog,
    // same Bought signature from a non-pump address must be ignored
    fakeLog(IFACES.pump, 'Bought', [LT, A(0xbad), 999n * 10n**18n, 1n], { address: A(0xdead1), blockNumber: 503, txHash: '0x'+'c4'.repeat(32), logIndex: 0 }),
  ];
  const pumpCalls = [];
  const pumpProvider = {
    async getLogs(f) {
      pumpCalls.push(f);
      const addrs = (Array.isArray(f.address) ? f.address : [f.address]).map(a => a.toLowerCase());
      const topics = Array.isArray(f.topics[0]) ? f.topics[0] : [f.topics[0]];
      return pumpChain.filter(l => addrs.includes(l.address.toLowerCase()) && topics.includes(l.topics[0])
        && l.blockNumber >= f.fromBlock && l.blockNumber <= f.toBlock);
    },
    async getBlock(n) { return { timestamp: 1_700_000_000 + n }; },
  };
  const pst = await processChunk(dbp, pumpProvider, 400, 600);
  ok(pumpCalls.length === 1, 'quiet DEX + pump activity = 1 getLogs (merged), got ' + pumpCalls.length);
  ok(pumpCalls[0].address.map(a=>a.toLowerCase()).includes(PUMP.toLowerCase()), 'merged call includes the pump address');
  ok(pumpCalls[0].topics[0].length === 7, 'merged call ORs 4 DEX + 3 pump topics, got ' + pumpCalls[0].topics[0].length);
  ok(pst.launched === 1 && pst.launchTrades === 2, 'stats: 1 launched, 2 launch trades');
  const ltRows = (await dbp.query('SELECT trader, side, usdc_amount FROM launch_trades ORDER BY block_number')).rows;
  ok(ltRows.length === 2, 'both pump trades stored, the spoofed one from another address is not (got ' + ltRows.length + ')');
  ok(ltRows.some(r => r.trader === BUYER.toLowerCase() && Number(r.usdc_amount) === 12.5), 'buy stored with 12.5 USDC');
  ok((await dbp.query('SELECT creator FROM launch_tokens')).rows[0].creator === CREATOR.toLowerCase(), 'launch_tokens row has the creator');
  // idempotent — re-running the chunk (crash + resume) doesn't double count
  await processChunk(dbp, pumpProvider, 400, 600);
  ok((await dbp.query('SELECT COUNT(*) AS n FROM launch_trades')).rows[0].n == 2, 'replaying the chunk does not duplicate launch trades');
  delete process.env.PUMP_ADDRESS;
  pumpCalls.length = 0;
  await processChunk(dbp, pumpProvider, 700, 800);
  ok(pumpCalls[0].topics[0].length === 4 && !pumpCalls[0].address.map(a=>a.toLowerCase()).includes(PUMP.toLowerCase()), 'with PUMP_ADDRESS unset the merged call is exactly the DEX shape');

  console.log('\n=== queries: points = floor(launchpad volume) + shares; leaderboard + rank ===');
  const { getStats, recentSwaps, pointsLeaderboard, pointsForWallet } = require('./queries');
  // BUYER: 12.5 volume -> 12 pts. SELLER: 3 volume -> 3 pts. Add shares.
  ok(await store.addSharePoint(dbp, BUYER, LT, '2026-09-06') === true, 'first share for (wallet, token, day) is credited');
  ok(await store.addSharePoint(dbp, BUYER, LT, '2026-09-06') === false, 'same (wallet, token, day) again is NOT credited — PK is the cap');
  ok(await store.addSharePoint(dbp, BUYER, A(0xabc2), '2026-09-06') === true, 'a different token the same day is credited');
  ok(await store.addSharePoint(dbp, BUYER, LT, '2026-09-07') === true, 'the same token the next day is credited');
  const SHARER = A(0xd001); // shares only, never traded
  ok(await store.addSharePoint(dbp, SHARER, LT, '2026-09-06') === true, 'a wallet with no trades can still earn share points');
  ok(await store.sharesToday(dbp, BUYER, '2026-09-06') === 2, 'sharesToday counts per UTC day (2 on the 6th)');

  const board = await pointsLeaderboard(dbp, 10);
  ok(board.traders === 3, 'leaderboard counts every wallet with volume OR shares (3), got ' + board.traders);
  const byW = Object.fromEntries(board.rows.map(r => [r.wallet, r]));
  ok(byW[BUYER.toLowerCase()].points === 15, 'BUYER: floor(12.5) + 3 shares = 15, got ' + byW[BUYER.toLowerCase()].points);
  ok(byW[SELLER.toLowerCase()].points === 3 && byW[SELLER.toLowerCase()].volume === 3, 'SELLER: sells count as volume (3)');
  ok(byW[SHARER.toLowerCase()].points === 1 && byW[SHARER.toLowerCase()].volume === 0, 'SHARER: 1 point, zero volume');
  ok(board.rows[0].wallet === BUYER.toLowerCase(), 'sorted by points desc');
  const meB = await pointsForWallet(dbp, BUYER);
  ok(meB.rank === 1 && meB.points === 15, 'pointsForWallet: rank 1 for the leader');
  const meS = await pointsForWallet(dbp, SHARER);
  ok(meS.rank === 3, 'pointsForWallet: rank 3 for the share-only wallet, got ' + meS.rank);
  const nobody = await pointsForWallet(dbp, A(0xeeee));
  ok(nobody.points === 0 && nobody.rank === null, 'unknown wallet: 0 points, no rank');

  const st = await getStats(dbp);
  ok(st.launched === 1 && st.tokens === 0 && typeof st.volume24h === 'number', 'getStats returns launchpad + DEX counters');
  const rs = await recentSwaps(db2, 5);
  ok(rs.length === 2 && rs[0].symbol !== undefined, 'recentSwaps joins symbol onto the newest swaps (from the DEX db)');

  console.log('\n=== api: POST /points/share — wallet signature required, day-bound, capped ===');
  const { makeApp, shareMessage, utcDay, SHARE_DAILY_CAP } = require('./api');
  const app = makeApp(dbp);
  const srv = await new Promise(r => { const h = app.listen(0, () => r(h)); });
  const base = 'http://127.0.0.1:' + srv.address().port;
  const wallet = ethers.Wallet.createRandom();
  const today = utcDay();
  const post = async body => { const r = await fetch(base + '/api/v1/points/share', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  const sig = await wallet.signMessage(shareMessage(wallet.address, LT, today));
  let r1 = await post({ wallet: wallet.address, token: LT, day: today, signature: sig });
  ok(r1.status === 200 && r1.body.awarded === true && r1.body.sharesToday === 1, 'valid signed share is credited');
  r1 = await post({ wallet: wallet.address, token: LT, day: today, signature: sig });
  ok(r1.status === 200 && r1.body.awarded === false, 'replaying the same share is accepted but not credited twice');
  const other = ethers.Wallet.createRandom();
  const wrongSig = await other.signMessage(shareMessage(wallet.address, LT, today));
  r1 = await post({ wallet: wallet.address, token: LT, day: today, signature: wrongSig });
  ok(r1.status === 401, 'a signature from a different key is rejected (401)');
  r1 = await post({ wallet: wallet.address, token: LT, day: '2020-01-01', signature: sig });
  ok(r1.status === 400 && r1.body.error === 'stale day', 'a signature for another day is rejected (400 stale day)');
  r1 = await post({ wallet: 'nope', token: LT, day: today, signature: sig });
  ok(r1.status === 400, 'malformed wallet is rejected');
  // cap: fill up to SHARE_DAILY_CAP distinct tokens, the next is 429
  let capHit = null;
  for (let i = 1; i <= SHARE_DAILY_CAP; i++) {
    const tok = A(0xf000 + i);
    const sg = await wallet.signMessage(shareMessage(wallet.address, tok, today));
    capHit = await post({ wallet: wallet.address, token: tok, day: today, signature: sg });
    if (capHit.status === 429) break;
  }
  ok(capHit && capHit.status === 429 && capHit.body.sharesToday === SHARE_DAILY_CAP, `daily cap enforced at ${SHARE_DAILY_CAP} (got ${capHit && capHit.status})`);
  const lb = await (await fetch(base + '/api/v1/points/leaderboard?limit=5')).json();
  ok(lb.rules && lb.rules.season === 'pre' && Array.isArray(lb.leaderboard), 'leaderboard reports season=pre without PUMP_ADDRESS');
  const mine = await (await fetch(base + '/api/v1/points/' + wallet.address)).json();
  ok(mine.sharesToday === SHARE_DAILY_CAP && mine.points === SHARE_DAILY_CAP, 'per-wallet endpoint returns sharesToday + points');
  const hstats = await (await fetch(base + '/api/v1/stats')).json();
  ok(hstats.launched === 1 && 'volume24h' in hstats, '/stats serves hero-strip numbers');
  const pre = await fetch(base + '/api/v1/points/share', { method:'OPTIONS' });
  ok(pre.status === 204 && pre.headers.get('access-control-allow-methods').includes('POST'), 'CORS preflight allows POST from the browser');
  srv.close();

  console.log('\n' + '='.repeat(52));
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(1); });
