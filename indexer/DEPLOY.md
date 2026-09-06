# Deploying the Arclite explorer indexer — step by step

Everything in this folder is written and tested (115/115, `npm test` — schema, decode logic, and aggregation SQL all verified against synthetic data; see the note at the top of `test.js` for exactly what that does and doesn't prove). This guide is the part I can't do for you: creating accounts, holding secrets, and clicking deploy. None of it needs the deployer key or any wallet — this is read-only infrastructure, it never signs anything.

## Step 0 — settle the RPC first

Don't skip this. Every RPC issue this project has hit (the rate-limited public endpoint, `rpc.arclite.fun` not resolving, the arc-scan.org scare) matters more here than anywhere else — a flaky RPC feeding the indexer means the whole database quietly falls behind for every visitor, not just one retried page load.

Current choice: an Infura Arc mainnet endpoint, verified to return `0x13b2` (5042). **The actual URL is deliberately not written down in this repo** — it embeds an API key and this repo is public. Keep it in your password manager; it goes into Railway's Variables tab in step 3 and nowhere else.

Worth knowing before you rely on it: as of the last check, Circle's own docs (docs.arc.io) still list Arc mainnet as "Upcoming" and name Alchemy/Blockdaemon/dRPC/QuickNode as official node partners, not Infura. That's a real open question, not fully resolved — re-verify any endpoint before trusting it:

```bash
curl -s -X POST -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' \
  "<your RPC URL>"
# MUST return {"jsonrpc":"2.0","id":1,"result":"0x13b2"}   ← 5042
```

(The indexer is read-only and never signs anything, so a bad RPC here means stale/wrong data, not a fund-safety issue — still worth getting right.)

## Step 1 — create a Railway account

Go to [railway.app](https://railway.app) and sign up (GitHub login is the fastest path since your code already lives on GitHub). This is an account you create yourself — I can't do this step.

Cost: roughly **$5–15/month** total for both services plus Postgres on the Hobby plan, based on typical usage for something this size.

## Step 2 — new project, add Postgres

1. **New Project** → **Deploy PostgreSQL** (or **Empty Project**, then **+ New → Database → PostgreSQL** — Railway's exact button wording shifts between UI versions, but "add a Postgres database to this project" is the action).
2. Once it's provisioned, open the Postgres service → **Variables** tab → copy the `DATABASE_URL` value (you likely won't need to paste this anywhere manually — see step 4's variable reference).
3. Load the schema. Easiest path: open the Postgres service's **Data** tab (Railway has a built-in query console) and paste the contents of `indexer/schema.sql`. Or, from your own machine with `psql` installed:
   ```bash
   psql "<DATABASE_URL from the Variables tab>" -f indexer/schema.sql
   ```

## Step 3 — deploy the worker service

This is `worker.js` — the process that never stops, following the chain and writing to Postgres.

1. In the same Railway project: **+ New → GitHub Repo** → select `tonytheruthla/arclight`.
2. Once it's created, open the service → **Settings**:
   - **Root Directory**: `indexer`
   - **Start Command**: `npm run worker` (or `node worker.js`)
3. **Variables** tab, add:
   - `RPC_URL` = your Infura Arc mainnet URL (the endpoint verified in step 0 — paste it here, into Railway, not into any file in the repo)
   - `START_BLOCK` = `0` to start (or a later block once you know each contract's actual deployment block, to skip scanning empty history)
   - `DATABASE_URL` — click **+ New Variable → Add Reference** and point it at the Postgres service's `DATABASE_URL` rather than pasting the value by hand. Keeps it in sync if Railway ever rotates it.
4. Deploy. Watch the **Logs** tab — you should see `[init] no prior state — starting from block 0` followed by `[chunk] 1-9500 · +0 tokens · 0 swaps` repeating as it works forward. This confirms it's alive and talking to both the RPC and the database, regardless of how much real activity is on-chain yet.
5. **This service needs no public domain.** It doesn't listen on a port or serve traffic — leave networking off for it.

## Step 4 — deploy the API service

This is `api.js` — the public read-only endpoint the terminal calls.

1. **+ New → GitHub Repo** → same repo again, as a second service in the same project.
2. **Settings**:
   - **Root Directory**: `indexer`
   - **Start Command**: `npm run api`
3. **Variables**: add `DATABASE_URL` the same way (reference the Postgres service). `PORT` is set automatically by Railway — don't override it.
4. **Settings → Networking → Generate Domain** to get a public URL (something like `arclite-indexer-production.up.railway.app`). Attach your own subdomain later if you want (e.g. `api.arclite.fun`) via the same Networking tab.
5. Verify it's actually serving data:
   ```bash
   curl https://<your-generated-domain>/api/v1/tokens
   ```
   Should return JSON with a `tokens` array (empty is fine if the worker hasn't found anything yet — an empty array is a working API, not a broken one).

## Step 5 — point the terminal at it

In `app/terminal.html`, find `indexerApi:''` inside the `mainnet` network config (near the top of the script, next to `v4PoolManager`) and set it to your API's URL:

```js
indexerApi:'https://<your-generated-domain>',
```

That's the only code change needed. The terminal already tries this first and falls back to the client-side scanner automatically if it's empty, unreachable, or errors — so this is safe to flip on before the indexer has caught up on history; visitors just won't notice a difference until it has real data.

## Step 6 — push it live

Same pattern as every other change this session: copy the updated `arclight/` folder (now including the new `indexer/` subfolder) to your machine, commit, push to `tonytheruthla/arclight`, confirm GitHub Pages picks it up.

`indexer/` itself doesn't need to be part of the GitHub Pages build — it's not static site content, it's a separate service that Railway deploys straight from the repo. Having it in the same repo is just convenient for keeping worker/API code next to the terminal that calls it.

## Step 7 — watch the first backfill

Depending on `START_BLOCK`, the first catch-up to the chain head could take a while — each `[chunk]` log line covers ~9,500 blocks, and Arc's RPC is rate-limited, so the retry/backoff logic will slow things down under load rather than fail outright. That's expected. Once logs show it's caught up (`lastBlock` stops jumping by full chunks and starts polling instead), the API has real, live data.

## Launchpad + points (added Sept 6)

The same worker indexes the **Arclite launchpad** the moment it exists on the chain it's watching.
One extra Railway variable, on **both** the worker and the API service:

- `PUMP_ADDRESS` = the ArclitePump address from `deployment-v3.json` after the mainnet deploy.
  Until it's set, `/api/v1/points/leaderboard` reports `season: "pre"` and volume points can't
  accrue (there's nothing to trade on). Share points work from day one.
- `SHARE_DAILY_CAP` (optional, default 10) — max share points per wallet per UTC day.

Points rules live in one place, `queries.js` `POINTS_CTE`: **1 point per 1 USDC traded on the
launchpad** (buys and sells, floored per wallet) **+ 1 point per share** (one per token per UTC
day). Nothing else counts — referrals and the old bounty are gone.

Share points are the only thing a browser can *write*: `POST /api/v1/points/share` with
`{wallet, token, day, signature}` where `signature` is the wallet's `personal_sign` of the exact
text in `api.js` `shareMessage()`. The API verifies it with ethers, so a claim can't be forged for
someone else's wallet and can't be replayed on another day.

**Schema is applied automatically** on boot (`db.js migrate()` — all `CREATE IF NOT EXISTS`), so
the three new tables (`launch_tokens`, `launch_trades`, `share_points`) appear on the next deploy
with no psql step.

New endpoints: `/api/v1/stats` (hero strip), `/api/v1/swaps/recent` (live feed),
`/api/v1/points/leaderboard`, `/api/v1/points/:wallet`, `POST /api/v1/points/share`.

## RPC quota — the thing that will actually bite you

Observed live on 2026-09-05: with the free Infura tier, `eth_call` started returning

```json
{"error":{"code":-32600,"message":"project ID exceeded quota"}}
```

while `eth_getLogs` and `eth_blockNumber` kept working. That asymmetry is nasty, because
the indexer *looks* healthy — chunks keep advancing, swaps keep landing — but every token's
`name`, `symbol` and `decimals` read fails, since those need `eth_call`.

Two consequences the code now handles rather than hides:

- A token discovered during a quota outage is stored with `meta_ok = false`. The API returns
  `price: null` for it instead of a price computed from guessed 18 decimals (which can be
  wrong by 10^12 — that's where the nonsense `1613319207434.85` came from).
- The worker retries those tokens (`backfillMeta`) whenever it's caught up, so they repair
  themselves once quota frees up. No manual intervention, no re-scan.

**The free tier is enough — the worker is now sized for it.** Infura credit costs (from their
published table): `eth_getLogs` 255, `eth_call` / `getBlock` / `blockNumber` 80 each. What the
worker costs per chunk:

| | before | now |
|---|---|---|
| `eth_getLogs` per chunk | 5 (≈1,275 credits) | 2 (≈510) — one merged discovery+swaps call, one transfers call |
| polling interval | 20s | 30s (`POLL_INTERVAL_MS`) |
| steady state / day | **≈6M** (2× the free tier) | **≈1.7M** |
| remaining backfill (≈663 chunks) | — | ≈1.2M, one-off |

So day one of a fresh backfill lands around 2.5–2.9M — tight against the 3M line — and every
day after is ~1.7M with room to spare for the metadata repair. Two levers if you need them, both
Railway variables, no redeploy of code:

- `PAUSED=1` — idles the worker (no RPC calls at all). Use it to hand the whole quota to
  something else for an hour, e.g. the contract deploy. Unset to resume where it left off.
- `CHUNK_DELAY_MS=2000` — paces the backfill (≈1,800 credits every 2s instead of as fast as
  the RPC allows) so it spreads over two days rather than risking the daily cap.

If you'd still rather not think about it: the Developer plan ($50/mo, 15M/day) removes the
question entirely. But it isn't required.

## What to check when something looks wrong

- **Worker logs show repeated `[error]` lines** → almost always the RPC. Re-run the step 0 curl check against `RPC_URL` exactly as set in Railway's Variables tab (a copy-paste typo here is the single most common failure).
- **API returns `{"tokens":[]}` forever** → check the worker's logs for `[discover v3]` / `[discover v4]` lines. If none ever appear, either `START_BLOCK` is set past where any real pools were created, or the RPC being used doesn't actually have the history you expect — verify against a block explorer.
- **Terminal still shows "· Uniswap V3" instead of "· indexer" in the sync line** → the `indexerApi` fetch failed or timed out (6-second cutoff) and it silently fell back, exactly as designed. Open the browser console — the network tab will show the actual failure (CORS, 404, timeout) rather than guessing.
