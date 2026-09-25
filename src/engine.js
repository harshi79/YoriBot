'use strict';
/*
 * YoriBot engine — pure business logic, no Telegram imports.
 *
 * Two products in one bot:
 *   🤫 WHISPERS      a message in a group that exactly one person can read
 *   🕵️ ANON INBOX    a deep link people use to message you with no name attached
 *
 * It talks to a tiny adapter so everything is testable with a mock:
 *   bot.username
 *   bot.sendText(chatId, text, opts)                      -> Message
 *   bot.sendMedia(chatId, type, fileId, caption, opts, payload) -> Message
 *   bot.sendRich(chatId, htmlOrBlocks, opts)              -> Message   (10.1+, optional)
 *   bot.editText(chatId, messageId, text, opts)
 *   bot.editRich(chatId, messageId, htmlOrBlocks, opts)                (optional)
 *   bot.editMedia(chatId, messageId, type, fileId, caption, opts)      (optional)
 *   bot.editMarkup(chatId, messageId, replyMarkup)
 *   bot.editInline(inlineMessageId, text, opts)                        (optional)
 *   bot.editEphemeral(chatId, receiverUserId, ephemeralMessageId, text, opts) (optional)
 *   bot.deleteMessage(chatId, messageId)
 *   bot.deleteEphemeral(chatId, receiverUserId, ephemeralMessageId)    (optional)
 *   bot.react(chatId, messageId, emoji)
 *   bot.typing(chatId, action)                                         (optional)
 *   bot.answerCb(callbackQueryId, opts)
 *   bot.answerInline(inlineQueryId, results, opts)
 *   bot.answerGuest(guestQueryId, result)                              (optional)
 *
 * `opts` is passed through to the wire, so `ephemeral_message_parameters`
 * (Bot API 10.2/10.3) is just another option — no special-casing needed.
 */
const { classifyMessage, hasMedia, chatActionFor } = require('./media');
const { checkAbuse } = require('./filter');
const { classifyError, KINDS, bestEffort } = require('./errors');
const { SIGNAL, FLAVOUR, reactionOf } = require('./reactions');
const { sendRichOrText, editRichOrText } = require('./rich');
const whisper = require('./whisper');
const ui = require('./ui');

const { esc, NO_PREVIEW, linkFor } = ui;

const pick = (a) => a[Math.floor(Math.random() * a.length)];

/** The compose panel always keeps its buttons while it is being edited. */
const COMPOSE_OPTS = { parse_mode: 'HTML', reply_markup: ui.composeKeyboard() };
const chatId = (msg) => String(msg.chat.id);
/*
 * Who is acting? In a private chat the chat id IS the user id, but in a group it
 * is the group — so every piece of per-person state (user record, sessions,
 * rate limits, whisper authorship) must be keyed by the USER, or two members of
 * one group would share an identity.
 */
const actor = (msg) => (msg && msg.from && msg.from.id != null ? String(msg.from.id) : chatId(msg));
const isGroup = (msg) => whisper.isGroupChat(msg.chat && msg.chat.type);
const label = (from) => (from ? (from.first_name || from.username || String(from.id)) : 'Someone');
const inlineOpenLocks = new Set(); // avoid duplicate one-time deliveries on simultaneous /start
const requiresPrivateReveal = (w) => !!(w && w.chatType === 'inline' &&
  (w.inlinePrepared || w.media || !ui.whisperAlertFits(w)));

const IDEAS = [
  'One thing you would change about the world?',
  'A secret you have never told anyone here?',
  'Your honest first impression of me?',
  'Something you wish you had said out loud?',
  'A song that has been stuck in your head?',
  'A small thing that makes you happy?',
  'Rate my energy today, honestly.',
  'A question you are afraid to ask out loud?',
  'What do you actually think of me?',
  'Something you almost said but didn\u2019t?'
];

const safe = (p, label) => bestEffort(p, label);
const typing = (bot, msg, action) => safe(bot.typing ? bot.typing(chatId(msg), action || 'typing') : Promise.resolve(), 'typing');

// ------------------------------------------------------------------- panels

/*
 * A "panel" is a message we keep editing in place. In a private chat that is a
 * normal message; when we have ephemeral support in a group it is an ephemeral
 * message that only its owner can see — which needs a different edit method
 * (`editEphemeralMessageText`) and a different id. This abstraction keeps the
 * rest of the engine from caring which one it is holding.
 */
function panelOf(sent, msg, fromId) {
  const eid = sent && sent.ephemeral_message_id;
  if (eid != null) {
    return { chatId: chatId(msg), ephemeralId: eid, receiverId: Number(fromId) };
  }
  return { chatId: chatId(msg), messageId: sent && sent.message_id };
}

async function editPanel(bot, store, ref, html, opts = {}) {
  if (!ref) return false;
  try {
    if (ref.ephemeralId && bot.editEphemeral) {
      await bot.editEphemeral(ref.chatId, ref.receiverId, ref.ephemeralId, html, opts);
      return true;
    }
    if (!ref.messageId) return false;
    await bot.editText(ref.chatId, ref.messageId, html, opts);
    return true;
  } catch (err) {
    const kind = classifyError(err).kind;
    if (kind === KINDS.NOT_MODIFIED) return true; // nothing changed: that's a success
    if (kind === KINDS.UNEDITABLE || kind === KINDS.NOT_FOUND) {
      // Too old / deleted: re-create it and hand the new reference back.
      try {
        // An expired private panel must NEVER be recreated as a public group
        // message. If ephemeral delivery has stopped working, fail closed.
        const sendOpts = ref.ephemeralId
          ? { ...opts, ephemeral_message_parameters: { receiver_user_id: Number(ref.receiverId) } }
          : opts;
        const fresh = await bot.sendText(ref.chatId, html, sendOpts);
        return { recreated: panelOf(fresh, { chat: { id: ref.chatId } }, ref.receiverId) };
      } catch { return false; }
    }
    return false;
  }
}

/**
 * Edit the panel that belongs to a *session* (compose / group Q&A / whisper).
 * If the panel can no longer be edited — Telegram only allows edits for ~48h in
 * groups — we post a fresh one and re-point the session at it, so the user never
 * ends up typing into a dead panel.
 */
async function editSessionPanel(bot, store, session, html, opts = {}) {
  const ref = {
    chatId: session.panelChatId, messageId: session.panelMsgId,
    ephemeralId: session.panelEphemeralId, receiverId: session.panelReceiverId
  };
  const r = await editPanel(bot, store, ref, html, opts);
  if (r && r.recreated) {
    const next = {
      ...session,
      panelChatId: r.recreated.chatId,
      panelMsgId: r.recreated.messageId,
      panelEphemeralId: r.recreated.ephemeralId,
      panelReceiverId: r.recreated.receiverId
    };
    if (session.kind === 'group') store.setGroupSession(session.senderId || ref.chatId, next);
    else if (session.kind === 'whisper_target' || session.kind === 'whisper_body' || session.kind === 'inline_media') store.setWhisperSession(session.senderId, next);
    else store.setSession(session.senderId || ref.chatId, next);
  }
  return r;
}

/**
 * Reply that only the caller can see, when the chat supports ephemeral messages
 * (Bot API 10.2+). For private-only content, fall back to a DM, never a public
 * group message. Generic notices can fall back to a normal group reply.
 */
async function privateReply(bot, store, msg, html, opts = {}, privateOnly = false) {
  const from = msg.from;
  if (isGroup(msg) && from && from.id != null && store.chatCap(chatId(msg), 'ephemeral') !== false) {
    try {
      const sent = await bot.sendText(chatId(msg), html, {
        parse_mode: 'HTML', ...NO_PREVIEW,
        ephemeral_message_parameters: { receiver_user_id: Number(from.id) },
        ...opts
      });
      store.setChatCap(chatId(msg), 'ephemeral', true);
      return { sent, private: true };
    } catch (err) {
      const kind = classifyError(err).kind;
      if (kind === KINDS.CAPABILITY || kind === KINDS.FORBIDDEN) store.setChatCap(chatId(msg), 'ephemeral', false);
    }
  }
  if (privateOnly && isGroup(msg)) {
    if (from && from.id != null) {
      try {
        const sent = await bot.sendText(from.id, html, { parse_mode: 'HTML', ...NO_PREVIEW, ...opts });
        return { sent, private: true, dm: true };
      } catch { /* recipient has not opened the bot; fail closed */ }
    }
    await safe(bot.sendText(chatId(msg), '🔒 Open my private chat to use that command.'), 'private-command-hint');
    return { sent: null, private: false };
  }
  return { sent: await bot.sendText(chatId(msg), html, { parse_mode: 'HTML', ...NO_PREVIEW, ...opts }), private: false };
}

/**
 * The compose panel a sender gets after opening someone's link. Private when we
 * can (so nobody in a shared chat sees that you're writing something anonymous).
 */
async function openPanel(bot, store, msg, html, markup) {
  const from = msg.from;
  if (isGroup(msg) && from && from.id != null && store.chatCap(chatId(msg), 'ephemeral') !== false) {
    try {
      const sent = await bot.sendText(chatId(msg), html, {
        parse_mode: 'HTML', ...NO_PREVIEW, reply_markup: markup,
        ephemeral_message_parameters: { receiver_user_id: Number(from.id) }
      });
      store.setChatCap(chatId(msg), 'ephemeral', true);
      return panelOf(sent, msg, from.id);
    } catch (err) {
      const kind = classifyError(err).kind;
      if (kind === KINDS.CAPABILITY || kind === KINDS.FORBIDDEN) store.setChatCap(chatId(msg), 'ephemeral', false);
    }
  }
  const sent = await bot.sendText(chatId(msg), html, { parse_mode: 'HTML', ...NO_PREVIEW, reply_markup: markup });
  return panelOf(sent, msg, from && from.id);
}

// ------------------------------------------- private reveal for inline cards

async function handleInlinePrivateStart(bot, store, msg, id) {
  const cid = chatId(msg);
  const uid = actor(msg);
  // /start payloads can be pasted into groups. Never send a secret there.
  if (!msg.chat || msg.chat.type !== 'private' || cid !== uid) {
    await bot.sendText(cid, '🔒 Open this bot in a <b>private chat</b> to view a locked whisper.', { parse_mode: 'HTML' });
    return;
  }
  const w = store.getWhisper(id);
  if (!requiresPrivateReveal(w)) {
    await bot.sendText(cid, '⌛ This private whisper link is invalid or expired.');
    return;
  }
  if (inlineOpenLocks.has(w.id)) return; // concurrent /start must not deliver a one-time file twice
  inlineOpenLocks.add(w.id);
  try {
    const access = await whisper.checkWhisperAccess(bot, store, w, msg.from);
    if (!access.allowed) {
      await bot.sendText(cid, access.peek ? '🔒 This whisper is not for you.' : (access.toast || '⌛ Whisper unavailable.'));
      return;
    }

    const html = ui.whisperDmHTML(w) + (w.oneTime ? '\n\n🔥 This view is deleted in 30 seconds.' : '');
    const markup = w.oneTime ? undefined : ui.whisperOpenKeyboard(w, false);
    const commonOpts = { parse_mode: 'HTML', reply_markup: markup };
    const oldMid = w.dmMessageIds && w.dmMessageIds[uid];
    let mid = oldMid;
    let edited = false;
    if (oldMid) {
      try {
        if (w.media && typeof bot.editMedia === 'function') {
          await bot.editMedia(cid, oldMid, w.media.type, w.media.fileId, html, {
            ...commonOpts,
            ...(['photo', 'video', 'animation'].includes(w.media.type) ? { has_spoiler: true } : {})
          });
          edited = true;
        } else if (!w.media) {
          await bot.editText(cid, oldMid, html, { ...commonOpts, ...NO_PREVIEW });
          edited = true;
        }
      } catch { /* deleted / too old — send a fresh private message below */ }
    }
    if (!edited) {
      let sent;
      if (w.media) {
        sent = await bot.sendMedia(cid, w.media.type, w.media.fileId, html, {
          ...commonOpts, protect_content: true,
          ...(['photo', 'video', 'animation'].includes(w.media.type) ? { has_spoiler: true } : {})
        }, w.media.payload);
      } else {
        sent = await bot.sendText(cid, html, { ...commonOpts, ...NO_PREVIEW, protect_content: true });
      }
      mid = sent && sent.message_id;
    }

    whisper.bindRecipient(store, w, msg.from);
    const firstRead = !w.openedBy.includes(uid);
    store.recordOpen(w.id, uid);
    if (firstRead) store.recordWhisperGot(uid);
    if (w.oneTime) {
      if (mid) store.scheduleDelete(cid, mid, 30000);
      // Don't store this DM id in dmMessageIds: burnWhisper would delete it
      // immediately, before the recipient gets a chance to see the photo.
      await whisper.burnWhisper(bot, store, w, 'read once');
    } else {
      store.updateWhisper(w.id, { dmMessageIds: { ...w.dmMessageIds, [uid]: mid } });
      await safe(whisper.editCard(bot, w, ui.whisperCardHTML(w), {
        parse_mode: 'HTML', ...NO_PREVIEW, reply_markup: ui.whisperKeyboard(w, false)
      }), 'inline-private-open-edit');
    }
  } catch (err) {
    if (process.env.DEBUG_BOT) console.warn('[inline-private]', classifyError(err).description);
    await safe(bot.sendText(cid, '🚫 The private whisper could not be delivered. Please try opening the card again.'), 'inline-private-failed');
  } finally {
    inlineOpenLocks.delete(w.id);
  }
}

// ------------------------------------------------------------------- /start

async function handleStart(bot, store, msg) {
  const cid = chatId(msg);
  const uid = actor(msg);
  const from = msg.from || {};
  const user = store.getOrCreateUser(uid, { username: from.username, firstName: from.first_name });
  const payload = (msg.text || '/start').trim().split(/\s+/)[1] || null;

  if (payload && /^wm_[a-f0-9]{12}$/i.test(payload)) {
    await handleInlinePrivateStart(bot, store, msg, payload.slice(3).toLowerCase());
    return;
  }

  // ---- group "ask me anything" deep link: ?start=g_<token>
  if (payload && payload.startsWith('g_')) {
    const groupId = store.getGroupByToken(payload.slice(2));
    if (!groupId) { await bot.sendText(cid, '❌ This group link is invalid or expired.'); return; }
    const g = store.getGroup(groupId);
    if (!g || !g.active) { await bot.sendText(cid, "🔒 This group's Q&A is currently off."); return; }
    const panel = await openPanel(bot, store, msg, ui.groupPanelHTML(), ui.composeKeyboard());
    store.setGroupSession(uid, { kind: 'group', groupId, panelChatId: panel.chatId, panelMsgId: panel.messageId, panelEphemeralId: panel.ephemeralId, panelReceiverId: panel.receiverId });
    return;
  }

  // ---- anonymous inbox deep link: ?start=<token>
  if (payload && !payload.startsWith('/')) {
    const target = store.getTargetByToken(payload);
    if (!target) { await bot.sendText(cid, '❌ This anonymous link is invalid or expired.'); return; }
    if (target === uid) {
      await bot.sendText(cid, "🙃 That's your own link! Share it so others can message you anonymously.",
        { reply_markup: ui.shareKeyboard(linkFor(bot.username, user.token)) });
      return;
    }
    const tUser = store.getUser(target);
    const panel = await openPanel(bot, store, msg,
      ui.composePanelHTML((tUser && tUser.firstName) || 'someone'), ui.composeKeyboard());
    store.setSession(uid, {
      kind: 'anon', target, panelChatId: panel.chatId, panelMsgId: panel.messageId,
      panelEphemeralId: panel.ephemeralId, panelReceiverId: panel.receiverId
    });
    if (tUser && tUser.receiving) {
      await safe(bot.sendText(target, '👀 Someone just opened your anonymous box…'), 'opened-notice');
    }
    return;
  }

  // ---- plain /start
  const link = linkFor(bot.username, user.token);
  const html = ui.welcomeHTML(user, link, bot.name || bot.username, bot.username);
  const markup = {
    inline_keyboard: [
      [{ text: '🎛 Open control panel', callback_data: 'menu' }, { text: '🤫 Whisper someone', callback_data: 'whisper_help' }],
      ui.shareKeyboard(link).inline_keyboard[0]
    ]
  };
  if (cfgRich(bot)) {
    await sendRichOrText(bot, cid, { html, opts: { ...NO_PREVIEW, reply_markup: markup }, gate: bot.richGate });
  } else {
    await bot.sendText(cid, html, { parse_mode: 'HTML', ...NO_PREVIEW, reply_markup: markup });
  }
  await safe(bot.react(cid, msg.message_id, SIGNAL.welcome), 'welcome-react');
}

const cfgRich = (bot) => !!(bot.richGate && bot.richGate.enabled && typeof bot.sendRich === 'function');

// ------------------------------------------------------- inbound messages

async function handleMessage(bot, store, msg, cfg) {
  const cid = chatId(msg);
  if (msg.text && msg.text.startsWith('/')) return;  // commands are routed separately
  if (msg.chat && msg.chat.type === 'channel') return; // channel posts are not whispers

  /*
   * Whisper compose sessions are keyed by USER, not by chat: in a group two
   * people can be composing at the same time, and a chat-keyed session would
   * hand one person's secret to the other.
   */
  const uid = actor(msg);
  const wSession = store.getWhisperSession(uid);
  if (wSession && wSession.kind === 'whisper_target') return whisperStepTarget(bot, store, msg, cfg, wSession);
  if (wSession && wSession.kind === 'whisper_body') return whisperStepBody(bot, store, msg, cfg, wSession);
  if (wSession && wSession.kind === 'inline_media') return whisperStepInlineMedia(bot, store, msg, cfg, wSession);

  const session = store.getSession(uid);

  const gSession = store.getGroupSession(uid);
  if (gSession) return deliverGroupQuestion(bot, store, msg, gSession, cfg);

  if (session) return deliverFromSender(bot, store, msg, session, cfg);

  // Swipe-reply routing.
  const rtm = msg.reply_to_message;
  if (rtm && rtm.ephemeral_message_id) {
    // Replying to an ephemeral message (Bot API 10.2): still invisible to the
    // rest of the chat, so treat it exactly like `/r <text>`.
    const cls = classifyMessage(msg);
    if (cls.kind === 'text') return handleReply(bot, store, msg, cfg, cls.text);
    return privateReply(bot, store, msg, '↩️ Invisible replies are text-only for now.');
  }
  if (rtm && rtm.message_id) {
    const tid = store.threadByLink(actor(msg), rtm.message_id) || store.threadByLink(cid, rtm.message_id);
    if (tid && String(tid).startsWith('w:')) return hintReplyCommand(bot, store, msg, cfg, String(tid).slice(2));
    if (tid) return deliverOwnerReply(bot, store, msg, tid);
  }
  // A whisper card tapped with a plain (non-reply) message: stay quiet.
}

/** Replying publicly to a locked card would leak the secret — nudge to `/r`. */
async function hintReplyCommand(bot, store, msg, cfg, whisperId) {
  const w = store.getWhisper(whisperId);
  if (!w) return;
  const html = '🤫 Careful — a normal reply here is <b>public</b>.\n\nUse <code>/r your reply</code> and only they will see it.';
  if (isGroup(msg)) await privateReply(bot, store, msg, html);
  else await bot.sendText(chatId(msg), html, { parse_mode: 'HTML', ...NO_PREVIEW });
}

// --------------------------------------------- anonymous inbox: sender side

async function deliverFromSender(bot, store, msg, session, cfg) {
  const cid = chatId(msg);
  const sid = session.senderId || actor(msg);   // the anonymous sender
  const target = store.getUser(session.target);
  const panel = (html, opts) => editSessionPanel(bot, store, session, html, opts || COMPOSE_OPTS);

  if (!target || !target.receiving) {
    await panel("😶 They're not accepting anonymous messages right now.\nTap <b>Cancel</b> or try later.");
    return;
  }
  if (store.isBlocked(session.target, sid)) {
    await panel("🚫 You've been blocked from messaging this person.");
    return;
  }

  const cls = classifyMessage(msg);
  const abuse = checkAbuse(cls.kind === 'text' ? cls.text : cls.caption);
  if (!abuse.ok) {
    await panel('🚫 That message was blocked by the filter (' + abuse.reason + ').');
    return;
  }
  const rate = store.rateCheck(sid, session.target, cfg || {});
  if (!rate.ok) {
    await panel('🚧 ' + rate.reason + '\nTap <b>Cancel</b> to stop.');
    return;
  }

  const thread = store.getOrCreateThread(session.target, sid);
  const replyToOwner = thread.lastOwnerMsgId ? { message_id: thread.lastOwnerMsgId } : undefined;
  const sendOpts = {
    protect_content: !!target.protect,
    disable_notification: !!target.silent,
    reply_parameters: replyToOwner
  };

  let sent;
  if (cls.kind === 'text') {
    const c = ui.composeDelivered(cls.text, target);
    sent = await bot.sendText(session.target, c.text, { entities: c.entities, ...sendOpts });
  } else if (cls.kind === 'media' || cls.kind === 'native') {
    await typing(bot, { chat: { id: session.target } }, chatActionFor(cls));
    sent = await sendClassified(bot, session.target, cls, ui.composeCaption(cls), {
      parse_mode: 'HTML', ...sendOpts,
      ...(target.spoiler && ['photo', 'video', 'animation', 'live_photo'].includes(cls.type) ? { has_spoiler: true } : {})
    });
  } else {
    await panel('🤖 ' + esc(cls.reason || "I can't send that anonymously") + '.\nTry text, a photo, a sticker or a voice note.');
    return;
  }

  await finishDelivery(bot, store, msg, session, thread, sent, target, cfg);
}

/** Everything that happens after an anonymous message lands: buttons, links, reactions, auto-burn. */
async function finishDelivery(bot, store, msg, session, thread, sent, target, cfg) {
  const cid = chatId(msg);
  const sid = session.senderId || actor(msg);
  const mid = sent && sent.message_id;
  if (mid) {
    // Attach Report/Block/Burn with the real message id (one extra call, but the
    // buttons need to know which message they belong to).
    await safe(bot.editMarkup(target.chatId, mid, ui.reportKeyboard(mid)), 'attach-buttons');
    store.linkMessage(target.chatId, mid, thread.id);
    store.setThreadField(thread.id, 'lastSenderMsgId', mid);
    if (target.autoDeleteMs) store.scheduleDelete(target.chatId, mid, target.autoDeleteMs);
  }
  if (msg.message_id) store.linkMessage(sid, msg.message_id, thread.id);
  thread.count = (thread.count || 0) + 1;
  store.recordSent(sid);
  store.recordReceived(target.chatId);
  store.bump('anonReceived');
  if (msg.message_id) await safe(bot.react(cid, msg.message_id, SIGNAL.sent), 'sender-react');
  await safe(bot.react(target.chatId, mid, pick(FLAVOUR)), 'receiver-react');
  await editSessionPanel(bot, store, session, '✅ <b>Sent anonymously!</b> Send another, or tap <b>Cancel</b>.', COMPOSE_OPTS);
}

/** Media / native payloads are re-created by the adapter, one call per type. */
async function sendClassified(bot, to, cls, caption, opts) {
  if (cls.kind === 'media') return bot.sendMedia(to, cls.type, cls.fileId, caption, opts, cls.payload);
  if (cls.kind === 'native') return bot.sendNative(to, cls.type, cls.params, caption, opts);
  return bot.sendText(to, caption || '', opts);
}

// --------------------------------------------- anonymous inbox: owner reply

async function deliverOwnerReply(bot, store, msg, threadId) {
  const cid = chatId(msg);
  const oid = actor(msg);              // the inbox owner answering
  const thread = store.getThread(threadId);
  if (!thread || !thread.active) { await bot.sendText(cid, '⚠️ That conversation is closed.'); return; }
  const sender = store.getUser(thread.sender);
  if (!sender) { await bot.sendText(cid, '⚠️ That person is gone.'); return; }

  const cls = classifyMessage(msg);
  if (cls.kind !== 'text' && cls.kind !== 'media' && cls.kind !== 'native') {
    await bot.sendText(cid, '🤖 You can reply with text or media only.');
    return;
  }
  const replyToSender = thread.lastSenderMsgId ? { message_id: thread.lastSenderMsgId } : undefined;
  const opts = {
    reply_parameters: replyToSender,
    protect_content: !!sender.protect,
    disable_notification: !!sender.silent
  };

  let sent;
  if (cls.kind === 'text') {
    const c = ui.composeReply(cls.text);
    sent = await bot.sendText(thread.sender, c.text, { entities: c.entities, ...opts });
  } else {
    await typing(bot, { chat: { id: thread.sender } }, chatActionFor(cls));
    const caption = cls.kind === 'media' ? ui.composeReplyCaption(cls) : '💬 <b>Reply (still anonymous)</b>';
    sent = await sendClassified(bot, thread.sender, cls, caption, {
      parse_mode: 'HTML', ...opts,
      ...(sender.spoiler && ['photo', 'video', 'animation', 'live_photo'].includes(cls.type) ? { has_spoiler: true } : {})
    });
  }

  const mid = sent && sent.message_id;
  if (mid) {
    store.linkMessage(thread.sender, mid, thread.id);
    store.setThreadField(thread.id, 'lastOwnerMsgId', mid);
    if (sender.autoDeleteMs) store.scheduleDelete(thread.sender, mid, sender.autoDeleteMs);
    await safe(bot.editMarkup(thread.sender, mid, ui.reportKeyboard(mid)), 'attach-buttons');
  }
  if (msg.message_id) store.linkMessage(oid, msg.message_id, thread.id);
  // Put the action buttons back on the message they replied to.
  if (msg.reply_to_message && msg.reply_to_message.message_id) {
    await safe(bot.editMarkup(cid, msg.reply_to_message.message_id,
      ui.reportKeyboard(msg.reply_to_message.message_id)), 'restore-buttons');
  }
  thread.count = (thread.count || 0) + 1;
  store.recordSent(oid);
  store.recordReceived(thread.sender);
  store.bump('anonSent');
  if (msg.message_id) await safe(bot.react(cid, msg.message_id, SIGNAL.reply), 'reply-react');
  await bot.sendText(cid, "💬 <b>Replied anonymously.</b> They'll get it as a notification.", { parse_mode: 'HTML' });
}

// ------------------------------------------------------ group Q&A (anon AMA)

async function deliverGroupQuestion(bot, store, msg, gSession, cfg) {
  const cid = chatId(msg);
  const sid = gSession.senderId || actor(msg);   // the asker
  const groupId = gSession.groupId;
  const group = store.getGroup(groupId);
  const panel = (html) => editSessionPanel(bot, store, gSession, html, COMPOSE_OPTS);
  if (!group || !group.active) {
    await panel("🔒 This group's Q&A is off.");
    return;
  }
  const cls = classifyMessage(msg);
  const abuse = checkAbuse(cls.kind === 'text' ? cls.text : cls.caption);
  if (!abuse.ok) {
    await panel('🚫 That message was blocked by the filter (' + abuse.reason + '). Tap <b>Cancel</b>.');
    return;
  }
  const rate = store.rateCheck(sid, 'g:' + groupId, cfg || {});
  if (!rate.ok) {
    await panel('🚧 ' + rate.reason + '\nTap <b>Cancel</b> to stop.');
    return;
  }

  const questionHTML = '🕵️ <b>Anonymous question</b>\n\n';
  let sent;
  if (cls.kind === 'text') {
    sent = await bot.sendText(groupId, questionHTML + esc(cls.text), { parse_mode: 'HTML', ...NO_PREVIEW });
  } else if (cls.kind === 'media' || cls.kind === 'native') {
    await typing(bot, { chat: { id: groupId } }, chatActionFor(cls));
    sent = await sendClassified(bot, groupId, cls,
      questionHTML.replace(/<\/b>\n\n$/, '</b>') + (cls.caption ? '\n\n' + esc(cls.caption) : ''),
      { parse_mode: 'HTML', ...NO_PREVIEW });
  } else {
    await panel("🤖 Sorry, I can't forward that type to the group yet.");
    return;
  }

  store.recordGroupQuestion(groupId);
  if (msg.message_id) await safe(bot.react(cid, msg.message_id, SIGNAL.sent), 'question-react');

  /*
   * Bot API 10.2 ephemeral confirmation: a private "it's live" note that only
   * the asker sees, right there in the group. If this chat can't do ephemeral
   * (the bot is not an admin), fall back to a DM — never to a public message,
   * which would out the asker.
   */
  const ack = '✅ Your anonymous question is live in the group.';
  if (store.chatCap(groupId, 'ephemeral') !== false) {
    const r = await safe(bot.sendText(groupId, ack, {
      ephemeral_message_parameters: { receiver_user_id: Number(sid) }
    }), 'ephemeral-ack');
    if (r.ok) store.setChatCap(groupId, 'ephemeral', true);
    else if (r.kind === KINDS.CAPABILITY || r.kind === KINDS.FORBIDDEN) {
      store.setChatCap(groupId, 'ephemeral', false);
      await safe(bot.sendText(sid, ack), 'dm-ack');
    }
  } else {
    await safe(bot.sendText(sid, ack), 'dm-ack');
  }

  await panel('✅ <b>Posted anonymously!</b> Ask another, or tap <b>Cancel</b>.');
}

// ------------------------------------------------------------- whisper flow

const INLINE_PRIVATE_MEDIA = new Set(['photo', 'video', 'animation', 'document']);

/** /wi @alice [caption] [0] — stage a private photo for an inline locked card. */
async function handleInlineMedia(bot, store, msg, cfg) {
  const cid = chatId(msg);
  const from = msg.from || {};
  const uid = actor(msg);
  if (!msg.chat || msg.chat.type !== 'private') {
    await privateReply(bot, store, msg, '🖼 Start <code>/wi @username</code> in my private chat, then send me the photo there. Never post a private image directly into the group.');
    return;
  }
  const input = (msg.text || '').split(/\s+/).slice(1).join(' ');
  const parsed = whisper.parseInlineWhisperInput(input, store, { maxTargets: 1 });
  if (parsed.targets.length !== 1 || parsed.unknown.length) {
    await bot.sendText(cid,
      '🖼 <b>Private inline media</b>\n\nUse <code>/wi @alice</code> or <code>/wi 123456789 0</code> (final 0 hides your name on the card).\nThen send me a photo, video, GIF or document in this DM.',
      { parse_mode: 'HTML', ...NO_PREVIEW });
    return;
  }
  store.getOrCreateUser(uid, { username: from.username, firstName: from.first_name });
  const sent = await bot.sendText(cid, ui.inlineMediaComposeHTML(whisper.targetLabel(parsed.targets)), {
    parse_mode: 'HTML', ...NO_PREVIEW,
    reply_markup: { inline_keyboard: [[{ text: '🚪 Cancel', callback_data: 'cancel' }]] }
  });
  store.setWhisperSession(uid, {
    kind: 'inline_media', senderId: uid, targets: parsed.targets, flags: parsed.flags,
    introText: parsed.text, panelChatId: cid, panelMsgId: sent && sent.message_id
  });
}

/** The file stays in the DM; only a text-only, target-locked inline card is shared. */
async function whisperStepInlineMedia(bot, store, msg, cfg, session) {
  const uid = actor(msg);
  const cls = classifyMessage(msg);
  const panel = (html) => editSessionPanel(bot, store, session, html, {
    parse_mode: 'HTML', ...NO_PREVIEW,
    reply_markup: { inline_keyboard: [[{ text: '🚪 Cancel', callback_data: 'cancel' }]] }
  });
  if (cls.kind !== 'media' || !INLINE_PRIVATE_MEDIA.has(cls.type) || !cls.fileId) {
    await panel('🖼 Send a <b>photo, video, GIF or document</b> here in this private chat. The file will never appear in the public inline card.');
    return;
  }
  const caption = cls.caption || session.introText || '';
  if (caption.length > 800) {
    await panel('🚧 Keep the private caption under 800 characters, then send the media again.');
    return;
  }
  const abuse = checkAbuse(caption);
  if (!abuse.ok) { await panel('🚫 That caption was blocked by the abuse filter. Try another caption.'); return; }
  const recipient = session.targets[0].userId || session.targets[0].key;
  const rate = store.rateCheck(uid, `w:${recipient}`, cfg || {});
  if (!rate.ok) { await panel('🚧 ' + esc(rate.reason)); return; }

  const from = msg.from || {};
  const w = whisper.createWhisper(store, { whisperTtlMs: cfg && cfg.whisperTtlMs }, {
    chatId: null, chatType: 'inline', chatTitle: null,
    fromId: uid, fromLabel: from.username ? '@' + from.username : label(from),
    targets: session.targets, text: caption, flags: session.flags,
    classified: cls, inlinePrepared: true
  });
  store.clearWhisperSession(uid);
  await editPanel(bot, store, {
    chatId: session.panelChatId, messageId: session.panelMsgId,
    ephemeralId: session.panelEphemeralId, receiverId: session.panelReceiverId
  }, ui.inlineMediaReadyHTML(w), {
    parse_mode: 'HTML', ...NO_PREVIEW, reply_markup: ui.inlineMediaShareKeyboard(w)
  });
}

/*
 * Three ways in:
 *   /w @alice secret          one-shot
 *   /w                        guided (target, then body — supports media)
 *   @bot @alice secret [0]    inline in ANY chat; final 0 hides the bot's sender label
 */
async function handleWhisper(bot, store, msg, cfg) {
  const cid = chatId(msg);
  const uid = actor(msg);
  const from = msg.from || {};
  store.getOrCreateUser(uid, { username: from.username, firstName: from.first_name });
  const argText = (msg.text || '').split(/\s+/).slice(1).join(' ');
  const parsed = whisper.parseWhisperInput(argText, store, { maxTargets: cfg.maxWhisperTargets });

  if (parsed.unknown.length && process.env.DEBUG_BOT) {
    console.warn('[whisper] unknown flags:', parsed.unknown.join(' '));
  }

  // ---- guided mode: pick a target first
  if (!parsed.targets.length) {
    const panel = await openPanel(bot, store, msg,
      '🤫 <b>Who is this whisper for?</b>\n\nSend <code>@username</code> or a user id (get one with <code>/id</code>).\n' +
      'You can list several: <code>@alice @bob 12345678</code>\n\nOptional flags: <code>!1</code> burn after reading, <code>!5m</code> expire, <code>!nosender</code>, <code>!sign</code>.',
      ui.composeKeyboard());
    store.setWhisperSession(uid, {
      kind: 'whisper_target', panelChatId: panel.chatId, panelMsgId: panel.messageId,
      panelEphemeralId: panel.ephemeralId, panelReceiverId: panel.receiverId, flags: parsed.flags,
      homeChatId: cid
    });
    return;
  }

  // ---- guided mode: target given, body still missing
  if (!parsed.text && !hasMedia(msg)) {
    const panel = await openPanel(bot, store, msg,
      `🤫 <b>Whisper to ${parsed.targets.map((t) => t.label).join(', ')}</b>\n\nNow send the secret — text, photo, sticker, GIF or voice note.\nTap <b>Cancel</b> to drop it.`,
      ui.composeKeyboard());
    store.setWhisperSession(uid, {
      kind: 'whisper_body', panelChatId: panel.chatId, panelMsgId: panel.messageId,
      panelEphemeralId: panel.ephemeralId, panelReceiverId: panel.receiverId,
      targets: parsed.targets, flags: parsed.flags, homeChatId: cid
    });
    return;
  }

  await sendWhisper(bot, store, msg, cfg, {
    targets: parsed.targets, text: parsed.text, flags: parsed.flags,
    classified: hasMedia(msg) ? classifyMessage(msg) : null
  });
}

/** Guided step 1: the sender named their target(s). */
async function whisperStepTarget(bot, store, msg, cfg, session) {
  const cid = chatId(msg);
  const parsed = whisper.parseWhisperInput((msg.text || '').trim(), store, { maxTargets: cfg.maxWhisperTargets });
  const panel = (html) => editSessionPanel(bot, store, session, html, COMPOSE_OPTS);
  if (!parsed.targets.length) {
    await panel('🤫 I need a target: send <code>@username</code> or a user id.\nTap <b>Cancel</b> to stop.');
    return;
  }
  const next = {
    ...session, kind: 'whisper_body', targets: parsed.targets,
    flags: { ...(session.flags || {}), ...parsed.flags }
  };
  store.setWhisperSession(actor(msg), next);
  await panel(`🤫 <b>Whisper to ${parsed.targets.map((t) => t.label).join(', ')}</b>\n\nNow send the secret — text, photo, sticker, GIF or voice note.`);
}

/** Guided step 2: the sender wrote the secret. */
async function whisperStepBody(bot, store, msg, cfg, session) {
  const cid = chatId(msg);
  const body = whisper.classifyBody(msg);
  const panel = (html) => editSessionPanel(bot, store, session, html, COMPOSE_OPTS);
  if (body.unsupported) {
    await panel('🤖 ' + esc(body.unsupported) + ' — send text or a photo/sticker/voice note instead, or tap <b>Cancel</b>.');
    return;
  }
  if (!body.text && !body.classified) {
    await panel('🤫 Send me the secret first.');
    return;
  }
  const panelRef = {
    chatId: session.panelChatId, messageId: session.panelMsgId,
    ephemeralId: session.panelEphemeralId, receiverId: session.panelReceiverId
  };
  store.clearWhisperSession(actor(msg));
  await sendWhisper(bot, store, msg, cfg, {
    targets: session.targets, text: body.text, flags: session.flags || {}, classified: body.classified,
    panelRef
  });
}

/** Shared tail: create the record, run the delivery ladder, tell the sender. */
async function sendWhisper(bot, store, msg, cfg, spec) {
  const cid = chatId(msg);
  const uid = actor(msg);
  const from = msg.from || {};
  const chat = msg.chat || {};

  if (spec.text && spec.text.length > (cfg.maxWhisperLength || 3500)) {
    await bot.sendText(cid, `🚧 Whispers are capped at ${cfg.maxWhisperLength || 3500} characters.`, { parse_mode: 'HTML' });
    return;
  }
  const abuse = checkAbuse(spec.text);
  if (!abuse.ok) {
    const text = '🚫 Blocked by the abuse filter (' + abuse.reason + ').';
    if (spec.panelRef) await editPanel(bot, store, spec.panelRef, text, { parse_mode: 'HTML', reply_markup: ui.composeKeyboard() });
    else await bot.sendText(cid, text, { parse_mode: 'HTML' });
    return;
  }
  const rate = store.rateCheck(uid, 'w:' + spec.targets.map((t) => t.key).join(','), cfg || {});
  if (!rate.ok) {
    const text = '🚧 ' + rate.reason;
    if (spec.panelRef) await editPanel(bot, store, spec.panelRef, text, { parse_mode: 'HTML', reply_markup: ui.composeKeyboard() });
    else await bot.sendText(cid, text, { parse_mode: 'HTML' });
    return;
  }

  await typing(bot, msg, 'typing');

  const w = whisper.createWhisper(store, { whisperTtlMs: cfg.whisperTtlMs }, {
    chatId: cid,
    chatType: chat.type || 'private',
    chatTitle: chat.title || null,
    fromId: uid,
    fromLabel: label(from),
    targets: spec.targets,
    text: spec.text || '',
    flags: spec.flags || {},
    classified: spec.classified || null
  });

  const summary = await whisper.deliverWhisper(bot, store, cfg, w);
  const okCount = summary.ephemeral + summary.cards + summary.dms;

  const bits = [];
  if (summary.ephemeral) bits.push(`${summary.ephemeral} delivered invisibly in this chat`);
  if (summary.cards) bits.push(`${summary.cards} locked card${summary.cards > 1 ? 's' : ''} posted`);
  if (summary.dms) bits.push(`${summary.dms} sent by DM`);

  let html;
  if (okCount) {
    html = `🤫 <b>Whispered to ${esc(w.targetLabel)}.</b>\n\n${bits.join(' • ')}\n\n` +
      (summary.ephemeral ? 'They can answer with <code>/r their reply</code> — the group never sees it.'
        : 'Only they can open it. Everyone else gets a lock.');
    if (w.oneTime) html += '\n🔥 It burns the moment they read it.';
  } else if (summary.note === 'media-needs-ephemeral') {
    html = '🚫 I can only hide <b>media</b> whispers with an ephemeral message, and that needs me to be an <b>admin</b> of this group.\n\n' +
      'Promote me, or whisper text instead.';
  } else if (summary.note === 'no-target' || summary.failed.some((f) => f.kind === 'unknown-user')) {
    html = `🚫 I can't DM ${esc(w.targetLabel)} — they have never talked to me, and Telegram doesn't let a bot start a conversation.\n\n` +
      'Ask them to press /start here, or whisper them from a group you are both in.';
  } else if (summary.note === 'cannot-post') {
    html = '🚫 I have no rights to post in this chat.';
  } else {
    html = '🚫 That whisper could not be delivered.';
  }

  if (spec.panelRef) await editPanel(bot, store, spec.panelRef, html, { parse_mode: 'HTML', reply_markup: ui.composeKeyboard() });
  else await privateReply(bot, store, msg, html);

  if (okCount && msg.message_id) await safe(bot.react(cid, msg.message_id, SIGNAL.whisper), 'whisper-react');
}

/** `/r <text>` — invisible reply to the whisper this user is part of. */
async function handleReply(bot, store, msg, cfg, rawText) {
  const cid = chatId(msg);
  const uid = actor(msg);
  const from = msg.from || {};
  const text = rawText != null
    ? String(rawText).trim()
    : (msg.text || '').split(/\s+/).slice(1).join(' ').trim();
  store.getOrCreateUser(uid, { username: from.username, firstName: from.first_name });

  if (!text) {
    await privateReply(bot, store, msg,
      '↩️ <b>Invisible reply</b>\n\n<code>/r your answer</code> goes back to the person you are whispering with — nobody else in this chat can see your message or theirs.');
    return;
  }
  const r = await whisper.replyToWhisper(bot, store, cfg, {
    chatId: cid, chatType: (msg.chat && msg.chat.type) || 'private',
    chatTitle: msg.chat && msg.chat.title, from, text, messageId: msg.message_id
  });
  if (r.ok) {
    if (r.via === 'dm') await privateReply(bot, store, msg, '↩️ Delivered privately (this chat has no invisible messages — I need admin rights for those).');
    else if (msg.message_id) await safe(bot.react(cid, msg.message_id, SIGNAL.reply), 'reply-react');
  } else if (r.reason === 'no-context') {
    await privateReply(bot, store, msg,
      "↩️ There's no open whisper for you in this chat.\n\nUse <code>/w @someone secret</code> to start one.");
  } else {
    await privateReply(bot, store, msg, '🚫 That reply could not be delivered (' + esc(r.reason) + ').');
  }
}

/** `/whispers` — your recent whispers. */
async function handleWhispers(bot, store, msg) {
  const uid = actor(msg);
  const list = store.whispersFor(uid).map((w) => ({ ...w }));
  await privateReply(bot, store, msg, ui.whisperListHTML(list, uid), {}, true);
}

/** `/id` — your numeric user id (private, so nobody else in the group learns it). */
async function handleId(bot, store, msg) {
  const uid = actor(msg);
  const from = msg.from || {};
  store.getOrCreateUser(uid, { username: from.username, firstName: from.first_name });
  await privateReply(bot, store, msg,
    `🆔 <b>Your user id</b>\n\n<code>${esc(uid)}</code>\n\nUse it to whisper people who have no username:\n<code>/w ${esc(uid)} your secret</code>`, {}, true);
}

// ------------------------------------------------------------------ commands

async function handleMenu(bot, store, msg) {
  const cid = chatId(msg);
  const uid = actor(msg);
  const from = msg.from || {};
  const u = store.getOrCreateUser(uid, { username: from.username, firstName: from.first_name });
  const html = ui.menuHTML(u, bot.username, bot.name || bot.username);
  if (isGroup(msg)) {
    const r = await privateReply(bot, store, msg, html, { reply_markup: ui.menuKeyboard(u) }, true);
    store.setPanel(uid, r.sent && (r.sent.ephemeral_message_id || r.sent.message_id));
    return;
  }
  const sent = await bot.sendText(cid, html, { parse_mode: 'HTML', ...NO_PREVIEW, reply_markup: ui.menuKeyboard(u) });
  store.setPanel(uid, sent && sent.message_id);
}

async function handleLink(bot, store, msg) {
  const from = msg.from || {};
  const u = store.getOrCreateUser(actor(msg), { username: from.username, firstName: from.first_name });
  const link = linkFor(bot.username, u.token);
  await privateReply(bot, store, msg,
    `🔗 <b>Your anonymous link</b>\n\n<code>${esc(link)}</code>\n\nShare it anywhere — whoever opens it can message you with no name attached.`,
    { reply_markup: ui.shareKeyboard(link) }, true);
}

async function handleStats(bot, store, msg) {
  const from = msg.from || {};
  const u = store.getOrCreateUser(actor(msg), { username: from.username, firstName: from.first_name });
  await privateReply(bot, store, msg, ui.statsHTML(u), {}, true);
}

async function handlePause(bot, store, msg) {
  const cid = chatId(msg);
  const uid = actor(msg);
  store.getOrCreateUser(uid, {});
  store.setReceiving(uid, false);
  await privateReply(bot, store, msg, '🔒 <b>Paused.</b> Nobody can send you anonymous messages. /resume to reopen.');
  if (msg.message_id) await safe(bot.react(cid, msg.message_id, SIGNAL.paused), 'pause-react');
}

async function handleResume(bot, store, msg) {
  const cid = chatId(msg);
  const uid = actor(msg);
  store.getOrCreateUser(uid, {});
  store.setReceiving(uid, true);
  await privateReply(bot, store, msg, '🔓 <b>Resumed.</b> Anonymous messages are flowing again. /pause to close.');
  if (msg.message_id) await safe(bot.react(cid, msg.message_id, SIGNAL.resumed), 'resume-react');
}

async function handleCancel(bot, store, msg) {
  const cid = chatId(msg);
  const uid = actor(msg);
  const s = store.getWhisperSession(uid) || store.getSession(uid) || store.getGroupSession(uid);
  if (s) {
    store.clearWhisperSession(uid);
    store.clearSession(uid);
    store.clearGroupSession(uid);
    await editPanel(bot, store, {
      chatId: s.panelChatId, messageId: s.panelMsgId,
      ephemeralId: s.panelEphemeralId, receiverId: s.panelReceiverId
    }, "🚪 You've left anonymous mode. Open someone's link to message them.", { parse_mode: 'HTML' });
  } else {
    await privateReply(bot, store, msg, "🚪 You're not in anonymous mode right now.");
  }
}

async function handleHelp(bot, store, msg, cfg) {
  const cid = chatId(msg);
  const html = ui.helpHTML(bot.username, bot.name || bot.username);
  if (cfg && cfg.richGate && cfg.richGate.enabled && typeof bot.sendRich === 'function') {
    await sendRichOrText(bot, cid, { html, opts: { ...NO_PREVIEW }, gate: cfg.richGate });
    return;
  }
  await privateReply(bot, store, msg, html);
}

async function handleWall(bot, store, msg, cfg) {
  const cid = chatId(msg);
  const cId = cfg && cfg.channelId;
  const uid = actor(msg);
  const from = msg.from || {};
  const u = store.getOrCreateUser(uid, { username: from.username, firstName: from.first_name });
  if (!cId) {
    await privateReply(bot, store, msg, "🧱 The public wall isn't configured. Ask the bot admin to set <code>CHANNEL_ID</code>.");
    return;
  }
  const text = (msg.text || '').split(/\s+/).slice(1).join(' ').trim();
  if (!text && !hasMedia(msg)) {
    await privateReply(bot, store, msg,
      '🧱 Send <code>/wall your anonymous confession</code> and it posts to the public channel — no names, ever.');
    return;
  }
  const abuse = checkAbuse(text || (msg.caption || ''));
  if (!abuse.ok) {
    await privateReply(bot, store, msg, '🚫 The wall filter blocked that (' + esc(abuse.reason) + ').');
    return;
  }
  const rate = store.rateCheck(uid, 'wall', cfg || {});
  if (!rate.ok) { await privateReply(bot, store, msg, '🚧 ' + rate.reason); return; }

  const link = linkFor(bot.username, u.token);
  const kb = { inline_keyboard: [[{ text: '💬 Send your own anonymous message', url: link }]] };
  try {
    if (text) {
      await bot.sendText(cId, '🧱 <b>Anonymous confession</b>\n\n' + esc(text) + `\n\n— via @${esc(bot.username)}`,
        { parse_mode: 'HTML', reply_markup: kb, ...NO_PREVIEW });
    } else {
      const cls = classifyMessage(msg);
      if (cls.kind === 'media' || cls.kind === 'native') {
        await sendClassified(bot, cId, cls, '🧱 <b>Anonymous</b> • via @' + esc(bot.username),
          { parse_mode: 'HTML', reply_markup: kb });
      } else {
        await bot.sendText(cId, '🧱 <b>Anonymous</b> • via @' + esc(bot.username), { parse_mode: 'HTML', reply_markup: kb });
      }
    }
  } catch (err) {
    const kind = classifyError(err).kind;
    await privateReply(bot, store, msg, kind === KINDS.FORBIDDEN || kind === KINDS.CAPABILITY
      ? '🧱 I lost the rights to post in the wall channel. Ask the admin to re-add me.'
      : '🧱 The wall rejected that post (' + esc(kind) + ').');
    return;
  }
  store.bump('wallPosts');
  await privateReply(bot, store, msg, '🧱 Posted to the public wall <b>anonymously</b>! 🎉');
  if (msg.message_id) await safe(bot.react(cid, msg.message_id, SIGNAL.wall), 'wall-react');
}

async function handleGroup(bot, store, msg) {
  const cid = chatId(msg);
  const type = msg.chat && msg.chat.type;
  if (!whisper.isGroupChat(type)) {
    await bot.sendText(cid,
      '🕵️ Anonymous Q&A works inside a <b>group</b>. Add me to one and run <code>/group</code> there.\n\n' +
      'In a private chat you already have whispers: <code>/w @someone secret</code>.',
      { parse_mode: 'HTML', ...NO_PREVIEW });
    return;
  }
  const arg = (msg.text || '').split(/\s+/)[1] || '';
  if (arg === 'off') { store.setGroupActive(cid, false); await privateReply(bot, store, msg, '🔒 Anonymous Q&A turned <b>off</b> for this group.'); return; }
  if (arg === 'on') { store.setGroupActive(cid, true); await privateReply(bot, store, msg, '🔓 Anonymous Q&A turned <b>on</b> for this group.'); return; }
  if (arg === 'stats') {
    const g = store.getGroup(cid);
    await privateReply(bot, store, msg, `📊 This group has received <b>${g ? g.questions : 0}</b> anonymous questions.`);
    return;
  }

  const token = store.getOrCreateGroup(cid);
  store.setGroupActive(cid, true);
  const link = `https://t.me/${bot.username}?start=g_${token}`;
  await bot.sendText(cid, ui.groupLiveHTML(), {
    parse_mode: 'HTML', reply_markup: ui.groupKeyboard(link), ...NO_PREVIEW
  });
}

// -------------------------------------------------------------------- admin

const isAdmin = (cfg, id) => !!(cfg && cfg.adminIds && cfg.adminIds.length &&
  cfg.adminIds.map(String).includes(String(id)));

function adminStats(bot, store, cfg) {
  const c = store.counters();
  return {
    users: store.userCount(),
    anonReceived: c.anonReceived || 0,
    whispers: c.whispersSent || 0,
    whisperOpens: c.whisperOpens || 0,
    whisperPeeks: c.whisperPeeks || 0,
    whisperBurns: c.whisperBurns || 0,
    groups: store.groupCount(),
    groupQuestions: c.groupQuestions || 0,
    reports: c.reports || 0,
    transport: (cfg && cfg.transport) || '?',
    rich: bot.richGate ? (bot.richGate.enabled ? 'on' : 'off') : 'off',
    uptime: cfg && cfg.uptime ? cfg.uptime() : '?'
  };
}

/** One dashboard per admin: rich table when supported, classic HTML otherwise. */
async function renderAdminDashboard(bot, store, cfg, uid, messageId) {
  const stats = adminStats(bot, store, cfg);
  const spec = {
    rich: ui.adminRichMessage(stats), html: ui.adminHTML(stats), gate: bot.richGate,
    opts: { parse_mode: 'HTML', ...NO_PREVIEW, reply_markup: ui.adminKeyboard() }
  };
  const key = `admin:${uid}`;
  const mid = messageId || store.getPanel(key);
  if (mid) {
    try {
      await editRichOrText(bot, uid, mid, spec);
      store.setPanel(key, mid);
      return;
    } catch (err) {
      const kind = classifyError(err).kind;
      if (kind === KINDS.NOT_MODIFIED) return;
      if (kind !== KINDS.UNEDITABLE && kind !== KINDS.NOT_FOUND) throw err;
      // Deleted/uneditable: create just one fresh panel and remember its id.
    }
  }
  const sent = await sendRichOrText(bot, uid, spec);
  if (sent && sent.message_id) store.setPanel(key, sent.message_id);
}

async function handleAdmin(bot, store, msg, cfg) {
  const cid = chatId(msg);
  const from = msg.from || {};
  if (!isAdmin(cfg, from.id)) {
    await bot.sendText(cid, '🛠 This panel is for the bot admin only.');
    return;
  }
  if (cid !== String(from.id)) {
    await bot.sendText(cid, '🛠 For privacy, open this bot in a DM and send /admin there.');
    return;
  }
  await renderAdminDashboard(bot, store, cfg, cid);
}

// ------------------------------------------------------- callback queries

const accessible = (cb) => cb && cb.message && cb.message.chat && cb.message.date !== 0;

async function handleCallback(bot, store, cb, cfg) {
  const data = cb.data || '';
  const from = cb.from || {};
  const fromId = from.id != null ? String(from.id) : null;
  if (!fromId) return;

  const store1 = store.getOrCreateUser(fromId, { username: from.username, firstName: from.first_name });

  if (data.startsWith('wi_discard:')) {
    const w = store.getWhisper(data.slice('wi_discard:'.length));
    if (!w || !w.inlinePrepared || w.fromId !== fromId || w.status !== 'active') {
      await safe(bot.answerCb(cb.id, { text: '🗑 Not your draft' }), 'wi-discard-denied');
      return;
    }
    await whisper.burnWhisper(bot, store, w, 'discarded by its sender');
    if (accessible(cb)) await editPanel(bot, store,
      { chatId: String(cb.message.chat.id), messageId: cb.message.message_id },
      '🗑 <b>Private media draft discarded.</b>', { parse_mode: 'HTML' });
    await safe(bot.answerCb(cb.id, { text: '🗑 Discarded' }), 'wi-discard');
    return;
  }

  // ---- whisper callbacks (these answer with the secret, so they go first) ----
  if (data.startsWith('w_open:') || data.startsWith('w_burn:') ||
      data.startsWith('w_delete:') || data.startsWith('w_reply:')) {
    return handleWhisperCallback(bot, store, cb, cfg, data, fromId, store1);
  }

  if (!accessible(cb)) {
    await safe(bot.answerCb(cb.id, { text: '⌛ That message is too old.' }), 'cb-stale');
    return;
  }
  const cid = String(cb.message.chat.id);
  const mid = cb.message.message_id;
  const eid = cb.message.ephemeral_message_id;
  const panelRef = eid
    ? { chatId: cid, ephemeralId: eid, receiverId: Number(fromId) }
    : { chatId: cid, messageId: mid };
  // Older public group panels, forwarded buttons and fallback panels must
  // never edit a user's history, link or settings into the public transcript.
  const personalPanelData = new Set(['pause', 'resume', 'protect', 'spoiler', 'autodelete',
    'silent', 'stats', 'whispers', 'blocked', 'link', 'menu', 'refresh', 'help']);
  if (cid !== fromId && !eid && personalPanelData.has(data)) {
    await safe(bot.answerCb(cb.id, { text: '🔒 Open my DM for your private panel.' }), 'private-panel-hint');
    return;
  }
  if (eid && cb.message.receiver_user && String(cb.message.receiver_user.id) !== fromId) {
    await safe(bot.answerCb(cb.id, { text: '🔒 Not your panel.' }), 'private-panel-owner');
    return;
  }

  // ---- report / block / burn / reply on a delivered anonymous message ----
  if (data.startsWith('report:') || data.startsWith('block:') ||
      data.startsWith('burn:') || data.startsWith('reply:') || data.startsWith('unblock:')) {
    return handleDeliveryCallback(bot, store, cb, cfg, data, fromId, cid, mid);
  }

  // ---- instant UI toggles: answer first so the spinner dies immediately ----
  const toast = {
    idea: '💡', cancel: '🚪', pause: '🔒 Paused', resume: '🔓 Resumed',
    protect: null, spoiler: null, autodelete: null, silent: null,
    refresh: '🔄', menu: '🎛', stats: '📊', help: '❓', whispers: '🤫',
    blocked: '🚫', link: '🔗', wall: null, whisper_help: '🤫'
  };
  if (Object.prototype.hasOwnProperty.call(toast, data) && toast[data] !== null) {
    await safe(bot.answerCb(cb.id, { text: toast[data] }), 'cb-toast');
  }

  switch (data) {
    case 'idea':
      await editPanel(bot, store, panelRef,
        '💡 <b>Idea:</b> ' + esc(pick(IDEAS)) + '\n\nOr just say whatever. Tap <b>Cancel</b> when done.',
        { parse_mode: 'HTML', reply_markup: ui.composeKeyboard() });
      return;

    case 'cancel': {
      const s = store.getWhisperSession(fromId) || store.getSession(fromId) || store.getGroupSession(fromId);
      if (s) {
        store.clearWhisperSession(fromId);
        store.clearSession(fromId);
        store.clearGroupSession(fromId);
        await editPanel(bot, store, {
          chatId: s.panelChatId || cid, messageId: s.panelMsgId || mid,
          ephemeralId: s.panelEphemeralId, receiverId: s.panelReceiverId
        }, "🚪 You've left anonymous mode.", { parse_mode: 'HTML' });
      } else {
        await editPanel(bot, store, panelRef, '🚪 Nothing to cancel.', { parse_mode: 'HTML' });
      }
      return;
    }

    case 'pause': store.setReceiving(fromId, false); break;
    case 'resume': store.setReceiving(fromId, true); break;
    case 'protect': {
      const v = store.toggle(store1, 'protect');
      await safe(bot.answerCb(cb.id, { text: `🛡 Protect ${v ? 'ON' : 'OFF'}` }), 'cb-protect');
      break;
    }
    case 'spoiler': {
      const v = store.toggle(store1, 'spoiler');
      await safe(bot.answerCb(cb.id, { text: `👁 Spoiler ${v ? 'ON' : 'OFF'}` }), 'cb-spoiler');
      break;
    }
    case 'silent': {
      const v = store.toggle(store1, 'silent');
      await safe(bot.answerCb(cb.id, { text: `🔕 Silent delivery ${v ? 'ON' : 'OFF'}` }), 'cb-silent');
      break;
    }
    case 'autodelete': {
      const next = ui.nextAutoDelete(store1.autoDeleteMs);
      store.setField(fromId, 'autoDeleteMs', next);
      await safe(bot.answerCb(cb.id, { text: `🔥 Auto-burn ${ui.autoDeleteLabel(next)}` }), 'cb-autodelete');
      break;
    }
    case 'stats':
      await editPanel(bot, store, panelRef, ui.statsHTML(store1),
        { parse_mode: 'HTML', ...NO_PREVIEW, reply_markup: ui.menuKeyboard(store1) });
      await safe(bot.answerCb(cb.id, { text: '📊' }), 'cb-stats');
      return;
    case 'whispers': {
      const list = store.whispersFor(fromId);
      await editPanel(bot, store, panelRef, ui.whisperListHTML(list, fromId),
        { parse_mode: 'HTML', ...NO_PREVIEW, reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'menu' }]] } });
      await safe(bot.answerCb(cb.id, { text: '🤫' }), 'cb-whispers');
      return;
    }
    case 'blocked': {
      const blocked = store.listBlocked(fromId);
      const rows = blocked.length
        ? blocked.slice(-8).map((id) => [{ text: `✅ Unblock ${id}`, callback_data: 'unblock:' + id }])
        : [[{ text: '— nobody blocked —', callback_data: 'noop' }]];
      rows.push([{ text: '🔙 Back', callback_data: 'menu' }]);
      await editPanel(bot, store, panelRef,
        `🚫 <b>Blocked senders</b>\n\n${blocked.length ? blocked.length + ' sender(s) can no longer message you.' : 'Nobody is blocked.'}`,
        { parse_mode: 'HTML', ...NO_PREVIEW, reply_markup: { inline_keyboard: rows } });
      await safe(bot.answerCb(cb.id, { text: '🚫' }), 'cb-blocked');
      return;
    }
    case 'link': {
      const link = linkFor(bot.username, store1.token);
      await editPanel(bot, store, panelRef,
        `🔗 <b>Your anonymous link</b>\n\n<code>${esc(link)}</code>`,
        { parse_mode: 'HTML', ...NO_PREVIEW, reply_markup: ui.shareKeyboard(link) });
      await safe(bot.answerCb(cb.id, { text: '🔗 Link' }), 'cb-link');
      return;
    }
    case 'wall':
      await safe(bot.answerCb(cb.id, {
        text: (cfg && cfg.channelId) ? '🧱 Use /wall <text>' : '🧱 Wall not configured'
      }), 'cb-wall');
      return;
    case 'whisper_help':
      await editPanel(bot, store, panelRef,
        '🤫 <b>Whispering</b>\n\nIn a group: <code>/w @alice your secret</code>\n' +
        'Only Alice sees it — everyone else sees nothing at all.\n\n' +
        'Anywhere: <code>@' + esc(bot.username) + ' @alice your secret</code> (shows sender → recipient).\n' +
        'Add a final <code>0</code> to hide the sender label — Telegram still shows who posted the inline message.\n' +
        'For group <code>/w</code> whispers, she can answer with <code>/r her reply</code> when the bot knows both user ids. Inline cards reveal via the Open button.\n\n' +
        'Flags: <code>!1</code> burn after reading · <code>!5m</code> expire · <code>!nosender</code> · <code>!sign</code>',
        { parse_mode: 'HTML', ...NO_PREVIEW, reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'menu' }]] } });
      return;
    case 'help':
      await editPanel(bot, store, panelRef, ui.helpHTML(bot.username, bot.name || bot.username),
        { parse_mode: 'HTML', ...NO_PREVIEW, reply_markup: ui.menuKeyboard(store1) });
      return;
    case 'menu':
    case 'refresh':
      await renderMenu(bot, store, panelRef, store1, bot.name || bot.username);
      return;
    case 'noop':
      await safe(bot.answerCb(cb.id, {}), 'cb-noop');
      return;
    case 'admin:refresh':
    case 'admin:reports':
      return handleAdminCallback(bot, store, cb, cfg, data, fromId, cid, mid);
    default:
      await safe(bot.answerCb(cb.id, { text: '?' }), 'cb-unknown');
  }

  // Every setting toggle lands here: re-render the same message, in place.
  await renderMenu(bot, store, panelRef, store1, bot.name || bot.username);
}

async function renderMenu(bot, store, ref, u, botName) {
  await editPanel(bot, store, ref, ui.menuHTML(u, bot.username, botName),
    { parse_mode: 'HTML', ...NO_PREVIEW, reply_markup: ui.menuKeyboard(u) });
}

async function handleAdminCallback(bot, store, cb, cfg, data, fromId, cid, mid) {
  if (!isAdmin(cfg, fromId) || cid !== fromId) {
    await safe(bot.answerCb(cb.id, { text: '🛠 Open /admin in the bot DM' }), 'cb-admin'); return;
  }
  if (data === 'admin:reports') {
    const reports = store.getReports(8).reverse();
    const html = reports.length
      ? '🚩 <b>Last reports</b>\n\n' + reports.map((r) =>
        `• owner <code>${esc(r.owner)}</code> ← sender <code>${esc(r.sender)}</code> · ${esc(r.reason || '')}`).join('\n')
      : '🚩 No reports yet.';
    const result = await editPanel(bot, store, { chatId: cid, messageId: mid }, html,
      { parse_mode: 'HTML', ...NO_PREVIEW, reply_markup: ui.adminKeyboard() });
    if (result) store.setPanel(`admin:${fromId}`, result.recreated ? result.recreated.messageId : mid);
  } else {
    await renderAdminDashboard(bot, store, cfg, fromId, mid);
  }
  await safe(bot.answerCb(cb.id, { text: '🛠' }), 'cb-admin-ok');
}

/** Report / block / burn / reply on a delivered anonymous message. */
async function handleDeliveryCallback(bot, store, cb, cfg, data, owner, cid, mid) {
  const [action, rawId] = data.split(':');
  const msgId = Number(rawId);

  if (action === 'unblock') {
    store.unblock(owner, rawId);
    await safe(bot.answerCb(cb.id, { text: `✅ ${rawId} unblocked` }), 'cb-unblock');
    return;
  }
  if (action === 'reply') {
    /*
     * Turn the buttons into a force_reply so the client opens the reply box
     * already quoting the anonymous message. Whatever they type comes back to us
     * with reply_to_message set, which the thread logic already understands.
     */
    await safe(bot.editMarkup(cid, msgId, {
      force_reply: true, selective: true, input_field_placeholder: 'Type your anonymous reply…'
    }), 'force-reply');
    await safe(bot.answerCb(cb.id, { text: '↩️ Now type your reply — it goes back anonymously' }), 'cb-reply');
    return;
  }
  if (action === 'burn') {
    await safe(bot.deleteMessage(cid, msgId), 'burn');
    await safe(bot.answerCb(cb.id, { text: '🔥 Burned' }), 'cb-burn');
    return;
  }

  const threadId = store.threadByLink(owner, msgId);
  if (!threadId) { await safe(bot.answerCb(cb.id, { text: '⚠️ Already handled or expired' }), 'cb-stale-thread'); return; }
  const thread = store.getThread(threadId);
  if (!thread) { await safe(bot.answerCb(cb.id, { text: '⚠️ That conversation is gone' }), 'cb-gone'); return; }

  if (action === 'report') {
    store.addReport({ owner, sender: thread.sender, threadId, reason: 'user report' });
    store.block(owner, thread.sender);
    store.closeThread(threadId);
    await safe(bot.react(owner, msgId, SIGNAL.reported), 'report-react');
    await safe(bot.editMarkup(owner, msgId, { inline_keyboard: [] }), 'clear-buttons');
    for (const adminId of (cfg && cfg.adminIds) || []) {
      await safe(bot.sendText(adminId,
        `🚩 <b>Report</b> @${esc(bot.username)}\nOwner: <code>${esc(owner)}</code>\nSender: <code>${esc(thread.sender)}</code>\nThread: <code>${esc(threadId)}</code>`,
        { parse_mode: 'HTML' }), 'admin-report');
    }
    await safe(bot.answerCb(cb.id, { text: '🚩 Reported & sender blocked' }), 'cb-report');
    return;
  }

  // block
  store.block(owner, thread.sender);
  store.closeThread(threadId);
  await safe(bot.react(owner, msgId, SIGNAL.blocked), 'block-react');
  await safe(bot.editMarkup(owner, msgId, { inline_keyboard: [] }), 'clear-buttons');
  await safe(bot.answerCb(cb.id, { text: '🚫 Sender blocked' }), 'cb-block');
}

/** Open / burn / delete / reply on a whisper card. */
async function handleWhisperCallback(bot, store, cb, cfg, data, fromId, user) {
  const [action, id] = data.split(':');
  const w = store.getWhisper(id);

  if (action === 'w_open') {
    if (requiresPrivateReveal(w)) {
      if (cb.inline_message_id && !w.inlineMessageId) store.updateWhisper(w.id, { inlineMessageId: cb.inline_message_id });
      const access = await whisper.checkWhisperAccess(bot, store, w, cb.from);
      if (!access.allowed) {
        await safe(bot.answerCb(cb.id, { text: access.alert || access.toast, show_alert: !!access.alert }), 'cb-open-denied');
        return;
      }
      // Inline callbacks carry an inline_message_id, NOT a chat_id. Opening a
      // bot DM with an authenticated deep link is the only way to show media
      // without making the photo public to everyone in the original chat.
      const url = `https://t.me/${bot.username}?start=wm_${w.id}`;
      try {
        await bot.answerCb(cb.id, { url });
      } catch {
        await safe(bot.answerCb(cb.id, { text: `Open @${bot.username} privately and send /start wm_${w.id}`, show_alert: true }), 'cb-open-link');
      }
      return;
    }
    const r = await whisper.revealWhisper(bot, store, w, cb.from);
    await safe(bot.answerCb(cb.id, r.allowed ? { text: r.alert, show_alert: true } : { text: r.alert || r.toast, show_alert: !!r.alert }), 'cb-open');
    return;
  }
  if (!w) { await safe(bot.answerCb(cb.id, { text: '⌛ Gone' }), 'cb-gone'); return; }

  const isSender = w.fromId === fromId;
  if (action === 'w_burn' || action === 'w_delete') {
    if (!isSender && !whisper.isRecipient(w, cb.from)) {
      await safe(bot.answerCb(cb.id, { text: "🤫 Not yours" }), 'cb-notyours');
      return;
    }
    await whisper.burnWhisper(bot, store, w, action === 'w_burn' ? 'burned by its reader' : 'deleted by its sender');
    await safe(bot.answerCb(cb.id, { text: '🔥 Burned' }), 'cb-burned');
    return;
  }
  if (action === 'w_reply') {
    await safe(bot.answerCb(cb.id, {
      text: '↩️ Type /r your reply — in this chat it stays invisible to everyone else.'
    }), 'cb-wreply');
    return;
  }
  await safe(bot.answerCb(cb.id, { text: '?' }), 'cb-wunknown');
}

// ------------------------------------------------------------- inline mode

/*
 * `@bot …` in any chat. Two jobs:
 *   • no targets  -> your share card (the viral loop)
 *   • with target -> a locked whisper card, droppable into ANY chat, even one
 *     the bot has never been added to. Inline cards name the sender by default;
 *     a standalone final 0 leaves their name off the card and reveal.
 * Telegram still shows who posted an inline message, even with the 0 switch.
 * Whisper answers are always `is_personal` with `cache_time: 0`: Telegram caches
 * inline results per query otherwise, and a cached whisper card would be shown
 * to the wrong person.
 */
function inlineWhisperResult(w) {
  const privateOpen = w.inlinePrepared || !ui.whisperAlertFits(w);
  return {
    type: 'article', id: w.id,
    title: `🤫 Whisper to ${w.targetLabel} · ${w.signed ? 'from ' + w.fromLabel : 'no sender label'}`,
    description: w.inlinePrepared ? '🖼 Private media — only a text-only card is posted'
      : privateOpen ? '📖 Full message opens privately in the bot'
        : w.signed ? `🔒 ${w.text.slice(0, 90)}`
          : `⚠️ Telegram shows who posts inline messages · 🔒 ${w.text.slice(0, 45)}`,
    input_message_content: {
      message_text: ui.whisperCardHTML(w), parse_mode: 'HTML',
      link_preview_options: { is_disabled: true }
    },
    reply_markup: ui.whisperKeyboard(w, false)
  };
}

async function handleInline(bot, store, query, cfg) {
  const from = query.from || {};
  const fromId = from.id != null ? String(from.id) : null;
  if (!fromId) return;
  const u = store.getOrCreateUser(fromId, { username: from.username, firstName: from.first_name });
  const link = linkFor(bot.username, u.token);
  const raw = String(query.query || '');

  // /wi prepares media in a DM; its inline query only exposes a locked article.
  // Never return the underlying photo as an InlineQueryResultPhoto: that would
  // post it to the entire chat, even with has_spoiler enabled.
  if (raw.trim().startsWith('share:')) {
    const match = /^share:([a-f0-9]{12})$/i.exec(raw.trim());
    const w = match && store.getWhisper(match[1]);
    const allowed = w && w.inlinePrepared && w.media && w.chatType === 'inline' &&
      w.fromId === fromId && w.status === 'active' && w.expiresAt > Date.now();
    await bot.answerInline(query.id, allowed ? [inlineWhisperResult(w)] : [],
      { cache_time: 0, is_personal: true });
    return;
  }

  const parsed = whisper.parseInlineWhisperInput(raw, store, { maxTargets: cfg ? cfg.maxWhisperTargets : 5 });

  if (!parsed.targets.length) {
    const results = [{
      type: 'article', id: 'share',
      title: '📨 Share your anonymous link',
      description: 'Anyone who opens it can message you with no name attached.',
      input_message_content: {
        message_text: `🤫 Send me secret messages — I won't know who you are:\n${link}`,
        link_preview_options: { is_disabled: true }
      },
      reply_markup: { inline_keyboard: [[{ text: '💬 Open anonymous box', url: link }]] }
    }];
    if (raw.trim()) {
      results.unshift({
        type: 'article', id: 'hint',
        title: '🤫 Whisper: @' + raw.replace(/^@?/, '').split(/\s+/)[0] + ' …',
        description: 'Format: @username message [0 = hide sender]',
        input_message_content: {
          message_text: '🤫 To whisper, name the person first:\n<code>@' + esc(bot.username) + ' @alice your secret</code>\n\nAdd <code>0</code> at the end to hide your name on the card (Telegram still shows who posted it).',
          parse_mode: 'HTML', link_preview_options: { is_disabled: true }
        }
      });
    }
    await bot.answerInline(query.id, results, { cache_time: 0, is_personal: true });
    return;
  }

  if (!parsed.text) {
    await bot.answerInline(query.id, [{
      type: 'article', id: 'need-text',
      title: `🤫 Whisper to ${whisper.targetLabel(parsed.targets)}`,
      description: 'Type a message, then add 0 to hide your name',
      input_message_content: {
        message_text: `🤫 <b>Whisper to ${esc(whisper.targetLabel(parsed.targets))}</b>\n\nType your message: <code>@${esc(bot.username)} @alice your secret</code>\nAdd <code>0</code> at the end to hide your name on the card (Telegram still shows who posted it).`,
        parse_mode: 'HTML', link_preview_options: { is_disabled: true }
      }
    }], { cache_time: 0, is_personal: true });
    return;
  }

  const fromLabel = from.username ? '@' + from.username : label(from);
  // Callback alerts fit only ~200 characters. Longer inline text uses the same
  // authenticated private-bot reveal as media; never truncate a secret.
  // The private text is wrapped in a DM header; stay under sendMessage's 4096.
  const maxLength = Math.min((cfg && cfg.maxWhisperLength) || 3500, 3900);
  if (parsed.text.length > maxLength) {
    await bot.answerInline(query.id, [{
      type: 'article', id: 'too-long',
      title: `🚧 Shorten your whisper (max ${maxLength} characters)`,
      description: 'This whisper was not sent.',
      input_message_content: {
        message_text: `🚧 Whisper not sent. Shorten it to ${maxLength} characters or use /w in a group with this bot.`
      }
    }], { cache_time: 0, is_personal: true });
    return;
  }

  // Inline queries fire on every keystroke — reuse the record for identical input.
  const hash = require('crypto').createHash('sha1')
    .update([fromId, fromLabel, parsed.targets.map((t) => t.key).join(','), parsed.text, JSON.stringify(parsed.flags)].join('|'))
    .digest('hex').slice(0, 20);
  let w = store.dedupeWhisperKey(hash);
  if (!w) {
    w = whisper.createWhisper(store, { whisperTtlMs: cfg && cfg.whisperTtlMs }, {
      chatId: null, chatType: 'inline', chatTitle: null,
      fromId, fromLabel, targets: parsed.targets,
      text: parsed.text, flags: parsed.flags, classified: null
    });
    store.rememberWhisperKey(hash, w.id);
  }

  await bot.answerInline(query.id, [inlineWhisperResult(w)], { cache_time: 0, is_personal: true });
}

/**
 * `chosen_inline_result` tells us the `inline_message_id` of the card the user
 * actually sent — the only handle we get on a message posted into a chat the bot
 * is not a member of. Store it so the card can be edited (peek counter, burn).
 */
async function handleChosenInlineResult(bot, store, result) {
  if (!result || !result.inline_message_id) return;
  const w = store.getWhisper(result.result_id);
  if (!w || !result.from || String(result.from.id) !== w.fromId) return;
  // A chosen result must never transfer ownership of somebody else's secret.
  store.updateWhisper(w.id, { inlineMessageId: result.inline_message_id });
}

// ------------------------------------------------------------- guest mode

/*
 * Bot API 10.0 guest mode: someone @-mentions the bot in a chat it is NOT a
 * member of. The only way back in is `answerGuestQuery`, so a guest whisper is
 * delivered as a locked card via that single reply. Requires Guest Mode to be
 * enabled in @BotFather; harmless when it isn't (we just never get these).
 */
async function handleGuest(bot, store, msg, cfg) {
  const guestQueryId = msg.guest_query_id;
  const caller = msg.guest_bot_caller_user || msg.from;
  const chat = msg.guest_bot_caller_chat || msg.chat;
  if (!guestQueryId || !caller || typeof bot.answerGuest !== 'function') return;

  const fromId = String(caller.id);
  store.getOrCreateUser(fromId, { username: caller.username, firstName: caller.first_name });
  const parsed = whisper.parseWhisperInput(msg.text || '', store, { maxTargets: cfg ? cfg.maxWhisperTargets : 5 });
  if (!parsed.targets.length || !parsed.text) return;

  const w = whisper.createWhisper(store, { whisperTtlMs: cfg && cfg.whisperTtlMs }, {
    chatId: chat ? String(chat.id) : null,
    chatType: (chat && chat.type) || 'inline',
    chatTitle: (chat && chat.title) || null,
    fromId, fromLabel: label(caller), targets: parsed.targets,
    text: parsed.text, flags: parsed.flags, classified: null
  });

  const r = await safe(bot.answerGuest(guestQueryId, {
    type: 'article', id: w.id,
    title: `🤫 Whisper to ${w.targetLabel}`,
    input_message_content: { message_text: ui.whisperCardHTML(w), parse_mode: 'HTML', link_preview_options: { is_disabled: true } },
    reply_markup: ui.whisperKeyboard(w, false)
  }), 'guest-answer');
  if (r.ok && r.value && r.value.inline_message_id) {
    store.updateWhisper(w.id, { inlineMessageId: r.value.inline_message_id });
  }
}

// ------------------------------------------------------- membership changes

/*
 * `my_chat_member` is how we learn our own rights in a chat. Being promoted to
 * admin is exactly what unlocks ephemeral messages (Bot API 10.2), so the
 * "this chat can't do ephemeral" latch has to be dropped the moment it happens —
 * otherwise a group that promotes the bot later stays stuck on locked cards.
 */
async function handleMyChatMember(bot, store, update) {
  const chat = update && update.chat;
  const status = update && update.new_chat_member && update.new_chat_member.status;
  if (!chat || !status) return;
  if (status === 'administrator' || status === 'creator') {
    store.clearChatCap(chat.id, 'ephemeral');
    const title = chat.title ? ` <b>${esc(chat.title)}</b>` : '';
    await safe(bot.sendText(chat.id,
      `🤫 <b>Invisible whispers are now available here.</b>\n\n<code>/w @someone your secret</code> — only they will see it, and <code>/r</code> replies stay hidden too.`,
      { parse_mode: 'HTML', ...NO_PREVIEW }), 'admin-notice');
  } else if (status === 'kicked' || status === 'left' || status === 'restricted') {
    store.setChatCap(chat.id, 'ephemeral', false);
  }
}

module.exports = {
  // handlers
  handleStart, handleMessage, handleMenu, handleLink, handleStats, handlePause, handleResume,
  handleCancel, handleHelp, handleWall, handleGroup, handleCallback, handleInline,
  handleChosenInlineResult, handleGuest, handleWhisper, handleInlineMedia, handleReply, handleWhispers,
  handleId, handleAdmin, handleMyChatMember,
  // internals worth testing directly
  editPanel, editSessionPanel, privateReply, openPanel, panelOf, sendClassified, finishDelivery, isAdmin,
  // re-exported from ./ui so existing callers/tests keep working
  linkFor, esc, composeDelivered: ui.composeDelivered, composeReply: ui.composeReply,
  menuHTML: ui.menuHTML, welcomeHTML: ui.welcomeHTML, statsHTML: ui.statsHTML, helpHTML: ui.helpHTML,
  menuKeyboard: ui.menuKeyboard, shareKeyboard: ui.shareKeyboard, composeKeyboard: ui.composeKeyboard,
  reportKeyboard: ui.reportKeyboard, reactionOf, IDEAS
};
