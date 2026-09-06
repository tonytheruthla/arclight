#!/usr/bin/env node
// The indexer. Backfills from START_BLOCK (or wherever it last stopped),
// then polls forever. Run this as a long-lived process (Railway "worker"
// service, not a web service) — see DEPLOY.md.
require('dotenv').config();
const { ethers } = require('ethers');
const { ARC, TOPICS, pumpAddress } = require('./chain');
const { decodePoolCreatedV3, decodeInitializeV4, decodeSwapV3, decodeSwapV4, decodeTransfer, decodeTokenCreated, decodeLaunchTrade } = require('./process');
const { getState, setState, upsertToken, getKnownTokens, getTokensMissingMeta, updateTokenMeta, insertSwap, applyTransfer, takeSnapshot, upsertLaunchToken, insertLaunchTrade } = require('./store');
const { listTokens } = require('./queries');
const { makePool, migrate } = require('./db');

const LOG_CHUNK = 9500;               // Arc's eth_getLogs caps at 10k blocks — same limit terminal.html works around
/* Provider credit budget (Infura free tier: 3M credits/day; eth_getLogs = 255,
 * eth_call / getBlock / blockNumber = 80). Each poll that finds new blocks costs
 * 2 getLogs + 1 blockNumber ≈ 590 credits, plus 80 per unique swap block.
 *   30s polling  -> 2,880 polls/day -> ~1.7M/day steady state. Fits.
 *   20s polling  -> ~2.5M/day. Fits, no headroom for metadata backfill.
 * Before the merge below it was 5 getLogs per poll ≈ 6M/day, i.e. 2x the free tier.
 * CHUNK_DELAY_MS paces the initial backfill so it can't blow the daily quota in
 * one go (663 chunks x ~1,800 ≈ 1.2M, so 0 is fine; raise it if you're sharing
 * the key with something else). PAUSED=1 idles the worker without a redeploy —
 * use it to hand the whole quota to a deploy for an hour. */
/* Memory bound. The worker runs in a ~512MB container. A launch-wave range can
 * put 14,000 swaps and far more transfers in one 9,500-block chunk; held as ethers
 * Log objects across three arrays plus one transaction, that peaked at ~600MB and
 * the kernel killed it — then it restarted into the same chunk. So any single
 * fetch that comes back with more than MAX_LOGS_PER_CHUNK logs aborts the chunk
 * BEFORE processing (one wasted getLogs, ~255 credits) and the main loop retries
 * it at half the block range. Chunk size grows back once ranges are quiet. */
const MAX_LOGS_PER_CHUNK = Number(process.env.MAX_LOGS_PER_CHUNK || 6000);
const MIN_CHUNK          = 200;
class TooDense extends Error {
  constructor(count, from, to) { super(`${count} logs in ${from}-${to} exceeds MAX_LOGS_PER_CHUNK=${MAX_LOGS_PER_CHUNK}`); this.tooDense = true; }
}
/** Next chunk size after a chunk outcome. Halve on TooDense (floor MIN_CHUNK);
 *  double back toward LOG_CHUNK once a chunk comes in well under the cap. */
function nextChunkSize(current, { tooDense = false, logs = 0 } = {}) {
  if (tooDense) return Math.max(MIN_CHUNK, Math.floor(current / 2));
  if (logs < MAX_LOGS_PER_CHUNK / 4 && current < LOG_CHUNK) return Math.min(LOG_CHUNK, current * 2);
  return current;
}

const POLL_INTERVAL_MS   = Number(process.env.POLL_INTERVAL_MS || 30_000);
const CHUNK_DELAY_MS     = Number(process.env.CHUNK_DELAY_MS || 0);
const PAUSED             = process.env.PAUSED === '1';
const SNAPSHOT_INTERVAL_MS = 10 * 60 * 1000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Quota exhaustion is not transient — the provider will refuse the same call
 *  until its daily reset, so backing off and retrying only burns wall-clock time.
 *  Observed live: 5 tries x 3 fields with backoff made each newly discovered
 *  token cost ~20s of pure waiting, turning a dense chunk into a ten-minute stall.
 *  Rate limits (429) ARE transient and still get the backoff. */
const isQuotaExhausted = msg => /exceeded quota|quota exceeded|daily (request )?limit|\b402\b/i.test(String(msg || ''));

async function retry(fn, tries = 5, baseMs = 1000) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) {
      last = e;
      const m = String(e && (e.message || e));
      if (isQuotaExhausted(m)) break;                 // fail fast; backfillMeta repairs later
      if (i === tries - 1) break;
      await sleep(/limit|429|-32011/i.test(m) ? baseMs * (i + 2) : baseMs * (i + 1));
    }
  }
  throw last;
}

/** Reads name/symbol/decimals via eth_call. These fail independently of log
 *  scanning — an exhausted provider quota rejects eth_call while still serving
 *  eth_getLogs, which is exactly how tokens ended up recorded with blank names
 *  and a guessed 18 decimals. `ok` reports whether decimals is REAL: every price
 *  is decimal-adjusted, so a guessed 18 on a 6-decimal token is off by 10^12.
 *  Callers must not publish a price when ok is false. */
async function tokenMeta(provider, addr, tries = 5) {
  const c = new ethers.Contract(addr, [
    'function name() view returns (string)',
    'function symbol() view returns (string)',
    'function decimals() view returns (uint8)',
  ], provider);
  const FAIL = Symbol('fail');
  let lastErr = '';
  const grab = fn => retry(fn, tries).catch(e => { lastErr = String(e && (e.message || e)); return FAIL; });
  const [name, symbol, decimals] = await Promise.all([
    grab(() => c.name()),
    grab(() => c.symbol()),
    grab(() => c.decimals()),
  ]);
  // name/symbol are cosmetic and some legitimate tokens return bytes32 or omit
  // them entirely; decimals is the one that must be real for prices to mean
  // anything, so it alone gates ok.
  return {
    name: name === FAIL ? '' : name,
    symbol: symbol === FAIL ? '' : symbol,
    decimals: decimals === FAIL ? 18 : Number(decimals),
    ok: decimals !== FAIL,
    err: lastErr,
  };
}

/** True for errors that mean "the provider is refusing everyone right now", as
 *  opposed to "this particular contract has no decimals()". Retrying the former
 *  across a whole batch just burns more of the quota that's already gone. */
const isProviderLimit = msg => /quota|rate limit|too many requests|429|-32005|-32600/i.test(String(msg || ''));

/** Re-read metadata for tokens we couldn't read at discovery time. Without this
 *  a token discovered during a quota outage stays nameless and mispriced
 *  forever, because upsertToken is ON CONFLICT DO NOTHING. Small batch per tick
 *  so it can't itself become the thing that burns the quota. */
async function backfillMeta(db, provider, limit = 5) {
  const addrs = await getTokensMissingMeta(db, limit);
  let fixed = 0;
  for (const addr of addrs) {
    // tries=1: this runs on a loop anyway, so burning 5 retries per field against
    // a provider that's already refusing calls just wastes quota.
    const meta = await tokenMeta(provider, addr, 1);
    if (!meta.ok) {
      if (isProviderLimit(meta.err)) {
        console.log('[meta] provider is refusing calls; pausing backfill this cycle');
        break;                           // whole batch would fail the same way
      }
      continue;                          // this one token is odd; try the rest
    }
    await updateTokenMeta(db, addr, meta);
    fixed++;
    console.log(`[meta] ${meta.symbol || '?'} ${addr} decimals=${meta.decimals}`);
  }
  return fixed;
}

/** Block timestamps for every swap in a chunk from TWO getBlock calls, not one
 *  per unique block. We fetch the chunk's first and last block and interpolate
 *  linearly between them. block_time only feeds the 24h aggregation windows
 *  and the 24h change, where being a few seconds off is irrelevant — while a
 *  dense chunk can touch thousands of unique blocks, which at 80 credits a
 *  fetch was both the slowest phase of a chunk and the largest single line in
 *  the credit budget. On the live tail chunks are tens of blocks wide, so the
 *  interpolation is near-exact there anyway. Zero calls if there's nothing to
 *  timestamp. */
async function blockTimes(provider, fromBlock, toBlock, blockNumbers) {
  const cache = new Map();
  const uniq = [...new Set(blockNumbers)];
  if (!uniq.length) return cache;
  const lo = Math.min(fromBlock, ...uniq), hi = Math.max(toBlock, ...uniq);
  const [a, b] = await Promise.all([
    retry(() => provider.getBlock(lo)),
    hi === lo ? null : retry(() => provider.getBlock(hi)),
  ]);
  const tsLo = Number(a.timestamp), tsHi = b ? Number(b.timestamp) : tsLo;
  const perBlock = hi > lo ? (tsHi - tsLo) / (hi - lo) : 0;
  for (const bn of uniq) cache.set(bn, new Date((tsLo + (bn - lo) * perBlock) * 1000));
  return cache;
}

/** eth_getLogs with automatic range splitting. Providers cap results per call
 *  (Infura: 20,000, error -32602 "query exceeds max results 20000, retry with
 *  the range A-B"). A busy 9,500-block window of V4 swaps trips it. When that
 *  happens we split — using the provider's suggested end block when it gives
 *  one, halving otherwise — and stitch the pieces back together. Quiet ranges
 *  still cost one call; only genuinely dense ranges pay for more. */
async function getLogsAdaptive(provider, filter, depth = 0) {
  const from = Number(filter.fromBlock), to = Number(filter.toBlock);
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const logs = await provider.getLogs(filter);
      if (logs.length > MAX_LOGS_PER_CHUNK) throw new TooDense(logs.length, from, to);
      return logs;
    } catch (e) {
      if (e && e.tooDense) throw e;
      const msg = String(e && (e.message || e));
      const capped = /exceeds max results|too many results|response size|query timeout|-32602/i.test(msg);
      if (capped) {
        // Deterministic — the same query will fail the same way. Don't retry it,
        // split it. Use the provider's suggested end block when it offers one.
        if (!(to > from) || depth > 12) throw e;
        const m = msg.match(/range\s+(\d+)\s*-\s*(\d+)/);
        let mid = m ? Number(m[2]) : Math.floor((from + to) / 2);
        if (!(mid >= from && mid < to)) mid = Math.floor((from + to) / 2);
        console.log(`[split] ${from}-${to} exceeded the provider result cap; retrying as ${from}-${mid} + ${mid + 1}-${to}`);
        const a = await getLogsAdaptive(provider, { ...filter, fromBlock: from, toBlock: mid }, depth + 1);
        if (a.length > MAX_LOGS_PER_CHUNK) throw new TooDense(a.length, from, mid);
        const b = await getLogsAdaptive(provider, { ...filter, fromBlock: mid + 1, toBlock: to }, depth + 1);
        if (a.length + b.length > MAX_LOGS_PER_CHUNK) throw new TooDense(a.length + b.length, from, to);
        return a.concat(b);
      }
      lastErr = e;                                   // transient: back off and retry
      await sleep(/limit|429|-32011/i.test(msg) ? 2000 * (attempt + 1) : 1000 * (attempt + 1));
    }
  }
  throw lastErr;
}

async function processChunk(db, provider, fromBlock, toBlock) {
  // ---- 1. ONE getLogs for discovery AND swaps on every pool we already know.
  // eth_getLogs accepts an address list and an OR-list of topics, so factory
  // PoolCreated, PoolManager Initialize, and Swap events from all known V3 pools
  // + the V4 manager come back in a single 255-credit call instead of four.
  // Swaps for pools discovered *in this very chunk* aren't in the address list
  // yet; those get one small follow-up call below, only when it happens.
  const knownV3Before = await getKnownTokens(db, 'v3');
  // The Arclite launchpad rides in the same call when it's deployed on this
  // chain: three more topics on one more address, zero extra credits.
  const PUMP = pumpAddress();
  const merged = await getLogsAdaptive(provider, {
    address: [ARC.v3Factory, ARC.v4PoolManager, ...(PUMP ? [PUMP] : []), ...knownV3Before.map(t => t.pool_ref)],
    topics: [[TOPICS.poolCreated, TOPICS.v4Initialize, TOPICS.v3Swap, TOPICS.v4Swap,
              ...(PUMP ? [TOPICS.pumpCreated, TOPICS.pumpBought, TOPICS.pumpSold] : [])]],
    fromBlock, toBlock,
  });
  const byTopic = t => merged.filter(l => l.topics && l.topics[0] === t);
  const poolCreatedLogs = byTopic(TOPICS.poolCreated);
  const initLogs        = byTopic(TOPICS.v4Initialize);
  let   v3SwapLogs      = byTopic(TOPICS.v3Swap);
  let   v4SwapLogs      = byTopic(TOPICS.v4Swap);
  // Only logs actually emitted by the pump count — a random token could emit
  // an event with the same signature, and the address filter above is an OR.
  const fromPump = l => PUMP && l.address && l.address.toLowerCase() === PUMP.toLowerCase();
  const pumpCreatedLogs = byTopic(TOPICS.pumpCreated).filter(fromPump);
  const pumpTradeLogs   = [...byTopic(TOPICS.pumpBought), ...byTopic(TOPICS.pumpSold)].filter(fromPump);

  const newV3Pools = [];
  for (const log of poolCreatedLogs) {
    const info = decodePoolCreatedV3(log, ARC.usdc);
    if (!info) continue;
    const meta = await tokenMeta(provider, info.token);
    await upsertToken(db, { address: info.token, ...meta, dex: 'v3', poolRef: info.poolRef, fee: info.fee, usdcIsToken0: info.usdcIsToken0, block: info.block, metaOk: meta.ok });
    newV3Pools.push(info.poolRef);
    console.log(`[discover v3] ${meta.symbol || '?'} ${info.token}`);
  }
  for (const log of initLogs) {
    const info = decodeInitializeV4(log, ARC.usdc);
    if (!info) continue;
    const meta = await tokenMeta(provider, info.token);
    await upsertToken(db, { address: info.token, ...meta, dex: 'v4', poolRef: info.poolRef, fee: info.fee, usdcIsToken0: info.usdcIsToken0, block: info.block, metaOk: meta.ok });
    console.log(`[discover v4] ${meta.symbol || '?'} ${info.token}`);
  }

  const v3Tokens = await getKnownTokens(db, 'v3');
  const v4Tokens = await getKnownTokens(db, 'v4');

  // ---- 2. swaps — already fetched above. Only pools created inside this chunk
  // need a follow-up, since they weren't in the merged call's address list.
  // (V4 needs nothing extra: all V4 swaps come from the one PoolManager address
  // and are matched to known poolIds below, which now include this chunk's.)
  if (newV3Pools.length) {
    const late = await getLogsAdaptive(provider, { address: newV3Pools, topics: [TOPICS.v3Swap], fromBlock, toBlock });
    v3SwapLogs = v3SwapLogs.concat(late);
  }
  // Narrow to swaps we will actually store BEFORE fetching block timestamps.
  // The V4 PoolManager emits Swap for every pool on the chain, USDC-paired or
  // not; in a dense range that is thousands of logs we discard. Fetching a
  // block per discarded log was the slow part of a chunk and, at 80 credits a
  // block, the single biggest hole in the credit budget.
  const byPool   = new Map(v3Tokens.map(t => [t.pool_ref.toLowerCase(), t]));
  const byPoolId = new Map(v4Tokens.map(t => [t.pool_ref, t]));
  const v3Kept = v3SwapLogs.map(log => [log, byPool.get(log.address.toLowerCase())]).filter(([, t]) => t);
  const v4Kept = v4SwapLogs.map(log => [log, byPoolId.get(log.topics[1])]).filter(([, t]) => t);
  const times = await blockTimes(provider, fromBlock, toBlock,
    [...v3Kept, ...v4Kept].map(([log]) => log.blockNumber).concat([...pumpCreatedLogs, ...pumpTradeLogs].map(l => l.blockNumber)));

  for (const [log, t] of v3Kept) {
    const s = decodeSwapV3(log, { usdcIsToken0: t.usdc_is_token0 }, ARC.usdcDecimals, t.decimals, times.get(log.blockNumber));
    if (s) await insertSwap(db, t.address, s);
  }
  for (const [log, t] of v4Kept) {
    const s = decodeSwapV4(log, { usdcIsToken0: t.usdc_is_token0, poolRef: t.pool_ref }, ARC.usdcDecimals, t.decimals, times.get(log.blockNumber));
    if (s) await insertSwap(db, t.address, s);
  }

  // ---- 2b. Arclite launchpad — the volume that earns points (queries.js).
  let launchTrades = 0;
  for (const log of pumpCreatedLogs) {
    const t = decodeTokenCreated(log, times.get(log.blockNumber));
    if (t) { await upsertLaunchToken(db, t); console.log(`[launch] ${t.symbol || '?'} ${t.address} by ${t.creator}`); }
  }
  for (const log of pumpTradeLogs) {
    const tr = decodeLaunchTrade(log, times.get(log.blockNumber));
    if (tr) { await insertLaunchTrade(db, tr); launchTrades++; }
  }

  // ---- 3. transfers, for holder counts
  const allTokens = v3Tokens.concat(v4Tokens);
  let transferCount = 0;
  if (allTokens.length) {
    const trLogs = await getLogsAdaptive(provider, {
      address: allTokens.map(t => t.address), topics: [TOPICS.erc20Transfer], fromBlock, toBlock,
    });
    transferCount = trLogs.length;
    const byAddr = new Map(allTokens.map(t => [t.address.toLowerCase(), t]));
    for (const log of trLogs) {
      const t = byAddr.get(log.address.toLowerCase());
      if (!t) continue;
      const tr = decodeTransfer(log, t.decimals);
      if (tr) await applyTransfer(db, t.address, tr);
    }
  }

  return { discovered: poolCreatedLogs.length + initLogs.length, swaps: v3Kept.length + v4Kept.length,
           transfers: transferCount, launchTrades, launched: pumpCreatedLogs.length, logs: merged.length + transferCount };
}

/** Process one chunk inside a single DB transaction. Balance updates are
 *  deltas (balance += amount), NOT idempotent — so if the worker restarts
 *  halfway through a chunk (a redeploy, a crash), replaying that chunk would
 *  double-count every transfer it had already applied. Wrapping the chunk and
 *  its setState() in one transaction means a chunk is either fully applied
 *  and marked done, or not applied at all. Postgres does the rest. */
async function runChunk(pool, provider, fromBlock, toBlock) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const stats = await processChunk(client, provider, fromBlock, toBlock);
    await setState(client, ARC.chainId, toBlock);
    await client.query('COMMIT');
    return stats;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function takeSnapshots(db) {
  const rows = await listTokens(db, { sort: 'new', limit: 1000, offset: 0 });
  const now = new Date();
  for (const r of rows) {
    if (Number(r.price) > 0) await takeSnapshot(db, r.address, r.price, now);
  }
  console.log(`[snapshot] recorded price for ${rows.length} tokens at ${now.toISOString()}`);
}

async function main() {
  // PAUSED must be honoured before touching anything. It used to sit after the
  // first DB read, so with Postgres down the worker crashed instead of idling —
  // which is exactly the moment you most want a pause switch to work.
  if (PAUSED) {
    console.log('[paused] PAUSED=1 — idling, no RPC or DB calls. Unset to resume.');
    while (true) await sleep(60_000);
  }
  const db = makePool();
  await migrate(db);
  const provider = new ethers.JsonRpcProvider(
    process.env.RPC_URL,
    new ethers.Network('arc', BigInt(ARC.chainId)),
    { staticNetwork: true, batchMaxCount: 1 } // Infura rejects batched JSON-RPC
  );

  let lastBlock = await getState(db, ARC.chainId);
  if (lastBlock == null) {
    lastBlock = Number(process.env.START_BLOCK || 0);
    console.log(`[init] no prior state — starting from block ${lastBlock} (set START_BLOCK to change)`);
  } else {
    console.log(`[init] resuming from block ${lastBlock}`);
  }

  let lastSnapshot = 0;
  let chunksSinceMeta = 0;
  let chunk = LOG_CHUNK;

  while (true) {
    try {
      const head = await retry(() => provider.getBlockNumber());
      if (lastBlock < head) {
        const to = Math.min(head, lastBlock + chunk);
        let stats;
        try {
          stats = await runChunk(db, provider, lastBlock + 1, to);
        } catch (e) {
          if (!(e && e.tooDense)) throw e;
          const next = nextChunkSize(chunk, { tooDense: true });
          console.log(`[dense] ${e.message} — shrinking chunk ${chunk} -> ${next} and retrying`);
          chunk = next;
          continue;                                   // no sleep: retry the same range smaller, right away
        }
        console.log(`[chunk] ${lastBlock + 1}-${to} · +${stats.discovered} tokens · ${stats.swaps} swaps · ${stats.transfers} transfers${stats.launchTrades ? ' · ' + stats.launchTrades + ' launchpad' : ''} · ${stats.logs} logs`);
        lastBlock = to;
        chunk = nextChunkSize(chunk, { logs: stats.logs });
        // Repair metadata during the backfill too, not just once caught up. A
        // cold start is millions of blocks behind, so gating this on "caught up"
        // meant every token discovered on the way stayed nameless and unpriced
        // for the entire catch-up. Every 25th chunk keeps it cheap.
        if (++chunksSinceMeta >= 25) { chunksSinceMeta = 0; await backfillMeta(db, provider); }
        if (CHUNK_DELAY_MS) await sleep(CHUNK_DELAY_MS);
      } else {
        // Caught up. Use the idle time to repair tokens whose metadata reads
        // failed earlier — this is when the RPC is least busy and most likely
        // to answer eth_call.
        await backfillMeta(db, provider);
        if (Date.now() - lastSnapshot > SNAPSHOT_INTERVAL_MS) {
          await takeSnapshots(db);
          lastSnapshot = Date.now();
        }
        await sleep(POLL_INTERVAL_MS);
      }
    } catch (e) {
      console.error('[error]', e.stack || e.message || e);
      await sleep(POLL_INTERVAL_MS);
    }
  }
}

if (require.main === module) {
  main().catch(e => { console.error('FATAL', e); process.exit(1); });
}

module.exports = { processChunk, runChunk, takeSnapshots, getLogsAdaptive, retry, blockTimes, nextChunkSize, TooDense, MAX_LOGS_PER_CHUNK };
