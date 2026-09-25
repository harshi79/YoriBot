# 🤫 YoriBot — a real whisper bot + two-way anonymous inbox

**Send a message in a group that only one person can read.** That is a whisper, and
until now this repo didn't actually have one: it was an *anonymous inbox* bot
(secret deep link → strangers DM you → you reply, still anonymous). Both halves are
here now, built only on **free** Bot API features — no Telegram Premium, no paid
reactions, no stars.

Everything is designed around one interaction rule: **the UI updates in place.**
Panels, whispers, settings and stats are rewritten with `editMessageText` /
`editEphemeralMessageText` instead of being re-sent, so the chat never fills up
with the bot's own messages.

---

## 🚑 First: why the deploy aborted

> `Deploy aborted — the new version was not listening on any port during the 180s window.`

That is not a Telegram problem. Two things in the old entry point made it
impossible for a container platform to see the app come up:

1. **It opened no HTTP port at all.** The bot ran in long-poll mode: it dials
   *out* to `api.telegram.org/getUpdates` and nothing ever listens. The platform
   probes `$PORT` for 180s, hears nothing, rolls back. Long-polling bots on a PaaS
   are invisible by construction.
2. **It called `process.exit(1)` when `BOT_TOKEN` was missing.** On a first deploy
   the env var often isn't set yet, so the process died before it could ever bind.

Both are fixed at the architecture level, and there is now a **regression test**
that spawns the real entry point with no token and asserts a port opens.

The new boot contract (`src/index.js`):

| Step | Behaviour |
| --- | --- |
| 1 | Bind `0.0.0.0:$PORT` **before** touching Telegram. `/healthz` answers 200 from the first millisecond. |
| 2 | No token? Log a clear hint, keep the server up, retry every 30s. **Never exit.** |
| 3 | Bad token / network down? Same: server stays green, `/ready` reports 503. |
| 4 | `EADDRINUSE` → exit 1 (that *is* a real failure — another process owns the port). |
| 5 | Webhook requested but `setWebhook` fails → fall back to long-poll instead of dying. |
| 6 | Long-poll → `deleteWebhook` first, so a stale webhook can't steal updates. |
| 7 | `SIGTERM`/`SIGINT` → stop polling, flush the store, close the server, exit 0. |

Ops endpoints (all on the same port, no auth needed except the webhook):

| Route | Meaning |
| --- | --- |
| `GET /healthz` | 200 always — *"the process is alive"*. Use this as the platform health check. |
| `GET /ready` | 200 only when connected to Telegram — *"it's actually working"*. Use for readiness. |
| `GET /metrics` | JSON: uptime, mode, connected, users, whispers sent, rich-message gate, webhook errors. |
| `GET /` | A human-readable status page (same numbers, styled). |
| `POST /telegram/<token-hash>` | Webhook. Secret-token verified, 2 MB cap, ACKs before handling. |

Verified locally: with no token the server binds, `/healthz` → 200, `/ready` → 503,
`/metrics` → JSON, and with a bogus token it logs `Check BOT_TOKEN…` and keeps serving.

---

## ✨ What it does

### 🤫 Whispers (the new part)

`/w @someone your secret` in any group, or `@YourBot @someone your secret` from any
chat via inline mode. Delivery follows a **ladder** — it uses the strongest thing
the chat allows and degrades without ever leaking:

1. **Ephemeral message** (Bot API 10.2) — visible *only* to the recipient, in the
   group, auto-gone. Requires the bot to be a group admin; the first
   `chat_admin_required` / `not enough rights` error **latches** the capability off
   for that chat so we stop paying for doomed round-trips.
2. **Locked card** — a normal group message showing only *"🤫 a whisper for @alice"*
   with a button that works for one user id. Everyone else who taps it gets
   `"not for you"`. Tap → reveal (the card is edited into the secret), burn, or
   reply invisibly.
3. **Direct message** — if the sender wrote from a private chat, the target just
   gets a DM.

Media whispers (photo/video/voice/sticker/file) go out ephemerally too. If
ephemeral isn't available they are **refused** rather than turned into a public
card — a locked caption with a public photo would leak the whole point.

Other whisper features: multi-target (`/w @a @b 123456782 hi`), usernames *or*
numeric ids *or* `tg://user?id=`, self-destruct flags (`!1` one-time read,
`!5m`/`!2h`/`!1d` TTL), `!nosender`, `/r` invisible replies, `/whispers` history,
expiry sweeps that rewrite dead cards to *"expired"*, and a public-reply
interceptor (replying to a locked card in the group warns you instead of
broadcasting your answer).

### 🕵️ Anonymous inbox (kept and improved)

Secret deep link `t.me/YourBot?start=<token>` → friend types a message → it lands
in your DM with no name, no forward header, quoted as a thread. Reply to it and
your answer goes back to them **still anonymous**. Toggles per user: receiving
on/off, `protect_content`, spoiler reveal, auto-burn after N seconds, silent
delivery. Every delivery carries **🚩 Report** and **🚫 Block** buttons; reporting
blocks that sender and pings `ADMIN_ID`.

### 🕵️ Group anonymous Q&A

`/group` in any group → members tap a button, DM their question, and it is posted
to the group with no author. The asker gets a private ephemeral ack (Bot API
10.2), or a DM when the bot isn't an admin.

### 🎛 Smooth in-place editing

Every panel is a *session* the store points at (`{chatId, messageId,
ephemeralId, receiverId}`). Toggling a setting edits that message; when Telegram
says the message can't be edited any more (too old, deleted, wrong id, ephemeral
expired) the panel is **re-created and the session re-pointed** — the flow never
dead-ends. On top of that the adapter keeps a hash of every edit it has sent and
skips identical ones, turns `message is not modified` into a success, and knows
which errors mean "recreate it" versus "give up".

### 🛡 Safety and abuse

Hourly caps (global / per-pair / per-whisper) + minimum interval, a banned-phrase
filter applied before *any* delivery, report/block, and a reaction vocabulary
restricted to Telegram's official free emoji whitelist.

> **This one was a live bug.** The old code reacted with ✅ 📨 💌 ✨ 🤫 💬 🫣 🚩 —
> none of which are in the free `ReactionTypeEmoji` set, so every single reaction
> threw `REACTION_INVALID`. `src/reactions.js` now holds the 73-emoji whitelist and
> coerces any signal to the nearest legal emoji before it hits the API.

---

## 📚 The research behind it (free features, by Bot API version)

| Version | Feature | How YoriBot uses it | Fallback when unsupported |
| --- | --- | --- | --- |
| **10.3** (Aug 2026) | `replace_callback_query_message`, rich edits of ephemeral messages | Used where an edit must replace the button message | Classic `editMessageText` |
| **10.2** (Jul 2026) | **Ephemeral messages** — `ephemeral_message_parameters` on 13 send methods, `editEphemeralMessage{Text,Media,Caption,ReplyMarkup}`, `deleteEphemeralMessage`, `BotCommand.is_ephemeral`, `Message.receiver_user`/`ephemeral_message_id` | The whole whisper delivery layer, private acks, `/id` in groups, and group commands that leave no trace in the chat | Per-chat capability latch → locked card / DM |
| **10.1** (Jun 2026) | **Rich messages** — `sendRichMessage`, `InputRichMessageContent`, 32,768 UTF-8 **bytes** | The `/start` welcome and `/help` long-form when `RICH_MESSAGES=auto\|on` | Same HTML as the fallback twin; a capability error latches rich off for the process |
| **10.0** (May 2026) | **Guest mode** — `guest_message` update, `answerGuestQuery`, `User.supports_guest_queries` | `@YourBot @alice secret` works in chats the bot is **not** a member of | Silently ignored unless BotFather enables Guest Mode |
| 9.x | Inline mode (`is_personal`), reactions (`setMessageReaction`), `reply_parameters`, `link_preview_options`, `protect_content`, spoiler entities, per-scope `setMyCommands`, `setMyName/Description/ShortDescription` | Share cards, signal reactions, threading, no-preview cards, privacy toggles, self-registering command menu | Always available on every client |

Things deliberately **not** used, and why:

- **Premium-only reactions / custom emoji** — bots can only use the free emoji set,
  one reaction per message. Enforced in `src/reactions.js`.
- **`sendChecklist`** — requires a `business_connection_id` a normal bot can't get.
- **`message_effect_id`** — cosmetic, and effects only render on some clients.
- **Rich messages on by default** — they render as *"not supported"* on Telegram
  Web, so `RICH_MESSAGES=off` is the default and every rich send has an HTML twin.

---

## 🛠 Setup

```bash
npm install
cp .env.example .env     # then put your token in BOT_TOKEN
npm start
```

**[@BotFather](https://t.me/BotFather) checklist:**

1. `/newbot` → copy the token into `BOT_TOKEN`.
2. `/setinline` → enable **inline mode** (powers `@YourBot @someone secret` and the share card).
3. `/setprivacy` → **Disable** (so the bot sees the messages it needs in groups).
4. `/setjoingroups` → **Enable** (whispers need the bot in the group).
5. Optional: **Guest Mode** → enable, for whispers in chats the bot hasn't joined.
6. Optional: add the bot as **admin** in your groups — that unlocks true ephemeral
   whispers instead of locked cards.

Commands, descriptions and the profile are registered automatically on boot
(`SET_PROFILE=0` opts out). Never rename your bot by accident: `BOT_NAME` is empty
by default and the real name comes from `getMe`.

For `/wall`, create a public channel, add the bot as an admin with *Post messages*,
and set `CHANNEL_ID`.

---

## 📋 Commands

| Command | Where | Description |
| --- | --- | --- |
| `/start [token]` | private | Your link, or open someone else's anonymous inbox |
| `/w <who> <secret>` | anywhere | Whisper. `/w @alice hi`, `/w 12345678 hi`, `/w` for a guided flow |
| `/r <reply>` | anywhere | Invisible reply to your last whisper partner |
| `/whispers` | anywhere | Your whisper history |
| `/id` | anywhere | Your user id (ephemeral in groups) |
| `/menu` | private | Control panel — every toggle edits the same message |
| `/link` | private | Your anonymous link + share button |
| `/stats` | private | Received / sent / whispers |
| `/pause` · `/resume` | private | Stop / start receiving |
| `/group` · `/group off` · `/group stats` | group | Anonymous Q&A |
| `/wall <text>` | private | Anonymous confession to the public channel |
| `/cancel` | anywhere | Leave any compose flow |
| `/help` | anywhere | How it all works |
| `/admin` | admins | Live dashboard: users, whispers, opens/peeks/burns, reports, transport, rich gate — plus a **last reports** view |

In groups, `/w`, `/r`, `/id`, `/whispers` and `/link` are registered with
`is_ephemeral: true`, so they never appear in the group transcript.

---

## ⚙️ Configuration

Every variable is documented in [`.env.example`](.env.example). The ones that
matter most:

| Variable | Default | Notes |
| --- | --- | --- |
| `BOT_TOKEN` | — | Required for Telegram; the HTTP server starts without it. |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | `PORT=0` is legal (kernel-assigned). Always bind `0.0.0.0`. |
| `WEBHOOK_MODE` | `longpoll` | `longpoll` \| `auto` \| `force` \| `off`. |
| `WEBHOOK_URL` / `WEBHOOK_SECRET` | — | Path defaults to `/telegram/<hash-of-token>`; the secret is derived from the token when unset. |
| `RICH_MESSAGES` | `off` | `off` \| `auto` \| `on`. |
| `ALLOW_GUEST_MODE` | `1` | Bot API 10.0 guest queries. |
| `TYPING_INDICATORS` | `1` | `sendChatAction` before deliveries. |
| `CHANNEL_ID` / `ADMIN_ID` | — | `/wall` channel and abuse-report admin(s). |
| `GLOBAL_PER_HOUR`, `PAIR_PER_HOUR`, `WHISPER_PER_HOUR`, `MIN_INTERVAL_MS` | `80/40/40/1200` | Anti-abuse. |
| `WHISPER_TTL_MS`, `SWEEP_INTERVAL_MS` | `7 days`, `30s` | Locked-card lifetime and sweeper cadence. |
| `WHISPER_DATA` | `data/whisper.json` | **Mount a volume** in production, or state dies with the container. |
| `LOG_LEVEL`, `DEBUG_BOT` | `info`, `0` | `DEBUG_BOT=1` logs every swallowed best-effort failure. |

### Deploying

- **Railway / Render / Fly / any container PaaS**: `npm start`, health check
  `GET /healthz`, readiness `GET /ready`. Long-poll mode needs no public URL.
- **Public URL available?** Set `WEBHOOK_URL` (or `WEBHOOK_MODE=auto`) and the bot
  registers a secret-verified webhook; if `setWebhook` fails it falls back to
  long-poll rather than crashing.
- **Never run two instances in long-poll mode** — Telegram round-robins updates
  between pollers and your conversations will stutter. Webhook mode is the
  horizontal-scale path.
- **Persistence**: `WHISPER_DATA` is a single JSON file written atomically
  (temp file + `rename`) with debounced saves. Fine for one instance; swap
  `src/store.js` for SQLite/Postgres before you scale out — the engine only
  depends on its method names.

---

## ✅ Tests

```bash
npm test        # 38 checks, no token, no network
```

Three layers, all offline:

1. **Engine against a mock adapter** — inbox delivery and threading, owner replies,
   report/block, pause/resume, settings toggles, spoiler entities, auto-burn +
   sweeper, `/wall`, whisper parsing, the ephemeral → card → DM ladder, capability
   latching, media refusal, guided `/w` flow, expiry, inline share + whisper cards,
   `chosen_inline_result`, guest mode, group Q&A + DM ack fallback.
2. **Smooth-edit plumbing** — panel re-creation and session re-pointing, edit
   de-duplication, `message is not modified`, `UNEDITABLE`, reaction coercion,
   the rich gate, membership-change latch clearing, store persistence and pruning,
   the HTTP routes and webhook auth.
3. **Real client integration** — a genuine `node-telegram-bot-api` `Bot` with an
   injected `fetch` (the library's own test seam), fed real update objects. This
   proves every method name and parameter shape we send actually exists and
   serialises correctly: `ephemeral_message_parameters`, `reply_markup` as an
   object, `is_ephemeral` commands, `deleteEphemeralMessage`, `answerInlineQuery`
   with `is_personal`, `answerGuestQuery`, valid `setMessageReaction` emoji — and
   that unrelated group chatter costs **zero** API calls.

Plus the deploy regression test: spawn `src/index.js` with `PORT=0` and no token,
assert a port opens, `/healthz` returns 200, and `SIGTERM` exits 0.

---

## 🗂 Project layout

```
src/
  index.js      entry point: binds the port FIRST, then long-poll or webhook
  server.js     node:http — healthz / ready / metrics / status page / webhook
  telegram.js   real client wiring + the adapter (edit de-dupe, error taxonomy)
  engine.js     all handlers: inbox, whispers, groups, inline, guest, admin
  whisper.js    parsing, the delivery ladder, reveal / burn / expire / edit
  ui.js         keyboards + HTML builders
  store.js      users, groups, threads, sessions, whisper records, rate logs
  rich.js       RichGate: Bot API 10.1 rich messages with an HTML fallback
  reactions.js  the 73 free emoji + signal → legal emoji coercion
  errors.js     Telegram error → kind taxonomy (capability vs payload vs fatal)
  media.js      classify any message (incl. live_photo, poll, dice, venue)
  filter.js     banned-phrase abuse filter
  config.js     env parsing
test/
  selftest.js   38 offline checks incl. real-client integration + boot test
```

The engine never imports `node-telegram-bot-api`; it talks to a small adapter
(`sendText`, `sendMedia`, `sendNative`, `sendRich`, `editText`, `editRich`,
`editMarkup`, `editInline`, `editEphemeral`, `deleteMessage`, `deleteEphemeral`,
`react`, `typing`, `answerCb`, `answerInline`, `answerGuest`). That is why the
whole thing is testable without a token, and why swapping transports is cheap.

---

## 🔒 Privacy notes

- Messages are re-sent by `file_id`/text, never `forwardMessage` — the sender's
  identity is never in the payload.
- Whispers are stored only as much as the ladder requires: sender id, target ids,
  text and a TTL for the card flow. Ephemeral deliveries are additionally recorded
  so reveal/burn/expire can edit them; nothing is sent anywhere else.
- `protect_content` (opt-in) stops recipients forwarding or saving.
- Report/block is one tap and immediately stops that sender.
- Locked cards are keyed by user id: a wrong tapper gets `"not for you"` and learns
  nothing about the content.

---

Built as the *"ultimate whisper bot"* — invisible in groups, anonymous in DMs,
smooth in place, and free.
