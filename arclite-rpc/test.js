#!/usr/bin/env node
/**
 * test.js — exercises the proxy against controllable fake upstreams.
 * No network, no provider key needed. `node test.js`
 */
'use strict';
const http = require('http');
const { spawn } = require('child_process');

const REVERTER = '0x000000000000000000000000000000000000dEaD';
// ABI-encoded Error(string) 'SafeMath: multiplication overflow' — the exact
// payload the live endpoint returned through trace_call.
const REVERT_DATA = '0x08c379a0' + '0'.repeat(62) + '20' + '0'.repeat(62) + '21' +
  Buffer.from('SafeMath: multiplication overflow').toString('hex').padEnd(64, '0');
let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (d ? '  -> ' + d : '')); } };

// ---- fake upstream ------------------------------------------------------
function upstream(port, opts) {
  // chainId defaults to Arc's own (0x13b2 / 5042) so every existing test upstream
  // passes verification for free; only the new mismatch test overrides it.
  const state = { calls: 0, mode: opts.mode || 'ok', head: 1000, chainId: opts.chainId || '0x13b2', burst: 0 };
  const s = http.createServer((req, res) => {
    let b = ''; req.on('data', c => b += c);
    req.on('end', () => {
      state.calls++;
      const p = JSON.parse(b);
      const one = (r) => {
        // 'nocall' models the real Arc upstream as measured on 2026-09-09: every
        // method works EXCEPT eth_call, which is refused every single time.
        if (state.mode === 'nocall') {
          if (r.method === 'eth_call')
            return { jsonrpc: '2.0', id: r.id, error: { code: -32005, message: 'project ID exceeded quota' } };
          if (r.method === 'trace_call') {
            const to = (r.params[0] && r.params[0].to) || '';
            if (to === REVERTER)
              return { jsonrpc: '2.0', id: r.id, result: { output: REVERT_DATA, stateDiff: null, trace: [{ type: 'call', error: 'Reverted' }] } };
            return { jsonrpc: '2.0', id: r.id, result: { output: '0x' + port.toString(16), stateDiff: null, trace: [{ type: 'call' }] } };
          }
        }
        if (state.mode === 'quota')
          return { jsonrpc: '2.0', id: r.id, error: { code: -32005, message: 'project ID exceeded quota' } };
        // 'burst' models the real endpoint: refuses a few calls, then answers.
        if (state.mode === 'burst' && state.burst > 0) { state.burst--;
          return { jsonrpc: '2.0', id: r.id, error: { code: -32005, message: 'project ID exceeded quota' } }; }
        if (r.method === 'eth_chainId')     return { jsonrpc: '2.0', id: r.id, result: state.chainId };
        if (r.method === 'eth_blockNumber') return { jsonrpc: '2.0', id: r.id, result: '0x' + (state.head).toString(16) };
        if (r.method === 'eth_getCode')     return { jsonrpc: '2.0', id: r.id, result: '0xdeadbeef' };
        if (r.method === 'eth_call' && state.mode === 'hex429') return { jsonrpc: '2.0', id: r.id, result: '0x0000000000000000000000000000000000000000000000000000000000004290' };
        if (r.method === 'eth_call')        return { jsonrpc: '2.0', id: r.id, result: '0x' + port.toString(16) };
        if (r.method === 'eth_getTransactionCount') return { jsonrpc: '2.0', id: r.id, result: '0x' + state.calls.toString(16) };
        if (r.method === 'eth_getBlockByNumber') return { jsonrpc: '2.0', id: r.id, result: { number: r.params[0], hash: '0xabc', timestamp: '0x1', transactions: [] } };
        return { jsonrpc: '2.0', id: r.id, result: '0x1' };
      };
      if (state.mode === 'dead') { req.socket.destroy(); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(Array.isArray(p) ? p.map(one) : one(p)));
    });
  });
  s.listen(port);
  return { state, close: () => s.close() };
}

function rpc(port, method, params, id) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(Array.isArray(method) ? method : { jsonrpc: '2.0', id: id || 1, method, params: params || [] });
    const r = http.request({ hostname: '127.0.0.1', port, path: '/', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } },
      res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(d) }); } catch { resolve({ status: res.statusCode, json: null }); } }); });
    r.on('error', reject); r.write(body); r.end();
  });
}
function get(port, path) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port, path }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(d) }); } catch { resolve({ status: res.statusCode, json: null }); } });
    }).on('error', reject);
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log('\n  Arclite RPC proxy\n  ' + '─'.repeat(46));

  const A = upstream(19001, { mode: 'ok' });
  const B = upstream(19002, { mode: 'ok' });

  const proxy = spawn(process.execPath, [__dirname + '/server.js'], {
    env: Object.assign({}, process.env, { ETH_CALL_SHIM: '', 
      PORT: '19000', CHAIN_ID: '5042',
      UPSTREAMS: 'http://127.0.0.1:19001,http://127.0.0.1:19002',
      RATE_PER_MIN: '30',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await sleep(900);

  // 1. chain identity answered locally, zero upstream cost
  const before = A.state.calls + B.state.calls;
  const cid = await rpc(19000, 'eth_chainId');
  ok('eth_chainId served locally as 0x13b2', cid.json.result === '0x13b2', cid.json.result);
  ok('  ...without touching an upstream', A.state.calls + B.state.calls === before);

  // 2. caching of an immutable method
  const c1 = await rpc(19000, 'eth_getCode', ['0xabc', 'latest']);
  const midCalls = A.state.calls + B.state.calls;
  const c2 = await rpc(19000, 'eth_getCode', ['0xabc', 'latest']);
  const afterCalls = A.state.calls + B.state.calls;
  ok('eth_getCode returns correct result', c1.json.result === '0xdeadbeef');
  ok('eth_getCode second call served from cache', afterCalls === midCalls, `${midCalls} -> ${afterCalls}`);

  // 3. nonce must NEVER be cached (caching it breaks transaction sending)
  const n1 = await rpc(19000, 'eth_getTransactionCount', ['0xabc', 'pending']);
  const n2 = await rpc(19000, 'eth_getTransactionCount', ['0xabc', 'pending']);
  ok('eth_getTransactionCount is never cached', n1.json.result !== n2.json.result,
     `${n1.json.result} vs ${n2.json.result}`);

  // 3b. regression: a hex RESULT that happens to contain "429" is a normal answer,
  //     not a rate limit. The old whole-response regex tripped on this and took
  //     the upstream out for 60 s — the "stuck unhealthy" proxy seen on Sept 8.
  A.state.mode = 'hex429';
  const h1 = await rpc(19000, 'eth_call', [{ to: '0x429' }, 'latest']);
  ok('hex result containing "429" is served, not treated as quota', h1.json.result === '0x0000000000000000000000000000000000000000000000000000000000004290', JSON.stringify(h1.json).slice(0, 90));
  const hh = await new Promise((resolve) => http.get('http://127.0.0.1:19000/health', res => { let d=''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(d) })); }));
  ok('  ...and upstream A is still counted healthy afterwards', hh.json.upstreams && hh.json.upstreams.healthy === 2, JSON.stringify(hh.json.upstreams));
  A.state.mode = 'ok';

  // 4. THE important one: upstream quota exhaustion fails over instead of erroring
  A.state.mode = 'quota';
  const q = await rpc(19000, 'eth_call', [{ to: '0x1' }, 'latest']);
  ok('quota-exhausted upstream fails over silently', q.json.result !== undefined && !q.json.error,
     JSON.stringify(q.json).slice(0, 90));
  ok('  ...and the answer came from the healthy upstream B', q.json.result === '0x' + (19002).toString(16),
     q.json.result);


  // 4b. a BURSTY upstream — refuses a few calls then answers. This is the real
  //     failure that put "Could not read the draw contract: server response 502"
  //     on screen: one refusal became a 502 instead of a retry.
  A.state.mode = 'ok'; B.state.mode = 'ok';
  await sleep(1700);                                   // let the short cooloff lapse
  A.state.mode = 'burst'; A.state.burst = 3; B.state.mode = 'burst'; B.state.burst = 3;
  const t0 = Date.now();
  const burst = await rpc(19000, 'eth_call', [{ to: '0xdraw' }, 'latest']);
  ok('a bursty refusal is retried, not surfaced as a 502',
     burst.status === 200 && burst.json.result !== undefined, 'status ' + burst.status + ' ' + JSON.stringify(burst.json).slice(0, 80));
  ok('...and recovers in a couple of seconds, not a minute', Date.now() - t0 < 8000, (Date.now() - t0) + 'ms');
  A.state.mode = 'ok'; B.state.mode = 'ok'; A.state.burst = 0; B.state.burst = 0;

  // 4c. a write is NEVER retried — a duplicate broadcast could spend a nonce twice
  A.state.mode = 'burst'; A.state.burst = 99; B.state.mode = 'burst'; B.state.burst = 99;
  const wr = await rpc(19000, 'eth_sendRawTransaction', ['0xdeadbeef']);
  ok('eth_sendRawTransaction is not retried — a duplicate broadcast could spend a nonce twice',
     wr.status === 502 || !!(wr.json && wr.json.error), 'status ' + wr.status);
  A.state.mode = 'ok'; B.state.mode = 'ok'; A.state.burst = 0; B.state.burst = 0;
  await sleep(1700);

  // 5. total outage returns a clean 502, not a hang
  A.state.mode = 'quota'; B.state.mode = 'quota';
  const dead = await rpc(19000, 'eth_call', [{ to: '0x2' }, 'latest']);
  ok('all upstreams down -> clean JSON-RPC error', dead.status === 502 && !!dead.json.error,
     dead.status + ' ' + JSON.stringify(dead.json).slice(0, 70));

  // 6. recovery
  A.state.mode = 'ok'; B.state.mode = 'ok';
  await sleep(200);
  // cooldown is 60s for quota, so force a distinct key and accept either upstream
  await sleep(100);

  // 7. batch
  const batch = await rpc(19000, [
    { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] },
    { jsonrpc: '2.0', id: 2, method: 'eth_chainId', params: [] },
  ]);
  ok('batch requests supported', Array.isArray(batch.json) && batch.json.length === 2);

  // 8. oversized batch rejected
  const big = await rpc(19000, Array.from({ length: 60 }, (_, i) => ({ jsonrpc: '2.0', id: i, method: 'eth_chainId', params: [] })));
  ok('oversized batch rejected (>50)', big.status === 413, String(big.status));

  // 9. malformed JSON
  const bad = await new Promise(res => {
    const malformed = '{ nope';
    const r = http.request({ hostname: '127.0.0.1', port: 19000, path: '/', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(malformed) } },
      s => { let d = ''; s.on('data', c => d += c); s.on('end', () => res({ status: s.statusCode, d })); });
    r.write(malformed); r.end();
  });
  ok('malformed JSON -> -32700 parse error', bad.status === 400 && bad.d.includes('-32700'));

  // 10. rate limiting
  let limited = false;
  for (let i = 0; i < 45; i++) {
    const r = await rpc(19000, 'eth_chainId');
    if (r.status === 429) { limited = true; break; }
  }
  ok('per-IP rate limit engages', limited);

  // 11. operational endpoints
  const h = await get(19000, '/health');
  ok('/health reports chain + upstreams', h.json && h.json.chainId === 5042 && h.json.upstreams.total === 2);
  const st = await get(19000, '/stats');
  ok('/stats exposes cache hit rate', st.json && typeof st.json.cacheHitRate === 'string', st.json && st.json.cacheHitRate);
  const pv = await get(19000, '/privacy');
  ok('/privacy asserts no logging + no persistence',
     pv.json && pv.json.logsIpAddresses === false && pv.json.logsWalletAddresses === false && pv.json.persistence === 'none — there is no database');

  // 12. CORS
  const cors = await new Promise(res => {
    const r = http.request({ hostname: '127.0.0.1', port: 19000, path: '/', method: 'OPTIONS' },
      s => res(s.headers['access-control-allow-origin']));
    r.end();
  });
  ok('CORS allows browser dapps', cors === '*', cors);

  proxy.kill(); A.close(); B.close();

  // 13. chain-ID verification: an upstream claiming the wrong chain gets excluded
  //     from rotation, and a correct one keeps serving traffic. This is the guard
  //     against pointing "Arc mainnet" at something that isn't actually Arc.
  const C = upstream(19003, { mode: 'ok', chainId: '0x1' });   // claims Ethereum mainnet
  const D = upstream(19004, { mode: 'ok' });                    // correctly claims Arc (5042)
  const proxy2 = spawn(process.execPath, [__dirname + '/server.js'], {
    env: Object.assign({}, process.env, { ETH_CALL_SHIM: '', 
      PORT: '19005', CHAIN_ID: '5042',
      UPSTREAMS: 'http://127.0.0.1:19003,http://127.0.0.1:19004',
      RATE_PER_MIN: '30',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await sleep(1200); // let the startup verifyAllUpstreams() sweep finish for both

  const h2 = await get(19005, '/health');
  ok('mismatched upstream flagged in /health', h2.json && h2.json.upstreams.chainMismatched === 1,
     JSON.stringify(h2.json));

  const st2 = await get(19005, '/stats');
  const list2 = (st2.json && st2.json.upstreams) || [];
  const mismatchedEntry = list2.find(u => u.chainVerified === false);
  const okEntry = list2.find(u => u.chainVerified === true);
  ok('wrong-chain upstream marked chainVerified:false and unhealthy',
     !!mismatchedEntry && mismatchedEntry.healthy === false, JSON.stringify(mismatchedEntry));
  ok('correct-chain upstream marked chainVerified:true and healthy',
     !!okEntry && okEntry.healthy === true, JSON.stringify(okEntry));
  ok('/stats masks upstream identity (no raw url/path field that could leak an API key)',
     list2.every(u => u.url === undefined && typeof u.upstream === 'string'), JSON.stringify(list2));

  // live traffic should route only to the verified upstream D, never to C
  const call2 = await rpc(19005, 'eth_call', [{ to: '0x1' }, 'latest']);
  ok('mismatched upstream excluded from live routing', call2.json.result === '0x' + (19004).toString(16),
     call2.json.result);

  proxy2.kill(); C.close(); D.close();

  // ---- transport failures, single upstream -------------------------------
  // The live proxy showed 141 client-facing 502s out of 225 requests at six
  // requests a minute. Not quota: a dropped socket benched the ONE upstream
  // for 15 s and reported exhausted=false, so forward() returned without a
  // single retry. Every request in that window 502'd. These two tests pin the
  // behaviour that fixes it.
  console.log('\n  transport failures with a single upstream');
  const E = upstream(19006, { mode: 'ok' });
  const proxy3 = spawn(process.execPath, [__dirname + '/server.js'], {
    env: Object.assign({}, process.env, { ETH_CALL_SHIM: '', 
      PORT: '19007', CHAIN_ID: '5042',
      UPSTREAMS: 'http://127.0.0.1:19006',
      RATE_PER_MIN: '300',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await sleep(900);

  // 1. socket dies, then recovers 400 ms later. The retry schedule should ride
  //    straight over it and the caller should never see the failure.
  E.state.mode = 'dead';
  setTimeout(() => { E.state.mode = 'ok'; }, 400);
  const t1 = await rpc(19007, 'eth_call', [{ to: '0x1' }, 'latest']);
  ok('a dropped socket is retried, not surfaced as 502',
     t1.status === 200 && t1.json && t1.json.result === '0x' + (19006).toString(16),
     `status ${t1.status} ${JSON.stringify(t1.json)}`);

  // 2. drive the sole upstream into its cool-off, then ask again immediately
  //    while it is perfectly healthy. This is the exact 15-second blackout.
  E.state.mode = 'dead';
  await rpc(19007, 'eth_call', [{ to: '0x2' }, 'latest']);   // benches it
  E.state.mode = 'ok';
  const t2 = await rpc(19007, 'eth_call', [{ to: '0x3' }, 'latest']);
  ok('a benched sole upstream does not blanket-502 the next request',
     t2.status === 200 && t2.json && t2.json.result === '0x' + (19006).toString(16),
     `status ${t2.status} ${JSON.stringify(t2.json)}`);

  // 3. the split counters must actually distinguish the two failure modes,
  //    otherwise we are back to guessing which fix a live incident needs.
  const s3 = await get(19007, '/stats');
  ok('/stats separates transport failures from quota failures',
     s3.json && s3.json.transportFail > 0 && s3.json.quotaFail === 0,
     JSON.stringify({ transportFail: s3.json && s3.json.transportFail, quotaFail: s3.json && s3.json.quotaFail }));
  ok('/stats reports the last transport error text',
     !!(s3.json && s3.json.lastTransportError), s3.json && s3.json.lastTransportError);

  proxy3.kill(); E.close();

  // ---- eth_call shim ----------------------------------------------------
  // The live outage on 2026-09-09: the Arc upstream answered every method
  // except eth_call, so every read the terminal makes 502'd and nobody could
  // launch, buy or enter the draw. Retrying and extra capacity cannot fix a
  // method-level refusal; translating to trace_call can.
  console.log('\n  eth_call shim (upstream refuses eth_call)');
  const F = upstream(19008, { mode: 'nocall' });
  const proxy4 = spawn(process.execPath, [__dirname + '/server.js'], {
    env: Object.assign({}, process.env, { ETH_CALL_SHIM: '', 
      PORT: '19009', CHAIN_ID: '5042',
      UPSTREAMS: 'http://127.0.0.1:19008', RATE_PER_MIN: '300',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await sleep(900);

  const k1 = await rpc(19009, 'eth_call', [{ to: '0x1' }, 'latest']);
  ok('eth_call succeeds even though the upstream refuses eth_call',
     k1.status === 200 && k1.json && k1.json.result === '0x' + (19008).toString(16),
     `status ${k1.status} ${JSON.stringify(k1.json)}`);

  // a revert must stay a revert — not become an empty success
  const k2 = await rpc(19009, 'eth_call', [{ to: REVERTER }, 'latest'], 2);
  ok('a reverting call is reported as an error, not as empty data',
     k2.json && k2.json.error && k2.json.error.code === 3 && /reverted/i.test(k2.json.error.message),
     JSON.stringify(k2.json).slice(0, 140));
  ok('  ...and carries the revert data so ethers can decode the reason',
     k2.json && k2.json.error && k2.json.error.data === REVERT_DATA,
     String(k2.json && k2.json.error && k2.json.error.data).slice(0, 60));
  // prove the reason really decodes
  let reason = null;
  try {
    const d = k2.json.error.data;
    if (d.startsWith('0x08c379a0')) reason = Buffer.from(d.slice(138, 138 + 66), 'hex').toString('utf8').replace(/\0+$/, '');
  } catch {}
  ok('  ...decoding it yields "SafeMath: multiplication overflow"',
     reason === 'SafeMath: multiplication overflow', String(reason));

  // other methods are untouched
  const k3 = await rpc(19009, 'eth_getCode', ['0xabc', 'latest']);
  ok('non-call methods are unaffected by the shim', k3.json && k3.json.result === '0xdeadbeef');

  const k4 = await get(19009, '/stats');
  ok('/stats says the shim is active and counts its use',
     k4.json && /active/.test(k4.json.ethCallShim || '') && k4.json.callShimUsed >= 2,
     JSON.stringify({ shim: k4.json && k4.json.ethCallShim, used: k4.json && k4.json.callShimUsed }));

  // A malformed trace_call reply must NOT become an empty success. This is the
  // failure mode that matters most: "0x" decodes as zero, and a zero price or a
  // zero balance on a trading page is worse than a visible error.
  F.state.mode = 'ok';                      // now trace_call returns junk ('0x1')
  await sleep(50);
  const k5 = await rpc(19009, 'eth_call', [{ to: '0x2' }, 'latest'], 5);
  ok('a malformed trace_call reply becomes an error, never an empty 0x result',
     !!(k5.json && k5.json.error) && k5.json.result === undefined,
     JSON.stringify(k5.json));

  proxy4.kill(); F.close();

  console.log('  ' + '─'.repeat(46));
  console.log(`  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
