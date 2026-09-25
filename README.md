# 🤖 WHoevenYori — the ultimate anonymous-message Telegram bot

WHoevenYori (`@WHoevenYori`) is an advanced anonymous inbox bot. Every user gets a
secret deep link; friends who open it can message them **anonymously**, and the
owner can **reply back — still anonymous** — in threaded conversations. It uses
only **free** Telegram Bot API features (no Premium required).

This is the most viral Telegram bot archetype: each user pulls in more users by
sharing their link in bios, stories, and groups.

## ✨ Features (what makes it "ultimate")

- **Two-way anonymous threads** — reply to any anonymous message and it's
  delivered back to the sender, still anonymous, quoted as a thread
  (`reply_parameters`).
- **Smooth in-place UI** — the compose panel and the control panel are edited
  live with `editMessageText` / `editMessageReplyMarkup`. No message spam.
- **Free reactions** (`setMessageReaction`) — ✅ sent, 👀 received, 💬 reply
  signals, all on the free emoji tier (bots can't use paid reactions).
- **Privacy controls** — `protect_content` (stops forwarding/saving) and
  `spoiler` (hides the message until tapped) toggles, per user.
- **Control panel** — inline keyboard with pause/resume, link, stats, protect,
  spoiler, wall, help, refresh. Toggling edits the same message.
- **Public confession wall** (`/wall`) — posts anonymous confessions to a public
  channel with a "send your own" button. This is the viral discovery engine.
- **Inline-mode sharing** — `@WHoevenYori` from *any* chat drops your link card.
- **Anti-abuse rate limiting** — global + per-pair hourly caps and a minimum
  interval, so a viral surge can't get you rate-limited or banned.
- **Deep linking** — `t.me/WHoevenYori?start=<token>` opens a specific inbox, and
  `?start=g_<token>` opens a group's anonymous Q&A.
- **🛡 Abuse filter + report/block** — a configurable banned-phrase/spam filter
  blocks junk before delivery; every received message has 🚩 Report / 🚫 Block
  buttons. Reporting blocks that sender and pings the admin. This is what keeps a
  viral bot from getting banned.
- **👥 Group "ask me anything"** — run `/group` in any group; members tap a button,
  DM their question, and it's posted to the group **with no author**. Perfect for
  communities, AMAs, and confessions.
- **⚡ Ephemeral confirmations (Bot API 10.2)** — after posting a group question,
  the asker gets a private, auto-deleting confirmation via `ephemeral_message_parameters`.
- **Admin reports** — abuse reports are forwarded to `ADMIN_ID`.

## 🛠 Setup

```bash
npm install
cp .env.example .env
```

1. Talk to [@BotFather](https://t.me/BotFather):
   - `/newbot` → choose a name and username (e.g. `WHoevenYori`).
   - Copy the **token** into `BOT_TOKEN` in `.env`.
   - `/setinline` → enable inline mode (powers the `@WHoevenYori` share card).
   - `/setcommands` → paste the commands listed in `src/telegram.js` (optional
     but nice; the bot also sets them automatically).
2. (Optional) Create a public channel, add the bot as admin with *Post
   messages*, and put its `@username` or `-100...` id into `CHANNEL_ID` to
   enable `/wall`.
3. Run:

```bash
npm start          # long-poll mode — works everywhere, no public URL needed
npm run selftest   # runs the full engine test suite (no token, no network)
```

For production with a public URL, set `WEBHOOK_URL` (and `WEBHOOK_SECRET`) and
the bot switches to webhook mode automatically.

## 📋 Commands

| Command | Description |
| --- | --- |
| `/start` | Get your anonymous link (or open someone's link via `?start=TOKEN`) |
| `/menu` | Open the control panel |
| `/link` | Show your anonymous link + share button |
| `/pause` · `/resume` | Stop / start receiving messages |
| `/stats` | Your received / sent counts |
| `/wall <text>` | Post an anonymous confession to the public channel |
| `/group` | Turn on anonymous Q&A in a group (`/group off` / `/group stats`) |
| `/cancel` | Leave anonymous mode |
| `/help` | How it works |

Every message you receive also has **🚩 Report** and **🚫 Block** inline buttons.

## 🧠 How the conversation works

```
Friend opens your link  ──►  types a message  ──►  you receive it privately
        │                                                     │
        └──────────────── you REPLY to it ────────────────────┘
                     (delivered back, still anonymous, threaded)
```

## 🚀 Going viral (deployment + growth)

- **Host it**: Railway / Render / Fly as a web service, or any VM with Node 18+.
  Long-poll mode needs no public URL.
- **Seed it**: post your own `@WHoevenYori` link in your bio, Instagram/Twitter
  bio, WhatsApp status, and a few Telegram groups.
- **The loop**: everyone who messages you anonymously gets hooked, shares *their*
  link, and pulls in more users. The public `/wall` channel compounds this by
  putting the bot in front of fresh eyes constantly.
- **Data**: the default JSON store is great for prototyping. Swap `src/store.js`
  for SQLite/Postgres before you hit serious scale — the engine only depends on
  the method names, not the storage backend.

## 🗂 Project layout

```
src/
  store.js     persistent data (users, sessions, threads, rate logs)
  media.js     normalize a Telegram message for anonymous forwarding
  engine.js    all business logic (framework-agnostic, fully tested)
  telegram.js  grammY-style wiring + the tiny bot adapter
  config.js    env-based configuration
  index.js     entry point (long-poll or webhook)
test/
  selftest.js  end-to-end engine tests with a mock adapter
```

## 🔒 Privacy notes

- Messages are re-sent by `file_id`, never `forwardMessage`, so the sender is
  never revealed.
- `protect_content` (opt-in) prevents recipients from forwarding/saving.
- No message content leaves Telegram's servers; the bot stores only chat ids,
  a random token, and thread mapping.

---
Built as the "ultimate Whisper bot" — anonymous, threaded, smooth, and free.
