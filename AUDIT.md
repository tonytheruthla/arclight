# Arklight — Audit Brief

**Send this file with the scope.** It exists to save you time: it tells you what the system does,
where we already know it's dangerous, and what we've already fixed. We would rather you spend the
engagement on the hard parts than rediscovering things we can hand you on day one.

---

## 1. Scope

| File | Lines | Note |
|---|---|---|
| `contracts/ArclightPumpV4.sol` | ~355 | Launchpad + bonding curve + graduation. **Audit candidate.** |
| `contracts/ArclightPredictV3.sol` | ~250 | Parimutuel graduation markets. Unchanged since v0.3. |

**Out of scope:** `ArclightPumpV3.sol`, `ArclightPredictV3` historical versions, `ArclightLaunchpad.sol`
(v0.1, abandoned), everything under `app/`.

- **No external dependencies.** No OpenZeppelin, no imports at all.
- **No upgradeability.** No proxies for the protocol itself.
- **One block of assembly** — the canonical EIP-1167 minimal proxy in `_clone()`. Verbatim from the
  EIP. It is the only non-obvious code in the repo and we're flagging it rather than making you find it.

**Compiler:** `solc 0.8.26` · optimizer **enabled**, **200 runs** · `evmVersion: paris`

---

## 2. The one thing that will trip you up

> **Gas is USDC, with 18 decimals. Not ETH.**

Arklight targets [Arc](https://docs.arc.network), Circle's stablecoin-native L1, where the native gas
token is USDC. Every `msg.value` in this codebase is **dollars**, and `1e18 == $1.00`.

Consequences worth holding in your head:

- `payable` functions receive dollars. `VIRTUAL_USDC = 3_000e18` means $3,000.
- There is **no ERC-20 USDC contract** in the flow. No `approve`, no `transferFrom` for the quote
  asset. Value moves via `msg.value` and `.call{value:}`.
- A user with a zero balance cannot transact at all, including reverting — relevant to griefing analysis.
- Reviewers who assume ETH semantics tend to mis-size every economic threshold in the contract.

---

## 3. What the system does

**Launchpad (`ArclightPumpV4`)**

1. `createToken` — clones an ERC-20 (EIP-1167), 1B supply held by the factory. Flat deploy fee.
2. `buy` / `sell` — constant-product curve over *virtual* reserves
   (`VIRTUAL_USDC + realUsdc` × `VIRTUAL_TOKENS - soldTokens`). 1% fee each way.
3. **Graduation** — when `realUsdc >= graduationUsdc`, phase flips to `Graduated`, the curve freezes,
   and `redeemPool` / `redeemSupply` are snapshotted.
4. **Migration window** — the owner has `MIGRATION_GRACE` (7 days) to `migrate()` liquidity to `lpVault`.
5. **Redemption backstop** — if that window lapses without migration, `redeem()` opens permanently and
   holders take the frozen reserve pro-rata. `migrate()` becomes unreachable at that moment.
6. Creator's 1% allocation is claimable only 30 days after graduation.

**Markets (`ArclightPredictV3`)**

Parimutuel YES/NO on "will this token graduate before deadline D". **Oracle-free**: `resolve()` reads
the launchpad's curve phase and `graduatedAt` directly. YES only if `phase == Graduated && graduatedAt
<= deadline`. Winners split the pot pro-rata less a 2% rake. One-sided markets refund in full.

---

## 4. Where we think the risk actually is

Ranked by our own worry, most to least:

### 4.1 The graduation → migration → redemption state machine
The design intent is that **no state can strand user funds**, and that the operator gets a *deadline*,
not indefinite control. Specifically we want these to hold:

- Once `block.timestamp >= graduatedAt + MIGRATION_GRACE` and `!migrated`, `redeem()` works and
  `migrate()` reverts — **permanently**, with no ordering or reentrancy trick that re-opens it.
- `redeemPool` can never pay out more than was frozen at graduation.
- A token can never be both `migrated` and redeemable.

If any of those can be broken, that's the critical finding.

### 4.2 Curve math
- Rounding direction on every division — can a sequence of buys/sells extract value?
- Can `soldTokens` exceed `CURVE_SUPPLY` across interleaved operations?
- `sell()` decrements `realUsdc` by `usdcOut + fee` (gross) while the fee stays in the contract.
  We believe that's consistent with `buy()` adding net. Please confirm.
- Precision loss at extreme values — very small buys, near-sold-out curves.

### 4.3 Solvency invariant
`totalReserves` (Pump) and `totalStaked` (Predict) track what is owed to users. `withdrawFees()`
reverts `Insolvent` if paying fees would dip below that. We want: **platform fees can never be
withdrawn out of user funds, under any accounting drift.** Check every path that mutates these,
including failed sends and one-sided market refunds.

### 4.4 Parimutuel edge cases
`winPool == 0`, `winPool == pot`, zero-stake claims, integer-division dust, double-claim. Critically:
**can the fee accrued at `resolve()` ever exceed what remains for claimants?**

### 4.5 Clone factory
- `initialize()` is one-shot; the implementation is pre-initialised at construction. We test both.
- Is there any path where a clone is created but left uninitialised and claimable?
- Does the EIP-1167 assembly handle a failed `create` correctly? (We revert `CloneFailed`.)

### 4.6 Reentrancy
Guards are on every value-sending path and CEI ordering is correct today. **But `migrate()` will
eventually call a real DEX**, which is the path we'd attack. Treat `lpVault` as hostile.

### 4.7 Access control
Two-step ownership (`transferOwnership` → `acceptOwnership`). Pause covers entries
(`createToken`/`buy`/`sell`/`bet`) but deliberately **not** exits (`redeem`/`claim`/`resolve`/
`claimCreatorAllocation`) — a paused contract must never trap funds. Confirm that's airtight.

---

## 5. What we already found and fixed

Full write-up in `arklight-contract-audit.md`. Summary of the v0.2 → v0.3 fixes, all of which we
reproduced against the old code in `regress-v2.js`:

| Severity | Bug | Fix |
|---|---|---|
| 🔴 | Graduation permanently froze all holder funds — `migrate()` was an empty stub while `buy`/`sell` required `Trading` | Grace window + `redeem()` backstop |
| 🔴 | No `transferOwnership` at all — deploying EOA was the permanent, irrevocable owner | Two-step ownership |
| 🔴 | Market resolved YES on *any* graduation, even long after the deadline | Compare `graduatedAt <= deadline` |
| 🟠 | No pause | `Pausable` on entries only |
| 🟠 | `withdrawFees(address to)` — arbitrary destination | Fixed `treasury`, no argument |
| 🟡 | No reentrancy guards | `nonReentrant` throughout |
| 🟡 | Fees and reserves commingled with no invariant | `totalReserves` / `totalStaked` + `Insolvent` check |

---

## 6. Test evidence

```
node test-v3.js      37 passed   v0.3 behaviour: graduation, redemption, ownership,
                                 pause, treasury, solvency, oracle-free resolution
node test-v4.js      18 passed   v0.4 clone factory: gas, one-shot init, implementation
                                 hijack resistance, clone independence, createdAt
node regress-v2.js   reproduces both v0.2 critical bugs against the original code
```

Run against `@ethereumjs/vm` (Paris). **These are our tests and they pass — which tells you the code
does what we intended, not that what we intended is safe.** That distinction is the engagement.

---

## 7. Deployment reality

Live on Arc testnet, full lifecycle exercised on-chain (see `deployment-v3.json`):

| | |
|---|---|
| ArclightPumpV3 | `0xe6e185c2b77AB49C63774f24a53e87B7A17826E1` |
| ArclightPredictV3 | `0x1DC7fAe3157b9Ef003903599762fe8842478bE0b` |
| Explorer | https://testnet.arcscan.app |

Launch → trade → graduate → open market → bet → resolve YES → claim has all been executed with real
transactions. Testnet params are deliberately small (`deploymentFee 0.1`, `graduationUsdc 2`) so the
whole lifecycle was affordable; **mainnet values are 1 and 8000 USDC**.

**v0.4 has not yet been deployed to a live chain** — it is verified only in the local EVM harness.

---

## 8. Known-unfinished, intentionally

Please still comment on these; we'd rather hear it now.

1. **`migrate()` sends to `lpVault`, an address the owner sets.** Until that points at a real DEX
   position, "LP burned automatically" is a claim the contract does not enforce. We know. We want your
   view on the safest way to wire it.
2. **No keeper enforcement on-chain.** Resolution is permissionless; we run an off-chain keeper. If a
   market is never resolved, funds sit claimable-but-unclaimed indefinitely.
3. **Light points are off-chain** (localStorage). Not in scope, but noting it so nothing looks hidden.

---

## 9. Contact

Rahul Bhatia — raul@arklight.fun · https://arklight.fun
Repo: https://github.com/tonytheruthla/arclight
