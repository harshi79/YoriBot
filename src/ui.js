'use strict';
/*
 * All keyboards and all message copy live here, so the engine stays pure logic
 * and the wording can be changed without touching delivery code.
 *
 * Formatting is classic HTML (`parse_mode: 'HTML'`) rather than MarkdownV2:
 * it needs almost no escaping, survives in-place edits, and renders on every
 * client including Telegram Web. Rich Messages (Bot API 10.1) are used only
 * where src/rich.js decides it is safe.
 */

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

const NO_PREVIEW = { link_preview_options: { is_disabled: true } };
const HOUR = 3600 * 1000;

const linkFor = (username, token) => `https://t.me/${username}?start=${token}`;
const shareUrl = (link, text) =>
  `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(text || '')}`;

/** Compact "burns in 4m" style relative time. */
function relTime(ms) {
  if (ms <= 0) return 'now';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

const AUTO_DELETE_STEPS = [
  { ms: 0, label: 'OFF' },
  { ms: 30 * 1000, label: '30s' },
  { ms: 5 * 60 * 1000, label: '5m' },
  { ms: 60 * 60 * 1000, label: '1h' }
];
const autoDeleteLabel = (ms) => (AUTO_DELETE_STEPS.find((s) => s.ms === Number(ms)) || { label: 'OFF' }).label;
const nextAutoDelete = (ms) => {
  const i = AUTO_DELETE_STEPS.findIndex((s) => s.ms === Number(ms));
  return AUTO_DELETE_STEPS[(i + 1) % AUTO_DELETE_STEPS.length].ms;
};

// ------------------------------------------------------------------ keyboards

function shareKeyboard(link) {
  return {
    inline_keyboard: [[{
      text: '📤 Share my link',
      url: shareUrl(link, "Send me secret messages 🤫 — I won't know who you are")
    }]]
  };
}

function composeKeyboard() {
  return {
    inline_keyboard: [[
      { text: '💡 Idea', callback_data: 'idea' },
      { text: '🔗 My link', callback_data: 'link' },
      { text: '🚪 Cancel', callback_data: 'cancel' }
    ]]
  };
}

function reportKeyboard(deliveredMsgId) {
  return {
    inline_keyboard: [[
      { text: '↩️ Reply', callback_data: `reply:${deliveredMsgId}` },
      { text: '🔥 Burn', callback_data: `burn:${deliveredMsgId}` },
      { text: '🚩 Report', callback_data: `report:${deliveredMsgId}` },
      { text: '🚫 Block', callback_data: `block:${deliveredMsgId}` }
    ]]
  };
}

function menuKeyboard(u) {
  return {
    inline_keyboard: [
      [
        { text: u.receiving ? '🔓 Receiving: ON' : '🔒 Receiving: OFF', callback_data: u.receiving ? 'pause' : 'resume' },
        { text: '🔗 Link', callback_data: 'link' }
      ],
      [
        { text: `🛡 Protect: ${u.protect ? 'ON' : 'OFF'}`, callback_data: 'protect' },
        { text: `👁 Spoiler: ${u.spoiler ? 'ON' : 'OFF'}`, callback_data: 'spoiler' }
      ],
      [
        { text: `🔥 Auto-burn: ${autoDeleteLabel(u.autoDeleteMs)}`, callback_data: 'autodelete' },
        { text: `🔕 Silent: ${u.silent ? 'ON' : 'OFF'}`, callback_data: 'silent' }
      ],
      [
        { text: '📊 Stats', callback_data: 'stats' },
        { text: '🤫 Whispers', callback_data: 'whispers' }
      ],
      [
        { text: '🧱 Wall', callback_data: 'wall' },
        { text: '🚫 Blocked', callback_data: 'blocked' }
      ],
      [
        { text: '❓ Help', callback_data: 'help' },
        { text: '🔄 Refresh', callback_data: 'refresh' }
      ]
    ]
  };
}

/** Inline keyboard under a whisper. */
function whisperKeyboard(w, viewerIsSender) {
  const row = [{ text: '🔓 Open whisper', callback_data: `w_open:${w.id}` }];
  if (viewerIsSender && !w.oneTime) row.push({ text: '🗑 Delete', callback_data: `w_delete:${w.id}` });
  return { inline_keyboard: [row] };
}

/** Staged privately via /wi; share ONLY the text-only locked card via inline mode. */
function inlineMediaShareKeyboard(w) {
  return { inline_keyboard: [
    [{ text: '📤 Choose a chat for the locked card', style: 'primary', switch_inline_query: `share:${w.id}` }],
    [{ text: '🗑 Discard draft', style: 'danger', callback_data: `wi_discard:${w.id}` }]
  ] };
}

/** Buttons on an ephemeral (already-open) whisper — only the recipient sees them. */
function whisperOpenKeyboard(w, canReply) {
  const rows = [[{ text: '🔥 Burn it', callback_data: `w_burn:${w.id}` }]];
  if (canReply) rows.push([{ text: '↩️ Reply invisibly', callback_data: `w_reply:${w.id}` }]);
  return { inline_keyboard: rows };
}

function groupKeyboard(link) {
  return {
    inline_keyboard: [
      [{ text: '🕵️ Ask anonymously', url: link }],
      [{ text: '🤫 Whisper someone', callback_data: 'whisper_help' }]
    ]
  };
}

function adminKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '📈 Refresh', style: 'primary', callback_data: 'admin:refresh' }],
      [{ text: '🚩 Last reports', callback_data: 'admin:reports' }]
    ]
  };
}

// --------------------------------------------------------------- anon inbox

function welcomeHTML(user, link, botName = 'this bot', botUsername = null) {
  const name = esc(user.firstName || 'there');
  return `👋 <b>Hey ${name}!</b>\n\n` +
    `<b>${esc(botName)}</b> does two things, and both are free:\n\n` +
    `🤫 <b>Whispers</b> — send a message in any group that <b>only one person</b> can read.\n` +
    `🕵️ <b>Anonymous inbox</b> — share your link and people message you with no name attached, and you can reply back still anonymous.\n\n` +
    `🔗 <b>Your link:</b>\n<code>${esc(link)}</code>\n\n` +
    `In a group try: <code>/w @someone your secret</code>\n` +
    `Or type anywhere: <code>@${esc(botUsername || botName)} @someone your secret</code>\n` +
    `Add <code>0</code> at the end to hide your name on the inline card (Telegram still shows who posted it).`;
}

function menuHTML(u, botUsername, botName = 'YoriBot') {
  const link = linkFor(botUsername, u.token);
  return `🎛 <b>${esc(botName)} control panel</b>\n\n` +
    `▫️ Receiving: <b>${u.receiving ? 'ON 🔓' : 'OFF 🔒'}</b>\n` +
    `▫️ Protect content: <b>${u.protect ? 'ON 🛡' : 'OFF'}</b>\n` +
    `▫️ Spoiler reveal: <b>${u.spoiler ? 'ON 👁' : 'OFF'}</b>\n` +
    `▫️ Auto-burn: <b>${autoDeleteLabel(u.autoDeleteMs)}</b>\n` +
    `▫️ Silent delivery: <b>${u.silent ? 'ON 🔕' : 'OFF'}</b>\n` +
    `▫️ Received: <b>${u.received}</b> • Sent: <b>${u.sent}</b>\n` +
    `▫️ Whispers: <b>${u.whispersGot || 0}</b> in • <b>${u.whispersSent || 0}</b> out\n\n` +
    `🔗 <code>${esc(link)}</code>\n\nTap a button — the panel updates in place.`;
}

function statsHTML(u) {
  return `📊 <b>Your stats</b>\n\n` +
    `📥 Received: <b>${u.received}</b>\n` +
    `📤 Sent: <b>${u.sent}</b>\n` +
    `🤫 Whispers received: <b>${u.whispersGot || 0}</b>\n` +
    `🤫 Whispers sent: <b>${u.whispersSent || 0}</b>\n` +
    `🔘 Status: <b>${u.receiving ? 'Receiving 🔓' : 'Paused 🔒'}</b>\n` +
    `🛡 Protect: <b>${u.protect ? 'ON' : 'OFF'}</b> • 👁 Spoiler: <b>${u.spoiler ? 'ON' : 'OFF'}</b>\n` +
    `🔥 Auto-burn: <b>${autoDeleteLabel(u.autoDeleteMs)}</b> • 🔕 Silent: <b>${u.silent ? 'ON' : 'OFF'}</b>`;
}

function helpHTML(botUsername, botName = 'YoriBot') {
  const at = esc(botUsername || 'this bot');
  return `❓ <b>How ${esc(botName)} works</b>\n\n` +
    `<b>🤫 Whispers (group secrets)</b>\n` +
    `<code>/w @alice the password is 1234</code>\n` +
    `Alice sees it in the group; everyone else sees nothing at all — it's an <i>ephemeral message</i>, visible only to her and me.\n` +
    `If I don't have admin rights in that group, I post a locked card instead. Alice (and you by default) can open it.\n` +
    `Alice answers with <code>/r her reply</code> — also invisible to the group.\n\n` +
    `<b>Whisper flags</b>\n` +
    `<code>!1</code> burn after first read • <code>!5m</code>/<code>!1h</code> auto-expire • <code>!nosender</code> you can't re-open it • <code>!sign</code> attach your name\n` +
    `Multiple people: <code>/w @alice @bob 12345678 hey</code>\n\n` +
    `<b>🕵️ Anonymous inbox</b>\n` +
    `1️⃣ Share your link — anyone who opens it can message you <b>anonymously</b>.\n` +
    `2️⃣ You get it privately. <b>Reply</b> to the message to talk back, still anonymous.\n` +
    `3️⃣ Conversations are threaded, so it reads like a real chat.\n\n` +
    `<b>Commands</b>\n` +
    `<code>/w</code> whisper someone in a group\n` +
    `<code>/wi</code> prepare a private photo for a text-only inline card (DM only)\n` +
    `<code>/r</code> invisible reply to a whisper\n` +
    `<code>/id</code> your user id (private to you)\n` +
    `<code>/link</code> your anonymous link\n` +
    `<code>/menu</code> control panel\n` +
    `<code>/pause</code> · <code>/resume</code> stop/start receiving\n` +
    `<code>/stats</code> your numbers\n` +
    `<code>/whispers</code> your whisper history\n` +
    `<code>/group</code> anonymous Q&amp;A in a group\n` +
    `<code>/wall text</code> post to the public confession wall\n` +
    `<code>/cancel</code> leave anonymous mode\n` +
    `<code>/help</code> this message\n\n` +
    `<b>Anywhere in Telegram</b>: type <code>@${at} @alice secret</code> (or a numeric user id) and pick the card — no need to add me to the chat.\n` +
    `The card shows who sent it and who it's for. Add a standalone <code>0</code> at the end to hide the sender label: <code>@${at} @alice secret 0</code>.\n` +
    `Long inline text opens in a protected DM instead of being cut off. For images, DM me <code>/wi @alice 0</code>, send a photo/video/GIF/document, then share the locked text card. Only the recipient gets the file privately.\n` +
    `⚠️ Telegram still shows the account that posted an inline message; <code>0</code> cannot hide that. Use numeric IDs for stronger targeting. /w stays anonymous by default.\n\n` +
    `🛡 Protect stops forwarding • 👁 Spoiler hides until tapped • 🔥 Auto-burn deletes what you receive.\n` +
    `🚩 Report / 🚫 Block on anything you receive.`;
}

function composePanelHTML(targetName, extra = '') {
  return `🕵️ <b>You're anonymous</b> with ${esc(targetName)}.\n\n` +
    `Say anything — they won't know it's you. Text, photos, stickers, voice… all anonymous.\n` +
    (extra ? `\n${extra}\n` : '') +
    `\nTap <b>Cancel</b> when done, or <b>Idea</b> if you're stuck.`;
}

function groupPanelHTML() {
  return `🕵️ <b>Anonymous group question</b>\n\n` +
    `Your question appears in the group with <b>no name attached</b>. Photos, stickers, voice — all anonymous.\n` +
    `Tap <b>Cancel</b> when done.`;
}

function composeDelivered(body, target) {
  const header = '📨 Anonymous message';
  const sep = '\n\n';
  const full = header + sep + body;
  const entities = [{ type: 'bold', offset: 0, length: header.length }];
  if (target && target.spoiler) {
    entities.push({ type: 'spoiler', offset: header.length + sep.length, length: body.length });
  }
  return { text: full, entities };
}

function composeReply(body) {
  const header = '💬 Reply (still anonymous)';
  const sep = '\n\n';
  return { text: header + sep + body, entities: [{ type: 'bold', offset: 0, length: header.length }] };
}

const composeCaption = (cls) => '📨 <b>Anonymous message</b>' + (cls.caption ? '\n\n' + esc(cls.caption) : '');
const composeReplyCaption = (cls) => '💬 <b>Reply (still anonymous)</b>' + (cls.caption ? '\n\n' + esc(cls.caption) : '');

// ------------------------------------------------------------------ whispers

const WHISPER_ALERT_LIMIT = 190; // answerCallbackQuery alerts are cut off around 200 chars
const whisperAlertBody = (w) => `🤫 ${w.text || '(media whisper)'}\n\n${w.signed ? `— ${w.fromLabel}` : '— anonymous'}`;
const whisperAlertFits = (w) => whisperAlertBody(w).length <= WHISPER_ALERT_LIMIT;

/** The alert body shown when the right person opens a whisper. */
function whisperAlertText(w) {
  const from = w.signed ? `— ${w.fromLabel}` : '— anonymous';
  const body = `🤫 ${w.text || '(media whisper)'}`;
  const suffix = `\n\n${from}`;
  const out = body + suffix;
  if (out.length <= WHISPER_ALERT_LIMIT) return out;
  // Telegram rejects oversized callback alerts. Keep the byline visible even
  // for older long whispers, and never claim the full text is in the public card.
  const shortened = body.slice(0, WHISPER_ALERT_LIMIT - suffix.length - 1)
    .replace(/[\uD800-\uDBFF]$/, ''); // do not end in half an emoji
  return shortened + '…' + suffix;
}

/** The locked card everybody in the chat can see. */
function whisperCardHTML(w, opts = {}) {
  // The card never contains the secret. Inline cards label the sender unless
  // the 0 switch was used. For /w, !sign still only signs the private reveal;
  // don't change the visibility of existing group whispers.
  const heading = w.chatType === 'inline' && w.signed
    ? `🤫 <b>Whisper from ${esc(w.fromLabel)} to ${esc(w.targetLabel)}</b>`
    : `🤫 <b>Whisper for ${esc(w.targetLabel)}</b>`;
  const lines = [heading];
  lines.push('');
  lines.push(w.allowSenderReopen === false
    ? '🔒 Only intended recipients can open it. Everyone else sees the lock.'
    : '🔒 Intended recipients or the sender can open it. Everyone else sees the lock.');
  if (w.chatType === 'inline' && (w.inlinePrepared || !whisperAlertFits(w))) {
    lines.push(w.media ? '📷 The media opens privately in the bot.' : '📖 The full text opens privately in the bot.');
  }
  if (w.peeks > 0) lines.push(`👀 <b>${w.peeks}</b> ${w.peeks === 1 ? 'person has' : 'people have'} tried to peek`);
  if (w.openedBy.length > 0 && !w.oneTime) lines.push('✅ Opened');
  const left = w.expiresAt - (opts.now || Date.now());
  if (left > 0 && left < 2 * HOUR) lines.push(`⏳ Burns in ${relTime(left)}`);
  if (opts.burned) return `🔥 <b>This whisper burned.</b>\n\n${esc(opts.burned)}`;
  if (opts.expired) return `⌛ <b>This whisper expired.</b> Nobody will ever read it now.`;
  return lines.join('\n');
}

/** What the recipient sees — an ephemeral message inside the group. */
function whisperEphemeralHTML(w, opts = {}) {
  const who = w.signed ? esc(w.fromLabel) : 'someone anonymous';
  const where = w.chatTitle ? ` in <b>${esc(w.chatTitle)}</b>` : '';
  return `🤫 <b>A whisper for you</b>${where}\n\n` +
    `${esc(w.text || '')}\n\n` +
    `<i>from ${who}</i>` +
    (w.oneTime ? '\n<i>🔥 this burns once you close it</i>' : '') +
    (opts.hint === false ? '' : '\n\nReply with <code>/r your answer</code> — the group never sees it.');
}

/** A whisper delivered as a DM (no group, or ephemeral unavailable). */
function whisperDmHTML(w) {
  const who = w.signed ? esc(w.fromLabel) : 'someone anonymous';
  const where = w.chatTitle ? ` in <b>${esc(w.chatTitle)}</b>` : '';
  return `🤫 <b>You got a whisper</b>${where}\n\n` +
    `${esc(w.text || '')}\n\n` +
    `<i>from ${who}</i>`;
}

function inlineMediaComposeHTML(targetLabel) {
  return `🖼 <b>Prepare a private photo for ${esc(targetLabel)}</b>\n\n` +
    `Send me a photo, video, GIF, or document here in our private chat. Its caption is private too.\n` +
    `I'll give you a share button that posts a <b>text-only locked card</b> into any chat. ` +
    `The chosen recipient (and you unless !nosender was set) can open the file in the bot DM.\n\n` +
    `Tap Cancel to stop.`;
}

function inlineMediaReadyHTML(w) {
  return `🖼 <b>Private media ready for ${esc(w.targetLabel)}</b>\n\n` +
    `Pick a chat below and select the locked card. The photo/file is <b>never</b> attached to that card.\n` +
    (w.signed ? `The card shows from ${esc(w.fromLabel)} to ${esc(w.targetLabel)}.\n`
      : `No sender name on the card (Telegram still shows who posts inline messages).\n`) +
    `The recipient opens the media privately in this bot. You can discard the draft until then.`;
}

function whisperListHTML(list, meId) {
  if (!list || !list.length) {
    return '🤫 <b>No whispers yet.</b>\n\nIn a group try <code>/w @someone your secret</code>, or mention me anywhere: <code>@bot @someone secret</code>.';
  }
  const rows = list.map((w) => {
    const dir = w.fromId === String(meId) ? '→' : '←';
    const when = relTime(Date.now() - w.createdAt);
    const text = esc((w.text || '(media)').slice(0, 48));
    const state = w.status === 'active' ? (w.openedBy.length ? '✅' : '🔒') : (w.status === 'burned' ? '🔥' : '⌛');
    return `${dir} ${state} <code>${text}</code> · ${when} · 👀${w.peeks}`;
  });
  return `🤫 <b>Your whispers</b>\n\n${rows.join('\n')}`;
}

function groupLiveHTML() {
  return `🕵️ <b>Anonymous Q&amp;A is live!</b>\n\n` +
    `Tap a button to ask the group anything — your name stays hidden, and questions appear here with no author.\n\n` +
    `🤫 Prefer one person? <code>/w @them your secret</code> — only they can read it.\n` +
    `Admins: turn this off with <code>/group off</code>.`;
}

function adminRichMessage(stats) {
  const row = (key, value) => [{ text: key }, { text: String(value) }];
  return { blocks: [
    { type: 'heading', size: 3, text: '🛠 YoriBot · live dashboard' },
    { type: 'paragraph', text: 'Tap Refresh to update this message in place.' },
    { type: 'table', is_bordered: true, is_striped: true, is_compact: true, cells: [
      [{ text: 'Metric', is_header: true }, { text: 'Value', is_header: true }],
      row('👥 Users', stats.users),
      row('📨 Anonymous messages', stats.anonReceived || 0),
      row('🤫 Whispers', stats.whispers || 0),
      row('🔓 Opens', stats.whisperOpens || 0),
      row('👀 Peeks', stats.whisperPeeks || 0),
      row('🔥 Burns', stats.whisperBurns || 0),
      row('👥 Groups / questions', `${stats.groups} / ${stats.groupQuestions || 0}`),
      row('🚩 Reports', stats.reports || 0),
      row('⚙️ Transport / rich', `${stats.transport || '?'} / ${stats.rich || '?'}`),
      row('⏱ Uptime', stats.uptime || '?')
    ] }
  ] };
}

function adminHTML(stats) {
  return `🛠 <b>Bot admin</b>\n\n` +
    `👥 Users: <b>${stats.users}</b>\n` +
    `📨 Anonymous delivered: <b>${stats.anonReceived || 0}</b>\n` +
    `🤫 Whispers: <b>${stats.whispers || 0}</b> (${stats.whisperOpens || 0} opened, ${stats.whisperPeeks || 0} peeks, ${stats.whisperBurns || 0} burned)\n` +
    `👥 Groups with Q&amp;A: <b>${stats.groups}</b> (${stats.groupQuestions || 0} questions)\n` +
    `🚩 Reports: <b>${stats.reports || 0}</b>\n` +
    `⚙️ Transport: <b>${esc(stats.transport || '?')}</b> • Rich: <b>${esc(stats.rich || '?')}</b>\n` +
    `⏱ Uptime: <b>${esc(stats.uptime || '?')}</b>`;
}

module.exports = {
  esc, NO_PREVIEW, linkFor, shareUrl, relTime,
  AUTO_DELETE_STEPS, autoDeleteLabel, nextAutoDelete,
  shareKeyboard, composeKeyboard, reportKeyboard, menuKeyboard, whisperKeyboard,
  inlineMediaShareKeyboard, whisperOpenKeyboard, groupKeyboard, adminKeyboard,
  welcomeHTML, menuHTML, statsHTML, helpHTML, composePanelHTML, groupPanelHTML,
  composeDelivered, composeReply, composeCaption, composeReplyCaption,
  WHISPER_ALERT_LIMIT, whisperAlertFits, whisperAlertText, whisperCardHTML, whisperEphemeralHTML,
  whisperDmHTML, inlineMediaComposeHTML, inlineMediaReadyHTML, whisperListHTML, groupLiveHTML, adminHTML, adminRichMessage
};
