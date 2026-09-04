-- Arclite explorer indexer schema.
-- Raw event tables + a running balance ledger. Aggregation (24h volume,
-- holders, trending) is computed on read from these — see queries.js —
-- not pre-materialized, to keep this simple until there's enough volume
-- to justify materialized views / cron rollups.

CREATE TABLE IF NOT EXISTS tokens (
  address           TEXT PRIMARY KEY,
  name              TEXT NOT NULL DEFAULT '',
  symbol            TEXT NOT NULL DEFAULT '',
  decimals          SMALLINT NOT NULL DEFAULT 18,
  dex               TEXT NOT NULL CHECK (dex IN ('v3','v4')),
  pool_ref          TEXT NOT NULL,      -- v3: pool contract address. v4: poolId (bytes32).
  fee               INTEGER,            -- v3 fee tier in hundredths of a bip; null for v4 (read from Initialize per-pool if needed later)
  usdc_is_token0    BOOLEAN NOT NULL,
  first_seen_block  BIGINT NOT NULL,
  first_seen_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS swaps (
  id            BIGSERIAL PRIMARY KEY,
  token_address TEXT NOT NULL REFERENCES tokens(address),
  block_number  BIGINT NOT NULL,
  block_time    TIMESTAMPTZ NOT NULL,
  tx_hash       TEXT NOT NULL,
  log_index     INTEGER NOT NULL,
  trader        TEXT NOT NULL,
  side          TEXT NOT NULL CHECK (side IN ('buy','sell')),
  usdc_amount   NUMERIC NOT NULL,   -- always positive, human-readable (already decimal-adjusted)
  token_amount  NUMERIC NOT NULL,
  price         NUMERIC NOT NULL,   -- USDC per token at this swap
  UNIQUE (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS idx_swaps_token_time ON swaps (token_address, block_time DESC);
CREATE INDEX IF NOT EXISTS idx_swaps_time        ON swaps (block_time DESC);

-- Running balance ledger, updated from Transfer events. This is what makes
-- a holder count possible without re-summing all history on every request —
-- and it's the expensive-to-maintain part flagged in the build plan.
CREATE TABLE IF NOT EXISTS balances (
  token_address TEXT NOT NULL REFERENCES tokens(address),
  holder        TEXT NOT NULL,
  balance       NUMERIC NOT NULL DEFAULT 0,
  PRIMARY KEY (token_address, holder)
);
CREATE INDEX IF NOT EXISTS idx_balances_positive ON balances (token_address) WHERE balance > 0;

-- Periodic price snapshots, so "24h % change" and trending have something
-- to compare against instead of guessing from the nearest swap.
CREATE TABLE IF NOT EXISTS price_snapshots (
  token_address TEXT NOT NULL REFERENCES tokens(address),
  snapshot_at   TIMESTAMPTZ NOT NULL,
  price         NUMERIC NOT NULL,
  PRIMARY KEY (token_address, snapshot_at)
);
CREATE INDEX IF NOT EXISTS idx_snapshots_token_time ON price_snapshots (token_address, snapshot_at DESC);

-- One row per chain, tracking how far the indexer has caught up. Restarting
-- the worker resumes from here instead of re-scanning from genesis.
CREATE TABLE IF NOT EXISTS indexer_state (
  chain_id    INTEGER PRIMARY KEY,
  last_block  BIGINT NOT NULL
);
