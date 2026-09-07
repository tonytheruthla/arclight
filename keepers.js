#!/usr/bin/env node
/**
 * keepers.js — one Railway service, both keepers.
 *   draw-keeper  : commit / seal / draw for Lucky Trencher  (needs DRAW, OPERATOR_KEY, OPERATOR_SEED)
 *   limit-keeper : fills ArcliteLimit orders               (needs LIMIT, PUMP, KEEPER_KEY)
 * Either half is skipped if its variables are absent, so this can go live in stages.
 */
'use strict';
require('dotenv').config();
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
