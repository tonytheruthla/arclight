#!/usr/bin/env node
/**
 * draw-bot.js — the Lucky Trencher heartbeat for Telegram.
 *
 * Posts three things and nothing else:
 *   1. :56  a two-minute warning, ONLY when a pot actually exists.
 *   2.      every Drawn event: tier, winner, prize, tx.
 *   3.      every forced Settled: the receipt that the chain drew without us.
 *
 * WHY THIS ONE FIRST
 * ------------------
 * It gives the group a reason to exist 24 times a day and every message is
 * checkable against the chain. A community bot that posts prices is noise; one
 * that posts receipts is the product.
 *
 * SAFETY
 * ------
 * - READ-ONLY. No signer, no private key, no write path. Compromise it and the
 *   worst case is nuisance messages, which is the right blast radius for
 *   something running unattended.
 * - Zero new packages. ethers is already a dependency; Telegram is plain HTTPS
 *   and Node has fetch.
 * - Silent when the pot is empty. 24 posts a day saying "$0" trains people to
 *   mute the group, which costs more than the posts are worth.
 * - The bot token is a secret: Railway env var, never the repo. The repo is public.
 *
 * RUN
 *   TG_TOKEN=123:ABC TG_CHAT=-1001234567890 node draw-bot.js
 *   ... DRY=1        print to stdout instead of posting, for a first look
 *   ... DRAW=0x..    override the contract (defaults to mainnet)
 */
'use strict';
const { ethers } = require('ethers');
const fs = require('fs');

const RPC       = process.env.RPC || 'https://rpc.blockdaemon.mainnet.arc.io';
const CHAIN_ID  = Number(process.env.CHAIN_ID || 5042);
const DRAW      = process.env.DRAW || '0x9f5dd4c61c84227835CA06E81077Bd6f8f3eDe52';
const TG_TOKEN  = process.env.TG_TOKEN;
const TG_CHAT   = process.env.TG_CHAT;
const DRY       = !!process.env.DRY;
const STATE     = process.env.STATE_FILE || '.draw-bot-state.json';
const EXPLORER  = 'https://arcscan.app';
const POLL_MS   = Number(process.env.POLL_MS || 20000);
/* Blocks per getLogs call. Arc does ~7,100 blocks an hour, so 2,000 is about
   17 minutes of chain — comfortably under every provider's range ceiling and
   small enough to answer fast. The first version of this file asked for
   `lastBlock+1 .. head` in ONE call; after the bot sat stopped for a day that
   was 106,000 blocks, over Blockdaemon's 100,000 cap, and every poll died with
   "request timeout". */
const LOG_SPAN  = Number(process.env.LOG_SPAN || 2000);
/* How far behind is worth catching up on at all. A draw bot announcing a
   winner from fifteen hours ago is noise, not news — and the whole point of
   "no backfill on first run" was to keep history out of the group. Same
   reasoning applies to a long outage: skip forward, say so in the log, and
   start being useful now. */
const MAX_BEHIND = Number(process.env.MAX_BEHIND || 5000);

const ABI = [
  'event Drawn(uint256 indexed roundId, uint8 indexed tier, address indexed winner, uint256 winningIndex, uint256 tickets, uint256 prize, bool hitJackpot)',
  'event Settled(uint256 indexed roundId, bytes32 seed, bool forced)',
  'function currentRound() view returns (uint256)',
  'function jackpot() view returns (uint256)',
  'function roundState(uint256) view returns (uint256[3] pots, uint256[3] tickets, uint32[3] wallets, bool open, bool isSealed, bool isSettled, bool committed, uint256 closeAt, uint256 endAt)',
];

const TIERS = ['Degen ($1)', 'Trencher ($5)', 'Whale ($50)'];
const usd = v => {
  const n = Number(ethers.formatEther(v));
  return '$' + (n >= 100 ? Math.round(n).toLocaleString() : n.toFixed(2).replace(/\.00$/, ''));
};
const short = a => a.slice(0, 6) + '…' + a.slice(-4);
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/* ---- message text. Kept as pure functions so the tests can assert the exact
       strings without a network or a chain. Voice rules: short declaratives, no
       hype verbs, never "gambling" or "casino" — describe the mechanism. */
function warningMessage({ roundId, pots, tickets }) {
  const live = [0, 1, 2].filter(i => tickets[i] > 0n);
  if (!live.length) return null;                       // silence beats "$0"
  const total = live.reduce((s, i) => s + pots[i], 0n);
  const lines = live.map(i => `${TIERS[i]} · ${usd(pots[i])} across ${tickets[i]} ticket${tickets[i] === 1n ? '' : 's'}`);
  return [
    `<b>Round #${roundId} closes in 2 minutes.</b>`,
    '',
    ...lines,
    '',
    `Total pot ${usd(total)}. Sales stop at :58, the draw lands at :00.`,
    `<a href="https://arclite.fun">arclite.fun</a>`,
  ].join('\n');
}

function drawnMessage({ roundId, tier, winner, prize, tickets, hitJackpot, txHash }) {
  /* Built conditionally rather than with filter(Boolean): the '' entries are
     deliberate blank lines, and filtering truthiness ate them along with the
     empty jackpot slot, collapsing the message into a wall. */
  const out = [
    `<b>Round #${roundId} · ${TIERS[tier]}</b>`,
    '',
    `${esc(short(winner))} takes ${usd(prize)} from ${tickets} ticket${tickets === 1n ? '' : 's'}.`,
  ];
  if (hitJackpot) out.push('', '<b>The jackpot hit.</b> One in twenty winning tickets takes it.');
  out.push('', `<a href="${EXPLORER}/tx/${txHash}">Verify on arcscan</a>`, 'No crying in the trenches.');
  return out.join('\n');
}

function forcedMessage({ roundId, txHash }) {
  return [
    `<b>Round #${roundId} settled without us.</b>`,
    '',
    'Nobody ran the reveal in time, so the chain forced the draw. That is the escape hatch working: the money cannot get stuck, and we forfeit the fee when it happens.',
    '',
    `<a href="${EXPLORER}/tx/${txHash}">Verify on arcscan</a>`,
  ].join('\n');
}

/** Decide what range to scan next, given where we stopped and where the chain is.
 *
 *  Pure on purpose: the two bugs this replaces — an unbounded range and an
 *  unbounded catch-up — are both arithmetic, and arithmetic can be tested
 *  without a chain.
 *
 *  Returns { from, to, skipped, done }.
 *    skipped > 0  we were further behind than MAX_BEHIND and jumped forward
 *    done         nothing to scan; caller should sleep
 */
function planScan(lastBlock, head, { maxBehind = MAX_BEHIND, logSpan = LOG_SPAN } = {}) {
  let skipped = 0;
  if (head - lastBlock > maxBehind) {
    skipped = head - lastBlock - maxBehind;
    lastBlock = head - maxBehind;
  }
  if (head <= lastBlock) return { from: lastBlock + 1, to: lastBlock, skipped, done: true };
  const to = Math.min(head, lastBlock + logSpan);
  return { from: lastBlock + 1, to, skipped, done: false };
}

async function send(text) {
  if (DRY || !TG_TOKEN || !TG_CHAT) { console.log('\n--- would post ---\n' + text + '\n'); return true; }
  const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) console.error('[tg] failed:', j.description || r.status);
  return !!j.ok;
}

const readState = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; } };
const writeState = s => { try { fs.writeFileSync(STATE, JSON.stringify(s, null, 2)); } catch (e) { console.error('[state]', e.message); } };

async function main() {
  /* Say something BEFORE the first await. The original version's first output
     came after provider.getBlockNumber(), so a container that could not reach
     the RPC produced zero logs and looked identical to one that never started.
     On Railway that is indistinguishable from a crash, and it cost an
     afternoon of guessing. Boot banner first, always. */
  console.log(`[boot] draw-bot starting · pid ${process.pid} · node ${process.version}`);
  console.log(`[boot] rpc ${RPC} · chain ${CHAIN_ID} · draw ${DRAW}`);
  console.log(`[boot] TG_TOKEN ${TG_TOKEN ? 'set' : 'MISSING'} · TG_CHAT ${TG_CHAT || 'MISSING'} · DRY ${DRY ? '1' : '0'}`);

  if (!DRY && (!TG_TOKEN || !TG_CHAT)) {
    console.error('\n  TG_TOKEN and TG_CHAT are required (or set DRY=1 to preview).\n');
    process.exit(1);
  }
  const provider = new ethers.JsonRpcProvider(RPC, new ethers.Network('arc', CHAIN_ID), { staticNetwork: true, batchMaxCount: 1 });
  const draw = new ethers.Contract(DRAW, ABI, provider);
  const iface = new ethers.Interface(ABI);

  /* Prove the RPC is reachable, loudly, with a bounded wait. An unreachable
     endpoint used to hang here forever in silence. */
  let head0;
  try {
    head0 = await Promise.race([
      provider.getBlockNumber(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('no response in 20s')), 20000)),
    ]);
    console.log(`[boot] rpc ok, head ${head0.toLocaleString()}`);
  } catch (e) {
    console.error(`[boot] RPC UNREACHABLE: ${e.message}. Check the endpoint and that the container has outbound network.`);
    process.exit(1);
  }

  let st = readState();
  if (!st.lastBlock) {
    st.lastBlock = head0;
    writeState(st);
    console.log(`[init] starting from block ${st.lastBlock} — no backfill, so a restart cannot spam the group`);
  }

  console.log(`[init] draw ${DRAW} · chat ${TG_CHAT || '(dry)'} · polling ${POLL_MS}ms`);

  while (true) {
    try {
      const head = await provider.getBlockNumber();

      const plan = planScan(st.lastBlock, head);
      if (plan.skipped > 0) {
        console.log(`[skip] ${plan.skipped.toLocaleString()} blocks behind the useful window — jumping forward. Old rounds are not news.`);
        st.lastBlock = plan.from - 1;
        writeState(st);
      }

      if (!plan.done) {
        const to = plan.to;
        const logs = await provider.getLogs({
          address: DRAW, fromBlock: plan.from, toBlock: to,
          topics: [[iface.getEvent('Drawn').topicHash, iface.getEvent('Settled').topicHash]],
        });
        for (const log of logs) {
          const p = iface.parseLog(log);
          if (!p) continue;
          if (p.name === 'Drawn') {
            await send(drawnMessage({
              roundId: p.args.roundId, tier: Number(p.args.tier), winner: p.args.winner,
              prize: p.args.prize, tickets: p.args.tickets, hitJackpot: p.args.hitJackpot,
              txHash: log.transactionHash,
            }));
          } else if (p.name === 'Settled' && p.args.forced) {
            await send(forcedMessage({ roundId: p.args.roundId, txHash: log.transactionHash }));
          }
        }
        st.lastBlock = to;
        writeState(st);
        if (to < head) continue;          // more to do; skip the sleep and keep going
      }

      // The :56 warning, once per round, and only if there is something to warn about.
      const now = Math.floor(Date.now() / 1000);
      const minute = Math.floor((now % 3600) / 60);
      const round = Math.floor(now / 3600);
      if (minute >= 56 && minute < 58 && st.warnedRound !== round) {
        const rs = await draw.roundState(round);
        const msg = warningMessage({ roundId: round, pots: rs.pots, tickets: rs.tickets });
        if (msg) await send(msg);
        st.warnedRound = round;
        writeState(st);
      }
    } catch (e) {
      console.error('[loop]', (e.shortMessage || e.message || e).toString().slice(0, 140));
    }
    await new Promise(r => setTimeout(r, POLL_MS));   // reached unless a chunk `continue`d
  }
}

module.exports = { warningMessage, drawnMessage, forcedMessage, usd, short, TIERS, planScan, LOG_SPAN, MAX_BEHIND };
if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
