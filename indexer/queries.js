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
  // Gated on meta_ok, exactly like the price the API publishes. Without the
  // gate this sorted on the RAW price while the SELECT withheld it, so
  // sort=mcap returned tokens whose price is null — 16 of the first 17 on
  // mainnet, all rendering as "—". Rank on the number we are willing to show.
  mcap: 'CASE WHEN t.meta_ok THEN COALESCE(lp.price, 0) * COALESCE(t.total_supply, 0) ELSE 0 END',
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
      t.total_supply,
      t.meta_ok, t.meta_source,
      p.logo_url, p.website, p.twitter, p.telegram, p.source AS profile_source,
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
    LEFT JOIN token_profiles p ON p.address = t.address
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
      t.total_supply,
      t.meta_ok, t.meta_source,
      p.logo_url, p.website, p.twitter, p.telegram, p.description, p.source AS profile_source,
      CASE WHEN t.meta_ok THEN COALESCE(lp.price,0) ELSE NULL END price,
      COALESCE(v.vol,0) volume_24h, COALESCE(v.txns,0) txns_24h,
      COALESCE(v.traders,0) traders_24h, COALESCE(h.holders,0) holders
    FROM tokens t
    LEFT JOIN latest_price lp ON lp.token_address = t.address
    LEFT JOIN vol24 v ON v.token_address = t.address
    LEFT JOIN holders h ON h.token_address = t.address
    LEFT JOIN token_profiles p ON p.address = t.address
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
    SELECT s.token_address, t.symbol, t.name, t.meta_ok, p.logo_url, s.block_number, s.block_time, s.tx_hash,
           s.trader, s.side, s.usdc_amount, s.token_amount, s.price
    FROM swaps s JOIN tokens t ON t.address = s.token_address
    LEFT JOIN token_profiles p ON p.address = s.token_address
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

/** Everything the Portfolio view needs for one Arc wallet, from the tables the
 *  worker already keeps: DEX-token balances from the Transfer ledger (exact),
 *  launchpad positions from the trade log (buys minus sells — a transfer of a
 *  curve token between wallets isn't seen here, so the app confirms these few
 *  with balanceOf before showing a Sell button), the wallet's trades on both,
 *  and the coins it launched. One query per section, all indexed columns. */
/** Postgres returns NUMERIC as an exact decimal string; pg-mem (tests) may
 *  hand back a float like 1e+21. Both become the exact integer string. */
const exactStr = v => { const s = String(v); return /e/i.test(s) ? BigInt(Math.round(Number(s))).toString() : s; };

async function walletHoldings(db, wallet) {
  const wl = wallet.toLowerCase();
  const dex = await db.query(`
    WITH ${LATEST_PRICE_CTE}
    SELECT t.address, t.name, t.symbol, t.decimals, t.dex, t.pool_ref, t.meta_ok, t.total_supply,
           p.logo_url,
           b.balance,
           CASE WHEN t.meta_ok THEN COALESCE(lp.price, 0) ELSE NULL END AS price
    FROM balances b
    JOIN tokens t ON t.address = b.token_address
    LEFT JOIN latest_price lp ON lp.token_address = t.address
    LEFT JOIN token_profiles p ON p.address = t.address
    WHERE b.holder = $1 AND b.balance > 0
    ORDER BY b.balance DESC
  `, [wl]);
  const launch = await db.query(`
    SELECT * FROM (
      SELECT lt.address, lt.name, lt.symbol, lt.creator, lt.created_at,
             SUM(CASE WHEN tr.side = 'buy' THEN tr.token_amount ELSE 0 END)
               - SUM(CASE WHEN tr.side = 'sell' THEN tr.token_amount ELSE 0 END) AS position,
             COUNT(tr.id) AS trades
      FROM launch_trades tr JOIN launch_tokens lt ON lt.address = tr.token_address
      WHERE tr.trader = $1
      GROUP BY lt.address, lt.name, lt.symbol, lt.creator, lt.created_at
    ) p WHERE p.position > 0
  `, [wl]);
  return {
    dex: dex.rows.map(r => ({
      address: r.address, name: r.name, symbol: r.symbol, decimals: Number(r.decimals), dex: r.dex, pool_ref: r.pool_ref,
      meta_ok: !!r.meta_ok, logo_url: r.logo_url || null, balance: exactStr(r.balance),
      price: r.price == null ? null : Number(r.price), total_supply: r.total_supply == null ? null : Number(r.total_supply),
    })),
    launch: launch.rows.map(r => ({
      address: r.address, name: r.name, symbol: r.symbol, creator: r.creator, created_at: r.created_at,
      position: Number(r.position), trades: Number(r.trades),
    })),
  };
}

async function walletTrades(db, wallet, limit = 100) {
  const wl = wallet.toLowerCase();
  const r = await db.query(`
    SELECT * FROM (
      SELECT 'dex' AS venue, s.token_address, t.symbol, t.name, s.block_time, s.tx_hash, s.side, s.usdc_amount, s.token_amount, s.price
      FROM swaps s JOIN tokens t ON t.address = s.token_address WHERE s.trader = $1
      UNION ALL
      SELECT 'launchpad' AS venue, l.token_address, lt.symbol, lt.name, l.block_time, l.tx_hash, l.side, l.usdc_amount, l.token_amount,
             CASE WHEN l.token_amount > 0 THEN l.usdc_amount / l.token_amount ELSE NULL END AS price
      FROM launch_trades l JOIN launch_tokens lt ON lt.address = l.token_address WHERE l.trader = $1
    ) x ORDER BY block_time DESC LIMIT $2
  `, [wl, Math.min(Number(limit) || 100, 500)]);
  return r.rows.map(x => ({ venue: x.venue, token_address: x.token_address, symbol: x.symbol, name: x.name, block_time: x.block_time,
    tx_hash: x.tx_hash, side: x.side, usdc_amount: Number(x.usdc_amount), token_amount: Number(x.token_amount),
    price: x.price == null ? null : Number(x.price) }));
}

async function walletLaunches(db, wallet) {
  const r = await db.query(`
    SELECT lt.address, lt.name, lt.symbol, lt.created_at, lt.created_block,
           COALESCE(SUM(tr.usdc_amount), 0) AS volume, COUNT(tr.id) AS trades
    FROM launch_tokens lt LEFT JOIN launch_trades tr ON tr.token_address = lt.address
    WHERE lt.creator = $1
    GROUP BY lt.address, lt.name, lt.symbol, lt.created_at, lt.created_block
    ORDER BY lt.created_block DESC
  `, [wallet.toLowerCase()]);
  return r.rows.map(x => ({ address: x.address, name: x.name, symbol: x.symbol, created_at: x.created_at,
    volume: Number(x.volume), trades: Number(x.trades) }));
}

module.exports = { listTokens, getToken, getStats, recentSwaps, pointsLeaderboard, pointsForWallet, walletHoldings, walletTrades, walletLaunches };
