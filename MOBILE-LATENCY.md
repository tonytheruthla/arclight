# Mobile scanner latency — measured, diagnosed, fixed

Measured on a 375x812 viewport against the live site, 16 Sept.

## The page was never the problem

```
TTFB (html)            20ms
html download          76ms      98 KB over the wire, 321 KB decoded
DOM interactive       388ms
load event            504ms
```

Half a second to interactive on mobile. The 328 KB terminal gzips to 98 KB and
is not what anyone is waiting for.

## This is

```
GET /api/v1/tokens     8,093ms
```

And on a second run, isolated:

```
/stats                  2,250ms
/tokens?limit=20        9,995ms     10 KB
/tokens?limit=100      12,157ms     51 KB
```

**limit=20 and limit=100 cost almost the same.** The cost is fixed, not
proportional to what is returned — so paging never helps and never would have.

### Why

`listTokens` builds four CTEs that scan whole tables *before* the LIMIT applies.
The worst is:

```sql
latest_id AS (
  SELECT token_address, MAX(id) AS max_id FROM swaps GROUP BY token_address
)
```

No time bound. A full scan of `swaps`, every request. `old_id` then scans most
of it again for the 24h comparison.

On 16 Sept that table is carrying **1,001,065 transactions in 24 hours** across
**33,163 tokens**. It grows every block. This was never going to improve on its
own — it gets worse in proportion to the product working.

The indexer catch-up was adding contention on top, but it is not the cause: the
query is a full scan regardless.

## The fix

`indexer/cache.js` — a read-through cache with three properties, each
load-bearing:

- **Fresh** (15s): served from memory, no database.
- **Stale-while-revalidate** (1h): past 15s it returns the *old* value
  instantly and refreshes behind the response. A scanner showing numbers 20
  seconds old is correct; one showing a spinner for ten seconds is broken.
- **Single-flight**: concurrent misses for the same key share ONE query.
  Without this, fifty phones opening the site at once each start their own
  ten-second scan and take the database down. This is the property that
  actually protects us, and it is tested with 50 simultaneous callers.

Applied to `/tokens`, `/stats` and `/swaps/recent`, plus `Cache-Control` so
browsers and any CDN help too.

**A warmer** refreshes the default views every 12s in the background, so the
first visitor after a quiet spell is not the one who pays. Without it the cache
only helps the second person through the door.

`CACHE_TTL_MS=0` disables the whole thing; the test suite sets it, because the
suite writes to the DB and reads straight back.

## Result

| | before | after |
|---|---|---|
| first visitor, warm cache | 8,093ms | served from memory |
| 50 concurrent cold visitors | 50 queries | 1 query, 49 coalesced |
| failed refresh | error to the user | last good value, silently |

**199 indexer tests pass, 0 fail**, including 10 new ones covering staleness,
coalescing, and that a failing background refresh never rejects into a response.

## What this does not fix

The underlying query is still a full table scan; the cache just means almost
nobody waits on it. The real fix is to stop computing latest price from a scan —
denormalise `last_price` and `last_swap_id` onto `tokens`, written by
`insertSwap`. That removes `latest_id` and `old_id` entirely.

Worth doing before `swaps` gets much larger. It is a schema change plus a
backfill, so it is a deliberate piece of work rather than something to bolt on
today.
