#!/usr/bin/env node
// JSON API over the indexed data. Deploy this as a separate Railway "web"
// service from worker.js (a web service and a worker scale and restart
// independently — one crashing shouldn't take the other down).
//
// Everything is read-only except POST /api/v1/points/share, which writes one
// row per wallet-signed share. That is the only state a browser can create
// here, and it is bounded by the primary key plus a daily cap.
require('dotenv').config();
const express = require('express');
const { ethers } = require('ethers');
const { makePool, migrate } = require('./db');
const { listTokens, getToken, getStats, recentSwaps, pointsLeaderboard, pointsForWallet, walletHoldings, walletTrades, walletLaunches } = require('./queries');
const { solHoldings } = require('./sol');
const { sharesToday, addSharePoint, getProfiles, upsertProfile, putImage, getImage } = require('./store');
const { pumpAddress } = require('./chain');
const { startResolver } = require('./meta');

// ---- images ------------------------------------------------------------------
const IMG_MAX = 512 * 1024;
const IMG_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'];
const GATEWAYS = ['https://ipfs.io/ipfs/', 'https://gateway.pinata.cloud/ipfs/', 'https://cloudflare-ipfs.com/ipfs/', 'https://dweb.link/ipfs/'];
/** Candidate URLs for a logo: an ipfs:// URI fans out over public gateways;
 *  a gateway https URL also gets the other gateways as fallbacks. */
function imageCandidates(u) {
  if (!u) return [];
  let cid = null;
  if (u.startsWith('ipfs://')) cid = u.slice(7).replace(/^ipfs\//, '');
  const m = u.match(/\/ipfs\/([^/?#]+.*)$/); if (m) cid = m[1];
  if (cid) return [...new Set([u.startsWith('http') ? u : null, ...GATEWAYS.map(g => g + cid)].filter(Boolean))];
  return u.startsWith('http') ? [u] : [];
}
async function fetchImage(url, fetchImpl = fetch) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 10000);
  try {
    const r = await fetchImpl(url, { signal: ac.signal, headers: { accept: 'image/*' }, redirect: 'follow' });
    if (!r.ok) throw new Error('status ' + r.status);
    const ct = (r.headers.get('content-type') || '').split(';')[0].trim();
    if (!IMG_TYPES.includes(ct)) throw new Error('not an image: ' + ct);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > IMG_MAX) throw new Error('too large');
    return { contentType: ct, bytes: buf };
  } finally { clearTimeout(t); }
}

/** Text a creator signs to set their token's profile. Day-bound like shares. */
function metaMessage(wallet, token, day) {
  return `Arclite token profile\nwallet: ${wallet.toLowerCase()}\ntoken: ${token.toLowerCase()}\nday: ${day}`;
}
const isUrl = u => u == null || u === '' || (typeof u === 'string' && u.length <= 300 && /^https?:\/\/[^\s]+$/.test(u));

const SHARE_DAILY_CAP = Number(process.env.SHARE_DAILY_CAP || 10);

/** The exact text a wallet signs to claim a share point. Deterministic and
 *  human-readable, so what MetaMask shows the user is what we verify. The day
 *  is inside it, so a signature can't be replayed tomorrow. */
function shareMessage(wallet, token, day) {
  return `Arclite share\nwallet: ${wallet.toLowerCase()}\ntoken: ${token.toLowerCase()}\nday: ${day}`;
}
const utcDay = (d = new Date()) => d.toISOString().slice(0, 10);
const isAddr = a => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);

function makeApp(db, opts = {}) {
  const app = express();
  const solOpts = { fetchImpl: opts.fetchImpl || fetch, rpcUrl: opts.solRpc || process.env.SOL_RPC || undefined };
  // token-meta carries a base64 image (≤512 KB); everything else is tiny.
  app.use('/api/v1/token-meta', express.json({ limit: '800kb' }));
  app.use(express.json({ limit: '4kb' }));

  // Open CORS — public market data, same posture pump.archi documents for
  // their own API. The share endpoint needs the preflight too.
  app.use((req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  const fail = (res, e) => { console.error(e); res.status(500).json({ error: 'internal error' }); };

  app.get('/api/v1', (req, res) => {
    res.json({ name: 'Arclite Explorer API', chainId: 5042, launchpad: pumpAddress(),
      endpoints: ['/api/v1/tokens', '/api/v1/tokens/:address', '/api/v1/stats', '/api/v1/swaps/recent',
                  '/api/v1/points/leaderboard', '/api/v1/points/:wallet', 'POST /api/v1/points/share',
                  '/api/v1/profiles?addrs=a,b', '/api/v1/img/:address', 'POST /api/v1/token-meta'] });
  });

  app.get('/api/v1/tokens', async (req, res) => {
    try {
      const sort = ['volume', 'mcap', 'txns', 'holders', 'new', 'change'].includes(req.query.sort) ? req.query.sort : 'new';
      const limit = Math.min(Number(req.query.limit) || 50, 200);
      const offset = Math.max(Number(req.query.offset) || 0, 0);
      const rows = await listTokens(db, { sort, limit, offset });
      res.json({ sort, limit, offset, count: rows.length, tokens: rows });
    } catch (e) { fail(res, e); }
  });

  app.get('/api/v1/tokens/:address', async (req, res) => {
    try {
      const row = await getToken(db, req.params.address);
      if (!row) return res.status(404).json({ error: 'not found' });
      res.json(row);
    } catch (e) { fail(res, e); }
  });

  app.get('/api/v1/stats', async (req, res) => {
    try { res.json({ ...(await getStats(db)), launchpad: pumpAddress(), at: new Date().toISOString() }); }
    catch (e) { fail(res, e); }
  });

  app.get('/api/v1/swaps/recent', async (req, res) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 30, 100);
      res.json({ swaps: await recentSwaps(db, limit) });
    } catch (e) { fail(res, e); }
  });

  // ---- points --------------------------------------------------------------
  const rules = () => ({
    volume: '1 point per 1 USDC traded on the Arclite launchpad (buys and sells)',
    share: `1 point per share — 1 per token per UTC day, max ${SHARE_DAILY_CAP} per wallet per day`,
    // 'pre' until the launchpad is deployed on this chain: shares still count,
    // volume can't exist yet. The UI says so rather than showing an empty board.
    season: pumpAddress() ? 'live' : 'pre',
    launchpad: pumpAddress(),
    shareDailyCap: SHARE_DAILY_CAP,
  });

  app.get('/api/v1/points/leaderboard', async (req, res) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 100, 500);
      const board = await pointsLeaderboard(db, limit);
      res.json({ rules: rules(), traders: board.traders, leaderboard: board.rows });
    } catch (e) { fail(res, e); }
  });

  app.get('/api/v1/points/:wallet', async (req, res) => {
    try {
      if (!isAddr(req.params.wallet)) return res.status(400).json({ error: 'bad wallet' });
      const me = await pointsForWallet(db, req.params.wallet);
      const day = utcDay();
      me.sharesToday = await sharesToday(db, me.wallet, day);
      me.shareDailyCap = SHARE_DAILY_CAP;
      res.json({ rules: rules(), ...me });
    } catch (e) { fail(res, e); }
  });

  /** Claim a share point. Body: { wallet, token, day, signature }.
   *  The signature must be the wallet's personal_sign of shareMessage(...).
   *  Verification is done server-side with ethers — the browser can't forge
   *  a claim for a wallet it doesn't control, and can't replay one across days. */
  app.post('/api/v1/points/share', async (req, res) => {
    try {
      const { wallet, token, day, signature } = req.body || {};
      if (!isAddr(wallet) || !isAddr(token)) return res.status(400).json({ error: 'bad wallet or token' });
      if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature)) return res.status(400).json({ error: 'bad signature' });
      const today = utcDay();
      if (day !== today) return res.status(400).json({ error: 'stale day', today });
      let signer;
      try { signer = ethers.verifyMessage(shareMessage(wallet, token, day), signature); }
      catch { return res.status(400).json({ error: 'signature does not verify' }); }
      if (signer.toLowerCase() !== wallet.toLowerCase()) return res.status(401).json({ error: 'signature is not from this wallet' });

      const n = await sharesToday(db, wallet, today);
      if (n >= SHARE_DAILY_CAP) return res.status(429).json({ error: 'daily share cap reached', sharesToday: n, cap: SHARE_DAILY_CAP });
      const awarded = await addSharePoint(db, wallet, token, today);
      res.json({ ok: true, awarded, sharesToday: n + (awarded ? 1 : 0), cap: SHARE_DAILY_CAP,
        reason: awarded ? null : 'already credited for this token today' });
    } catch (e) { fail(res, e); }
  });

  // ---- profiles + images ----------------------------------------------------
  /** Profiles for a list of addresses — the launchpad view reads coins straight
   *  from the chain and needs logos/socials for them too. */
  app.get('/api/v1/profiles', async (req, res) => {
    try {
      const addrs = String(req.query.addrs || '').split(',').map(a => a.trim()).filter(isAddr).slice(0, 200);
      const rows = await getProfiles(db, addrs);
      res.json({ profiles: rows.map(p => ({ address: p.address, name: p.name, symbol: p.symbol, logo: p.logo_url ? `/api/v1/img/${p.address}` : null,
        website: p.website, twitter: p.twitter, telegram: p.telegram, description: p.description, source: p.source })) });
    } catch (e) { fail(res, e); }
  });

  /** The logo, from our cache; on a miss, fetched once from the launchpad /
   *  IPFS and stored. 404s are cached in memory for an hour so a dead link
   *  doesn't cost a gateway round-trip per page view. */
  const imgMiss = new Map();
  app.get('/api/v1/img/:address', async (req, res) => {
    try {
      const addr = req.params.address.toLowerCase();
      if (!isAddr(addr)) return res.status(400).end();
      const hit = await getImage(db, addr);
      if (hit) { res.set('Content-Type', hit.content_type); res.set('Cache-Control', 'public, max-age=86400, immutable'); return res.end(hit.bytes); }
      if ((imgMiss.get(addr) || 0) > Date.now()) return res.status(404).set('Cache-Control', 'public, max-age=3600').end();
      const [p] = await getProfiles(db, [addr]);
      let got = null;
      for (const u of imageCandidates(p && p.logo_url)) { try { got = await fetchImage(u, app.locals.fetch); break; } catch {} }
      if (!got) { imgMiss.set(addr, Date.now() + 3600_000); return res.status(404).set('Cache-Control', 'public, max-age=3600').end(); }
      await putImage(db, addr, got.contentType, got.bytes);
      res.set('Content-Type', got.contentType); res.set('Cache-Control', 'public, max-age=86400, immutable'); res.end(got.bytes);
    } catch (e) { fail(res, e); }
  });

  /** Creator sets logo + socials for a token launched on Arclite.
   *  Body: { wallet, token, day, signature, image?: 'data:image/png;base64,…', website?, twitter?, telegram?, description? }
   *  The signer must be the wallet that created the token (launch_tokens.creator). */
  app.post('/api/v1/token-meta', async (req, res) => {
    try {
      const { wallet, token, day, signature, image, website, twitter, telegram, description } = req.body || {};
      if (!isAddr(wallet) || !isAddr(token)) return res.status(400).json({ error: 'bad wallet or token' });
      if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature)) return res.status(400).json({ error: 'bad signature' });
      if (day !== utcDay()) return res.status(400).json({ error: 'stale day', today: utcDay() });
      if (![website, twitter, telegram].every(isUrl)) return res.status(400).json({ error: 'links must be http(s) URLs' });
      if (description != null && (typeof description !== 'string' || description.length > 500)) return res.status(400).json({ error: 'description too long' });
      let signer;
      try { signer = ethers.verifyMessage(metaMessage(wallet, token, day), signature); }
      catch { return res.status(400).json({ error: 'signature does not verify' }); }
      if (signer.toLowerCase() !== wallet.toLowerCase()) return res.status(401).json({ error: 'signature is not from this wallet' });
      const lt = await db.query('SELECT creator, name, symbol FROM launch_tokens WHERE address = $1', [token.toLowerCase()]);
      if (!lt.rows.length) return res.status(404).json({ error: 'not an Arclite launchpad token (or not indexed yet — try again in a minute)' });
      if (lt.rows[0].creator.toLowerCase() !== wallet.toLowerCase()) return res.status(403).json({ error: 'only the creator can set this' });

      let logoUrl = null;
      if (image) {
        const m = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(image));
        if (!m) return res.status(400).json({ error: 'image must be a data: URL (png/jpeg/gif/webp)' });
        const bytes = Buffer.from(m[2], 'base64');
        if (bytes.length > IMG_MAX) return res.status(413).json({ error: 'image over 512 KB' });
        await putImage(db, token, m[1], bytes);
        logoUrl = 'db';
      } else {
        const [prev] = await getProfiles(db, [token]);
        logoUrl = prev ? prev.logo_url : null;                       // keep the existing logo when only links change
      }
      await upsertProfile(db, { address: token, name: lt.rows[0].name, symbol: lt.rows[0].symbol, logoUrl,
        website: website || null, twitter: twitter || null, telegram: telegram || null, description: description || null,
        source: 'creator', updatedBy: wallet });
      res.json({ ok: true, logo: logoUrl ? `/api/v1/img/${token.toLowerCase()}` : null });
    } catch (e) { fail(res, e); }
  });

  // ---- portfolio ------------------------------------------------------------
  /** One Arc wallet: holdings (DEX ledger + launchpad positions), trades on
   *  both venues, coins launched. Read-only; the page adds live balanceOf
   *  checks for the launchpad positions before offering a Sell. */
  app.get('/api/v1/wallet/:wallet', async (req, res) => {
    try {
      if (!isAddr(req.params.wallet)) return res.status(400).json({ error: 'bad wallet' });
      const wl = req.params.wallet.toLowerCase();
      const [holdings, trades, launches] = await Promise.all([
        walletHoldings(db, wl), walletTrades(db, wl, Number(req.query.trades) || 100), walletLaunches(db, wl)]);
      res.set('Cache-Control', 'public, max-age=20');
      res.json({ wallet: wl, holdings, trades, launches, at: new Date().toISOString() });
    } catch (e) { fail(res, e); }
  });

  /** Solana holdings for a public key, proxied through SOL_RPC (see sol.js). */
  app.get('/api/v1/sol/:owner', async (req, res) => {
    try {
      const data = await solHoldings(req.params.owner, solOpts);
      res.set('Cache-Control', 'public, max-age=30');
      res.json(data);
    } catch (e) {
      if (e.status === 400) return res.status(400).json({ error: e.message });
      console.error('[sol]', e.message);
      res.status(502).json({ error: 'solana read failed', detail: String(e.message || e).slice(0, 160),
        hint: process.env.SOL_RPC ? undefined : 'SOL_RPC is not set on this service; the public endpoint is rate-limited and blocks some hosts' });
    }
  });

  app.get('/health', (req, res) => res.json({ ok: true }));
  return app;
}

const PORT = process.env.PORT || 3001;
if (require.main === module) {
  const db = makePool();
  // Migrate before listening: a request that hits a table that doesn't exist
  // yet would 500 for the first few seconds otherwise.
  migrate(db).catch(e => console.error('[db] migrate failed (continuing):', e.message))
    .then(() => {
      makeApp(db).listen(PORT, () => console.log(`[api] listening on :${PORT}`));
      // Logos/names from the launchpads' public APIs. Lives here rather than in
      // the worker because it needs no RPC — it keeps running while the worker
      // is PAUSED. META_RESOLVER=0 turns it off.
      if (process.env.META_RESOLVER !== '0') startResolver(db);
    });
}

module.exports = { makeApp, shareMessage, metaMessage, utcDay, SHARE_DAILY_CAP };
