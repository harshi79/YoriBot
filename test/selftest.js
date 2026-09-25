'use strict';
/*
 * Self-test: runs the full engine against a mock Telegram adapter. No token,
 * no network. Validates two-way threading, reactions, editing, privacy, abuse
 * filter, report/block, group Q&A (with ephemeral), wall and inline flows.
 * Run with: npm run selftest
 */
const path = require('path');
const os = require('os');
const assert = require('assert');

process.env.WHISPER_DATA = path.join(os.tmpdir(), `whisper-test-${Date.now()}.json`);

const Store = require('../src/store');
const engine = require('../src/engine');

function mockBot(username) {
  const log = [];
  let mid = 1000;
  const bot = {
    username,
    async sendText(chatId, text, opts = {}) { const m = { message_id: ++mid }; log.push({ method: 'sendText', to: String(chatId), text, opts, message_id: m.message_id }); return m; },
    async sendMedia(chatId, type, fileId, caption, opts = {}) { const m = { message_id: ++mid }; log.push({ method: 'sendMedia', to: String(chatId), type, caption, opts, message_id: m.message_id }); return m; },
    async editText(chatId, messageId, text, opts = {}) { log.push({ method: 'editText', to: String(chatId), messageId, text }); return { ok: true }; },
    async editMarkup(chatId, messageId, replyMarkup) { log.push({ method: 'editMarkup', to: String(chatId), messageId, replyMarkup }); return { ok: true }; },
    async react(chatId, messageId, emoji) { log.push({ method: 'react', to: String(chatId), messageId, emoji }); return { ok: true }; },
    async answerCb() { return { ok: true }; },
    async answerInline() { log.push({ method: 'answerInline' }); return { ok: true }; }
  };
  bot._log = log;
  return bot;
}

const last = (log, pred) => log.filter(pred).pop();
const find = (log, pred) => log.find(pred);

(async () => {
  const bot = mockBot('WHoevenYori');
  const store = new Store();
  const cfg = { channelId: '@testchannel', adminId: '999', globalPerHour: 80, pairPerHour: 40, minIntervalMs: 0 };

  // 1) Alice /start -> welcome + link
  await engine.handleStart(bot, store, { chat: { id: 111 }, from: { first_name: 'Alice', username: 'alice' }, text: '/start' });
  const alice = store.getUser('111');
  assert(alice && alice.token, 'alice should have a token');
  const welcome = find(bot._log, (l) => l.to === '111' && l.method === 'sendText');
  assert(welcome && welcome.text.includes('WHoevenYori'), 'welcome mentions bot');
  assert(welcome.text.includes(`t.me/WHoevenYori?start=${alice.token}`), 'welcome contains deep link');

  // 2) Bob opens Alice's link -> compose panel + session + "opened box" notify
  await engine.handleStart(bot, store, { chat: { id: 222 }, from: { first_name: 'Bob' }, text: '/start ' + alice.token });
  const panel = find(bot._log, (l) => l.to === '222' && l.method === 'sendText' && l.text.includes('anonymous'));
  assert(panel, 'bob should get a compose panel');
  assert(store.getSession('222').target === '111', 'session target is alice');
  assert(find(bot._log, (l) => l.to === '111' && l.text && l.text.includes('opened your anonymous box')), 'alice notified');

  // 3) Bob sends anonymous text -> Alice receives, Bob reacts, panel updates, counts
  await engine.handleMessage(bot, store, { chat: { id: 222 }, message_id: 9, text: 'hi alice anonymous' }, cfg);
  const delivered = find(bot._log, (l) => l.to === '111' && l.method === 'sendText' && l.text && l.text.includes('hi alice anonymous'));
  assert(delivered, 'alice received the anonymous text');
  assert(delivered.text.startsWith('📨 Anonymous message'), 'delivered has correct header');
  assert(delivered.opts.entities && delivered.opts.entities.some((e) => e.type === 'bold'), 'delivered uses bold header entity');
  assert(find(bot._log, (l) => l.to === '222' && l.method === 'react' && l.emoji === '✅'), 'bob reacted ✅');
  assert(find(bot._log, (l) => l.to === '222' && l.method === 'editText' && l.text.includes('Sent anonymously')), 'panel updated to sent');
  assert(find(bot._log, (l) => l.method === 'editMarkup' && l.replyMarkup && JSON.stringify(l.replyMarkup).includes('report:' + delivered.message_id)), 'delivered has report/block buttons');
  assert(store.getUser('111').received === 1, 'alice received count = 1');
  assert(store.getUser('222').sent === 1, 'bob sent count = 1');

  // 3b) abuse filter blocks a banned phrase
  await engine.handleMessage(bot, store, { chat: { id: 222 }, message_id: 12, text: 'free money now click here' }, cfg);
  assert(find(bot._log, (l) => l.to === '222' && l.method === 'editText' && l.text.includes('blocked by the filter')), 'abuse blocked');
  assert(store.getUser('111').received === 1, 'no receive on abuse');

  // 3c) report callback blocks the sender
  await engine.handleCallback(bot, store, { id: 'r1', from: { id: '111', first_name: 'Alice' }, message: { chat: { id: 111 }, message_id: delivered.message_id }, data: 'report:' + delivered.message_id }, cfg);
  assert(store.isBlocked('111', '222') === true, 'sender blocked after report');
  assert(find(bot._log, (l) => l.method === 'editMarkup' && l.replyMarkup && JSON.stringify(l.replyMarkup) === '{"inline_keyboard":[]}'), 'report clears buttons');

  // 3d) blocked sender is now rejected
  await engine.handleMessage(bot, store, { chat: { id: 222 }, message_id: 13, text: 'hello again' }, cfg);
  assert(find(bot._log, (l) => l.to === '222' && l.method === 'editText' && l.text.includes('blocked from messaging')), 'blocked sender rejected');

  // 4) Alice replies to the delivered message -> Bob receives threaded reply
  await engine.handleMessage(bot, store, { chat: { id: 111 }, message_id: 10, reply_to_message: { message_id: delivered.message_id }, text: 'hello bob, this is anonymous reply' }, cfg);
  const reply = find(bot._log, (l) => l.to === '222' && l.method === 'sendText' && l.text && l.text.includes('anonymous reply'));
  assert(reply, 'bob received the owner reply');
  assert(reply.text.startsWith('💬 Reply'), 'reply has correct header');
  assert(reply.opts.reply_parameters && reply.opts.reply_parameters.message_id === delivered.message_id, 'reply threads to original');
  assert(find(bot._log, (l) => l.to === '111' && l.text && l.text.includes('Replied anonymously')), 'alice got reply confirmation');
  assert(store.getUser('222').received === 1, 'bob received count = 1');

  // 5) pause -> bob's next message is rejected
  await engine.handlePause(bot, store, { chat: { id: 111 }, from: {} });
  assert(store.getUser('111').receiving === false, 'alice paused');
  await engine.handleMessage(bot, store, { chat: { id: 222 }, message_id: 11, text: 'another' }, cfg);
  assert(find(bot._log, (l) => l.to === '222' && l.method === 'editText' && l.text.includes('not accepting')), 'rejected while paused');
  assert(store.getUser('111').received === 1, 'no new receive while paused');

  // 6) resume
  await engine.handleResume(bot, store, { chat: { id: 111 }, from: {} });
  assert(store.getUser('111').receiving === true, 'alice resumed');

  // 7) /link, /stats
  await engine.handleLink(bot, store, { chat: { id: 111 }, from: {} });
  assert(find(bot._log, (l) => l.to === '111' && l.text && l.text.includes('Your anonymous link')), 'link command works');
  await engine.handleStats(bot, store, { chat: { id: 111 }, from: {} });
  assert(find(bot._log, (l) => l.to === '111' && l.text && l.text.includes('stats')), 'stats command works');

  // 8) /cancel clears bob's session
  await engine.handleCancel(bot, store, { chat: { id: 222 }, from: {} });
  assert(store.getSession('222') === null, 'cancel clears session');

  // 9) /wall posts to channel
  await engine.handleWall(bot, store, { chat: { id: 333 }, from: { first_name: 'Carol' }, text: '/wall I secretly love bots' }, cfg);
  assert(find(bot._log, (l) => l.to === '@testchannel' && l.text && l.text.includes('secretly love bots')), 'wall posted to channel');

  // 10) inline query answered
  await engine.handleInline(bot, store, { id: 'q1', from: { id: 444, first_name: 'Dan' } });
  assert(find(bot._log, (l) => l.method === 'answerInline'), 'inline query answered');

  // 11) callback toggles protect
  await engine.handleCallback(bot, store, { id: 'c1', from: { id: '111', first_name: 'Alice' }, message: { chat: { id: 111 }, message_id: 5 }, data: 'protect' });
  assert(store.getUser('111').protect === true, 'protect toggled ON');

  // 12) spoiler toggle reflected in delivered entity
  await engine.handleCallback(bot, store, { id: 'c2', from: { id: '111', first_name: 'Alice' }, message: { chat: { id: 111 }, message_id: 6 }, data: 'spoiler' });
  assert(store.getUser('111').spoiler === true, 'spoiler toggled ON');
  await engine.handleStart(bot, store, { chat: { id: 555 }, from: { first_name: 'Eve' }, text: '/start ' + alice.token });
  await engine.handleMessage(bot, store, { chat: { id: 555 }, message_id: 20, text: 'spoiler test' }, cfg);
  const spoilered = find(bot._log, (l) => l.to === '111' && l.method === 'sendText' && l.text === '📨 Anonymous message\n\nspoiler test');
  assert(spoilered && spoilered.opts.entities.some((e) => e.type === 'spoiler'), 'spoiler entity applied when enabled');

  // 13) GROUP "ask me anything" + ephemeral confirmation
  await engine.handleGroup(bot, store, { chat: { id: -100, type: 'group' }, from: { first_name: 'Admin' }, text: '/group' });
  const groupMsg = find(bot._log, (l) => l.to === '-100' && l.method === 'sendText' && l.text.includes('Anonymous Q&A is live'));
  assert(groupMsg, 'group ask message posted');
  const glink = groupMsg.opts.reply_markup.inline_keyboard[0][0].url;
  const gtoken = glink.split('start=g_')[1];
  assert(gtoken, 'group token present in link');
  // member opens the group link -> group session
  await engine.handleStart(bot, store, { chat: { id: 777 }, from: { first_name: 'Member' }, text: '/start g_' + gtoken });
  assert(store.getGroupSession('777') && store.getGroupSession('777').groupId === '-100', 'group session set');
  // member asks a question
  await engine.handleMessage(bot, store, { chat: { id: 777 }, message_id: 30, text: 'what is the meaning of life?' }, cfg);
  const q = find(bot._log, (l) => l.to === '-100' && l.method === 'sendText' && l.text && l.text.includes('meaning of life'));
  assert(q, 'question posted to group');
  assert(q.text.startsWith('🕵️ <b>Anonymous question'), 'question header correct');
  assert(find(bot._log, (l) => l.to === '-100' && l.opts && l.opts.ephemeral_message_parameters && l.opts.ephemeral_message_parameters.receiver_user_id === 777), 'ephemeral confirmation sent');
  assert(store.getGroup('-100').questions === 1, 'group question counted');
  // group abuse filter
  await engine.handleMessage(bot, store, { chat: { id: 777 }, message_id: 31, text: 'casino free money' }, cfg);
  assert(find(bot._log, (l) => l.to === '777' && l.method === 'editText' && l.text.includes('blocked by the filter')), 'group abuse blocked');
  // /group off
  await engine.handleGroup(bot, store, { chat: { id: -100, type: 'group' }, from: {}, text: '/group off' });
  assert(store.getGroup('-100').active === false, 'group turned off');

  console.log('✅ ALL SELFTESTS PASSED');
  process.exit(0);
})().catch((e) => {
  console.error('❌ SELFTEST FAILED:', e && e.message ? e.message : e);
  process.exit(1);
});
