#!/usr/bin/env node
/**
 * keepers.js — one Railway service, both keepers.
 *   draw-keeper  : commit / seal / draw for Lucky Trencher  (needs DRAW, OPERATOR_KEY, OPERATOR_SEED)
 *   limit-keeper : fills ArcliteLimit orders               (needs LIMIT, PUMP, KEEPER_KEY)
 * Either half is skipped if its variables are absent, so this can go live in stages.
 */
'use strict';
// dotenv is a local convenience only: it reads a .env file that exists on a
// developer's machine and nowhere else. Railway injects variables into the
// process directly, so a hard require here would crash-loop the service for a
// package it does not need. Optional on purpose.
try { require('dotenv').config(); } catch { /* no .env, no dotenv — fine */ }
const { spawn } = require('child_process');
const env = process.env;

/* Name the variables that are actually missing, not the ones we require.
   The old message printed a fixed "(DRAW/OPERATOR_KEY/OPERATOR_SEED unset)"
   whenever ANY of the three was absent, which reads like all three are gone.
   On 2026-09-09 that cost a debugging round trip: DRAW was set correctly and
   only the two secrets were blank, but the log gave no way to tell.

   A variable set to an empty string counts as missing. Railway lets you save a
   name with no value, and that is exactly how this failed — the three key
   fields existed but held "". Treat blank as absent so the message is true. */
const missing = names => names.filter(n => !String(env[n] || '').trim());
const describe = names => {
  const gone = missing(names);
  return gone.length === names.length
    ? `none of ${names.join(', ')} are set`
    : `${gone.join(', ')} ${gone.length === 1 ? 'is' : 'are'} empty or unset`;
};

const parts = [];
const drawVars  = ['DRAW', 'OPERATOR_KEY', 'OPERATOR_SEED'];
const limitVars = ['LIMIT', 'PUMP', 'KEEPER_KEY'];

if (!missing(drawVars).length) parts.push('draw-keeper.js');
else console.log('[keepers] draw keeper OFF — ' + describe(drawVars));

if (!missing(limitVars).length) parts.push('limit-keeper.js');
else console.log('[keepers] limit keeper OFF — ' + describe(limitVars));

if (!parts.length) {
  console.log('[keepers] nothing to run — idling. Set the variables above and redeploy.');
  setInterval(() => {}, 60_000);
}
for (const p of parts) {
  const child = spawn(process.execPath, [__dirname + '/' + p], { stdio: 'inherit', env });
  child.on('exit', code => { console.error(`[keepers] ${p} exited ${code} — restarting in 5s`); setTimeout(() => process.exit(1), 5000); });
}
