# The Lucky Trencher draw bot

`draw-bot.js` + `test-draw-bot.js`. **41 tests pass, 0 fail.** No new packages.

## What it posts, and what it refuses to post

| when | message |
|---|---|
| :56, only if a pot exists | round closing, pot and ticket count per live tier |
| every `Drawn` event | tier, winner, prize, ticket count, tx link |
| `Settled` with `forced: true` | the chain drew without us, and we forfeit the fee |

**It says nothing when the pot is empty.** Twenty-four "$0" messages a day is how
a group learns to mute you, and right now most rounds will be empty. Silence is
a feature, and a test pins it.

Every draw message carries an arcscan tx link. A RECEIPT post without a
verifiable artifact is just a claim, so the link is not optional.

## Safety

- **Read-only.** No signer, no key, no write path. If the bot is compromised the
  worst case is nuisance messages. That is the correct blast radius for
  something running unattended.
- **The bot token is a secret.** Railway env var, never the repo — the repo is public.
- **No new dependencies.** `ethers` was already there; Telegram is plain HTTPS
  and Node has `fetch`.
- **Hostile input is escaped.** A token or address containing HTML cannot inject
  markup into a message. Tested.
- **No backfill on first run.** It records the current block and starts there, so
  a restart cannot replay history into the group.

## Setup

1. Message **@BotFather** → `/newbot` → copy the token.
2. Add the bot to **@arclitefun** and promote it to admin with post rights.
3. Get the chat id: post once in the group, then open
   `https://api.telegram.org/bot<TOKEN>/getUpdates` and read `chat.id`
   (group ids are negative, e.g. `-1001234567890`).

### See it before it posts anywhere

```
DRY=1 node draw-bot.js
```

Prints to stdout instead of Telegram. Nothing is sent.

### Run it

```
TG_TOKEN=... TG_CHAT=-100... node draw-bot.js
```

On Railway: new service, same repo, start command `node draw-bot.js`, with
`TG_TOKEN` and `TG_CHAT` as variables. It shares the region and RPC with the
indexer.

## Voice

Locked to the pillars: short declaratives, no hype verbs, the mechanism
described rather than the outcome promised. Never "gambling" or "casino" —
Arc is Circle's chain and a Circle employee should read every message without
wincing. Tests assert the banned list, and that no emoji appear.

Signature line on draw results: **No crying in the trenches.**

## Two bugs worth recording

**`filter(Boolean)` ate the blank lines.** `drawnMessage` built an array with
`''` entries as deliberate separators and an empty string for the absent jackpot
line, then filtered on truthiness — which removed all of them and collapsed the
message into a wall of text. Only visible by rendering it and looking. Now built
conditionally, with a test pinning the blank-line positions.

**"twenty" contains "wen".** The voice guard used `includes()` against a banned
word list, and the jackpot line — "One in twenty winning tickets" — failed the
"never says wen" check. Word boundaries, not substrings.
