# Draw bot — setup, step by step

`draw-bot.js` and `test-draw-bot.js` are in the repo. 41 tests pass. It needs
only `ethers`, which the root `package.json` already has.

**Read this first:** with zero tickets sold, the bot posts **nothing**. That is
correct, not broken. Checked just now — round 497122, all three pots at $0, no
tickets. The group stays silent until someone actually buys one. Don't deploy
it, see silence, and assume it failed.

---

## Step 1 — Make the bot

1. Open Telegram, search **@BotFather**, start a chat.
2. Send `/newbot`.
3. Name: `Arclite Draw` (display name, can be anything).
4. Username: must end in `bot` — e.g. `ArcliteDrawBot`.
5. BotFather replies with a token like `8123456789:AAF...`.

**That token is a password.** Anyone holding it can post as your bot. It goes in
Railway only — never in the repo, never in this chat.

While you're there, send `/setdescription` and `/setuserpic` if you want it to
look like it belongs to you.

---

## Step 2 — Put it in the group

1. Open **@arclitefun**.
2. Group name → **Add members** → search your bot's username → add it.
3. Group name → **Administrators** → **Add Admin** → pick the bot.
4. It needs only one right: **Post messages**. Turn the rest off — a bot that
   cannot delete or ban cannot be used to wreck the group if the token leaks.

---

## Step 3 — Get the chat id

The bot cannot see messages sent before it joined, so:

1. Post any message in the group, e.g. `hello`.
2. Open this in a browser, with your real token in place of `<TOKEN>`:

```
https://api.telegram.org/bot<TOKEN>/getUpdates
```

3. Find `"chat":{"id":-1001234567890`. **Copy the id including the minus sign.**
   Supergroup ids start `-100`.

If `getUpdates` returns `{"ok":true,"result":[]}`, the bot has not seen anything
yet — post again in the group and reload.

---

## Step 4 — Preview it before it can post anywhere

```
cd ~/Downloads/arclight
DRY=1 node draw-bot.js
```

`DRY=1` prints to your terminal and sends nothing to Telegram. You will see:

```
[init] starting from block NNNNNN — no backfill, so a restart cannot spam the group
[init] draw 0x9f5dd4c6… · chat (dry) · polling 20000ms
```

and then nothing, because there are no tickets. That is the expected output
today. Ctrl-C to stop.

To see what the messages actually look like:

```
node -e 'const B=require("./draw-bot"),E=10n**18n;
console.log(B.warningMessage({roundId:497122,pots:[7n*E,25n*E,0n],tickets:[7n,5n,0n]}));
console.log(B.drawnMessage({roundId:497122,tier:1,winner:"0x01Cf6dC3F06b8c75A3eBF3b214dB562E956998be",prize:24n*E,tickets:5n,hitJackpot:false,txHash:"0x"+"ab".repeat(32)}));'
```

---

## Step 5 — Deploy on Railway

1. Railway → your project → **New** → **GitHub Repo** → `tonytheruthla/arclight`.
2. Settings → **Root Directory**: leave blank (repo root — that is where
   `draw-bot.js` and the `ethers` dependency live).
3. Settings → **Start Command**: `node draw-bot.js`
4. Settings → **Networking**: do **not** generate a domain. This is a worker,
   not a web service.
5. Variables → add:

```
TG_TOKEN = 8123456789:AAF...        (from BotFather)
TG_CHAT  = -1001234567890           (from getUpdates, keep the minus)
```

6. Deploy.

### Confirm it started

Deployments → click the top row → logs. You want:

```
[init] starting from block 21304xxx — no backfill, so a restart cannot spam the group
[init] draw 0x9f5dd4c61c84227835CA06E81077Bd6f8f3eDe52 · chat -100… · polling 20000ms
```

Then silence. **Silence is success right now.**

---

## Step 6 — Prove it can actually post

The bot will not speak on its own until a ticket is sold, so test the plumbing
directly. In a browser, with your real values:

```
https://api.telegram.org/bot<TOKEN>/sendMessage?chat_id=<CHAT_ID>&text=bot%20is%20wired
```

If "bot is wired" appears in @arclitefun, the token, the chat id and the admin
rights are all correct. Delete the message afterwards.

If it errors:

- `chat not found` → wrong chat id, or the minus sign got dropped.
- `bot is not a member of the group` → step 2 didn't finish.
- `not enough rights to send text messages` → it's in the group but not an admin.
- `Unauthorized` → wrong token.

---

## What it will post, when it eventually does

**At :56, only if a pot exists** — round closing, pot and ticket count per tier.

**On every `Drawn` event** — tier, winner, prize, ticket count, and an arcscan
tx link. Signed off with "No crying in the trenches."

**On a forced settlement** — that the chain drew without us and we forfeit the
fee. That post is the strongest thing the product can say about itself, and it
only happens when something went wrong on our side.

---

## Safety, recorded

- **Read-only.** No signer, no key, no write path. If the token leaks the worst
  case is nuisance messages in one group.
- **No backfill.** First run records the current block. A restart cannot replay
  history into the group.
- **Escaped output.** A token or address containing HTML cannot inject markup.
- **Silent on empty pots**, so the group never learns to mute it.

---

## If you want to turn it off

Railway → the service → Settings → **Remove**. Or set `PAUSED` — actually no,
that variable is the indexer's, not the bot's. Just stop or delete the service.
