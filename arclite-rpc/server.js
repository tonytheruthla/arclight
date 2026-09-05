#!/usr/bin/env node
/**
 * Arclite Arc RPC — a public, cached, failover JSON-RPC proxy for Arc mainnet.
 *
 * WHY THIS EXISTS
 * ---------------
 * Circle has not opened a public Arc RPC. `rpc.arc.network` does not resolve. Today the
 * ecosystem's ability to transact runs through a single hobby-tier proxy that returns
 * "project ID exceeded quota" under mild load. Whoever runs a reliable endpoint becomes
 * the default way people reach Arc.
 *
 * DESIGN NOTES
 * ------------
 * - Zero dependencies. Node's stdlib only. Deploys anywhere, no supply chain.
 * - Multiple upstreams with health tracking and automatic failover.
 * - Method-aware caching. Immutable answers are cached hard; head-dependent answers
 *   briefly; writes never. This is where the quota savings actually come from.
 * - Per-IP token-bucket rate limiting so one bot can't burn the quota for everyone.
 *
 * PRIVACY — this is a promise the code has to keep, not a paragraph on a website.
 * We never log request bodies, wallet addresses, or IPs. IPs are hashed with a random
 * per-process salt purely to bucket rate limits, and the salt dies with the process.
 * There is no persistence layer here on purpose. See /privacy.
 *
 * RUN
 *   UPSTREAMS="https://your-key.provider.com,https://backup.provider.com" \
 *   PORT=8080 node server.js
 */

'use strict';
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');

// ---------------------------------------------------------------- config
const PORT = Number(process.env.PORT || 8080);
const CHAIN_ID = Number(process.env.CHAIN_ID || 5042);
const CHAIN_ID_HEX = '0x' + CHAIN_ID.toString(16);
const UPSTREAMS = (process.env.UPSTREAMS || '').split(',').map(s => s.trim()).filter(Boolean);
const RATE_PER_MIN = Number(process.env.RATE_PER_MIN || 240);
const UPSTREAM_TIMEOUT = Number(process.env.UPSTREAM_TIMEOUT_MS || 8000);
const MAX_BODY = 512 * 1024;

if (!UPSTREAMS.length) {
  console.error('\n  ✗ UPSTREAMS is required.\n' +
    '    UPSTREAMS="https://arc-mainnet.g.alchemy.com/v2/KEY,https://backup" node server.js\n\n' +
    '    Do NOT point this at another project\'s public proxy. Get your own key —\n' +
    '    QuickNode, Alchemy and GetBlock all document Arc support.\n');
  process.exit(1);
}

// ---------------------------------------------------------------- cache
// TTL in ms. 0 = never cache. Infinity = immutable, cache until eviction.
//
// The interesting entries are the immutable ones. A token page hammers eth_getCode and
// eth_chainId on every visit; those answers cannot change, so serving them from memory
// is free and is most of what keeps us inside a provider quota.
const TTL = {
  eth_chainId:            Infinity,
  net_version:            Infinity,
  eth_getCode:            6 * 60 * 60 * 1000,  // contracts are ~immutable; not strictly
  web3_clientVersion:     60 * 60 * 1000,
  eth_blockNumber:        1000,
  eth_getBalance:         2000,
  eth_call:               2000,
  eth_getLogs:            4000,
  eth_getBlockByNumber:   2000,                // overridden to Infinity when finalized
  eth_getBlockByHash:     Infinity,
  eth_getTransactionByHash:       Infinity,
  eth_getTransactionReceipt:      15000,       // pending -> mined; don't pin a null
  eth_gasPrice:           4000,
  eth_maxPriorityFeePerGas: 4000,
  eth_feeHistory:         4000,
  eth_getTransactionCount: 0,                  // nonce: never cache, breaks sending
  eth_estimateGas:        0,
  eth_sendRawTransaction: 0,
};

const cache = new Map();          // key -> { v, exp }
const CACHE_MAX = 5000;

function cacheGet(k) {
  const e = cache.get(k);
  if (!e) return undefined;
  if (e.exp !== Infinity && Date.now() > e.exp) { cache.delete(k); return undefined; }
  // refresh LRU position
  cache.delete(k); cache.set(k, e);
  return e.v;
}
function cacheSet(k, v, ttl) {
  if (!ttl) return;
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(k, { v, exp: ttl === Infinity ? Infinity : Date.now() + ttl });
}

function ttlFor(req) {
  const t = TTL[req.method];
  if (t === undefined) return 0;                       // unknown method: pass through
  // A block requested by explicit number, far enough behind head, can never change.
  if (req.method === 'eth_getBlockByNumber' && Array.isArray(req.params)) {
    const tag = req.params[0];
    if (typeof tag === 'string' && /^0x[0-9a-f]+$/i.test(tag)) {
      const n = parseInt(tag, 16);
      if (headBlock && headBlock - n > 64) return Infinity;
    }
  }
  return t;
}
const keyFor = (req) => req.method + '|' + JSON.stringify(req.params || []);

let headBlock = 0;

// ---------------------------------------------------------------- upstreams
// chainVerified: null = not checked yet, true = confirmed, false = MISMATCH.
// Starts healthy so a slow first check doesn't block traffic, but a confirmed
// mismatch takes the upstream out of rotation — see verifyUpstream() below.
const pool = UPSTREAMS.map(u => ({ url: u, healthy: true, failUntil: 0, ok: 0, fail: 0, ms: 0, chainVerified: null }));

// Upstream URLs often embed a provider API key (e.g. an Infura project ID in the
// path). /stats is a public, unauthenticated endpoint — never echo the raw URL
// there. This keeps enough to tell upstreams apart (host + which index) without
// leaking the secret.
function maskUpstream(u, i) {
  try {
    const { hostname } = new URL(u);
    return `#${i + 1} ${hostname}`;
  } catch { return `#${i + 1} (unparseable)`; }
}

function post(target, payload) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(target); } catch { return reject(new Error('bad upstream url')); }
    const body = Buffer.from(JSON.stringify(payload));
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': body.length },
      timeout: UPSTREAM_TIMEOUT,
    }, res => {
      const chunks = [];
      let size = 0;
      res.on('data', c => { size += c.length; if (size <= 8 * 1024 * 1024) chunks.push(c); });
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(new Error('upstream returned non-JSON (status ' + res.statusCode + ')')); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('upstream timeout')); });
    req.on('error', e => reject(new Error(e.code || e.message)));
    req.write(body); req.end();
  });
}

/** Quota/rate errors mean this upstream is done for a while, not that the call was bad. */
function isUpstreamExhausted(json) {
  const s = JSON.stringify(json || '').toLowerCase();
  return /exceeded quota|rate limit|too many requests|429|capacity|forbidden|unauthorized/.test(s);
}

async function forward(payload) {
  const started = pool.findIndex(p => p.healthy && Date.now() > p.failUntil);
  const order = [];
  for (let i = 0; i < pool.length; i++) order.push(pool[(Math.max(started, 0) + i) % pool.length]);

  let lastErr = null;
  for (const p of order) {
    if (Date.now() < p.failUntil) continue;
    const t0 = Date.now();
    try {
      const res = await post(p.url, payload);
      if (isUpstreamExhausted(res)) {
        // Cool this upstream off and try the next one rather than passing the
        // quota error to the caller. This is the exact failure RadarDex ships.
        p.fail++; p.healthy = false; p.failUntil = Date.now() + 60_000;
        lastErr = new Error('upstream exhausted');
        continue;
      }
      p.ok++; p.healthy = true; p.ms = Date.now() - t0;
      return res;
    } catch (e) {
      p.fail++; p.failUntil = Date.now() + 15_000; p.healthy = false;
      lastErr = e;
    }
  }
  throw lastErr || new Error('no healthy upstream');
}

// ---------------------------------------------------------------- rate limit
const SALT = crypto.randomBytes(16);                  // dies with the process, by design
const buckets = new Map();
function allow(ipRaw) {
  const ip = crypto.createHash('sha256').update(SALT).update(String(ipRaw)).digest('hex').slice(0, 16);
  const now = Date.now();
  let b = buckets.get(ip);
  if (!b) { b = { tokens: RATE_PER_MIN, ts: now }; buckets.set(ip, b); }
  b.tokens = Math.min(RATE_PER_MIN, b.tokens + ((now - b.ts) / 60000) * RATE_PER_MIN);
  b.ts = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}
setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [k, v] of buckets) if (v.ts < cutoff) buckets.delete(k);
}, 60_000).unref();

// ---------------------------------------------------------------- stats
const stats = { started: Date.now(), requests: 0, cacheHits: 0, upstreamCalls: 0, rateLimited: 0, errors: 0 };

// keep headBlock warm so the finalized-block cache rule works
async function pollHead() {
  try {
    const r = await forward({ jsonrpc: '2.0', id: 'head', method: 'eth_blockNumber', params: [] });
    if (r && r.result) headBlock = parseInt(r.result, 16);
  } catch { /* transient; next tick */ }
}
setInterval(pollHead, 5000).unref();
pollHead();

/** eth_chainId is answered to CALLERS from local config (handleOne, above) —
 *  that's a deliberate cache win, chain identity can never change mid-flight.
 *  But it means nothing here ever actually checks that a given upstream
 *  agrees with CHAIN_ID, which matters a lot right now: as of this proxy's
 *  last audit, Circle's own docs (docs.arc.io) list Arc mainnet as
 *  "Upcoming," not live, and don't publish a mainnet RPC — so an upstream
 *  claiming to serve Arc mainnet needs to be checked against reality, not
 *  trusted because its URL has "mainnet" in it. This calls each upstream
 *  directly, bypassing the local short-circuit, and pulls it out of
 *  rotation if it disagrees.
 */
async function verifyUpstream(p) {
  try {
    const res = await post(p.url, { jsonrpc: '2.0', id: 'verify', method: 'eth_chainId', params: [] });
    const got = res && res.result;
    if (typeof got === 'string' && got.toLowerCase() === CHAIN_ID_HEX.toLowerCase()) {
      if (p.chainVerified !== true) console.log('  ✓ upstream chain check OK:', p.url, '->', got);
      p.chainVerified = true;
    } else {
      console.error('  ✗ CHAIN ID MISMATCH:', p.url, 'returned', got, 'expected', CHAIN_ID_HEX,
        '— excluding this upstream from rotation until it matches.');
      p.chainVerified = false;
      p.healthy = false;
      p.failUntil = Date.now() + 5 * 60_000; // recheck in 5 min rather than banning forever
    }
  } catch (e) {
    // A verify failure isn't necessarily a mismatch — could be transient. Leave
    // chainVerified as-is (null on first run stays null, a prior true/false holds)
    // rather than flipping health state on a network blip.
    console.error('  ! chain check failed for', p.url, ':', e.message || e);
  }
}
function verifyAllUpstreams() { for (const p of pool) verifyUpstream(p); }
setInterval(verifyAllUpstreams, 5 * 60_000).unref();
verifyAllUpstreams();

// ---------------------------------------------------------------- rpc handling
async function handleOne(req) {
  if (!req || req.jsonrpc !== '2.0' || typeof req.method !== 'string') {
    return { jsonrpc: '2.0', id: (req && req.id) ?? null,
             error: { code: -32600, message: 'Invalid Request' } };
  }
  // Answer chain identity locally — it can never change and it's the single most
  // requested method by wallets.
  if (req.method === 'eth_chainId') return { jsonrpc: '2.0', id: req.id, result: CHAIN_ID_HEX };
  if (req.method === 'net_version') return { jsonrpc: '2.0', id: req.id, result: String(CHAIN_ID) };

  const ttl = ttlFor(req);
  const key = keyFor(req);
  if (ttl) {
    const hit = cacheGet(key);
    if (hit !== undefined) { stats.cacheHits++; return { jsonrpc: '2.0', id: req.id, result: hit }; }
  }

  stats.upstreamCalls++;
  const res = await forward({ jsonrpc: '2.0', id: req.id, method: req.method, params: req.params || [] });
  if (ttl && res && res.result !== undefined && res.error === undefined) {
    // Never pin a null receipt — the tx may simply not be mined yet.
    if (!(req.method === 'eth_getTransactionReceipt' && res.result === null)) {
      cacheSet(key, res.result, ttl);
    }
  }
  return res;
}

// ---------------------------------------------------------------- http
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, GET, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400',
};
const send = (res, code, obj, extra) =>
  res.writeHead(code, Object.assign({ 'content-type': 'application/json' }, CORS, extra || {}))
     .end(JSON.stringify(obj));

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') return res.writeHead(204, CORS).end();

  if (req.method === 'GET') {
    const path = req.url.split('?')[0];
    if (path === '/health') {
      const healthy = pool.filter(p => p.healthy && Date.now() > p.failUntil).length;
      const mismatched = pool.filter(p => p.chainVerified === false).length;
      return send(res, healthy ? 200 : 503, {
        ok: healthy > 0, chainId: CHAIN_ID, head: headBlock,
        upstreams: { total: pool.length, healthy, chainMismatched: mismatched },
        uptimeSec: Math.round((Date.now() - stats.started) / 1000),
      });
    }
    if (path === '/stats') {
      const total = stats.cacheHits + stats.upstreamCalls;
      return send(res, 200, Object.assign({}, stats, {
        chainId: CHAIN_ID, head: headBlock, cacheEntries: cache.size,
        cacheHitRate: total ? (stats.cacheHits / total * 100).toFixed(1) + '%' : '0%',
        upstreams: pool.map((p, i) => ({
          upstream: maskUpstream(p.url, i), healthy: p.healthy, ok: p.ok, fail: p.fail, lastMs: p.ms,
          chainVerified: p.chainVerified,
        })),
      }));
    }
    if (path === '/privacy') {
      return send(res, 200, {
        logsRequestBodies: false,
        logsWalletAddresses: false,
        logsIpAddresses: false,
        ipHandling: 'hashed with a random per-process salt, in memory only, for rate limiting; salt is discarded on restart',
        persistence: 'none — there is no database',
        retentionSeconds: 0,
        source: 'https://github.com/tonytheruthla/arclight',
      });
    }
    return send(res, 200, { name: 'Arclite Arc RPC', chainId: CHAIN_ID, head: headBlock,
                            usage: 'POST JSON-RPC 2.0 to /', endpoints: ['/health', '/stats', '/privacy'] });
  }

  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
             req.socket.remoteAddress || 'unknown';
  if (!allow(ip)) {
    stats.rateLimited++;
    return send(res, 429, { jsonrpc: '2.0', id: null,
      error: { code: -32005, message: 'Rate limit exceeded. ' + RATE_PER_MIN + ' req/min per IP.' } },
      { 'retry-after': '10' });
  }

  let size = 0; const chunks = [];
  req.on('data', c => {
    size += c.length;
    if (size > MAX_BODY) { req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', async () => {
    stats.requests++;
    let payload;
    try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }

    try {
      if (Array.isArray(payload)) {
        if (payload.length > 50) {
          return send(res, 413, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Batch too large (max 50)' } });
        }
        return send(res, 200, await Promise.all(payload.map(handleOne)));
      }
      return send(res, 200, await handleOne(payload));
    } catch (e) {
      stats.errors++;
      return send(res, 502, { jsonrpc: '2.0', id: payload && payload.id !== undefined ? payload.id : null,
        error: { code: -32603, message: 'All upstreams unavailable: ' + (e.message || 'unknown') } });
    }
  });
});

server.listen(PORT, () => {
  console.log('\n  Arclite Arc RPC');
  console.log('  ' + '─'.repeat(46));
  console.log('  port      ', PORT);
  console.log('  chainId   ', CHAIN_ID, '(' + CHAIN_ID_HEX + ')');
  console.log('  upstreams ', pool.length);
  console.log('  rate limit', RATE_PER_MIN + ' req/min/IP');
  console.log('  endpoints  /  /health  /stats  /privacy\n');
});
