// Aggregation, computed on read from the raw event tables. Fine at today's
// scale; if this ever gets slow, the fix is a materialized view refreshed
// every minute, not a rewrite — every query here is already a plain
// GROUP BY, nothing exotic.
//
// Deliberately avoids DISTINCT ON and window functions for "latest row per
// token", even though both are valid, idiomatic Postgres — this was tested
// against real query semantics (see test.js) and MAX(id)+JOIN is what
// verified correct, so that's what ships. `id` is a BIGSERIAL primary key,
// so MAX(id) per token is unambiguous even when two swaps land in the same
// block and share a block_time.
const { ZERO, DEAD } = require('./store');

const SORT_COLUMNS = {
  volume: 'COALESCE(v.vol, 0)',
  mcap: 'COALESCE(lp.price, 0)', // mcap = price * supply; supply is constant off-chain, so price sorts the same
  txns: 'COALESCE(v.txns, 0)',
  holders: 'COALESCE(h.holders, 0)',
  new: 't.first_seen_block',
  change: 'COALESCE(chg.pct, 0)',
};

const LATEST_PRICE_CTE = `
  latest_id AS (
    SELECT token_address, MAX(id) AS max_id FROM swaps GROUP BY token_address
  ),
  latest_price AS (
    SELECT s.token_address, s.price
    FROM swaps s JOIN latest_id li ON li.token_address = s.token_address AND li.max_id = s.id
  )`;

const OLD_PRICE_CTE = `
  old_id AS (
    SELECT token_address, MAX(id) AS max_id FROM swaps
    WHERE block_time <= now() - interval '24 hours'
    GROUP BY token_address
  ),
  old_price AS (
    SELECT s.token_address, s.price
    FROM swaps s JOIN old_id oi ON oi.token_address = s.token_address AND oi.max_id = s.id
  )`;

async function listTokens(db, { sort = 'new', limit = 50, offset = 0 } = {}) {
  const sortCol = SORT_COLUMNS[sort] || SORT_COLUMNS.new;
  const sql = `
    WITH ${LATEST_PRICE_CTE},
    ${OLD_PRICE_CTE},
    vol24 AS (
      SELECT token_address,
             SUM(usdc_amount) AS vol,
             COUNT(*) AS txns,
             COUNT(DISTINCT trader) AS traders
      FROM swaps
      WHERE block_time > now() - interval '24 hours'
      GROUP BY token_address
    ),
    holders AS (
      SELECT token_address, COUNT(*) AS holders
      FROM balances
      WHERE balance > 0 AND holder NOT IN ('${ZERO}', '${DEAD}')
      GROUP BY token_address
    ),
    chg AS (
      SELECT lp.token_address,
             CASE WHEN op.price > 0 THEN ((lp.price - op.price) / op.price) * 100 ELSE NULL END AS pct
      FROM latest_price lp JOIN old_price op ON op.token_address = lp.token_address
    )
    SELECT
      t.address, t.name, t.symbol, t.decimals, t.dex, t.pool_ref, t.first_seen_block, t.first_seen_at,
      t.meta_ok,
      -- Every price is decimal-adjusted, so it is only meaningful once decimals
      -- was really read from the token. Until then report NULL rather than a
      -- confidently wrong number.
      CASE WHEN t.meta_ok THEN COALESCE(lp.price, 0) ELSE NULL END AS price,
      COALESCE(v.vol, 0)         AS volume_24h,
      COALESCE(v.txns, 0)        AS txns_24h,
      COALESCE(v.traders, 0)     AS traders_24h,
      COALESCE(h.holders, 0)     AS holders,
      CASE WHEN t.meta_ok THEN chg.pct ELSE NULL END AS change_24h
    FROM tokens t
    LEFT JOIN latest_price lp ON lp.token_address = t.address
    LEFT JOIN vol24 v         ON v.token_address = t.address
    LEFT JOIN holders h       ON h.token_address = t.address
    LEFT JOIN chg             ON chg.token_address = t.address
    ORDER BY ${sortCol} DESC NULLS LAST
    LIMIT $1 OFFSET $2
  `;
  const r = await db.query(sql, [limit, offset]);
  return r.rows;
}

async function getToken(db, address) {
  const sql = `
    WITH ${LATEST_PRICE_CTE},
    vol24 AS (
      SELECT token_address, SUM(usdc_amount) vol, COUNT(*) txns, COUNT(DISTINCT trader) traders
      FROM swaps WHERE block_time > now() - interval '24 hours' GROUP BY token_address
    ),
    holders AS (
      SELECT token_address, COUNT(*) holders FROM balances
      WHERE balance > 0 AND holder NOT IN ('${ZERO}', '${DEAD}') GROUP BY token_address
    )
    SELECT t.address, t.name, t.symbol, t.decimals, t.dex, t.pool_ref, t.first_seen_block, t.first_seen_at,
      t.meta_ok,
      CASE WHEN t.meta_ok THEN COALESCE(lp.price,0) ELSE NULL END price,
      COALESCE(v.vol,0) volume_24h, COALESCE(v.txns,0) txns_24h,
      COALESCE(v.traders,0) traders_24h, COALESCE(h.holders,0) holders
    FROM tokens t
    LEFT JOIN latest_price lp ON lp.token_address = t.address
    LEFT JOIN vol24 v ON v.token_address = t.address
    LEFT JOIN holders h ON h.token_address = t.address
    WHERE t.address = $1
  `;
  const r = await db.query(sql, [address.toLowerCase()]);
  return r.rows[0] || null;
}

/** Hero-strip numbers: what RadarDEX shows as TOKENS / 24H VOLUME / 24H TXNS,
 *  plus traders and the launchpad's own counters. All from the raw tables. */
async function getStats(db) {
  const r = await db.query(`
    SELECT
      (SELECT COUNT(*) FROM tokens)                                                          AS tokens,
      (SELECT COALESCE(SUM(usdc_amount),0) FROM swaps WHERE block_time > now() - interval '24 hours') AS volume_24h,
      (SELECT COUNT(*) FROM swaps WHERE block_time > now() - interval '24 hours')            AS txns_24h,
      (SELECT COUNT(DISTINCT trader) FROM swaps WHERE block_time > now() - interval '24 hours') AS traders_24h,
      (SELECT COUNT(*) FROM launch_tokens)                                                   AS launched,
      (SELECT COALESCE(SUM(usdc_amount),0) FROM launch_trades WHERE block_time > now() - interval '24 hours') AS launch_volume_24h,
      (SELECT COUNT(*) FROM launch_trades WHERE block_time > now() - interval '24 hours')    AS launch_txns_24h
  `);
  const x = r.rows[0];
  return {
    tokens: Number(x.tokens), volume24h: Number(x.volume_24h), txns24h: Number(x.txns_24h), traders24h: Number(x.traders_24h),
    launched: Number(x.launched), launchVolume24h: Number(x.launch_volume_24h), launchTxns24h: Number(x.launch_txns_24h),
  };
}

/** Live feed: the most recent DEX swaps with the token's symbol attached. */
async function recentSwaps(db, limit = 30) {
  const r = await db.query(`
    SELECT s.token_address, t.symbol, t.name, t.meta_ok, s.block_number, s.block_time, s.tx_hash,
           s.trader, s.side, s.usdc_amount, s.token_amount, s.price
    FROM swaps s JOIN tokens t ON t.address = s.token_address
    ORDER BY s.id DESC LIMIT $1
  `, [limit]);
  return r.rows;
}

/** Points, the rules in one place:
 *    1 point per 1 USDC traded on the Arclite launchpad (buys AND sells count —
 *      volume is volume), floored per wallet, not per trade;
 *    1 point per social share (one per token per UTC day, capped by the API).
 *  Both are additive, nothing else counts. Ranked by total, ties by volume. */
const POINTS_CTE = `
  vol AS (
    SELECT trader AS wallet, SUM(usdc_amount) AS volume, COUNT(*) AS trades
    FROM launch_trades GROUP BY trader
  ),
  sh AS (
    SELECT wallet, COUNT(*) AS shares FROM share_points GROUP BY wallet
  ),
  w AS (
    SELECT wallet FROM vol UNION SELECT wallet FROM sh
  ),
  scored AS (
    SELECT w.wallet,
           COALESCE(v.volume, 0)  AS volume,
           COALESCE(v.trades, 0)  AS trades,
           COALESCE(s.shares, 0)  AS shares,
           FLOOR(COALESCE(v.volume, 0)::numeric) + COALESCE(s.shares, 0) AS points
    FROM w LEFT JOIN vol v ON v.wallet = w.wallet LEFT JOIN sh s ON s.wallet = w.wallet
  )`;

async function pointsLeaderboard(db, limit = 100) {
  const r = await db.query(`
    WITH ${POINTS_CTE}
    SELECT wallet, volume, trades, shares, points FROM scored
    ORDER BY points DESC, volume DESC, wallet ASC LIMIT $1
  `, [limit]);
  const total = await db.query(`WITH ${POINTS_CTE} SELECT COUNT(*) AS n FROM scored`);
  return { traders: Number(total.rows[0].n), rows: r.rows.map(x => ({
    wallet: x.wallet, volume: Number(x.volume), trades: Number(x.trades), shares: Number(x.shares), points: Number(x.points),
  })) };
}

async function pointsForWallet(db, wallet) {
  const wl = wallet.toLowerCase();
  const r = await db.query(`WITH ${POINTS_CTE} SELECT wallet, volume, trades, shares, points FROM scored WHERE wallet = $1`, [wl]);
  const me = r.rows[0]
    ? { wallet: wl, volume: Number(r.rows[0].volume), trades: Number(r.rows[0].trades), shares: Number(r.rows[0].shares), points: Number(r.rows[0].points) }
    : { wallet: wl, volume: 0, trades: 0, shares: 0, points: 0 };
  // Rank = 1 + wallets strictly ahead. Same tie-break as the board.
  const rk = await db.query(
    `WITH ${POINTS_CTE} SELECT COUNT(*) AS n FROM scored WHERE points > $1::numeric OR (points = $1::numeric AND volume > $2::numeric)`,
    [me.points, me.volume]);
  me.rank = me.points > 0 || me.volume > 0 ? 1 + Number(rk.rows[0].n) : null;
  return me;
}

module.exports = { listTokens, getToken, getStats, recentSwaps, pointsLeaderboard, pointsForWallet };
