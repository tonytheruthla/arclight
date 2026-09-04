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

module.exports = { listTokens, getToken };
