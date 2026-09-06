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
  first_seen_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- false until name/symbol/decimals were ALL read successfully from the chain.
  -- Discovery happens from a log, but metadata needs eth_call, which fails
  -- independently (rate limits, quota, non-standard tokens). When it fails we
  -- still record the token — a token with a blank name is better than a missing
  -- one — but decimals is then only a GUESS, which makes every price derived
  -- from it wrong. So we flag it, retry it later (worker backfillMeta), and the
  -- API refuses to publish a price until this is true.
  meta_ok           BOOLEAN NOT NULL DEFAULT false
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

-- ============================================================================
-- Arclite launchpad (ArclitePump) — the venue whose volume earns points.
-- Indexed only when PUMP_ADDRESS is set on the worker; on mainnet that is the
-- day the launchpad contracts deploy. Native USDC on Arc is 18dp, so
-- usdc_amount here is already decimal-adjusted to whole dollars, same as swaps.
-- ============================================================================
CREATE TABLE IF NOT EXISTS launch_tokens (
  address        TEXT PRIMARY KEY,
  creator        TEXT NOT NULL,
  name           TEXT NOT NULL DEFAULT '',
  symbol         TEXT NOT NULL DEFAULT '',
  created_block  BIGINT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS launch_trades (
  id            BIGSERIAL PRIMARY KEY,
  token_address TEXT NOT NULL,
  block_number  BIGINT NOT NULL,
  block_time    TIMESTAMPTZ NOT NULL,
  tx_hash       TEXT NOT NULL,
  log_index     INTEGER NOT NULL,
  trader        TEXT NOT NULL,
  side          TEXT NOT NULL CHECK (side IN ('buy','sell')),
  usdc_amount   NUMERIC NOT NULL,   -- whole USDC, decimal-adjusted from 18dp native
  token_amount  NUMERIC NOT NULL,
  UNIQUE (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS idx_launch_trades_trader ON launch_trades (trader);
CREATE INDEX IF NOT EXISTS idx_launch_trades_time   ON launch_trades (block_time DESC);
CREATE INDEX IF NOT EXISTS idx_launch_trades_token  ON launch_trades (token_address, block_time DESC);

-- Social-share points. One row = one point. The primary key IS the cap:
-- a wallet can earn at most one share point per token per UTC day, and the
-- API additionally refuses more than SHARE_DAILY_CAP rows per wallet per day.
-- Every row was authorised by a wallet signature over (wallet, token, day) —
-- see api.js POST /api/v1/points/share — so nobody can be credited a share
-- they didn't sign for, and a signature can't be replayed on another day.
CREATE TABLE IF NOT EXISTS share_points (
  wallet        TEXT NOT NULL,
  token_address TEXT NOT NULL,
  day           TEXT NOT NULL,      -- 'YYYY-MM-DD' in UTC
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (wallet, token_address, day)
);
CREATE INDEX IF NOT EXISTS idx_share_points_wallet ON share_points (wallet, day);
