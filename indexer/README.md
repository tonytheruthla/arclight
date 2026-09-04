# Arclite explorer indexer

Chain indexer + read API behind the Arc token explorer in `app/terminal.html`.
Follows Uniswap V3 `PoolCreated` and V4 `Initialize`/`Swap` events on Arc
(chain 5042) into Postgres, and serves aggregated 24h volume, txns, traders,
holders and price change over a small JSON API.

Deployed as two Railway services from this folder: `npm run worker` (follows the
chain) and `npm run api` (serves reads). See DEPLOY.md for the full setup.

Never put a real RPC URL in this folder - provider URLs embed API keys and this
repo is public. Those belong in Railway's Variables tab only.
