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

module.exports = { makePool };
