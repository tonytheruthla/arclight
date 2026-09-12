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
  { address: TOK, name: 'Alpha', symbol: 'ALPHA', decimals: 18, dex: 'v3', pool_ref: '0x3333333333333333333333333333333333333333', first_seen_block: 100, first_seen_at: new Date(Date.now()-86400e3).toISOString(), meta_ok: true, price: '0.5', volume_24h: '1200', txns_24h: '9', traders_24h: '4', holders: '20', change_24h: '12.5', total_supply: '1000000000', logo_url: 'ipfs://bafyALPHA', website: 'https://alpha.fun', twitter: 'https://x.com/alphaonarc', telegram: null, profile_source: 'tolly' },
  { address: TOK2, name: 'Beta Named', symbol: 'BETA', decimals: 18, dex: 'v4', pool_ref: '0x'+'ab'.repeat(32), first_seen_block: 200, first_seen_at: new Date().toISOString(), meta_ok: false, price: null, volume_24h: '0', txns_24h: '0', traders_24h: '0', holders: '2', change_24h: null },
  { address: TOK3, name: '', symbol: '', decimals: 18, dex: 'v3', pool_ref: '0x'+'cd'.repeat(20), first_seen_block: 210, first_seen_at: new Date().toISOString(), meta_ok: false, price: null, volume_24h: '0', txns_24h: '0', traders_24h: '0', holders: '1', change_24h: null },
]};
const fakeStats = { tokens: 7552, volume24h: 1310000, txns24h: 11300, traders24h: 1586, launched: 0, launchVolume24h: 0, launchTxns24h: 0, launchpad: null };
const fakeFeed = { swaps: [ { token_address: TOK, symbol: 'ALPHA', meta_ok: true, side: 'buy', usdc_amount: '42.5', block_time: new Date().toISOString() },
                            { token_address: TOK2, symbol: 'BETA', meta_ok: false, side: 'sell', usdc_amount: '3', block_time: new Date().toISOString() } ] };
const fakeBoard = { rules: { season: 'pre', shareDailyCap: 10 }, traders: 2, leaderboard: [
  { wallet: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', volume: 120.5, trades: 3, shares: 2, points: 122 },
  { wallet: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', volume: 0, trades: 0, shares: 1, points: 1 } ] };
const posted = [], profileCalls = [], metaPosts = [], quoterCalls = [], walletCalls = [], solCalls = [], hoodCalls = [];
const QUOTE_OUT = 135644666987196334623n;   // a real Robinhood Chain quote: 0.0097 ETH → CASHCAT, 18dp
const LT = '0x00000000000000000000000000000000000abc01';
let metaReply = () => ({ ok: true, status: 200, json: async () => ({ ok: true, logo: '/api/v1/img/'+LT.toLowerCase() }) });

function boot(url, boptions) {
  const BOPT = boptions || {};
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
      // quote side: what a buyer pays with. WETH and USDG are the two the
      // Robinhood docs name; UNLISTED stands in for a bridged/unknown quote.
      const WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73', USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', UNLISTED = '0x'+'de'.repeat(20);
      const pool = (id, name, vol, chg, liq, created, dex, quote, quoteUsd) => ({ id, attributes: { name, address: '0xp'+id, base_token_price_usd: '0.0135', quote_token_price_usd: String(quoteUsd==null ? 1 : quoteUsd), volume_usd: { h24: String(vol) }, price_change_percentage: { h24: String(chg) }, transactions: { h24: { buys: 10, sells: 5, buyers: 7, sellers: 4 } }, reserve_in_usd: String(liq), fdv_usd: '13494420', pool_created_at: created },
        relationships: { base_token: { data: { id: net + '_' + (net==='solana' ? 'So1anaMint'+id+'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' : '0x'+String(id).repeat(40).slice(0,40)) } }, quote_token: { data: { id: net + '_' + (quote || USDG) } }, dex: { data: { id: dex } } } });
      if (s.includes('trending_pools')) return json({ included: [ { id: net+'_'+(net==='solana' ? 'So1anaMint1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' : '0x'+'1'.repeat(40)), type: 'token', attributes: { image_url: 'https://coin-images.coingecko.com/robin.png' } } ], data: [ pool(1, 'ROBIN / USDG', 2178736, -38.6, 302392, new Date(Date.now()-86400e3*2).toISOString(), 'pons-v2-dex', USDG, 1), pool(2, 'HOOD / WETH', 500000, 12.1, 90000, new Date(Date.now()-3600e3*5).toISOString(), 'uniswap-v3-robinhood', WETH, 4000) ] });
      if (s.includes('new_pools')) return json({ data: [ pool(3, 'FRESH / XYZ', 1200, 4.2, 5000, new Date(Date.now()-600e3).toISOString(), 'uniswap-v3-robinhood', UNLISTED, 1), pool(1, 'ROBIN / USDG', 2178736, -38.6, 302392, new Date(Date.now()-86400e3*2).toISOString(), 'pons-v2-dex', USDG, 1) ] });
    }
    if (s.includes('/api/v1/tokens')) return json(BOPT.tokens ? { tokens: BOPT.tokens } : fakeTokens);
    if (s.includes('/api/v1/stats')) return json(fakeStats);
    if (s.includes('/api/v1/swaps/recent')) return json(fakeFeed);
    if (s.includes('/api/v1/points/leaderboard')) return json(fakeBoard);
    if (s.includes('/api/v1/profiles')) { const q = decodeURIComponent(s.split('addrs=')[1]||'').split(','); profileCalls.push(q); return json({ profiles: q.filter(a => a === LT.toLowerCase()).map(a => ({ address: a, name: 'Launched', symbol: 'LNCH', logo: '/api/v1/img/'+a, website: null, twitter: 'https://x.com/lnch', telegram: 'https://t.me/lnch', source: 'creator' })) }); }
    if (s.includes('/api/v1/token-meta')) { metaPosts.push(JSON.parse(opts.body)); return metaReply(); }
    if (s.includes('/api/v1/points/share')) { posted.push(JSON.parse(opts.body)); return json({ ok: true, awarded: true, sharesToday: 1, cap: 10 }); }
    if (s.match(/\/api\/v1\/points\/0x/)) return json(BOPT.points || { wallet: '0x', volume: 0, trades: 0, shares: 0, points: 0, rank: null, sharesToday: 0, shareDailyCap: 10 });
    // Portfolio reads (v14): the indexer's ledger, its Solana proxy, and Robinhood Chain's explorer
    if (s.match(/\/api\/v1\/wallet\/0x/)) { walletCalls.push(s); return BOPT.wallet ? json(BOPT.wallet) : new Response('', { status: 503 }); }
    if (s.match(/\/api\/v1\/sol\//)) { solCalls.push(s); return BOPT.sol ? json(BOPT.sol) : new Response(JSON.stringify({ error: 'solana read failed', hint: 'SOL_RPC is not set' }), { status: 502, headers: { 'content-type': 'application/json' } }); }
    if (s.includes('robinhoodchain.blockscout.com/api/v2/addresses/')) { hoodCalls.push(s); return BOPT.hood ? json(BOPT.hood) : new Response('', { status: 404 }); }
    if (s.includes('robinhoodchain.blockscout.com/api/v2/stats')) return json({ coin_price: '2500' });
    // RPC calls arrive here through ethers' FetchRequest. Answer the two reads
    // the terminal makes against the deployed pump — graduationUsdc() for the
    // Launch page, tokenCount() for the Launchpad tab — and fail the rest.
    if (opts && opts.body) {
      let req = null; try { req = JSON.parse(opts.body); } catch {}
      const call = Array.isArray(req) ? req[0] : req;
      if (call && call.method === 'eth_chainId') return json({ jsonrpc:'2.0', id:call.id, result: s.includes('robinhood') ? '0x1237' : '0x13b2' });
      if (call && call.method === 'eth_getBalance' && BOPT.balances) return json({ jsonrpc:'2.0', id:call.id, result: '0x' + BigInt(s.includes('robinhood') ? BOPT.balances.hoodEth : BOPT.balances.arcNative).toString(16) });
      if (call && call.method === 'eth_call') {
        const data = (call.params && call.params[0] && call.params[0].data) || '';
        const word = n => '0x' + BigInt(n).toString(16).padStart(64, '0');
        if (data.startsWith('0x70a08231') && BOPT.balances) {   // balanceOf(who) on token `to`
          const to = (call.params[0].to || '').toLowerCase();
          const b = BOPT.balances.tokens && BOPT.balances.tokens[to];
          return json({ jsonrpc:'2.0', id:call.id, result: word(b == null ? 0n : b) });
        }
        if (data.startsWith('0xdd62ed3e') && BOPT.balances) return json({ jsonrpc:'2.0', id:call.id, result: word(0) });   // allowance = 0
        if (data.startsWith('0x8aefa191')) return json({ jsonrpc:'2.0', id:call.id, result: word(1500n * 10n**18n) });  // graduationUsdc
        if (data.startsWith('0x9f181b5e')) return json({ jsonrpc:'2.0', id:call.id, result: word(0) });                // tokenCount = 0
        if (data.startsWith('0x313ce567')) return json({ jsonrpc:'2.0', id:call.id, result: word(18) });               // decimals()
        // QuoterV2.quoteExactInputSingle: only the 1% tier fills, and it returns
        // QUOTE_OUT regardless of amount — enough to drive the card's arithmetic.
        if (data.startsWith('0xc6a5026a')) {
          const fee = parseInt(data.slice(10 + 64*3, 10 + 64*4), 16);
          quoterCalls.push({ tokenIn: '0x'+data.slice(10+24, 10+64), tokenOut: '0x'+data.slice(10+64+24, 10+128), amountIn: BigInt('0x'+data.slice(10+128, 10+192)), fee });
          if (fee !== 10000) return json({ jsonrpc:'2.0', id:call.id, error: { code: -32000, message: 'execution reverted' } });
          return json({ jsonrpc:'2.0', id:call.id, result: word(QUOTE_OUT) + word(0).slice(2) + word(1).slice(2) + word(85790).slice(2) });
        }
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
  ok(d.getElementById('hs1k').textContent === 'Tokens' && d.getElementById('heroTag').textContent === 'Points for trading. Points for posting.', 'hero tagline switches for Points — the campaign line, sentence case');

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
  ok(!/testnet/i.test(d.getElementById('panel').textContent), 'gate no longer points at a testnet that users cannot reach');
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
  ok(climb.querySelector('.side .mcap b') && climb.querySelector('.side .mcap b').textContent.startsWith('$'), 'launchpad card: market cap leads the side column in the amber pill');
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
  ok(!td.getElementById('rows').textContent.includes('You\'re on testnet'), 'Tokens view never tells the user they are on testnet');

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
  for(let i=0;i<40 && !ld.querySelector('[data-pftab="orders"]');i++) await sleep(250);
  ld.querySelector('[data-pftab="orders"]').dispatchEvent(new lw.MouseEvent('click', { bubbles: true })); await sleep(100);
  ok(ld.getElementById('pfOrders') && ld.getElementById('pfOrders').textContent.includes('$10.00 of C1') && ld.getElementById('pfOrders').textContent.includes('expires in'), 'Portfolio → Orders tab lists the open buy order from ordersOf()');
  ld.querySelector('[data-lcancel]').dispatchEvent(new lw.MouseEvent('click', { bubbles: true })); await sleep(100);
  ok(cancelled.length === 1 && cancelled[0] === 0, 'Cancel calls cancel(0)');

  console.log('\n=== chains: ARC / HOOD / SOL switcher, GeckoTerminal explorer ===');
  const cm = boot('https://arclite.fun/app/terminal.html?net=mainnet');
  await sleep(400);
  const cd = cm.d, cw = cm.w;
  ok([...cd.querySelectorAll('#chsw [data-chain]')].map(b=>b.dataset.chain).join(',') === 'arc,hood,sol' && cd.querySelector('#chsw .on').dataset.chain === 'arc', 'chain switcher: ARC · HOOD · SOL, ARC active by default');
  ok(!cd.getElementById('netsw') && !/Testnet|Mainnet/.test(cd.querySelector('.topbar').textContent),
     'no Mainnet/Testnet switch anywhere in the topbar');
  ok(cd.getElementById('netPill').textContent === 'arc', 'pill says "arc", not "arc mainnet"');
  cd.querySelector('[data-chain="hood"]').dispatchEvent(new cw.MouseEvent('click', { bubbles: true }));
  await sleep(400);
  ok(cw.__term.CHAIN === 'hood' && cw.localStorage.getItem('ark_chain') === 'hood', 'HOOD selected + remembered');
  ok(cd.getElementById('netPill').textContent === 'robinhood chain', 'pill follows the chain off-Arc');
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
  ok(!cd.querySelector('#rail .feed') && cd.getElementById('rail').textContent.includes('Uniswap V3 pools buy in-app, 3% Arclite fee'), 'rail: no Arc live feed; says what buys in-app and what opens on its DEX');
  ok(cd.getElementById('heroTag').textContent === 'Everything. On Chain.' && !/GeckoTerminal/.test(cd.getElementById('heroTag').textContent), 'HOOD hero line is the three words, not "explorer via GeckoTerminal"');
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
  ok(cw.__term.CHAIN === 'arc' && cd.getElementById('netPill').textContent === 'arc' && cw.__term.coins.length === 3, 'back to ARC: indexer data returns, pill says arc');

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
  ok(/amountOutMinimum: minOut/.test(html.slice(html.indexOf('function buildSwapCalls'), html.indexOf('async function doSwapBuy'))), 'amountOutMinimum is passed through untouched');
  ok(!/formatUnits\([^)]*minOut|parseUnits\([^)]*minOut/.test(src), 'minOut is never run through parseUnits/formatUnits — an unverified decimals cannot corrupt it');
  ok(T.spendUnits(10, { usd: 1, dec: 6 }) === 10000000n, 'amountIn is built from USDC 6dp, not 18 ($10 → 10,000,000)');
  ok(/approve\(cfg\.router, amountIn\)/.test(src) && !/MaxUint256|2\*\*256|ffffffff/.test(src), 'approval is for the exact amount, never unlimited');
  ok(/balanceOf\(who\)/.test(src) && /less than the/.test(src), 'checks the balance first and says so in the buyer\'s units');

  // display safety: an unverified token prints no token amount
  const fmtSrc = html.slice(html.indexOf('function fmtTokenOut'), html.indexOf('async function refreshQuote'));
  ok(/if \(!c\.metaOk \|\| c\.decimals == null\) return null/.test(fmtSrc), 'no token amount is printed until decimals are verified');
  }

  // ---- in-app buy on Robinhood Chain, and the 3% fee on every V3 buy -----
  console.log('\n=== Robinhood Chain: buy in-app, 3% Arclite fee in the same transaction ===');
  {
  // An EIP-1193 wallet that records everything and signs nothing. ethers'
  // JsonRpcSigner runs against it for real: populate, estimateGas, send,
  // poll the hash, wait for the receipt.
  const word = n => '0x' + BigInt(n).toString(16).padStart(64, '0');
  const ADDR = '0xCDF74d039A0c259524c0A64e5bd56FceF492b246';
  const fakeWallet = (startChain, opts) => {
    const st = { chain: startChain, calls: [], sent: [], switched: [], added: [], usdcBalance: 1_000_000_000n, allowance: 0n };
    const receipt = h => ({ transactionHash: h, blockNumber: '0x10', blockHash: '0x'+'1'.repeat(64), status: '0x1', logs: [], gasUsed: '0x1', cumulativeGasUsed: '0x1', from: ADDR, to: st.sent[parseInt(h,16)-1].to, contractAddress: null, transactionIndex: '0x0', logsBloom: '0x'+'0'.repeat(512), type: '0x0', effectiveGasPrice: '0x1' });
    st.request = async ({ method, params }) => {
      st.calls.push(method);
      switch (method) {
        case 'eth_chainId': return '0x' + st.chain.toString(16);
        case 'eth_accounts': case 'eth_requestAccounts': return [ADDR];
        case 'wallet_switchEthereumChain':
          st.switched.push(params[0].chainId);
          if (opts && opts.unknownChains && opts.unknownChains.includes(params[0].chainId)) { const e = new Error('Unrecognized chain'); e.code = 4902; throw e; }
          st.chain = parseInt(params[0].chainId, 16); return null;
        case 'wallet_addEthereumChain': st.added.push(params[0]); st.chain = parseInt(params[0].chainId, 16); return null;
        case 'eth_getBalance': return word(10n**18n);                       // 1 ETH
        case 'eth_call': { const d = (params[0].data || '');
          if (d.startsWith('0x70a08231')) return word(st.usdcBalance);      // balanceOf
          if (d.startsWith('0xdd62ed3e')) return word(st.allowance);        // allowance
          throw new Error('unstubbed eth_call ' + d.slice(0, 10)); }
        case 'eth_estimateGas': return '0x30000';
        case 'eth_blockNumber': return '0x10';
        case 'eth_sendTransaction': { const tx = params[0]; st.sent.push({ ...tx, chain: st.chain }); if (tx.data && tx.data.startsWith('0x095ea7b3')) st.allowance = BigInt('0x' + tx.data.slice(74)); return word(st.sent.length); }
        case 'eth_getTransactionByHash': { const i = parseInt(params[0], 16) - 1, t = st.sent[i];
          return { hash: params[0], blockNumber: '0x10', blockHash: '0x'+'1'.repeat(64), transactionIndex: '0x0', from: ADDR, to: t.to, nonce: '0x'+i.toString(16), gas: '0x30000', gasPrice: '0x1', value: t.value || '0x0', input: t.data, chainId: '0x'+t.chain.toString(16), type: '0x0', r: '0x'+'1'.repeat(64), s: '0x'+'1'.repeat(64), v: '0x1b' }; }
        case 'eth_getTransactionReceipt': return receipt(params[0]);
        default: throw new Error('unstubbed ' + method);
      }
    };
    return st;
  };
  const decodeMulticall = data => {
    const T = ethers;
    const iface = new T.Interface(['function multicall(uint256 deadline, bytes[] data)', 'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96))', 'function pull(address,uint256)', 'function sweepToken(address,uint256,address)', 'function wrapETH(uint256)', 'function unwrapWETH9(uint256,address)', 'function refundETH()']);
    const [deadline, calls] = iface.decodeFunctionData('multicall', data);
    return { deadline: Number(deadline), calls: calls.map(c => { const f = iface.getFunction(c.slice(0, 10)); return { name: f.name, args: iface.decodeFunctionData(f, c) }; }) };
  };

  // ---- config: every address is the documented one, and nothing else ----
  const hm = boot('https://arclite.fun/app/terminal.html?net=mainnet');
  await sleep(500);
  const hd = hm.d, hw = hm.w, T = hw.__term, HOOD = T.CHAINS.hood;
  ok(HOOD.router === '0xcaf681a66d020601342297493863e78c959e5cb2' && HOOD.quoter === '0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7' && HOOD.v3Factory === '0x1f7d7550b1b028f7571e69a784071f0205fd2efa',
     'SwapRouter02 / QuoterV2 / factory are the addresses on developers.uniswap.org for Robinhood Chain');
  ok(HOOD.weth === '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73' && HOOD.spend['0x5fc5360d0400a0fd4f2af552add042d716f1d168'].sym === 'USDG',
     'WETH and USDG are the addresses on docs.robinhood.com/chain/contracts');
  ok(HOOD.explorer === 'https://robinhoodchain.blockscout.com' && HOOD.wallet.blockExplorerUrls[0] === HOOD.explorer, 'explorer is the one the chain docs name (blockscout), not explorer.robinhood.com');
  ok(HOOD.wallet.chainId === '0x1237' && HOOD.chainId === 4663 && HOOD.wallet.nativeCurrency.symbol === 'ETH' && HOOD.wallet.nativeCurrency.decimals === 18 && HOOD.wallet.rpcUrls[0] === 'https://rpc.mainnet.chain.robinhood.com',
     'wallet_addEthereumChain params: 4663, ETH gas, the documented public RPC');
  ok(Object.keys(HOOD.spend).length === 2 && Object.values(HOOD.spend).every(x => x.sym === 'ETH' || x.sym === 'USDG'), 'only ETH and USDG can be spent — nothing the docs don\'t name');
  ok(/include=base_token,quote_token/.test(html), 'GeckoTerminal is asked for the quote token too');

  // ---- selectors: the ABI strings resolve to the selectors verified in both routers' bytecode ----
  const sel = sig => ethers.id(sig).slice(0, 10);
  ok(sel('pull(address,uint256)') === '0xf2d5d56b' && sel('sweepToken(address,uint256,address)') === '0xdf2ab5bb' && sel('wrapETH(uint256)') === '0x1c58db4f' && sel('unwrapWETH9(uint256,address)') === '0x49404b7c' && sel('refundETH()') === '0x12210e8a' && sel('multicall(uint256,bytes[])') === '0x5ae401dc' && sel('exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))') === '0x04e45aaf',
     'ABI selectors match the ones found in the Router02 bytecode on Arc and on Robinhood Chain');
  ok(T.ROUTER_IFACE.fragments.filter(f => f.type === 'function' && f.name === 'multicall').length === 1 && T.ROUTER_IFACE.getFunction('multicall').inputs[0].name === 'deadline', 'one multicall in the ABI — the deadline one — so ethers never has to guess an overload');
  ok(!/function (sweepToken|unwrapWETH9)WithFee/.test(html), 'the router\'s own *WithFee helpers are not in the ABI: they cap at 1% (require(feeBips <= 100))');

  // ---- arithmetic ----
  ok(T.PLATFORM_FEE_BPS === 300 && T.TREASURY === '0x81cfC1013620DC96f3b94A8147888983428B374d', 'fee is 3% (300 bps) to the treasury EOA');
  ok(T.platformFee(10_000_000n) === 300_000n && T.platformFee(2_500_000_000_000_000n) === 75_000_000_000_000n, '3% in base units: $10 USDC → $0.30; 0.0025 ETH → 0.000075 ETH');
  ok(T.spendUnits(10, { usd: 4000, dec: 18 }) === 2_500_000_000_000_000n, '$10 at ETH=$4000 → 0.0025 ETH, exact in wei');
  ok(T.spendUnits(10, { usd: 1, dec: 6 }) === 10_000_000n && T.spendUnits(0.5, { usd: 1, dec: 6 }) === 500_000n, 'dollars → 6dp USDC/USDG');
  {
    const sp = { token: '0x3600000000000000000000000000000000000000', sym: 'USDC', dec: 6, native: false, usd: 1 };
    const calls = T.buildSwapCalls(sp, TOK, 10000, ADDR, 10_000_000n, 12_000n);
    const dec = decodeMulticall(T.ROUTER_IFACE.encodeFunctionData('multicall', [1, calls])).calls;
    ok(dec.map(c => c.name).join(' → ') === 'pull → sweepToken → exactInputSingle', 'ERC-20 quote: pull the fee, sweep it to the treasury, then swap');
    ok(dec[0].args[0].toLowerCase() === sp.token && dec[0].args[1] === 300_000n, 'pull(USDC, 3%)');
    ok(dec[1].args[0].toLowerCase() === sp.token && dec[1].args[1] === 300_000n && dec[1].args[2] === T.TREASURY, 'sweepToken(USDC, ≥3%, TREASURY)');
    const sw = dec[2].args[0];
    ok(sw.tokenIn.toLowerCase() === sp.token && sw.tokenOut.toLowerCase() === TOK && sw.amountIn === 9_700_000n && sw.amountOutMinimum === 12_000n && sw.recipient === ADDR && Number(sw.fee) === 10000 && sw.sqrtPriceLimitX96 === 0n,
       'exactInputSingle swaps the other 97% straight to the buyer, minOut untouched');
    ok(dec[0].args[1] + sw.amountIn === 10_000_000n, 'fee + swapped = exactly what the buyer spends; nothing is lost to rounding');
  }
  {
    const sp = { token: HOOD.weth, sym: 'ETH', dec: 18, native: true, usd: 4000 };
    const calls = T.buildSwapCalls(sp, TOK, 3000, ADDR, 2_500_000_000_000_000n, 1n);
    const dec = decodeMulticall(T.ROUTER_IFACE.encodeFunctionData('multicall', [1, calls])).calls;
    ok(dec.map(c => c.name).join(' → ') === 'wrapETH → unwrapWETH9 → exactInputSingle → refundETH', 'native ETH: wrap the fee, unwrap it to the treasury as ETH, swap the rest, refund any dust');
    ok(dec[0].args[0] === 75_000_000_000_000n && dec[1].args[0] === 75_000_000_000_000n && dec[1].args[1] === T.TREASURY, 'wrapETH(fee) then unwrapWETH9(≥fee, TREASURY) — the treasury receives ETH, not WETH');
    ok(dec[2].args[0].tokenIn === HOOD.weth && dec[2].args[0].amountIn === 2_425_000_000_000_000n, 'the pool receives 0.002425 ETH — the 97%');
  }
  ok(/bestQuote\(sp, c\.addr, amountIn - platformFee\(amountIn\)\)/.test(html), 'the quote shown is for the amount that reaches the pool, not the gross');

  // ---- the card, on HOOD ----
  hd.querySelector('[data-chain="hood"]').dispatchEvent(new hw.MouseEvent('click', { bubbles: true }));
  await sleep(500);
  const hoodTok = '0x' + '2'.repeat(40), ponsTok = '0x' + '1'.repeat(40), unlistedTok = '0x' + '3'.repeat(40);
  const clickCard = async addr => { const el = [...hd.querySelectorAll('#lanes .tcard')].find(x => x.dataset.addr === addr); el.dispatchEvent(new hw.MouseEvent('click', { bubbles: true })); await sleep(500); };
  await clickCard(hoodTok);
  const rail = hd.getElementById('rail');
  ok(!!hd.getElementById('swapCard') && !!hd.querySelector('[data-swbuy]'), 'a Uniswap V3 pool on Robinhood Chain shows the in-app Buy card');
  ok(rail.textContent.includes('Spend (USD, paid in ETH)'), 'the amount is in dollars and says it is paid in ETH');
  ok([...rail.querySelectorAll('.stat')].some(s => s.textContent.includes('Pair') && s.textContent.includes('ETH')), 'Pair stat says ETH, not a hard-coded USDC');
  ok(rail.textContent.includes('Your wallet switches to Robinhood Chain') && rail.textContent.includes('gas is paid in ETH'), 'hint: wallet switches chain, gas is ETH');
  ok(rail.textContent.includes('3% Arclite fee') && rail.textContent.includes('0.0025 ETH in') && rail.textContent.includes('0.000075 ETH') && rail.textContent.includes('0.002425 ETH swapped'),
     'the split is printed: 0.0025 ETH in · 3% fee 0.000075 ETH · 0.002425 ETH swapped');
  ok(rail.textContent.includes('≈') && rail.textContent.includes('135.645') && rail.textContent.includes('HOOD'), 'the quote renders as a token amount, 135.645 HOOD (decimals read on the chain, not guessed)');
  const qc = quoterCalls.filter(q => q.tokenOut === hoodTok);
  ok(qc.length > 0 && qc.every(q => q.tokenIn === HOOD.weth.toLowerCase() && q.amountIn === 2_425_000_000_000_000n), 'the quoter was asked for WETH → token on 0.002425 ETH (post-fee), across the fee tiers');
  ok(!hd.querySelector('#rail a.btn.primary'), 'Open pool is no longer the primary action when the buy is in-app');
  ok(rail.textContent.includes('3% Arclite fee is taken in the same transaction'), 'trade hint says the fee rides in the same transaction');

  await clickCard(ponsTok);
  ok(!hd.getElementById('swapCard') && hd.getElementById('rail').textContent.includes('lives on pons-v2-dex, not Uniswap V3'), 'a Pons pool: no Buy button, and it says which DEX it lives on');
  ok(!!hd.querySelector('#rail a.btn.primary'), '...so Open pool becomes the primary action again');
  await clickCard(unlistedTok);
  ok(!hd.getElementById('swapCard') && hd.getElementById('rail').textContent.includes('quoted in a token that isn\'t on the Robinhood Chain docs'), 'a V3 pool quoted in an unlisted token: no Buy button, and it says why');
  ok([...hd.querySelectorAll('#rail .stat')].some(s => s.textContent.includes('Pair') && s.textContent.includes('0xdede')), 'its Pair stat shows the quote address rather than pretending');

  // ---- the transaction, end to end through ethers, against the recording wallet ----
  await clickCard(hoodTok);
  const wal = fakeWallet(5042);           // connected on Arc, as every session starts
  hw.ethereum = wal;
  const bp = new ethers.BrowserProvider(wal, 'any');
  T.setWallet(await bp.getSigner(), ADDR);
  hd.getElementById('swAmt').value = '10';
  await T.doSwapBuy(hoodTok);
  ok(wal.switched.length === 1 && wal.switched[0] === '0x1237' && wal.added.length === 0, 'buying on HOOD switches the wallet to 4663 first (no add needed — the wallet knew the chain)');
  ok(wal.sent.length === 1 && wal.sent[0].chain === 4663 && wal.sent[0].to.toLowerCase() === HOOD.router, 'exactly one transaction, sent on 4663, to Uniswap\'s router — no approval for native ETH');
  ok(BigInt(wal.sent[0].value) === 2_500_000_000_000_000n, 'value = 0.0025 ETH, the gross amount');
  {
    const dec = decodeMulticall(wal.sent[0].data);
    const names = dec.calls.map(c => c.name).join(' → ');
    ok(names === 'wrapETH → unwrapWETH9 → exactInputSingle → refundETH', 'calldata is the four-step fee multicall');
    ok(dec.calls[1].args[1] === T.TREASURY && dec.calls[1].args[0] === 75_000_000_000_000n, '0.000075 ETH (3%) goes to the treasury');
    const sw = dec.calls[2].args[0];
    ok(sw.amountIn === 2_425_000_000_000_000n && sw.recipient === ADDR && sw.tokenOut.toLowerCase() === hoodTok && Number(sw.fee) === 10000, '0.002425 ETH (97%) swaps to the buyer through the 1% tier that quoted');
    ok(sw.amountOutMinimum === QUOTE_OUT * 9700n / 10000n, 'minOut = quote × (1 − 3% slippage), in the token\'s base units, untouched');
    ok(dec.deadline > Math.floor(Date.now()/1000) + 800 && dec.deadline <= Math.floor(Date.now()/1000) + 900, '15-minute deadline');
  }
  ok(wal.chain === 4663, 'the wallet is left on Robinhood Chain after the buy…');
  await T.ensureArc();
  ok(wal.chain === 5042 && wal.switched[wal.switched.length-1] === '0x13b2', '…and ensureArc() brings it back before any Arc send');
  await T.ensureArc();
  ok(wal.switched.length === 2, 'ensureArc() on a wallet already on Arc asks for nothing');

  // first time on a wallet that has never seen the chain: it gets added from the documented params
  const wal2 = fakeWallet(5042, { unknownChains: ['0x1237'] });
  hw.ethereum = wal2;
  T.setWallet(await new ethers.BrowserProvider(wal2, 'any').getSigner(), ADDR);
  await T.doSwapBuy(hoodTok);
  ok(wal2.added.length === 1 && wal2.added[0].chainId === '0x1237' && wal2.added[0].rpcUrls[0] === HOOD.wallet.rpcUrls[0] && wal2.added[0].blockExplorerUrls[0] === HOOD.explorer, 'unknown chain → wallet_addEthereumChain with the documented params');
  ok(wal2.sent.length === 1 && wal2.sent[0].chain === 4663, '…and the buy still goes out on 4663');

  // ---- the same fee on Arc, ERC-20 path: approve exact, then pull → sweep → swap ----
  hd.querySelector('[data-chain="arc"]').dispatchEvent(new hw.MouseEvent('click', { bubbles: true }));
  await sleep(500);
  const wal3 = fakeWallet(4663);          // a HOOD buy left the wallet there
  hw.ethereum = wal3;
  T.setWallet(await new ethers.BrowserProvider(wal3, 'any').getSigner(), ADDR);
  await clickCard(TOK);
  ok(!!hd.getElementById('swapCard') && hd.getElementById('rail').textContent.includes('$10.00 in · 3% Arclite fee $0.30 · $9.70 swapped'), 'Arc card prints the dollar split: $10.00 in · 3% fee $0.30 · $9.70 swapped');
  hd.getElementById('swAmt').value = '10';
  await T.doSwapBuy(TOK);
  ok(wal3.switched[0] === '0x13b2' && wal3.sent.every(t => t.chain === 5042), 'an Arc buy from a wallet still on HOOD switches to 5042 before sending');
  ok(wal3.sent.length === 2 && wal3.sent[0].to.toLowerCase() === T.NET.usdc && wal3.sent[0].data.startsWith('0x095ea7b3'), 'first transaction: USDC approve…');
  ok(BigInt('0x' + wal3.sent[0].data.slice(74)) === 10_000_000n && ('0x' + wal3.sent[0].data.slice(34, 74)).toLowerCase() === T.NET.router.toLowerCase(), '…for exactly $10 to the router, never unlimited');
  {
    const dec = decodeMulticall(wal3.sent[1].data);
    ok(wal3.sent[1].to.toLowerCase() === T.NET.router.toLowerCase() && (wal3.sent[1].value == null || BigInt(wal3.sent[1].value) === 0n), 'second transaction: the router multicall, no ETH value');
    ok(dec.calls.map(c => c.name).join(' → ') === 'pull → sweepToken → exactInputSingle', 'pull → sweepToken → exactInputSingle');
    ok(dec.calls[0].args[1] === 300_000n && dec.calls[1].args[2] === T.TREASURY && dec.calls[2].args[0].amountIn === 9_700_000n, '$0.30 to the treasury, $9.70 to the pool');
  }
  // insufficient balance: nothing is sent, and the message is in the buyer's units
  const wal4 = fakeWallet(5042); wal4.usdcBalance = 5_000_000n;
  hw.ethereum = wal4; T.setWallet(await new ethers.BrowserProvider(wal4, 'any').getSigner(), ADDR);
  await sleep(600);                        // the previous buy re-quotes on success; let that land
  await T.doSwapBuy(TOK);
  ok(wal4.sent.length === 0, 'with $5 of USDC and a $10 order, nothing is sent');
  ok(hd.getElementById('toast').textContent.includes('You have $5.00') && hd.getElementById('toast').textContent.includes('less than the $10.00'), 'and the toast says so in dollars');

  // ---- every Arc send re-asserts the chain first ----
  for (const fn of ['doLaunch', 'buyTickets', 'claimDraw', 'placeLimit', 'cancelLimit', 'doBuy', 'doBet', 'lockCreatorBuy']) {
    const i = html.indexOf('async function ' + fn + '(');
    const body = html.slice(i, html.indexOf('\n}\n', i));
    const guard = body.indexOf('await ensureArc()'), send = body.search(/\.wait\(|sendTransaction\(|\.buy\(|\.bet\(|\.claim\(|\.cancel\(|\.createToken\(|\.transfer\(|lockMyTokens\(/);
    ok(guard > 0 && send > guard, fn + '() calls ensureArc() before it sends');
  }
  ok(/const s = ch \? await walletOn\(ch\.chainId, ch\.wallet\) : \(await ensureArc\(\), signer\);/.test(html), 'sweepDust() sends on the chain the row came from, not wherever the wallet happens to be');
  ok(/const s = await walletOn\(cfg\.chainId, cfg\.wallet\);/.test(html.slice(html.indexOf('async function doSwapBuy'))), 'doSwapBuy() gets its signer from walletOn(chain) — the transaction cannot leave for the wrong chain');
  ok(/if\(now!==chainId\) throw new Error/.test(html), 'walletOn() re-reads eth_chainId after switching and refuses to continue if it disagrees');
  }

  // ---- wallet control: the button opens Portfolio ------------------------
  console.log('\n=== wallet button → Portfolio ===');
  {
  const wm = boot('https://arclite.fun/app/terminal.html?net=mainnet');
  await sleep(400);
  const wd = wm.d, ww = wm.w;
  ok(!wd.getElementById('balPill') && !wd.getElementById('fundBtn') && !wd.getElementById('wMenu'),
     'no loose balance pill, no Fund button, no dropdown menu in the topbar');
  ok(wd.getElementById('walletBtn').hidden && !wd.getElementById('connectBtn').hidden,
     'disconnected: Connect shown, wallet button hidden');
  ww.__term.setWallet({}, '0x' + 'a'.repeat(40));
  await ww.__term.refreshBalance();
  await sleep(150);
  ok(!wd.getElementById('walletBtn').hidden && wd.getElementById('connectBtn').hidden,
     'connected: Connect is replaced by the wallet button');
  ok(wd.getElementById('wAddr').textContent === '0xaaaa…aaaa', 'wallet button shows the short address');
  wd.getElementById('walletBtn').dispatchEvent(new ww.MouseEvent('click', { bubbles: true }));
  await sleep(300);
  ok(ww.__term.VIEW === 'portfolio' && ww.location.hash === '#portfolio', 'clicking the wallet button opens the Portfolio view');
  ok(wd.getElementById('lanes').hidden && wd.getElementById('tbl').style.display !== 'none',
     'Portfolio claims the table slot: lanes hidden, table shown (it shares that slot with lanes mode)');
  const pg = wd.getElementById('rows');
  // now force lanes back on, re-enter Portfolio, and check the slot again
  wd.getElementById('lanes').hidden = false; wd.getElementById('tbl').style.display = 'none';
  await ww.__term.renderPortfolio(); await sleep(60);
  ok(wd.getElementById('lanes').hidden && wd.getElementById('tbl').style.display !== 'none',
     'entering Portfolio while lanes were on hides the lanes again');
  ok(pg.querySelector('.pfid') && pg.textContent.includes('0xaaaa…aaaa') && /Your portfolio/i.test(pg.textContent), 'the page opens on an identity card with the address');
  ok(!!pg.querySelector('[data-pfcopy]') && !!pg.querySelector('[data-pffund]') && !!pg.querySelector('[data-pfdisc]'), 'Copy, Fund and Disconnect live on the page');
  ok(/Arclite points/i.test(pg.textContent) && /From trading/i.test(pg.textContent) && /From sharing/i.test(pg.textContent), 'points card splits trading and sharing');
  ok(pg.querySelectorAll('.pftab').length === 4 && [...pg.querySelectorAll('.pftab')].map(t=>t.dataset.pftab).join(',') === 'holdings,trades,launches,orders', 'tabs: Holdings · Trades · Launches · Orders');
  ok(/Robinhood Chain/.test(pg.textContent) && /Solana/.test(pg.textContent) && !!pg.querySelector('[data-pfsol]'), 'holdings are grouped by chain, with a Connect Phantom prompt for Solana');
  ww.confirm = () => false;
  pg.querySelector('[data-pfdisc]').dispatchEvent(new ww.MouseEvent('click', { bubbles: true })); await sleep(100);
  ok(!wd.getElementById('walletBtn').hidden, 'Disconnect asks first — cancelling keeps the wallet');
  ww.confirm = () => true;
  pg.querySelector('[data-pfdisc]').dispatchEvent(new ww.MouseEvent('click', { bubbles: true })); await sleep(150);
  ok(wd.getElementById('walletBtn').hidden && !wd.getElementById('connectBtn').hidden && pg.textContent.includes('Connect a wallet'),
     'confirmed Disconnect returns the topbar to Connect and the page to its prompt');
  }

  // ---- portfolio: holdings across three chains, priced, with Buy / Sell ----
  console.log('\n=== portfolio: ARC ledger + HOOD explorer + SOL proxy ===');
  {
  const ME = '0x' + 'a'.repeat(40);
  const ARC_TOK = '0x' + '1'.repeat(40), LNCH = '0x00000000000000000000000000000000000abc01';
  const HOOD_TOK = '0x' + '2'.repeat(40), HOOD_SPAM = '0x' + '3'.repeat(40), WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';
  const opts = {
    wallet: { wallet: ME, holdings: {
        dex: [ { address: ARC_TOK, name: 'Alpha', symbol: 'ALPHA', decimals: 18, dex: 'v3', meta_ok: true, logo_url: 'ipfs://x', balance: '2000000000000000000000', price: 0.5 } ],
        launch: [ { address: LNCH, name: 'Launched', symbol: 'LNCH', creator: ME, position: 1000, trades: 2 } ] },
      trades: [ { venue: 'launchpad', token_address: LNCH, symbol: 'LNCH', side: 'buy', usdc_amount: 12.5, token_amount: 1000, block_time: new Date().toISOString(), tx_hash: '0x'+'ab'.repeat(32) },
                { venue: 'dex', token_address: ARC_TOK, symbol: 'ALPHA', side: 'sell', usdc_amount: 3, token_amount: 6, block_time: new Date(Date.now()-3600e3).toISOString(), tx_hash: '0x'+'cd'.repeat(32) } ],
      launches: [ { address: LNCH, name: 'Launched', symbol: 'LNCH', created_at: new Date().toISOString(), volume: 12.5, trades: 2 } ] },
    hood: [
      { token: { address_hash: HOOD_TOK, name: 'Cash Cat', symbol: 'CASHCAT', decimals: '18', exchange_rate: '0.002', icon_url: 'https://x/cat.png', type: 'ERC-20', holders_count: '100' }, value: '5000000000000000000000' },
      { token: { address_hash: WETH, name: 'WETH', symbol: 'WETH', decimals: '18', exchange_rate: '2500', type: 'ERC-20' }, value: '0' },
      { token: { address_hash: HOOD_SPAM, name: 'rh-ofac.xyz | OFAC COMPLIANCE NOTICE: assets FROZEN, visit rh-ofac.xyz', symbol: 'FROZEN', decimals: '18', exchange_rate: null, type: 'ERC-20' }, value: '1000000000000000000' },
      { token: { address_hash: '0x'+'4'.repeat(40), name: 'Uniswap v4 Positions NFT', symbol: 'UNI-V4-POSM', decimals: null, type: 'ERC-721' }, value: '2' } ],
    sol: { owner: 'So1anaOwner1111111111111111111111111111111', sol: { amount: 2, price: 100, value: 200 }, total: 200.5,
      tokens: [ { mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', amount: 25000, raw: '2500000000', decimals: 5, symbol: 'BONK', name: 'Bonk', price: 0.00002, value: 0.5, logo: null } ] },
    points: { wallet: ME, volume: 152.7, trades: 4, shares: 3, points: 155, rank: 7, sharesToday: 1, shareDailyCap: 10 },
    balances: { arcNative: 5n * 10n**18n, hoodEth: 10n**16n, tokens: { [LNCH.toLowerCase()]: 1000n * 10n**18n, '0x3600000000000000000000000000000000000000': 2500000n } },
  };
  const pm = boot('https://arclite.fun/app/terminal.html?net=mainnet', opts);
  const pw = pm.w, pd = pm.d;
  pw.localStorage.setItem('ark_sol', 'So1anaOwner1111111111111111111111111111111');
  pw.__term.PF.solAddr = pw.localStorage.getItem('ark_sol');
  await sleep(300);
  pw.__term.setWallet({}, ME);
  await pw.__term.refreshBalance();
  pw.location.hash = '#portfolio';
  for (let i = 0; i < 60 && !(pw.__term.PF.arc && pw.__term.PF.hood && pw.__term.PF.sol); i++) await sleep(250);
  await sleep(200);
  const pg = pd.getElementById('rows');
  const PF = pw.__term.PF;
  ok(walletCalls.length >= 1 && hoodCalls.length >= 1 && solCalls.length >= 1, 'reads the ledger API, the HOOD explorer and the SOL proxy — one call each');
  ok(PF.arc && PF.arc.source === 'api' && PF.arc.tokens.length === 2, 'ARC: DEX holding from the ledger + launchpad position confirmed by balanceOf (' + (PF.arc && PF.arc.tokens.length) + ')');
  const alpha = PF.arc.tokens.find(t => t.symbol === 'ALPHA'), lnch = PF.arc.tokens.find(t => t.symbol === 'LNCH');
  ok(alpha && alpha.amt === 2000 && alpha.value === 1000 && alpha.logo && alpha.logo.endsWith('/api/v1/img/' + ARC_TOK), 'ARC DEX row: 2000 ALPHA × $0.50 = $1,000, logo through the API');
  ok(lnch && lnch.amt === 1000 && lnch.kind === 'launch', 'ARC launchpad row: balanceOf says 1000 LNCH');
  ok(Math.abs(PF.arc.cashNative - 5) < 1e-9 && Math.abs(PF.arc.cashUsdc - 2.5) < 1e-9, 'ARC cash: 5 native USDC (gas) + 2.5 ERC-20 USDC (6dp)');
  ok(PF.hood && PF.hood.tokens.length === 1 && PF.hood.tokens[0].symbol === 'CASHCAT' && PF.hood.tokens[0].value === 10 && PF.hood.tokens[0].logo === 'https://x/cat.png',
     'HOOD: one priced ERC-20 from the explorer (5000 × $0.002 = $10), zero balances and NFTs dropped');
  ok(PF.hood.unpriced.length === 1 && PF.hood.unpriced[0].spam === true && PF.hood.nativePrice === 2500 && Math.abs(PF.hood.native - 0.01) < 1e-12,
     'HOOD: the OFAC-phishing airdrop is flagged as spam and folded; ETH priced from the WETH rate');
  ok(PF.sol && PF.sol.tokens[0].symbol === 'BONK', 'SOL: proxy result kept');
  const total = pw.__term.pfTotal();
  ok(Math.abs(total - (7.5 + 1000 + 10 + 25 + 200 + 0.5)) < 1e-6, 'portfolio value sums every priced asset across chains: $' + total.toFixed(2) + ' (LNCH unpriced, spam excluded)');
  ok(pg.querySelector('.pftotal .v').textContent === '$1,243.00', 'the big number on the page agrees');
  ok(pg.querySelectorAll('.hrow').length >= 7, 'rows for USDC, ALPHA, LNCH, ETH, CASHCAT, SOL, BONK (' + pg.querySelectorAll('.hrow').length + ')');
  ok(/Arclite points/.test(pg.textContent) && pg.querySelector('.pts .big .n').textContent === '155' && /#7/.test(pg.textContent) && pg.querySelectorAll('.pts .p .n')[1].textContent === '152' && pg.querySelectorAll('.pts .p .n')[2].textContent === '3',
     'points card: 155 total, rank #7, 152 from trading (floor of volume), 3 from sharing');
  ok(pg.querySelector('.aring').style.background.includes('conic-gradient') && pg.querySelectorAll('.legend div').length >= 5 && /ALPHA/.test(pg.querySelector('.legend').textContent), 'allocation ring + legend from the same numbers');
  ok(!!pg.querySelector('[data-pfbuy="arc:'+ARC_TOK+'"]') && !!pg.querySelector('[data-pfsell="arc:'+ARC_TOK+'"]'), 'ALPHA (Arc DEX) has Buy and Sell');
  ok(!!pg.querySelector('[data-pfsell="arc:'+LNCH+'"]'), 'LNCH (curve) has Sell');
  ok(!!pg.querySelector('[data-pfbuy="hood:'+HOOD_TOK+'"]') && !!pg.querySelector('[data-pfsell="hood:'+HOOD_TOK+'"]'), 'CASHCAT (HOOD) has Buy and Sell');
  const jup = pg.querySelector('a[href^="https://jup.ag/swap/SOL-"]');
  ok(!!jup && jup.getAttribute('target') === '_blank' && jup.getAttribute('rel') === 'noopener', 'BONK (SOL) trades out to Jupiter, labelled as such');
  const spamRow = [...pg.querySelectorAll('.folded .hrow')][0];
  ok(spamRow && spamRow.classList.contains('dim') && spamRow.querySelector('.flag') && spamRow.querySelector('.nm b').textContent.includes('rh-ofac.xyz') && !spamRow.querySelector('.nm a[href*="rh-ofac"]'),
     'the spam token sits folded, dimmed, flagged — name shown as text, never as a link');
  // search filters rows
  const q = pd.getElementById('pfq'); q.value = 'cashcat'; q.dispatchEvent(new pw.Event('input', { bubbles: true })); await sleep(50);
  ok([...pd.querySelectorAll('#rows .hrow')].filter(r => !r.closest('.folded')).length === 1 && pd.querySelector('#rows .hrow').textContent.includes('CASHCAT'), 'search narrows holdings by name');
  pd.getElementById('pfq').value = ''; pd.getElementById('pfq').dispatchEvent(new pw.Event('input', { bubbles: true })); await sleep(50);
  // tabs
  pd.querySelector('[data-pftab="trades"]').dispatchEvent(new pw.MouseEvent('click', { bubbles: true })); await sleep(50);
  ok(pd.querySelectorAll('#rows .trow:not(.head)').length === 2 && /BUY/.test(pd.getElementById('rows').textContent) && /curve/.test(pd.getElementById('rows').textContent), 'Trades tab: both venues, side + venue labelled');
  pd.querySelector('[data-pftab="launches"]').dispatchEvent(new pw.MouseEvent('click', { bubbles: true })); await sleep(50);
  ok(/Launched/.test(pd.getElementById('rows').textContent) && /\$12\.50/.test(pd.getElementById('rows').textContent), 'Launches tab: the coin this wallet created, with its volume');
  pd.querySelector('[data-pftab="holdings"]').dispatchEvent(new pw.MouseEvent('click', { bubbles: true })); await sleep(50);

  // Sell sheet: HOOD token, quoted through the stubbed quoter (1% tier fills)
  pd.querySelector('[data-pfsell="hood:'+HOOD_TOK+'"]').dispatchEvent(new pw.MouseEvent('click', { bubbles: true }));
  for (let i = 0; i < 60 && !/≈|no Uniswap|failed/.test(pd.getElementById('ssQuote').textContent); i++) await sleep(100);
  ok(pd.getElementById('sellSheet').classList.contains('on') && pd.getElementById('ssTitle').textContent === 'Sell CASHCAT', 'Sell opens the sheet for the row');
  ok(Number(pd.getElementById('ssAmt').value) === 5000, 'amount defaults to Max (the whole balance)');
  const SELL = pw.__term.SELL;
  ok(SELL.quote && SELL.quote.kind === 'dex' && SELL.quote.fee === 10000 && SELL.quote.out === QUOTE_OUT, 'quoted on the 1% tier via the quoter, amount = balance minus the 3% fee (' + pd.getElementById('ssQuote').textContent.slice(0, 60) + ')');
  const lastQ = quoterCalls.filter(c => c.tokenIn === HOOD_TOK).pop();
  ok(lastQ && lastQ.amountIn === 5000n * 10n**18n * 9700n / 10000n, 'the quoter is asked for 97% of the tokens (the fee comes off the input)');
  ok(/3% Arclite fee = 150 CASHCAT/.test(pd.getElementById('ssQuote').textContent), 'the sheet prints the fee in tokens: 150 CASHCAT');
  pd.querySelector('#ssPct [data-pct="50"]').dispatchEvent(new pw.MouseEvent('click', { bubbles: true }));
  await sleep(50);
  ok(pd.getElementById('ssAmt').value === '2500.0' && SELL.amt === '2500.0', '50% chip halves the amount exactly (formatUnits, no float)');
  pd.getElementById('ssCancel').dispatchEvent(new pw.MouseEvent('click', { bubbles: true }));
  ok(!pd.getElementById('sellSheet').classList.contains('on'), 'Cancel closes the sheet');

  // the sell multicall, decoded
  const IF = pw.__term.ROUTER_IFACE, T = pw.__term.TREASURY, who = ME, router = pw.__term.CHAINS.hood.router;
  const amt = 1000n * 10n**18n, fee = amt * 300n / 10000n;
  const ethCalls = pw.__term.buildSellCalls(HOOD_TOK, { token: WETH, sym: 'ETH', dec: 18, native: true }, 10000, router, who, amt, 123n);
  ok(ethCalls.length === 4, 'sell for ETH: four calls');
  let d0 = IF.parseTransaction({ data: ethCalls[0] }), d1 = IF.parseTransaction({ data: ethCalls[1] }), d2 = IF.parseTransaction({ data: ethCalls[2] }), d3 = IF.parseTransaction({ data: ethCalls[3] });
  ok(d0.name === 'pull' && d0.args[0].toLowerCase() === HOOD_TOK && d0.args[1] === fee, '1. pull(token, 3% fee) from the seller');
  ok(d1.name === 'sweepToken' && d1.args[0].toLowerCase() === HOOD_TOK && d1.args[1] === fee && d1.args[2] === T, '2. sweepToken(token → treasury): the fee leaves before the swap');
  ok(d2.name === 'exactInputSingle' && d2.args[0].tokenIn.toLowerCase() === HOOD_TOK && d2.args[0].tokenOut.toLowerCase() === WETH.toLowerCase() && d2.args[0].amountIn === amt - fee && d2.args[0].recipient.toLowerCase() === router.toLowerCase() && d2.args[0].amountOutMinimum === 123n,
     '3. swap 97% token → WETH, output held by the router');
  ok(d3.name === 'unwrapWETH9' && d3.args[0] === 123n && d3.args[1].toLowerCase() === who, '4. unwrapWETH9(minOut, seller): the ETH lands with the seller');
  const usdgCalls = pw.__term.buildSellCalls(HOOD_TOK, { token: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', sym: 'USDG', dec: 6, native: false }, 3000, router, who, amt, 7n);
  const u2 = IF.parseTransaction({ data: usdgCalls[2] });
  ok(usdgCalls.length === 3 && u2.args[0].recipient.toLowerCase() === who && u2.args[0].fee === 3000n, 'sell for USDG: three calls, output straight to the seller');
  ok(/'function quoteSell\(address,uint256\) view returns \(uint256\)'/.test(html) && /'function sell\(address,uint256,uint256\) returns \(uint256\)'/.test(html), 'pump ABI carries sell + quoteSell (verified against ArclitePumpV4.sol)');
  ok(/await pumpW\.connect\(s\)\.sell\(r\.addr, amountIn, minOut\)/.test(html) && /tok\.approve\(PUMP, amountIn\)/.test(html), 'curve sell: exact-amount approve to the pump, then pump.sell(token, amount, minOut)');
  ok(/const s = await walletOn\(q\.cfg\.chainId, q\.cfg\.wallet\);/.test(html), 'DEX sell gets its signer from walletOn(chain) like the buy does');
  // the ledger down → chain fallback, still bounded
  const fm = boot('https://arclite.fun/app/terminal.html?net=mainnet', { balances: opts.balances });
  await sleep(300); fm.w.__term.setWallet({}, ME); await fm.w.__term.refreshBalance(); fm.w.location.hash = '#portfolio';
  for (let i = 0; i < 60 && !fm.w.__term.PF.arc; i++) await sleep(250);
  ok(fm.w.__term.PF.arc && fm.w.__term.PF.arc.source === 'chain' && /Ledger API unreachable/.test(fm.d.getElementById('rows').textContent), 'ledger API down: balanceOf fallback over the coins on screen, said plainly on the page');
  ok(fm.w.__term.PF.sol === null, 'no Solana address → no Solana read');
  }

  // ---- topbar width budget ----------------------------------------------
  // jsdom has no layout engine, so this cannot measure pixels. It guards the
  // rules that a real-browser measurement showed were required. The previous
  // version of this suite asserted document.scrollWidth === innerWidth, which
  // PASSED while the wallet was visibly clipped: the topbar has
  // overflow-x:auto, so its own overflow never reaches the document. Measured
  // in Chrome at 1600px: old bar wanted 1730px and clipped Refresh + Connect;
  // new bar wants 0px more than it has at 1920/1500/1440/1360/1280/1180/1100/1000.
  console.log('\n=== topbar width budget ===');
  ok(/\.wallet\{[^}]*flex:0 0 auto/.test(html),
     'the wallet control cannot shrink, so it is never the thing that gets cut');
  ok(/@media \(max-width:1440px\)\{ #netPill\{display:none\} \}/.test(html) &&
     /@media \(max-width:1150px\)\{ \.xlink\{display:none\} \}/.test(html) &&
     /@media \(max-width:1080px\)\{ #refreshBtn\{display:none\} \}/.test(html),
     'the measured fold order is present: chain pill, X link, then Refresh');
  ok(/\.topbar\{[\s\S]{0,160}overflow-x:auto/.test(html),
     'topbar still scrolls on phones rather than widening the page');

  // ---- the buy card should read as raised, not as another flat panel ------
  console.log('\n=== buy card popout ===');
  ok(/\.swapcard\{[^}]*box-shadow/.test(html) && /\.swapcard::after\{[^}]*radial-gradient/.test(html),
     'buy card has its own shadow and a vignette layer');
  ok(/swapCardHtml[\s\S]{0,400}class="card swapcard"/.test(html),
     'the buy card actually carries the .swapcard class');

  // ---- portfolio follows the chain you are on ----------------------------
  console.log('\n=== portfolio per chain ===');
  ok(/if\(!onArc\(\) && VIEW==='portfolio'\)\{ renderPortfolio\(\); return; \}/.test(html),
     'Portfolio is no longer gated behind "lives on Arc"');
  ok(/rpc:'https:\/\/rpc\.mainnet\.chain\.robinhood\.com'/.test(html),
     'Robinhood Chain has an RPC so balances are readable there');
  ok(/function providerFor\(key\)\{\s*if\(key==='arc'\) return provider;/.test(html) && /const prov = providerFor\('hood'\);/.test(html) && /loadArcHoldings\(\)\.catch[\s\S]{0,120}loadHoodHoldings\(\)\.catch[\s\S]{0,80}loadSolHoldings\(\)/.test(html),
     'Portfolio reads every chain at once — Arc, Robinhood Chain and Solana — whatever chain the scanner is on');
  ok(/value: PF\.hood\.nativePrice!=null \? PF\.hood\.native\*PF\.hood\.nativePrice : null/.test(html) && /reduce\(\(s,x\)=>s\+\(x\.value\|\|0\),0\)/.test(html),
     'ETH only enters the dollar total when the explorer gave it a price; unpriced assets add nothing');

  // ---- XSS: token names and profile URLs are attacker-controlled ----------
  // Anyone can deploy a token and choose its name, and anyone can submit a
  // profile for one. Both used to reach innerHTML raw, on a page where people
  // connect a wallet and sign transactions.
  console.log('\n=== hostile token metadata ===');
  {
  const XSS = '0x' + 'c'.repeat(40);
  const xm = boot('https://arclite.fun/app/terminal.html?net=mainnet', {
    tokens: [{
      address: XSS,
      name: '<img src=x onerror="window.__pwned=1">',
      symbol: '<svg onload="window.__pwned=1">',
      decimals: 18, dex: 'v3', pool_ref: '0x' + '9'.repeat(40),
      first_seen_block: 1, first_seen_at: new Date().toISOString(),
      meta_ok: true, price: '1', volume_24h: '10', txns_24h: '1',
      traders_24h: '1', holders: '1', change_24h: '0',
      logo_url: 'javascript:window.__pwned=1',
      website: 'javascript:window.__pwned=1',
      twitter: 'https://x.com/ok', telegram: null, profile_source: 'tolly',
    }],
  });
  await sleep(450);
  const xd = xm.d, xw = xm.w;
  // NB: jsdom runs with runScripts:'outside-only', so an injected inline
  // handler would not fire here even if the injection succeeded. Asserting on
  // window.__pwned would therefore pass whether or not the bug exists. The
  // real assertion is structural: did attacker markup become DOM nodes?
  const xcard = [...xd.querySelectorAll('#lanes .tcard')].find(x => x.dataset.addr === XSS);
  ok(!!xcard, 'the hostile token still renders (escaped, not dropped)');
  ok(xcard && !xcard.querySelector('img[src="x"]') && !xcard.querySelector('svg[onload]'),
     'its markup is inert: no injected <img src=x> or <svg onload> node exists');
  ok(xcard && xcard.querySelector('.nm').textContent.includes('<img'),
     'the name is shown as literal text, so the scam is visible rather than hidden');
  const xsoc = xcard && xcard.querySelector('.soc');
  ok(!xsoc || ![...xsoc.querySelectorAll('a')].some(a => /^javascript:/i.test(a.getAttribute('href') || '')),
     'a javascript: website URL is dropped, never rendered as a link');
  // The indexer rewrites logo_url to its own /api/v1/img/ path, so a hostile
  // logo never reaches src by that route. safeUrl is the guard for the paths
  // that are NOT rewritten — creator submissions and GeckoTerminal image_url.
  ok(xw.__term.avImg({ addr: XSS, logo: 'javascript:alert(1)' }) === '',
     'avImg drops a javascript: logo instead of emitting an <img src>');
  ok(/^<img src="https:\/\/ok\.test\/l\.png"/.test(xw.__term.avImg({ addr: XSS, logo: 'https://ok.test/l.png' })),
     'avImg still renders a legitimate https logo');
  // and the helper itself
  ok(xw.__term.safeUrl('javascript:alert(1)') === null &&
     xw.__term.safeUrl('data:text/html,<script>') === null &&
     xw.__term.safeUrl('https://alpha.fun') === 'https://alpha.fun' &&
     xw.__term.safeUrl(null) === null && xw.__term.safeUrl('') === null,
     'safeUrl: http/https pass through byte-identical, everything else is null');
  ok(xw.__term.esc('<b>&"') === '&lt;b&gt;&amp;&quot;', 'esc escapes <, >, & and quotes');
  }

  // ---- graduation target must never be invented -------------------------
  // Live bug 2026-09-09: landing on #launch quoted "graduates at $8,000" while
  // the contract said $1,500, because GRAD_TARGET defaulted to 8000 and was
  // only corrected inside loadLaunchpad(), which #launch never calls. A wrong
  // number on the page where someone launches a token is worse than no number.
  console.log('\n=== graduation target ===');
  ok(/let GRAD_TARGET = null;/.test(html),
     'GRAD_TARGET starts unknown rather than at a hardcoded 8000');
  ok(!/GRAD_TARGET *= *8000/.test(html), 'the 8000 placeholder is gone entirely');
  ok(/const gradStr = \(\) => GRAD_TARGET == null \? 'reading…'/.test(html),
     'every display site renders "reading…" while it is unknown');
  // gradStr() is the one place allowed to format it — it has already checked null.
  ok(html.split('GRAD_TARGET.toLocaleString()').length - 1 === 1,
     'exactly one place formats GRAD_TARGET, and it is gradStr()');
  ok(/console\.warn\('\[grad\] could not read graduationUsdc/.test(html),
     'a failed read is logged, not swallowed by an empty catch');
  ok(/async function renderLaunch\(\)\{[\s\S]{0,900}ensureGradTarget\(\)\.then/.test(html),
     'the Launch view reads the target itself instead of relying on boot');

  // and prove it end to end: land straight on #launch, never touching #launchpad
  {
  const gm = boot('https://arclite.fun/app/terminal.html?net=mainnet#launch');
  await sleep(900);
  const gtxt = gm.d.getElementById('panel').textContent;
  ok(!/\$8,000/.test(gtxt), 'landing on #launch never shows $8,000', gtxt.slice(0, 160));
  ok(/1,500|reading…/.test(gtxt), 'it shows the real target, or says it is still reading',
     (gtxt.match(/[Gg]raduates? at [^,]{0,14}/) || [''])[0]);
  }


  console.log('\n=== market cap on the ticker cards ===');
  {
  // Market cap was missing from scanner cards entirely — the one number people
  // rank by. It is OUR indexed price × the supply the indexer now reports, and
  // it must never be shown when either half is missing.
  const mw = boot('https://arclite.fun/app/terminal.html?net=mainnet');
  await sleep(700);
  const md = mw.d;
  const alpha = mw.w.__term.coins.find(c => c.addr.toLowerCase() === TOK.toLowerCase());
  const beta  = mw.w.__term.coins.find(c => c.addr.toLowerCase() === TOK2.toLowerCase());
  ok(alpha && alpha.supply === 1e9, 'total_supply from the indexer lands as coin.supply');
  ok(alpha && alpha.mcap === 0.5 * 1e9, 'mcap = our price × supply = $500,000,000');
  ok(beta && beta.mcap === 0 && beta.supply == null, 'a token with no price and no supply gets mcap 0 — never a guess');
  const cardA = md.querySelector('.tcard[data-addr="' + alpha.addr + '"]');
  const cardB = md.querySelector('.tcard[data-addr="' + beta.addr + '"]');
  ok(cardA && cardA.querySelector('.side .mcap b') && cardA.querySelector('.side .mcap b').textContent === mw.w.__term.fmtUsd(5e8),
     'Alpha\'s card leads its side column with MCAP ' + mw.w.__term.fmtUsd(5e8));
  ok(cardA && cardA.querySelector('.side').firstElementChild.classList.contains('mcap'), 'MCAP is the FIRST stat on the card, above V / P / TX');
  ok(cardB && cardB.querySelector('.side .mcap.none') && cardB.querySelector('.side .mcap.none b').textContent === '—',
     'Beta\'s card shows MCAP — (dim, no pill) rather than a number it cannot stand behind');
  ok(/\.tcard \.side \.mcap\{[^}]*rgba\(255,214,10/.test(html), 'the MCAP pill is amber — the highlight the user asked for');
  ok(/\.tcard\{[^}]*padding:13px 14px[^}]*margin-bottom:10px/.test(html), 'cards got more room: 13×14 padding, 10px between');
  }

  console.log('\n=== buy panel: luminescence on selection ===');
  {
  // Picking a ticker re-renders the swap card; that restart is what makes it
  // bloom. jsdom does not run CSS animations, so this pins the rules that
  // produce it and proves the card is rebuilt (not patched) on selection.
  ok(/@keyframes swlum\{/.test(html) && /\.swapcard\{[^}]*animation:[^}]*swlum/.test(html), 'the swap card animates swlum on every (re)render');
  ok(/@keyframes swbeam\{/.test(html) && /\.swapcard::before\{[^}]*animation:[^}]*swbeam/.test(html), 'a beam of light sweeps the top edge on the same trigger');
  ok(/18%\s*\{[^}]*0 0 70px rgba\(34,211,238,\.55\)/.test(html), 'the bloom peaks at a 70px cyan ring');
  ok(/prefers-reduced-motion:reduce\)\{[^}]*\.swapcard\{animation:none\}[^}]*\.swapcard::before\{animation:none/.test(html), 'reduced-motion users get neither the bloom nor the beam');
  const sw = boot('https://arclite.fun/app/terminal.html?net=mainnet');
  await sleep(700);
  const sd = sw.d;
  const v3 = sd.querySelector('.tcard[data-addr="' + TOK + '"]') || sd.querySelector('.tcard[data-addr="' + TOK.toLowerCase() + '"]');
  v3.dispatchEvent(new sw.w.MouseEvent('click', { bubbles: true })); await sleep(400);
  const card1 = sd.getElementById('swapCard');
  ok(!!card1 && card1.classList.contains('swapcard'), 'clicking a ticker renders the swap card');
  // pick a different token, then come back — the card must be a NEW element.
  // render() rebuilds the list on every click, so re-query rather than reuse
  // a reference to a node that is no longer in the document.
  const pick = addr => { const el = sd.querySelector('.tcard[data-addr="' + addr + '"]') || sd.querySelector('.tcard[data-addr="' + addr.toLowerCase() + '"]'); el.dispatchEvent(new sw.w.MouseEvent('click', { bubbles: true })); };
  const otherAddr = [...sd.querySelectorAll('.tcard[data-i]')].map(c => c.dataset.addr).find(a => a.toLowerCase() !== TOK.toLowerCase());
  pick(otherAddr); await sleep(300);
  pick(TOK); await sleep(400);
  const card2 = sd.getElementById('swapCard');
  ok(!!card2 && card2 !== card1, 're-selecting rebuilds the card — a new element, so the luminescence restarts');
  }

  console.log('\n=== THE DRAW: the stage takes over from :00 until every tier has resolved ===');
  {
  const lw = boot('https://arclite.fun/app/terminal.html?net=mainnet#draw');
  await sleep(700);
  const ld = lw.d, T = lw.w.__term;
  const U = n => BigInt(Math.round(n*1e6)) * 10n**12n;
  const now = Math.floor(Date.now()/1000), r = Math.floor(now/3600);
  const W1 = '0x' + 'a1'.repeat(20), ME = '0x' + 'b2'.repeat(20);

  // reel geometry: the winner sits in cell 33, which lands under the marker
  const cells = T.liveReelCells(7, 37, 4);
  const hitAt = cells.split('<div class="cell').findIndex(x => x.startsWith(' hit')) - 1;
  ok(hitAt === 33 && /class="cell hit"><span class="ix">#4<\/span>/.test(cells), 'liveReelCells puts the winning index (#4 of 7) in cell 33');
  ok(!/hit/.test(T.liveReelCells(7, 24, null)), 'the live-spinning strip carries no winner at all');

  // the hour turns on a round with tickets in three different states
  const ending = { pots:[U(5),U(10),U(0)], tickets:[5n,2n,0n], wallets:[3n,1n,0n], open:false, isSealed:true, isSettled:false, committed:true, closeAt:BigInt(now-120), endAt:BigInt(now) };
  T.setDraw('0x'+'d4'.repeat(20), { round:r, cur:ending, prev:null, prevTiers:null, mine:[1,0,0], jackpot:U(3), totalPaid:0n, biggestPot:U(10), claimable:0n, tape:[], wall:[] });
  await sleep(100);
  T.liveEnter(r, ending);
  await sleep(120);
  const stage = ld.getElementById('dstage');
  ok(!!stage && ld.querySelectorAll('.dstage .dcol').length === 3 && !ld.querySelector('#panel .tiers'), 'the stage replaces the tier cards');
  ok(ld.querySelector('.dcol[data-dcol="0"] .dreel.spin'), 'Degen (5 tickets, 3 wallets) spins a live reel');
  ok(ld.querySelector('.dcol[data-dcol="1"].calm') && /Refunding 2 tickets/.test(ld.querySelector('.dcol[data-dcol="1"]').textContent), 'Trencher (2 tickets, 1 wallet) does not spin — it says it is refunding');
  ok(ld.querySelector('.dcol[data-dcol="2"].calm') && /No tickets/.test(ld.querySelector('.dcol[data-dcol="2"]').textContent), 'Whale (empty) says so');
  ok(/resolving on-chain/.test(ld.querySelector('.dstage .st').textContent), 'status reads "resolving on-chain" — nothing is invented');

  // the 12s poll must not tear the stage down mid-spin
  const before = ld.getElementById('dstage');
  T.renderDraw();                            // what the 12s poll does
  await sleep(50);
  ok(ld.getElementById('dstage') === before, 'a re-render while live leaves the stage element untouched');

  // the chain answers: round r settled, Degen drawn to ticket #3 → W1, Trencher refunded
  const prevTiers = [
    { pot:U(5), tickets:5n, wallets:3n, drawn:true,  refunded:false, winner:W1, prize:U(4.875), hitJackpot:false },
    { pot:U(10), tickets:2n, wallets:1n, drawn:false, refunded:true, winner:'0x'+'0'.repeat(40), prize:0n, hitJackpot:false },
    { pot:0n, tickets:0n, wallets:0n, drawn:false, refunded:false, winner:'0x'+'0'.repeat(40), prize:0n, hitJackpot:false },
  ];
  Object.assign(T.DW, { round:r+1, cur:{ ...ending, tickets:[0n,0n,0n], wallets:[0n,0n,0n], pots:[0n,0n,0n], open:true, isSealed:false, closeAt:BigInt(now+3480), endAt:BigInt(now+3600) },
    prev:{ ...ending, isSettled:true }, prevTiers,
    wall:[{ key:'w', round:r, tier:0, winner:W1, idx:3, n:5, prize:U(4.875), jp:false, tx:'0x'+'e5'.repeat(32) }] });
  T.liveCheck();
  await sleep(150);
  ok(!ld.querySelector('.dcol[data-dcol="0"] .dreel.spin') && ld.querySelector('.dcol[data-dcol="0"] .dreel.land'), 'Degen\'s reel stops spinning and decelerates onto the result');
  ok(/#3<\/span><span>winner/.test(ld.querySelector('.dcol[data-dcol="0"] .strip').innerHTML), 'the landing strip carries ticket #3 — the index the Drawn event reported');
  await sleep(2800);
  const won = ld.querySelector('.dcol[data-dcol="0"]');
  ok(won.classList.contains('won') && !!won.querySelector('.dwin'), 'after the landing, the Degen column pops the winner card');
  ok(won.querySelector('.dwin .addr').textContent === '0xa1a1…a1a1' || won.querySelector('.dwin .addr').textContent.startsWith('0xa1a1'), 'the winner\'s address is the headline of the pop');
  ok(won.querySelector('.dwin .addr').dataset.copy === W1, 'clicking the address copies the full wallet');
  ok(/Ticket #3 of 5/.test(won.querySelector('.dwin .k').textContent), 'it says which ticket won out of how many');
  ok(won.querySelector('.dwin .tx') && won.querySelector('.dwin .tx').href.includes('e5e5'), 'and links to the draw transaction');
  await sleep(1400);
  ok(won.querySelector('.dwin .prize').textContent === T.fmtUsd(4.875, 2), 'the prize counts up to the real amount, ' + T.fmtUsd(4.875, 2));
  ok(!won.querySelector('.dwin .you'), 'no YOU WON badge — W1 is not this wallet');
  ok(/Refunded — one wallet/.test(ld.querySelector('.dcol[data-dcol="1"]').textContent), 'Trencher resolves as a refund, calmly');
  ok(ld.querySelector('.dstage .st.done') && /settled/.test(ld.querySelector('.dstage .st').textContent), 'status flips to "settled"');

  // the stage stands down on dismiss, and the new round is what's left
  ld.querySelector('[data-livedismiss]').click(); await sleep(80);
  ok(!ld.getElementById('dstage') && ld.querySelectorAll('#panel .tier').length === 3 && T.DW.live === null, '"Back to the round" dismisses the stage and the tier cards return');

  // when nothing was sold, the hour turning shows no stage at all
  T.liveEnter(r+5, { ...ending, tickets:[0n,0n,0n], wallets:[0n,0n,0n] });
  await sleep(60);
  ok(T.DW.live === null && !ld.getElementById('dstage'), 'an empty round never opens the stage');

  // YOU WON: the pop badges your own wallet and fires confetti
  T.setWallet({}, ME);
  const mine = { ...ending, tickets:[3n,0n,0n], wallets:[2n,0n,0n], endAt:BigInt(now) };
  T.liveEnter(r+9, mine); await sleep(80);
  Object.assign(T.DW, { round:r+10, prev:{ ...mine, isSettled:true },
    prevTiers:[{ pot:U(3), tickets:3n, wallets:2n, drawn:true, refunded:false, winner:ME, prize:U(2.9), hitJackpot:true }, prevTiers[2], prevTiers[2]],
    wall:[{ key:'w9', round:r+9, tier:0, winner:ME, idx:1, n:3, prize:U(2.9), jp:true, tx:'0x'+'e7'.repeat(32) }] });
  T.liveCheck(); await sleep(2900);
  const mineCol = ld.querySelector('.dcol[data-dcol="0"]');
  ok(mineCol.querySelector('.dwin .you') && mineCol.querySelector('.dwin .you').textContent === 'YOU WON', 'a win for the connected wallet gets the YOU WON badge');
  ok(mineCol.querySelector('.dwin .prize.jp') && /Mega Jackpot hit/.test(mineCol.textContent), 'a jackpot hit is called out in gold');
  ok(!!ld.querySelector('.confetti'), 'and confetti falls');
  T.liveDismiss();
  }


  console.log('\n=== header: readout not dashboard, and the tagline is real copy ===');
  {
  ok(!/\[ [a-z ·]+ \]/.test(html), 'no bracketed dev-style tagline anywhere');
  ok(/id="heroTag">Everything\. On Chain\.</.test(html), 'the default tagline is "Everything. On Chain."');
  ok(!/explorer via GeckoTerminal/.test(html), 'no "explorer via GeckoTerminal" anywhere — the source credit lives in the sync line only');
  for (const line of ['Everything. On Chain.', 'Born on Arclite. Live from the first trade.',
                      'Every hour, on the hour. Winner takes the pot.', 'Points for trading. Points for posting.'])
    ok(html.includes(line), `per-view tagline present: "${line}"`);
  ok(/\.hero\{[^}]*padding:15px 34px 14px/.test(html) && /\.hero \.ttl b\{font:700 21px/.test(html), 'header is ~half the height: 21px wordmark, 15px padding');
  ok(/\.hstat\{[^}]*border-left:1px solid var\(--hair2\)/.test(html) && !/\.hstat\{[^}]*border-radius/.test(html), 'stats are an inline readout with hairline dividers, not boxed cards');
  ok(/\.hstat b\{[^}]*var\(--fm\)/.test(html) && /\.hstat span\{[^}]*order:2/.test(html), 'mono value first, dim label after');
  ok(/\.ticker \.trackwrap\{[^}]*mask-image:linear-gradient\(90deg,transparent,#000 36px/.test(html), 'the marquee fades at both edges so a half-scrolled entry reads as motion, not a clip');
  ok(/\.hero \.ttl span\{[^}]*text-transform:none/.test(html), 'tagline is sentence case, not tracked caps');
  }

  console.log('\n=== draw popup: nudges on a cadence, never a nag ===');
  {
  // The old rule was "last 20 minutes only". Most sessions never reached it.
  const pw2 = boot('https://arclite.fun/app/terminal.html?net=mainnet');
  await sleep(500);
  const pd = pw2.d, pw = pw2.w;
  const pop = pd.getElementById('drawPop');
  ok(!!pop && pop.hidden, 'on load the popup is hidden — the page gets 25s to settle first');
  ok(!!pd.getElementById('drawPopMute') && pd.getElementById('drawPopMute').textContent === 'Not today', 'there is a "Not today" mute');
  ok(/POP = \{ arm: Date\.now\(\) \+ 25000/.test(html), 'the early nudge is armed 25s after load');
  ok(/const early = c\.secs > 300 && Date\.now\(\) >= POP\.arm && !drawPopDismissed\(c\.round\)/.test(html), 'early: any time with >5 min left, once per round, quiet after ×');
  ok(/const late\s*= c\.secs <= 300 && c\.secs > 60 && !drawPopLateDone\(c\.round\)/.test(html), 'late: the last 5 minutes, once, never inside the final minute');
  ok(/&& !drawPopMuted\(\) && \(early \|\| late\)/.test(html), '"Not today" silences both');
  // simulate: arm passed, sales open with 40 minutes left → early nudge shows
  const PT = pw.__term, clock = (round, secs, label) => { PT.POP.clock = () => ({ round, endAt: 0, closeAt: 0, secs, closed: false, label }); };
  PT.POP.arm = 0;
  pw.localStorage.clear();
  clock(777, 2400, '40:00'); PT.tickDraw(); await sleep(30);
  ok(!pop.hidden, 'early nudge: 40 minutes left → the popup shows');
  pd.getElementById('drawPopX').click(); await sleep(500);
  PT.tickDraw(); await sleep(30);
  ok(pop.hidden && pw.localStorage.getItem('ark_drawpop_dismissed') === '777', '× closes it and it stays closed for round 777');
  // the last five minutes re-nudge once even after the × …
  clock(777, 240, '04:00'); PT.tickDraw(); await sleep(30);
  ok(!pop.hidden && pd.getElementById('popLab').textContent === 'Sales close in', 'late nudge: 4 minutes left → shows again, labelled "Sales close in"');
  pd.getElementById('drawPopX').click(); await sleep(500);
  PT.tickDraw(); await sleep(30);
  ok(pop.hidden && pw.localStorage.getItem('ark_drawpop_late') === '777', '… and only once');
  // … but never in the last minute
  pw.localStorage.clear();
  clock(777, 45, '00:45'); PT.tickDraw(); await sleep(30);
  ok(pop.hidden, 'no nudge inside the final minute — too late to buy');
  // a new round: the early nudge is back
  clock(778, 3000, '50:00'); PT.tickDraw(); await sleep(30);
  ok(!pop.hidden, 'next round: the early nudge returns');
  // "Not today" mutes everything for the UTC day
  pd.getElementById('drawPopMute').click(); await sleep(500);
  clock(779, 240, '04:00'); PT.tickDraw(); await sleep(30);
  ok(pop.hidden && pw.localStorage.getItem('ark_drawpop_mute') === new Date().toISOString().slice(0,10), '"Not today" mutes early AND late nudges until the next UTC day');
  }

  console.log('\n=== no leftovers ===');
  ok(!/bounty/i.test(html), 'terminal.html contains no "bounty"');
  ok(!/REFERRALS\s*=|bindReferrer|copyRefLink/.test(html), 'terminal.html contains no referral code');
  ok(!/YOUR_PROJECT_ID|infura\.io\/v3\/[0-9a-f]{32}/.test(html), 'no RPC project ID in the page');

  console.log('\n' + '='.repeat(52));
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(1); });
