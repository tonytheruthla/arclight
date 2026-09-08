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
const parts = [];
if (env.DRAW && env.OPERATOR_KEY && env.OPERATOR_SEED) parts.push('draw-keeper.js'); else console.log('[keepers] draw keeper off (DRAW/OPERATOR_KEY/OPERATOR_SEED unset)');
if (env.LIMIT && env.PUMP && env.KEEPER_KEY) parts.push('limit-keeper.js'); else console.log('[keepers] limit keeper off (LIMIT/PUMP/KEEPER_KEY unset)');
if (!parts.length) { console.log('[keepers] nothing to run — idling'); setInterval(() => {}, 60_000); }
for (const p of parts) {
  const child = spawn(process.execPath, [__dirname + '/' + p], { stdio: 'inherit', env });
  child.on('exit', code => { console.error(`[keepers] ${p} exited ${code} — restarting in 5s`); setTimeout(() => process.exit(1), 5000); });
}
