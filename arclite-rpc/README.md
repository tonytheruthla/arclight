# Arclite Arc RPC

Cached, failover JSON-RPC proxy for Arc mainnet (chain 5042).
Zero dependencies - Node stdlib only.

- Method-aware caching; nonces and sends never cached.
- Multi-upstream failover with quota-exhaustion detection.
- Verifies each upstream really serves chain 5042.
- Per-IP rate limiting; no bodies or IPs logged.

Run: set UPSTREAMS, then npm start. Tests: npm test.

Never commit a real provider URL here.
