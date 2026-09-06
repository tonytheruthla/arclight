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
const { listTokens, getToken, getStats, recentSwaps, pointsLeaderboard, pointsForWallet } = require('./queries');
const { sharesToday, addSharePoint } = require('./store');
const { pumpAddress } = require('./chain');

const SHARE_DAILY_CAP = Number(process.env.SHARE_DAILY_CAP || 10);

/** The exact text a wallet signs to claim a share point. Deterministic and
 *  human-readable, so what MetaMask shows the user is what we verify. The day
 *  is inside it, so a signature can't be replayed tomorrow. */
function shareMessage(wallet, token, day) {
  return `Arclite share\nwallet: ${wallet.toLowerCase()}\ntoken: ${token.toLowerCase()}\nday: ${day}`;
}
const utcDay = (d = new Date()) => d.toISOString().slice(0, 10);
const isAddr = a => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);

function makeApp(db) {
  const app = express();
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
                  '/api/v1/points/leaderboard', '/api/v1/points/:wallet', 'POST /api/v1/points/share'] });
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

  app.get('/health', (req, res) => res.json({ ok: true }));
  return app;
}

const PORT = process.env.PORT || 3001;
if (require.main === module) {
  const db = makePool();
  // Migrate before listening: a request that hits a table that doesn't exist
  // yet would 500 for the first few seconds otherwise.
  migrate(db).catch(e => console.error('[db] migrate failed (continuing):', e.message))
    .then(() => makeApp(db).listen(PORT, () => console.log(`[api] listening on :${PORT}`)));
}

module.exports = { makeApp, shareMessage, utcDay, SHARE_DAILY_CAP };
