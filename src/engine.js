'use strict';
/*
 * WHoevenYori engine — pure business logic. No Telegram imports here.
 * It talks to a tiny `bot` adapter interface so we can unit-test it with a mock:
 *   bot.username                     -> string
 *   bot.sendText(chatId, text, opts) -> { message_id }
 *   bot.sendMedia(chatId, type, fileId, caption, opts, payload) -> { message_id }
 *   bot.editText(chatId, messageId, text, opts)
 *   bot.editMarkup(chatId, messageId, replyMarkup)
 *   bot.react(chatId, messageId, emoji)
 *   bot.answerCb(callbackQueryId, opts)
 *   bot.answerInline(inlineQueryId, results)
 */
const { classifyMessage, hasMedia } = require('./media');
const { checkAbuse } = require('./filter');

const REACTIONS = ['👀', '📨', '💌', '🔥', '✨', '🤫', '💬', '🫣'];
const IDEAS = [
  'One thing you would change about the world?',
  'A secret you have never told anyone here?',
  'Your honest first impression of me?',
  'Something you wish you had said out loud?',
  'A song that has been stuck in your head?',
  'A small thing that makes you happy?',
  'Rate my energy today, honestly.',
  'A question you are afraid to ask out loud?'
];

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const linkFor = (username, token) => `https://t.me/${username}?start=${token}`;
const chatId = (msg) => String(msg.chat.id);
const safe = async (p) => { try { await p; } catch (e) { /* best-effort (reactions/edits/ephemeral) */ } };

// ---- keyboards (plain InlineKeyboardMarkup JSON) ----
function shareKeyboard(link) {
  const url = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent("Send me anonymous messages 💬 — I won't know who you are")}`;
  return { inline_keyboard: [[{ text: '📤 Share my link', url }]] };
}
function composeKeyboard() {
  return { inline_keyboard: [[
    { text: '💡 Idea', callback_data: 'idea' },
    { text: '🚪 Cancel', callback_data: 'cancel' }
  ]] };
}
function reportKeyboard(deliveredMsgId) {
  return { inline_keyboard: [[
    { text: '🚩 Report', callback_data: 'report:' + deliveredMsgId },
    { text: '🚫 Block', callback_data: 'block:' + deliveredMsgId }
  ]] };
}
function menuKeyboard(u) {
  return { inline_keyboard: [
    [
      { text: u.receiving ? '🔓 Receiving: ON' : '🔒 Receiving: OFF', callback_data: u.receiving ? 'pause' : 'resume' },
      { text: '🔗 Link', callback_data: 'link' }
    ],
    [
      { text: `🛡 Protect: ${u.protect ? 'ON' : 'OFF'}`, callback_data: 'protect' },
      { text: `👁 Spoiler: ${u.spoiler ? 'ON' : 'OFF'}`, callback_data: 'spoiler' }
    ],
    [
      { text: '📊 Stats', callback_data: 'stats' },
      { text: '🧱 Wall', callback_data: 'wall' }
    ],
    [
      { text: '❓ Help', callback_data: 'help' },
      { text: '🔄 Refresh', callback_data: 'refresh' }
    ]
  ] };
}
const NO_PREVIEW = { link_preview_options: { is_disabled: true } };

// ---- text builders ----
function welcomeHTML(user, link) {
  const name = esc(user.firstName || 'there');
  return `👋 <b>Hey ${name}!</b>\n\n` +
    `I'm <b>WHoevenYori</b> — your secret anonymous inbox.\n\n` +
    `🔗 <b>Your link:</b>\n<code>${esc(link)}</code>\n\n` +
    `Share it anywhere. Friends who open it can message you <b>anonymously</b> — and you can reply back, still anonymous. Threaded, private, no names.\n\n` +
    `Tap a button below to get started.`;
}
function menuHTML(u, botUsername) {
  const link = linkFor(botUsername, u.token);
  return `🎛 <b>WHoevenYori Control Panel</b>\n\n` +
    `▫️ Receiving: <b>${u.receiving ? 'ON 🔓' : 'OFF 🔒'}</b>\n` +
    `▫️ Protect content: <b>${u.protect ? 'ON 🛡' : 'OFF'}</b>\n` +
    `▫️ Spoiler reveal: <b>${u.spoiler ? 'ON 👁' : 'OFF'}</b>\n` +
    `▫️ Received: <b>${u.received}</b> • Sent: <b>${u.sent}</b>\n\n` +
    `🔗 <code>${esc(link)}</code>\n\nTap buttons to change settings instantly.`;
}
function statsHTML(u) {
  return `📊 <b>Your WHoevenYori stats</b>\n\n` +
    `📥 Received: <b>${u.received}</b>\n` +
    `📤 Sent: <b>${u.sent}</b>\n` +
    `🔘 Status: <b>${u.receiving ? 'Receiving 🔓' : 'Paused 🔒'}</b>\n` +
    `🛡 Protect: <b>${u.protect ? 'ON' : 'OFF'}</b> • 👁 Spoiler: <b>${u.spoiler ? 'ON' : 'OFF'}</b>`;
}
function helpHTML() {
  return `❓ <b>How WHoevenYori works</b>\n\n` +
    `1️⃣ Share your link. Anyone who opens it can message you <b>anonymously</b>.\n` +
    `2️⃣ You get each message privately. <b>Reply</b> to any message to talk back — still anonymous.\n` +
    `3️⃣ Conversations are <b>threaded</b>, so it feels like a real chat.\n` +
    `4️⃣ In groups, run <code>/group</code> to let members ask <b>anonymous questions</b>.\n\n` +
    `<b>Commands</b>\n` +
    `/link — your anonymous link\n` +
    `/menu — this panel\n` +
    `/pause · /resume — stop/start receiving\n` +
    `/stats — your numbers\n` +
    `/group — anonymous Q&A in a group\n` +
    `/wall &lt;text&gt; — post an anonymous confession to the public wall\n` +
    `/cancel — leave anonymous mode\n` +
    `/help — this message\n\n` +
    `🛡 <b>Protect</b> stops people forwarding your messages. 👁 <b>Spoiler</b> hides them until tapped.\n` +
    `🚩 <b>Report</b> / 🚫 <b>Block</b> any message you receive.`;
}

// Build delivered text + entities (no parse_mode, so spoiler works cleanly).
function composeDelivered(body, target) {
  const header = '📨 Anonymous message';
  const sep = '\n\n';
  const full = header + sep + body;
  const entities = [{ type: 'bold', offset: 0, length: header.length }];
  if (target && target.spoiler) entities.push({ type: 'spoiler', offset: header.length + sep.length, length: body.length });
  return { text: full, entities };
}
function composeReply(body) {
  const header = '💬 Reply (still anonymous)';
  const sep = '\n\n';
  const full = header + sep + body;
  return { text: full, entities: [{ type: 'bold', offset: 0, length: header.length }] };
}
const composeCaption = (cls) => '📨 <b>Anonymous message</b>' + (cls.caption ? '\n\n' + esc(cls.caption) : '');
const composeReplyCaption = (cls) => '💬 <b>Reply (still anonymous)</b>' + (cls.caption ? '\n\n' + esc(cls.caption) : '');

// ---- /start ----
async function handleStart(bot, store, msg) {
  const cid = chatId(msg);
  const from = { username: msg.from && msg.from.username, firstName: msg.from && msg.from.first_name };
  const user = store.getOrCreateUser(cid, from);
  const payload = (msg.text || '/start').trim().split(/\s+/)[1] || null;

  // Group "ask me anything" deep link: ?start=g_<token>
  if (payload && payload.startsWith('g_')) {
    const groupId = store.getGroupByToken(payload.slice(2));
    if (!groupId) { await bot.sendText(cid, '❌ This group link is invalid or expired.'); return; }
    const g = store.getGroup(groupId);
    if (!g || !g.active) { await bot.sendText(cid, "🔒 This group's Q&A is currently off."); return; }
    const panel = await bot.sendText(cid,
      `🕵️ <b>Anonymous group question</b>\n\n` +
      `Your question will appear in the group with no name attached. Photos, stickers, voice — all anonymous.\n` +
      `Tap <b>Cancel</b> when done.`,
      { parse_mode: 'HTML', reply_markup: composeKeyboard() });
    store.setGroupSession(cid, { groupId, panelChatId: cid, panelMsgId: panel.message_id });
    return;
  }

  if (payload) {
    const target = store.getTargetByToken(payload);
    if (!target) { await bot.sendText(cid, '❌ This anonymous link is invalid or expired.'); return; }
    if (target === cid) { await bot.sendText(cid, "🙃 That's your own link! Share it so others can message you anonymously."); return; }
    const tUser = store.getUser(target);
    const panel = await bot.sendText(cid,
      `🕵️ <b>You're now anonymous</b> with ${esc(tUser.firstName || 'someone')}.\n\n` +
      `Say anything — they won't know it's you. Photos, stickers, voice… all anonymous.\n` +
      `Tap <b>Cancel</b> when done, or <b>Idea</b> if you're stuck.`,
      { parse_mode: 'HTML', reply_markup: composeKeyboard() });
    store.setSession(cid, { target, panelChatId: cid, panelMsgId: panel.message_id });
    if (tUser.receiving) await bot.sendText(target, '👀 Someone just opened your anonymous box…');
    return;
  }

  const link = linkFor(bot.username, user.token);
  await bot.sendText(cid, welcomeHTML(user, link), {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: [
      [{ text: '🎛 Open control panel', callback_data: 'menu' }],
      shareKeyboard(link).inline_keyboard[0]
    ] },
    ...NO_PREVIEW
  });
}

// ---- inbound messages: group question OR anon send OR owner reply ----
async function handleMessage(bot, store, msg, cfg) {
  const cid = chatId(msg);
  if (msg.text && msg.text.startsWith('/')) return; // commands handled separately

  const gSession = store.getGroupSession(cid);
  if (gSession) return deliverGroupQuestion(bot, store, msg, gSession, cfg);

  const session = store.getSession(cid);
  if (session) return deliverFromSender(bot, store, msg, session, cfg);

  const rtm = msg.reply_to_message;
  if (rtm && rtm.message_id) {
    const tid = store.threadByLink(cid, rtm.message_id);
    if (tid) return deliverOwnerReply(bot, store, msg, tid);
  }
  // anything else is ignored silently
}

async function deliverFromSender(bot, store, msg, session, cfg) {
  const cid = chatId(msg);
  const target = store.getUser(session.target);

  if (!target || !target.receiving) {
    await editPanel(bot, session, "😶 They're not accepting anonymous messages right now.\nTap <b>Cancel</b> or try later.");
    return;
  }
  if (store.isBlocked(session.target, cid)) {
    await editPanel(bot, session, "🚫 You've been blocked from messaging this person.");
    return;
  }
  const cls = classifyMessage(msg);
  const abuse = checkAbuse(cls.kind === 'text' ? cls.text : cls.caption);
  if (!abuse.ok) {
    await editPanel(bot, session, '🚫 That message was blocked by the filter (' + abuse.reason + ').');
    return;
  }
  const rate = store.rateCheck(cid, session.target, cfg || {});
  if (!rate.ok) {
    await editPanel(bot, session, '🚧 ' + rate.reason + '\nTap <b>Cancel</b> to stop.');
    return;
  }

  const thread = store.getOrCreateThread(session.target, cid);
  const replyToOwner = thread.lastOwnerMsgId ? { message_id: thread.lastOwnerMsgId } : undefined;

  if (cls.kind === 'text') {
    const c = composeDelivered(cls.text, target);
    const sent = await bot.sendText(session.target, c.text, {
      entities: c.entities, protect_content: target.protect, reply_parameters: replyToOwner
    });
    // attach report/block buttons with the real message id
    try { await bot.editMarkup(session.target, sent.message_id, reportKeyboard(sent.message_id)); } catch (e) {}
    store.linkMessage(session.target, sent.message_id, thread.id);
    if (msg.message_id) store.linkMessage(cid, msg.message_id, thread.id);
    store.setThreadField(thread.id, 'lastSenderMsgId', sent.message_id);
    store.recordSent(cid); store.recordReceived(session.target);
    if (msg.message_id) await safe(bot.react(cid, msg.message_id, '✅'));
    await safe(bot.react(session.target, sent.message_id, pick(REACTIONS)));
    await editPanel(bot, session, '✅ <b>Sent anonymously!</b> Send another, or tap <b>Cancel</b>.');
  } else if (cls.kind === 'media') {
    const opts = {
      protect_content: target.protect, parse_mode: 'HTML', reply_parameters: replyToOwner,
      ...(target.spoiler && ['photo', 'video', 'animation'].includes(cls.type) ? { has_spoiler: true } : {})
    };
    const sent = await bot.sendMedia(session.target, cls.type, cls.fileId, composeCaption(cls), opts, cls.payload);
    try { await bot.editMarkup(session.target, sent.message_id, reportKeyboard(sent.message_id)); } catch (e) {}
    store.linkMessage(session.target, sent.message_id, thread.id);
    if (msg.message_id) store.linkMessage(cid, msg.message_id, thread.id);
    store.setThreadField(thread.id, 'lastSenderMsgId', sent.message_id);
    store.recordSent(cid); store.recordReceived(session.target);
    if (msg.message_id) await safe(bot.react(cid, msg.message_id, '✅'));
    await editPanel(bot, session, '✅ <b>Sent anonymously!</b> Send another, or tap <b>Cancel</b>.');
  } else {
    await editPanel(bot, session, "🤖 Sorry, I can't forward that type anonymously yet.\nTap <b>Cancel</b>.");
  }
}

async function deliverGroupQuestion(bot, store, msg, gSession, cfg) {
  const cid = chatId(msg);
  const groupId = gSession.groupId;
  const group = store.getGroup(groupId);
  if (!group || !group.active) {
    await editGroupPanel(bot, gSession, "🔒 This group's Q&A is off.");
    return;
  }
  const cls = classifyMessage(msg);
  const abuse = checkAbuse(cls.kind === 'text' ? cls.text : cls.caption);
  if (!abuse.ok) {
    await editGroupPanel(bot, gSession, '🚫 That message was blocked by the filter (' + abuse.reason + '). Tap <b>Cancel</b>.');
    return;
  }
  const rate = store.rateCheck(cid, 'g:' + groupId, cfg || {});
  if (!rate.ok) {
    await editGroupPanel(bot, gSession, '🚧 ' + rate.reason + '\nTap <b>Cancel</b> to stop.');
    return;
  }

  let sent;
  if (cls.kind === 'text') {
    sent = await bot.sendText(groupId, '🕵️ <b>Anonymous question</b>\n\n' + esc(cls.text), { parse_mode: 'HTML', ...NO_PREVIEW });
  } else if (cls.kind === 'media') {
    sent = await bot.sendMedia(groupId, cls.type, cls.fileId,
      '🕵️ <b>Anonymous question</b>' + (cls.caption ? '\n\n' + esc(cls.caption) : ''),
      { parse_mode: 'HTML', ...NO_PREVIEW }, cls.payload);
  } else {
    await editGroupPanel(bot, gSession, "🤖 Sorry, I can't forward that type to the group yet.");
    return;
  }

  store.recordGroupQuestion(groupId);
  if (msg.message_id) await safe(bot.react(cid, msg.message_id, '✅'));

  // Bot API 10.2 ephemeral: a private, auto-deleting confirmation to the asker.
  await safe(bot.sendText(groupId, '✅ Your anonymous question is live in the group.',
    { ephemeral_message_parameters: { receiver_user_id: Number(cid) } }));

  await editGroupPanel(bot, gSession, '✅ <b>Posted anonymously!</b> Ask another, or tap <b>Cancel</b>.');
}

async function deliverOwnerReply(bot, store, msg, threadId) {
  const cid = chatId(msg);
  const thread = store.getThread(threadId);
  if (!thread || !thread.active) { await bot.sendText(cid, '⚠️ That conversation is closed.'); return; }
  const sender = store.getUser(thread.sender);
  const cls = classifyMessage(msg);
  if (cls.kind !== 'text' && cls.kind !== 'media') {
    await bot.sendText(cid, '🤖 You can reply with text or media only.'); return;
  }
  const replyToSender = thread.lastSenderMsgId ? { message_id: thread.lastSenderMsgId } : undefined;
  const opts = { reply_parameters: replyToSender, protect_content: sender ? sender.protect : false };
  let sent;
  if (cls.kind === 'text') {
    const c = composeReply(cls.text);
    sent = await bot.sendText(thread.sender, c.text, { entities: c.entities, ...opts });
  } else {
    const o2 = {
      parse_mode: 'HTML', ...opts,
      ...(sender && sender.spoiler && ['photo', 'video', 'animation'].includes(cls.type) ? { has_spoiler: true } : {})
    };
    sent = await bot.sendMedia(thread.sender, cls.type, cls.fileId, composeReplyCaption(cls), o2, cls.payload);
  }
  store.linkMessage(thread.sender, sent.message_id, thread.id);
  if (msg.message_id) store.linkMessage(cid, msg.message_id, thread.id);
  store.setThreadField(thread.id, 'lastOwnerMsgId', sent.message_id);
  store.recordSent(cid); store.recordReceived(thread.sender);
  if (msg.message_id) await safe(bot.react(cid, msg.message_id, '💬'));
  await bot.sendText(cid, '💬 <b>Replied anonymously.</b> They\'ll get it as a notification.', { parse_mode: 'HTML' });
}

async function editPanel(bot, session, html) {
  try {
    await bot.editText(session.panelChatId, session.panelMsgId, html, { parse_mode: 'HTML', reply_markup: composeKeyboard() });
  } catch (e) { /* message too old to edit — ignore */ }
}
async function editGroupPanel(bot, gSession, html) {
  try {
    await bot.editText(gSession.panelChatId, gSession.panelMsgId, html, { parse_mode: 'HTML', reply_markup: composeKeyboard() });
  } catch (e) { /* ignore */ }
}

// ---- commands ----
async function handleMenu(bot, store, msg) {
  const u = store.getOrCreateUser(chatId(msg), { username: msg.from && msg.from.username, firstName: msg.from && msg.from.first_name });
  await bot.sendText(chatId(msg), menuHTML(u, bot.username), { parse_mode: 'HTML', reply_markup: menuKeyboard(u), ...NO_PREVIEW });
}
async function handleLink(bot, store, msg) {
  const u = store.getOrCreateUser(chatId(msg), { username: msg.from && msg.from.username, firstName: msg.from && msg.from.first_name });
  const link = linkFor(bot.username, u.token);
  await bot.sendText(chatId(msg), `🔗 <b>Your anonymous link</b>\n\n<code>${esc(link)}</code>\n\nShare it anywhere.`,
    { parse_mode: 'HTML', reply_markup: shareKeyboard(link), ...NO_PREVIEW });
}
async function handleStats(bot, store, msg) {
  const u = store.getOrCreateUser(chatId(msg), { username: msg.from && msg.from.username, firstName: msg.from && msg.from.first_name });
  await bot.sendText(chatId(msg), statsHTML(u), { parse_mode: 'HTML' });
}
async function handlePause(bot, store, msg) {
  store.getOrCreateUser(chatId(msg), {}); store.setReceiving(chatId(msg), false);
  await bot.sendText(chatId(msg), '🔒 <b>Paused.</b> No one can send you anonymous messages. /resume to reopen.', { parse_mode: 'HTML' });
}
async function handleResume(bot, store, msg) {
  store.getOrCreateUser(chatId(msg), {}); store.setReceiving(chatId(msg), true);
  await bot.sendText(chatId(msg), '🔓 <b>Resumed.</b> Anonymous messages are flowing again. /pause to close.', { parse_mode: 'HTML' });
}
async function handleCancel(bot, store, msg) {
  const cid = chatId(msg);
  const s = store.getSession(cid) || store.getGroupSession(cid);
  if (s) {
    store.clearSession(cid); store.clearGroupSession(cid);
    await editPanel(bot, s, "🚪 You've left anonymous mode. Open someone's link to message them.");
  } else {
    await bot.sendText(cid, "🚪 You're not in anonymous mode right now.");
  }
}
async function handleHelp(bot, store, msg) {
  await bot.sendText(chatId(msg), helpHTML(), { parse_mode: 'HTML', ...NO_PREVIEW });
}
async function handleWall(bot, store, msg, cfg) {
  const cid = chatId(msg);
  const cId = cfg && cfg.channelId;
  const u = store.getOrCreateUser(cid, { username: msg.from && msg.from.username, firstName: msg.from && msg.from.first_name });
  if (!cId) {
    await bot.sendText(cid, '🧱 The public wall isn\'t configured. Ask the bot admin to set <code>CHANNEL_ID</code>.', { parse_mode: 'HTML' });
    return;
  }
  const text = (msg.text || '').split(/\s+/).slice(1).join(' ').trim();
  if (!text && !hasMedia(msg)) {
    await bot.sendText(cid, '🧱 Send <code>/wall your anonymous confession</code> and it posts to the public channel (no names, ever).', { parse_mode: 'HTML' });
    return;
  }
  const link = linkFor(bot.username, u.token);
  const kb = { inline_keyboard: [[{ text: '💬 Send your own anonymous message', url: link }]] };
  if (text) {
    await bot.sendText(cId, '🧱 <b>Anonymous confession</b>\n\n' + esc(text) + `\n\n— via @${esc(bot.username)}`,
      { parse_mode: 'HTML', reply_markup: kb, ...NO_PREVIEW });
  } else {
    const cls = classifyMessage(msg);
    if (cls.kind === 'media') {
      await bot.sendMedia(cId, cls.type, cls.fileId, '🧱 <b>Anonymous</b> • via @' + esc(bot.username), { parse_mode: 'HTML', reply_markup: kb }, cls.payload);
    } else {
      await bot.sendText(cId, '🧱 <b>Anonymous</b> • via @' + esc(bot.username), { parse_mode: 'HTML', reply_markup: kb });
    }
  }
  await bot.sendText(cid, '🧱 Posted to the public wall <b>anonymously</b>! 🎉', { parse_mode: 'HTML' });
}
async function handleGroup(bot, store, msg) {
  const cid = chatId(msg);
  const type = msg.chat && msg.chat.type;
  if (type !== 'group' && type !== 'supergroup') {
    await bot.sendText(cid, '🕵️ The anonymous Q&A works inside a <b>group</b>. Add me to a group and run <code>/group</code> there.', { parse_mode: 'HTML' });
    return;
  }
  const arg = (msg.text || '').split(/\s+/)[1] || '';
  if (arg === 'off') { store.setGroupActive(cid, false); await bot.sendText(cid, '🔒 Anonymous Q&A turned <b>off</b> for this group.', { parse_mode: 'HTML' }); return; }
  if (arg === 'on') { store.setGroupActive(cid, true); await bot.sendText(cid, '🔓 Anonymous Q&A turned <b>on</b> for this group.', { parse_mode: 'HTML' }); return; }
  if (arg === 'stats') { const g = store.getGroup(cid); await bot.sendText(cid, `📊 This group has received <b>${g ? g.questions : 0}</b> anonymous questions.`, { parse_mode: 'HTML' }); return; }

  const token = store.getOrCreateGroup(cid);
  store.setGroupActive(cid, true);
  const link = `https://t.me/${bot.username}?start=g_${token}`;
  await bot.sendText(cid,
    `🕵️ <b>Anonymous Q&A is live!</b>\n\n` +
    `Tap the button to ask the group anything — your name stays hidden. Questions appear here with no author.\n\n` +
    `Admins: turn it off with <code>/group off</code>.`,
    { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🕵️ Ask anonymously', url: link }]] }, ...NO_PREVIEW });
}

// ---- callback queries (smooth in-place UI) ----
async function handleCallback(bot, store, cb, cfg) {
  const data = cb.data;
  const chatIdStr = cb.message ? String(cb.message.chat.id) : null;
  const fromId = cb.from ? String(cb.from.id) : null;
  if (!chatIdStr || !fromId) return;
  const u = store.getOrCreateUser(fromId, { username: cb.from.username, firstName: cb.from.first_name });

  if (data.startsWith('report:') || data.startsWith('block:')) {
    return handleReportBlock(bot, store, cb, cfg, data, fromId, chatIdStr);
  }
  if (data === 'idea') {
    try {
      await bot.editText(chatIdStr, cb.message.message_id,
        '💡 <b>Idea:</b> ' + esc(pick(IDEAS)) + '\n\nOr just say whatever. Tap <b>Cancel</b> when done.',
        { parse_mode: 'HTML', reply_markup: composeKeyboard() });
    } catch (e) {}
    await bot.answerCb(cb.id, { text: '💡 Idea' });
    return;
  }
  if (data === 'cancel') {
    const s = store.getSession(fromId) || store.getGroupSession(fromId);
    if (s) {
      store.clearSession(fromId); store.clearGroupSession(fromId);
      try { await bot.editText(chatIdStr, cb.message.message_id, "🚪 You've left anonymous mode."); } catch (e) {}
    } else {
      try { await bot.editText(chatIdStr, cb.message.message_id, '🚪 Nothing to cancel.'); } catch (e) {}
    }
    await bot.answerCb(cb.id, { text: '🚪' });
    return;
  }

  switch (data) {
    case 'pause': store.setReceiving(fromId, false); await renderMenu(bot, cb, u); await bot.answerCb(cb.id, { text: '🔒 Paused' }); break;
    case 'resume': store.setReceiving(fromId, true); await renderMenu(bot, cb, u); await bot.answerCb(cb.id, { text: '🔓 Resumed' }); break;
    case 'protect': { const v = store.toggle(u, 'protect'); await renderMenu(bot, cb, u); await bot.answerCb(cb.id, { text: `🛡 Protect ${v ? 'ON' : 'OFF'}` }); break; }
    case 'spoiler': { const v = store.toggle(u, 'spoiler'); await renderMenu(bot, cb, u); await bot.answerCb(cb.id, { text: `👁 Spoiler ${v ? 'ON' : 'OFF'}` }); break; }
    case 'link':
      await bot.sendText(fromId, `🔗 <b>Your anonymous link</b>\n\n<code>${esc(linkFor(bot.username, u.token))}</code>`,
        { parse_mode: 'HTML', reply_markup: shareKeyboard(linkFor(bot.username, u.token)), ...NO_PREVIEW });
      await bot.answerCb(cb.id, { text: '🔗 Link sent' });
      break;
    case 'stats':
      try { await bot.editText(chatIdStr, cb.message.message_id, statsHTML(u), { parse_mode: 'HTML', reply_markup: menuKeyboard(u), ...NO_PREVIEW }); } catch (e) {}
      await bot.answerCb(cb.id, { text: '📊' });
      break;
    case 'wall':
      await bot.answerCb(cb.id, { text: (cfg && cfg.channelId) ? '🧱 Use /wall <text>' : '🧱 Wall not configured' });
      break;
    case 'help':
      try { await bot.editText(chatIdStr, cb.message.message_id, helpHTML(), { parse_mode: 'HTML', reply_markup: menuKeyboard(u), ...NO_PREVIEW }); } catch (e) {}
      await bot.answerCb(cb.id, { text: '❓' });
      break;
    case 'menu':
    case 'refresh':
      await renderMenu(bot, cb, u);
      await bot.answerCb(cb.id, { text: '🔄' });
      break;
    default:
      await bot.answerCb(cb.id, { text: '?' });
  }
}

async function handleReportBlock(bot, store, cb, cfg, data, owner, chatIdStr) {
  const msgId = Number(data.split(':')[1]);
  const threadId = store.threadByLink(owner, msgId);
  if (!threadId) { await bot.answerCb(cb.id, { text: '⚠️ Already handled or expired' }); return; }
  const thread = store.getThread(threadId);
  if (data.startsWith('report:')) {
    store.addReport({ owner, sender: thread.sender, threadId, text: '(see message)' });
    store.block(owner, thread.sender);
    await safe(bot.react(owner, msgId, '🚩'));
    await safe(bot.editMarkup(owner, msgId, { inline_keyboard: [] }));
    if (cfg && cfg.adminId) {
      await safe(bot.sendText(cfg.adminId,
        `🚩 Report @${esc(bot.username)}\nOwner: ${owner}\nThread: ${threadId}\nSender: ${thread.sender}`,
        { parse_mode: 'HTML' }));
    }
    await bot.answerCb(cb.id, { text: '🚩 Reported & sender blocked' });
  } else {
    store.block(owner, thread.sender);
    await safe(bot.editMarkup(owner, msgId, { inline_keyboard: [] }));
    await bot.answerCb(cb.id, { text: '🚫 Sender blocked' });
  }
}

async function renderMenu(bot, cb, u) {
  try {
    await bot.editText(cb.message.chat.id, cb.message.message_id, menuHTML(u, bot.username),
      { parse_mode: 'HTML', reply_markup: menuKeyboard(u), ...NO_PREVIEW });
  } catch (e) {}
}

// ---- inline mode (share your link from any chat) ----
async function handleInline(bot, store, query) {
  const fromId = query.from ? String(query.from.id) : null;
  if (!fromId) return;
  const u = store.getOrCreateUser(fromId, { username: query.from.username, firstName: query.from.first_name });
  const link = linkFor(bot.username, u.token);
  const results = [{
    type: 'article', id: 'share',
    title: '📨 Share your anonymous link',
    description: 'Anyone who opens it can message you anonymously.',
    input_message_content: { message_text: `📨 Send me anonymous messages — I won't know who you are:\n${link}`, parse_mode: 'HTML' },
    reply_markup: { inline_keyboard: [[{ text: '💬 Open anonymous box', url: link }]] }
  }];
  await bot.answerInline(query.id, results);
}

module.exports = {
  handleStart, handleMessage, handleMenu, handleLink, handleStats, handlePause, handleResume,
  handleCancel, handleHelp, handleWall, handleGroup, handleCallback, handleInline,
  // exported for tests
  linkFor, composeDelivered, composeReply, menuHTML, welcomeHTML, statsHTML, helpHTML,
  menuKeyboard, shareKeyboard, composeKeyboard, reportKeyboard, esc
};
