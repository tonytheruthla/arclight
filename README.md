# Arclight

**The token launchpad + prediction market for Arc — priced in real dollars, rug-proof by design.**

> **v0.2 live on Arc Testnet:** launchpad factory [`0x0723...209A`](https://testnet.arcscan.app/address/0x07236980c1734d86D94D979A5d512689f7BD209A) · first token ARCG [`0x10e0...8868`](https://testnet.arcscan.app/address/0x10e0052E393d42510D704bEA062A7De577478868)
> **v0.1 live on Arc Testnet:** milestone escrow [`0x666a...4A81`](https://testnet.arcscan.app/address/0x666aE5951023fA45dD3E484a60ab55E15D1C4A81)

## v0.2 — ArclightPump (memecoin launchpad)

Pump.fun-style one-click token launches, rebuilt for Arc and fixing pump.fun's gaps:

- **Bonding curve priced in native USDC** — coins cost real dollars, not a volatile gas token. Buys/sells via `msg.value`, no approvals. (`contracts/ArclightPump.sol`)
- **Anti-dump creator vesting** — creator's 1% allocation is locked until 30 days after graduation; zero creator tokens circulate while the curve is live.
- **Graduation at $8K raised** — curve freezes, LP reserve earmarked for DEX migration (v0.3), ~13x price ride from launch to graduation.
- **Platform revenue** — 1 USDC deployment fee + 1% trade fee, accrued on-chain.
- **Proven live:** token created and traded on testnet (see `deployment-v2.json`).

v0.3 roadmap: sealed-bid fair-launch window (Arc privacy primitives), DEX migration with LP burn, holder fee-share streaming, and **graduation prediction markets** — parimutuel betting on which launches graduate, fusing the launchpad with a prediction market venue.

Arclight fuses three primitives that don't exist on Arc today into one product: a launchpad, prediction markets, and revenue-based financing.

- **Revenue-backed launches** — projects raise USDC by selling revenue-share tokens: pro-rata claims on future USDC cash flows streamed onchain. Real yield, not governance vibes.
- **Milestone prediction markets as the vesting oracle** — every launch ships with YES/NO markets on objective milestones ("mainnet contracts live by date D"). Raised USDC sits in escrow and streams to the team only as markets resolve YES. Any NO fails the launch and refunds backers pro-rata.
- **A live credibility score** — pre-raise YES prices form a public, skin-in-the-game rating for every project on Arc. NO shares double as project-failure insurance.

## Why Arc — and only Arc

| Arc property | What it unlocks for Arclight |
|---|---|
| Native USDC gas (18 decimals) | Escrow via `msg.value` — no ERC-20 approvals to back a launch |
| Sub-second deterministic finality | Micro-fee milestone markets and revenue streaming stay economical |
| Configurable privacy | Sealed-bid batch auctions — no snipers, no MEV, uniform clearing price |
| Native FX (StableFX) | EURC-denominated raises for European projects |
| Compliance-ready architecture | Identity gating and transfer controls for institutional participation |

## How it works

```
BACKERS ──deposit──▶ ESCROW VAULT ──gated by──▶ MILESTONE MARKET
 native USDC          raise locked               "Shipped by date D?"
                      onchain                          │
                                          YES ─▶ tranche streams to team,
                                                 next milestone opens
                                          NO ──▶ launch fails, remaining
                                                 escrow refunds backers
```

## Repo contents

```
contracts/ArclightLaunchpad.sol   v0 skeleton: registry + escrow + milestones + refunds
build.json                        compiled ABI + bytecode (solc 0.8.26, optimizer 200)
deploy.js                         one-command deploy to Arc Testnet
docs/arclight-one-pager.pdf       infographic one-pager
```

### v0 contract (this repo)

`ArclightLaunchpad.sol` implements the escrow spine: launch registry, native-USDC
escrow, milestone tranches in basis points (must sum to 10,000), sequential
milestone settlement, and pro-rata refunds of unreleased escrow on any failed
milestone. Milestone resolution is a trusted resolver in v0 — explicitly a
placeholder for v1's market-driven resolution.

### v1 roadmap

- LMSR-based milestone prediction markets as the resolution and pricing layer
- Optimistic oracle resolution: bonded proposers + challenge window
- Revenue-share token standard with onchain USDC streaming
- Sealed-bid batch launch entry using Arc privacy primitives
- EURC raises via native FX

## Deploy to Arc Testnet

```bash
npm install
node deploy.js   # 1st run: generates a burner wallet, prints the address
                 # fund it at https://faucet.circle.com (Arc Testnet)
node deploy.js   # 2nd run: deploys and writes deployment.json
```

Or with your own key: `DEPLOYER_KEY=0x... node deploy.js`

| Network | Value |
|---|---|
| Chain | Arc Testnet |
| Chain ID | `5042002` |
| RPC | `https://rpc.testnet.arc.network` |
| Explorer | https://testnet.arcscan.app |
| Faucet | https://faucet.circle.com |

## Status

- [x] v0 escrow + milestone contracts, compile-verified
- [x] Arc Testnet deployment — [`0x666aE5951023fA45dD3E484a60ab55E15D1C4A81`](https://testnet.arcscan.app/address/0x666aE5951023fA45dD3E484a60ab55E15D1C4A81) ([deploy tx](https://testnet.arcscan.app/tx/0x60f38ee4e1096cfcf96bc7e6258aa4866e081aa8cbe32efdc72351290926ef8f), see `deployment.json`)
- [ ] Milestone market AMM (v1)
- [ ] Optimistic oracle resolution (v1)
- [ ] Revenue-share streaming (v1)

## Contact

Rahul Bhatia — rbhatia610@gmail.com

## License

MIT
