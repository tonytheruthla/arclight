// DB read/write functions. Every function takes `db` (anything exposing
// .query(sql, params) — a real `pg` Pool in production, a pg-mem adapter in
// tests) so the same code path is what gets tested, not a parallel mock.
const ZERO = '0x0000000000000000000000000000000000000000';
const DEAD = '0x000000000000000000000000000000000000dead';

async function getState(db, chainId) {
  const r = await db.query('SELECT last_block FROM indexer_state WHERE chain_id = $1', [chainId]);
  return r.rows.length ? Number(r.rows[0].last_block) : null;
}

async function setState(db, chainId, block) {
  await db.query(
    `INSERT INTO indexer_state (chain_id, last_block) VALUES ($1, $2)
     ON CONFLICT (chain_id) DO UPDATE SET last_block = $2`,
    [chainId, block]
  );
}

async function upsertToken(db, t) {
  await db.query(
    `INSERT INTO tokens (address, name, symbol, decimals, dex, pool_ref, fee, usdc_is_token0, first_seen_block, meta_ok)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (address) DO NOTHING`,
    [t.address.toLowerCase(), t.name || '', t.symbol || '', t.decimals || 18,
     t.dex, t.poolRef, t.fee, t.usdcIsToken0, t.block, t.metaOk === true]
  );
}

/** Tokens whose name/symbol/decimals we never managed to read. Retried by the
 *  worker so a transient RPC failure doesn't leave a token permanently blank. */
async function getTokensMissingMeta(db, limit = 10) {
  const r = await db.query(
    'SELECT address FROM tokens WHERE meta_ok = false ORDER BY first_seen_block LIMIT $1',
    [limit]
  );
  return r.rows.map(x => x.address);
}

async function updateTokenMeta(db, address, meta) {
  await db.query(
    `UPDATE tokens SET name = $2, symbol = $3, decimals = $4, meta_ok = true WHERE address = $1`,
    [address.toLowerCase(), meta.name || '', meta.symbol || '', meta.decimals]
  );
}

async function getKnownTokens(db, dex) {
  const r = dex
    ? await db.query('SELECT * FROM tokens WHERE dex = $1', [dex])
    : await db.query('SELECT * FROM tokens', []);
  return r.rows;
}

async function insertSwap(db, tokenAddress, s) {
  await db.query(
    `INSERT INTO swaps (token_address, block_number, block_time, tx_hash, log_index, trader, side, usdc_amount, token_amount, price)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (tx_hash, log_index) DO NOTHING`,
    [tokenAddress.toLowerCase(), s.block, s.blockTime, s.txHash, s.logIndex,
     s.trader.toLowerCase(), s.side, s.usdcAmount, s.tokenAmount, s.price]
  );
}

/** Apply a Transfer as a balance delta. Mint (from=0x0) and burn (to=0x0 or
 *  0x...dead) are tracked as amount flowing to/from those sentinel addresses,
 *  but the holders query (see queries.js) excludes them — a burn address
 *  holding tokens isn't a "holder" for the UI's purposes. */
/** BigInt -> exact decimal string, so NUMERIC gets the true value and never a
 *  float approximation. 1234n at 3 decimals -> "1.234". */
function scaleToDecimalString(v, decimals) {
  const neg = v < 0n;
  let a = neg ? -v : v;
  const s = a.toString().padStart(decimals + 1, '0');
  const int = s.slice(0, s.length - decimals);
  let frac = decimals ? s.slice(s.length - decimals).replace(/0+$/, '') : '';
  return (neg ? '-' : '') + int + (frac ? '.' + frac : '');
}

/** Apply many balance deltas in ONE statement per batch instead of two queries
 *  per transfer.
 *
 *  WHY THIS EXISTS
 *  ---------------
 *  applyTransfer did two awaited round trips per Transfer log. At Arc's
 *  post-public volume that was ~180,000 sequential queries inside a single
 *  chunk transaction — which was essentially the whole chunk time, and which
 *  held locks long enough that the API could not even run its migrations. On
 *  17 Sept that took the site down.
 *
 *  `deltas` is a Map keyed `token|holder` with BigInt values, already netted in
 *  memory. Netting first matters twice over: it collapses a holder who traded
 *  fifty times into one row, and it guarantees each key appears once — Postgres
 *  refuses an ON CONFLICT DO UPDATE that touches the same row twice in one
 *  statement.
 *
 *  Rows are sent in batches because Postgres caps a statement at 65,535
 *  parameters and we use three per row.
 */
async function applyTransfersBatch(db, deltas, decimalsFor, { batchSize = 500 } = {}) {
  const entries = [...deltas.entries()].filter(([, v]) => v !== 0n);
  let written = 0;
  for (let i = 0; i < entries.length; i += batchSize) {
    const slice = entries.slice(i, i + batchSize);
    const vals = [], params = [];
    slice.forEach(([key, raw], j) => {
      const sep = key.indexOf('|');
      const token = key.slice(0, sep), holder = key.slice(sep + 1);
      vals.push(`($${j * 3 + 1}, $${j * 3 + 2}, $${j * 3 + 3}::numeric)`);
      params.push(token, holder, scaleToDecimalString(raw, decimalsFor(token)));
    });
    await db.query(
      `INSERT INTO balances (token_address, holder, balance) VALUES ${vals.join(',')}
       ON CONFLICT (token_address, holder) DO UPDATE SET balance = balances.balance + EXCLUDED.balance`,
      params);
    written += slice.length;
  }
  return written;
}

async function applyTransfer(db, tokenAddress, t) {
  // Both operands cast explicitly. `0 - $3` makes Postgres infer INTEGER from the
  // literal and reject a fractional amount; and pg-mem (the test engine) drops the
  // subtraction entirely for `0 - $3::numeric`, returning +amount. Spelling it as
  // 0::numeric - $3::numeric is correct in both, so the tests test the real thing.
  const addr = tokenAddress.toLowerCase();
  await db.query(
    `INSERT INTO balances (token_address, holder, balance) VALUES ($1,$2, 0::numeric - $3::numeric)
     ON CONFLICT (token_address, holder) DO UPDATE SET balance = balances.balance - $3::numeric`,
    [addr, t.from.toLowerCase(), t.amount]
  );
  await db.query(
    `INSERT INTO balances (token_address, holder, balance) VALUES ($1,$2,$3)
     ON CONFLICT (token_address, holder) DO UPDATE SET balance = balances.balance + $3`,
    [addr, t.to.toLowerCase(), t.amount]
  );
}

async function takeSnapshot(db, tokenAddress, price, at) {
  await db.query(
    `INSERT INTO price_snapshots (token_address, snapshot_at, price) VALUES ($1,$2,$3)
     ON CONFLICT (token_address, snapshot_at) DO NOTHING`,
    [tokenAddress.toLowerCase(), at, price]
  );
}

// ---- Arclite launchpad ------------------------------------------------------

async function upsertLaunchToken(db, t) {
  await db.query(
    `INSERT INTO launch_tokens (address, creator, name, symbol, created_block, created_at)
     VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (address) DO NOTHING`,
    [t.address.toLowerCase(), t.creator.toLowerCase(), t.name || '', t.symbol || '', t.block, t.blockTime]
  );
}

async function insertLaunchTrade(db, t) {
  await db.query(
    `INSERT INTO launch_trades (token_address, block_number, block_time, tx_hash, log_index, trader, side, usdc_amount, token_amount)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (tx_hash, log_index) DO NOTHING`,
    [t.token.toLowerCase(), t.block, t.blockTime, t.txHash, t.logIndex, t.trader.toLowerCase(), t.side, t.usdcAmount, t.tokenAmount]
  );
}

// ---- share points -----------------------------------------------------------

/** How many share points this wallet already earned today (UTC). */
async function sharesToday(db, wallet, day) {
  const r = await db.query('SELECT COUNT(*) AS n FROM share_points WHERE wallet = $1 AND day = $2', [wallet.toLowerCase(), day]);
  return Number(r.rows[0].n);
}

/** Record one share point. Returns true if a new row was written, false if
 *  this wallet already has a point for this token today (the PK is the cap). */
async function addSharePoint(db, wallet, token, day) {
  const args = [wallet.toLowerCase(), token.toLowerCase(), day];
  // Explicit existence check rather than trusting rowCount / RETURNING on a
  // DO NOTHING insert: Postgres reports 0 rows there, pg-mem reports 1, and the
  // tests run on pg-mem. The primary key is still what enforces one row — under
  // a concurrent double-claim both callers may see "awarded" but only one row
  // exists, and points are counted from rows, never from responses.
  const seen = await db.query(
    'SELECT 1 FROM share_points WHERE wallet = $1 AND token_address = $2 AND day = $3', args);
  if (seen.rows.length) return false;
  await db.query(
    `INSERT INTO share_points (wallet, token_address, day) VALUES ($1,$2,$3)
     ON CONFLICT (wallet, token_address, day) DO NOTHING`, args);
  return true;
}

// ---- token profiles (logo + socials) ----------------------------------------

/** Write a profile. Launchpad sources never overwrite a creator-submitted one:
 *  the team that launched the coin outranks any aggregator, including us. */
async function upsertProfile(db, p) {
  const addr = p.address.toLowerCase();
  const cur = await db.query('SELECT source FROM token_profiles WHERE address = $1', [addr]);
  if (cur.rows.length && cur.rows[0].source === 'creator' && p.source !== 'creator') return false;
  if (cur.rows.length) {
    await db.query(
      `UPDATE token_profiles SET name=$2, symbol=$3, logo_url=$4, website=$5, twitter=$6, telegram=$7, description=$8, source=$9, updated_by=$10, updated_at=now()
       WHERE address = $1`,
      [addr, p.name || '', p.symbol || '', p.logoUrl || null, p.website || null, p.twitter || null, p.telegram || null, p.description || null, p.source, p.updatedBy || null]);
  } else {
    await db.query(
      `INSERT INTO token_profiles (address, name, symbol, logo_url, website, twitter, telegram, description, source, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [addr, p.name || '', p.symbol || '', p.logoUrl || null, p.website || null, p.twitter || null, p.telegram || null, p.description || null, p.source, p.updatedBy || null]);
  }
  return true;
}

async function getProfiles(db, addrs) {
  if (!addrs.length) return [];
  // Expanded IN list rather than = ANY($1): identical on Postgres, and pg-mem
  // (the test double) returns nothing for array parameters.
  const lc = addrs.map(a => a.toLowerCase());
  const r = await db.query(`SELECT * FROM token_profiles WHERE address IN (${lc.map((_, i) => '$' + (i + 1)).join(',')})`, lc);
  return r.rows;
}

/** Fill name/symbol on a tokens row from a launchpad, without touching
 *  decimals/meta_ok unless the caller has verified them (confirmOk). */
/** Total supply in whole tokens. Written once by default: for an ordinary ERC-20
 *  a later different value is a data problem upstream, not something to silently
 *  overwrite.
 *
 *  `force` is the one legitimate exception. Arclite pad tokens BURN their unsold
 *  curve supply at graduation, so their totalSupply genuinely falls — once. Every
 *  market cap is price x total_supply, so if this column never updates, our own
 *  UI keeps quoting the pre-burn number and the burn fixes nothing where anyone
 *  can see it. Only the on-chain read may pass force. */
async function setTokenSupply(db, address, supply, { force = false } = {}) {
  await db.query(
    force
      ? `UPDATE tokens SET total_supply = $2 WHERE address = $1`
      : `UPDATE tokens SET total_supply = $2 WHERE address = $1 AND total_supply IS NULL`,
    [address.toLowerCase(), supply]);
}

/** Addresses the Arclite pad launched — the only tokens whose supply can change. */
async function getLaunchTokenAddresses(db, limit = 50) {
  const r = await db.query('SELECT address FROM launch_tokens ORDER BY address LIMIT $1', [limit]);
  return r.rows.map(x => x.address);
}

async function setTokenNames(db, address, { name, symbol, source, confirmOk = false }) {
  if (confirmOk) {
    await db.query(
      `UPDATE tokens SET name = $2, symbol = $3, meta_source = $4, meta_checked_at = now(), meta_ok = true, decimals = 18 WHERE address = $1`,
      [address.toLowerCase(), name || '', symbol || '', source]);
  } else {
    await db.query(
      `UPDATE tokens SET name = CASE WHEN name = '' THEN $2 ELSE name END,
                         symbol = CASE WHEN symbol = '' THEN $3 ELSE symbol END,
                         meta_source = COALESCE(meta_source, $4), meta_checked_at = now()
       WHERE address = $1`,
      [address.toLowerCase(), name || '', symbol || '', source]);
  }
}

async function putImage(db, address, contentType, bytes) {
  const addr = address.toLowerCase();
  const cur = await db.query('SELECT 1 FROM token_images WHERE address = $1', [addr]);
  if (cur.rows.length) await db.query('UPDATE token_images SET content_type=$2, bytes=$3, fetched_at=now() WHERE address=$1', [addr, contentType, bytes]);
  else await db.query('INSERT INTO token_images (address, content_type, bytes) VALUES ($1,$2,$3)', [addr, contentType, bytes]);
}
async function getImage(db, address) {
  const r = await db.query('SELECT content_type, bytes, fetched_at FROM token_images WHERE address = $1', [address.toLowerCase()]);
  return r.rows[0] || null;
}

module.exports = { applyTransfersBatch, scaleToDecimalString, getState, setState, upsertToken, getKnownTokens, getTokensMissingMeta, updateTokenMeta, insertSwap, applyTransfer, takeSnapshot,
  upsertLaunchToken, insertLaunchTrade, sharesToday, addSharePoint, upsertProfile, getProfiles, setTokenNames, setTokenSupply, getLaunchTokenAddresses, putImage, getImage, ZERO, DEAD };
