// Arclight skeleton deploy — Arc Testnet
// Usage:
//   npm install
//   node deploy.js            <- first run generates a burner wallet, prints address to fund
//   node deploy.js            <- after funding at https://faucet.circle.com, run again to deploy
// Or use your own key:  DEPLOYER_KEY=0x... node deploy.js

const { ethers } = require("ethers");
const fs = require("fs");

const RPC = "https://rpc.testnet.arc.network";
const CHAIN_ID = 5042002;
const EXPLORER = "https://testnet.arcscan.app";
const WALLET_FILE = ".deployer.json";

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC, CHAIN_ID);

  // --- wallet: env key > saved burner > new burner
  let key = process.env.DEPLOYER_KEY;
  if (!key && fs.existsSync(WALLET_FILE)) {
    key = JSON.parse(fs.readFileSync(WALLET_FILE, "utf8")).privateKey;
  }
  if (!key) {
    const w = ethers.Wallet.createRandom();
    fs.writeFileSync(WALLET_FILE, JSON.stringify({ address: w.address, privateKey: w.privateKey }, null, 2));
    console.log("Generated burner deployer wallet (saved to .deployer.json — testnet only, do not reuse):");
    console.log("  " + w.address);
    console.log("\nFund it with testnet USDC on Arc Testnet at https://faucet.circle.com");
    console.log("then run `node deploy.js` again.");
    return;
  }

  const wallet = new ethers.Wallet(key, provider);
  const bal = await provider.getBalance(wallet.address);
  console.log("Deployer:", wallet.address);
  console.log("Balance :", ethers.formatEther(bal), "USDC (native, 18 decimals)");
  if (bal === 0n) {
    console.log("\nBalance is zero — fund this address at https://faucet.circle.com (Arc Testnet), then re-run.");
    return;
  }

  const { abi, bytecode } = JSON.parse(fs.readFileSync("build.json", "utf8"));
  const factory = new ethers.ContractFactory(abi, bytecode, wallet);
  console.log("\nDeploying ArclightLaunchpad...");
  const contract = await factory.deploy();
  const receipt = await contract.deploymentTransaction().wait();

  console.log("\n✅ Deployed!");
  console.log("Contract:", contract.target);
  console.log("Tx      :", receipt.hash);
  console.log("Explorer:", `${EXPLORER}/address/${contract.target}`);

  fs.writeFileSync(
    "deployment.json",
    JSON.stringify({ network: "arc-testnet", chainId: CHAIN_ID, address: contract.target, tx: receipt.hash, deployer: wallet.address, timestamp: new Date().toISOString() }, null, 2)
  );
  console.log("\nSaved to deployment.json — put this address in the ecosystem-form submission.");
}

main().catch((e) => { console.error(e); process.exit(1); });
