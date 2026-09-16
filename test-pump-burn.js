// ArclitePumpV4 — graduation burns the curve supply nobody bought (task #59).
// In-process EVM, real contract, real arithmetic. Proves the burn happens, that
// it fixes the market-cap overstatement, that it takes nothing that was owed to
// anyone, and that nobody can burn a balance that isn't theirs.
const { createVM } = require('@ethereumjs/vm');
const { Common, Mainnet, Hardfork } = require('@ethereumjs/common');
const { createAddressFromString, Account, hexToBytes, bytesToHex } = require('@ethereumjs/util');
const { ethers } = require('ethers');
const fs = require('fs');

const build = JSON.parse(fs.readFileSync(__dirname + '/build-pump-v5.json'));
const IPUMP = new ethers.Interface(build.ArclitePumpV4.abi);
const ITOK  = new ethers.Interface(build.ArcliteToken.abi);
const A = n => createAddressFromString('0x' + n.toString(16).padStart(40, '0'));
const OWNER = A(0xA1), TREAS = A(0xA2), LPV = A(0xA3), CREATOR = A(0xB1);
const BUYERS = [A(0xC1), A(0xC2), A(0xC3), A(0xC4), A(0xC5), A(0xC6)];
const U = n => BigInt(Math.round(Number(n) * 1e6)) * 10n ** 12n;   // USDC, 18dp
const E18 = 10n ** 18n;
const whole = v => Number(v / E18);
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  PASS ' + m)) : (fail++, console.log('  FAIL ' + m)); };

(async () => {
  let TIME = 1_800_000_000n, BLOCK = 1000n;
  const blockchain = { getBlock: async n => ({ hash: () => new Uint8Array(32), header: { number: BigInt(n) } }), shallowCopy(){return this;},
    getIteratorHead: async()=>null, getCanonicalHeadBlock: async()=>null, putBlock: async()=>{}, validateHeader: async()=>{}, consensus:{}, getTotalDifficulty: async()=>0n, events:{on(){}} };
  const vm = await createVM({ common: new Common({ chain: Mainnet, hardfork: Hardfork.Paris }), blockchain });
  const raw = vm.evm.runCall.bind(vm.evm);
  const run = o => raw({ ...o, block: { header: { timestamp: TIME, number: BLOCK, difficulty: 0n, gasLimit: 30000000n,
    baseFeePerGas: 0n, coinbase: OWNER, prevRandao: new Uint8Array(32), getBlobGasPrice: () => 0n } } });
  const fund = async (a, w) => { const acc = (await vm.stateManager.getAccount(a)) || new Account(); acc.balance = w; await vm.stateManager.putAccount(a, acc); };
  for (const a of [OWNER, CREATOR, ...BUYERS]) await fund(a, U(10_000_000));

  const call = async (to, from, I, fn, args = [], value = 0n) => {
    const r = await run({ caller: from, origin: from, to: typeof to === 'string' ? createAddressFromString(to) : to,
      gasLimit: 30_000_000n, data: hexToBytes(I.encodeFunctionData(fn, args)), value });
    const e = r.execResult.exceptionError && r.execResult.exceptionError.error;
    let revert = null;
    if (e) { try { const p = I.parseError(bytesToHex(r.execResult.returnValue)); revert = p ? p.name : e; } catch { revert = e; } }
    const logs = (r.execResult.logs || []).map(l => { for (const ii of [IPUMP, ITOK]) { try { const q = ii.parseLog({ topics: l[1].map(bytesToHex), data: bytesToHex(l[2]) }); if (q) return q; } catch {} } return null; }).filter(Boolean);
    return { err: revert, ret: bytesToHex(r.execResult.returnValue), logs };
  };
  const view = async (to, I, fn, args = []) => { const r = await call(to, OWNER, I, fn, args); if (r.err) throw new Error(fn + ' reverted: ' + r.err); return I.decodeFunctionResult(fn, r.ret); };

  console.log('\n=== deploy: fee 0, graduation $1,500 (live mainnet settings) ===');
  const dep = await run({ caller: OWNER, origin: OWNER, gasLimit: 30_000_000n,
    data: hexToBytes(build.ArclitePumpV4.bytecode + IPUMP.encodeDeploy([0n, U(1500), TREAS.toString()]).slice(2)), value: 0n });
  const PAD = dep.createdAddress;
  ok(!!PAD, 'pad deploys');
  ok(!(await call(PAD, OWNER, IPUMP, 'setLpVault', [LPV.toString()])).err, 'lpVault set');

  const TOTAL = (await view(PAD, IPUMP, 'TOTAL_SUPPLY'))[0];
  const CURVE = (await view(PAD, IPUMP, 'CURVE_SUPPLY'))[0];
  const LPRES = (await view(PAD, IPUMP, 'LP_RESERVE'))[0];
  const CALLOC = (await view(PAD, IPUMP, 'CREATOR_ALLOC'))[0];
  console.log(`  TOTAL ${whole(TOTAL).toLocaleString()} · CURVE ${whole(CURVE).toLocaleString()} · LP ${whole(LPRES).toLocaleString()} · CREATOR ${whole(CALLOC).toLocaleString()}`);

  console.log('\n=== launch + buy to graduation ===');
  const cr = await call(PAD, CREATOR, IPUMP, 'createToken', ['Burn Test', 'BURN']);
  ok(!cr.err, 'createToken: ' + (cr.err || 'ok'));
  const TOKEN = IPUMP.decodeFunctionResult('createToken', cr.ret)[0];
  ok((await view(TOKEN, ITOK, 'totalSupply'))[0] === TOTAL, 'token starts at the full 1B supply');

  let graduated = false, burnLog = null;
  for (const b of BUYERS) {
    const r = await call(PAD, b, IPUMP, 'buy', [TOKEN, 0n], U(300));
    if (r.err) { console.log('  buy reverted:', r.err); break; }
    const g = r.logs.find(l => l.name === 'Graduated');
    const s = r.logs.find(l => l.name === 'SupplyBurned');
    if (g) { graduated = true; burnLog = s; break; }
  }
  ok(graduated, 'curve graduates at $1,500 raised');
  ok(!!burnLog, 'SupplyBurned fires in the same transaction as Graduated');

  const c = await view(PAD, IPUMP, 'curves', [TOKEN]);
  const sold = c[4];
  const supplyAfter = (await view(TOKEN, ITOK, 'totalSupply'))[0];
  const padHolds = (await view(TOKEN, ITOK, 'balanceOf', [PAD.toString()]))[0];

  console.log('\n=== the arithmetic ===');
  console.log(`  sold on curve      ${whole(sold).toLocaleString()}`);
  console.log(`  burned             ${whole(burnLog.args[1]).toLocaleString()}`);
  console.log(`  totalSupply now    ${whole(supplyAfter).toLocaleString()}  (was ${whole(TOTAL).toLocaleString()})`);
  console.log(`  pad still holds    ${whole(padHolds).toLocaleString()}  (should be LP ${whole(LPRES).toLocaleString()} + creator ${whole(CALLOC).toLocaleString()})`);

  ok(burnLog.args[1] === CURVE - sold, 'burned exactly CURVE_SUPPLY - soldTokens');
  ok(supplyAfter === TOTAL - (CURVE - sold), 'totalSupply fell by exactly the burn');
  ok(supplyAfter === sold + LPRES + CALLOC, 'totalSupply == sold + LP_RESERVE + CREATOR_ALLOC — nothing unaccounted for');
  ok(padHolds === LPRES + CALLOC, 'pad holds only what it still owes out');
  ok(burnLog.args[2] === supplyAfter, 'the event reports the remaining supply, so an indexer never guesses');

  const before = 1_000_000_000 / whole(sold + LPRES + CALLOC);
  console.log(`\n  market cap overstatement BEFORE this fix: ${((before - 1) * 100).toFixed(1)}%`);
  ok(Math.abs(Number(supplyAfter - (sold + LPRES + CALLOC))) === 0, 'after the fix every token in totalSupply is reachable — 0% overstatement');

  console.log('\n=== nothing owed to anyone was taken ===');
  ok(!(await call(PAD, OWNER, IPUMP, 'migrate', [TOKEN])).err, 'migrate still succeeds after the burn');
  ok((await view(TOKEN, ITOK, 'balanceOf', [LPV.toString()]))[0] === LPRES, 'lpVault received the full LP_RESERVE');
  TIME += 31n * 24n * 3600n;                       // past CREATOR_LOCK
  ok(!(await call(PAD, CREATOR, IPUMP, 'claimCreatorAllocation', [TOKEN])).err, 'creator can still claim after the burn');
  ok((await view(TOKEN, ITOK, 'balanceOf', [CREATOR.toString()]))[0] >= CALLOC, 'creator received the full CREATOR_ALLOC');
  ok((await view(TOKEN, ITOK, 'balanceOf', [PAD.toString()]))[0] === 0n, 'pad now holds nothing — no stranded supply at all');

  console.log('\n=== burn is self-only: no privileged burner exists ===');
  const victim = BUYERS[0];
  const vBal = (await view(TOKEN, ITOK, 'balanceOf', [victim.toString()]))[0];
  ok(vBal > 0n, 'a buyer holds tokens');
  ok(!build.ArcliteToken.abi.some(f => /^burnFrom$/.test(f.name || '')), 'there is no burnFrom in the ABI');
  const burnFn = build.ArcliteToken.abi.find(f => f.name === 'burn');
  ok(burnFn && burnFn.inputs.length === 1, 'burn takes only an amount — no address parameter to point at someone else');
  const r2 = await call(TOKEN, OWNER, ITOK, 'burn', [vBal]);
  ok(!!r2.err, 'owner calling burn cannot touch a holder: ' + r2.err);
  ok((await view(TOKEN, ITOK, 'balanceOf', [victim.toString()]))[0] === vBal, "the holder's balance is untouched");

  console.log(`\n====================================================\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(1); });
