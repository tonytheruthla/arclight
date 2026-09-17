// draw-bot message tests — exact strings, no network, no chain.
const B = require('./draw-bot');
const E18 = 10n ** 18n;
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  PASS ' + m)) : (fail++, console.log('  FAIL ' + m)); };

console.log('\n=== usd formatting ===');
ok(B.usd(1n * E18) === '$1', '1e18 -> $1');
ok(B.usd(5n * E18) === '$5', '5e18 -> $5');
ok(B.usd(250n * E18) === '$250', 'large values lose the decimals');
ok(B.usd(1500n * E18) === '$1,500', 'thousands get a separator');
ok(B.usd(E18 / 2n) === '$0.50', 'small values keep cents');

console.log('\n=== the :56 warning ===');
const empty = B.warningMessage({ roundId: 497100, pots: [0n, 0n, 0n], tickets: [0n, 0n, 0n] });
ok(empty === null, 'an empty round posts NOTHING — 24 "$0" messages a day is how a group gets muted');

const one = B.warningMessage({ roundId: 497100, pots: [3n * E18, 0n, 0n], tickets: [3n, 0n, 0n] });
ok(one.includes('Round #497100 closes in 2 minutes'), 'leads with the clock, not a promise of winning');
ok(one.includes('Degen ($1) · $3 across 3 tickets'), 'names the tier, pot and ticket count');
ok(!one.includes('Trencher') && !one.includes('Whale'), 'tiers with no tickets are left out entirely');
ok(one.includes('Sales stop at :58, the draw lands at :00'), 'states the mechanism');

const many = B.warningMessage({ roundId: 1, pots: [1n * E18, 10n * E18, 50n * E18], tickets: [1n, 2n, 1n] });
ok(many.includes('Total pot $61'), 'totals across live tiers only');
ok(many.includes('1 ticket') && many.includes('2 tickets'), 'singular/plural both correct');

console.log('\n=== Drawn ===');
const d = B.drawnMessage({ roundId: 497101, tier: 1, winner: '0xabcdef1234567890abcdef1234567890abcdef12',
  prize: 48n * E18, tickets: 10n, hitJackpot: false, txHash: '0x' + 'ab'.repeat(32) });
ok(d.includes('Round #497101 · Trencher ($5)'), 'round and tier in the headline');
ok(d.includes('0xabcd…ef12 takes $48 from 10 tickets'), 'winner, prize and ticket count, said flatly');
ok(d.includes('arcscan.app/tx/0xabab'), 'carries a verifiable tx link — a RECEIPT without one is just a claim');
ok(d.includes('No crying in the trenches.'), 'the signature line');
ok(!d.includes('jackpot'), 'no jackpot line when it did not hit');
  ok(d.split('\n')[1] === '', 'blank line after the headline survives (filter(Boolean) used to eat it)');

const j = B.drawnMessage({ roundId: 1, tier: 2, winner: '0x' + '11'.repeat(20), prize: 900n * E18,
  tickets: 1n, hitJackpot: true, txHash: '0x' + 'cd'.repeat(32) });
ok(j.includes('The jackpot hit.'), 'jackpot line appears when it hit');
ok(j.includes('One in twenty winning tickets takes it.'), 'and explains the odds rather than hyping them');
ok(j.includes('from 1 ticket'), 'singular ticket');
ok(j.split('\n').filter(l => l === '').length === 3, 'jackpot version keeps all three blank lines');
ok(j.split('\n')[1] === '' && j.split('\n')[3] === '', 'blanks sit after the headline and before the jackpot line');

console.log('\n=== forced settlement ===');
const f = B.forcedMessage({ roundId: 497102, txHash: '0x' + 'ef'.repeat(32) });
ok(f.includes('settled without us'), 'owns it plainly');
ok(f.includes('the money cannot get stuck'), 'explains why that is the system working');
ok(f.includes('we forfeit the fee'), 'states the cost to us — the true thing said flatly');
ok(f.includes('arcscan.app/tx/0xefef'), 'verifiable');

console.log('\n=== voice and compliance guards ===');
const all = [one, many, d, j, f].join('\n');
/* Word-boundary matching, not substring: "twenty" contains "wen", and a naive
   includes() check fails on the jackpot line. The first version of this test
   did exactly that. */
const banned = ['gambling', 'casino', 'bet your', 'financial advice', 'guaranteed', 'wen', 'insane', 'massive', 'unreal', 'to the moon'];
for (const w of banned) {
  const re = new RegExp('\\b' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
  ok(!re.test(all), `never says "${w}"`);
}
ok(!/[\u{1F300}-\u{1FAFF}\u{2700}-\u{27BF}]/u.test(all), 'no emoji anywhere');
ok(!/\b(will|going to) (pump|moon|rise)\b/i.test(all), 'no price prediction');

console.log('\n=== HTML safety ===');
const x = B.drawnMessage({ roundId: 1, tier: 0, winner: '0x<script>alert(1)</script>ab',
  prize: E18, tickets: 1n, hitJackpot: false, txHash: '0x' + '00'.repeat(32) });
ok(!x.includes('<script>'), 'a hostile address cannot inject HTML into the message');
ok(x.includes('&lt;') || !x.includes('<scr'), 'it is escaped');

console.log(`\n====================================================\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
