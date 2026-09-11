// Token metadata resolver — names, symbols, logos and socials WITHOUT an RPC.
//
// Nothing about a token's logo lives on-chain. On Arc every explorer gets it
// from the launchpad the token was created on: Tolly and Sharc both publish a
// public token list with name / symbol / image / socials, the same way every
// Solana explorer reads pump.fun's. This module pulls those lists on a timer
// and fills our `tokens` names and `token_profiles` from them.
//
// It also confirms decimals for free: a launchpad quotes its own USD price for
// the token. Our indexed price assumed 18 decimals. If the two agree to within
// a factor of 3, the assumption was right and the token's meta_ok flips true —
// which is what unlocks prices in the API. (If they disagree, the price stays
// hidden and we wait for eth_call after the 16th.)
//
// Polite by construction: Tolly's list is 5 pages of 200, Sharc's is one call,
// once every META_INTERVAL_MS (default 10 min). Nothing per-token.
'use strict';
const { upsertProfile, setTokenNames, setTokenSupply } = require('./store');

const TOLLY = 'https://api.tollylabs.com';
const SHARC = 'https://sharc.fun';
const UA = 'arclite-explorer/1.0 (+https://arclite.fun)';
const log = (...a) => console.log('[meta]', ...a);

const ipfsToHttp = u => (typeof u === 'string' && u.startsWith('ipfs://')) ? u : u;   // kept as ipfs://; the image proxy picks the gateway
const clean = s => (typeof s === 'string' && s.trim()) ? s.trim().slice(0, 300) : null;

async function getJson(url, fetchImpl = fetch, timeoutMs = 15000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetchImpl(url, { headers: { accept: 'application/json', 'user-agent': UA }, signal: ac.signal });
    if (!r.ok) throw new Error(`${url} → ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

/** Tolly: scope=all is their own chain-wide scan (~900 tokens with pools).
 *  Returns Map(address → {name,symbol,logoUrl,website,twitter,telegram,price}). */
async function fetchTolly(fetchImpl) {
  const out = new Map();
  for (let offset = 0, page = 0; page < 10; offset += 200, page++) {
    const j = await getJson(`${TOLLY}/tokens?q=&sort=volume&dir=desc&limit=200&offset=${offset}&scope=all`, fetchImpl);
    const rows = j.tokens || [];
    for (const t of rows) {
      if (!t.address) continue;
      out.set(t.address.toLowerCase(), {
        name: clean(t.name) || '', symbol: clean(t.symbol) || '',
        logoUrl: ipfsToHttp(clean(t.image_uri)), website: clean(t.website), twitter: clean(t.twitter), telegram: clean(t.telegram),
        price: Number(t.price) || 0, source: 'tolly',
        // Tolly publishes marketCap and price; their ratio is the supply.
        // 611688.27 / 0.000611688 = 1,000,000,000 on a launchpad token.
        supply: (Number(t.marketCap) > 0 && Number(t.price) > 0) ? Number(t.marketCap) / Number(t.price) : null,
      });
    }
    if (rows.length < 200 || out.size >= Number(j.total || Infinity)) break;
  }
  return out;
}

/** Sharc: its own launchpad only (bonding curve + graduated). */
async function fetchSharc(fetchImpl) {
  const out = new Map();
  const j = await getJson(`${SHARC}/api/tokens`, fetchImpl);
  for (const t of (Array.isArray(j) ? j : (j.tokens || []))) {
    if (!t.address) continue;
    const m = t.metadata || {};
    out.set(t.address.toLowerCase(), {
      name: clean(t.name) || '', symbol: clean(t.symbol) || '',
      logoUrl: ipfsToHttp(clean(m.image)), website: clean(m.website), twitter: clean(m.twitter), telegram: clean(m.telegram),
      description: clean(m.description),
      price: t.priceE18 ? Number(t.priceE18) / 1e18 : 0, source: 'sharc',
    });
  }
  return out;
}

/** Does the launchpad's quoted price agree with ours under the 18dp assumption? */
function pricesAgree(ours, theirs) {
  if (!(ours > 0) || !(theirs > 0)) return false;
  const r = ours / theirs;
  return r > 1 / 3 && r < 3;
}

/** One pass. `db` is any pg-compatible pool. Returns counters for logging/tests. */
async function resolveOnce(db, { fetchImpl = fetch, sources = ['tolly', 'sharc'] } = {}) {
  const found = new Map();
  for (const s of sources) {
    try {
      const m = s === 'tolly' ? await fetchTolly(fetchImpl) : s === 'sharc' ? await fetchSharc(fetchImpl) : new Map();
      for (const [k, v] of m) if (!found.has(k)) found.set(k, v);   // first source wins (tolly is chain-wide)
      log(`${s}: ${m.size} tokens`);
    } catch (e) { log(`${s} failed: ${String(e.message || e).slice(0, 120)}`); }
  }
  if (!found.size) return { found: 0, named: 0, confirmed: 0, profiles: 0 };

  // Our tokens + the price we computed for each (18dp assumed at insert time).
  const ours = await db.query(`
    WITH latest_id AS (SELECT token_address, MAX(id) AS max_id FROM swaps GROUP BY token_address)
    SELECT t.address, t.name, t.symbol, t.meta_ok, t.total_supply, s.price
    FROM tokens t
    LEFT JOIN latest_id li ON li.token_address = t.address
    LEFT JOIN swaps s ON s.id = li.max_id`);
  const launch = await db.query('SELECT address FROM launch_tokens');
  const known = new Set([...ours.rows.map(r => r.address), ...launch.rows.map(r => r.address)]);

  let named = 0, confirmed = 0, profiles = 0, supplied = 0;
  for (const row of ours.rows) {
    const m = found.get(row.address);
    if (!m) continue;
    // Supply is written once. Sanity-bound it: anything outside 1e3..1e15
    // whole tokens is a bad ratio (a zero price on one side), not a real
    // token, and a wrong supply makes every market cap wrong.
    if (row.total_supply == null && m.supply && m.supply > 1e3 && m.supply < 1e15) {
      await setTokenSupply(db, row.address, m.supply);
      supplied++;
    }
    const confirmOk = !row.meta_ok && pricesAgree(Number(row.price), m.price);
    if (!row.meta_ok || row.name === '' || row.symbol === '') {
      await setTokenNames(db, row.address, { name: m.name, symbol: m.symbol, source: m.source, confirmOk });
      named++; if (confirmOk) confirmed++;
    }
  }
  for (const [addr, m] of found) {
    if (!known.has(addr)) continue;                       // profiles only for tokens we show
    if (!(m.logoUrl || m.website || m.twitter || m.telegram)) continue;
    if (await upsertProfile(db, { address: addr, ...m })) profiles++;
  }
  log(`named ${named} · confirmed decimals ${confirmed} · profiles ${profiles} · supply ${supplied}`);
  return { found: found.size, named, confirmed, profiles, supplied };
}

/** Run forever on a timer. Safe to host in the API process: no RPC, no locks. */
function startResolver(db, { intervalMs = Number(process.env.META_INTERVAL_MS || 600_000), sources } = {}) {
  let busy = false;
  const tick = async () => {
    if (busy) return; busy = true;
    try { await resolveOnce(db, { sources }); } catch (e) { log('error', String(e.message || e).slice(0, 160)); }
    finally { busy = false; }
  };
  tick();
  return setInterval(tick, intervalMs);
}

module.exports = { resolveOnce, startResolver, fetchTolly, fetchSharc, pricesAgree };
