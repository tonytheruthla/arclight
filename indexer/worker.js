#!/usr/bin/env node
// The indexer. Backfills from START_BLOCK (or wherever it last stopped),
// then polls forever. Run this as a long-lived process (Railway "worker"
// service, not a web service) — see DEPLOY.md.
require('dotenv').config();
const { ethers } = require('ethers');
const { ARC, TOPICS, pumpAddress } = require('./chain');
const { decodePoolCreatedV3, decodeInitializeV4, decodeSwapV3, decodeSwapV4, decodeTransfer, decodeTokenCreated, decodeLaunchTrade } = require('./process');
const { applyTransfersBatch, getState, setState, upsertToken, getKnownTokens, getTokensMissingMeta, updateTokenMeta, setTokenSupply, getLaunchTokenAddresses, insertSwap, applyTransfer, takeSnapshot, upsertLaunchToken, insertLaunchTrade } = require('./store');
const { listTokens } = require('./queries');
const { makePool, migrate } = require('./db');

const LOG_CHUNK = Number(process.env.LOG_CHUNK || 250);   // starting/maximum block span per chunk
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
/* Why 250 and 25,000 rather than the old 9,500 and 6,000.
 *
 * The merged discovery/swap call fetches a WHOLE chunk in one getLogs. When the
 * range is too big the provider refuses it (20,000-result cap) and
 * getLogsAdaptive splits — but a split holds `a` AND `b` in memory before the
 * size check can reject them, so peak memory is ~2x a 20,000-log leaf plus the
 * JSON-RPC response strings being parsed. On 16 Sept's Arc traffic (35.4
 * matching logs/block) a 9,500-block chunk meant ~336,000 logs and a peak that
 * blew a ~512MB heap: "FATAL ERROR: Reached heap limit".
 *
 * Bounding the WORK is the fix, not buying a bigger heap. At 250 blocks the
 * merged call is ~8,800 logs (~26MB) and never splits at all. Transfers are
 * separately streamed in TRANSFER_SLICE-block slices. Both are now bounded by a
 * constant instead of by how busy the chain happens to be. */
const MAX_LOGS_PER_CHUNK = Number(process.env.MAX_LOGS_PER_CHUNK || 25000);
const MIN_CHUNK          = Number(process.env.MIN_CHUNK || 200);
/* Block span per transfers fetch. Small on purpose — see the streaming note in
 * processChunk. 25 blocks was ~9,000 transfer logs on 16 Sept's traffic. */
const TRANSFER_SLICE     = Number(process.env.TRANSFER_SLICE || 25);
/* MIN_CHUNK is where the chunk RESTS, not a floor it cannot pass. A dense
 * range has to be able to shrink all the way to a single block, because a
 * 200-block window that is over the cap can only be split further. Flooring
 * the shrink at 200 made nextChunkSize(200) return 200, and the main loop
 * retried the identical range forever — 'shrinking chunk 200 -> 200'. */
class TooDense extends Error {
  constructor(count, from, to) { super(`${count} logs in ${from}-${to} exceeds MAX_LOGS_PER_CHUNK=${MAX_LOGS_PER_CHUNK}`); this.tooDense = true; }
}
/** Next chunk size after a chunk outcome. Halve on TooDense, all the way down to
 *  a single block if the range stays over the cap; double back toward LOG_CHUNK
 *  once a chunk comes in well under it. The halving MUST strictly decrease, or
 *  the main loop retries an identical range forever. */
function nextChunkSize(current, { tooDense = false, logs = 0 } = {}) {
  if (tooDense) return Math.max(1, Math.floor(current / 2));   // must strictly decrease
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
  await refreshLaunchSupply(db, provider);
  return fixed;
}

/** Re-read totalSupply for pad-launched tokens.
 *
 *  Every other token's supply is written once, which is right — it does not move.
 *  Arclite pad tokens are the exception: at graduation the pad burns the curve
 *  supply nobody bought, so totalSupply drops, once, permanently. Market cap is
 *  price x total_supply, so without this the site would keep reporting the
 *  pre-burn supply and the burn would be invisible exactly where it matters.
 *
 *  Read from the chain, not from a third-party token list — an outside list will
 *  not know about our burn, and on the day it happens it would overwrite the
 *  correct value with a stale one. */
async function refreshLaunchSupply(db, provider) {
  let addrs = [];
  try { addrs = await getLaunchTokenAddresses(db, 25); } catch { return 0; }
  if (!addrs.length) return 0;
  let changed = 0;
  for (const addr of addrs) {
    try {
      const c = new ethers.Contract(addr, ['function totalSupply() view returns (uint256)'], provider);
      const raw = await c.totalSupply();
      const whole = Number(raw / 10n ** 18n);
      if (!(whole > 0)) continue;
      const cur = await db.query('SELECT total_supply FROM tokens WHERE address = $1', [addr]);
      const was = cur.rows[0] && cur.rows[0].total_supply;
      if (was != null && Number(was) === whole) continue;
      await setTokenSupply(db, addr, whole, { force: true });
      changed++;
      console.log(`[supply] ${addr} ${was == null ? 'set' : Number(was).toLocaleString() + ' ->'} ${whole.toLocaleString()}`);
    } catch { /* one odd token must not stop the rest */ }
  }
  return changed;
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
async function getLogsAdaptive(provider, filter, depth = 0, cap = MAX_LOGS_PER_CHUNK) {
  const from = Number(filter.fromBlock), to = Number(filter.toBlock);
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const logs = await provider.getLogs(filter);
      if (logs.length > cap) throw new TooDense(logs.length, from, to);
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
        const a = await getLogsAdaptive(provider, { ...filter, fromBlock: from, toBlock: mid }, depth + 1, cap);
        if (a.length > cap) throw new TooDense(a.length, from, mid);
        const b = await getLogsAdaptive(provider, { ...filter, fromBlock: mid + 1, toBlock: to }, depth + 1, cap);
        if (a.length + b.length > cap) throw new TooDense(a.length + b.length, from, to);
        return a.concat(b);
      }
      lastErr = e;                                   // transient: back off and retry
      await sleep(/limit|429|-32011/i.test(msg) ? 2000 * (attempt + 1) : 1000 * (attempt + 1));
    }
  }
  throw lastErr;
}

async function processChunk(db, provider, fromBlock, toBlock, cap = MAX_LOGS_PER_CHUNK) {
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
  }, 0, cap);
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
    const late = await getLogsAdaptive(provider, { address: newV3Pools, topics: [TOPICS.v3Swap], fromBlock, toBlock }, 0, cap);
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

  // ---- 3. transfers, for holder counts — STREAMED in block slices.
  /* This is by far the densest fetch the worker makes: it asks every known
   * token address for every Transfer in the range, and on 16 Sept a single
   * 200-block window held 72,292 of them. Materialising a whole chunk's worth
   * at once is what actually put the container under memory pressure — the
   * merged call above was only 7,071 in the same window.
   *
   * Slicing decouples the two concerns. Peak memory now depends on
   * TRANSFER_SLICE, not on the chunk size, so the chunk can stay big enough to
   * keep up with the chain while each fetch stays small enough to hold. Each
   * slice is fetched, applied and released before the next one is requested. */
  const allTokens = v3Tokens.concat(v4Tokens);
  let transferCount = 0;
  if (allTokens.length) {
    const addrs = allTokens.map(t => t.address);
    const byAddr = new Map(allTokens.map(t => [t.address.toLowerCase(), t]));
    for (let sFrom = fromBlock; sFrom <= toBlock; sFrom += TRANSFER_SLICE) {
      const sTo = Math.min(sFrom + TRANSFER_SLICE - 1, toBlock);
      const trLogs = await getLogsAdaptive(provider, {
        address: addrs, topics: [TOPICS.erc20Transfer], fromBlock: sFrom, toBlock: sTo,
      }, 0, cap);
      transferCount += trLogs.length;
      /* Net every delta in memory, then write once.
       *
       * This used to be two awaited round trips per log — ~180,000 sequential
       * queries per chunk, inside the chunk's single transaction. That was
       * almost the entire chunk time, and it held table locks long enough that
       * the API could not run its own migrations and the site went dark.
       *
       * Netting first also collapses a wallet that traded fifty times into one
       * row, and guarantees each (token, holder) appears once — which ON
       * CONFLICT DO UPDATE requires.
       *
       * Deltas are accumulated as exact BigInts and scaled once at write time.
       * Summing the float `amount` would compound rounding across thousands of
       * additions; this is more accurate than what it replaces, not just faster. */
      const deltas = new Map();
      const decimalsBy = new Map();
      for (const log of trLogs) {
        const t = byAddr.get(log.address.toLowerCase());
        if (!t) continue;
        const tr = decodeTransfer(log, t.decimals);
        if (!tr || tr.amountRaw === undefined) continue;
        const token = t.address.toLowerCase();
        decimalsBy.set(token, t.decimals);
        const k1 = token + '|' + tr.from.toLowerCase();
        const k2 = token + '|' + tr.to.toLowerCase();
        deltas.set(k1, (deltas.get(k1) || 0n) - tr.amountRaw);
        deltas.set(k2, (deltas.get(k2) || 0n) + tr.amountRaw);
      }
      if (deltas.size) {
        await applyTransfersBatch(db, deltas, tok => decimalsBy.get(tok) ?? 18);
      }
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
async function runChunk(pool, provider, fromBlock, toBlock, cap = MAX_LOGS_PER_CHUNK) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const stats = await processChunk(client, provider, fromBlock, toBlock, cap);
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
  let forceOne = false;

  while (true) {
    try {
      const head = await retry(() => provider.getBlockNumber());
      if (lastBlock < head) {
        const to = Math.min(head, lastBlock + chunk);
        let stats;
        try {
          /* forceOne: this exact single block already came back over the cap and
             cannot be split any further, so process it rather than retry it. A
             block is indivisible — looping here loses the data permanently,
             processing it costs one oversized chunk of memory, once. */
          stats = await runChunk(db, provider, lastBlock + 1, to, forceOne ? Infinity : MAX_LOGS_PER_CHUNK);
          forceOne = false;
        } catch (e) {
          if (!(e && e.tooDense)) throw e;
          if (chunk <= 1) {
            console.log(`[dense] ${e.message} — single block, cannot split further; processing it anyway`);
            forceOne = true;
            continue;
          }
          const next = nextChunkSize(chunk, { tooDense: true });
          console.log(`[dense] ${e.message} — shrinking chunk ${chunk} -> ${next} and retrying`);
          chunk = next;
          continue;                                   // no sleep: retry the same range smaller, right away
        }
        console.log(`[chunk] ${lastBlock + 1}-${to} · +${stats.discovered} tokens · ${stats.swaps} swaps · ${stats.transfers} transfers${stats.launchTrades ? ' · ' + stats.launchTrades + ' launchpad' : ''} · ${stats.logs} logs`);
        lastBlock = to;
        chunk = nextChunkSize(chunk, { logs: stats.logs });
        if (chunk < MIN_CHUNK && stats.logs < MAX_LOGS_PER_CHUNK) chunk = Math.min(MIN_CHUNK, LOG_CHUNK);
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

module.exports = { processChunk, runChunk, takeSnapshots, getLogsAdaptive, retry, blockTimes, nextChunkSize, TooDense, MAX_LOGS_PER_CHUNK, LOG_CHUNK, MIN_CHUNK, TRANSFER_SLICE };
