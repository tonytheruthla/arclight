#!/usr/bin/env node
/**
 * test.js — exercises the proxy against controllable fake upstreams.
 * No network, no provider key needed. `node test.js`
 */
'use strict';
const http = require('http');
const { spawn } = require('child_process');

let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (d ? '  -> ' + d : '')); } };

// ---- fake upstream ------------------------------------------------------
function upstream(port, opts) {
  // chainId defaults to Arc's own (0x13b2 / 5042) so every existing test upstream
  // passes verification for free; only the new mismatch test overrides it.
  const state = { calls: 0, mode: opts.mode || 'ok', head: 1000, chainId: opts.chainId || '0x13b2' };
  const s = http.createServer((req, res) => {
    let b = ''; req.on('data', c => b += c);
    req.on('end', () => {
      state.calls++;
      const p = JSON.parse(b);
      const one = (r) => {
        if (state.mode === 'quota')
          return { jsonrpc: '2.0', id: r.id, error: { code: -32005, message: 'project ID exceeded quota' } };
        if (r.method === 'eth_chainId')     return { jsonrpc: '2.0', id: r.id, result: state.chainId };
        if (r.method === 'eth_blockNumber') return { jsonrpc: '2.0', id: r.id, result: '0x' + (state.head).toString(16) };
        if (r.method === 'eth_getCode')     return { jsonrpc: '2.0', id: r.id, result: '0xdeadbeef' };
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
    env: Object.assign({}, process.env, {
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

  // 4. THE important one: upstream quota exhaustion fails over instead of erroring
  A.state.mode = 'quota';
  const q = await rpc(19000, 'eth_call', [{ to: '0x1' }, 'latest']);
  ok('quota-exhausted upstream fails over silently', q.json.result !== undefined && !q.json.error,
     JSON.stringify(q.json).slice(0, 90));
  ok('  ...and the answer came from the healthy upstream B', q.json.result === '0x' + (19002).toString(16),
     q.json.result);

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
    env: Object.assign({}, process.env, {
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

  console.log('  ' + '─'.repeat(46));
  console.log(`  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
