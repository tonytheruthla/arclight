# What to do next — 17 Sept

---

## STEP 0 — URGENT. The site points at the dead pad.

**arclite.fun currently sends every Launch to `0xa855b6…dd394`** — the old
contract, the one with 44% of supply stranded forever. The new pad
`0xB52A6D…c361` is live and owned by you, but the site does not know about it.

The fix is already sitting in your clone. It has never been uploaded.

```
app/terminal.html   328,522 bytes   old-pad 0   new-pad 1
home.html            17,156 bytes   old-pad 0   new-pad 1
terminal.html       325,975 bytes   old-pad 0   new-pad 1
test-home.js         10,252 bytes   old-pad 0   new-pad 1
```

Nothing else matters until these four are live. Do Step 1, then check Step 2.

---

## STEP 1 — Get your local work into GitHub

You have 7 modified and 11 untracked files locally. Web-uploading them one by
one is not sensible any more. Set up auth once.

### 1a. Make a token

1. github.com/settings/tokens
2. **Generate new token (fine-grained)**
3. Repository access: **Only select repositories** → `arclight`
4. Permissions → Repository permissions → **Contents: Read and write**
5. Generate, copy it.

**Do not paste the token into this chat.** I don't need it.

### 1b. Pull first, then push

Your local clone is behind — you made edits in the GitHub web editor that your
clone has never seen. Pull before pushing or git will refuse.

```
cd ~/Downloads/arclight
echo ".draw-bot-state.json" >> .gitignore
git pull --rebase
```

If the rebase reports conflicts, stop and paste me the output. Do not force
anything.

### 1c. Commit and push

```
git add -A
git commit -m "Point site at pad v5; add draw bot, API cache, deploy and ownership scripts"
git push
```

Username: `tonytheruthla`. Password: **paste the token**, not your password.
macOS Keychain will remember it after the first time.

---

## STEP 2 — Verify the site actually changed

Wait about a minute for GitHub Pages, then:

```
curl -s https://arclite.fun/app/terminal.html | grep -c B52A6D9fe1cf135f4309536713bd2a43b34dc361
curl -s https://arclite.fun/app/terminal.html | grep -c a855b64c978118fdAC9746d1795c1E16668dd394
```

First must print **1**. Second must print **0**.

If the second is not 0, GitHub Pages is serving a cached copy — wait 10 minutes
and check again. Tell me either way and I'll verify independently.

---

## STEP 3 — Telegram bot

1. Message **@BotFather** → `/newbot` → copy the token.
2. Add the bot to **@arclitefun**, promote to admin with post rights.
3. Post any message in the group, then open
   `https://api.telegram.org/bot<TOKEN>/getUpdates` and copy `chat.id`
   (it will be negative, like `-1001234567890`).
4. Preview before it can post anywhere:

```
cd ~/Downloads/arclight
DRY=1 node draw-bot.js
```

5. Railway → New service → same repo → start command `node draw-bot.js` →
   variables `TG_TOKEN` and `TG_CHAT`.

**The token goes in Railway only. The repo is public.**

---

## STEP 4 — Two Railway variables

- **API service:** `SOL_RPC` = your Helius URL. Portfolio's Solana section has
  been dark since v14. The URL contains a key, so Railway only, never the repo.
- Delete the old keyed `UPSTREAMS` / `RPC_URL` values if they are still sitting
  on the proxy and worker services.

---

## STEP 5 — Kill the exposed Infura project

Key `b6bf7d35…76eaf8` was visible in a screenshot in chat. Removing the Railway
variable does **not** revoke it. Log in to infura.io, find the project, delete
it. It is already dead — Arc revoked it — so this is hygiene, not an emergency.

---

## STEP 6 — Post the disclosure

`DISCLOSURE.txt` in `~/Downloads/PUSH-ME-PAD-V5/`. Five tweets, each under 280
with the URL counted at 23, linted 5/5.

**Only after Step 2 passes.** The thread points people at the pad, and it should
point them at the right one.

---

## STEP 7 — Your two decisions

**Creator of the Week amount.** Recommendation: **$250**. At $500 Arclite
becomes a ~15% holder of someone's coin with a 90-day lock, and that is a story
told against you.

**The buy wallet.** Create it, fund it with one week's buy, send me the address.
It goes in reply 2 of the launch post and Friday's receipt post. I never touch
the key.

Then run `DOUBLE-DOWN.md`.

---

## Waiting on you, not blocking

- **Hero film re-render.** `film2.py` hardcodes 9,393 tokens / $1.86M / 1,778
  traders from 11 Sept. Live is 131,326 / $211M / 54,729 — understated 14x,
  113x and 31x. Say the word and I'll update and re-render. **The creator cut
  is unaffected** — it carries no figures and is safe to post today.
- **Indexer write batching.** ~180,000 sequential DB queries per chunk. Fine
  while there is 3x headroom.
- **Scanner full table scan.** The cache hides it; denormalising `last_price`
  removes it. Worth doing before the campaign lands, not after.
- **ARCL tokenomics.** The hero says "Launching soon". The three gates read
  2 / none / 0. Either the gates move or the wording does.
