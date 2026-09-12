// Solana holdings for one owner, read server-side and handed to the browser.
//
// Why here and not in the page: Solana's public RPC refuses browser origins
// (403 from a page on arclite.fun, checked 12 Sept 2026), the keyless public
// endpoints that do answer browsers block getTokenAccountsByOwner, and a
// provider key can't live in a public repo. So the API makes the two RPC
// calls with whatever SOL_RPC it was given, prices the mints through
// GeckoTerminal (keyless, the same source the terminal's Solana tab already
// uses), and caches the answer per owner for a short while.
//
// Nothing here signs anything. The page connects Phantom only to learn the
// public key; every read goes through this endpoint.
//
// Program ids are the canonical ones from spl.solana.com; the wrapped-SOL
// mint is from the same docs.
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022    = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnwqTU6HsYyMXR';
const WSOL          = 'So11111111111111111111111111111111111111112';
// Solana's own public endpoint (solana.com/docs/references/clusters): rate
// limited, no SLA, and it blocks some cloud IPs outright. Set SOL_RPC on the
// service to a provider URL that carries its key — the key stays in Railway's
// variables, never in this repo.
const DEFAULT_RPC = 'https://api.mainnet-beta.solana.com';
const GECKO = 'https://api.geckoterminal.com/api/v2/networks/solana/tokens/multi/';

const isPubkey = s => typeof s === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);

const ownerCache = new Map();   // owner → { at, data }
const mintCache  = new Map();   // mint  → { at, meta }
const OWNER_TTL = 45 * 1000, MINT_TTL = 10 * 60 * 1000, MAX_MINTS = 60;

async function rpc(url, method, params, fetchImpl) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 12000);
  try {
    const r = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: ac.signal });
    if (!r.ok) throw new Error(`rpc ${method} → ${r.status}`);
    const j = await r.json();
    if (j.error) throw new Error(`rpc ${method}: ${j.error.message || JSON.stringify(j.error)}`);
    return j.result;
  } finally { clearTimeout(t); }
}

/** name / symbol / price / logo for up to 30 mints per call, cached per mint. */
async function mintMeta(mints, fetchImpl) {
  const out = {}, need = [];
  const now = Date.now();
  for (const m of mints) {
    const c = mintCache.get(m);
    if (c && now - c.at < MINT_TTL) out[m] = c.meta; else need.push(m);
  }
  for (let i = 0; i < need.length; i += 30) {
    const batch = need.slice(i, i + 30);
    try {
      const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 10000);
      const r = await fetchImpl(GECKO + batch.join(','), { headers: { accept: 'application/json' }, signal: ac.signal });
      clearTimeout(t);
      if (!r.ok) continue;
      const j = await r.json();
      for (const d of (j.data || [])) {
        const a = d.attributes || {};
        const meta = { name: a.name || '', symbol: a.symbol || '', decimals: a.decimals == null ? null : Number(a.decimals),
          price: a.price_usd == null ? null : Number(a.price_usd), logo: a.image_url && a.image_url !== 'missing.png' ? a.image_url : null };
        out[a.address] = meta; mintCache.set(a.address, { at: now, meta });
      }
    } catch (e) { /* unpriced is a valid answer */ }
  }
  return out;
}

async function solHoldings(owner, { fetchImpl = fetch, rpcUrl = process.env.SOL_RPC || DEFAULT_RPC } = {}) {
  if (!isPubkey(owner)) { const e = new Error('bad owner'); e.status = 400; throw e; }
  const c = ownerCache.get(owner);
  if (c && Date.now() - c.at < OWNER_TTL) return c.data;

  const [lamports, a1, a2] = await Promise.all([
    rpc(rpcUrl, 'getBalance', [owner], fetchImpl),
    rpc(rpcUrl, 'getTokenAccountsByOwner', [owner, { programId: TOKEN_PROGRAM }, { encoding: 'jsonParsed' }], fetchImpl),
    rpc(rpcUrl, 'getTokenAccountsByOwner', [owner, { programId: TOKEN_2022 }, { encoding: 'jsonParsed' }], fetchImpl).catch(() => ({ value: [] })),
  ]);
  const accounts = [...(a1?.value || []), ...(a2?.value || [])];
  // one row per mint (a wallet can hold several accounts of the same mint)
  const byMint = new Map();
  for (const acc of accounts) {
    const info = acc?.account?.data?.parsed?.info; if (!info) continue;
    const ta = info.tokenAmount || {};
    const ui = Number(ta.uiAmount || 0); if (!(ui > 0)) continue;
    const prev = byMint.get(info.mint) || { mint: info.mint, amount: 0, decimals: Number(ta.decimals || 0), raw: 0n };
    prev.amount += ui; prev.raw += BigInt(ta.amount || '0');
    byMint.set(info.mint, prev);
  }
  const rows = [...byMint.values()].slice(0, MAX_MINTS);
  const meta = await mintMeta([WSOL, ...rows.map(r => r.mint)], fetchImpl);
  const solPrice = meta[WSOL]?.price ?? null;
  const sol = Number(typeof lamports === 'object' ? lamports.value : lamports) / 1e9;
  const tokens = rows.map(r => {
    const m = meta[r.mint] || {};
    return { mint: r.mint, amount: r.amount, raw: r.raw.toString(), decimals: r.decimals,
      symbol: m.symbol || '', name: m.name || '', logo: m.logo || null,
      price: m.price ?? null, value: m.price != null ? r.amount * m.price : null };
  }).sort((a, b) => (b.value || 0) - (a.value || 0));
  const data = { owner, sol: { amount: sol, price: solPrice, value: solPrice != null ? sol * solPrice : null }, tokens,
    total: (solPrice != null ? sol * solPrice : 0) + tokens.reduce((s, t) => s + (t.value || 0), 0), at: new Date().toISOString() };
  ownerCache.set(owner, { at: Date.now(), data });
  return data;
}

module.exports = { solHoldings, isPubkey, TOKEN_PROGRAM, TOKEN_2022, WSOL, DEFAULT_RPC };
