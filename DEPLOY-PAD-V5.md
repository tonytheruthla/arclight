# Task #59 — burn the unsold curve supply. Fixed, tested, ready to deploy.

**22 contract tests pass, 0 fail. 185 indexer tests pass, 0 fail.**
Pad compiles to 15,207 bytes, under the 24,576 EIP-170 limit.

I never touch keys. Every step below is yours to run with your own wallet.

---

## What was wrong

At graduation the pad kept every curve token nobody bought. No path moved them —
`buy()` closes, `migrate()` only moves `LP_RESERVE`, `claimCreatorAllocation()`
only moves `CREATOR_ALLOC`. They sat in the contract forever *while still
counting toward `totalSupply`*, so every market cap — ours and every other
site's — read high.

`redeem()` had the same leak: redeemed tokens came back to the contract and
stayed.

### The real numbers, measured from the contract, not estimated

I ran graduation in a real EVM at several buy sizes, because the overstatement
depends on how far the final buy overshoots $1,500:

| final buy size | sold at graduation | stranded | market cap overstated by |
|---|---|---|---|
| $1,000 | 429,397,590 | 370,602,409 | **58.9%** |
| $300 | 402,459,222 | 397,540,777 | 66.0% |
| $100 | 373,193,717 | 426,806,282 | 74.5% |
| $25 | 361,556,627 | 438,443,372 | 78.1% |
| $5 | 360,767,181 | 439,232,818 | **78.3%** |

**Correction to what I told you earlier.** I had been quoting a flat **79%** and
"357.6M sells". The true figure is a **range, 59–79%**, converging on ~79% as
buys get smaller, and the fine-grained sold figure is ~360.8M, not 357.6M. 79%
is the realistic case, not the only case, and I should have stated it as a range
from the start.

---

## The fix — three changes, all in `ArclitePumpV4.sol`

**1. `ArcliteToken.burn(uint256)`** — destroys the caller's own tokens and
decrements `totalSupply`.

Self-only by construction: there is no `burnFrom`, no privileged burner, and
`burn` takes an amount but no address, so there is no parameter with which to
point it at anyone else. An owner calling it can only burn their own balance.
Tests assert all three.

It decrements `totalSupply` rather than sending to `0x…dead`. That distinction
*is* the fix — a dead-address transfer leaves `totalSupply` untouched, so every
market cap computed as `price × totalSupply` stays exactly as wrong as before.

**2. `_graduate` burns `CURVE_SUPPLY - soldTokens`.** Selling stops at
graduation, so `soldTokens` is final at that point and this is precisely the
part of the curve nobody took. Emits `SupplyBurned(token, amount,
remainingSupply)` in the same transaction as `Graduated`.

**3. `redeem` burns the tokens handed back**, for the same reason.

Redemption maths is untouched: it divides `redeemPool` by `redeemSupply`, and
`redeemSupply` is `soldTokens`, which the burn does not change.

### Proven, not asserted

```
sold on curve      402,459,222
burned             397,540,777
totalSupply now    602,459,222  (was 1,000,000,000)
pad still holds    200,000,000  = LP 190,000,000 + creator 10,000,000

PASS totalSupply == sold + LP_RESERVE + CREATOR_ALLOC — nothing unaccounted for
PASS migrate still succeeds after the burn
PASS lpVault received the full LP_RESERVE
PASS creator can still claim after the burn
PASS pad now holds nothing — no stranded supply at all
PASS owner calling burn cannot touch a holder
```

---

## The half that nearly got missed

The indexer wrote `total_supply` **once** (`WHERE total_supply IS NULL`). Burning
on-chain would have changed nothing on arclite.fun — our own site would have gone
on quoting the pre-burn supply, and the fix would have been invisible exactly
where people look.

So `indexer/` changes too:

- `setTokenSupply(..., { force })` — write-once still holds for ordinary tokens,
  because a third-party list disagreeing is a data problem, not an update.
- `refreshLaunchSupply()` reads `totalSupply()` **on-chain** for pad-launched
  tokens during the existing meta backfill. On-chain deliberately: Tolly's list
  is where supply comes from today, and on burn day it would overwrite the
  correct value with a stale one.

Pinned by four tests, including that the market cap the UI computes actually
falls ($4,200 → $2,355 on the test figures).

---

## Deploying — your wallet, your key, every step

**Nothing is lost by redeploying.** The live pad has `tokenCount() = 0`. No
token, no curve, no user position exists on it. This is the last moment this is
free.

### 1. Compile and run the tests yourself

```bash
cd arclight
node compile-pump.js      # -> build-pump-v5.json
node test-pump-burn.js    # -> 22 passed, 0 failed
```

### 2. Deploy

Constructor args, matching what is live today:

```
deploymentFee_   0
graduationUsdc_  1500000000000000000000     (1,500 USDC, 18dp)
treasury_        <your treasury address>
```

Use the same flow you used for the current pad. **Do not paste a private key
anywhere except your own terminal**, and not into this chat.

### 3. Immediately after deploy

```
setLpVault(<lp vault address>)
```

Then read back, before anything else:

```
tokenCount()      -> 0
deploymentFee()   -> 0
graduationUsdc()  -> 1500000000000000000000
owner()           -> your deployer
```

### 4. Swap the address in three live files

The new pad has a new address. It appears in:

| file | what to change |
|---|---|
| `arclight/app/terminal.html` | the pad address constant |
| `arclight/home.html` | the contract address in the copy |
| `arclight/test-home.js` | the address the test asserts |

Send me the new address and I'll produce the edited files with byte counts, the
same way as every other push — safer than hand-editing a 328KB file.

### 5. Railway

On the **worker** service: set `PUMP_ADDRESS` to the new pad.

The indexer keys launchpad rows off that address, so until it changes the new
pad's launches are invisible.

### 6. Update the address everywhere it is quoted

`TELEGRAM-DAY-ONE.md` pin text, `X-HERO-COPY.md`, `arclite-mainnet-push.md`,
`arclite-keepers-live.md`, and the content-pillars skill all carry the old
address. I'll sweep them once you send the new one.

---

## Order

1. `node compile-pump.js && node test-pump-burn.js` — see it pass yourself.
2. Deploy, `setLpVault`, read back the four values.
3. Send me the address → I return terminal.html / home.html / test-home.js.
4. `PUMP_ADDRESS` on Railway.
5. Post the disclosure (`DISCLOSURE.md`) — it names the old behaviour, the
   number, and the fix, with the tx to check.

**Wait for the indexer to finish catching up before step 5.** It is still
working through the backlog and the numbers a reader would check are moving.
