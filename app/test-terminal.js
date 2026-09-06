// DOM tests for terminal.html — runs the real page script in jsdom with real
// ethers, a fake indexer API (fetch) and a fake RPC (so the script's provider
// never touches the network). Proves: the five views route + paint correctly,
// the logo switches surfaces, hero/ticker/feed fill from the API, the Launch
// form exists and gates on the pump, Points renders rules + leaderboard, share
// button signs the exact message the API verifies, and no referral/bounty UI
// remains. Run: node test-terminal.js  (needs jsdom + ethers resolvable)
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { ethers } = require('ethers');

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  PASS ' + m)) : (fail++, console.log('  FAIL ' + m)); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const html = fs.readFileSync(path.join(__dirname, 'terminal.html'), 'utf8')
  // ethers comes from the CDN in the browser; here we inject it as a global instead
  .replace(/<script src="https:\/\/cdnjs[^"]*ethers[^"]*"><\/script>/, '');

const API = 'https://empathetic-magic-production-dd77.up.railway.app';
const TOK = '0x1111111111111111111111111111111111111111';
const TOK2 = '0x2222222222222222222222222222222222222222';
const fakeTokens = { tokens: [
  { address: TOK, name: 'Alpha', symbol: 'ALPHA', decimals: 18, dex: 'v3', pool_ref: '0x3333333333333333333333333333333333333333', first_seen_block: 100, first_seen_at: new Date(Date.now()-86400e3).toISOString(), meta_ok: true, price: '0.5', volume_24h: '1200', txns_24h: '9', traders_24h: '4', holders: '20', change_24h: '12.5' },
  { address: TOK2, name: '', symbol: '', decimals: 18, dex: 'v4', pool_ref: '0x'+'ab'.repeat(32), first_seen_block: 200, first_seen_at: new Date().toISOString(), meta_ok: false, price: null, volume_24h: '0', txns_24h: '0', traders_24h: '0', holders: '2', change_24h: null },
]};
const fakeStats = { tokens: 7552, volume24h: 1310000, txns24h: 11300, traders24h: 1586, launched: 0, launchVolume24h: 0, launchTxns24h: 0, launchpad: null };
const fakeFeed = { swaps: [ { token_address: TOK, symbol: 'ALPHA', meta_ok: true, side: 'buy', usdc_amount: '42.5', block_time: new Date().toISOString() },
                            { token_address: TOK2, symbol: '', meta_ok: false, side: 'sell', usdc_amount: '3', block_time: new Date().toISOString() } ] };
const fakeBoard = { rules: { season: 'pre', shareDailyCap: 10 }, traders: 2, leaderboard: [
  { wallet: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', volume: 120.5, trades: 3, shares: 2, points: 122 },
  { wallet: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', volume: 0, trades: 0, shares: 1, points: 1 } ] };
const posted = [];

function boot(url) {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  w.ethers = ethers;
  w.localStorage.clear();
  w.fetch = async (u, opts) => {
    const s = String(u);
    const json = d => ({ ok: true, status: 200, json: async () => d, text: async () => JSON.stringify(d) });
    if (s.includes('/api/v1/tokens')) return json(fakeTokens);
    if (s.includes('/api/v1/stats')) return json(fakeStats);
    if (s.includes('/api/v1/swaps/recent')) return json(fakeFeed);
    if (s.includes('/api/v1/points/leaderboard')) return json(fakeBoard);
    if (s.includes('/api/v1/points/share')) { posted.push(JSON.parse(opts.body)); return json({ ok: true, awarded: true, sharesToday: 1, cap: 10 }); }
    if (s.match(/\/api\/v1\/points\/0x/)) return json({ wallet: '0x', volume: 0, trades: 0, shares: 0, points: 0, rank: null, sharesToday: 0, shareDailyCap: 10 });
    // Anything else is an RPC call through ethers' FetchRequest — answer chainId, fail the rest quietly.
    return { ok: false, status: 503, json: async () => ({}), text: async () => '' };
  };
  w.open = () => ({});
  w.alert = () => {}; w.confirm = () => true;
  const script = html.match(/<script>([\s\S]*)<\/script>\s*<\/body>/)[1];
  w.eval(script);
  return { dom, w, d: w.document };
}

(async () => {
  console.log('\n=== shell: nav, logo switch, hero, ticker ===');
  const m = boot('https://arclite.fun/app/terminal.html?net=mainnet');
  await sleep(400);
  const d = m.d, w = m.w;
  const logo = d.querySelector('a.logo');
  ok(logo && logo.getAttribute('href') === '/home.html', 'logo is a link to the website (/home.html)');
  ok(!!d.querySelector('.logo .sitechip'), 'logo carries the "site ↗" hint chip');
  const navs = [...d.querySelectorAll('.navi')].map(a => a.dataset.view);
  ok(JSON.stringify(navs) === JSON.stringify(['tokens','launchpad','launch','points','portfolio']), 'top nav has the five views in RadarDEX order');
  ok(d.querySelector('.navi.on') && d.querySelector('.navi.on').dataset.view === 'tokens', 'mainnet defaults to the Tokens view');
  ok(d.getElementById('hs1').textContent === '7,552' && d.getElementById('hs2').textContent === '$1.31M', 'hero stats filled from /stats (tokens, 24h volume)');
  ok(d.getElementById('hs3').textContent === '11.3K' && d.getElementById('hs4').textContent === '1.6K', 'hero txns/traders formatted like RadarDEX (K)');
  ok(d.querySelectorAll('#rows tr').length === 2, 'token table renders both indexed tokens');
  const tis=[...d.querySelectorAll('#tickTrack .ti')];
  ok(tis.length >= 2 && tis.length % 2 === 0 && tis.every(x=>x.textContent.includes('ALPHA')), 'trending ticker is two identical halves (seamless loop) and skips the unnamed token');
  ok(d.querySelector('#tickTrack .ti b').textContent === 'ALPHA' && d.querySelector('#tickTrack .ti .up').textContent === '+12.50%', 'ticker shows symbol + 24h change');
  ok(d.querySelector('#rail .top3') && d.querySelector('#rail .top3 .sy').textContent === '$ALPHA', 'right rail default: top-3 card, ranked by volume');
  ok(d.querySelectorAll('#rail .feed .fr').length === 2, 'right rail default: live feed rows from /swaps/recent');
  ok(d.querySelector('#rail .feed .fr .sd').textContent === 'BUY' && d.querySelector('#rail .feed .fr .am').textContent === '$42.50', 'feed row shows side + USDC amount');
  ok(d.getElementById('tape').textContent.includes('BUY') && d.getElementById('tape').textContent.includes('ALPHA'), 'bottom tape shows mainnet swaps instead of "coming"');
  ok(d.getElementById('toolbar').style.visibility !== 'hidden' && d.querySelector('.tab[data-f="trending"]').style.display !== 'none', 'Tokens view shows explorer filter tabs');
  ok(d.querySelector('.presets').style.display === 'none', 'Buy/Bet presets hidden on the explorer');

  console.log('\n=== routing: hash → view, panel/table/rail visibility ===');
  w.location.hash = '#points';
  await sleep(300);
  ok(w.__term.VIEW === 'points' && d.querySelector('.navi.on').dataset.view === 'points', 'hashchange routes to Points');
  ok(!d.getElementById('panel').hidden && d.querySelector('.tablewrap').style.display === 'none' && d.getElementById('rail').style.display === 'none', 'Points: panel shown, table + rail hidden');
  ok(d.getElementById('toolbar').style.visibility === 'hidden', 'Points: filter toolbar hidden');
  ok(d.querySelector('#panel h1').textContent.replace(/\s+/g,' ').includes('Arclite Points'), 'Points header rendered');
  const ptxt = d.getElementById('panel').textContent;
  ok(ptxt.includes('1 point per $1 traded') && ptxt.includes('1 point per share'), 'Points rules: per-$1 volume + per-share');
  ok(!/referr|bounty/i.test(ptxt), 'Points view has no referral or bounty copy');
  ok(ptxt.includes('Pre-season'), 'pre-season pill shown when API says season=pre');
  ok(d.querySelectorAll('#panel table.lb tbody tr').length === 2, 'leaderboard renders the API rows');
  const r1 = d.querySelector('#panel table.lb tbody tr');
  ok(r1.textContent.includes('0xaaaa') && r1.textContent.includes('122'), 'leaderboard row: wallet + points');
  ok(ptxt.includes('Connect your wallet to see your rank'), 'disconnected: connect prompt for rank');
  ok(d.getElementById('hs1k').textContent === 'Tokens' && d.getElementById('heroTag').textContent.includes('earn as you trade'), 'hero tagline switches for Points');

  w.location.hash = '#launch';
  await sleep(250);
  ok(w.__term.VIEW === 'launch', 'routes to Launch');
  const ltxt = d.getElementById('panel').textContent;
  ok(ltxt.includes('Launch a token on'), 'Launch header rendered');
  ok(ltxt.includes('goes live') || ltxt.includes('open the day the Arclite contracts deploy'), 'mainnet without pump: honest gate, no form');
  ok(!d.getElementById('lpName'), 'no form fields when there is no pump on this network');
  ok(!!d.querySelector('#panel button.primary') && /testnet/i.test(d.querySelector('#panel button.primary').textContent), 'gate offers the testnet switch');
  ok(d.getElementById('hs1k').textContent === 'Launched' && d.getElementById('hs4k').textContent === 'Grad target', 'hero stats relabel for the launchpad');

  w.location.hash = '#launchpad';
  await sleep(250);
  ok(w.__term.VIEW === 'launchpad' && d.querySelector('.tablewrap').style.display !== 'none', 'routes to Launchpad, table visible');
  ok(d.getElementById('rows').textContent.includes('goes live on mainnet at deploy'), 'Launchpad on mainnet: gate copy in the table');
  ok(d.querySelector('.tab[data-f="climbing"]').style.display !== 'none' && d.querySelector('.tab[data-f="trending"]').style.display === 'none', 'Launchpad shows curve tabs, hides explorer tabs');
  ok(!!d.querySelector('.toolbar a.launch-only[href="#launch"]'), 'Launchpad toolbar has the "Launch a token" button');

  w.location.hash = '#portfolio';
  await sleep(250);
  ok(w.__term.VIEW === 'portfolio' && d.getElementById('rows').textContent.includes('Connect a wallet'), 'Portfolio view renders its connect prompt in the table area');
  ok(!/referr/i.test(d.getElementById('rows').textContent), 'Portfolio has no referral section');

  w.location.hash = '#tokens';
  await sleep(250);
  ok(w.__term.VIEW === 'tokens' && d.querySelectorAll('#rows tr').length === 2, 'back to Tokens: table repopulated');

  console.log('\n=== share: X intent + wallet-signed claim ===');
  const alphaRow = [...d.querySelectorAll('#rows tr[data-i]')].find(tr => tr.textContent.includes('ALPHA'));
  alphaRow.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(50);
  const shareBtn = d.querySelector('#rail [data-share]');
  ok(!!shareBtn && shareBtn.textContent.includes('+1 pt'), 'token rail has a "Share on X · +1 pt" button');
  // pretend a wallet is connected
  const wallet = ethers.Wallet.createRandom();
  w.__term.setWallet(wallet, wallet.address);
  let opened = null; w.open = u => { opened = u; return {}; };
  shareBtn.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(300);
  ok(opened && opened.startsWith('https://twitter.com/intent/tweet?text=') && decodeURIComponent(opened).includes('$ALPHA'), 'opens the X composer with the token');
  ok(posted.length === 1 && posted[0].wallet === wallet.address && posted[0].token.toLowerCase() === TOK, 'POSTs a share claim for this wallet + token');
  const expectMsg = `Arclite share\nwallet: ${wallet.address.toLowerCase()}\ntoken: ${TOK}\nday: ${new Date().toISOString().slice(0,10)}`;
  ok(ethers.verifyMessage(expectMsg, posted[0].signature).toLowerCase() === wallet.address.toLowerCase(), 'signature verifies against the exact message the API expects');
  ok(posted[0].day === new Date().toISOString().slice(0,10), 'claim carries today\'s UTC day');

  console.log('\n=== testnet: launchpad default + Launch form ===');
  const t = boot('https://arclite.fun/app/terminal.html?net=testnet');
  await sleep(300);
  ok(t.w.__term.VIEW === 'launchpad', 'testnet defaults to the Launchpad view');
  t.w.location.hash = '#launch';
  await sleep(250);
  const td = t.d;
  ok(!!td.getElementById('lpName') && !!td.getElementById('lpSym') && !!td.getElementById('lpGo'), 'Launch form: name, ticker, launch button');
  const sumtxt = td.querySelector('#panel .summ').textContent;
  ok(sumtxt.includes('1,000,000,000') && sumtxt.includes('80%') && sumtxt.includes('1%'), 'summary lists fixed params: supply, 80% creator share, 1% fee');
  ok(td.getElementById('lpGo').textContent.includes('Connect wallet'), 'launch button asks to connect when no wallet');
  t.w.location.hash = '#tokens';
  await sleep(250);
  ok(td.getElementById('rows').textContent.includes('reads Arc mainnet'), 'Tokens view on testnet: gate to mainnet');

  console.log('\n=== no leftovers ===');
  ok(!/bounty/i.test(html), 'terminal.html contains no "bounty"');
  ok(!/REFERRALS\s*=|bindReferrer|copyRefLink/.test(html), 'terminal.html contains no referral code');
  ok(!/YOUR_PROJECT_ID|infura\.io\/v3\/[0-9a-f]{32}/.test(html), 'no RPC project ID in the page');

  console.log('\n' + '='.repeat(52));
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(1); });
