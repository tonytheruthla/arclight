'use strict';
/**
 * A read-through cache with stale-while-revalidate and single-flight.
 *
 * WHY THIS EXISTS
 * ---------------
 * /api/v1/tokens costs ~10s regardless of `limit`, because listTokens builds
 * CTEs that scan the whole swaps table (latest_id does MAX(id) GROUP BY token
 * with no time bound) before the LIMIT applies. On 16 Sept that table passed a
 * million rows in 24h. Measured: limit=20 -> 9,995ms, limit=100 -> 12,157ms.
 * Cost is fixed, so paging does not help and never will.
 *
 * Three properties, each load-bearing:
 *
 *   FRESH        inside ttlMs, return the value. No database at all.
 *   STALE        past ttlMs but inside staleMs, return the OLD value instantly
 *                and refresh in the background. Only the very first request
 *                after a cold start ever waits. A scanner showing numbers 20
 *                seconds old is right; a scanner showing a spinner for 10
 *                seconds is broken.
 *   SINGLE-FLIGHT  concurrent misses for the same key share ONE query. Without
 *                this, fifty phones opening the site at once would each start
 *                their own 10-second scan and take the database down. This is
 *                the property that actually protects us.
 */
function createCache({ ttlMs = 15000, staleMs = 120000, now = () => Date.now() } = {}) {
  const store = new Map();
  const inflight = new Map();
  let hits = 0, misses = 0, staleServed = 0, coalesced = 0;

  async function run(key, fn) {
    if (inflight.has(key)) { coalesced++; return inflight.get(key); }
    const p = (async () => {
      const value = await fn();
      store.set(key, { value, at: now() });
      return value;
    })().finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  return {
    async get(key, fn) {
      const hit = store.get(key);
      const age = hit ? now() - hit.at : Infinity;
      if (hit && age < ttlMs) { hits++; return hit.value; }
      if (hit && age < staleMs) {
        staleServed++;
        run(key, fn).catch(() => {});       // refresh behind the response
        return hit.value;                    // ...but answer now
      }
      misses++;
      return run(key, fn);                   // cold: nothing to serve but the truth
    },
    stats: () => ({ hits, misses, staleServed, coalesced, keys: store.size }),
    clear: () => { store.clear(); inflight.clear(); },
  };
}
module.exports = { createCache };
