// Real Postgres connection, used by worker.js and api.js in production.
// test.js uses pg-mem instead and never imports this file, so tests run
// with zero external dependencies.
const { Pool } = require('pg');

function makePool() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL not set. See DEPLOY.md step 3.');
  }
  return new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
  });
}

/** Apply schema.sql. Every statement in it is CREATE ... IF NOT EXISTS, so this
 *  is safe to run on every boot — it's how new tables (launch_trades,
 *  share_points, ...) reach the live database without a manual psql step.
 *  Columns added to existing tables still need an explicit ALTER; see the
 *  MIGRATIONS list below, each guarded so re-running is a no-op. */
async function migrate(pool) {
  const fs = require('fs');
  const sql = fs.readFileSync(__dirname + '/schema.sql', 'utf8');
  await pool.query(sql);
  const MIGRATIONS = [
    'ALTER TABLE tokens ADD COLUMN IF NOT EXISTS meta_ok BOOLEAN NOT NULL DEFAULT false',
  ];
  for (const m of MIGRATIONS) await pool.query(m);
  console.log('[db] schema up to date');
}

module.exports = { makePool, migrate };
