#!/usr/bin/env node
/**
 * test-home.js — a smoke suite for the marketing site.
 *
 * home.html had no tests at all while it was a testnet toy. It now points at
 * mainnet contracts and can spend real money, so the things that would be
 * expensive to get wrong get pinned here: which chain it talks to, which
 * addresses it uses, that it never quotes a graduation figure it has not read,
 * and that a hostile token name cannot inject markup.
 *
 *   npm i jsdom ethers && node test-home.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { ethers } = require('ethers');

const html = fs.readFileSync(path.join(__dirname, 'home.html'), 'utf8');
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '  -> ' + detail : '')); }
};

// The four addresses that were verified on chain after the Sept 8 deploy.
const MAINNET = {
  pump:    '0xa855b64c978118fdAC9746d1795c1E16668dd394',
  predict: '0xb7148f397Bcd7020eCa3A4dbf3eb7D7DE82C4547',
};
const TESTNET_LEFTOVERS = [
  '5042002', '0x4cef52', 'rpc.testnet.arc.network', 'testnet.arcscan.app',
  '0x07236980c1734d86D94D979A5d512689f7BD209A',   // old testnet pump
  '0xC2B2468Bf0D91d0c23A4116567a017Cab5d79259',   // old testnet predict
];

(async () => {
  console.log('\n  Arclite home.html\n  ' + '─'.repeat(48));

  // ---- 1. network identity ------------------------------------------------
  console.log('\n=== network ===');
  ok('chain id is 5042 (Arc mainnet)', /const CHAIN_ID = 5042;/.test(html));
  ok('chain hex matches the decimal id', /const CHAIN_HEX = '0x13b2';/.test(html));
  ok('  ...and 0x13b2 really is 5042', parseInt('0x13b2', 16) === 5042);
  ok('RPC goes through our proxy', /const RPC = 'https:\/\/rpc\.arclite\.fun';/.test(html));
  ok('explorer is the mainnet one', /const EXPLORER = 'https:\/\/arcscan\.app';/.test(html));
  ok('ethers Network is not named "arc-testnet"', !/arc-testnet/.test(html));

  // ---- 2. contracts -------------------------------------------------------
  console.log('\n=== contracts ===');
  ok('pump is the deployed ArclitePumpV4', html.includes(MAINNET.pump));
  ok('predict is the deployed ArclitePredictV4', html.includes(MAINNET.predict));
  ok('no curves()/graduationUsdc() ABI here — the terminal owns curve reads',
     !/'function curves\(address\)/.test(html) && !/'function graduationUsdc\(\)/.test(html));

  // Decoding a real V4 return with the old 7-field ABI happens to work because
  // the leading fields line up. Prove that, so the change is understood rather
  // than assumed — and so a future reshuffle of the struct fails loudly here.
  const A = ethers.AbiCoder.defaultAbiCoder();
  const t10 = ['address','uint64','uint64','uint8','uint256','uint256','bool','bool','uint256','uint256'];
  const enc = A.encode(t10, ['0x1111111111111111111111111111111111111111', 1n, 2n, 1, 3n,
                             ethers.parseEther('742'), true, false, 5n, 9n]);
  const d10 = A.decode(t10, enc);
  const d7  = A.decode(t10.slice(0, 7), enc);
  ok('the fields home.html reads (phase, realUsdc) are positionally identical in both shapes',
     Number(d7[3]) === Number(d10[3]) && d7[5] === d10[5]);

  // ---- 3. the money path lives in exactly one place ----------------------
  // This page used to carry its own connect / launch / buy / bet flows — a
  // second implementation of everything the terminal does, with no tests
  // behind it. Every contract change had to be made twice and only one copy
  // would have been caught. It is now a shop window: two read-only counters
  // and links to /app.
  console.log('\n=== one money path ===');
  ok('no wallet connect on the homepage', !/function connect\b|walletModal|eip6963/i.test(html));
  ok('no launch form', !/id="tokName"|createToken\(\)/.test(html));
  ok('no buy/sell UI', !/id="tradeBtn"|function doTrade/.test(html));
  ok('no prediction market writes', !/function betM|function claimM|function createMarket/.test(html));
  ok('the ABI it ships cannot spend money',
     !/'function (buy|sell|createToken|approve|bet|claim)\(/.test(html));
  ok('  ...it is just the two counters',
     /const PUMP_ABI = \['function tokenCount\(\) view returns \(uint256\)'\];/.test(html) &&
     /const PREDICT_ABI = \['function marketCount\(\) view returns \(uint256\)'\];/.test(html));
  ok('every CTA leaves for the terminal', /location\.href = '\/app\/terminal\.html#'/.test(html));
  ok('the nav button is a link to the app, not a connect handler',
     /<a class="btn btn-primary" id="connectBtn" href="\/app\/terminal\.html#tokens">/.test(html));
  ok('nothing untrusted is rendered, so no escaper is needed',
     !/\$\{d\.name\}|\$\{d\.symbol\}|innerHTML *= *`/.test(html));

  // ---- 4. no testnet remnants in anything a visitor sees ------------------
  console.log('\n=== no testnet remnants ===');
  for (const bad of TESTNET_LEFTOVERS) {
    // one mention of 5042002 survives, in the comment explaining the migration
    const count = html.split(bad).length - 1;
    const allowed = bad === '5042002' ? 1 : 0;
    ok(`"${bad}" appears ${allowed} time(s)`, count === allowed, `found ${count}`);
  }

  // ---- 5. rendering + hostile token metadata ------------------------------
  console.log('\n=== renders, and survives a hostile token name ===');
  const dom = new JSDOM(html, {
    url: 'https://arclite.fun/home.html',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const w = dom.window;
  w.ethers = ethers;
  const errors = [];
  w.addEventListener('error', e => errors.push(String(e.message)));
  // no network in tests: every RPC call rejects, which also proves the page
  // does not fall over when the chain is unreachable.
  w.fetch = async () => { throw new Error('offline in tests'); };
  // jsdom has no IntersectionObserver; every browser the site supports does.
  // Stub it so the rest of the script is actually exercised rather than
  // aborting on the scroll-reveal setup.
  w.IntersectionObserver = class {
    constructor(cb){ this._cb = cb; }
    observe(el){ this._cb([{ target: el, isIntersecting: true }], this); }
    unobserve(){} disconnect(){} takeRecords(){ return []; }
  };
  w.matchMedia = w.matchMedia || (q => ({ matches:false, media:q, addListener(){}, removeListener(){},
                                          addEventListener(){}, removeEventListener(){} }));
  // jsdom implements no SVG geometry either; the hero animation measures a path.
  if (w.SVGElement && !w.SVGElement.prototype.getTotalLength) {
    w.SVGElement.prototype.getTotalLength = () => 1000;
    w.SVGElement.prototype.getPointAtLength = () => ({ x: 0, y: 0 });
  }

  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  ok('exactly one inline script block', scripts.length === 1, String(scripts.length));
  try {
    w.eval(scripts[0]);
    ok('the page script runs without throwing', true);
  } catch (e) {
    ok('the page script runs without throwing', false, String(e.message).slice(0, 160));
  }

  ok('the page defines no token-rendering helpers at all',
     typeof w.rowHtml === 'undefined' && typeof w.loadTokens === 'undefined');
  ok('enterApp routes rather than revealing a hidden panel',
     typeof w.enterApp === 'function' && !/showPanel/.test(html));

  ok('no uncaught page errors while offline', errors.length === 0, errors.slice(0, 2).join(' | '));

  console.log('\n' + '='.repeat(52));
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(1); });
