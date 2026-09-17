// Compiles ArclitePumpV4 (pad + token) to build-pump-v5.json.
const solc = require('solc'); const fs = require('fs');
const file='ArclitePumpV4.sol';
const src=fs.readFileSync('contracts/'+file,'utf8');
const input={language:'Solidity',sources:{[file]:{content:src}},
  settings:{optimizer:{enabled:true,runs:200},evmVersion:'paris',
  outputSelection:{'*':{'*':['abi','evm.bytecode.object']}}}};
const o=JSON.parse(solc.compile(JSON.stringify(input)));
const errs=(o.errors||[]).filter(e=>e.severity==='error');
if(errs.length){ console.error(errs.map(e=>e.formattedMessage).join('\n')); process.exit(1); }
(o.errors||[]).forEach(e=>console.log('  warn:', e.formattedMessage.split('\n')[0]));
const solcVersion = solc.version();
console.log('solc', solcVersion);
const out={ solcVersion };
for(const name of ['ArclitePumpV4','ArcliteToken']){
  const c=o.contracts[file][name];
  out[name]={abi:c.abi, bytecode:'0x'+c.evm.bytecode.object};
  console.log('OK', name, (c.evm.bytecode.object.length/2).toLocaleString(), 'bytes');
}
fs.writeFileSync('build-pump-v5.json', JSON.stringify(out,null,2));
