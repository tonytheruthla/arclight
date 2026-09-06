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

module.exports = { getState, setState, upsertToken, getKnownTokens, getTokensMissingMeta, updateTokenMeta, insertSwap, applyTransfer, takeSnapshot,
  upsertLaunchToken, insertLaunchTrade, sharesToday, addSharePoint, ZERO, DEAD };
