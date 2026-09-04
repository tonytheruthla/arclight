#!/usr/bin/env node
// The indexer. Backfills from START_BLOCK (or wherever it last stopped),
// then polls forever. Run this as a long-lived process (Railway "worker"
// service, not a web service) — see DEPLOY.md.
require('dotenv').config();
const { ethers } = require('ethers');
const { ARC, TOPICS } = require('./chain');
const { decodePoolCreatedV3, decodeInitializeV4, decodeSwapV3, decodeSwapV4, decodeTransfer } = require('./process');
const { getState, setState, upsertToken, getKnownTokens, insertSwap, applyTransfer, takeSnapshot } = require('./store');
const { listTokens } = require('./queries');
const { makePool } = require('./db');

const LOG_CHUNK = 9500;               // Arc's eth_getLogs caps at 10k blocks — same limit terminal.html works around
const POLL_INTERVAL_MS = 20_000;
const SNAPSHOT_INTERVAL_MS = 10 * 60 * 1000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function retry(fn, tries = 5, baseMs = 1000) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) {
      last = e;
      const m = String(e && (e.message || e));
      if (i === tries - 1) break;
      await sleep(/limit|429|-32011/i.test(m) ? baseMs * (i + 2) : baseMs * (i + 1));
    }
  }
  throw last;
}

async function tokenMeta(provider, addr) {
  const c = new ethers.Contract(addr, [
    'function name() view returns (string)',
    'function symbol() view returns (string)',
    'function decimals() view returns (uint8)',
  ], provider);
  const [name, symbol, decimals] = await Promise.all([
    retry(() => c.name()).catch(() => ''),
    retry(() => c.symbol()).catch(() => ''),
    retry(() => c.decimals()).catch(() => 18),
  ]);
  return { name, symbol, decimals: Number(decimals) };
}

/** Fetch block timestamps once per unique block number touched in a chunk,
 *  instead of once per log — with hundreds of swaps in a chunk this is the
 *  difference between a handful of RPC calls and hundreds against an RPC
 *  that already rate-limits. */
async function blockTimeCache(provider, blockNumbers) {
  const uniq = [...new Set(blockNumbers)];
  const cache = new Map();
  for (const bn of uniq) {
    const b = await retry(() => provider.getBlock(bn));
    cache.set(bn, new Date(b.timestamp * 1000));
  }
  return cache;
}

async function processChunk(db, provider, fromBlock, toBlock) {
  // ---- 1. discovery: new V3 pools + V4 pools, USDC-paired only
  const [poolCreatedLogs, initLogs] = await Promise.all([
    retry(() => provider.getLogs({ address: ARC.v3Factory, topics: [TOPICS.poolCreated], fromBlock, toBlock })),
    retry(() => provider.getLogs({ address: ARC.v4PoolManager, topics: [TOPICS.v4Initialize], fromBlock, toBlock })),
  ]);
  for (const log of poolCreatedLogs) {
    const info = decodePoolCreatedV3(log, ARC.usdc);
    if (!info) continue;
    const meta = await tokenMeta(provider, info.token);
    await upsertToken(db, { address: info.token, ...meta, dex: 'v3', poolRef: info.poolRef, fee: info.fee, usdcIsToken0: info.usdcIsToken0, block: info.block });
    console.log(`[discover v3] ${meta.symbol || '?'} ${info.token}`);
  }
  for (const log of initLogs) {
    const info = decodeInitializeV4(log, ARC.usdc);
    if (!info) continue;
    const meta = await tokenMeta(provider, info.token);
    await upsertToken(db, { address: info.token, ...meta, dex: 'v4', poolRef: info.poolRef, fee: info.fee, usdcIsToken0: info.usdcIsToken0, block: info.block });
    console.log(`[discover v4] ${meta.symbol || '?'} ${info.token}`);
  }

  const v3Tokens = await getKnownTokens(db, 'v3');
  const v4Tokens = await getKnownTokens(db, 'v4');

  // ---- 2. swaps
  let v3SwapLogs = [], v4SwapLogs = [];
  if (v3Tokens.length) {
    v3SwapLogs = await retry(() => provider.getLogs({
      address: v3Tokens.map(t => t.pool_ref), topics: [TOPICS.v3Swap], fromBlock, toBlock,
    }));
  }
  if (v4Tokens.length) {
    v4SwapLogs = await retry(() => provider.getLogs({
      address: ARC.v4PoolManager, topics: [TOPICS.v4Swap], fromBlock, toBlock,
    }));
  }
  const times = await blockTimeCache(provider, [...v3SwapLogs, ...v4SwapLogs].map(l => l.blockNumber));

  if (v3SwapLogs.length) {
    const byPool = new Map(v3Tokens.map(t => [t.pool_ref.toLowerCase(), t]));
    for (const log of v3SwapLogs) {
      const t = byPool.get(log.address.toLowerCase());
      if (!t) continue;
      const s = decodeSwapV3(log, { usdcIsToken0: t.usdc_is_token0 }, ARC.usdcDecimals, t.decimals, times.get(log.blockNumber));
      if (s) await insertSwap(db, t.address, s);
    }
  }
  if (v4SwapLogs.length) {
    const byPoolId = new Map(v4Tokens.map(t => [t.pool_ref, t]));
    for (const log of v4SwapLogs) {
      const poolId = log.topics[1];
      const t = byPoolId.get(poolId);
      if (!t) continue;
      const s = decodeSwapV4(log, { usdcIsToken0: t.usdc_is_token0, poolRef: t.pool_ref }, ARC.usdcDecimals, t.decimals, times.get(log.blockNumber));
      if (s) await insertSwap(db, t.address, s);
    }
  }

  // ---- 3. transfers, for holder counts
  const allTokens = v3Tokens.concat(v4Tokens);
  if (allTokens.length) {
    const trLogs = await retry(() => provider.getLogs({
      address: allTokens.map(t => t.address), topics: [TOPICS.erc20Transfer], fromBlock, toBlock,
    }));
    const byAddr = new Map(allTokens.map(t => [t.address.toLowerCase(), t]));
    for (const log of trLogs) {
      const t = byAddr.get(log.address.toLowerCase());
      if (!t) continue;
      const tr = decodeTransfer(log, t.decimals);
      if (tr) await applyTransfer(db, t.address, tr);
    }
  }

  return { discovered: poolCreatedLogs.length + initLogs.length, swaps: v3SwapLogs.length + v4SwapLogs.length, transfers: allTokens.length ? 'scanned' : 0 };
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
  const db = makePool();
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

  while (true) {
    try {
      const head = await retry(() => provider.getBlockNumber());
      if (lastBlock < head) {
        const to = Math.min(head, lastBlock + LOG_CHUNK);
        const stats = await processChunk(db, provider, lastBlock + 1, to);
        await setState(db, ARC.chainId, to);
        console.log(`[chunk] ${lastBlock + 1}-${to} · +${stats.discovered} tokens · ${stats.swaps} swaps`);
        lastBlock = to;
      } else {
        if (Date.now() - lastSnapshot > SNAPSHOT_INTERVAL_MS) {
          await takeSnapshots(db);
          lastSnapshot = Date.now();
        }
        await sleep(POLL_INTERVAL_MS);
      }
    } catch (e) {
      console.error('[error]', e.message || e);
      await sleep(POLL_INTERVAL_MS);
    }
  }
}

if (require.main === module) {
  main().catch(e => { console.error('FATAL', e); process.exit(1); });
}

module.exports = { processChunk, takeSnapshots };
