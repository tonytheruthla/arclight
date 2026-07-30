// v0.4 clone-factory tests. Focus: gas win, one-shot init, implementation
// cannot be hijacked, clones are fully independent, and createdAt lands in page().
const { createVM } = require('@ethereumjs/vm');
const { Common, Mainnet, Hardfork } = require('@ethereumjs/common');
const { createAddressFromString, Account, hexToBytes, bytesToHex } = require('@ethereumjs/util');
const { ethers } = require('ethers');
const fs = require('fs');

const v3 = JSON.parse(fs.readFileSync('build-pump-v3.json'));
const v4 = JSON.parse(fs.readFileSync('build-pump-v4.json'));
const i3 = new ethers.Interface(v3.abi), i4 = new ethers.Interface(v4.abi);
const TOKEN_ABI = new ethers.Interface([
  'function initialize(string,string,uint256,address)','function name() view returns (string)',
  'function symbol() view returns (string)','function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)','function initialized() view returns (bool)'
]);

const A = n => createAddressFromString('0x'+n.toString(16).padStart(40,'0'));
const OWNER=A(0xA1), USER=A(0xB2), ATTACK=A(0xB9), TREASURY=A(0xC4);
const E = n => BigInt(Math.round(n*1e6)) * 10n**12n;
let TIME = 1800000000n, vm;
let pass=0, fail=0;
const ok=(c,m)=>{ c?(pass++,console.log('  PASS '+m)):(fail++,console.log('  FAIL '+m)); };

(async()=>{
  vm = await createVM({ common: new Common({chain:Mainnet, hardfork:Hardfork.Paris}) });
  const raw = vm.evm.runCall.bind(vm.evm);
  const run = o => raw({...o, block:{header:{timestamp:TIME,number:1n,difficulty:0n,gasLimit:30000000n,
    baseFeePerGas:0n,coinbase:OWNER,prevRandao:new Uint8Array(32),getBlobGasPrice:()=>0n}}});
  const fund = async(a,w)=>{const acc=(await vm.stateManager.getAccount(a))||new Account(); acc.balance=w; await vm.stateManager.putAccount(a,acc);};
  for(const a of [OWNER,USER,ATTACK]) await fund(a, E(500000));
  await fund(TREASURY, 0n);
  const call = async(to,from,d,v=0n)=>{ if(typeof to==='string') to=createAddressFromString(to);
    const r=await run({caller:from,origin:from,to,gasLimit:30000000n,data:hexToBytes(d),value:v});
    return {err:r.execResult.exceptionError&&r.execResult.exceptionError.error,
            ret:bytesToHex(r.execResult.returnValue), gas:r.execResult.executionGasUsed}; };
  const deploy = async(b,args,i)=>{const r=await run({caller:OWNER,origin:OWNER,gasLimit:30000000n,
    data:hexToBytes(b+(args.length?i.encodeDeploy(args).slice(2):'')),value:0n}); return r.createdAddress;};

  console.log('\n=== deploy both factories ===');
  const p3 = await deploy(v3.bytecode, [E(1), E(8000), TREASURY.toString()], i3);
  const p4 = await deploy(v4.bytecode, [E(1), E(8000), TREASURY.toString()], i4);
  ok(!!p3 && !!p4, 'v0.3 and v0.4 factories deploy');

  console.log('\n=== 1. the gas win ===');
  const g3 = await call(p3, USER, i3.encodeFunctionData('createToken',['Gas Test','GAS']), E(1));
  const g4 = await call(p4, USER, i4.encodeFunctionData('createToken',['Gas Test','GAS']), E(1));
  ok(!g3.err && !g4.err, 'createToken succeeds on both');
  const cut = Number(g3.gas - g4.gas) / Number(g3.gas) * 100;
  console.log(`       v0.3 ${g3.gas} gas  ->  v0.4 ${g4.gas} gas`);
  console.log(`       saving ${(g3.gas-g4.gas)} gas (${cut.toFixed(1)}%),  ${(Number(g3.gas)/Number(g4.gas)).toFixed(1)}x cheaper`);
  ok(g4.gas < (g3.gas * 6n) / 10n, 'v0.4 launch costs under 60% of v0.3');

  const token = ethers.AbiCoder.defaultAbiCoder().decode(['address'], g4.ret)[0];

  console.log('\n=== 2. the clone is a real, working token ===');
  const rd = async(fn,args=[])=>{
    const r = await call(token, USER, TOKEN_ABI.encodeFunctionData(fn,args));
    return r.err ? null : TOKEN_ABI.decodeFunctionResult(fn, r.ret)[0];
  };
  ok(await rd('name')==='Gas Test', 'clone name() reads through the proxy');
  ok(await rd('symbol')==='GAS', 'clone symbol() reads through the proxy');
  ok((await rd('totalSupply'))===1000000000n*10n**18n, 'clone totalSupply is 1B');
  ok((await rd('balanceOf',[p4.toString()]))===1000000000n*10n**18n, 'factory holds the full supply');

  console.log('\n=== 3. initialize() is one-shot (the classic clone bug) ===');
  const re = await call(token, ATTACK,
    TOKEN_ABI.encodeFunctionData('initialize',['Hijacked','EVIL',E(999),ATTACK.toString()]));
  ok(!!re.err, 'attacker cannot re-initialize a live clone');
  ok(await rd('name')==='Gas Test', 'name unchanged after hijack attempt');

  console.log('\n=== 4. the implementation itself cannot be claimed ===');
  const implR = await call(p4, USER, i4.encodeFunctionData('tokenImplementation',[]));
  const impl = i4.decodeFunctionResult('tokenImplementation', implR.ret)[0];
  const ir = await call(impl, ATTACK,
    TOKEN_ABI.encodeFunctionData('initialize',['Pwned','PWN',E(999),ATTACK.toString()]));
  ok(!!ir.err, 'implementation is pre-initialised, so it cannot be hijacked');
  const initR = await call(impl, USER, TOKEN_ABI.encodeFunctionData('initialized',[]));
  ok(TOKEN_ABI.decodeFunctionResult('initialized', initR.ret)[0]===true, 'implementation.initialized == true');

  console.log('\n=== 5. clones are independent ===');
  const g4b = await call(p4, USER, i4.encodeFunctionData('createToken',['Second Coin','TWO']), E(1));
  const t2 = ethers.AbiCoder.defaultAbiCoder().decode(['address'], g4b.ret)[0];
  ok(t2.toLowerCase()!==token.toLowerCase(), 'second clone gets a distinct address');
  const n2r = await call(t2, USER, TOKEN_ABI.encodeFunctionData('name',[]));
  ok(TOKEN_ABI.decodeFunctionResult('name', n2r.ret)[0]==='Second Coin', 'second clone has its own storage');
  ok(await rd('name')==='Gas Test', 'first clone unaffected by the second');

  console.log('\n=== 6. trading still works through the proxy ===');
  const buy = await call(p4, USER, i4.encodeFunctionData('buy',[token,0]), E(500));
  ok(!buy.err, 'buy() transfers cloned tokens: '+(buy.err||'ok'));
  ok((await rd('balanceOf',[USER.toString()]))>0n, 'buyer received clone tokens');

  console.log('\n=== 7. createdAt now comes back from page() ===');
  const pg = await call(p4, USER, i4.encodeFunctionData('page',[0,10]));
  const d = i4.decodeFunctionResult('page', pg.ret);
  ok(d.length===6, 'page() returns 6 arrays (was 5)');
  ok(d[5].length===2 && d[5][0]===TIME, 'createdAt present and correct: '+d[5][0]);

  console.log('\n'+'='.repeat(52));
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail?1:0);
})().catch(e=>{ console.error('HARNESS ERROR:',e); process.exit(1); });
