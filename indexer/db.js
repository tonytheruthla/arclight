// Real Postgres connection, used by worker.js and api.js in production.
// test.js uses pg-mem instead and never imports this file, so tests run
// with zero external dependencies.
const { Pool } = require('pg');

function makePool() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL not set. See DEPLOY.md step 3.');
  }
  /* statement_timeout is the difference between a bad night and a log line.
   *
   * runChunk wraps a whole chunk in ONE transaction: BEGIN, ~180,000 queries,
   * COMMIT. schema.sql is all CREATE TABLE/INDEX IF NOT EXISTS, which need
   * locks on those same tables. So an API boot queues behind the worker's open
   * transaction — and if that transaction is stuck, migrate() waits FOREVER
   * with no output at all. On 17 Sept that took the whole site down and the
   * only evidence was a missing log line.
   *
   * A statement that cannot finish in the budget now fails loudly instead.
   * The worker needs a long budget because its chunks are genuinely long; the
   * API's queries should never take more than a few seconds, so it gets a
   * short one and reports rather than hangs. */
  const isWorker = process.env.DB_ROLE === 'worker';
  const statement_timeout = Number(process.env.DB_STATEMENT_TIMEOUT_MS || (isWorker ? 300000 : 30000));
  return new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
    statement_timeout,
    connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS || 10000),
    max: Number(process.env.DB_POOL_MAX || (isWorker ? 4 : 8)),
  });
}

/** Apply schema.sql. Every statement in it is CREATE ... IF NOT EXISTS, so this
 *  is safe to run on every boot — it's how new tables (launch_trades,
 *  share_points, ...) reach the live database without a manual psql step.
 *  Columns added to existing tables still need an explicit ALTER; see the
 *  MIGRATIONS list below, each guarded so re-running is a no-op. */
async function migrate(pool) {
  console.log('[db] migrating…');          // so a hang is visibly a HANG, not a silent start
  const fs = require('fs');
  const sql = fs.readFileSync(__dirname + '/schema.sql', 'utf8');
  await pool.query(sql);
  const MIGRATIONS = [
    'ALTER TABLE tokens ADD COLUMN IF NOT EXISTS meta_ok BOOLEAN NOT NULL DEFAULT false',
    // meta_source records where name/symbol came from when it was not eth_call
    // ('tolly'/'sharc' launchpad APIs). meta_checked_at lets the resolver skip
    // tokens it looked at recently.
    "ALTER TABLE tokens ADD COLUMN IF NOT EXISTS meta_source TEXT",
    'ALTER TABLE tokens ADD COLUMN IF NOT EXISTS meta_checked_at TIMESTAMPTZ',
  ];
  for (const m of MIGRATIONS) await pool.query(m);
  console.log('[db] schema up to date');
}

module.exports = { makePool, migrate };
