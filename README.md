# Arclight

**The revenue-backed launchpad for Arc — where the market, not the team, controls the money.**

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
- [ ] Arc Testnet deployment (`deployment.json` will carry the address)
- [ ] Milestone market AMM (v1)
- [ ] Optimistic oracle resolution (v1)
- [ ] Revenue-share streaming (v1)

## Contact

Rahul Bhatia — rbhatia610@gmail.com

## License

MIT
