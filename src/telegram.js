'use strict';
/*
 * Telegram wiring for YoriBot, on `node-telegram-bot-api` v2 (Bot API 10.3).
 *
 * This layer does three jobs:
 *   1. Translate the wire API into the tiny adapter interface the engine uses.
 *   2. Make in-place editing SMOOTH: identical edits are skipped client-side,
 *      "message is not modified" is swallowed, and genuinely un-editable
 *      messages are reported so the engine can re-create the panel instead of
 *      leaving a stale one on screen.
 *   3. Register commands (including *ephemeral* group commands, Bot API 10.2)
 *      and the bot's public profile.
 */
const crypto = require('crypto');
const { Bot } = require('node-telegram-bot-api');

const Store = require('./store');
const engine = require('./engine');
const config = require('./config');
const ui = require('./ui');
const { RichGate } = require('./rich');
const { classifyError, KINDS } = require('./errors');
const { reactionOf } = require('./reactions');

const UPDATES_WE_HANDLE = [
  'message', 'callback_query', 'inline_query', 'chosen_inline_result',
  'guest_message', 'my_chat_member'
];

const hashOf = (v) => crypto.createHash('sha1').update(JSON.stringify(v)).digest('base64').slice(0, 22);

// ------------------------------------------------------------------- adapter

function createAdapter(bot, opts = {}) {
  const editCache = new Map();   // `${kind}:${chat}:${msg}` -> payload hash
  const MAX_EDIT_CACHE = 4000;

  const remember = (key, h) => {
    if (editCache.size >= MAX_EDIT_CACHE) {
      const oldest = editCache.keys().next().value;
      if (oldest !== undefined) editCache.delete(oldest);
    }
    editCache.set(key, h);
  };

  /**
   * One edit path for every flavour of edit.
   * Skips no-ops, tolerates "not modified", and re-throws un-editable messages
   * tagged so the engine can rebuild the panel.
   */
  async function smartEdit(kind, key, payload, call) {
    const h = hashOf(payload);
    if (editCache.get(key) === h) return { ok: true, skipped: true };
    try {
      const r = await call();
      remember(key, h);
      return r === undefined ? { ok: true } : r;
    } catch (err) {
      const c = classifyError(err);
      if (c.kind === KINDS.NOT_MODIFIED) { remember(key, h); return { ok: true, noop: true }; }
      if (c.kind === KINDS.UNEDITABLE || c.kind === KINDS.NOT_FOUND) {
        editCache.delete(key);
        throw Object.assign(err, { tg: { kind: c.kind } });
      }
      throw err;
    }
  }

  const adapter = {
    username: opts.username || 'YoriBot',
    name: opts.name || 'YoriBot',
    richGate: opts.richGate || null,
    api: bot.api,
    /** Drop the edit cache (e.g. after the process learns a message was deleted). */
    forgetEdits: () => editCache.clear(),

    async sendText(chatId, text, o = {}) {
      return bot.api.sendMessage({ chat_id: chatId, text, ...o });
    },

    async sendMedia(chatId, type, fileId, caption, o = {}, payload = {}) {
      const base = { chat_id: chatId, caption: caption || undefined, ...o };
      switch (type) {
        case 'photo': return bot.api.sendPhoto({ ...base, photo: fileId });
        case 'live_photo':
          // Bot API 10.x: a live photo is the motion file PLUS its still frame.
          return bot.api.sendLivePhoto({ ...base, live_photo: fileId, photo: payload.photo || fileId });
        case 'sticker': return bot.api.sendSticker({ chat_id: chatId, sticker: fileId, ...o });
        case 'voice': return bot.api.sendVoice({ ...base, voice: fileId });
        case 'audio': return bot.api.sendAudio({ ...base, audio: fileId });
        case 'video': return bot.api.sendVideo({ ...base, video: fileId });
        case 'video_note': return bot.api.sendVideoNote({ chat_id: chatId, video_note: fileId, ...o });
        case 'animation': return bot.api.sendAnimation({ ...base, animation: fileId });
        case 'document': return bot.api.sendDocument({ ...base, document: fileId });
        default: return bot.api.sendMessage({ chat_id: chatId, text: caption || '📨 (unsupported media)', ...o });
      }
    },

    /** Payloads that are re-created by value, not re-sent by file_id. */
    async sendNative(chatId, type, params = {}, caption, o = {}) {
      switch (type) {
        case 'contact':
          return bot.api.sendContact({
            chat_id: chatId, phone_number: params.phone_number, first_name: params.first_name,
            last_name: params.last_name, vcard: params.vcard, ...o
          });
        case 'location':
          return bot.api.sendLocation({ chat_id: chatId, latitude: params.latitude, longitude: params.longitude, ...o });
        case 'venue':
          return bot.api.sendVenue({
            chat_id: chatId, latitude: params.latitude, longitude: params.longitude,
            title: params.title, address: params.address,
            foursquare_id: params.foursquare_id, foursquare_type: params.foursquare_type, ...o
          });
        case 'dice':
          return bot.api.sendDice({ chat_id: chatId, emoji: params.emoji || '🎲', ...o });
        case 'poll':
          return bot.api.sendPoll({
            chat_id: chatId, question: params.question, options: params.options || [],
            is_anonymous: params.is_anonymous, type: params.type,
            allows_multiple_answers: params.allows_multiple_answers, ...o
          });
        default:
          return bot.api.sendMessage({ chat_id: chatId, text: caption || '📨 (unsupported)', ...o });
      }
    },

    /** Bot API 10.1 rich message — the caller (src/rich.js) owns the fallback. */
    async sendRich(chatId, content, o = {}) {
      const { parse_mode, entities, link_preview_options, ...rest } = o;
      return bot.api.sendRichMessage({ chat_id: chatId,
        rich_message: typeof content === 'string' ? { html: content } : content, ...rest });
    },

    async editText(chatId, messageId, text, o = {}) {
      const key = `t:${chatId}:${messageId}`;
      return smartEdit('text', key, { text, markup: o.reply_markup },
        () => bot.api.editMessageText({ chat_id: chatId, message_id: messageId, text, ...o }));
    },

    async editRich(chatId, messageId, content, o = {}) {
      const key = `r:${chatId}:${messageId}`;
      const { reply_markup } = o;
      const rich_message = typeof content === 'string' ? { html: content } : content;
      return smartEdit('rich', key, { rich_message, markup: reply_markup },
        () => bot.api.editMessageText({ chat_id: chatId, message_id: messageId, rich_message, reply_markup }));
    },

    async editMarkup(chatId, messageId, replyMarkup) {
      const key = `m:${chatId}:${messageId}`;
      return smartEdit('markup', key, replyMarkup,
        () => bot.api.editMessageReplyMarkup({ chat_id: chatId, message_id: messageId, reply_markup: replyMarkup }));
    },

    /** Refresh an already-delivered private photo/file in place instead of spamming a DM. */
    async editMedia(chatId, messageId, type, fileId, caption, o = {}) {
      const media = { type, media: fileId, caption: caption || undefined,
        parse_mode: o.parse_mode,
        ...(o.has_spoiler && ['photo', 'video', 'animation'].includes(type) ? { has_spoiler: true } : {}) };
      const key = `md:${chatId}:${messageId}`;
      return smartEdit('media', key, { media, markup: o.reply_markup },
        () => bot.api.editMessageMedia({ chat_id: chatId, message_id: messageId, media, reply_markup: o.reply_markup }));
    },

    /** Inline-mode messages: only an inline_message_id, no chat. */
    async editInline(inlineMessageId, text, o = {}) {
      const key = `i:${inlineMessageId}`;
      return smartEdit('inline', key, { text, markup: o.reply_markup },
        () => bot.api.editMessageText({ inline_message_id: inlineMessageId, text, ...o }));
    },

    /** Bot API 10.2: editing a message only one user can see, inside a group. */
    async editEphemeral(chatId, receiverUserId, ephemeralMessageId, text, o = {}) {
      const key = `e:${chatId}:${receiverUserId}:${ephemeralMessageId}`;
      return smartEdit('ephemeral', key, { text, markup: o.reply_markup },
        () => bot.api.editEphemeralMessageText({
          chat_id: chatId, receiver_user_id: Number(receiverUserId),
          ephemeral_message_id: Number(ephemeralMessageId), text,
          parse_mode: o.parse_mode, entities: o.entities, reply_markup: o.reply_markup
        }));
    },

    async deleteMessage(chatId, messageId) {
      editCache.delete(`t:${chatId}:${messageId}`);
      editCache.delete(`m:${chatId}:${messageId}`);
      editCache.delete(`md:${chatId}:${messageId}`);
      return bot.api.deleteMessage({ chat_id: chatId, message_id: messageId });
    },

    async deleteEphemeral(chatId, receiverUserId, ephemeralMessageId) {
      return bot.api.deleteEphemeralMessage({
        chat_id: chatId, receiver_user_id: Number(receiverUserId),
        ephemeral_message_id: Number(ephemeralMessageId)
      });
    },

    /**
     * Reactions: bots get ONE free-tier emoji per message. `reactionOf` coerces
     * anything invalid onto the whitelist, because `REACTION_INVALID` is the
     * single most common silent failure here.
     */
    async react(chatId, messageId, emoji) {
      if (!messageId) return false;
      return bot.api.setMessageReaction({
        chat_id: chatId, message_id: Number(messageId), reaction: reactionOf(emoji)
      });
    },

    async typing(chatId, action = 'typing') {
      return bot.api.sendChatAction({ chat_id: chatId, action });
    },

    async answerCb(cbId, o = {}) {
      return bot.api.answerCallbackQuery({ callback_query_id: cbId, ...o });
    },

    async answerInline(queryId, results, o = {}) {
      return bot.api.answerInlineQuery({ inline_query_id: queryId, results, cache_time: 0, ...o });
    },

    async answerGuest(guestQueryId, result) {
      return bot.api.answerGuestQuery({ guest_query_id: guestQueryId, result });
    }
  };

  return adapter;
}

// ------------------------------------------------------------------ commands

const PRIVATE_COMMANDS = [
  { command: 'start', description: 'Your anonymous link + how whispers work' },
  { command: 'w', description: 'Whisper someone (only they can read it)' },
  { command: 'wi', description: 'Share a private photo through an inline locked card' },
  { command: 'r', description: 'Invisible reply to a whisper' },
  { command: 'menu', description: 'Control panel' },
  { command: 'link', description: 'Your anonymous link' },
  { command: 'id', description: 'Your user id' },
  { command: 'whispers', description: 'Your whisper history' },
  { command: 'stats', description: 'Your numbers' },
  { command: 'pause', description: 'Stop receiving messages' },
  { command: 'resume', description: 'Start receiving messages' },
  { command: 'wall', description: 'Post an anonymous confession' },
  { command: 'group', description: 'Anonymous Q&A in a group' },
  { command: 'cancel', description: 'Leave anonymous mode' },
  { command: 'help', description: 'How it works' }
];

/*
 * Group commands. `is_ephemeral` (Bot API 10.2) hides the member's own message
 * from everybody else — which is the whole point of `/w` and `/r`. Older Bot API
 * servers reject the unknown field, so we retry without it.
 */
const GROUP_COMMANDS = [
  { command: 'w', description: '🤫 Whisper someone — only they can read it', is_ephemeral: true },
  { command: 'r', description: '↩️ Invisible reply to a whisper', is_ephemeral: true },
  { command: 'id', description: '🆔 Your user id (private)', is_ephemeral: true },
  { command: 'group', description: '🕵️ Anonymous Q&A in this group' },
  { command: 'whispers', description: '🤫 Your whispers (private)', is_ephemeral: true },
  { command: 'link', description: '🔗 Your anonymous link (private)', is_ephemeral: true },
  { command: 'menu', description: '🎛 Control panel' },
  { command: 'cancel', description: '🚪 Leave anonymous mode' },
  { command: 'help', description: '❓ How it works' }
];

async function registerCommands(bot) {
  const scopes = [
    { commands: PRIVATE_COMMANDS, scope: undefined },
    { commands: GROUP_COMMANDS, scope: { type: 'all_group_chats' } }
  ];
  for (const { commands, scope } of scopes) {
    try {
      await bot.api.setMyCommands({ commands, scope });
    } catch (err) {
      // Older servers don't know `is_ephemeral` yet: retry with it stripped.
      const stripped = commands.map(({ is_ephemeral, ...rest }) => rest);
      try { await bot.api.setMyCommands({ commands: stripped, scope }); } catch { /* cosmetic */ }
    }
  }
}

async function setupProfile(bot, cfg) {
  if (!cfg.setProfile) return;
  const jobs = [];
  if (cfg.botName) jobs.push(bot.api.setMyName({ name: cfg.botName }));
  if (cfg.botDescription) jobs.push(bot.api.setMyDescription({ description: cfg.botDescription }));
  if (cfg.botShortDescription) jobs.push(bot.api.setMyShortDescription({ short_description: cfg.botShortDescription }));
  const results = await Promise.allSettled(jobs);
  if (process.env.DEBUG_BOT) {
    for (const r of results) if (r.status === 'rejected') console.warn('[profile]', r.reason && r.reason.message);
  }
}

// --------------------------------------------------------------------- build

function buildBot(token, overrides = {}) {
  const cfg = {
    botUsername: overrides.botUsername || config.BOT_USERNAME,
    botName: overrides.botName || config.BOT_NAME,   // null => use the real bot name
    channelId: overrides.channelId || config.CHANNEL_ID,
    adminIds: overrides.adminIds || config.ADMIN_IDS,
    globalPerHour: config.GLOBAL_PER_HOUR,
    pairPerHour: config.PAIR_PER_HOUR,
    whisperPerHour: config.WHISPER_PER_HOUR,
    minIntervalMs: config.MIN_INTERVAL_MS,
    maxWhisperLength: config.MAX_WHISPER_LENGTH,
    maxWhisperTargets: config.MAX_WHISPER_TARGETS,
    whisperTtlMs: config.WHISPER_TTL_MS,
    richMessages: config.RICH_MESSAGES,
    setProfile: config.SET_PROFILE,
    transport: overrides.transport || 'longpoll',
    uptime: overrides.uptime || (() => 'n/a'),
    ...overrides
  };
  cfg.adminId = cfg.adminIds && cfg.adminIds[0] ? cfg.adminIds[0] : config.ADMIN_ID;

  const bot = new Bot(token, {
    /*
     * The library already retries 429 (honouring retry_after), network errors
     * and 5xx with jittered backoff. On top of that we throttle the GLOBAL rate
     * to stay inside Telegram's ~30 msg/s budget during a surge — but we
     * deliberately do NOT throttle per chat: a burst to one chat (delivery +
     * panel edit + reaction) is normal, and spacing it out by a second each
     * would make the UI feel laggy. If Telegram objects it answers 429 and the
     * transport waits exactly as long as it must.
     */
    maxRetries: 2,
    retryBackoffMs: 400,
    rateLimit: { global: 20 },
    ...(overrides.botOptions || {})
  });

  const store = overrides.store || new Store(overrides.dataFile || config.DATA_FILE);
  const richGate = new RichGate(cfg.richMessages);
  cfg.richGate = richGate;
  const adapter = createAdapter(bot, {
    username: cfg.botUsername || 'YoriBot',
    // Overridden by bootstrap() with the bot's real first_name when BOT_NAME
    // was not explicitly configured.
    name: cfg.botName || 'YoriBot',
    richGate,
    store
  });

  const M = (ctx) => ctx.message;

  // ---- commands (registered before the catch-all message handler) ----
  bot.command('start', (ctx) => { const m = M(ctx); if (m) return engine.handleStart(adapter, store, m); });
  bot.command(['w', 'whisper', 'psst', 'tell'], (ctx) => { const m = M(ctx); if (m) return engine.handleWhisper(adapter, store, m, cfg); });
  bot.command('wi', (ctx) => { const m = M(ctx); if (m) return engine.handleInlineMedia(adapter, store, m, cfg); });
  bot.command(['r', 'reply', 'rw'], (ctx) => { const m = M(ctx); if (m) return engine.handleReply(adapter, store, m, cfg); });
  bot.command('id', (ctx) => { const m = M(ctx); if (m) return engine.handleId(adapter, store, m); });
  bot.command(['whispers', 'ws'], (ctx) => { const m = M(ctx); if (m) return engine.handleWhispers(adapter, store, m); });
  bot.command(['pause', 'stop', 'off'], (ctx) => { const m = M(ctx); if (m) return engine.handlePause(adapter, store, m); });
  bot.command(['resume', 'on'], (ctx) => { const m = M(ctx); if (m) return engine.handleResume(adapter, store, m); });
  bot.command('link', (ctx) => { const m = M(ctx); if (m) return engine.handleLink(adapter, store, m); });
  bot.command('stats', (ctx) => { const m = M(ctx); if (m) return engine.handleStats(adapter, store, m); });
  bot.command(['menu', 'settings', 'panel'], (ctx) => { const m = M(ctx); if (m) return engine.handleMenu(adapter, store, m); });
  bot.command('cancel', (ctx) => { const m = M(ctx); if (m) return engine.handleCancel(adapter, store, m); });
  bot.command(['help', 'about'], (ctx) => { const m = M(ctx); if (m) return engine.handleHelp(adapter, store, m, cfg); });
  bot.command('group', (ctx) => { const m = M(ctx); if (m) return engine.handleGroup(adapter, store, m); });
  bot.command('wall', (ctx) => { const m = M(ctx); if (m) return engine.handleWall(adapter, store, m, cfg); });
  bot.command('admin', (ctx) => { const m = M(ctx); if (m) return engine.handleAdmin(adapter, store, m, cfg); });

  // ---- everything else ----
  bot.on('message', (ctx) => { const m = M(ctx); if (m) return engine.handleMessage(adapter, store, m, cfg); });
  bot.on('callback_query', (ctx) => { if (ctx.callbackQuery) return engine.handleCallback(adapter, store, ctx.callbackQuery, cfg); });
  bot.on('inline_query', (ctx) => { if (ctx.inlineQuery) return engine.handleInline(adapter, store, ctx.inlineQuery, cfg); });
  bot.on('chosen_inline_result', (ctx) => {
    const r = ctx.update && ctx.update.chosen_inline_result;
    if (r) return engine.handleChosenInlineResult(adapter, store, r);
  });
  bot.on('guest_message', (ctx) => {
    const m = ctx.update && ctx.update.guest_message;
    if (m && config.ALLOW_GUEST_MODE) return engine.handleGuest(adapter, store, m, cfg);
  });
  bot.on('my_chat_member', (ctx) => {
    const u = ctx.update && ctx.update.my_chat_member;
    if (u) return engine.handleMyChatMember(adapter, store, u);
  });

  bot.catch((err, ctx) => {
    const c = classifyError(err);
    const where = ctx && ctx.update ? ctx.update.update_id : '?';
    if (c.kind === KINDS.FORBIDDEN || c.kind === KINDS.NOT_FOUND || c.kind === KINDS.BAD_REQUEST) {
      if (config.LOG_LEVEL === 'debug') console.warn(`[update ${where}] ${c.kind}: ${c.description}`);
      return;
    }
    console.error(`[update ${where}] handler error (${c.kind}):`, c.description || err);
  });

  /** One-shot boot: identity, commands, profile. Never fatal. */
  async function bootstrap() {
    const out = { username: adapter.username, ok: false };
    try {
      const me = await bot.api.getMe();
      if (me && me.username) {
        adapter.username = me.username;
        out.username = me.username;
        store.indexUsername(me.username, 'bot');
      }
      if (me && me.first_name && !cfg.botName) adapter.name = me.first_name;
      out.ok = true;
    } catch (err) {
      out.error = classifyError(err).description || String(err);
    }
    await Promise.allSettled([registerCommands(bot), setupProfile(bot, cfg)]);
    return out;
  }

  return { bot, store, adapter, cfg, richGate, bootstrap, UPDATES_WE_HANDLE };
}

module.exports = { buildBot, createAdapter, registerCommands, setupProfile, UPDATES_WE_HANDLE, PRIVATE_COMMANDS, GROUP_COMMANDS, hashOf, ui };
