// Compiles the post-launch contracts: the hourly draw and limit orders.
const solc = require('solc'); const fs = require('fs');
const targets = [ ['LuckyTrencher.sol','LuckyTrencher','build-draw.json'], ['ArcliteLimit.sol','ArcliteLimit','build-limit.json'] ];
let fail=false;
for (const [file,name,out] of targets) {
  const src = fs.readFileSync('contracts/'+file,'utf8');
  const input={language:'Solidity',sources:{[file]:{content:src}},settings:{optimizer:{enabled:true,runs:200},evmVersion:'paris',outputSelection:{'*':{'*':['abi','evm.bytecode.object']}}}};
  const o=JSON.parse(solc.compile(JSON.stringify(input)));
  const errs=(o.errors||[]).filter(e=>e.severity==='error');
  if(errs.length){ console.error('=== '+file+' FAILED ==='); console.error(errs.map(e=>e.formattedMessage).join('\n')); fail=true; continue; }
  (o.errors||[]).forEach(e=>console.log('  warn:', e.formattedMessage.split('\n')[0]));
  const c=o.contracts[file][name];
  fs.writeFileSync(out, JSON.stringify({abi:c.abi, bytecode:'0x'+c.evm.bytecode.object},null,2));
  console.log('OK', name, c.evm.bytecode.object.length/2, 'bytes');
}
process.exit(fail?1:0);
