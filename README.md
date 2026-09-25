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

1. **Ephemeral message** (Bot API 10.2/10.3) — visible *only* to the recipient
   in the group while their client displays it. It may disappear, and Telegram
   does **not guarantee delivery**, especially to offline recipients. Requires
   the bot to be a group admin; the first
   `chat_admin_required` / `not enough rights` error **latches** the capability off
   for that chat so we stop paying for doomed round-trips.
2. **Locked card** — a normal group message showing only *"🤫 a whisper for @alice"*
   with a button authorized for its intended reader(s) and, by default, sender.
   Everyone else who taps it gets `"not for you"`. Tap → reveal text in a private
   popup; the card only
   updates its status (it never publishes the secret).
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

### 💬 Inline whispers (sender label optional)

Enable inline mode with `/setinline` in @BotFather, then type in any chat and
**select the whisper card** from the results:

| Type in the chat | Card shows | Secret shows to |
| --- | --- | --- |
| `@YourBot @alice meet me at 8` | "Whisper from @you to @alice" | Only @alice (and the sender) when they tap **Open** |
| `@YourBot 123456789 meet me at 8 0` | "Whisper for user 123456789" (no sender label) | Only user 123456789 (and the sender) when they tap **Open** |

A username may also be written without `@` as the **first** target. The final
`0` must be a separate token at the very end: it is a privacy switch, **not**
part of the secret. To end a message with a literal zero, write `\0` instead.
`!anon` still hides the label; `!sign` still displays it, except a final `0`
takes priority. `/w` and guest whispers keep their previous anonymous-by-default
behaviour. The posted card never contains the secret text. Inline cards reveal
through the **Open** button; unlike a `/w` whisper in a group, they cannot set up
an in-chat `/r` reply context. Short text fits the private callback popup; **longer
text** opens via a recipient-checked deep link in the bot's DM, in full instead
of being truncated. The configured text limit still applies (at most 3,900
characters for this route so the private Telegram message can include a header).

#### 🖼 Private media behind an inline card

1. In a **DM with the bot**, send `/wi @alice` (or `/wi 123456789 0` to omit the
   sender label). Optional flags such as `!1` (one-time), `!5m` (expiry), and
   `!nosender` go **before** the target: `/wi !1 @alice 0`. You can include a short
   caption after the target.
2. Send a photo, video, GIF, or document **to the bot in that DM**. The bot stages
   the Telegram `file_id` and privately gives you a **Choose a chat** button.
3. Select the **text-only locked card** in the destination chat. Neither the image
   nor its caption/file ID is present in the public inline result.
4. The recipient (and sender, unless `!nosender` was set) can tap **Open** and
   follow the bot deep link. The bot rechecks the actor's user ID/username and
   expiry, then sends the file in
   their own **DM** with `protect_content` (and photo/video/GIF spoiler). Reopening
   edits the existing private message when possible. For `!1`, the card burns
   after successful delivery and the private message is scheduled for deletion
   30 seconds later. They may have to start the bot before a DM can be sent.

This does **not** put a secretly viewable image in the originating inline chat.
Telegram's photo-type inline results publish the image to the whole chat, even
under a spoiler or a collapsed rich block. Inline callbacks give the bot an
`inline_message_id`, **not** a destination `chat_id` suitable for private media
delivery there; `chat_instance` is not a chat ID. A DM is the safe supported path.
`/w` group media whispers still use the existing ephemeral-or-refuse ladder.

**Important:** Telegram displays the account that posts an inline message in the
chat. `0` only hides the sender's name *in the bot's card and reveal*, not that
Telegram attribution. For a private bot-posted whisper, use `/w` in a group where
the bot can send ephemeral messages; do not rely on inline mode for true anonymity.

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
which errors mean "recreate it" versus "give up". Private photo reopens use
`editMessageMedia` with an existing `file_id`, while rich dashboards use
`editMessageText` with `rich_message` instead of generating another message.

`/admin` is **private-chat only**. With `RICH_MESSAGES=auto` or `on`, the dashboard
is a real structured `InputRichBlockTable` (header cells, striped/compact rows),
not a simulated monospaced table. **Refresh** and **Last reports** edit that same
panel in place; capability failures latch rich off and fall back to classic HTML.
Rich mode defaults to **off** because not every Telegram client supports rich
blocks yet. The bot can detect a **server** capability error, not a client that
renders a successful rich message as unsupported; keep rich off for those users.
The classic HTML view works without configuration.

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

Based on the official [1](https://core.telegram.org/bots/api-changelog) and the
[2](https://core.telegram.org/bots/api) method/type definitions (checked September
2026). These are **Bot API versions, not subscription tiers**:

| Version | Supported free feature | Use in YoriBot / deliberate scope |
| --- | --- | --- |
| **10.3** (Aug 2026) | Consolidated `EphemeralMessageParameters`; `replace_callback_query_message`; compact rich tables; rich ephemeral edits | Whisper delivery uses `ephemeral_message_parameters`, admin table sets `is_compact`. We **do not** claim callback replacement enables inline-photo secrecy. |
| **10.2** (Jul 2026) | Ephemeral group messages/edits/deletes; `BotCommand.is_ephemeral`; `InputRichMessage.blocks` including actual table blocks | `/w`, `/r`, private group acks, ephemeral commands; `/admin` uses table blocks opt-in. If unavailable, media `/w` fails closed and text uses a locked card. |
| **10.1** (Jun 2026) | `sendRichMessage`, rich-message editing through `editMessageText`, `InputRichMessageContent` | Optional rich welcome/help/dashboard with a separate HTML fallback; large rich payloads are conservatively capped at 32 KiB. |
| **10.0** (May 2026) | Guest queries, `answerGuestQuery`; business accounts no longer require Premium for bot integration | Optional guest whisper cards when enabled in BotFather. No business integration is needed. |
| **9.5** (Mar 2026) | `sendMessageDraft` became available to **all** bots; date-time entities | Draft streaming isn't needed for a short whisper and isn't enabled just for appearance. |
| **9.4** (Feb 2026) | `InlineKeyboardButton.style`; custom emoji buttons still depend on owner Premium in some contexts | Free primary/danger styles on new share/admin buttons, without custom emoji IDs. |
| **9.3** (Dec 2025) | Private-chat topics and drafts | Existing DM compose sessions work without enabling topics. |
| **9.2** (Aug 2025) | Checklist-task replies | No checklist-dependent flow. |
| **9.1** (Jul 2025) | Checklist send/edit methods **on behalf of business accounts** | Not a general-purpose checklist for a standalone free whisper bot. |
| Earlier | Inline cards, callback deep links, free reaction emoji, `protect_content`, spoilers, `editMessageMedia` | Locked cards, private media, edit-in-place and fallbacks continue to work without rich support. |

Things deliberately **not** used, and why:

- **Premium-dependent custom emoji decorations and paid reactions**. Reactions
  are restricted to Telegram's documented free emoji choices (`src/reactions.js`).
- **`sendChecklist`**: its business-account context is separate from a normal bot
  whisper, even though business integration itself need not require Premium.
- **`sendMessageDraft`**: it is free now, but streaming drafts are unnecessary for
  short whispers and don't make an inline photo private.
- **Rich messages on by default**: some clients may show *"not supported"* for
  rich blocks, so `RICH_MESSAGES=off` is the default and rich sends have HTML twins.

---

## 🛠 Setup

```bash
npm install
cp .env.example .env     # then put your token in BOT_TOKEN
npm start
```

**[@BotFather](https://t.me/BotFather) checklist:**

1. `/newbot` → copy the token into `BOT_TOKEN`.
2. `/setinline` → enable **inline mode** (powers `@YourBot @someone secret [0]` and the share card).
3. `/setinlinefeedback` → enable chosen-result updates (choose 100% if offered).
   This lets the bot track the posted card's `inline_message_id` at selection and
   update its status/expiry before anyone taps it. Without feedback, private
   reveal still works; the bot may learn that ID only when a callback is tapped,
   so unopened cards can remain visually stale after expiry.
4. `/setprivacy` → **Disable** (so the bot sees the messages it needs in groups).
5. `/setjoingroups` → **Enable** (whispers need the bot in the group).
6. Optional: **Guest Mode** → enable, for whispers in chats the bot hasn't joined.
7. Optional: add the bot as **admin** in your groups — that unlocks true ephemeral
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
| `/start [token]` | private | Your link, open an anonymous inbox or open an authorized `wm_` inline whisper |
| `/w <who> <secret>` | anywhere | Whisper. `/w @alice hi`, `/w 12345678 hi`, `/w` for a guided flow |
| `/wi <who> [0]` | private | Stage a photo/video/GIF/document and share a text-only inline card; `0` hides sender label |
| `@YourBot <who> <secret> [0]` | inline, anywhere | Locked card; shows sender → recipient unless a final `0` hides the sender label |
| `/r <reply>` | anywhere | Invisible reply to your last whisper partner |
| `/whispers` | anywhere | Your history; private ephemeral reply in groups or DM fallback |
| `/id` | anywhere | Your user id; private ephemeral reply in groups or DM fallback |
| `/menu` | private | Control panel — every toggle edits the same message |
| `/link` | private | Your anonymous link + share button |
| `/stats` | private | Received / sent / whispers |
| `/pause` · `/resume` | private | Stop / start receiving |
| `/group` · `/group off` · `/group stats` | group | Anonymous Q&A |
| `/wall <text>` | private | Anonymous confession to the public channel |
| `/cancel` | anywhere | Leave any compose flow |
| `/help` | anywhere | How it all works |
| `/admin` | admin DM | Private dashboard with opt-in rich table, HTML fallback, in-place **Refresh** and **Last reports** |

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
npm test        # 56 checks, no token, no Telegram network
```

Three layers, all offline:

1. **Engine against a mock adapter** — inbox delivery and threading, owner replies,
   report/block, pause/resume, settings toggles, spoiler entities, auto-burn +
   sweeper, `/wall`, whisper parsing, the ephemeral → card → DM ladder, capability
   latching, media refusal, guided `/w` flow, expiry, inline share + whisper cards,
   `chosen_inline_result`, guest mode, group Q&A + DM ack fallback, inline media
   staging/auth/expiry/burn, long-text DM reveal and private-only history fallback.
2. **Smooth-edit plumbing** — panel re-creation and session re-pointing, text/
   rich/media edit de-duplication, `message is not modified`, `UNEDITABLE`,
   capability latch + HTML fallback, actual rich table blocks, admin refresh,
   membership-change latch clearing, store persistence/pruning and HTTP auth.
3. **Real client integration** — a genuine `node-telegram-bot-api` `Bot` with an
   injected `fetch` (the library's own test seam), fed real update objects. This
   verifies the method names and wire shapes (not a live Telegram acceptance test):
   `ephemeral_message_parameters`, `editMessageMedia`, `sendRichMessage`, rich
   `editMessageText`, `reply_markup` as an object, `is_ephemeral` commands,
   `deleteEphemeralMessage`, personal inline articles, protected private photo
   delivery, guest queries and free reactions — and unrelated group chatter
   costs **zero** API calls.

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
  selftest.js   56 offline checks incl. real-client integration + boot test
```

The engine never imports `node-telegram-bot-api`; it talks to a small adapter
(`sendText`, `sendMedia`, `sendNative`, `sendRich`, `editText`, `editRich`,
`editMedia`, `editMarkup`, `editInline`, `editEphemeral`, `deleteMessage`, `deleteEphemeral`,
`react`, `typing`, `answerCb`, `answerInline`, `answerGuest`). That is why the
whole thing is testable without a token, and why swapping transports is cheap.

---

## 🔒 Privacy notes

- Media is re-sent privately by Telegram `file_id`, **never** `forwardMessage`;
  the inline result contains only a text card. Sender names can be shown on signed
  cards, and **Telegram always shows who posted an inline message**.
- Whisper text, private captions, file IDs, sender/target IDs and expiry are
  stored in the bot's JSON data file until cleanup. Protect the mounted volume;
  bots and Telegram are not end-to-end-encrypted storage.
- The protected inline-media DM uses `protect_content` to inhibit forwarding and
  saving; **it cannot prevent screenshots or someone photographing a screen**.
  One-time deletion is best-effort, not a cryptographic self-destruct.
- When a target is specified **only by username** and the bot has no ID for it,
  anyone who currently controls that username may be the first opener. Successful
  authorization binds the ID for later opens. For stronger targeting, use a
  numeric Telegram ID, especially if usernames can change hands.
- Signed inline cards name sender and recipient; a final `0` removes the bot's
  sender label but never Telegram's original inline post attribution. The sender
  may also re-open their own whisper unless `!nosender` is set.
- If private delivery isn't possible, inline media stays locked instead of being
  posted publicly; `/whispers`, `/id`, menu and link fall back to DM or a generic
  group hint rather than posting private state into the group.
- Report/block is one tap and stops subsequent anonymous deliveries.

---

Built as the *"ultimate whisper bot"* — invisible in groups, anonymous in DMs,
smooth in place, and free.
