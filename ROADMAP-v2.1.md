# Arclite — v2.1 Product Upgrades (backlog)

Locked in on 2026-07-22. Do not start until Rahul says "let's work on version 2.1".

## 1. Universal wallet support (+ Telegram wallet)
- Support **every wallet that works on the Arc chain**, not just MetaMask.
  - Add EIP-6963 multi-injected-provider discovery + WalletConnect v2 so Rabby,
    Rainbow, Coinbase Wallet, Ledger, Trust, OKX, etc. all connect.
- **Explore Telegram wallet integration** (TON / Wallet-in-Telegram). Note: the
  relevant Telegram wallet feature is expected to release in ~1 month — revisit
  timing then; build against it once the API/SDK is public.

## 2. Chain-agnostic web app
- Make the dapp **multi-chain**: support all major chains, e.g. Solana and
  EVM/ERC-20 chains, alongside Arc.
- Implications to design for: per-chain contract deployments, a chain switcher in
  the UI, chain-specific wallet adapters (Solana wallet-adapter for Phantom etc.,
  EVM adapters for the rest), and unified token/market views across chains.

## 3. Social score for launched tokens
- For each launched token, gather social data by **token name (e.g. $ARCLIGHTGENESIS)
  and/or contract address**.
- Compute a **social score** from: number of tweets/posts, engagement, likes,
  reposts, reach, velocity, etc.
- Surface the score on the token detail + trade rows so buyers can gauge momentum.
- Data sources to evaluate: X/Twitter API, aggregators, on-chain mentions.
  (Watch API cost/rate limits; may need a backend/indexer + caching.)

## 4. Account abstraction (social login → dedicated wallets)
- Let users **sign in with X (Twitter) and Telegram** — no seed phrase.
- On login, **provision a dedicated (smart-contract / embedded) wallet** for the
  user tied to their social identity.
- Evaluate providers: Privy, Dynamic, Turnkey, Web3Auth, ZeroDev/Pimlico (ERC-4337).
  Pairs naturally with #1 (Telegram) and #2 (multi-chain embedded wallets).

---
### Sequencing note (for when we start)
These interlock: account abstraction (#4) + universal/Telegram wallets (#1) share
the same auth/wallet layer; chain-agnostic (#2) and the social score (#3) each need
a backend/indexer. Suggested order when we begin: wallet/auth layer first (#1, #4),
then multi-chain (#2), then social score (#3). We'll confirm scope at kickoff.
