'use strict';
/*
 * Telegram wiring for AgrrhBot using the modern `node-telegram-bot-api` (grammY-style).
 * This layer only translates Telegram updates / API calls into the tiny adapter
 * interface the engine expects.
 */
const { Bot } = require('node-telegram-bot-api');
const Store = require('./store');
const engine = require('./engine');
const config = require('./config');

function createAdapter(bot, username) {
  return {
    username,
    async sendText(chatId, text, opts = {}) {
      return bot.api.sendMessage({ chat_id: chatId, text, ...opts });
    },
    async sendMedia(chatId, type, fileId, caption, opts = {}, payload) {
      const o = { chat_id: chatId, caption: caption || undefined, ...opts };
      let r;
      switch (type) {
        case 'photo': r = await bot.api.sendPhoto({ ...o, photo: fileId }); break;
        case 'sticker': r = await bot.api.sendSticker({ chat_id: chatId, sticker: fileId }); break;
        case 'voice': r = await bot.api.sendVoice({ ...o, voice: fileId }); break;
        case 'audio': r = await bot.api.sendAudio({ ...o, audio: fileId }); break;
        case 'video': r = await bot.api.sendVideo({ ...o, video: fileId }); break;
        case 'video_note': r = await bot.api.sendVideoNote({ chat_id: chatId, video_note: fileId }); break;
        case 'animation': r = await bot.api.sendAnimation({ ...o, animation: fileId }); break;
        case 'document': r = await bot.api.sendDocument({ ...o, document: fileId }); break;
        case 'contact': r = await bot.api.sendContact({ chat_id: chatId, phone_number: payload.phone_number, first_name: payload.first_name, last_name: payload.last_name, ...opts }); break;
        case 'location': r = await bot.api.sendLocation({ chat_id: chatId, latitude: payload.latitude, longitude: payload.longitude, ...opts }); break;
        default: r = await bot.api.sendMessage({ chat_id: chatId, text: caption || '📨 (unsupported media)' });
      }
      return r;
    },
    async editText(chatId, messageId, text, opts = {}) {
      return bot.api.editMessageText({ chat_id: chatId, message_id: messageId, text, ...opts });
    },
    async editMarkup(chatId, messageId, replyMarkup) {
      return bot.api.editMessageReplyMarkup({ chat_id: chatId, message_id: messageId, reply_markup: replyMarkup });
    },
    async react(chatId, messageId, emoji) {
      return bot.api.setMessageReaction({ chat_id: chatId, message_id: messageId, reaction: [{ type: 'emoji', emoji }] });
    },
    async answerCb(cbId, opts = {}) {
      return bot.api.answerCallbackQuery({ callback_query_id: cbId, ...opts });
    },
    async answerInline(queryId, results) {
      return bot.api.answerInlineQuery({ inline_query_id: queryId, results, cache_time: 300 });
    }
  };
}

function buildBot(token) {
  const bot = new Bot(token);
  const store = new Store();
  const cfg = {
    channelId: config.CHANNEL_ID,
    globalPerHour: config.GLOBAL_PER_HOUR,
    pairPerHour: config.PAIR_PER_HOUR,
    minIntervalMs: config.MIN_INTERVAL_MS
  };
  const adapter = createAdapter(bot, config.BOT_USERNAME || 'AgrrhBot');

  // Resolve the real username (used for deep links) from Telegram.
  bot.api.getMe().then((me) => { if (me && me.username) adapter.username = me.username; }).catch(() => {});

  const M = (ctx) => ctx.message;
  bot.command('start', (ctx) => { const m = M(ctx); if (m) return engine.handleStart(adapter, store, m); });
  bot.command(['pause', 'stop', 'off'], (ctx) => { const m = M(ctx); if (m) return engine.handlePause(adapter, store, m); });
  bot.command(['resume', 'on'], (ctx) => { const m = M(ctx); if (m) return engine.handleResume(adapter, store, m); });
  bot.command('link', (ctx) => { const m = M(ctx); if (m) return engine.handleLink(adapter, store, m); });
  bot.command('stats', (ctx) => { const m = M(ctx); if (m) return engine.handleStats(adapter, store, m); });
  bot.command('menu', (ctx) => { const m = M(ctx); if (m) return engine.handleMenu(adapter, store, m); });
  bot.command('cancel', (ctx) => { const m = M(ctx); if (m) return engine.handleCancel(adapter, store, m); });
  bot.command('help', (ctx) => { const m = M(ctx); if (m) return engine.handleHelp(adapter, store, m); });
  bot.command('wall', (ctx) => { const m = M(ctx); if (m) return engine.handleWall(adapter, store, m, cfg); });

  bot.on('message', (ctx) => { const m = M(ctx); if (m) return engine.handleMessage(adapter, store, m, cfg); });
  bot.on('callback_query', (ctx) => { if (ctx.callbackQuery) return engine.handleCallback(adapter, store, ctx.callbackQuery, cfg); });
  bot.on('inline_query', (ctx) => { if (ctx.inlineQuery) return engine.handleInline(adapter, store, ctx.inlineQuery); });

  bot.api.setMyCommands({
    commands: [
      { command: 'start', description: 'Get your anonymous link' },
      { command: 'menu', description: 'Open control panel' },
      { command: 'link', description: 'Your anonymous link' },
      { command: 'pause', description: 'Stop receiving messages' },
      { command: 'resume', description: 'Start receiving messages' },
      { command: 'stats', description: 'Your anonymous stats' },
      { command: 'wall', description: 'Post an anonymous confession' },
      { command: 'cancel', description: 'Leave anonymous mode' },
      { command: 'help', description: 'How it works' }
    ]
  }).catch(() => {});

  bot.catch((err) => { console.error('[handler error]', err && err.message ? err.message : err); });

  return { bot, store, adapter };
}

module.exports = { buildBot, createAdapter };
