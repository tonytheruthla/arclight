#!/usr/bin/env node
/**
 * fake-node.js — a tiny JSON-RPC node over @ethereumjs/vm, so the real deploy
 * scripts (deploy-v4 / deploy-limit / deploy-draw / accept-ownership / genesis)
 * can be rehearsed end-to-end against a chain that says it's 5042, with real
 * signed transactions, real receipts, real nonces — and a kill switch that
 * makes the "RPC" start failing after N sends, to prove the resume path.
 *
 *   node fake-node.js                  # :8545, chain 5042
 *   CHAIN_ID=5042 PORT=8545 FUND=0xabc,0xdef DIE_AFTER=1 node fake-node.js
 *
 * Not for anything but rehearsal. It mines one block per transaction.
 */
'use strict';
const http = require('http');
const { createVM, runTx } = require('@ethereumjs/vm');
const { Common, Mainnet, Hardfork } = require('@ethereumjs/common');
const { createTxFromRLP } = require('@ethereumjs/tx');
const { createBlock } = require('@ethereumjs/block');
const { createAddressFromString, Account, hexToBytes, bytesToHex, bigIntToHex } = require('@ethereumjs/util');

const CHAIN_ID = BigInt(process.env.CHAIN_ID || 5042);
const PORT = Number(process.env.PORT || 8545);
const DIE_AFTER = process.env.DIE_AFTER ? Number(process.env.DIE_AFTER) : Infinity;   // sends before the node "dies"
const FUND = (process.env.FUND || '').split(',').map(s => s.trim()).filter(Boolean);
let FLAKY = Number(process.env.FLAKY || 0);   // 0..1 — fraction of reads answered with a quota error

(async () => {
  const common = new Common({ chain: { ...Mainnet, chainId: Number(CHAIN_ID) }, hardfork: Hardfork.Paris });
  const vm = await createVM({ common });
  const fund = async (a, wei) => { const acc = (await vm.stateManager.getAccount(createAddressFromString(a))) || new Account(); acc.balance = wei; await vm.stateManager.putAccount(createAddressFromString(a), acc); };
  for (const a of FUND) await fund(a, 10n ** 21n);   // 1000 USDC each
  let number = 1000n, timestamp = BigInt(Math.floor(Date.now() / 1000));
  const txs = new Map(), receipts = new Map(), blocks = new Map();
  let sends = 0, dead = false;
  const mkBlock = () => createBlock({ header: { number, timestamp, gasLimit: 30_000_000n, baseFeePerGas: 1_000_000_000n, difficulty: 0n } }, { common });

  const getAcc = async a => (await vm.stateManager.getAccount(createAddressFromString(a))) || new Account();
  const simulate = async c => {
    await vm.stateManager.checkpoint();
    try {
      return await vm.evm.runCall({ caller: c.from ? createAddressFromString(c.from) : undefined, to: c.to ? createAddressFromString(c.to) : undefined, data: c.data ? hexToBytes(c.data) : undefined, value: c.value ? BigInt(c.value) : 0n, gasLimit: 30_000_000n, block: mkBlock() });
    } finally { await vm.stateManager.revert(); }
  };
  const handlers = {
    eth_chainId: async () => bigIntToHex(CHAIN_ID),
    net_version: async () => String(CHAIN_ID),
    eth_blockNumber: async () => bigIntToHex(number),
    eth_gasPrice: async () => '0x3b9aca00',
    eth_maxPriorityFeePerGas: async () => '0x1',
    eth_feeHistory: async () => ({ oldestBlock: bigIntToHex(number), baseFeePerGas: ['0x3b9aca00', '0x3b9aca00'], gasUsedRatio: [0], reward: [['0x1']] }),
    eth_getBalance: async ([a]) => bigIntToHex((await getAcc(a)).balance),
    eth_getTransactionCount: async ([a]) => bigIntToHex((await getAcc(a)).nonce),
    eth_getCode: async ([a]) => bytesToHex(await vm.stateManager.getCode(createAddressFromString(a))),
    eth_getBlockByNumber: async ([n, full]) => {
      const num = n === 'latest' || n === 'pending' ? number : BigInt(n);
      return { number: bigIntToHex(num), hash: '0x' + num.toString(16).padStart(64, '0'), parentHash: '0x' + (num - 1n).toString(16).padStart(64, '0'),
        timestamp: bigIntToHex(timestamp), gasLimit: '0x1c9c380', gasUsed: '0x0', baseFeePerGas: '0x3b9aca00', miner: '0x' + '0'.repeat(40),
        transactions: [...txs.values()].filter(t => t.blockNumber === bigIntToHex(num)).map(t => full ? t : t.hash), nonce: '0x0000000000000000', difficulty: '0x0', extraData: '0x', logsBloom: '0x' + '0'.repeat(512), sha3Uncles: '0x' + '0'.repeat(64), stateRoot: '0x' + '0'.repeat(64), receiptsRoot: '0x' + '0'.repeat(64), transactionsRoot: '0x' + '0'.repeat(64), size: '0x0', uncles: [] };
    },
    // Simulations must not touch state: runCall writes straight to the state
    // manager (a creation would burn the nonce), so checkpoint + revert.
    eth_call: async ([c]) => {
      const r = await simulate(c);
      if (r.execResult.exceptionError) { const e = new Error('execution reverted'); e.code = 3; e.data = bytesToHex(r.execResult.returnValue); throw e; }
      return bytesToHex(r.execResult.returnValue);
    },
    eth_estimateGas: async ([c]) => {
      const r = await simulate(c);
      if (r.execResult.exceptionError) { const e = new Error('execution reverted'); e.code = 3; e.data = bytesToHex(r.execResult.returnValue); throw e; }
      return bigIntToHex(r.execResult.executionGasUsed * 13n / 10n + 60_000n);
    },
    eth_sendRawTransaction: async ([raw]) => {
      if (++sends > DIE_AFTER) { dead = true; const e = new Error('daily request count exceeded, request rate limited'); e.code = -32005; throw e; }
      const tx = createTxFromRLP(hexToBytes(raw), { common });
      const block = mkBlock();
      const res = await runTx(vm, { tx, block, skipBlockGasLimitValidation: true });
      const hash = bytesToHex(tx.hash());
      const created = res.createdAddress ? res.createdAddress.toString() : null;
      const bn = bigIntToHex(number), bh = '0x' + number.toString(16).padStart(64, '0');
      txs.set(hash, { hash, nonce: bigIntToHex(tx.nonce), blockHash: bh, blockNumber: bn, transactionIndex: '0x0', from: tx.getSenderAddress().toString(), to: tx.to ? tx.to.toString() : null, value: bigIntToHex(tx.value), gas: bigIntToHex(tx.gasLimit), gasPrice: '0x3b9aca00', input: bytesToHex(tx.data), type: '0x2', chainId: bigIntToHex(CHAIN_ID), v: '0x0', r: '0x0', s: '0x0', maxFeePerGas: '0x3b9aca00', maxPriorityFeePerGas: '0x1', accessList: [] });
      receipts.set(hash, { transactionHash: hash, transactionIndex: '0x0', blockHash: bh, blockNumber: bn, from: tx.getSenderAddress().toString(), to: tx.to ? tx.to.toString() : null, contractAddress: created,
        cumulativeGasUsed: bigIntToHex(res.totalGasSpent), gasUsed: bigIntToHex(res.totalGasSpent), effectiveGasPrice: '0x3b9aca00', status: res.execResult.exceptionError ? '0x0' : '0x1', type: '0x2', logsBloom: '0x' + '0'.repeat(512),
        logs: (res.execResult.logs || []).map((l, i) => ({ address: bytesToHex(l[0]), topics: l[1].map(bytesToHex), data: bytesToHex(l[2]), blockNumber: bn, blockHash: bh, transactionHash: hash, transactionIndex: '0x0', logIndex: bigIntToHex(BigInt(i)), removed: false })) });
      number += 1n; timestamp += 1n;
      return hash;
    },
    eth_getTransactionReceipt: async ([h]) => receipts.get(h) || null,
    eth_getTransactionByHash: async ([h]) => txs.get(h) || null,
    eth_getLogs: async ([f]) => {
      const want = f.address ? [].concat(f.address).map(a => a.toLowerCase()) : null;
      return [...receipts.values()].flatMap(r => r.logs).filter(l => (!want || want.includes(l.address.toLowerCase())) && (!f.topics || !f.topics[0] || [].concat(f.topics[0]).includes(l.topics[0])));
    },
  };

  const server = http.createServer((req, res) => {
    if (req.url === '/revive') { dead = false; sends = 0; res.end('revived\n'); return; }
    // /warp?s=3600 — push block.timestamp forward. The draw contract keys every
    // round off the UTC hour, so without this a full seal→draw rehearsal would
    // mean waiting for a real hour boundary to come round.
    if (req.url && req.url.startsWith('/warp')) { timestamp += BigInt(new URL(req.url, 'http://x').searchParams.get('s') || 0); res.end('timestamp=' + timestamp + '\n'); return; }
    if (req.url && req.url.startsWith('/flaky')) { FLAKY = Number(new URL(req.url, 'http://x').searchParams.get('p') || 0); res.end('flaky=' + FLAKY + '\n'); return; }
    let body = ''; req.on('data', c => body += c); req.on('end', async () => {
      let out;
      try {
        const q = JSON.parse(body);
        const one = async r => {
          // FLAKY simulates a rate-limited provider: some reads refuse, the
          // same read succeeds moments later. Sends are never flaked — a lost
          // send is a different failure and must not be retried blindly.
          if (FLAKY && r.method !== 'eth_chainId' && r.method !== 'eth_sendRawTransaction' && Math.random() < FLAKY)
            return { jsonrpc: '2.0', id: r.id, error: { code: -32600, message: 'project ID exceeded quota' } };
          if (dead && r.method !== 'eth_chainId') return { jsonrpc: '2.0', id: r.id, error: { code: -32005, message: 'daily request count exceeded, request rate limited' } };
          const h = handlers[r.method]; if (!h) return { jsonrpc: '2.0', id: r.id, error: { code: -32601, message: 'method not found: ' + r.method } };
          try { return { jsonrpc: '2.0', id: r.id, result: await h(r.params || []) }; }
          catch (e) { return { jsonrpc: '2.0', id: r.id, error: { code: e.code || -32000, message: e.message, data: e.data } }; }
        };
        out = Array.isArray(q) ? await Promise.all(q.map(one)) : await one(q);
      } catch (e) { out = { jsonrpc: '2.0', id: null, error: { code: -32700, message: String(e.message) } }; }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(out));
    });
  });
  server.listen(PORT, () => console.log(`[fake-node] chain ${CHAIN_ID} on :${PORT}` + (DIE_AFTER < Infinity ? ` — dies after ${DIE_AFTER} send(s)` : '')));
})();
