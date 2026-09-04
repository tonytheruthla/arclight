#!/usr/bin/env node
// Read-only JSON API over the indexed data. Deploy this as a separate
// Railway "web" service from worker.js (a web service and a worker scale
// and restart independently — one crashing shouldn't take the other down).
require('dotenv').config();
const express = require('express');
const { makePool } = require('./db');
const { listTokens, getToken } = require('./queries');

const app = express();
const db = makePool();

// Open CORS — this is public read-only market data, same posture pump.archi
// documents for their own API ("CORS is open, no key needed").
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  next();
});

app.get('/api/v1', (req, res) => {
  res.json({ name: 'Arclite Explorer API', chainId: 5042, endpoints: ['/api/v1/tokens', '/api/v1/tokens/:address'] });
});

app.get('/api/v1/tokens', async (req, res) => {
  try {
    const sort = ['volume', 'mcap', 'txns', 'holders', 'new', 'change'].includes(req.query.sort) ? req.query.sort : 'new';
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const rows = await listTokens(db, { sort, limit, offset });
    res.json({ sort, limit, offset, count: rows.length, tokens: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'internal error' });
  }
});

app.get('/api/v1/tokens/:address', async (req, res) => {
  try {
    const row = await getToken(db, req.params.address);
    if (!row) return res.status(404).json({ error: 'not found' });
    res.json(row);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'internal error' });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3001;
if (require.main === module) {
  app.listen(PORT, () => console.log(`[api] listening on :${PORT}`));
}

module.exports = app;
