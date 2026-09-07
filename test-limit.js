// ArcliteLimit tests — against the REAL ArclitePumpV4 in the in-process EVM.
// Proves the one property that matters: an order can only ever fill at its
// limit or better, enforced by the pump's own slippage check, with no oracle.
const { createVM } = require('@ethereumjs/vm');
const { Common, Mainnet, Hardfork } = require('@ethereumjs/common');
const { createAddressFromString, Account, hexToBytes, bytesToHex } = require('@ethereumjs/util');
const { ethers } = require('ethers');
const fs = require('fs');

const pumpB = JSON.parse(fs.readFileSync(__dirname + '/build-pump-v4.json'));
const limB  = JSON.parse(fs.readFileSync(__dirname + '/build-limit.json'));
const IP = new ethers.Interface(pumpB.abi), IL = new ethers.Interface(limB.abi);
const IT = new ethers.Interface(['function balanceOf(address) view returns (uint256)', 'function approve(address,uint256) returns (bool)']);
const A = n => createAddressFromString('0x' + n.toString(16).padStart(40, '0'));
const OWNER = A(0xA1), TREAS = A(0xA3), KEEPER = A(0xA5), P0 = A(0xB1), P1 = A(0xB2), P2 = A(0xB3);
const U = n => ethers.parseEther(String(n));
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  PASS ' + m)) : (fail++, console.log('  FAIL ' + m)); };

(async () => {
  const vm = await createVM({ common: new Common({ chain: Mainnet, hardfork: Hardfork.Paris }) });
  let TIME = 1_800_000_000n;
  const raw = vm.evm.runCall.bind(vm.evm);
  const run = o => raw({ ...o, block: { header: { timestamp: TIME, number: 1000n, difficulty: 0n, gasLimit: 30000000n, baseFeePerGas: 0n, coinbase: OWNER, prevRandao: new Uint8Array(32), getBlobGasPrice: () => 0n } } });
  const bal = async a => ((await vm.stateManager.getAccount(a)) || new Account()).balance;
  const fund = async (a, w) => { const acc = (await vm.stateManager.getAccount(a)) || new Account(); acc.balance = w; await vm.stateManager.putAccount(a, acc); };
  for (const a of [OWNER, KEEPER, P0, P1, P2]) await fund(a, U(1_000_000));
  const call = async (iface, to, from, fn, args = [], value = 0n) => {
    const r = await run({ caller: from, origin: from, to: typeof to === 'string' ? createAddressFromString(to) : to, gasLimit: 30_000_000n, data: hexToBytes(iface.encodeFunctionData(fn, args)), value });
    const err = r.execResult.exceptionError && r.execResult.exceptionError.error;
    let revert = null;
    if (err) {
      const ret = bytesToHex(r.execResult.returnValue);
      if (ret.startsWith('0x08c379a0')) { try { revert = 'Error(' + ethers.AbiCoder.defaultAbiCoder().decode(['string'], '0x' + ret.slice(10))[0] + ')'; } catch {} }
      if (!revert) { try { const p = IL.parseError(ret); revert = p ? p.name : null; } catch {} }
      if (!revert) { try { const p = IP.parseError(ret); revert = p ? p.name : null; } catch {} }
      if (!revert) revert = err;
    }
    const logs = (r.execResult.logs || []).map(l => { for (const i of [IL, IP]) { try { const p = i.parseLog({ topics: l[1].map(bytesToHex), data: bytesToHex(l[2]) }); if (p) return p; } catch {} } return null; }).filter(Boolean);
    return { err: revert, ret: bytesToHex(r.execResult.returnValue), logs };
  };
  const view = async (iface, to, fn, args = []) => { const r = await call(iface, to, OWNER, fn, args); if (r.err) throw new Error(fn + ' reverted: ' + r.err); return iface.decodeFunctionResult(fn, r.ret); };
  const deploy = async (b, iface, args) => { const r = await run({ caller: OWNER, origin: OWNER, gasLimit: 30_000_000n, data: hexToBytes(b + (args.length ? iface.encodeDeploy(args).slice(2) : '')), value: 0n }); return r.createdAddress; };

  console.log('\n=== deploy pump + token + limit book ===');
  const PUMP = await deploy(pumpB.bytecode, IP, [0n, U(2500), TREAS.toString()]);
  const ct = await call(IP, PUMP, P2, 'createToken', ['Limit Test', 'LIM'], 0n);
  const TOKEN = ethers.AbiCoder.defaultAbiCoder().decode(['address'], ct.ret)[0];
  const LIM = await deploy(limB.bytecode, IL, [PUMP.toString()]);
  ok(!!PUMP && !!TOKEN && !!LIM, 'pump, token and ArcliteLimit deployed');
  const spot = async () => (await view(IP, PUMP, 'spotPrice', [TOKEN]))[0];
  const s0 = await spot();
  ok(s0 > 0n, 'spot price = ' + ethers.formatEther(s0) + ' USDC/token');
  const tokBal = async a => (await view(IT, TOKEN, 'balanceOf', [a.toString()]))[0];

  console.log('\n=== buy limit ABOVE spot fills now, at or better than the limit ===');
  const exp = Number(TIME) + 3600;
  ok((await call(IL, LIM, P0, 'placeBuy', [TOKEN, s0 * 2n, exp], U(0.5))).err === 'BadAmount', '$0.50 order rejected (MIN_ORDER $1)');
  ok((await call(IL, LIM, P0, 'placeBuy', [TOKEN, s0 * 2n, Number(TIME)], U(10))).err === 'BadExpiry', 'expiry in the past rejected');
  let r = await call(IL, LIM, P0, 'placeBuy', [TOKEN, s0 * 2n, exp], U(10));
  ok(!r.err && r.logs[0].name === 'Placed' && r.logs[0].args.id === 0n, 'P0 places buy #0: $10 at limit 2× spot');
  ok((await bal(LIM)) === U(10), 'USDC is escrowed in the contract');
  const kb = await bal(KEEPER), p0t = await tokBal(P0);
  r = await call(IL, LIM, KEEPER, 'execute', [0]);
  ok(!r.err, 'keeper executes #0');
  const f = r.logs.find(l => l.name === 'Filled');
  const tip = U(10) * 30n / 10000n;
  ok(f.args.tip === tip && (await bal(KEEPER)) - kb === tip, 'executor tipped 0.3% ($0.03)');
  const got = (await tokBal(P0)) - p0t;
  ok(got === f.args.amountOut && got > 0n, 'P0 received the tokens (' + ethers.formatEther(got).slice(0, 12) + ')');
  const avg = (U(10) - tip) * 10n ** 18n / got;
  ok(avg <= s0 * 2n, 'average fill price ' + ethers.formatEther(avg) + ' ≤ limit ' + ethers.formatEther(s0 * 2n));
  ok((await bal(LIM)) === 0n, 'nothing left in escrow');
  ok((await call(IL, LIM, KEEPER, 'execute', [0])).err === 'NotOpen', 'cannot execute a filled order twice');
  ok((await view(IL, LIM, 'orders', [0])).status === 1n, 'order status = filled');

  console.log('\n=== buy limit BELOW spot cannot fill — the pump\'s own slippage check refuses ===');
  const s1 = await spot();
  r = await call(IL, LIM, P0, 'placeBuy', [TOKEN, s1 / 2n, exp], U(10));
  ok(!r.err && r.logs[0].args.id === 1n, 'P0 places buy #1 at half of spot');
  const ex = await call(IL, LIM, KEEPER, 'execute', [1]);
  ok(ex.err === 'Error(slippage)', 'execute reverts with the pump\'s "slippage" — no fill worse than the limit is possible (' + ex.err + ')');
  ok((await bal(LIM)) === U(10) && (await view(IL, LIM, 'orders', [1])).status === 0n, 'escrow intact, order still open');
  ok((await call(IL, LIM, P1, 'cancel', [1])).err === 'NotOwner', 'a stranger cannot cancel an unexpired order');
  const p0b = await bal(P0);
  ok(!(await call(IL, LIM, P0, 'cancel', [1])).err && (await bal(P0)) - p0b === U(10), 'owner cancels, gets the $10 back');

  console.log('\n=== sell limit: escrow tokens, fill only at ≥ limit ===');
  ok(!(await call(IP, PUMP, P1, 'buy', [TOKEN, 0], U(200))).err, 'P1 buys $200 on the curve (price moves up)');
  const p1tok = await tokBal(P1);
  const half = p1tok / 2n;
  const s2 = await spot();
  ok(!(await call(IT, TOKEN, P1, 'approve', [LIM.toString(), p1tok])).err, 'P1 approves the limit book');
  r = await call(IL, LIM, P1, 'placeSell', [TOKEN, half, s2 * 2n, exp]);
  ok(!r.err && r.logs.some(l => l.name === 'Placed' && l.args.isBuy === false), 'P1 places sell #2: half his tokens at 2× spot');
  ok((await tokBal(LIM)) === half && (await tokBal(P1)) === p1tok - half, 'tokens escrowed');
  ok((await call(IL, LIM, KEEPER, 'execute', [2])).err === 'Error(slippage)', 'sell above market cannot fill');
  r = await call(IL, LIM, P1, 'placeSell', [TOKEN, half, s2 * 9n / 10n, exp]);
  ok(!r.err && r.logs.find(l => l.name === 'Placed').args.id === 3n, 'P1 places sell #3 at 0.9× spot');
  const p1b = await bal(P1), kb2 = await bal(KEEPER);
  r = await call(IL, LIM, KEEPER, 'execute', [3]);
  ok(!r.err, 'keeper fills the sell');
  const f3 = r.logs.find(l => l.name === 'Filled');
  const usdcOut = f3.args.amountOut, tip3 = usdcOut * 30n / 10000n;
  ok((await bal(P1)) - p1b === usdcOut - tip3 && (await bal(KEEPER)) - kb2 === tip3, 'P1 got the USDC minus 0.3%, keeper got the tip');
  ok(usdcOut * 10n ** 18n / half >= s2 * 9n / 10n, 'average sell price ≥ limit');
  ok((await bal(LIM)) === 0n, 'no USDC stuck in the book after a sell');

  console.log('\n=== expiry: anyone can return the escrow ===');
  ok((await call(IL, LIM, KEEPER, 'cancel', [2])).err === 'NotOwner', 'before expiry only the owner may cancel #2');
  TIME += 3601n;
  ok((await call(IL, LIM, KEEPER, 'execute', [2])).err === 'NotExpired', 'expired order cannot be executed');
  const p1t2 = await tokBal(P1);
  ok(!(await call(IL, LIM, KEEPER, 'cancel', [2])).err && (await tokBal(P1)) - p1t2 === half, 'after expiry anyone cancels; tokens go back to the OWNER, not the caller');

  console.log('\n=== views ===');
  const mine = (await view(IL, LIM, 'ordersOf', [P1.toString()]))[0];
  ok(mine.length === 2 && mine[0] === 2n && mine[1] === 3n, 'ordersOf(P1) = [2, 3]');
  const pg = (await view(IL, LIM, 'page', [0, 10]))[0];
  ok(pg.length === 4 && pg[0].owner.toLowerCase() === P0.toString().toLowerCase() && pg[3].status === 1n, 'page(0,10) returns all 4 orders with status');
  ok((await view(IL, LIM, 'count'))[0] === 4n, 'count = 4');

  console.log('\n' + '='.repeat(52));
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(1); });
