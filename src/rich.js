'use strict';
/*
 * Rich Messages (Bot API 10.1+): native headings, tables, lists, collapsible
 * details, code blocks and inline media — up to 32,768 UTF-8 bytes instead of
 * the classic 4,096 characters, and no parse_mode escaping headaches.
 *
 * Two real-world caveats, both handled here:
 *
 *   1. CLIENT SUPPORT. Rich messages render as "not supported on Telegram Web"
 *      on some clients, so this is opt-in (RICH_MESSAGES=off by default) and
 *      every send has an HTML fallback.
 *   2. SERVER SUPPORT. `sendRichMessage` may simply not exist for a bot yet
 *      (old Bot API server, self-hosted telegram-bot-api). We detect that once,
 *      LATCH it off, and stop paying for a doomed round-trip on every message.
 *      A per-message 400 (bad payload) does NOT latch — only capability errors.
 *
 * Everything else in the bot stays on classic HTML + inline keyboards, which is
 * the proven-smooth path for in-place editing.
 */
const { classifyError, KINDS } = require('./errors');

const RICH_BYTE_LIMIT = 32768;

class RichGate {
  /** @param {'off'|'auto'|'on'} mode */
  constructor(mode = 'off') {
    this.mode = mode;
    this.latchedOff = false;   // capability failure -> permanently off for this process
    this.sent = 0;
    this.fellBack = 0;
  }

  get enabled() {
    return this.mode !== 'off' && !this.latchedOff;
  }

  /** A capability failure stops us trying again; a payload failure doesn't. */
  noteError(err) {
    const kind = classifyError(err).kind;
    if (kind === KINDS.CAPABILITY || kind === KINDS.NOT_FOUND) {
      this.latchedOff = true;
      return { latched: true, kind };
    }
    return { latched: false, kind };
  }

  noteSuccess() { this.sent += 1; }
  noteFallback() { this.fellBack += 1; }

  status() {
    return { mode: this.mode, active: this.enabled, latchedOff: this.latchedOff, sent: this.sent, fallbacks: this.fellBack };
  }
}

const byteLength = (s) => Buffer.byteLength(String(s == null ? '' : s), 'utf8');
// A conservative check for structured blocks: count the JSON envelope too.
const fits = (content) => byteLength(typeof content === 'string' ? content : JSON.stringify(content)) <= RICH_BYTE_LIMIT;

/**
 * Send `html` as a rich message when possible, else as a classic HTML message.
 *
 * @param {object} bot    adapter: needs sendRich() and sendText()
 * @param {string|number} chatId
 * @param {{html:string, rich?:object, opts?:object, gate?:RichGate}} spec
 * @returns {Promise<object>} the sent Message
 */
async function sendRichOrText(bot, chatId, spec) {
  const gate = spec.gate;
  const html = spec.html;
  const rich = spec.rich || { html };
  const opts = spec.opts || {};

  if (!gate || !gate.enabled || typeof bot.sendRich !== 'function' || !fits(rich)) {
    return bot.sendText(chatId, html, opts);
  }
  try {
    const msg = await bot.sendRich(chatId, rich, opts);
    gate.noteSuccess();
    return msg;
  } catch (err) {
    const { latched } = gate.noteError(err);
    gate.noteFallback();
    if (process.env.DEBUG_BOT) {
      console.warn(`[rich] falling back to HTML${latched ? ' (latched off)' : ''}: ${classifyError(err).description}`);
    }
    return bot.sendText(chatId, html, opts);
  }
}

/**
 * Edit a message to rich content, falling back to a classic HTML edit.
 * Same latch semantics as sendRichOrText.
 */
async function editRichOrText(bot, chatId, messageId, spec) {
  const gate = spec.gate;
  const rich = spec.rich || { html: spec.html };
  if (!gate || !gate.enabled || typeof bot.editRich !== 'function' || !fits(rich)) {
    return bot.editText(chatId, messageId, spec.html, spec.opts || {});
  }
  try {
    const r = await bot.editRich(chatId, messageId, rich, spec.opts || {});
    gate.noteSuccess();
    return r;
  } catch (err) {
    const kind = classifyError(err).kind;
    if (kind === KINDS.NOT_MODIFIED) return { ok: true, noop: true };
    if (kind === KINDS.UNEDITABLE || kind === KINDS.NOT_FOUND) throw err;
    gate.noteError(err);
    gate.noteFallback();
    return bot.editText(chatId, messageId, spec.html, spec.opts || {});
  }
}

module.exports = { RichGate, sendRichOrText, editRichOrText, RICH_BYTE_LIMIT, byteLength, fits };
