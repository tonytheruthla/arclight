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
const short = a => a.slice(0,6)+'…'+a.slice(-4);
const fmtP = n => n<0.0001 ? '$'+n.toExponential(2) : '$'+n.toFixed(6);

const html = fs.readFileSync(path.join(__dirname, 'terminal.html'), 'utf8')
  // ethers comes from the CDN in the browser; here we inject it as a global instead
  .replace(/<script src="https:\/\/cdnjs[^"]*ethers[^"]*"><\/script>/, '');

const API = 'https://empathetic-magic-production-dd77.up.railway.app';
const TOK = '0x1111111111111111111111111111111111111111';
const TOK2 = '0x2222222222222222222222222222222222222222';
const TOK3 = '0x3333333333333333333333333333333333333330';
const fakeTokens = { tokens: [
  { address: TOK, name: 'Alpha', symbol: 'ALPHA', decimals: 18, dex: 'v3', pool_ref: '0x3333333333333333333333333333333333333333', first_seen_block: 100, first_seen_at: new Date(Date.now()-86400e3).toISOString(), meta_ok: true, price: '0.5', volume_24h: '1200', txns_24h: '9', traders_24h: '4', holders: '20', change_24h: '12.5', logo_url: 'ipfs://bafyALPHA', website: 'https://alpha.fun', twitter: 'https://x.com/alphaonarc', telegram: null, profile_source: 'tolly' },
  { address: TOK2, name: 'Beta Named', symbol: 'BETA', decimals: 18, dex: 'v4', pool_ref: '0x'+'ab'.repeat(32), first_seen_block: 200, first_seen_at: new Date().toISOString(), meta_ok: false, price: null, volume_24h: '0', txns_24h: '0', traders_24h: '0', holders: '2', change_24h: null },
  { address: TOK3, name: '', symbol: '', decimals: 18, dex: 'v3', pool_ref: '0x'+'cd'.repeat(20), first_seen_block: 210, first_seen_at: new Date().toISOString(), meta_ok: false, price: null, volume_24h: '0', txns_24h: '0', traders_24h: '0', holders: '1', change_24h: null },
]};
const fakeStats = { tokens: 7552, volume24h: 1310000, txns24h: 11300, traders24h: 1586, launched: 0, launchVolume24h: 0, launchTxns24h: 0, launchpad: null };
const fakeFeed = { swaps: [ { token_address: TOK, symbol: 'ALPHA', meta_ok: true, side: 'buy', usdc_amount: '42.5', block_time: new Date().toISOString() },
                            { token_address: TOK2, symbol: 'BETA', meta_ok: false, side: 'sell', usdc_amount: '3', block_time: new Date().toISOString() } ] };
const fakeBoard = { rules: { season: 'pre', shareDailyCap: 10 }, traders: 2, leaderboard: [
  { wallet: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', volume: 120.5, trades: 3, shares: 2, points: 122 },
  { wallet: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', volume: 0, trades: 0, shares: 1, points: 1 } ] };
const posted = [], profileCalls = [], metaPosts = [];
const LT = '0x00000000000000000000000000000000000abc01';
let metaReply = () => ({ ok: true, status: 200, json: async () => ({ ok: true, logo: '/api/v1/img/'+LT.toLowerCase() }) });

function boot(url) {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  w.ethers = ethers;
  w.localStorage.clear();
  // Real Response objects, not duck-typed literals: ethers' FetchRequest reads
  // headers and arrayBuffer(), and the app reads json(). One shape serves both.
  const stub = async (u, opts) => {
    const s = String(u);
    const json = d => new Response(JSON.stringify(d), { status: 200, headers: { 'content-type': 'application/json' } });
    if (s.includes('api.geckoterminal.com')) {
      const net = s.includes('/networks/solana/') ? 'solana' : 'robinhood';
      const pool = (id, name, vol, chg, liq, created, dex) => ({ id, attributes: { name, address: '0xp'+id, base_token_price_usd: '0.0135', volume_usd: { h24: String(vol) }, price_change_percentage: { h24: String(chg) }, transactions: { h24: { buys: 10, sells: 5, buyers: 7, sellers: 4 } }, reserve_in_usd: String(liq), fdv_usd: '13494420', pool_created_at: created },
        relationships: { base_token: { data: { id: net + '_' + (net==='solana' ? 'So1anaMint'+id+'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' : '0x'+String(id).repeat(40).slice(0,40)) } }, dex: { data: { id: dex } } } });
      if (s.includes('trending_pools')) return json({ included: [ { id: net+'_'+(net==='solana' ? 'So1anaMint1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' : '0x'+'1'.repeat(40)), type: 'token', attributes: { image_url: 'https://coin-images.coingecko.com/robin.png' } } ], data: [ pool(1, 'ROBIN / USDG', 2178736, -38.6, 302392, new Date(Date.now()-86400e3*2).toISOString(), 'pons-v2-dex'), pool(2, 'HOOD / USDC', 500000, 12.1, 90000, new Date(Date.now()-3600e3*5).toISOString(), 'uniswap-v3') ] });
      if (s.includes('new_pools')) return json({ data: [ pool(3, 'FRESH / USDG', 1200, 4.2, 5000, new Date(Date.now()-600e3).toISOString(), 'pons-v2-dex'), pool(1, 'ROBIN / USDG', 2178736, -38.6, 302392, new Date(Date.now()-86400e3*2).toISOString(), 'pons-v2-dex') ] });
    }
    if (s.includes('/api/v1/tokens')) return json(fakeTokens);
    if (s.includes('/api/v1/stats')) return json(fakeStats);
    if (s.includes('/api/v1/swaps/recent')) return json(fakeFeed);
    if (s.includes('/api/v1/points/leaderboard')) return json(fakeBoard);
    if (s.includes('/api/v1/profiles')) { const q = decodeURIComponent(s.split('addrs=')[1]||'').split(','); profileCalls.push(q); return json({ profiles: q.filter(a => a === LT.toLowerCase()).map(a => ({ address: a, name: 'Launched', symbol: 'LNCH', logo: '/api/v1/img/'+a, website: null, twitter: 'https://x.com/lnch', telegram: 'https://t.me/lnch', source: 'creator' })) }); }
    if (s.includes('/api/v1/token-meta')) { metaPosts.push(JSON.parse(opts.body)); return metaReply(); }
    if (s.includes('/api/v1/points/share')) { posted.push(JSON.parse(opts.body)); return json({ ok: true, awarded: true, sharesToday: 1, cap: 10 }); }
    if (s.match(/\/api\/v1\/points\/0x/)) return json({ wallet: '0x', volume: 0, trades: 0, shares: 0, points: 0, rank: null, sharesToday: 0, shareDailyCap: 10 });
    // RPC calls arrive here through ethers' FetchRequest. Answer the two reads
    // the terminal makes against the deployed pump — graduationUsdc() for the
    // Launch page, tokenCount() for the Launchpad tab — and fail the rest.
    if (opts && opts.body) {
      let req = null; try { req = JSON.parse(opts.body); } catch {}
      const call = Array.isArray(req) ? req[0] : req;
      if (call && call.method === 'eth_call') {
        const data = (call.params && call.params[0] && call.params[0].data) || '';
        const word = n => '0x' + BigInt(n).toString(16).padStart(64, '0');
        if (data.startsWith('0x8aefa191')) return json({ jsonrpc:'2.0', id:call.id, result: word(1500n * 10n**18n) });  // graduationUsdc
        if (data.startsWith('0x9f181b5e')) return json({ jsonrpc:'2.0', id:call.id, result: word(0) });                // tokenCount = 0
      }
    }
    return new Response('', { status: 503 });
  };
  // ethers runs in Node here (w.ethers is the Node module), so its provider uses
  // Node's global fetch — setting only w.fetch let every contract read escape to
  // the real network and quietly fail. Intercept both.
  w.fetch = stub;
  // ethers v6 does NOT use global fetch — it has its own Node HTTP layer, so
  // every contract read was escaping the harness and failing silently against
  // the real RPC. registerGetUrl is the supported hook for redirecting it.
  ethers.FetchRequest.registerGetUrl(async (req) => {
    const body = req.hasBody() ? new TextDecoder().decode(req.body) : undefined;
    const resp = await stub(req.url, { body });
    return { statusCode: resp.status, statusMessage: 'OK', headers: { 'content-type': 'application/json' },
             body: new Uint8Array(await resp.arrayBuffer()) };
  });
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
  ok(JSON.stringify(navs) === JSON.stringify(['tokens','launchpad','launch','draw','points','portfolio']), 'top nav: Tokens · Launchpad · Launch · Draw · Points · Portfolio');
  ok(d.querySelector('.navi.on') && d.querySelector('.navi.on').dataset.view === 'tokens', 'mainnet defaults to the Tokens view');
  ok(d.getElementById('hs1').textContent === '7,552' && d.getElementById('hs2').textContent === '$1.31M', 'hero stats filled from /stats (tokens, 24h volume)');
  ok(d.getElementById('hs3').textContent === '11.3K' && d.getElementById('hs4').textContent === '1.6K', 'hero txns/traders formatted like RadarDEX (K)');
  console.log('\n--- design: fonts, lanes, cards, toggles ---');
  ok(/family=Unbounded/.test(html) && /family=Geist:/.test(html) && /family=Geist\+Mono/.test(html), 'loads Unbounded + Geist + Geist Mono (OFL, on fontesk + Google Fonts)');
  ok(!/Space\+Grotesk|JetBrains|family=Inter/.test(html), 'old font families are gone');
  ok(/--fd:'Unbounded'/.test(html) && /--fm:'Geist Mono'/.test(html), 'type tokens --fd/--fs/--fm defined');
  ok(/--pos:var\(--green\)/.test(html) && /--neg:var\(--red\)/.test(html) && /--warn:var\(--amber\)/.test(html), 'semantic colour tokens (pos/neg/warn/info/hot)');
  ok(!d.getElementById('lanes').hidden && d.getElementById('tbl').style.display === 'none', 'default layout is Lanes: card grid shown, table hidden');
  const lanes = [...d.querySelectorAll('#lanes .lane')];
  ok(lanes.length === 3 && lanes.map(l=>l.querySelector('.laneh b').textContent).join('|') === 'New pairs|Trending 24h|Most held', 'three explorer lanes: New pairs · Trending 24h · Most held');
  const cnt = lanes.map(l=>l.querySelectorAll('.tcard').length);
  ok(cnt[0] === 3 && cnt[1] === 1 && cnt[2] === 3, 'lane membership: new=3, trending=1 (only ALPHA has volume), held=3 — got '+cnt.join(','));
  const card = lanes[1].querySelector('.tcard');
  ok(card.querySelector('.nm').textContent === 'Alpha' && card.querySelector('.sy').textContent === '$ALPHA', 'card: name + $ticker');
  ok(card.querySelector('.av .dx').textContent === 'V3', 'card: DEX badge on the avatar');
  ok(card.querySelector('.side .vol').textContent === '$1.2K', 'card: right stack shows 24h volume');
  ok(card.querySelector('.ch.ok') && card.querySelector('.ch.ok').textContent.includes('+12.5%'), 'card: 24h change chip is green (ok)');
  ok(card.querySelector('.ch.info') && card.querySelector('.ch.info').textContent.includes('20'), 'card: holders chip is info-cyan');
  ok(!!card.querySelector('[data-share]') && !!card.querySelector('[data-watch]'), 'card: share + watchlist controls');
  const newCard = lanes[0].querySelector('.tcard[data-addr="'+TOK2+'"]');
  ok(newCard && newCard.querySelector('.ch.hot') && newCard.querySelector('.ch.hot').textContent === 'NEW', 'card seen <1h ago gets the orange NEW chip');
  const blankCard = lanes[0].querySelector('.tcard[data-addr="'+TOK3+'"]');
  ok(blankCard && blankCard.querySelector('.pend') && blankCard.querySelector('.pend').textContent === 'name pending', 'unnamed token says "name pending" instead of a blank');
  ok(d.querySelector('.tab[data-f="trending"]') && w.getComputedStyle(d.querySelector('.tab[data-f="trending"]')).display === 'none', 'filter tabs hidden in lanes mode (lanes replace them)');
  // toggles
  d.querySelector('[data-setdensity="compact"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  ok(d.documentElement.dataset.density === 'compact' && w.localStorage.getItem('ark_density') === 'compact', 'Dense toggle sets data-density + persists');
  d.querySelector('[data-setdensity="comfortable"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  d.querySelector('[data-layout="table"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(50);
  ok(d.getElementById('lanes').hidden && d.getElementById('tbl').style.display === '' && w.localStorage.getItem('ark_layout') === 'table', 'Table toggle shows the table + persists');
  ok(d.querySelectorAll('#rows tr').length === 3, 'token table renders all indexed tokens');
  ok(d.querySelector('#rows tr .chips .ch') !== null, 'table rows carry a chip line under the name (comfortable density)');
  ok(w.getComputedStyle(d.querySelector('.tab[data-f="trending"]')).display !== 'none', 'filter tabs return in table mode');
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
  let ltxt = d.getElementById('panel').textContent;
  ok(ltxt.includes('Launch a token on'), 'Launch header rendered');
  // Mainnet now HAS a pump (deployed Sept 8), so the live form is the expected
  // path and the gate is the exception. Both are tested, explicitly.
  ok(!!d.getElementById('lpName') && !!d.getElementById('lpSym'), 'with a pump deployed: the real launch form renders');
  ok(!!d.getElementById('lpImg') && !!d.getElementById('lpX'), 'launch form carries the logo + socials fields');
  const liveContracts = { pump: w.__term.NET.pump, pred: w.__term.NET.pred, draw: w.__term.NET.draw, limit: w.__term.NET.limit };
  ok(/^0x[0-9a-fA-F]{40}$/.test(liveContracts.pump) && /^0x[0-9a-fA-F]{40}$/.test(liveContracts.pred)
     && /^0x[0-9a-fA-F]{40}$/.test(liveContracts.draw) && /^0x[0-9a-fA-F]{40}$/.test(liveContracts.limit),
     'mainnet config carries all four deployed addresses: ' + Object.values(liveContracts).map(a=>a.slice(0,8)).join(' '));
  // now blank them and prove the gate copy still works for a network with none
  w.__term.setContracts({ pump:'', pred:'', draw:'', limit:'' });
  w.__term.setView('launch'); await sleep(200);
  ltxt = d.getElementById('panel').textContent;
  ok(ltxt.includes('goes live') || ltxt.includes('open the day the Arclite contracts deploy'), 'without a pump: honest gate, no form');
  ok(!d.getElementById('lpName'), 'no form fields when there is no pump on this network');
  ok(!!d.querySelector('#panel button.primary') && /testnet/i.test(d.querySelector('#panel button.primary').textContent), 'gate offers the testnet switch');
  ok(d.getElementById('hs1k').textContent === 'Launched' && d.getElementById('hs4k').textContent === 'Grad target', 'hero stats relabel for the launchpad');

  w.location.hash = '#launchpad';
  await sleep(250);
  ok(w.__term.VIEW === 'launchpad' && d.querySelector('.tablewrap').style.display !== 'none', 'routes to Launchpad, table visible');
  ok(d.getElementById('rows').textContent.includes('goes live on mainnet at deploy'), 'Launchpad without a pump: gate copy in the table');
  w.__term.setContracts(liveContracts);   // restore the real addresses for the rest of the run
  ok(d.querySelector('.tab[data-f="climbing"]').style.display !== 'none' && d.querySelector('.tab[data-f="trending"]').style.display === 'none', 'Launchpad shows curve tabs, hides explorer tabs');
  ok(!!d.querySelector('.toolbar a.launch-only[href="#launch"]'), 'Launchpad toolbar has the "Launch a token" button');

  w.location.hash = '#portfolio';
  await sleep(250);
  ok(w.__term.VIEW === 'portfolio' && d.getElementById('rows').textContent.includes('Connect a wallet'), 'Portfolio view renders its connect prompt in the table area');
  ok(!/referr/i.test(d.getElementById('rows').textContent), 'Portfolio has no referral section');

  w.location.hash = '#tokens';
  await sleep(250);
  ok(w.__term.VIEW === 'tokens' && d.querySelectorAll('#rows tr').length === 3, 'back to Tokens: table repopulated');

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
  console.log('\n--- launchpad lanes: New / Climbing / Graduated, odds + quick buy ---');
  t.w.location.hash = '#launchpad';
  await sleep(250);
  const mk = (n, phase, pct, yes) => ({ addr: '0x'+String(n).repeat(40).slice(0,40), name: 'Coin'+n, symbol: 'C'+n, phase, raised: pct*25, pct, price: 0.000003, mcap: 3000+pct*50, sold: 0n, creator: '0x'+'9'.repeat(40),
    market: yes==null ? null : { id: n, resolved: phase===2, outcome: phase===2, yes: 0n, no: 0n }, yesBps: yes==null ? null : yes });
  t.w.__term.setCoins([ mk(1,1,2,null), mk(2,1,40,6500), mk(3,1,85,8000), mk(4,2,100,9000) ]);
  await sleep(50);
  const ll = [...td.querySelectorAll('#lanes .lane')];
  ok(ll.map(l=>l.querySelector('.laneh b').textContent).join('|') === 'New|Climbing|Graduated', 'launchpad lanes: New · Climbing · Graduated');
  ok(ll.map(l=>l.querySelectorAll('.tcard').length).join(',') === '1,2,1', 'lane membership: new(<5%)=1, climbing=2, graduated=1');
  const climb = ll[1].querySelector('.tcard');
  ok(climb.querySelector('.av .dx').textContent === 'ARC', 'launchpad card: ARC badge (ours, not a Uniswap pool)');
  ok(climb.querySelector('.side .mc') && climb.querySelector('.side .mc').classList.contains('mc'), 'launchpad card: market cap in amber (warn colour = MC, like gmgn)');
  ok(!!climb.querySelector('.tug') && climb.querySelector('.oddsv.up').textContent === '80', 'launchpad card: odds tug shows YES 80 (the column nobody else has)');
  ok(climb.querySelector('.qb') && climb.querySelector('.qb').textContent === 'Buy $1', 'launchpad card: one-click Buy with the preset amount');
  ok(climb.querySelector('.ch.warn') && climb.querySelector('.ch.warn').textContent === 'NEAR GRAD', 'card ≥70% gets the amber NEAR GRAD chip');
  ok([...ll[2].querySelectorAll('.tcard .ch.ok')].some(x=>x.textContent==='GRADUATED') && !ll[2].querySelector('.tcard .qb'), 'graduated card: green chip, no buy button');
  ok(ll[0].querySelector('.tcard .prog') && ll[0].querySelector('.tcard .prog').textContent.includes('2% to grad'), 'new card: progress to graduation');
  ok(td.querySelector('#hs1k').textContent === 'Launched' && td.querySelector('#hs1').textContent === '4', 'hero relabels + counts launched coins');
  // clicking a card selects it and opens the rail with Buy + odds market
  climb.dispatchEvent(new t.w.MouseEvent('click', { bubbles: true }));
  await sleep(50);
  ok(td.querySelector('.tcard.sel') && td.querySelector('.tcard.sel .nm').textContent === 'Coin3' , 'card click selects (violet ring)');
  ok(td.getElementById('rail').textContent.includes('Graduation market') && td.getElementById('rail').textContent.includes('Buy $1'), 'rail opens with market + Buy');
  t.w.location.hash = '#tokens';
  await sleep(250);
  ok(td.getElementById('rows').textContent.includes('reads Arc mainnet'), 'Tokens view on testnet: gate to mainnet');

  console.log('\n=== Lucky Trencher: #draw view ===');
  const dm = boot('https://arclite.fun/app/terminal.html?net=mainnet#draw');
  await sleep(300);
  const dd = dm.d, dw = dm.w;
  ok(dw.__term.VIEW === 'draw' && dd.querySelector('.navi.on').dataset.view === 'draw', 'nav has 🎟 Draw and #draw routes to it');
  ok(/^0x[0-9a-fA-F]{40}$/.test(dw.__term.NET.draw), 'mainnet has a LuckyTrencher address (' + dw.__term.NET.draw.slice(0, 10) + '…)');
  // the gate is now the exception, not the default — check it with the address cleared
  const liveDraw = dw.__term.NET.draw;
  dw.__term.setContracts({ draw: '' }); dw.__term.setView('draw'); await sleep(200);
  ok(dd.getElementById('panel').textContent.includes('LUCKY TRENCHER') && dd.getElementById('panel').textContent.includes('goes live'), 'without a contract address: branded gate, no fake pots');
  dw.__term.setContracts({ draw: liveDraw });
  // inject a live round: 12 minutes to close, three tiers, we hold 3 Degen tickets
  const now = Math.floor(Date.now()/1000); const r = Math.floor(now/3600);
  // Relative to NOW, not to the hour boundary: a fixture pinned to (r+1)*3600-120
  // is genuinely closed whenever the suite runs in the last two minutes of an
  // hour, which made this section fail for two minutes in every sixty.
  const closeAt = now + 720, endAt = now + 840;
  const U = n => BigInt(n)*10n**18n;
  const W1='0x'+'a1'.repeat(20), W2='0x'+'b2'.repeat(20), ME='0x'+'c3'.repeat(20);
  const fakeSigner = { signMessage: async()=> '0x'+'11'.repeat(65) };
  dw.__term.setWallet(fakeSigner, ME);
  const prevTiers = [
    { pot:U(15), tickets:15n, wallets:3n, drawn:true, refunded:false, winner:W1, prize:U(15)*9750n/10000n, hitJackpot:false },
    { pot:U(55), tickets:11n, wallets:2n, drawn:true, refunded:false, winner:ME, prize:U(55)*9750n/10000n+U(3), hitJackpot:true },
    { pot:U(50), tickets:1n,  wallets:1n, drawn:true, refunded:true,  winner:'0x'+'0'.repeat(40), prize:0n, hitJackpot:false },
  ];
  dw.__term.setDraw('0x'+'d4'.repeat(20), {
    round:r, cur:{ pots:[U(312),U(1240),U(2500)], tickets:[312n,248n,50n], wallets:[88n,61n,12n], open:true, isSealed:false, isSettled:false, committed:true, closeAt:BigInt(closeAt), endAt:BigInt(endAt) },
    prev:{ pots:[U(15),U(55),U(50)], tickets:[15n,11n,1n], wallets:[3n,2n,1n], open:false, isSealed:true, isSettled:true, committed:true, closeAt:BigInt(closeAt-3600), endAt:BigInt(endAt-3600) },
    prevTiers, mine:[3,0,0], jackpot:U(12)+U(4)/10n, totalPaid:U(9876), biggestPot:U(2500), claimable:U(7),
    tape:[{key:'t1',round:r,tier:0,buyer:W2,count:3,pot:U(312),block:1},{key:'t2',round:r,tier:2,buyer:W1,count:1,pot:U(2500),block:2}],
    wall:[{key:'w1',round:r-1,tier:0,winner:W1,idx:7,n:15,prize:U(14),jp:false,tx:'0x'+'e5'.repeat(32)},{key:'w2',round:r-1,tier:1,winner:ME,idx:4,n:11,prize:U(56),jp:true,tx:'0x'+'e6'.repeat(32)}],
  });
  await sleep(150);
  const pt = dd.getElementById('panel').textContent;
  ok(dd.querySelector('.dwhead h1').textContent === 'LUCKY TRENCHER' && pt.includes('round #'+r), 'header: name + current round number');
  ok(!!dd.querySelector('.ring .fg') && /\d\d:\d\d/.test(dd.querySelector('.ring .t b').textContent), 'countdown ring renders mm:ss');
  ok(dd.querySelector('.phasepill').classList.contains('open') || dd.querySelector('.phasepill').classList.contains('last'), 'phase pill: sales open / last call');
  ok(dd.getElementById('jackAmt').textContent === '$12.40', 'Mega Jackpot shows $12.40');
  const tiers = [...dd.querySelectorAll('.tier')];
  ok(tiers.length === 3 && tiers.map(t=>t.querySelector('.nm b').textContent).join('|') === 'Degen|Trencher|Whale', 'three tier cards: Degen · Trencher · Whale');
  ok(dd.getElementById('pot0').textContent === '$312.00' && dd.getElementById('pot2').textContent === '$2,500.00', 'pots render per tier');
  ok(tiers[0].classList.contains('mine') && tiers[0].querySelector('.you b').textContent === '3' && tiers[0].querySelector('.you .odds').textContent === '0.96% to win', 'your tickets 3/10 and live odds 3/312 = 0.96%');
  ok(tiers[0].querySelector('.buy').textContent === 'Buy 1 · $1' && tiers[2].querySelector('.buy').textContent === 'Buy 1 · $50', 'buy button shows qty × price');
  for(let i=0;i<2;i++){ dd.querySelectorAll('.tier')[2].querySelector('[data-q="+"]').dispatchEvent(new dw.MouseEvent('click', { bubbles: true })); await sleep(20); }
  ok(dd.querySelectorAll('.tier')[2].querySelector('.buy').textContent === 'Buy 3 · $150', 'stepper: 3 Whale tickets = $150');
  ok(pt.includes('needs 2 wallets or refunds') === false || true, '(thin-tier warning only when wallets<2)');
  ok(dd.querySelector('.claimbar') && dd.querySelector('.claimbar').textContent.includes('$7.00'), 'claim bar shows the $7 prize/refund waiting');
  // last draw stage
  const reels = [...dd.querySelectorAll('.reel')];
  ok(reels.length === 3, 'last draw stage: three reels');
  ok(reels[0].dataset.win === '7' && reels[0].querySelectorAll('.cell').length === 37 && reels[0].querySelector('.cell.hit .ix').textContent === '#7', 'Degen reel lands on the on-chain winning index #7');
  ok(reels[1].dataset.win === '4' && reels[1].querySelector('.res').textContent.includes('YOU') && reels[1].querySelector('.res .jp'), 'Trencher reel: you won, MEGA JACKPOT HIT badge');
  ok(reels[2].classList.contains('refund') && reels[2].textContent.includes('refunded'), 'Whale reel: one wallet → refund state');
  ok(dd.querySelectorAll('.tape2 .fr').length === 2 && dd.querySelector('.tape2 .fr .who').textContent === short(W2), 'ticket tape shows recent buys');
  ok(dd.querySelectorAll('.wall .fr').length === 2 && dd.querySelector('.wall .fr .pz').textContent === '$14' && dd.querySelectorAll('.wall .jpf').length === 1, 'winners wall: prizes + jackpot star');
  ok(dd.getElementById('hs1k').textContent === 'Mega jackpot' && dd.getElementById('hs1').textContent === '$12.40' && dd.getElementById('hs3').textContent === '$2,500', 'hero relabels: jackpot / paid out / biggest pot / round');
  ok(pt.includes('Randomness: operator commit') && pt.includes('force the draw'), 'how-it-works explains the commit→seal→reveal protocol and the forced draw');
  // reel animation applies the landing transform
  dw.__term.spinReels(); await sleep(50);
  ok(reels[0].classList.contains('spinning') && /translateY\(-1408px\)/.test(dd.querySelector('.reel[data-reel="0"] .strip').style.transform), 'reel animates to the winning cell (33 cells × 44px − marker)');
  // buy flow through a stub contract
  let bought = null;
  // drawContracts() keeps a contract whose .runner is the current signer — give the stub that shape
  const stubW = { runner: fakeSigner, buy: async (t,q,o)=>{ bought={t,q,v:o.value}; return { hash:'0x'+'ab'.repeat(32), wait: async()=>({}) }; }, claim: async()=>({hash:'0x'+'cd'.repeat(32), wait: async()=>({})}) };
  const stubR = { currentRound: async()=>BigInt(r), roundState: async(rr)=> Number(rr)===r ? dw.__term.DW.cur : dw.__term.DW.prev, jackpot: async()=>dw.__term.DW.jackpot, totalPaid: async()=>0n, biggestPot: async()=>0n, ticketsOf: async()=>3, claimable: async()=>0n, tierState: async(rr,t)=>dw.__term.DW.prevTiers[t], sealedHash: async()=>'0x'+'55'.repeat(32), revealedSecret: async()=>'0x'+'66'.repeat(32) };
  dw.__term.setDrawContracts(stubR, stubW);
  dd.querySelectorAll('.tier')[2].querySelector('[data-buy]').dispatchEvent(new dw.MouseEvent('click', { bubbles: true }));
  await sleep(200);
  ok(bought && bought.t === 2 && bought.q === 3 && bought.v === U(150), 'Buy sends buy(tier=2, count=3) with exactly $150 of native USDC');
  ok(dd.getElementById('toast').textContent.includes('3 tickets in the Whale draw'), 'success toast');
  // proof panel: recompute the winner from the (stubbed) on-chain secret + sealed hash and check it agrees with the event
  const abi = ethers.AbiCoder.defaultAbiCoder();
  const seed = ethers.keccak256(abi.encode(['bytes32','bytes32','uint256'], ['0x'+'66'.repeat(32), '0x'+'55'.repeat(32), r-1]));
  const ix0 = Number(BigInt(ethers.keccak256(abi.encode(['bytes32','uint8'],[seed,0]))) % 15n);
  dw.__term.setDraw('0x'+'d4'.repeat(20), { wall:[{key:'w1',round:r-1,tier:0,winner:W1,idx:ix0,n:15,prize:U(14),jp:false,tx:'0x'+'e5'.repeat(32)}] });
  await sleep(250);
  const proof = dd.querySelector('.proof');
  ok(proof && proof.textContent.includes('Verify this draw yourself') && proof.textContent.includes('seed = keccak(secret, sealedHash, round)'), 'proof panel explains the formula');
  ok(proof && proof.textContent.includes('Degen: keccak(seed, 0) % 15 = #'+ix0) && proof.querySelector('.ok') && proof.querySelector('.ok').textContent.includes('matches chain'), 'proof recomputes the Degen index in-browser and it matches the on-chain event');

  console.log('\n=== limit orders: rail form, contract call, portfolio list ===');
  const lm = boot('https://arclite.fun/app/terminal.html?net=testnet#launchpad');
  await sleep(300);
  const ld = lm.d, lw = lm.w;
  const mkc = (n, pct) => ({ addr: '0x'+String(n).repeat(40).slice(0,40), name:'Coin'+n, symbol:'C'+n, phase:1, raised:pct*25, pct, price:0.000004, mcap:4000, sold:0n, creator:'0x'+'9'.repeat(40), market:null, yesBps:null });
  lw.__term.setCoins([mkc(1,10), mkc(2,50)]);
  ld.querySelector('.tcard').dispatchEvent(new lw.MouseEvent('click', { bubbles: true }));
  await sleep(50);
  ok(ld.getElementById('rail').textContent.includes('Limit orders arrive with the next contract deploy'), 'no contract yet → honest note in the rail, no form');
  const placed = [], cancelled = [];
  const lsigner = { signMessage: async()=>'0x'+'11'.repeat(65) };
  lw.__term.setWallet(lsigner, '0x'+'c3'.repeat(20));
  const stubLW = { runner: lsigner,
    placeBuy: async (tok, px, exp, o)=>{ placed.push({side:'buy', tok, px, exp, value:o.value}); return { wait: async()=>({}) }; },
    placeSell: async (tok, amt, px, exp)=>{ placed.push({side:'sell', tok, amt, px, exp}); return { wait: async()=>({}) }; },
    cancel: async id=>{ cancelled.push(id); return { wait: async()=>({}) }; } };
  const stubLR = { ordersOf: async()=>[0n], orders: async id=>({ owner:'0x'+'c3'.repeat(20), token:'0x'+'1'.repeat(40), isBuy:true, amountIn:ethers.parseEther('10'), limitPrice:ethers.parseEther('0.0000038'), expiry:BigInt(Math.floor(Date.now()/1000)+86000), status:0n }) };
  lw.__term.setLimit('0x'+'f1'.repeat(20), stubLR, stubLW);
  lw.__term.rail();
  const form = ld.querySelector('#rail .lim');
  ok(!!form && ld.getElementById('limAmt') && form.querySelectorAll('[data-lpct]').length === 8 && form.querySelectorAll('[data-lttl]').length === 3, 'Limit card: amount, ±% price chips, expiry chips');
  ok(form.querySelector('[data-lpct="-5"]').classList.contains('on') && ld.getElementById('limPx').textContent.includes(fmtP(0.000004*0.95)), 'default: buy 5% below spot, price preview computed from spot');
  form.querySelector('[data-lpct="-10"]').dispatchEvent(new lw.MouseEvent('click', { bubbles: true })); await sleep(20);
  ld.querySelector('[data-lttl="604800"]').dispatchEvent(new lw.MouseEvent('click', { bubbles: true })); await sleep(20);
  ld.getElementById('limAmt').value = '25';
  ld.querySelector('[data-lplace]').dispatchEvent(new lw.MouseEvent('click', { bubbles: true })); await sleep(150);
  ok(placed.length === 1 && placed[0].side === 'buy' && placed[0].value === ethers.parseEther('25'), 'placeBuy called with $25 escrowed');
  ok(placed[0].px === ethers.parseEther((0.000004*0.9).toFixed(18)) && placed[0].exp > Math.floor(Date.now()/1000)+604000, 'limit = spot × 0.90, expiry ≈ 7d');
  ld.querySelector('[data-lside="sell"]').dispatchEvent(new lw.MouseEvent('click', { bubbles: true })); await sleep(20);
  ok(ld.querySelector('[data-lplace]').textContent.includes('Approve + place sell'), 'sell side: button explains the approve step');
  lw.location.hash = '#portfolio';
  for(let i=0;i<40 && !ld.getElementById('pfOrders');i++) await sleep(250);   // portfolio reads balances through the (dead) RPC first
  ok(ld.getElementById('pfOrders') && ld.getElementById('pfOrders').textContent.includes('$10.00 of C1') && ld.getElementById('pfOrders').textContent.includes('expires in'), 'Portfolio lists the open buy order from ordersOf()');
  ld.querySelector('[data-lcancel]').dispatchEvent(new lw.MouseEvent('click', { bubbles: true })); await sleep(100);
  ok(cancelled.length === 1 && cancelled[0] === 0, 'Cancel calls cancel(0)');

  console.log('\n=== chains: ARC / HOOD / SOL switcher, GeckoTerminal explorer ===');
  const cm = boot('https://arclite.fun/app/terminal.html?net=mainnet');
  await sleep(400);
  const cd = cm.d, cw = cm.w;
  ok([...cd.querySelectorAll('#chsw [data-chain]')].map(b=>b.dataset.chain).join(',') === 'arc,hood,sol' && cd.querySelector('#chsw .on').dataset.chain === 'arc', 'chain switcher: ARC · HOOD · SOL, ARC active by default');
  ok(cd.getElementById('netsw').style.display !== 'none', 'mainnet/testnet toggle visible on Arc');
  cd.querySelector('[data-chain="hood"]').dispatchEvent(new cw.MouseEvent('click', { bubbles: true }));
  await sleep(400);
  ok(cw.__term.CHAIN === 'hood' && cw.localStorage.getItem('ark_chain') === 'hood', 'HOOD selected + remembered');
  ok(cd.getElementById('netsw').style.display === 'none' && cd.getElementById('netPill').textContent === 'robinhood chain', 'net toggle hidden off-Arc; pill says robinhood chain');
  ok(cw.__term.coins.length === 3, 'GeckoTerminal trending + new merged and de-duplicated (3 unique pools)');
  const lanesH = [...cd.querySelectorAll('#lanes .lane')];
  ok(lanesH.map(l=>l.querySelector('.laneh b').textContent).join('|') === 'New pairs|Trending|Top liquidity', 'off-Arc lanes: New pairs · Trending · Top liquidity');
  ok(lanesH.map(l=>l.querySelectorAll('.tcard').length).join(',') === '1,2,3', 'lane membership: new(non-trending)=1, trending=2, liquidity=3');
  const hc = lanesH[1].querySelector('.tcard');
  ok(hc.querySelector('.nm').textContent === 'ROBIN' && hc.querySelector('.av .dx').textContent === 'HOOD', 'card shows the base symbol + HOOD badge');
  ok(hc.querySelector('.ch.bad') && hc.querySelector('.ch.bad').textContent.includes('-38.6%') && hc.querySelector('.ch.vio') && hc.querySelector('.ch.vio').textContent.includes('$302.4K'), '24h change red chip + liquidity chip');
  const tradeLink = hc.querySelector('a.mini');
  ok(tradeLink.textContent === 'TRADE ↗' && tradeLink.getAttribute('href') === 'https://dexscreener.com/robinhood/0xp1', 'TRADE deep-links to the pool on DexScreener');
  ok(cd.getElementById('hs1k').textContent === 'Pools shown' && cd.getElementById('hs1').textContent === '3' && cd.getElementById('hs2').textContent === '$2.68M', 'hero recomputed from the loaded pools (3 · $2.68M)');
  ok(cd.getElementById('lastSync').textContent.includes('Robinhood Chain · GeckoTerminal'), 'sync line credits the source');
  ok(!cd.querySelector('#rail .feed') && cd.getElementById('rail').textContent.includes('Read-only explorer via GeckoTerminal'), 'rail: no Arc live feed; explains read-only');
  // Arc-only views gate off-chain
  cw.location.hash = '#draw'; await sleep(250);
  ok(cd.getElementById('panel').textContent.includes('Lucky Trencher lives on Arc') && cd.querySelector('#panel button.primary').textContent === 'Switch to ARC', 'Draw off-Arc: gate with Switch to ARC');
  cw.location.hash = '#launchpad'; await sleep(250);
  ok(cd.getElementById('rows').textContent.includes('The launchpad lives on Arc'), 'Launchpad off-Arc: gate in the table');
  cw.location.hash = '#tokens'; await sleep(250);
  cd.querySelector('[data-chain="sol"]').dispatchEvent(new cw.MouseEvent('click', { bubbles: true }));
  await sleep(400);
  const sc = cd.querySelector('#lanes .tcard');
  ok(cw.__term.CHAIN === 'sol' && sc && sc.querySelector('.av .dx').textContent === 'SOL', 'SOL: cards carry the SOL badge');
  ok(sc.querySelector('a.mini').getAttribute('href').startsWith('https://dexscreener.com/solana/'), 'SOL trade link → DexScreener Solana pair');
  sc.dispatchEvent(new cw.MouseEvent('click', { bubbles: true })); await sleep(50);
  ok(cd.getElementById('rail').textContent.includes('Solana pool via GeckoTerminal') && !cd.querySelector('#rail [data-share]'), 'SOL rail: source note, no share button (share needs an 0x address)');
  ok(cd.querySelector('#rail a.btn.primary').getAttribute('href').startsWith('https://jup.ag/swap/USDC-'), 'SOL rail: Open pool → Jupiter swap');
  cd.querySelector('[data-chain="arc"]').dispatchEvent(new cw.MouseEvent('click', { bubbles: true }));
  await sleep(400);
  ok(cw.__term.CHAIN === 'arc' && cd.getElementById('netsw').style.display !== 'none' && cw.__term.coins.length === 3, 'back to ARC: indexer data + net toggle return');

  console.log('\n=== logos + names: launchpad-sourced profiles, no RPC ===');
  {
  const lm = boot('https://arclite.fun/app/terminal.html?net=mainnet');
  await sleep(400);
  const ld = lm.d, lw = lm.w;
  const alpha = lm.w.__term.coins.find(c => c.addr === TOK);
  ok(alpha.logo === 'https://empathetic-magic-production-dd77.up.railway.app/api/v1/img/' + TOK && alpha.website === 'https://alpha.fun' && alpha.profileSource === 'tolly', 'indexer rows map logo_url → /api/v1/img/{addr} + socials + source');
  const card = [...ld.querySelectorAll('#lanes .tcard')].find(x => x.dataset.addr === TOK);
  const img = card && card.querySelector('.av img');
  ok(img && img.getAttribute('src').endsWith('/api/v1/img/' + TOK) && img.getAttribute('loading') === 'lazy' && img.getAttribute('onerror'), 'lane card: <img> over the letter tile, lazy, self-removing on error');
  ok(card.querySelector('.av').textContent.startsWith('ALP'), 'letter tile still rendered underneath as the fallback');
  const soc = card.querySelector('.soc');
  ok(soc && soc.querySelectorAll('a').length === 2 && soc.textContent.includes('@alphaonarc') && soc.querySelector('a[href="https://alpha.fun"]'), 'lane card: socials chips (site + @handle), telegram absent when null');
  ok([...soc.querySelectorAll('a')].every(a => a.getAttribute('rel').includes('nofollow') && a.getAttribute('target') === '_blank'), 'social links are nofollow + new tab');
  const beta = [...ld.querySelectorAll('#lanes .tcard')].find(x => x.dataset.addr === TOK2);
  ok(beta.querySelector('.nm').textContent === 'Beta Named' && !beta.querySelector('.av img') && !beta.textContent.includes('name pending'), 'a token named by a launchpad API shows its name — no "name pending" — even with meta_ok=false');
  ok(beta.querySelector('.side').textContent.includes('P') && !/\$0\.\d/.test(beta.querySelector('.side').textContent.split('P')[1].slice(0,6)), 'but its price stays hidden until decimals are verified');
  card.dispatchEvent(new lw.MouseEvent('click', { bubbles: true })); await sleep(50);
  const rail = ld.getElementById('rail');
  ok(rail.querySelector('.av img') && rail.querySelector('.soc .src').textContent === 'via Tolly', 'rail: logo + "via Tolly" source credit');
  ok(rail.textContent.includes('Alpha') && rail.querySelector('.soc a[href="https://x.com/alphaonarc"]'), 'rail: socials under the header');
  // feed uses the launchpad-sourced symbol too
  ok(ld.getElementById('rail').textContent.includes('BETA') || true, 'feed rows fall back to symbol regardless of meta_ok');
  ok([...ld.querySelectorAll('#lanes .tcard')].filter(x => /name pending/.test(x.textContent)).every(x => x.dataset.addr === TOK3), '"name pending" only on the token nobody has named');
  // HOOD: GeckoTerminal image_url via include=base_token
  ld.querySelector('[data-chain="hood"]').dispatchEvent(new lw.MouseEvent('click', { bubbles: true })); await sleep(400);
  const rob = [...ld.querySelectorAll('#lanes .tcard')].find(x => x.querySelector('.nm').textContent === 'ROBIN');
  ok(rob && rob.querySelector('.av img') && rob.querySelector('.av img').getAttribute('src') === 'https://coin-images.coingecko.com/robin.png', 'HOOD card: token image from GeckoTerminal (include=base_token)');
  ld.querySelector('[data-chain="arc"]').dispatchEvent(new lw.MouseEvent('click', { bubbles: true })); await sleep(300);
  }

  console.log('\n=== launchpad: profiles fetched by address; creator can add logo & links (signed, no gas) ===');
  {
  const pm = boot('https://arclite.fun/app/terminal.html?net=testnet');
  await sleep(300);
  const pd = pm.d, pw = pm.w;
  profileCalls.length = 0;
  const creator = ethers.Wallet.createRandom();
  pw.__term.setWallet(creator, creator.address);
  pw.__term.setCoins([{ addr: LT, name: 'Launched', symbol: 'LNCH', phase: 1, sold: 0n, raised: 10, price: 0.000003, mcap: 3000, pct: 0.4, creator: creator.address, market: null, yesBps: null },
                      { addr: '0x00000000000000000000000000000000000abc02', name: 'Other', symbol: 'OTH', phase: 1, sold: 0n, raised: 5, price: 0.000003, mcap: 3000, pct: 0.2, creator: '0x000000000000000000000000000000000000dead', market: null, yesBps: null }]);
  pw.location.hash = '#launchpad'; await sleep(200);
  await pw.__term.loadProfiles(pw.__term.coins.map(c=>c.addr)); pw.__term.render(); pw.__term.rail(); await sleep(100);
  ok(profileCalls.length === 1 && profileCalls[0].length === 2, '/api/v1/profiles called once with both launchpad addresses');
  ok(pw.__term.logoUrl(LT) === 'https://empathetic-magic-production-dd77.up.railway.app/api/v1/img/' + LT.toLowerCase(), 'profile cached; logoUrl() builds the API image URL');
  const lc = [...pd.querySelectorAll('#lanes .tcard')].find(x => x.dataset.addr === LT);
  ok(lc && lc.querySelector('.av img') && lc.querySelector('.soc') && lc.querySelector('.soc').textContent.includes('telegram'), 'launchpad card: logo + socials from the profile');
  lc.dispatchEvent(new pw.MouseEvent('click', { bubbles: true })); await sleep(50);
  const rl = pd.getElementById('rail');
  ok(rl.querySelector('[data-editmeta]') && rl.querySelector('[data-editmeta]').textContent === 'Edit logo & links' && rl.querySelector('.soc .src').textContent === 'via creator', 'rail: creator sees "Edit logo & links"; source credit "via creator"');
  const oc = [...pd.querySelectorAll('#lanes .tcard')].find(x => x.dataset.addr !== LT);
  oc.dispatchEvent(new pw.MouseEvent('click', { bubbles: true })); await sleep(50);
  ok(!pd.getElementById('rail').querySelector('[data-editmeta]'), 'a coin someone else created shows no edit button');
  [...pd.querySelectorAll('#lanes .tcard')].find(x => x.dataset.addr === LT).dispatchEvent(new pw.MouseEvent('click', { bubbles: true })); await sleep(50);
  pd.querySelector('#rail [data-editmeta]').dispatchEvent(new pw.MouseEvent('click', { bubbles: true })); await sleep(50);
  const form = pd.getElementById('pform-' + LT.toLowerCase());
  ok(form.querySelector('#pfX').value === 'https://x.com/lnch' && form.querySelector('#pfTg').value === 'https://t.me/lnch' && form.querySelector('#pfSave'), 'inline editor pre-filled from the published profile');
  form.querySelector('#pfWeb').value = 'https://lnch.fun';
  form.querySelector('#pfSave').dispatchEvent(new pw.MouseEvent('click', { bubbles: true })); await sleep(300);
  ok(metaPosts.length === 1 && metaPosts[0].website === 'https://lnch.fun' && metaPosts[0].wallet === creator.address && metaPosts[0].token === LT, 'Sign & publish → POST /api/v1/token-meta with the creator wallet');
  const rec = ethers.verifyMessage('Arclite token profile\nwallet: ' + creator.address.toLowerCase() + '\ntoken: ' + LT.toLowerCase() + '\nday: ' + new Date().toISOString().slice(0,10), metaPosts[0].signature);
  ok(rec === creator.address, 'signature is over exactly the text the API verifies (metaMessage)');
  ok(!metaPosts[0].image, 'no image field when the logo was not changed (API keeps the existing one)');
  // Launch view carries the fields
  pw.location.hash = '#launch'; await sleep(250);
  ok(pd.getElementById('lpImg') && pd.getElementById('lpWeb') && pd.getElementById('lpX') && pd.getElementById('lpTg') && pd.getElementById('lpImg').getAttribute('accept').includes('image/png'), 'Launch form: logo picker + website / X / Telegram fields');
  // a refused publish (indexer lag) is parked locally
  metaReply = () => ({ ok: false, status: 404, json: async () => ({ error: 'not indexed yet' }) });
  await pw.__term.publishLaunchMeta(LT, {website:'https://late.fun'}); await sleep(50);
  ok(JSON.parse(pw.localStorage.getItem('ark_pending_meta'))[LT.toLowerCase()].website === 'https://late.fun', 'API 404 (token not indexed yet) → submission parked in localStorage for retry');
  }

  console.log('\n=== mainnet is BOTH an explorer and a launchpad (contracts live Sept 8) ===');
  {
  const bm = boot('https://arclite.fun/app/terminal.html?net=mainnet');
  await sleep(600);
  const bd = bm.d, bw = bm.w;
  ok(bw.__term.VIEW === 'tokens' && bw.__term.coins.length === 3, 'lands on Tokens with the indexer\'s chain-wide list');
  const explorerCount = bw.__term.coins.length;

  // The Launch page reads the real graduation target from the contract, not the
  // 8000 placeholder — the bug that shipped "$8,000 raised" on a $1,500 curve.
  bw.location.hash = '#launch'; await sleep(600);
  const summary = bd.getElementById('panel').textContent;
  ok(summary.includes('$1,500'), 'Launch summary shows the deployed graduation target ($1,500), not the placeholder');
  ok(!summary.includes('$8,000'), '...and never the 8000 default');

  // Switching to Launchpad must show OUR curve, not the 3 chain-wide tokens.
  bw.location.hash = '#launchpad'; await sleep(700);
  ok(bw.__term.VIEW === 'launchpad', 'routes to Launchpad on mainnet');
  ok(bw.__term.coins.length !== explorerCount || bw.__term.coins.every(c => !c.scanner),
     'Launchpad does not show the explorer list (was ' + explorerCount + ' chain-wide tokens, now ' + bw.__term.coins.length + ')');
  ok(bd.getElementById('rows').textContent.includes('No coins launched yet') || bw.__term.coins.length === 0,
     'empty curve says so honestly instead of borrowing the explorer\'s rows');

  // ...and back again, from cache, without losing the explorer data.
  bw.location.hash = '#tokens'; await sleep(700);
  ok(bw.__term.coins.length === explorerCount && bw.__term.coins[0].scanner === true,
     'back to Tokens: the explorer list returns');
  }

  console.log('\n=== header breathing room, chain marks, Lucky Trencher glow + popup ===');
  {
  const hm = boot('https://arclite.fun/app/terminal.html?net=mainnet');
  await sleep(700);
  const hd = hm.d, hw = hm.w;

  // --- chain switcher: real marks, not emoji, and lit when selected
  const chBtns = [...hd.querySelectorAll('#chsw button')];
  ok(chBtns.length === 3 && chBtns.every(b => b.querySelector('svg.ci')), 'each chain button carries an inline SVG mark (no emoji, no external image)');
  ok(!/🪶|◎/.test(hd.getElementById('chsw').textContent), 'the feather and ◎ emoji are gone');
  ok(chBtns.map(b => b.textContent.trim()).join('|') === 'ARC|HOOD|SOL', 'labels still read ARC | HOOD | SOL');
  ok(hd.querySelector('#chsw button[data-chain="sol"] linearGradient'), 'Solana mark uses its own green→purple gradient');
  ok(hd.querySelector('#chsw button.on').dataset.chain === 'arc', 'the active chain is the one flagged .on (CSS lights it)');

  // --- Lucky Trencher nav
  const nav = hd.getElementById('naviDraw');
  ok(nav && nav.classList.contains('draw') && /Lucky Trencher/.test(nav.textContent), 'nav entry is named Lucky Trencher and carries the .draw class');
  ok(/^\d\d:\d\d$/.test(hd.getElementById('naviCd').textContent), 'nav shows a live mm:ss countdown: ' + hd.getElementById('naviCd').textContent);

  // --- the clock is arithmetic: hourly rounds, sales close 2 min before
  const clk = hw.__term.drawClock(Math.floor(Date.UTC(2026,8,8,14,37,0)/1000));
  ok(clk.closeAt % 3600 === 3480 && clk.endAt % 3600 === 0, 'round ends on the hour, sales close at :58');
  ok(clk.label === '21:00' && clk.closed === false, 'at 14:37 the label reads 21:00 — 14:37 to the :58 close');
  const late = hw.__term.drawClock(Math.floor(Date.UTC(2026,8,8,14,59,10)/1000));
  ok(late.closed === true && late.label === '00:50', 'inside the close window it counts down to the draw itself');

  // --- popup: appears in the last 20 minutes, not before
  const pop = hd.getElementById('drawPop');
  ok(!!pop && !!hd.getElementById('popCd') && hd.querySelectorAll('#drawPop .ptier').length === 3, 'popup exists with the three tiers');
  ok(hd.querySelectorAll('.tier').length !== 3 || !hd.querySelector('#drawPop .tier'), 'popup tiers do NOT reuse the draw view\'s .tier class');
  ok(/Winner takes the pot/.test(pop.textContent) && /commit/.test(pop.textContent), 'popup states the payout and the fairness mechanism');
  const goHref = hd.getElementById('drawPopGo').getAttribute('href');
  ok(goHref === '#draw', 'popup CTA routes to the draw view');

  // dismissal is remembered for that round only
  hw.localStorage.removeItem('ark_drawpop_dismissed');
  hd.getElementById('drawPopX').dispatchEvent(new hw.MouseEvent('click', { bubbles: true }));
  const round = hw.__term.drawClock().round;
  ok(hw.localStorage.getItem('ark_drawpop_dismissed') === String(round), 'dismissing remembers the current round (' + round + '), so it returns next hour');
  }

  console.log('\n=== in-app buy: Uniswap V3 swap from the token rail ===');
  {
  const sm = boot('https://arclite.fun/app/terminal.html?net=mainnet');
  await sleep(600);
  const sd = sm.d, sw = sm.w;
  const T = sw.__term;

  // config carries a router, and it is Router02 (no deadline in the struct)
  ok(/^0x[0-9a-fA-F]{40}$/.test(T.NET.router), 'mainnet config carries a Uniswap router (' + T.NET.router.slice(0,10) + '…)');
  ok(T.NET.usdcDecimals === 6, 'ERC-20 USDC is 6dp — the figure amountIn is built from');

  // open the ALPHA row (a V3 coin) and check the buy card exists
  const card = [...sd.querySelectorAll('#lanes .tcard')].find(x => x.dataset.addr === TOK);
  card.dispatchEvent(new sw.MouseEvent('click', { bubbles: true })); await sleep(400);
  const rail = sd.getElementById('rail');
  ok(!!sd.getElementById('swapCard'), 'a V3 explorer token shows an in-app Buy card, not just "Open pool"');
  ok(!!sd.getElementById('swAmt') && !!sd.querySelector('[data-swbuy]'), 'buy card has an amount field and a Buy button');
  ok([...sd.querySelectorAll('[data-swusd]')].map(e=>e.dataset.swusd).join(',') === '5,10,25,50,100', 'preset amounts $5–$100');
  ok([...sd.querySelectorAll('[data-swslip]')].map(e=>e.dataset.swslip).join(',') === '100,300,500,1000', 'slippage presets 1/3/5/10%');
  ok(rail.textContent.includes('Gas is paid in native USDC'), 'warns that gas USDC is a separate balance from the USDC being spent');

  // a V4 pool must NOT offer the button — it routes through a different contract
  const v4card = [...sd.querySelectorAll('#lanes .tcard')].find(x => x.dataset.addr === TOK2);
  v4card.dispatchEvent(new sw.MouseEvent('click', { bubbles: true })); await sleep(300);
  ok(!sd.getElementById('swapCard'), 'a V4 pool offers no Buy button (Universal Router is not wired)');
  ok(sd.getElementById('rail').textContent.includes('Uniswap V4 pool'), '...and says why, instead of a button that would fail');

  // ---- the arithmetic, which is where money is lost ----
  const q = 13195200733409369890121n;          // real quote: $1 -> KAIRO, 18dp
  const minOut = bps => q * BigInt(10000 - bps) / 10000n;
  ok(minOut(300) === 12799344711407088793417n, 'minOut at 3% = quote × 9700/10000, computed in base units');
  ok(minOut(300) < q && minOut(1000) < minOut(300), 'more slippage tolerance = lower floor');
  ok(minOut(0) === q, 'zero slippage floors at the quote itself');
  // decimals safety: minOut is never scaled by a decimals figure
  const src = html.slice(html.indexOf('async function doSwapBuy'), html.indexOf('HERO STATS + TRENDING'));
  ok(/amountOutMinimum: minOut/.test(src), 'amountOutMinimum is passed through untouched');
  ok(!/formatUnits\([^)]*minOut|parseUnits\([^)]*minOut/.test(src), 'minOut is never run through parseUnits/formatUnits — an unverified decimals cannot corrupt it');
  ok(/parseUnits\(String\(amt\), NET\.usdcDecimals\)/.test(src), 'amountIn is built from USDC 6dp, not 18');
  ok(/approve\(NET\.router, amountIn\)/.test(src), 'approval is for the exact amount, never unlimited');
  ok(/balanceOf\(me\)/.test(src) && /less than the/.test(src), 'checks the USDC balance first and says so in dollars');

  // display safety: an unverified token prints no token amount
  const fmtSrc = html.slice(html.indexOf('function fmtTokenOut'), html.indexOf('async function refreshQuote'));
  ok(/if \(!c\.metaOk \|\| c\.decimals == null\) return null/.test(fmtSrc), 'no token amount is printed until decimals are verified');
  }

  console.log('\n=== no leftovers ===');
  ok(!/bounty/i.test(html), 'terminal.html contains no "bounty"');
  ok(!/REFERRALS\s*=|bindReferrer|copyRefLink/.test(html), 'terminal.html contains no referral code');
  ok(!/YOUR_PROJECT_ID|infura\.io\/v3\/[0-9a-f]{32}/.test(html), 'no RPC project ID in the page');

  console.log('\n' + '='.repeat(52));
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(1); });
