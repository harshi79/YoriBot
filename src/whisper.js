'use strict';
/*
 * Whispers — the feature that actually makes this a *whisper bot*.
 *
 * A whisper is a message sent in a chat that only ONE person can read. Delivery
 * is a ladder, because no single mechanism works everywhere:
 *
 *   1. EPHEMERAL MESSAGE (Bot API 10.2/10.3) — `sendMessage` with
 *      `ephemeral_message_parameters.receiver_user_id`. The message lands on the
 *      recipient's timeline inside the group and is invisible to everybody else,
 *      including other bots. Needs the numeric user id AND admin rights in that
 *      chat. This is the real thing, so it is always tried first, and the result
 *      is latched per chat so we don't pay for a doomed call every time.
 *   2. LOCKED CARD — a public message with a "🔓 Open whisper" inline button.
 *      Anyone can tap it, but only the intended recipient gets the content
 *      (`answerCallbackQuery` with `show_alert`); everybody else is told it isn't
 *      for them, and their attempt is counted and shown on the card. This is the
 *      classic @whisperbot mechanic and works with zero permissions.
 *   3. DM — used when the whisper was composed in a private chat.
 *
 * Replies go back invisibly with `/r` (registered as an *ephemeral command*, so
 * the recipient's own message is hidden from the group too).
 *
 * Everything here is framework-agnostic: it talks to the same tiny adapter the
 * rest of the engine uses, so the whole ladder is unit-testable with a mock.
 */
const ui = require('./ui');
const { classifyError, KINDS, bestEffort } = require('./errors');
const { SIGNAL } = require('./reactions');
const { classifyMessage } = require('./media');

const { esc, NO_PREVIEW } = ui;

// ------------------------------------------------------------------- parsing

const TARGET_RE = /^(?:@([A-Za-z][A-Za-z0-9_]{2,31})|\[([^\]]{1,64})\]\(tg:\/\/user\?id=(\d{1,15})\)|(?:id|uid):(\d{1,15})|(\d{5,15}))$/;

/** `!5m` -> ms. `!1` -> one-time burn. */
function parseFlag(token) {
  const t = token.slice(1).toLowerCase();
  if (t === '1' || t === 'once' || t === 'burn') return { oneTime: true };
  if (t === 'nosender') return { allowSenderReopen: false };
  if (t === 'sign' || t === 'signed') return { signed: true };
  if (t === 'anon' || t === 'anonymous') return { signed: false };
  const m = /^(\d+)\s*(s|sec|m|min|h|hour|d|day)$/.exec(t);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2][0];
    const ms = n * (unit === 's' ? 1000 : unit === 'm' ? 60000 : unit === 'h' ? 3600000 : 86400000);
    return { ttlMs: Math.min(Math.max(ms, 10000), 30 * 86400000) };
  }
  return null;
}

/**
 * Pull targets and flags off the front of a whisper command, leaving the secret
 * text untouched (spacing and newlines preserved).
 *
 * @returns {{targets:Array<{key:string,label:string,userId?:string,username?:string}>,
 *            text:string, flags:object, unknown:Array<string>}}
 */
function parseWhisperInput(raw, store, limits = {}) {
  const maxTargets = limits.maxTargets || 5;
  let rest = String(raw == null ? '' : raw);
  const targets = [];
  const unknown = [];
  const flags = { oneTime: false, signed: false, allowSenderReopen: true, ttlMs: null };

  for (;;) {
    const lead = /^\s*/.exec(rest)[0];
    const body = rest.slice(lead.length);
    const tokenMatch = /^(\S+)/.exec(body);
    if (!tokenMatch) break;
    const token = tokenMatch[1];

    if (token.startsWith('!')) {
      const f = parseFlag(token);
      if (!f) { unknown.push(token); rest = body.slice(token.length); continue; }
      Object.assign(flags, f);
      rest = body.slice(token.length);
      continue;
    }

    const tm = TARGET_RE.exec(token);
    if (!tm) break; // first non-target token -> everything left is the secret

    rest = body.slice(token.length);
    if (targets.length >= maxTargets) { unknown.push(token); continue; }

    const username = tm[1];
    const mentionName = tm[2];
    const mentionId = tm[3];
    const prefixedId = tm[4];
    const bareId = tm[5];

    if (username) {
      const known = store ? store.getUserByUsername(username) : null;
      targets.push({
        key: 'u:' + username.toLowerCase(),
        label: '@' + username,
        username: username.toLowerCase(),
        userId: known ? String(known.chatId) : undefined
      });
    } else {
      const id = mentionId || prefixedId || bareId;
      const known = store ? store.getUser(id) : null;
      targets.push({
        key: 'i:' + id,
        label: mentionName ? esc(mentionName) : (known && known.firstName ? esc(known.firstName) : 'user ' + id),
        userId: String(id),
        username: known && known.username ? known.username.toLowerCase() : undefined
      });
    }
  }

  // de-duplicate targets, keep order
  const seen = new Set();
  const uniq = targets.filter((t) => (seen.has(t.key) ? false : (seen.add(t.key), true)));

  return { targets: uniq, text: rest.replace(/^\s+/, ''), flags, unknown };
}

const targetLabel = (targets) => targets.map((t) => t.label).join(', ');

/** Match a user against a whisper's target list (by id or by username). */
function canOpen(w, from) {
  if (!from || from.id == null) return false;
  const uid = String(from.id);
  const uname = from.username ? String(from.username).toLowerCase() : null;
  if (w.targets.some((t) => t.userId === uid)) return true;
  if (uname && w.targets.some((t) => t.key === 'u:' + uname)) return true;
  if (w.allowSenderReopen !== false && w.fromId === uid) return true;
  return false;
}

const isRecipient = (w, from) => {
  if (!from || from.id == null) return false;
  const uid = String(from.id);
  const uname = from.username ? String(from.username).toLowerCase() : null;
  return w.targets.some((t) => t.userId === uid || (uname && t.key === 'u:' + uname));
};

// ------------------------------------------------------------------ delivery

const isGroupChat = (chatType) => chatType === 'group' || chatType === 'supergroup';

/*
 * A whisper card lives either in a chat we can see (`chatId` + `cardMessageId`)
 * or, when it was dropped via inline/guest mode into a chat we are not a member
 * of, only as an `inline_message_id`. Inline messages can be EDITED but never
 * deleted, and they can't be reacted to — so every card mutation goes through
 * these two helpers.
 */
async function editCard(bot, w, html, opts) {
  if (w.inlineMessageId && typeof bot.editInline === 'function') {
    return bot.editInline(w.inlineMessageId, html, opts);
  }
  if (w.cardMessageId && w.chatId) {
    return bot.editText(w.chatId, w.cardMessageId, html, opts);
  }
  throw Object.assign(new Error('no card to edit'), { tg: { kind: KINDS.NOT_FOUND } });
}

async function deleteCard(bot, w) {
  if (w.cardMessageId && w.chatId) return bot.deleteMessage(w.chatId, w.cardMessageId);
  return true; // inline messages cannot be deleted, only re-written
}

async function reactCard(bot, w, emoji) {
  if (w.cardMessageId && w.chatId) return bot.react(w.chatId, w.cardMessageId, emoji);
  return true;
}

/**
 * Send one whisper to one recipient, ephemerally, inside the group.
 * @returns {Promise<{ok:boolean, kind?:string, ephemeralMessageId?:number}>}
 */
async function sendEphemeral(bot, w, target) {
  const params = { receiver_user_id: Number(target.userId) };
  const html = ui.whisperEphemeralHTML(w);
  const markup = ui.whisperOpenKeyboard(w, true);
  try {
    let sent;
    if (w.media && w.media.kind === 'media') {
      sent = await bot.sendMedia(w.chatId, w.media.type, w.media.fileId, html,
        { parse_mode: 'HTML', ...NO_PREVIEW, ephemeral_message_parameters: params, reply_markup: markup }, w.media.payload);
    } else {
      sent = await bot.sendText(w.chatId, html,
        { parse_mode: 'HTML', ...NO_PREVIEW, ephemeral_message_parameters: params, reply_markup: markup });
    }
    const eid = sent && (sent.ephemeral_message_id != null ? sent.ephemeral_message_id : sent.message_id);
    return { ok: true, ephemeralMessageId: eid };
  } catch (err) {
    return { ok: false, kind: classifyError(err).kind, description: classifyError(err).description };
  }
}

/**
 * Run the delivery ladder for a whisper record.
 * Mutates the record in the store and returns a summary for the sender.
 */
async function deliverWhisper(bot, store, cfg, w) {
  const summary = { ephemeral: 0, cards: 0, dms: 0, failed: [], note: null };
  const group = isGroupChat(w.chatType);
  const byId = w.targets.filter((t) => t.userId);
  const byName = w.targets.filter((t) => !t.userId);
  const hasMedia = !!(w.media && w.media.kind !== 'text');

  // ---- 1. ephemeral, per recipient with a known numeric id ----
  if (group && byId.length) {
    const cap = store.chatCap(w.chatId, 'ephemeral');
    if (cap !== false) {
      let capabilityFailure = null;
      for (const t of byId) {
        const r = await sendEphemeral(bot, w, t);
        if (r.ok) {
          w.ephemerals.push({ receiverUserId: Number(t.userId), ephemeralMessageId: r.ephemeralMessageId });
          summary.ephemeral++;
          store.setWhisperContext(w.chatId, t.userId, { whisperId: w.id, peerId: w.fromId, chatType: w.chatType });
          store.recordWhisperGot(t.userId);
        } else if (r.kind === KINDS.CAPABILITY || r.kind === KINDS.FORBIDDEN) {
          capabilityFailure = r.kind;
          break; // no point hammering the rest of the recipients
        } else {
          summary.failed.push({ target: t.label, kind: r.kind });
        }
      }
      if (summary.ephemeral > 0) {
        store.setChatCap(w.chatId, 'ephemeral', true);
        w.delivery = 'ephemeral';
      } else if (capabilityFailure) {
        // Not an admin here (or the chat doesn't support it). Remember that.
        store.setChatCap(w.chatId, 'ephemeral', false);
        summary.note = 'ephemeral-unavailable';
      }
    } else {
      summary.note = 'ephemeral-unavailable';
    }
    // A media whisper cannot be revealed through a locked card, so with no
    // ephemeral channel there is nothing we can safely do in this group.
    if (hasMedia && summary.ephemeral === 0) {
      w.status = 'failed';
      store.updateWhisper(w.id, { status: 'failed' });
      summary.note = 'media-needs-ephemeral';
      return summary;
    }
  }

  // ---- 2. locked card for anyone we only know by username ----
  const needsCard = group && (byName.length > 0 || summary.ephemeral === 0) && !hasMedia;
  if (needsCard) {
    // If some recipients already got an ephemeral message, the public card only
    // has to cover the ones we know by username alone.
    const cardTargets = summary.ephemeral > 0 ? byName : w.targets;
    const cardView = { ...w, targets: cardTargets, targetLabel: targetLabel(cardTargets) };
    try {
      const card = await bot.sendText(w.chatId, ui.whisperCardHTML(cardView), {
        parse_mode: 'HTML', ...NO_PREVIEW,
        reply_markup: ui.whisperKeyboard(w, false),
        protect_content: true
      });
      w.cardMessageId = card && card.message_id;
      w.delivery = w.delivery || 'card';
      summary.cards++;
      // A swipe-reply to the card must NOT go out in public — see the engine.
      if (w.cardMessageId && typeof store.linkMessage === 'function') {
        store.linkMessage(w.chatId, w.cardMessageId, 'w:' + w.id);
      }
      for (const t of w.targets) {
        if (t.userId) store.setWhisperContext(w.chatId, t.userId, { whisperId: w.id, peerId: w.fromId, chatType: w.chatType });
      }
    } catch (err) {
      const kind = classifyError(err).kind;
      summary.failed.push({ target: w.targetLabel, kind });
      if (kind === KINDS.FORBIDDEN || kind === KINDS.CAPABILITY) summary.note = summary.note || 'cannot-post';
    }
  }

  // ---- 3. DM delivery (private-chat whispers) ----
  if (!group) {
    for (const t of w.targets) {
      if (!t.userId) { summary.failed.push({ target: t.label, kind: 'unknown-user' }); continue; }
      try {
        const sent = await sendWhisperDm(bot, w, t);
        w.dmMessageIds[t.userId] = sent && sent.message_id;
        w.delivery = w.delivery || 'dm';
        summary.dms++;
        store.recordWhisperGot(t.userId);
        store.setWhisperContext('dm:' + t.userId, t.userId, { whisperId: w.id, peerId: w.fromId, chatType: 'private' });
      } catch (err) {
        summary.failed.push({ target: t.label, kind: classifyError(err).kind });
      }
    }
    if (!summary.dms && !summary.failed.length) summary.note = 'no-target';
  }

  if (!summary.ephemeral && !summary.cards && !summary.dms && !summary.note) summary.note = 'undeliverable';
  store.updateWhisper(w.id, {
    delivery: w.delivery,
    cardMessageId: w.cardMessageId,
    ephemerals: w.ephemerals,
    dmMessageIds: w.dmMessageIds,
    status: (summary.ephemeral || summary.cards || summary.dms) ? 'active' : 'failed'
  });
  if (summary.ephemeral || summary.cards || summary.dms) {
    store.recordWhisperSent(w.fromId);
    store.bump('whispersSent');
    store.setWhisperContext(w.chatId, w.fromId, {
      whisperId: w.id,
      peerId: (w.targets[0] && w.targets[0].userId) || null,
      chatType: w.chatType
    });
  }
  return summary;
}

/** A whisper delivered straight into someone's DMs. */
async function sendWhisperDm(bot, w, target) {
  const html = ui.whisperDmHTML(w);
  const markup = ui.whisperOpenKeyboard(w, true);
  if (w.media && w.media.kind === 'media') {
    return bot.sendMedia(target.userId, w.media.type, w.media.fileId, html,
      { parse_mode: 'HTML', ...NO_PREVIEW, reply_markup: markup }, w.media.payload);
  }
  return bot.sendText(target.userId, html, { parse_mode: 'HTML', ...NO_PREVIEW, reply_markup: markup });
}

// ------------------------------------------------------------------- reveal

/**
 * Handle a tap on a locked card. Returns what the caller should tell Telegram.
 * @returns {{allowed:boolean, alert?:string, toast?:string, peek?:boolean, burn?:boolean}}
 */
async function revealWhisper(bot, store, w, from) {
  if (!w) return { allowed: false, toast: '⌛ That whisper is gone.' };
  if (w.status === 'burned') return { allowed: false, toast: '🔥 Already burned.' };
  if (w.status === 'expired') return { allowed: false, toast: '⌛ That whisper expired.' };
  if (w.status !== 'active') return { allowed: false, toast: '⌛ That whisper is no longer active.' };
  if (Date.now() > w.expiresAt) {
    await expireWhisper(bot, store, w);
    return { allowed: false, toast: '⌛ That whisper expired.' };
  }

  if (!canOpen(w, from)) {
    store.recordPeek(w.id);
    await bestEffort(reactCard(bot, w, SIGNAL.peeked), 'peek-react');
    // Smooth in-place feedback: the card itself shows how many people are nosy.
    await bestEffort(editCard(bot, w, ui.whisperCardHTML(w),
      { parse_mode: 'HTML', ...NO_PREVIEW, reply_markup: ui.whisperKeyboard(w, false) }), 'peek-edit');
    return { allowed: false, peek: true, alert: "🤫 That whisper isn't for you.\n\n(Your curiosity has been noted — the sender can see how many people tried.)" };
  }

  store.recordOpen(w.id, from.id);
  await bestEffort(reactCard(bot, w, SIGNAL.opened), 'open-react');

  const burn = !!w.oneTime;
  const result = { allowed: true, alert: ui.whisperAlertText(w), burn };
  if (burn) {
    await burnWhisper(bot, store, w, 'read once');
  } else {
    // Update the card so it now reads "opened" — same message, no spam.
    await bestEffort(editCard(bot, w, ui.whisperCardHTML(w),
      { parse_mode: 'HTML', ...NO_PREVIEW, reply_markup: ui.whisperKeyboard(w, false) }), 'opened-edit');
  }
  return result;
}

/** Delete every trace of a whisper (cards, ephemerals, DMs) and mark it burned. */
async function burnWhisper(bot, store, w, reason = 'burned') {
  for (const e of w.ephemerals || []) {
    if (bot.deleteEphemeral) {
      await bestEffort(bot.deleteEphemeral(w.chatId, e.receiverUserId, e.ephemeralMessageId), 'delete-ephemeral');
    }
  }
  const edited = await bestEffort(editCard(bot, w, ui.whisperCardHTML(w, { burned: reason }),
    { parse_mode: 'HTML', ...NO_PREVIEW }), 'burn-edit');
  if (!edited.ok) await bestEffort(deleteCard(bot, w), 'burn-delete');
  for (const [uid, mid] of Object.entries(w.dmMessageIds || {})) {
    await bestEffort(bot.deleteMessage(uid, mid), 'burn-dm');
  }
  w.status = 'burned';
  store.updateWhisper(w.id, { status: 'burned' });
  store.bump('whisperBurns');
  return w;
}

async function expireWhisper(bot, store, w) {
  for (const e of w.ephemerals || []) {
    if (bot.deleteEphemeral) {
      await bestEffort(bot.deleteEphemeral(w.chatId, e.receiverUserId, e.ephemeralMessageId), 'expire-ephemeral');
    }
  }
  const edited = await bestEffort(editCard(bot, w, ui.whisperCardHTML(w, { expired: true }),
    { parse_mode: 'HTML', ...NO_PREVIEW }), 'expire-edit');
  if (!edited.ok) await bestEffort(deleteCard(bot, w), 'expire-delete');
  w.status = 'expired';
  store.updateWhisper(w.id, { status: 'expired' });
  store.bump('whispersExpired');
  return w;
}

// ------------------------------------------------------------------- sweeps

/**
 * Expiry + burn-after-reading sweeper. Called on a timer from index.js.
 * @returns {{expired:number, deleted:number}}
 */
async function sweep(bot, store, now = Date.now()) {
  let expired = 0;
  let deleted = 0;
  for (const w of store.dueWhispers(now)) {
    await expireWhisper(bot, store, w);
    expired++;
  }
  for (const d of store.dueDeletes(now)) {
    if (d.ephemeral && d.receiverUserId) {
      await bestEffort(bot.deleteEphemeral(d.chatId, d.receiverUserId, d.messageId), 'auto-burn-ephemeral');
    } else {
      await bestEffort(bot.deleteMessage(d.chatId, d.messageId), 'auto-burn');
    }
    deleted++;
  }
  return { expired, deleted };
}

// ------------------------------------------------------------------ replies

/**
 * `/r <text>` — reply to the whisper you are part of, invisibly.
 * Ephemeral in the group when possible; otherwise the peer is DM'd and the
 * sender's (now public) command message is deleted if we have the rights.
 */
async function replyToWhisper(bot, store, cfg, ctx) {
  const { chatId, chatType, from, text, messageId } = ctx;
  const context = store.getWhisperContext(chatId, from.id);
  if (!context || !context.peerId) {
    return { ok: false, reason: 'no-context' };
  }
  const w = store.getWhisper(context.whisperId);
  const peer = store.getUser(context.peerId);
  if (!peer) return { ok: false, reason: 'peer-gone' };

  const reply = {
    ...w,
    text,
    fromId: String(from.id),
    fromLabel: from.first_name || from.username || 'Someone',
    signed: false,
    targets: [{ key: 'i:' + context.peerId, label: peer.firstName || peer.username || context.peerId, userId: String(context.peerId) }],
    targetLabel: peer.firstName || context.peerId,
    media: null
  };

  const group = isGroupChat(chatType);
  if (group && store.chatCap(chatId, 'ephemeral') !== false) {
    try {
      const sent = await bot.sendText(chatId, ui.whisperEphemeralHTML({
        ...reply, chatTitle: ctx.chatTitle, oneTime: false
      }), {
        parse_mode: 'HTML', ...NO_PREVIEW,
        ephemeral_message_parameters: { receiver_user_id: Number(context.peerId) },
        reply_markup: ui.whisperOpenKeyboard({ ...reply, id: w ? w.id : 'reply', oneTime: false }, true)
      });
      // Keep the thread alive in both directions.
      store.setWhisperContext(chatId, context.peerId, { whisperId: context.whisperId, peerId: String(from.id), chatType });
      store.setWhisperContext(chatId, from.id, { whisperId: context.whisperId, peerId: String(context.peerId), chatType });
      if (w) store.updateWhisper(w.id, { status: w.status });
      await bestEffort(bot.sendText(chatId, '↩️ <b>Your reply was delivered invisibly.</b>', {
        parse_mode: 'HTML', ephemeral_message_parameters: { receiver_user_id: Number(from.id) }
      }), 'reply-ack');
      return { ok: true, via: 'ephemeral', ephemeralMessageId: sent && (sent.ephemeral_message_id || sent.message_id) };
    } catch (err) {
      if (classifyError(err).kind === KINDS.CAPABILITY || classifyError(err).kind === KINDS.FORBIDDEN) {
        store.setChatCap(chatId, 'ephemeral', false);
      } else {
        return { ok: false, reason: classifyError(err).kind };
      }
    }
  }

  // Fallback: DM the peer, then scrub the public command message.
  try {
    await bot.sendText(context.peerId, ui.whisperDmHTML({
      ...reply, chatTitle: ctx.chatTitle
    }), { parse_mode: 'HTML', ...NO_PREVIEW });
    if (group && messageId) await bestEffort(bot.deleteMessage(chatId, messageId), 'scrub-command');
    return { ok: true, via: 'dm' };
  } catch (err) {
    return { ok: false, reason: classifyError(err).kind };
  }
}

// ------------------------------------------------------------------- factory

/**
 * Build and persist a whisper record from parsed input.
 */
function createWhisper(store, cfg, spec) {
  const now = Date.now();
  const ttl = spec.flags && spec.flags.ttlMs ? spec.flags.ttlMs : (cfg && cfg.whisperTtlMs) || 7 * 86400000;
  const cls = spec.classified || null;
  return store.createWhisper({
    chatId: spec.chatId,
    chatType: spec.chatType,
    chatTitle: spec.chatTitle,
    fromId: spec.fromId,
    fromLabel: spec.fromLabel,
    signed: !!(spec.flags && spec.flags.signed),
    targets: spec.targets,
    targetLabel: targetLabel(spec.targets),
    text: spec.text || '',
    media: cls && cls.kind !== 'text' ? cls : null,
    oneTime: !!(spec.flags && spec.flags.oneTime),
    allowSenderReopen: spec.flags ? spec.flags.allowSenderReopen !== false : true,
    expiresAt: spec.flags && spec.flags.oneTime ? now + Math.min(ttl, 24 * 3600000) : now + ttl
  });
}

/** Turn an incoming message body into a whisper payload (text or media). */
function classifyBody(msg) {
  const cls = classifyMessage(msg);
  if (cls.kind === 'text') return { text: cls.text, classified: null };
  if (cls.kind === 'media' || cls.kind === 'native') return { text: cls.caption || '', classified: cls };
  return { text: '', classified: null, unsupported: cls.reason };
}

module.exports = {
  parseWhisperInput, parseFlag, targetLabel, canOpen, isRecipient, isGroupChat,
  deliverWhisper, sendWhisperDm, revealWhisper, burnWhisper, expireWhisper,
  sweep, replyToWhisper, createWhisper, classifyBody, sendEphemeral,
  editCard, deleteCard, reactCard
};
