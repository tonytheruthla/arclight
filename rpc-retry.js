#!/usr/bin/env node
/**
 * rpc-retry.js — one provider factory for every deploy/keeper script.
 *
 * Why this exists: a rate-limited RPC does not fail cleanly. It answers some
 * calls and refuses others, so a deploy can die on a read it made a hundred
 * times already — the "project ID exceeded quota" that stopped the Sept 8
 * ownership handoff twice, between two runs where the same read succeeded.
 * Retrying by hand is a coin flip; retrying in the transport is deterministic.
 *
 * Behaviour:
 *   - retries quota / rate-limit / 429 / 5xx / network errors with exponential
 *     backoff and jitter (default 12 attempts capped at 6s each, ~45s total —
 *     patient enough to outlast a burst, short enough to fail visibly);
 *   - never retries a real answer, including a contract revert — those are
 *     the chain's verdict, not the provider's mood;
 *   - never retries eth_sendRawTransaction on an ambiguous failure. A resend
 *     could double-spend a nonce; the caller's own resume path handles it.
 *   - logs each retry so a slow run is visibly waiting, not hung.
 *
 *   const { makeProvider } = require('./rpc-retry');
 *   const provider = makeProvider(RPC, CHAIN_ID);
 */
'use strict';
const { ethers } = require('ethers');

const RETRYABLE = /quota|rate.?limit|too many requests|429|capacity|timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|502|503|504|SERVER_ERROR|missing response/i;
const RETRYABLE_CODES = new Set([-32005, -32603, -32600, 429]);

const isRetryable = e => {
  if (!e) return false;
  if (RETRYABLE_CODES.has(e.code)) return true;
  return RETRYABLE.test(String(e.message || e.shortMessage || e));
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

class RetryProvider extends ethers.JsonRpcProvider {
  constructor(url, network, options, retry = {}) {
    super(url, network, options);
    this._retry = { attempts: Number(process.env.RPC_ATTEMPTS || retry.attempts || 12), baseMs: retry.baseMs || 500, maxMs: Number(process.env.RPC_MAX_WAIT_MS || retry.maxMs || 6_000), quiet: !!retry.quiet };
  }

  async _send(payload) {
    const { attempts, baseMs, maxMs, quiet } = this._retry;
    // A transaction send is not idempotent: if the response is lost we cannot
    // know whether it landed, and a blind resend risks a duplicate. Send once.
    const method = Array.isArray(payload) ? (payload[0] || {}).method : payload.method;
    const once = method === 'eth_sendRawTransaction';

    let lastErr = null;
    for (let i = 0; i < (once ? 1 : attempts); i++) {
      try {
        const res = await super._send(payload);
        // A JSON-RPC-level error still arrives as a 200 with an error member.
        const errs = (Array.isArray(res) ? res : [res]).map(r => r && r.error).filter(Boolean);
        const retryable = errs.find(isRetryable);
        if (retryable && i < attempts - 1) { lastErr = retryable; }
        else return res;
      } catch (e) {
        if (!isRetryable(e) || i === attempts - 1) throw e;
        lastErr = e;
      }
      const wait = Math.min(maxMs, Math.round(baseMs * 2 ** i * (0.75 + Math.random() * 0.5)));
      if (!quiet) console.log(`  … ${method || 'rpc'} — ${String((lastErr && (lastErr.message || lastErr.shortMessage)) || lastErr).slice(0, 60)}; retry ${i + 1}/${attempts} in ${(wait / 1000).toFixed(1)}s`);
      await sleep(wait);
    }
    throw lastErr || new Error('rpc: retries exhausted');
  }
}

/** The provider every script should use. staticNetwork + batchMaxCount:1
 *  because Infura rejects batched JSON-RPC; cacheTimeout:-1 because ethers'
 *  250 ms result cache can hand a stale nonce to the next transaction. */
function makeProvider(url, chainId, opts = {}) {
  const net = new ethers.Network('arc', BigInt(chainId));
  return new RetryProvider(url, net, { staticNetwork: net, batchMaxCount: 1, cacheTimeout: -1 }, opts);
}

module.exports = { makeProvider, RetryProvider, isRetryable };
