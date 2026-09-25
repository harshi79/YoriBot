'use strict';
/*
 * Self-test: the whole engine against a mock Telegram adapter — no token, no
 * network, no real API calls. Covers the anonymous inbox, whispers (ephemeral +
 * locked-card ladder), smooth editing, the abuse filter, the HTTP server that
 * keeps a PaaS deploy alive, and the process boot itself.
 *
 * Run with: npm test   (or: npm run selftest)
 */
const path = require('path');
const os = require('os');
const fs = require('fs');
const assert = require('assert');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
process.env.WHISPER_DATA = path.join(os.tmpdir(), `yoribot-test-${process.pid}.json`);

const Store = require('../src/store');
const engine = require('../src/engine');
const whisper = require('../src/whisper');
const ui = require('../src/ui');
const media = require('../src/media');
const reactions = require('../src/reactions');
const { RichGate } = require('../src/rich');
const { createAdapter } = require('../src/telegram');
const { createServer } = require('../src/server');

// ------------------------------------------------------------------ harness

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const tmpFile = () => path.join(os.tmpdir(), `yoribot-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
const mkStore = () => new Store(tmpFile());

const mkErr = (description, errorCode = 400) => {
  const e = new Error(description);
  e.description = description;
  e.errorCode = errorCode;
  return e;
};

function mockBot(opts = {}) {
  const log = [];
  const fail = opts.fail || {};
  let mid = 1000;
  let eid = 5000;
  let editCalls = 0;

  const push = (entry) => { log.push(entry); return entry; };
  const shouldFailEphemeral = (o) => fail.ephemeral && o && o.ephemeral_message_parameters;
  const shouldFailEdit = () => {
    editCalls++;
    if (fail.editAlways) return fail.editAlways;
    if (fail.editOnce && editCalls === 1) return fail.editOnce;
    return null;
  };

  const bot = {
    username: opts.username || 'YoriBot',
    name: opts.name || 'YoriBot',
    richGate: opts.richGate || null,

    async sendText(chatId, text, o = {}) {
      if (shouldFailEphemeral(o)) throw mkErr(fail.ephemeral);
      if (o.ephemeral_message_parameters) {
        return push({
          method: 'sendText', to: String(chatId), text, opts: o,
          message_id: 0, ephemeral_message_id: ++eid
        });
      }
      return push({ method: 'sendText', to: String(chatId), text, opts: o, message_id: ++mid });
    },

    async sendMedia(chatId, type, fileId, caption, o = {}, payload) {
      if (shouldFailEphemeral(o)) throw mkErr(fail.ephemeral);
      return push({
        method: 'sendMedia', to: String(chatId), type, fileId, caption, opts: o, payload,
        message_id: o.ephemeral_message_parameters ? 0 : ++mid,
        ephemeral_message_id: o.ephemeral_message_parameters ? ++eid : undefined
      });
    },

    async sendNative(chatId, type, params, caption, o = {}) {
      return push({ method: 'sendNative', to: String(chatId), type, params, caption, opts: o, message_id: ++mid });
    },

    async sendRich(chatId, content, o = {}) {
      if (fail.rich) throw mkErr(fail.rich);
      return push({ method: 'sendRich', to: String(chatId), html: content, opts: o, message_id: ++mid });
    },

    async editRich(chatId, messageId, content, o = {}) {
      if (fail.rich) throw mkErr(fail.rich);
      push({ method: 'editRich', to: String(chatId), messageId, content, opts: o });
      const f = shouldFailEdit();
      if (f) throw mkErr(f);
      return { ok: true };
    },

    async editText(chatId, messageId, text, o = {}) {
      push({ method: 'editText', to: String(chatId), messageId, text, opts: o });
      const f = shouldFailEdit();
      if (f) throw mkErr(f);
      return { ok: true };
    },

    async editMarkup(chatId, messageId, replyMarkup) {
      return push({ method: 'editMarkup', to: String(chatId), messageId, replyMarkup });
    },

    async editMedia(chatId, messageId, type, fileId, caption, o = {}) {
      return push({ method: 'editMedia', to: String(chatId), messageId, type, fileId, caption, opts: o });
    },

    async editInline(inlineMessageId, text, o = {}) {
      return push({ method: 'editInline', inlineMessageId, text, opts: o });
    },

    async editEphemeral(chatId, receiverUserId, ephemeralMessageId, text, o = {}) {
      return push({ method: 'editEphemeral', to: String(chatId), receiverUserId, ephemeralMessageId, text, opts: o });
    },

    async deleteMessage(chatId, messageId) {
      return push({ method: 'deleteMessage', to: String(chatId), messageId });
    },

    async deleteEphemeral(chatId, receiverUserId, ephemeralMessageId) {
      return push({ method: 'deleteEphemeral', to: String(chatId), receiverUserId, ephemeralMessageId });
    },

    async react(chatId, messageId, emoji) {
      return push({ method: 'react', to: String(chatId), messageId, emoji });
    },

    async typing(chatId, action) { return push({ method: 'typing', to: String(chatId), action }); },

    async answerCb(cbId, o = {}) { return push({ method: 'answerCb', cbId, opts: o }); },

    async answerInline(queryId, results, o = {}) {
      return push({ method: 'answerInline', queryId, results, opts: o });
    },

    async answerGuest(guestQueryId, result) {
      return push({ method: 'answerGuest', guestQueryId, result, inline_message_id: 'imsg-1' });
    }
  };

  bot._log = log;
  return bot;
}

const find = (log, pred) => log.find(pred);
const all = (log, pred) => log.filter(pred);
const CFG = {
  channelId: '@testchannel', adminId: '999', adminIds: ['999'],
  globalPerHour: 80, pairPerHour: 40, whisperPerHour: 40, minIntervalMs: 0,
  maxWhisperLength: 3500, maxWhisperTargets: 5, whisperTtlMs: 604800000
};

// ══════════════════════════════════════════════════════════════ anon inbox

test('anonymous inbox: /start gives a deep link, opening it starts a session', async () => {
  const bot = mockBot();
  const store = mkStore();
  await engine.handleStart(bot, store, { chat: { id: 111 }, from: { first_name: 'Alice', username: 'alice' }, text: '/start' });
  const alice = store.getUser('111');
  assert(alice && alice.token, 'alice has a token');
  const welcome = find(bot._log, (l) => l.to === '111' && l.method === 'sendText');
  assert(welcome.text.includes(`t.me/YoriBot?start=${alice.token}`), 'welcome contains the deep link');

  await engine.handleStart(bot, store, { chat: { id: 222 }, from: { first_name: 'Bob' }, text: '/start ' + alice.token });
  assert.strictEqual(store.getSession('222').target, '111', 'session points at alice');
  assert(find(bot._log, (l) => l.to === '111' && l.text && l.text.includes('opened your anonymous box')), 'alice is notified');
});

test('anonymous inbox: delivery is threaded, reacts with a VALID emoji, and attaches report/block', async () => {
  const bot = mockBot();
  const store = mkStore();
  await engine.handleStart(bot, store, { chat: { id: 111 }, from: { first_name: 'Alice' }, text: '/start' });
  await engine.handleStart(bot, store, { chat: { id: 222 }, from: { first_name: 'Bob' }, text: '/start ' + store.getUser('111').token });
  await engine.handleMessage(bot, store, { chat: { id: 222 }, message_id: 9, text: 'hi alice anonymous' }, CFG);

  const delivered = find(bot._log, (l) => l.to === '111' && l.method === 'sendText' && l.text && l.text.includes('hi alice anonymous'));
  assert(delivered, 'alice received it');
  assert(delivered.text.startsWith('📨 Anonymous message'), 'correct header');
  assert(delivered.opts.entities.some((e) => e.type === 'bold'), 'bold header entity');
  assert(find(bot._log, (l) => l.to === '222' && l.method === 'react' && l.emoji === reactions.SIGNAL.sent), 'sender gets a reaction');
  assert(find(bot._log, (l) => l.to === '222' && l.method === 'editText' && l.text.includes('Sent anonymously')), 'panel updated in place');
  assert(find(bot._log, (l) => l.method === 'editMarkup' && JSON.stringify(l.replyMarkup).includes('report:' + delivered.message_id)), 'report/block buttons');
  assert.strictEqual(store.getUser('111').received, 1);
  assert.strictEqual(store.getUser('222').sent, 1);

  // Every reaction the bot ever sends must be on Telegram's free whitelist.
  for (const r of all(bot._log, (l) => l.method === 'react')) {
    assert(reactions.FREE_SET.has(r.emoji), `reaction ${r.emoji} is not a valid free bot reaction`);
  }
});

test('anonymous inbox: owner reply goes back threaded and still anonymous', async () => {
  const bot = mockBot();
  const store = mkStore();
  await engine.handleStart(bot, store, { chat: { id: 111 }, from: { first_name: 'Alice' }, text: '/start' });
  await engine.handleStart(bot, store, { chat: { id: 222 }, from: { first_name: 'Bob' }, text: '/start ' + store.getUser('111').token });
  await engine.handleMessage(bot, store, { chat: { id: 222 }, message_id: 9, text: 'question?' }, CFG);
  const delivered = find(bot._log, (l) => l.to === '111' && l.text && l.text.includes('question?'));

  await engine.handleMessage(bot, store, {
    chat: { id: 111 }, message_id: 10, from: { id: 111 },
    reply_to_message: { message_id: delivered.message_id }, text: 'the answer'
  }, CFG);

  const reply = find(bot._log, (l) => l.to === '222' && l.method === 'sendText' && l.text && l.text.includes('the answer'));
  assert(reply, 'bob got the reply');
  assert(reply.text.startsWith('💬 Reply'), 'reply header');
  assert.strictEqual(reply.opts.reply_parameters.message_id, delivered.message_id, 'threaded to the original');
  assert(find(bot._log, (l) => l.to === '111' && l.text && l.text.includes('Replied anonymously')), 'alice gets a confirmation');
});

test('abuse filter blocks junk before it is delivered', async () => {
  const bot = mockBot();
  const store = mkStore();
  await engine.handleStart(bot, store, { chat: { id: 111 }, from: {}, text: '/start' });
  await engine.handleStart(bot, store, { chat: { id: 222 }, from: {}, text: '/start ' + store.getUser('111').token });
  await engine.handleMessage(bot, store, { chat: { id: 222 }, message_id: 12, text: 'free money now click here' }, CFG);
  assert(find(bot._log, (l) => l.to === '222' && l.method === 'editText' && l.text.includes('blocked by the filter')), 'blocked');
  assert.strictEqual(store.getUser('111').received, 0, 'nothing delivered');
});

test('report blocks the sender, clears the buttons and pings the admin', async () => {
  const bot = mockBot();
  const store = mkStore();
  await engine.handleStart(bot, store, { chat: { id: 111 }, from: {}, text: '/start' });
  await engine.handleStart(bot, store, { chat: { id: 222 }, from: {}, text: '/start ' + store.getUser('111').token });
  await engine.handleMessage(bot, store, { chat: { id: 222 }, message_id: 9, text: 'creepy' }, CFG);
  const delivered = find(bot._log, (l) => l.to === '111' && l.text && l.text.includes('creepy'));

  await engine.handleCallback(bot, store, {
    id: 'r1', from: { id: 111, first_name: 'Alice' }, date: 1,
    message: { chat: { id: 111 }, message_id: delivered.message_id, date: 1 },
    data: 'report:' + delivered.message_id
  }, CFG);

  assert(store.isBlocked('111', '222'), 'sender blocked');
  assert(find(bot._log, (l) => l.method === 'editMarkup' && JSON.stringify(l.replyMarkup) === '{"inline_keyboard":[]}'), 'buttons cleared');
  assert(find(bot._log, (l) => l.to === '999' && l.text && l.text.includes('Report')), 'admin notified');
  assert(store.getThread(store.threadByLink('111', delivered.message_id)).active === false, 'thread closed');

  await engine.handleMessage(bot, store, { chat: { id: 222 }, message_id: 13, text: 'hello again' }, CFG);
  assert(find(bot._log, (l) => l.to === '222' && l.method === 'editText' && l.text.includes('blocked from messaging')), 'blocked sender rejected');
});

test('pause stops deliveries, resume restarts them', async () => {
  const bot = mockBot();
  const store = mkStore();
  await engine.handleStart(bot, store, { chat: { id: 111 }, from: {}, text: '/start' });
  await engine.handleStart(bot, store, { chat: { id: 222 }, from: {}, text: '/start ' + store.getUser('111').token });
  await engine.handlePause(bot, store, { chat: { id: 111 }, from: {} });
  assert.strictEqual(store.getUser('111').receiving, false);
  await engine.handleMessage(bot, store, { chat: { id: 222 }, message_id: 11, text: 'anyone there' }, CFG);
  assert(find(bot._log, (l) => l.to === '222' && l.method === 'editText' && l.text.includes('not accepting')), 'rejected while paused');
  await engine.handleResume(bot, store, { chat: { id: 111 }, from: {} });
  assert.strictEqual(store.getUser('111').receiving, true);
});

test('settings toggles (protect, spoiler, auto-burn, silent) edit the same panel', async () => {
  const bot = mockBot();
  const store = mkStore();
  const cb = (data, id) => ({
    id: 'cb' + id, from: { id: 111, first_name: 'Alice' },
    message: { chat: { id: 111 }, message_id: 5, date: 1 }, data
  });
  await engine.handleCallback(bot, store, cb('protect', 1), CFG);
  assert.strictEqual(store.getUser('111').protect, true, 'protect on');
  await engine.handleCallback(bot, store, cb('spoiler', 2), CFG);
  assert.strictEqual(store.getUser('111').spoiler, true, 'spoiler on');
  await engine.handleCallback(bot, store, cb('autodelete', 3), CFG);
  assert.strictEqual(store.getUser('111').autoDeleteMs, ui.AUTO_DELETE_STEPS[1].ms, 'auto-burn steps forward');
  await engine.handleCallback(bot, store, cb('silent', 4), CFG);
  assert.strictEqual(store.getUser('111').silent, true, 'silent on');

  const edits = all(bot._log, (l) => l.method === 'editText' && l.messageId === 5);
  assert.strictEqual(edits.length, 4, 'all four toggles edited the SAME message in place');
  assert(find(bot._log, (l) => l.method === 'answerCb' && l.opts.text && l.opts.text.includes('Protect')), 'toast feedback');
});

test('spoiler setting is applied as a real entity on delivery', async () => {
  const bot = mockBot();
  const store = mkStore();
  await engine.handleStart(bot, store, { chat: { id: 111 }, from: {}, text: '/start' });
  store.setField('111', 'spoiler', true);
  await engine.handleStart(bot, store, { chat: { id: 555 }, from: {}, text: '/start ' + store.getUser('111').token });
  await engine.handleMessage(bot, store, { chat: { id: 555 }, message_id: 20, text: 'spoiler test' }, CFG);
  const msg = find(bot._log, (l) => l.to === '111' && l.method === 'sendText' && l.text === '📨 Anonymous message\n\nspoiler test');
  assert(msg.opts.entities.some((e) => e.type === 'spoiler'), 'spoiler entity present');
});

test('auto-burn schedules a delete and the sweeper performs it', async () => {
  const bot = mockBot();
  const store = mkStore();
  await engine.handleStart(bot, store, { chat: { id: 111 }, from: {}, text: '/start' });
  store.setField('111', 'autoDeleteMs', 1000);
  await engine.handleStart(bot, store, { chat: { id: 222 }, from: {}, text: '/start ' + store.getUser('111').token });
  await engine.handleMessage(bot, store, { chat: { id: 222 }, message_id: 9, text: 'burn me' }, CFG);
  assert(store.state.pendingDeletes.length === 1, 'delete scheduled');
  await new Promise((r) => setTimeout(r, 1100));
  const r = await whisper.sweep(bot, store);
  assert.strictEqual(r.deleted, 1, 'sweeper deleted it');
  assert(find(bot._log, (l) => l.method === 'deleteMessage' && l.to === '111'), 'deleteMessage called');
});

test('/wall posts to the channel and is filtered too', async () => {
  const bot = mockBot();
  const store = mkStore();
  await engine.handleWall(bot, store, { chat: { id: 333 }, from: { first_name: 'Carol' }, text: '/wall I secretly love bots' }, CFG);
  assert(find(bot._log, (l) => l.to === '@testchannel' && l.text && l.text.includes('secretly love bots')), 'posted');
  await engine.handleWall(bot, store, { chat: { id: 334 }, from: {}, text: '/wall crypto giveaway free money' }, CFG);
  assert(!find(bot._log, (l) => l.to === '@testchannel' && l.text && l.text.includes('crypto giveaway')), 'spam wall post blocked');
});

test('/link, /stats, /id answer privately and /id is ephemeral inside a group', async () => {
  const bot = mockBot();
  const store = mkStore();
  await engine.handleLink(bot, store, { chat: { id: 111, type: 'private' }, from: { id: 111 }, text: '/link' });
  assert(find(bot._log, (l) => l.to === '111' && l.text && l.text.includes('Your anonymous link')), 'link works');
  await engine.handleStats(bot, store, { chat: { id: 111, type: 'private' }, from: { id: 111 }, text: '/stats' });
  assert(find(bot._log, (l) => l.to === '111' && l.text && l.text.toLowerCase().includes('stats')), 'stats works');

  await engine.handleId(bot, store, { chat: { id: -100, type: 'supergroup' }, from: { id: 777 }, text: '/id' });
  const idMsg = find(bot._log, (l) => l.to === '-100' && l.method === 'sendText' && l.text.includes('Your user id'));
  assert(idMsg.opts.ephemeral_message_parameters, '/id in a group is an ephemeral message');
  assert.strictEqual(idMsg.opts.ephemeral_message_parameters.receiver_user_id, 777, 'only the caller sees it');
});

// ══════════════════════════════════════════════════════════════════ whispers

test('whisper parsing: targets, flags and the secret text', () => {
  const store = mkStore();
  const p = whisper.parseWhisperInput('!1 !5m @alice @bob 12345678 the party is at 9', store, {});
  assert.strictEqual(p.targets.length, 3, 'three targets');
  assert.deepStrictEqual(p.targets.map((t) => t.key), ['u:alice', 'u:bob', 'i:12345678']);
  assert.strictEqual(p.text, 'the party is at 9');
  assert.strictEqual(p.flags.oneTime, true);
  assert.strictEqual(p.flags.ttlMs, 300000);

  const p2 = whisper.parseWhisperInput('[John](tg://user?id=42) hi there', store, {});
  assert.strictEqual(p2.targets[0].key, 'i:42');
  assert.strictEqual(p2.text, 'hi there');

  const p3 = whisper.parseWhisperInput('@alice hello @bob how are you', store, {});
  assert.strictEqual(p3.targets.length, 1, 'only leading tokens are targets');
  assert.strictEqual(p3.text, 'hello @bob how are you');
});

test('inline parser: user id or username, trailing 0, literal zeros, and old /w flags', () => {
  const store = mkStore();
  const parse = (input) => whisper.parseInlineWhisperInput(input, store);
  const signed = parse('@alice the door code is 20');
  assert.strictEqual(signed.targets[0].key, 'u:alice');
  assert.strictEqual(signed.flags.signed, true, 'inline is signed by default');
  assert.strictEqual(signed.text, 'the door code is 20', 'a number containing 0 stays in the message');

  const anon = parse('123456789 the door code is 20 0  ');
  assert.strictEqual(anon.targets[0].userId, '123456789');
  assert.strictEqual(anon.flags.signed, false);
  assert.strictEqual(anon.text, 'the door code is 20', 'final standalone 0 is not part of the secret');
  assert.deepStrictEqual(parse('alice hi 0').targets.map((t) => t.label), ['@alice'], 'bare usernames work inline');
  assert.strictEqual(parse('alice hi 0').flags.signed, false);

  const escaped = parse('@alice the answer is \\0');
  assert.strictEqual(escaped.text, 'the answer is 0', 'escape a final literal zero');
  assert.strictEqual(escaped.flags.signed, true, 'a literal zero must not toggle privacy');
  assert.strictEqual(parse('@alice 0').text, '', 'a privacy flag alone does not send an empty whisper');
  assert.strictEqual(parse('!anon @alice hello').flags.signed, false, 'existing !anon still works inline');
  assert.strictEqual(parse('!sign @alice hello 0').flags.signed, false, 'trailing 0 wins over !sign');
  assert.strictEqual(parse('!1 @alice hi').flags.oneTime, true, 'other flags still work');

  const command = whisper.parseWhisperInput('@alice hi 0', store);
  assert.strictEqual(command.flags.signed, false, '/w keeps its anonymous default');
  assert.strictEqual(command.text, 'hi 0', 'trailing 0 remains literal in /w');
});

test('whisper in a group with a known target is delivered as an EPHEMERAL message', async () => {
  const bot = mockBot();
  const store = mkStore();
  // alice has used the bot, so @alice resolves to a numeric id
  store.getOrCreateUser('5001', { username: 'alice', firstName: 'Alice' });
  const group = { id: -100, type: 'supergroup', title: 'The Group' };

  await engine.handleWhisper(bot, store, {
    chat: group, from: { id: 777, first_name: 'Sam' }, message_id: 40,
    text: '/w @alice the meeting is cancelled'
  }, CFG);

  const e = find(bot._log, (l) => l.method === 'sendText' && l.opts.ephemeral_message_parameters);
  assert(e, 'ephemeral message sent');
  assert.strictEqual(e.to, '-100', 'into the group');
  assert.strictEqual(e.opts.ephemeral_message_parameters.receiver_user_id, 5001, 'only alice can see it');
  assert(e.text.includes('the meeting is cancelled'), 'the secret is in it');
  assert(!find(bot._log, (l) => l.method === 'sendText' && l.to === '-100' && !l.opts.ephemeral_message_parameters && l.text.includes('the meeting is cancelled')),
    'the secret is never posted publicly');
  const w = store.activeWhispers()[0];
  assert.strictEqual(w.delivery, 'ephemeral');
  assert.strictEqual(store.chatCap(-100, 'ephemeral'), true, 'capability latched on');
  assert(store.getWhisperContext(-100, '5001'), 'reply context set for alice');
});

test('whisper to an unknown username falls back to a LOCKED CARD only they can open', async () => {
  const bot = mockBot();
  const store = mkStore();
  const group = { id: -100, type: 'supergroup', title: 'The Group' };

  await engine.handleWhisper(bot, store, {
    chat: group, from: { id: 777, first_name: 'Sam', username: 'sam' }, message_id: 40,
    text: '/w !1 @stranger the secret word is banana'
  }, CFG);

  const card = find(bot._log, (l) => l.method === 'sendText' && l.to === '-100' && l.text.includes('Whisper for'));
  assert(card, 'locked card posted');
  assert(!card.text.includes('banana'), 'the secret is NOT in the public card');
  const cbData = card.opts.reply_markup.inline_keyboard[0][0].callback_data;
  assert(cbData.startsWith('w_open:'), 'reveal button present');
  const wid = cbData.slice('w_open:'.length);

  // a nosy stranger taps it
  await engine.handleCallback(bot, store, {
    id: 'c1', from: { id: 123, username: 'nosy' },
    message: { chat: group, message_id: card.message_id, date: 1 }, data: cbData
  }, CFG);
  const denied = find(bot._log, (l) => l.method === 'answerCb' && l.opts.show_alert && l.opts.text.includes("isn't for you"));
  assert(denied, 'the wrong person is refused');
  assert.strictEqual(store.getWhisper(wid).peeks, 1, 'peek counted');
  assert(find(bot._log, (l) => l.method === 'editText' && l.text.includes('tried to peek')), 'card edited in place with the peek count');

  // the real recipient taps it
  await engine.handleCallback(bot, store, {
    id: 'c2', from: { id: 999, username: 'stranger' },
    message: { chat: group, message_id: card.message_id, date: 1 }, data: cbData
  }, CFG);
  const revealed = all(bot._log, (l) => l.method === 'answerCb' && l.opts.show_alert).pop();
  assert(revealed.opts.text.includes('banana'), 'the recipient sees the secret');
  assert.strictEqual(store.getWhisper(wid).status, 'burned', '!1 burned it after one read');
  assert(find(bot._log, (l) => l.method === 'editText' && l.text.includes('burned')), 'the card says it burned');
});

test('/w !sign keeps the group card unlabeled but signs the private reveal', async () => {
  const bot = mockBot();
  const store = mkStore();
  await engine.handleWhisper(bot, store, {
    chat: { id: -100, type: 'supergroup' }, from: { id: 777, first_name: 'Sam' },
    message_id: 401, text: '/w !sign @stranger the secret word is apple'
  }, CFG);
  const card = find(bot._log, (l) => l.method === 'sendText' && l.text && l.text.includes('Whisper for @stranger'));
  assert(card && !card.text.includes('Sam'), 'pre-existing /w cards do not expose the sender');
  assert(!card.text.includes('apple'), 'never publish the secret');
  const id = card.opts.reply_markup.inline_keyboard[0][0].callback_data.slice('w_open:'.length);
  await engine.handleCallback(bot, store, { id: 'open-group', from: { id: 123, username: 'stranger' },
    message: { chat: { id: -100 }, message_id: card.message_id }, data: 'w_open:' + id
  }, CFG);
  const alert = find(bot._log, (l) => l.method === 'answerCb' && l.cbId === 'open-group');
  assert(alert.opts.text.includes('apple') && alert.opts.text.includes('Sam'), 'only the recipient sees the signature');
});

test('when ephemeral is not allowed, the bot latches it off and uses a card', async () => {
  const bot = mockBot({ fail: { ephemeral: 'Bad Request: CHAT_ADMIN_REQUIRED' } });
  const store = mkStore();
  store.getOrCreateUser('5001', { username: 'alice' });
  const group = { id: -100, type: 'supergroup' };

  await engine.handleWhisper(bot, store, {
    chat: group, from: { id: 777, first_name: 'Sam' }, message_id: 40, text: '/w @alice hello there'
  }, CFG);

  assert.strictEqual(store.chatCap(-100, 'ephemeral'), false, 'capability latched off');
  assert(find(bot._log, (l) => l.method === 'sendText' && l.to === '-100' && l.text.includes('Whisper for')), 'card posted instead');
  assert.strictEqual(store.activeWhispers()[0].delivery, 'card');

  // A second whisper must not try ephemeral again (no wasted round-trip).
  const before = bot._log.length;
  await engine.handleWhisper(bot, store, {
    chat: group, from: { id: 777, first_name: 'Sam' }, message_id: 41, text: '/w @alice second one'
  }, CFG);
  const second = bot._log.slice(before).filter((l) => l.method === 'sendText' && l.opts.ephemeral_message_parameters && l.to === '-100');
  assert.strictEqual(second.length, 0, 'ephemeral is not retried in a chat that cannot do it');
});

test('media whispers need ephemeral: they are refused rather than leaked', async () => {
  const bot = mockBot({ fail: { ephemeral: 'Bad Request: CHAT_ADMIN_REQUIRED' } });
  const store = mkStore();
  store.getOrCreateUser('5001', { username: 'alice' });
  const group = { id: -100, type: 'supergroup' };

  await engine.handleWhisper(bot, store, {
    chat: group, from: { id: 777 }, message_id: 42, text: '/w @alice look at this',
    photo: [{ file_id: 'small' }, { file_id: 'big' }]
  }, CFG);

  assert(!find(bot._log, (l) => l.method === 'sendMedia'), 'no media was posted publicly');
  assert(find(bot._log, (l) => l.text && l.text.includes('can only hide')), 'the sender is told why');
});

test('ephemeral media whispers go through sendMedia with receiver parameters', async () => {
  const bot = mockBot();
  const store = mkStore();
  store.getOrCreateUser('5001', { username: 'alice' });
  await engine.handleWhisper(bot, store, {
    chat: { id: -100, type: 'supergroup' }, from: { id: 777 }, message_id: 43,
    text: '/w @alice look', photo: [{ file_id: 'a' }, { file_id: 'b' }]
  }, CFG);
  const m = find(bot._log, (l) => l.method === 'sendMedia');
  assert(m, 'media whisper sent');
  assert.strictEqual(m.type, 'photo');
  assert.strictEqual(m.fileId, 'b', 'largest photo size is used');
  assert.strictEqual(m.opts.ephemeral_message_parameters.receiver_user_id, 5001);
});

test('a whisper from a private chat is delivered by DM', async () => {
  const bot = mockBot();
  const store = mkStore();
  store.getOrCreateUser('5001', { username: 'alice', firstName: 'Alice' });
  await engine.handleWhisper(bot, store, {
    chat: { id: 777, type: 'private' }, from: { id: 777, first_name: 'Sam' }, message_id: 44,
    text: '/w @alice psst'
  }, CFG);
  const dm = find(bot._log, (l) => l.method === 'sendText' && l.to === '5001' && l.text.includes('You got a whisper'));
  assert(dm, 'DM whisper delivered');
  assert(dm.text.includes('psst'), 'secret included');
  assert.strictEqual(store.activeWhispers()[0].delivery, 'dm');
});

test('/r replies invisibly to the whisper partner', async () => {
  const bot = mockBot();
  const store = mkStore();
  store.getOrCreateUser('5001', { username: 'alice' });
  const group = { id: -100, type: 'supergroup', title: 'G' };
  await engine.handleWhisper(bot, store, {
    chat: group, from: { id: 777, first_name: 'Sam' }, message_id: 45, text: '/w @alice are you there?'
  }, CFG);

  await engine.handleReply(bot, store, {
    chat: group, from: { id: 5001, first_name: 'Alice', username: 'alice' }, message_id: 46, text: '/r yes, who is this?'
  }, CFG);

  const replies = all(bot._log, (l) => l.method === 'sendText' && l.opts.ephemeral_message_parameters);
  const reply = replies.find((l) => l.text.includes('yes, who is this?'));
  assert(reply, 'the reply was sent ephemerally');
  assert.strictEqual(reply.opts.ephemeral_message_parameters.receiver_user_id, 777, 'back to the original sender');
  assert(!find(bot._log, (l) => l.method === 'sendText' && l.to === '-100' && !l.opts.ephemeral_message_parameters && l.text.includes('yes, who is this?')),
    'the group never sees the reply');
});

test('replying publicly to a locked card is intercepted with a warning', async () => {
  const bot = mockBot();
  const store = mkStore();
  const group = { id: -100, type: 'supergroup' };
  await engine.handleWhisper(bot, store, {
    chat: group, from: { id: 777 }, message_id: 47, text: '/w @stranger hello'
  }, CFG);
  const card = find(bot._log, (l) => l.text && l.text.includes('Whisper for'));
  const wid = card.opts.reply_markup.inline_keyboard[0][0].callback_data.slice('w_open:'.length);

  await engine.handleMessage(bot, store, {
    chat: group, from: { id: 777 }, message_id: 48,
    reply_to_message: { message_id: card.message_id }, text: 'wait come back'
  }, CFG);

  const warn = find(bot._log, (l) => l.text && l.text.includes('public'));
  assert(warn, 'warned about the public reply');
  assert(store.getWhisper(wid), 'whisper still intact');
});

test('guided whisper flow: /w -> target -> body', async () => {
  const bot = mockBot();
  const store = mkStore();
  store.getOrCreateUser('5001', { username: 'alice' });
  const group = { id: -100, type: 'supergroup' };

  await engine.handleWhisper(bot, store, { chat: group, from: { id: 777 }, message_id: 50, text: '/w' }, CFG);
  assert.strictEqual(store.getWhisperSession('777').kind, 'whisper_target', 'waiting for a target');

  await engine.handleMessage(bot, store, { chat: group, from: { id: 777 }, message_id: 51, text: '@alice' }, CFG);
  assert.strictEqual(store.getWhisperSession('777').kind, 'whisper_body', 'waiting for the body');

  await engine.handleMessage(bot, store, { chat: group, from: { id: 777 }, message_id: 52, text: 'meet me at 8' }, CFG);
  assert.strictEqual(store.getWhisperSession('777'), null, 'session cleared after sending');
  const e = all(bot._log, (l) => l.method === 'sendText' && l.opts.ephemeral_message_parameters)
    .find((l) => l.text.includes('meet me at 8'));
  assert(e, 'the guided whisper was delivered');
});

test('whisper expiry: the sweeper marks it expired and rewrites the card', async () => {
  const bot = mockBot();
  const store = mkStore();
  const group = { id: -100, type: 'supergroup' };
  await engine.handleWhisper(bot, store, {
    chat: group, from: { id: 777 }, message_id: 60, text: '/w !10s @stranger hurry'
  }, CFG);
  const w = store.activeWhispers()[0];
  store.updateWhisper(w.id, { expiresAt: Date.now() - 1 });
  const r = await whisper.sweep(bot, store);
  assert.strictEqual(r.expired, 1, 'one whisper expired');
  assert.strictEqual(store.getWhisper(w.id).status, 'expired');
  assert(find(bot._log, (l) => l.method === 'editText' && l.text.includes('expired')), 'card rewritten');
});

test('/whispers lists your history', async () => {
  const bot = mockBot();
  const store = mkStore();
  store.getOrCreateUser('5001', { username: 'alice' });
  await engine.handleWhisper(bot, store, {
    chat: { id: -100, type: 'supergroup' }, from: { id: 777 }, message_id: 61, text: '/w @alice first secret'
  }, CFG);
  await engine.handleWhispers(bot, store, { chat: { id: 777, type: 'private' }, from: { id: 777 }, text: '/whispers' });
  const list = find(bot._log, (l) => l.to === '777' && l.text && l.text.includes('Your whispers'));
  assert(list, 'history shown');
  assert(list.text.includes('first secret'), 'contains the whisper');
});

// ═══════════════════════════════════════════════════════ inline + guest mode

test('a /whispers history cannot leak captions to a group when ephemeral fails', async () => {
  const bot = mockBot({ fail: { ephemeral: 'Bad Request: CHAT_ADMIN_REQUIRED' } });
  const store = mkStore();
  store.getOrCreateUser('777', { username: 'sender' });
  store.createWhisper({ chatId: null, chatType: 'inline', fromId: '777', fromLabel: 'S',
    targets: [{ key: 'i:50001', label: 'recipient', userId: '50001' }],
    targetLabel: 'recipient', text: 'private caption' });
  const group = { chat: { id: -100, type: 'supergroup' }, from: { id: 777 }, text: '/whispers' };
  await engine.handleWhispers(bot, store, group);
  assert(find(bot._log, (l) => l.to === '777' && l.text && l.text.includes('private caption')),
    'private history falls back to DM');
  assert(!find(bot._log, (l) => l.to === '-100' && l.text && l.text.includes('private caption')),
    'no secret in the group even on capability failure');
  bot._log.length = 0;
  const oldSend = bot.sendText;
  bot.sendText = async (cid, ...args) => {
    if (String(cid) === '777') throw mkErr('Forbidden: bot was blocked by the user');
    return oldSend(cid, ...args);
  };
  await engine.handleWhispers(bot, store, group);
  assert(!find(bot._log, (l) => l.to === '-100' && l.text && l.text.includes('private caption')),
    'even when DM is blocked only a generic hint is public');
});

test('group panel callbacks never reveal history publicly; ephemeral panels edit in place', async () => {
  const bot = mockBot();
  const store = mkStore();
  store.createWhisper({ chatId: null, chatType: 'inline', fromId: '777', fromLabel: 'S',
    targets: [{ key: 'i:50001', label: 'recipient', userId: '50001' }],
    targetLabel: 'recipient', text: 'secret from history' });
  await engine.handleCallback(bot, store, { id: 'public-history', from: { id: 777 },
    message: { chat: { id: -100, type: 'supergroup' }, message_id: 123 }, data: 'whispers' }, CFG);
  assert(!find(bot._log, (l) => l.text && l.text.includes('secret from history')),
    'ordinary group button cannot edit a private history into a public message');
  assert(find(bot._log, (l) => l.method === 'answerCb' && l.opts.text.includes('DM')));
  bot._log.length = 0;
  await engine.handleCallback(bot, store, { id: 'ephemeral-history', from: { id: 777 },
    message: { chat: { id: -100, type: 'supergroup' }, message_id: 0,
      ephemeral_message_id: 999, receiver_user: { id: 777 } }, data: 'whispers' }, CFG);
  assert(find(bot._log, (l) => l.method === 'editEphemeral' && l.to === '-100' && l.receiverUserId === 777 &&
    l.ephemeralMessageId === 999 && l.text.includes('secret from history')),
  'original private group panel updated via editEphemeralMessageText');
  assert(!find(bot._log, (l) => l.method === 'sendText' && l.to === '-100'), 'no public fallback');
});

test('inline mode: no target -> share card; with target -> locked whisper card', async () => {
  const bot = mockBot();
  const store = mkStore();
  await engine.handleInline(bot, store, { id: 'q1', from: { id: 444, first_name: 'Dan' }, query: '' }, CFG);
  const share = find(bot._log, (l) => l.method === 'answerInline');
  assert.strictEqual(share.results[0].id, 'share', 'share card first');

  bot._log.length = 0;
  await engine.handleInline(bot, store, { id: 'q2', from: { id: 444, first_name: 'Dan', username: 'dan' }, query: '@alice the code is 4242' }, CFG);
  const wq = find(bot._log, (l) => l.method === 'answerInline');
  assert.strictEqual(wq.opts.is_personal, true, 'whisper results must be personal');
  assert.strictEqual(wq.opts.cache_time, 0, 'never cached');
  const article = wq.results[0];
  assert(article.title.includes('Whisper to'), 'title says whisper');
  assert(article.description.includes('4242'), 'description (private to the typer) previews it');
  assert(!article.input_message_content.message_text.includes('4242'), 'the SENT card must not contain the secret');
  assert(article.reply_markup.inline_keyboard[0][0].callback_data.startsWith('w_open:'), 'reveal button');
});

test('inline signed by default: card shows from/to, but only the recipient sees the secret', async () => {
  const bot = mockBot();
  const store = mkStore();
  const from = { id: 444, first_name: 'Dan', username: 'dan' };
  await engine.handleInline(bot, store, { id: 'signed', from, query: '@alice the secret is red' }, CFG);
  const answer = find(bot._log, (l) => l.method === 'answerInline');
  const article = answer.results[0];
  const card = article.input_message_content.message_text;
  assert.strictEqual(store.getWhisper(article.id).signed, true);
  assert(card.includes('Whisper from @dan to @alice'), 'sender and recipient are shown on the public card');
  assert(!card.includes('the secret is red'), 'the public card never contains the secret');
  assert(article.title.includes('from @dan'), 'sender previews the signed mode before posting');
  assert.strictEqual(answer.opts.is_personal, true);

  await engine.handleChosenInlineResult(bot, store, {
    result_id: article.id, inline_message_id: 'im-signed', from
  });
  await engine.handleCallback(bot, store, {
    id: 'open-signed', from: { id: 101, username: 'ALICE' },
    inline_message_id: 'im-signed', data: 'w_open:' + article.id
  }, CFG);
  const alert = find(bot._log, (l) => l.method === 'answerCb' && l.cbId === 'open-signed');
  assert(alert.opts.show_alert, 'recipient sees the secret in a private alert');
  assert(alert.opts.text.includes('the secret is red') && alert.opts.text.includes('@dan'), 'signed reveal names sender');
  const edit = find(bot._log, (l) => l.method === 'editInline' && l.inlineMessageId === 'im-signed');
  assert(edit && edit.text.includes('from @dan to @alice'), 'card keeps its label after being opened');
  assert(!edit.text.includes('the secret is red'), 'edited card still hides the message');
});

test('inline final 0 removes sender label and suffix, without hiding the Telegram post author', async () => {
  const bot = mockBot();
  const store = mkStore();
  const from = { id: 444, username: 'dan', first_name: 'Dan' };
  await engine.handleInline(bot, store, { id: 'public', from, query: '123456789 meet at nine' }, CFG);
  const signedId = find(bot._log, (l) => l.method === 'answerInline').results[0].id;
  bot._log.length = 0;

  await engine.handleInline(bot, store, { id: 'anon', from, query: '123456789 meet at nine 0' }, CFG);
  const answer = find(bot._log, (l) => l.method === 'answerInline');
  const article = answer.results[0];
  const w = store.getWhisper(article.id);
  const card = article.input_message_content.message_text;
  assert.notStrictEqual(article.id, signedId, 'signed and anonymous results do not share a stored whisper');
  assert.strictEqual(w.text, 'meet at nine', '0 is a switch, not part of the message');
  assert.strictEqual(w.signed, false);
  assert(card.includes('Whisper for user 123456789'), 'numeric user IDs work as targets');
  assert(!card.includes('@dan') && !card.includes('meet at nine'), 'no sender label or secret in the card');
  assert(article.title.includes('no sender label'), 'sender previews the privacy choice');
  assert(article.description.includes('Telegram shows who posts'), 'user is warned that inline is not truly anonymous');

  await engine.handleChosenInlineResult(bot, store, {
    result_id: article.id, inline_message_id: 'im-anon', from
  });
  await engine.handleCallback(bot, store, {
    id: 'peek-anon', from: { id: 123456788 },
    inline_message_id: 'im-anon', data: 'w_open:' + article.id
  }, CFG);
  const peek = find(bot._log, (l) => l.method === 'answerCb' && l.cbId === 'peek-anon');
  assert(peek.opts.text.includes("isn't for you") && !peek.opts.text.includes('meet at nine'));
  const edited = find(bot._log, (l) => l.method === 'editInline' && l.inlineMessageId === 'im-anon');
  assert(edited && !edited.text.includes('@dan') && !edited.text.includes('meet at nine'), 'peek edits keep the card private');

  await engine.handleCallback(bot, store, {
    id: 'open-anon', from: { id: 123456789 },
    inline_message_id: 'im-anon', data: 'w_open:' + article.id
  }, CFG);
  const alert = find(bot._log, (l) => l.method === 'answerCb' && l.cbId === 'open-anon');
  assert(alert.opts.text.includes('meet at nine') && alert.opts.text.includes('anonymous'), 'recipient sees the whole secret');
  assert(!alert.opts.text.includes('@dan') && !alert.opts.text.includes('nine 0'), 'no sender name or suffix in the reveal');
});

test('inline input errors do not create a whisper; signed labels are HTML-escaped', async () => {
  const bot = mockBot();
  const store = mkStore();
  const from = { id: 444, first_name: '<Dan & Sam>' };
  await engine.handleInline(bot, store, { id: 'empty', from, query: '@alice 0' }, CFG);
  assert.strictEqual(find(bot._log, (l) => l.method === 'answerInline').results[0].id, 'need-text');
  assert.strictEqual(store.activeWhispers().length, 0, 'privacy switch without message is not a whisper');
  bot._log.length = 0;

  await engine.handleInline(bot, store, { id: 'escaped', from, query: 'alice hi \\0' }, CFG);
  const article = find(bot._log, (l) => l.method === 'answerInline').results[0];
  assert.strictEqual(store.getWhisper(article.id).text, 'hi 0', 'literal zero is preserved');
  assert.strictEqual(store.getWhisper(article.id).signed, true, 'literal zero does not switch modes');
  assert(article.input_message_content.message_text.includes('&lt;Dan &amp; Sam&gt;'), 'signed name is safely escaped');
  assert(!article.input_message_content.message_text.includes('<Dan & Sam>'), 'HTML is not injected');
});

test('callback alerts are always within Telegram limits, even for older long cards', () => {
  const alert = ui.whisperAlertText({ text: '🔐'.repeat(300), signed: true, fromLabel: 'X' });
  assert(alert.length <= ui.WHISPER_ALERT_LIMIT, 'Telegram will accept the private popup');
  assert(alert.endsWith('— X'), 'signed sender survives truncation');
  assert(!alert.includes('open in the group'), 'the secret is not on the public card');
  assert.strictEqual(Buffer.from(alert).toString('utf8'), alert, 'truncation must not split an emoji');
});

test('long inline text opens privately in full via an authenticated deep link', async () => {
  const bot = mockBot();
  const store = mkStore();
  const from = { id: 444, first_name: 'Dan' };
  const limit = ui.WHISPER_ALERT_LIMIT - '🤫 \n\n— Dan'.length;
  await engine.handleInline(bot, store, { id: 'fits', from, query: '@alice ' + 'a'.repeat(limit) }, CFG);
  const fits = find(bot._log, (l) => l.method === 'answerInline').results[0];
  assert.strictEqual(ui.whisperAlertText(store.getWhisper(fits.id)).length, ui.WHISPER_ALERT_LIMIT);
  bot._log.length = 0;

  const secret = 'a'.repeat(limit + 1);
  await engine.handleInline(bot, store, { id: 'long', from, query: '@alice ' + secret }, CFG);
  const answer = find(bot._log, (l) => l.method === 'answerInline');
  const article = answer.results[0];
  assert(article.description.includes('privately'), 'not promised in a truncated popup');
  assert(!article.input_message_content.message_text.includes(secret), 'secret never in the card');
  assert(article.input_message_content.message_text.includes('opens privately'));
  await engine.handleChosenInlineResult(bot, store, { result_id: article.id, inline_message_id: 'im-long', from });
  bot._log.length = 0;

  await engine.handleCallback(bot, store, {
    id: 'wrong', from: { id: 600, username: 'mallory' }, inline_message_id: 'im-long', data: 'w_open:' + article.id
  }, CFG);
  assert(!find(bot._log, (l) => l.method === 'answerCb' && l.cbId === 'wrong').opts.url, 'wrong user gets no link');
  await engine.handleCallback(bot, store, {
    id: 'correct', from: { id: 5001, username: 'alice' }, inline_message_id: 'im-long', data: 'w_open:' + article.id
  }, CFG);
  const link = find(bot._log, (l) => l.method === 'answerCb' && l.cbId === 'correct');
  assert(link.opts.url.endsWith('start=wm_' + article.id), 'authorized user gets private deep link');
  assert.strictEqual(store.getWhisper(article.id).openedBy.length, 0, 'not marked read until delivered');
  bot._log.length = 0;

  await engine.handleStart(bot, store, { chat: { id: -100, type: 'supergroup' }, from: { id: 5001, username: 'alice' },
    text: '/start wm_' + article.id });
  assert(!find(bot._log, (l) => l.text && l.text.includes(secret)), 'pasting the link into a group never leaks the secret');
  await engine.handleStart(bot, store, { chat: { id: 600, type: 'private' }, from: { id: 600, username: 'mallory' },
    text: '/start wm_' + article.id });
  assert(!find(bot._log, (l) => l.to === '600' && l.text && l.text.includes(secret)), 'forwarding the link does not bypass recipient authorization');

  await engine.handleStart(bot, store, { chat: { id: 5001, type: 'private' }, from: { id: 5001, username: 'ALICE' },
    text: '/start wm_' + article.id });
  const delivered = find(bot._log, (l) => l.method === 'sendText' && l.to === '5001' && l.text.includes(secret));
  assert(delivered && delivered.opts.protect_content, 'full message delivered in a protected DM');
  assert.strictEqual(store.getWhisper(article.id).targets[0].userId, '5001', 'username is bound to actual recipient');
  bot._log.length = 0;
  await engine.handleStart(bot, store, { chat: { id: 5001, type: 'private' }, from: { id: 5001 },
    text: '/start wm_' + article.id });
  assert(find(bot._log, (l) => l.method === 'editText' && l.to === '5001'), 'reopen edits the DM instead of sending another copy');
  assert(!find(bot._log, (l) => l.method === 'sendText' && l.text.includes(secret)), 'no duplicate message');
  assert.strictEqual(whisper.canOpen(store.getWhisper(article.id), { id: 600, username: 'alice' }), false,
    'recycled username cannot take over an already-opened whisper');
});

test('inline rejects only when configured message limit is exceeded', async () => {
  const bot = mockBot();
  const store = mkStore();
  await engine.handleInline(bot, store, { id: 'oversize', from: { id: 444 }, query: '@alice too many letters' },
    { ...CFG, maxWhisperLength: 4 });
  const result = find(bot._log, (l) => l.method === 'answerInline').results[0];
  assert.strictEqual(result.id, 'too-long');
  assert(!result.input_message_content.message_text.includes('too many letters'));
  assert.strictEqual(store.activeWhispers().length, 0);
});

test('inline whisper cards can be edited after chosen_inline_result', async () => {
  const bot = mockBot();
  const store = mkStore();
  await engine.handleInline(bot, store, { id: 'q3', from: { id: 444, username: 'dan' }, query: '@alice hi from inline' }, CFG);
  const article = find(bot._log, (l) => l.method === 'answerInline').results[0];
  await engine.handleChosenInlineResult(bot, store, {
    result_id: article.id, inline_message_id: 'IM-attacker', from: { id: 999 }
  });
  assert(!store.getWhisper(article.id).inlineMessageId, 'a different sender cannot hijack the editable card');
  await engine.handleChosenInlineResult(bot, store, {
    result_id: article.id, inline_message_id: 'IM-1', from: { id: 444 }
  });
  assert.strictEqual(store.getWhisper(article.id).inlineMessageId, 'IM-1', 'inline handle stored');

  await engine.handleCallback(bot, store, {
    id: 'c9', from: { id: 1, username: 'mallory' }, inline_message_id: 'IM-1', data: 'w_open:' + article.id
  }, CFG);
  assert(find(bot._log, (l) => l.method === 'editInline'), 'the inline card was edited (peek counter)');
  assert(find(bot._log, (l) => l.method === 'answerCb' && l.opts.text.includes("isn't for you")), 'wrong person refused');
});

test('/wi stages a photo privately; inline sharing never embeds the file or caption', async () => {
  const bot = mockBot();
  const store = mkStore();
  const sender = { id: 444, username: 'dan', first_name: 'Dan' };
  await engine.handleInlineMedia(bot, store, { chat: { id: 444, type: 'private' }, from: sender,
    text: '/wi @alice 0' }, CFG);
  assert.strictEqual(store.getWhisperSession('444').kind, 'inline_media');
  await engine.handleMessage(bot, store, { chat: { id: 444, type: 'private' }, from: sender,
    photo: [{ file_id: 'photo-secret-file' }], caption: 'This photo is private' }, CFG);
  const w = store.activeWhispers()[0];
  assert(w && w.inlinePrepared && w.media.fileId === 'photo-secret-file');
  assert.strictEqual(w.signed, false, 'trailing 0 selects no sender label');
  assert.strictEqual(store.getWhisperSession('444'), null, 'compose flow completed');
  const ready = find(bot._log, (l) => l.method === 'editText' && l.text.includes('Private media ready'));
  assert(ready, 'share panel updated in place');
  assert.strictEqual(ready.opts.reply_markup.inline_keyboard[0][0].switch_inline_query, 'share:' + w.id);
  assert(!find(bot._log, (l) => l.method === 'sendMedia'), 'the media is not sent to any group');
  bot._log.length = 0;

  await engine.handleInline(bot, store, { id: 'stolen', from: { id: 999 }, query: 'share:' + w.id }, CFG);
  assert.deepStrictEqual(find(bot._log, (l) => l.method === 'answerInline').results, [], 'someone else cannot share the draft');
  bot._log.length = 0;
  await engine.handleInline(bot, store, { id: 'share', from: sender, query: 'share:' + w.id }, CFG);
  const answer = find(bot._log, (l) => l.method === 'answerInline');
  const article = answer.results[0];
  assert.strictEqual(answer.opts.is_personal, true);
  assert.strictEqual(article.type, 'article', 'not an inline photo result (which would publish the file)');
  assert(!JSON.stringify(article).includes('photo-secret-file') && !JSON.stringify(article).includes('This photo is private'),
    'neither file id nor private caption appears anywhere in public result');
  assert(!article.input_message_content.message_text.includes('@dan'), 'anonymous card omits name');
  assert(article.input_message_content.message_text.includes('privately in the bot'));

  await engine.handleChosenInlineResult(bot, store, { result_id: w.id, inline_message_id: 'im-photo', from: sender });
  bot._log.length = 0;
  await engine.handleCallback(bot, store, { id: 'wrong-photo', from: { id: 999, username: 'mallory' },
    inline_message_id: 'im-photo', data: 'w_open:' + w.id }, CFG);
  assert(!find(bot._log, (l) => l.method === 'answerCb' && l.cbId === 'wrong-photo').opts.url);
  await engine.handleCallback(bot, store, { id: 'right-photo', from: { id: 5001, username: 'alice' },
    inline_message_id: 'im-photo', data: 'w_open:' + w.id }, CFG);
  assert(find(bot._log, (l) => l.method === 'answerCb' && l.cbId === 'right-photo').opts.url.endsWith('wm_' + w.id));
  bot._log.length = 0;

  await engine.handleStart(bot, store, { chat: { id: 999, type: 'private' }, from: { id: 999, username: 'mallory' },
    text: '/start wm_' + w.id });
  assert(!find(bot._log, (l) => l.method === 'sendMedia'), 'a forwarded link reveals no media');
  await engine.handleStart(bot, store, { chat: { id: 5001, type: 'private' }, from: { id: 5001, username: 'alice' },
    text: '/start wm_' + w.id });
  const photo = find(bot._log, (l) => l.method === 'sendMedia' && l.to === '5001');
  assert(photo && photo.fileId === 'photo-secret-file', 'only the recipient gets the photo');
  assert(photo.opts.protect_content && photo.opts.has_spoiler, 'protected + spoiler, both free features');
  assert(photo.caption.includes('This photo is private'));
  assert.strictEqual(store.getWhisper(w.id).targets[0].userId, '5001');
  assert(!find(bot._log, (l) => l.method === 'sendMedia' && l.to !== '5001'));
  bot._log.length = 0;
  await engine.handleStart(bot, store, { chat: { id: 5001, type: 'private' }, from: { id: 5001 },
    text: '/start wm_' + w.id });
  assert(find(bot._log, (l) => l.method === 'editMedia' && l.fileId === 'photo-secret-file'), 'reopen edits media in place');
  assert(!find(bot._log, (l) => l.method === 'sendMedia'), 'no duplicate photo');
});

test('one-time inline media burns after private delivery, not before the photo is seen', async () => {
  const bot = mockBot();
  const store = mkStore();
  const sender = { id: 444, username: 'dan' };
  await engine.handleInlineMedia(bot, store, { chat: { id: 444, type: 'private' }, from: sender,
    text: '/wi !1 50001 0' }, CFG);
  await engine.handleMessage(bot, store, { chat: { id: 444, type: 'private' }, from: sender,
    photo: [{ file_id: 'one-time-photo' }] }, CFG);
  const w = store.activeWhispers()[0];
  await engine.handleStart(bot, store, { chat: { id: 50001, type: 'private' }, from: { id: 50001 },
    text: '/start wm_' + w.id });
  assert(find(bot._log, (l) => l.method === 'sendMedia' && l.fileId === 'one-time-photo'), 'delivered before burn');
  assert.strictEqual(store.getWhisper(w.id).status, 'burned');
  assert(!find(bot._log, (l) => l.method === 'deleteMessage' && l.to === '50001'), 'not deleted immediately');
  assert.strictEqual(store.state.pendingDeletes.length, 1, 'DM deletion is scheduled');
  await whisper.sweep(bot, store, Date.now() + 31000);
  assert(find(bot._log, (l) => l.method === 'deleteMessage' && l.to === '50001'), 'temporary photo cleaned up');
  const n = all(bot._log, (l) => l.method === 'sendMedia').length;
  await engine.handleStart(bot, store, { chat: { id: 50001, type: 'private' }, from: { id: 50001 },
    text: '/start wm_' + w.id });
  assert.strictEqual(all(bot._log, (l) => l.method === 'sendMedia').length, n, 'cannot replay a burned photo');
});

test('private inline media expiration is enforced again at /start', async () => {
  const bot = mockBot();
  const store = mkStore();
  await engine.handleInlineMedia(bot, store, { chat: { id: 444, type: 'private' },
    from: { id: 444 }, text: '/wi 50001' }, CFG);
  await engine.handleMessage(bot, store, { chat: { id: 444, type: 'private' }, from: { id: 444 },
    photo: [{ file_id: 'expired-file' }] }, CFG);
  const w = store.activeWhispers()[0];
  store.updateWhisper(w.id, { expiresAt: Date.now() - 1 });
  bot._log.length = 0;
  await engine.handleStart(bot, store, { chat: { id: 50001, type: 'private' }, from: { id: 50001 },
    text: '/start wm_' + w.id });
  assert.strictEqual(store.getWhisper(w.id).status, 'expired');
  assert(!find(bot._log, (l) => l.method === 'sendMedia'), 'even an authorized old link cannot fetch an expired file');
});

test('simultaneous one-time private opens deliver at most one copy', async () => {
  const bot = mockBot();
  const store = mkStore();
  await engine.handleInlineMedia(bot, store, { chat: { id: 444, type: 'private' },
    from: { id: 444 }, text: '/wi !1 50001' }, CFG);
  await engine.handleMessage(bot, store, { chat: { id: 444, type: 'private' }, from: { id: 444 },
    photo: [{ file_id: 'race-file' }] }, CFG);
  const w = store.activeWhispers()[0];
  const realSend = bot.sendMedia;
  bot.sendMedia = async (...args) => { await new Promise((resolve) => setTimeout(resolve, 25)); return realSend(...args); };
  const open = () => engine.handleStart(bot, store, { chat: { id: 50001, type: 'private' }, from: { id: 50001 },
    text: '/start wm_' + w.id });
  await Promise.all([open(), open()]);
  assert.strictEqual(all(bot._log, (l) => l.method === 'sendMedia' && l.fileId === 'race-file').length, 1);
  assert.strictEqual(store.getWhisper(w.id).status, 'burned');
});

test('/wi rejects group composition and unsupported media; drafts can be discarded', async () => {
  const bot = mockBot();
  const store = mkStore();
  await engine.handleInlineMedia(bot, store, { chat: { id: -100, type: 'supergroup' },
    from: { id: 444 }, text: '/wi @alice' }, CFG);
  assert.strictEqual(store.getWhisperSession('444'), null, 'never collect media in a group');
  await engine.handleInlineMedia(bot, store, { chat: { id: 444, type: 'private' },
    from: { id: 444 }, text: '/wi @alice' }, CFG);
  await engine.handleMessage(bot, store, { chat: { id: 444, type: 'private' }, from: { id: 444 },
    voice: { file_id: 'voice-no' } }, CFG);
  assert(store.getWhisperSession('444'), 'unsupported media keeps the flow open');
  assert.strictEqual(store.activeWhispers().length, 0);
  await engine.handleMessage(bot, store, { chat: { id: 444, type: 'private' }, from: { id: 444 },
    document: { file_id: 'secret-doc' } }, CFG);
  const w = store.activeWhispers()[0];
  assert.strictEqual(w.media.type, 'document', 'documents also stage safely in private');
  const panel = find(bot._log, (l) => l.method === 'editText' && l.text.includes('Private media ready'));
  await engine.handleCallback(bot, store, { id: 'discard', from: { id: 444 },
    message: { chat: { id: 444 }, message_id: panel.messageId }, data: 'wi_discard:' + w.id }, CFG);
  assert.strictEqual(store.getWhisper(w.id).status, 'burned');
  bot._log.length = 0;
  await engine.handleInline(bot, store, { id: 'gone', from: { id: 444 }, query: 'share:' + w.id }, CFG);
  assert.deepStrictEqual(find(bot._log, (l) => l.method === 'answerInline').results, [], 'discarded drafts cannot be shared');
});

test('guest mode answers a whisper with a locked card', async () => {
  const bot = mockBot();
  const store = mkStore();
  await engine.handleGuest(bot, store, {
    guest_query_id: 'gq1',
    guest_bot_caller_user: { id: 888, first_name: 'Guest' },
    guest_bot_caller_chat: { id: -55, type: 'supergroup', title: 'Far away' },
    chat: { id: -55, type: 'supergroup' },
    text: '@alice secret from a chat you are not in'
  }, CFG);
  const g = find(bot._log, (l) => l.method === 'answerGuest');
  assert(g, 'answered via answerGuestQuery');
  assert(g.result.input_message_content.message_text.includes('Whisper for'), 'locked card');
  assert(!g.result.input_message_content.message_text.includes('secret from a chat'), 'secret not in the card');
});

// ═════════════════════════════════════════════════════════════ group Q&A AMA

test('group Q&A posts anonymously and acks the asker with an ephemeral message', async () => {
  const bot = mockBot();
  const store = mkStore();
  await engine.handleGroup(bot, store, { chat: { id: -100, type: 'group' }, from: { first_name: 'Admin' }, text: '/group' });
  const live = find(bot._log, (l) => l.to === '-100' && l.text && l.text.includes('Anonymous Q&amp;A is live'));
  assert(live, 'group announcement posted');
  const glink = live.opts.reply_markup.inline_keyboard[0][0].url;
  const gtoken = glink.split('start=g_')[1];
  assert(gtoken, 'group token in the link');

  await engine.handleStart(bot, store, { chat: { id: 777 }, from: { first_name: 'Member' }, text: '/start g_' + gtoken });
  assert.strictEqual(store.getGroupSession('777').groupId, '-100', 'group session set');

  await engine.handleMessage(bot, store, { chat: { id: 777 }, message_id: 30, text: 'what is the meaning of life?' }, CFG);
  const q = find(bot._log, (l) => l.to === '-100' && l.text && l.text.includes('meaning of life'));
  assert(q, 'question posted to the group');
  assert(q.text.startsWith('🕵️ <b>Anonymous question'), 'anonymous header');
  assert(!q.text.includes('Member'), 'the asker is never named');
  const ack = find(bot._log, (l) => l.to === '-100' && l.opts && l.opts.ephemeral_message_parameters &&
    l.opts.ephemeral_message_parameters.receiver_user_id === 777);
  assert(ack, 'ephemeral confirmation to the asker only');
  assert.strictEqual(store.getGroup('-100').questions, 1, 'counted');

  await engine.handleGroup(bot, store, { chat: { id: -100, type: 'group' }, from: {}, text: '/group off' });
  assert.strictEqual(store.getGroup('-100').active, false, 'turned off');
});

test('group Q&A falls back to a DM ack when ephemeral is unavailable', async () => {
  const bot = mockBot({ fail: { ephemeral: 'Bad Request: CHAT_ADMIN_REQUIRED' } });
  const store = mkStore();
  const token = store.getOrCreateGroup('-100');
  await engine.handleStart(bot, store, { chat: { id: 777 }, from: {}, text: '/start g_' + token });
  await engine.handleMessage(bot, store, { chat: { id: 777 }, message_id: 31, text: 'a question' }, CFG);
  assert.strictEqual(store.chatCap('-100', 'ephemeral'), false, 'latched off');
  assert(find(bot._log, (l) => l.to === '777' && l.text === '✅ Your anonymous question is live in the group.'), 'DM ack instead');
  assert(!find(bot._log, (l) => l.to === '-100' && l.text && l.text.includes('a question') && !l.text.includes('Anonymous question')),
    'the asker is never named in the group');
});

// ═════════════════════════════════════════════════════════ smooth-edit plumbing

test('a panel that can no longer be edited is re-created and the session re-pointed', async () => {
  const bot = mockBot({ fail: { editOnce: "Bad Request: message can't be edited" } });
  const store = mkStore();
  await engine.handleStart(bot, store, { chat: { id: 111 }, from: {}, text: '/start' });
  await engine.handleStart(bot, store, { chat: { id: 222 }, from: {}, text: '/start ' + store.getUser('111').token });
  const sessionBefore = store.getSession('222');

  await engine.handleMessage(bot, store, { chat: { id: 222 }, message_id: 70, text: 'does this still work?' }, CFG);

  const sessionAfter = store.getSession('222');
  assert.notStrictEqual(sessionAfter.panelMsgId, sessionBefore.panelMsgId, 'the session now points at a fresh panel');
  assert(find(bot._log, (l) => l.to === '222' && l.method === 'sendText' && l.text.includes('Sent anonymously')), 'fresh panel sent');
});

test('adapter: identical edits are skipped, "not modified" is swallowed, invalid reactions are fixed', async () => {
  const calls = [];
  const api = {
    sendMessage: async (p) => { calls.push(['sendMessage', p]); return { message_id: 1 }; },
    editMessageText: async (p) => {
      calls.push(['editMessageText', p]);
      if (p.text === 'nope') throw mkErr('Bad Request: message is not modified');
      if (p.text === 'gone') throw mkErr("Bad Request: message can't be edited");
      return { message_id: p.message_id };
    },
    editMessageReplyMarkup: async (p) => { calls.push(['editMessageReplyMarkup', p]); return true; },
    setMessageReaction: async (p) => { calls.push(['setMessageReaction', p]); return true; },
    sendChatAction: async (p) => { calls.push(['sendChatAction', p]); return true; }
  };
  const adapter = createAdapter({ api }, { username: 'X' });

  await adapter.editText(1, 10, 'same', {});
  await adapter.editText(1, 10, 'same', {});
  assert.strictEqual(calls.filter((c) => c[0] === 'editMessageText').length, 1, 'second identical edit skipped');

  const noop = await adapter.editText(1, 11, 'nope', {});
  assert.strictEqual(noop.noop, true, 'NOT_MODIFIED treated as success');

  let threw = null;
  try { await adapter.editText(1, 12, 'gone', {}); } catch (e) { threw = e; }
  assert(threw && threw.tg && threw.tg.kind === 'uneditable', 'uneditable is tagged for the engine');

  await adapter.react(1, 13, '✅'); // NOT a valid bot reaction
  const react = calls.find((c) => c[0] === 'setMessageReaction');
  assert(reactions.FREE_SET.has(react[1].reaction[0].emoji), 'coerced onto the free whitelist');

  await adapter.react(1, 14, '🔥');
  assert.strictEqual(calls.filter((c) => c[0] === 'setMessageReaction')[1][1].reaction[0].emoji, '🔥', 'valid emoji untouched');
});

test('rich messages: used when enabled, latched off after a capability failure', async () => {
  const gate = new RichGate('auto');
  const bot = mockBot({ richGate: gate, fail: { rich: 'Bad Request: method sendRichMessage is not supported' } });
  const store = mkStore();
  await engine.handleHelp(bot, store, { chat: { id: 111, type: 'private' }, from: { id: 111 }, text: '/help' }, { ...CFG, richGate: gate });
  assert.strictEqual(gate.latchedOff, true, 'latched off after a capability error');
  assert(find(bot._log, (l) => l.method === 'sendText' && l.text.includes('How')), 'fell back to HTML');

  const gate2 = new RichGate('on');
  const bot2 = mockBot({ richGate: gate2 });
  await engine.handleHelp(bot2, store, { chat: { id: 111, type: 'private' }, from: { id: 111 }, text: '/help' }, { ...CFG, richGate: gate2 });
  assert(find(bot2._log, (l) => l.method === 'sendRich'), 'rich message used when the server supports it');
});

test('/admin uses a structured rich table in DM and refreshes the SAME message', async () => {
  const gate = new RichGate('on');
  const bot = mockBot({ richGate: gate });
  const store = mkStore();
  const cfg = { ...CFG, transport: 'long-poll', uptime: () => '1h' };
  await engine.handleAdmin(bot, store, { chat: { id: -100, type: 'supergroup' }, from: { id: 999 } }, cfg);
  assert(!find(bot._log, (l) => l.method === 'sendRich'), 'private stats never posted in a group');
  bot._log.length = 0;
  await engine.handleAdmin(bot, store, { chat: { id: 999, type: 'private' }, from: { id: 999 } }, cfg);
  const dashboard = find(bot._log, (l) => l.method === 'sendRich');
  assert(dashboard, 'opt-in rich message used');
  const table = dashboard.html.blocks.find((b) => b.type === 'table');
  assert(table && table.is_bordered && table.is_compact && table.cells[0][0].is_header,
    'actual InputRichBlockTable cells, not a fake HTML/code table');
  const mid = dashboard.message_id;
  assert.strictEqual(store.getPanel('admin:999'), mid);
  bot._log.length = 0;
  await engine.handleCallback(bot, store, { id: 'refresh', from: { id: 999 },
    message: { chat: { id: 999 }, message_id: mid }, data: 'admin:refresh' }, cfg);
  const refresh = find(bot._log, (l) => l.method === 'editRich');
  assert(refresh && refresh.messageId === mid && refresh.content.blocks.some((b) => b.type === 'table'));
  assert(!find(bot._log, (l) => l.method === 'sendRich' || l.method === 'sendText'), 'no new message on refresh');

  bot._log.length = 0;
  await engine.handleCallback(bot, store, { id: 'reports', from: { id: 999 },
    message: { chat: { id: 999 }, message_id: mid }, data: 'admin:reports' }, cfg);
  assert(find(bot._log, (l) => l.method === 'editText' && l.messageId === mid), 'report view edits same private panel');
  bot._log.length = 0;
  await engine.handleCallback(bot, store, { id: 'back', from: { id: 999 },
    message: { chat: { id: 999 }, message_id: mid }, data: 'admin:refresh' }, cfg);
  assert(find(bot._log, (l) => l.method === 'editRich' && l.messageId === mid), 'return to table edits in place');
});

test('admin rich capability fallback is HTML; failed edits repoint the private panel', async () => {
  const gate = new RichGate('on');
  const bot = mockBot({ richGate: gate, fail: { rich: 'Bad Request: method sendRichMessage is not supported' } });
  const store = mkStore();
  const msg = { chat: { id: 999, type: 'private' }, from: { id: 999 } };
  await engine.handleAdmin(bot, store, msg, CFG);
  assert(gate.latchedOff, 'unsupported endpoint latched off');
  const html = find(bot._log, (l) => l.method === 'sendText' && l.to === '999');
  assert(html && html.text.includes('Bot admin'));
  bot._log.length = 0;
  await engine.handleCallback(bot, store, { id: 'again', from: { id: 999 },
    message: { chat: { id: 999 }, message_id: html.message_id }, data: 'admin:refresh' }, CFG);
  assert(find(bot._log, (l) => l.method === 'editText' && l.messageId === html.message_id),
    'HTML fallback refreshes the existing panel');
  assert(!find(bot._log, (l) => l.method === 'sendText'), 'no duplicate fallback dashboard');

  const bot2 = mockBot({ richGate: new RichGate('on'), fail: { editOnce: "Bad Request: message can't be edited" } });
  const store2 = mkStore();
  await engine.handleAdmin(bot2, store2, msg, CFG);
  const first = store2.getPanel('admin:999');
  await engine.handleAdmin(bot2, store2, msg, CFG);
  assert.notStrictEqual(store2.getPanel('admin:999'), first, 'old rich panel replaced after an uneditable error');
  assert.strictEqual(all(bot2._log, (l) => l.method === 'sendRich').length, 2, 'just one replacement');
});

test('adapter editMedia serializes photo edits with spoilers and skips identical calls', async () => {
  const calls = [];
  const adapter = createAdapter({ api: { editMessageMedia: async (p) => { calls.push(p); return { message_id: p.message_id }; } } },
    { username: 'YoriBot' });
  await adapter.editMedia(999, 10, 'photo', 'cached-file-id', 'secret', { parse_mode: 'HTML', has_spoiler: true });
  await adapter.editMedia(999, 10, 'photo', 'cached-file-id', 'secret', { parse_mode: 'HTML', has_spoiler: true });
  assert.strictEqual(calls.length, 1, 'identical edit is not resent');
  assert.deepStrictEqual(calls[0].media, { type: 'photo', media: 'cached-file-id', caption: 'secret',
    parse_mode: 'HTML', has_spoiler: true });
  assert.strictEqual(calls[0].chat_id, 999);
  assert.strictEqual(calls[0].message_id, 10);
});

test('membership change clears the ephemeral latch when the bot is promoted', async () => {
  const bot = mockBot();
  const store = mkStore();
  store.setChatCap(-100, 'ephemeral', false);
  await engine.handleMyChatMember(bot, store, {
    chat: { id: -100, type: 'supergroup', title: 'G' },
    new_chat_member: { status: 'administrator' }
  });
  assert.strictEqual(store.chatCap(-100, 'ephemeral'), undefined, 'latch cleared');
  assert(find(bot._log, (l) => l.text && l.text.includes('Invisible whispers')), 'the group is told');
});

// ═══════════════════════════════════════════════════════════════════ plumbing

test('media classification covers the modern payload types', () => {
  assert.deepStrictEqual(media.classifyMessage({ text: 'hello' }), { kind: 'text', text: 'hello' });
  assert.strictEqual(media.classifyMessage({ photo: [{ file_id: 'a' }, { file_id: 'b' }] }).fileId, 'b');
  const live = media.classifyMessage({ live_photo: { file_id: 'vid', photo: [{ file_id: 'still' }] } });
  assert.strictEqual(live.type, 'live_photo');
  assert.strictEqual(live.payload.photo, 'still');
  assert.strictEqual(media.classifyMessage({ dice: { emoji: '🎲', value: 3 } }).kind, 'native');
  assert.strictEqual(media.classifyMessage({ poll: { question: 'q', options: [{ text: 'a' }] } }).type, 'poll');
  assert.strictEqual(media.classifyMessage({ venue: { location: { latitude: 1, longitude: 2 }, title: 't', address: 'a' } }).type, 'venue');
  assert.strictEqual(media.classifyMessage({ paid_media: {} }).kind, 'unsupported');
  assert.strictEqual(media.classifyMessage({ text: '/start' }).kind, 'unsupported');
});

test('store persists atomically and reloads', () => {
  const file = tmpFile();
  const a = new Store(file);
  const u = a.getOrCreateUser('111', { username: 'alice', firstName: 'Alice' });
  a.createWhisper({ chatId: -1, chatType: 'supergroup', fromId: '111', fromLabel: 'A', targets: [{ key: 'u:b', label: '@b' }], targetLabel: '@b', text: 'x' });
  const staged = a.createWhisper({ chatId: null, chatType: 'inline', fromId: '111',
    targets: [{ key: 'i:50001', label: 'user 50001', userId: '50001' }],
    targetLabel: 'user 50001', inlinePrepared: true, text: 'private caption',
    media: { kind: 'media', type: 'photo', fileId: 'cached-private-photo' } });
  a.close();
  assert(fs.existsSync(file), 'file written');
  assert(!fs.existsSync(file + `.${process.pid}.tmp`), 'temp file cleaned up');

  const b = new Store(file);
  assert.strictEqual(b.getUser('111').token, u.token, 'user survived the round-trip');
  assert.strictEqual(b.getUserByUsername('ALICE').chatId, '111', 'username index is case-insensitive');
  assert.strictEqual(b.activeWhispers().length, 2, 'whispers survived');
  assert.strictEqual(b.getWhisper(staged.id).inlinePrepared, true, 'inline-media mode survives a restart');
  assert.strictEqual(b.getWhisper(staged.id).media.fileId, 'cached-private-photo', 'private file_id survives a restart');
  b.close();
});

test('store.prune drops stale rate logs and finished whispers', () => {
  const store = mkStore();
  store.rateCheck('1', '2', { minIntervalMs: 0 });
  const w = store.createWhisper({ chatId: -1, chatType: 'group', fromId: '1', targets: [], targetLabel: '@x', text: 'x' });
  store.updateWhisper(w.id, { status: 'burned', createdAt: Date.now() - 3 * 86400000 });
  const removed = store.prune();
  assert(removed > 0, 'something was pruned');
  assert.strictEqual(store.getWhisper(w.id), null, 'old burned whisper dropped');
  store.close();
});

// ════════════════════════════════════════════════════════════════════ server

test('HTTP server: health/ready/metrics/status and the webhook route', async () => {
  let connected = false;
  const got = [];
  const server = createServer({
    status: () => ({ mode: 'long-poll', tokenConfigured: true, connected, botUsername: 'YoriBot', users: 3 }),
    webhookPath: '/telegram/abc',
    secretToken: 'sekret',
    onWebhook: async (update) => { got.push(update); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  let res = await fetch(base + '/healthz');
  assert.strictEqual(res.status, 200, 'healthz is 200 while the process is up');
  assert.strictEqual((await res.json()).status, 'ok');

  res = await fetch(base + '/ready');
  assert.strictEqual(res.status, 503, 'ready is 503 before Telegram connects');
  connected = true;
  res = await fetch(base + '/ready');
  assert.strictEqual(res.status, 200, 'ready is 200 once connected');

  res = await fetch(base + '/');
  assert.strictEqual(res.status, 200);
  assert((await res.text()).includes('YoriBot'), 'status page renders');

  res = await fetch(base + '/metrics');
  assert.strictEqual((await res.json()).node, process.version);

  res = await fetch(base + '/telegram/abc', {
    method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'sekret', 'content-type': 'application/json' },
    body: JSON.stringify({ update_id: 1, message: { message_id: 1, chat: { id: 1 } } })
  });
  assert.strictEqual(res.status, 200, 'valid webhook accepted');
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(got.length, 1, 'update reached the handler');

  res = await fetch(base + '/telegram/abc', { method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'wrong' }, body: '{}' });
  assert.strictEqual(res.status, 401, 'bad secret rejected');

  res = await fetch(base + '/nope');
  assert.strictEqual(res.status, 404);

  await new Promise((r) => server.close(r));
});

// ---------------------------------------------------------------- integration
/*
 * The strongest check we can run offline: a REAL node-telegram-bot-api Bot with
 * an injected fetch (the library's own test seam), fed REAL update objects.
 * This proves every API method name and parameter shape we use actually exists
 * in the client and serialises the way Telegram expects — ephemeral_message_parameters,
 * reply_markup as an object, is_ephemeral commands, answerGuestQuery, and so on.
 */
test('integration: real updates through the real client produce real API calls', async () => {
  const calls = [];
  const decode = (body) => {
    const out = {};
    for (const [k, v] of new URLSearchParams(body || '')) {
      try { out[k] = /^[{[]/.test(v) ? JSON.parse(v) : v; } catch { out[k] = v; }
    }
    return out;
  };
  const fakeFetch = async (url, init) => {
    const method = String(url).split('/').pop().split('?')[0];
    const params = decode(init && init.body);
    calls.push({ method, params });
    let result = true;
    if (method === 'getMe') {
      result = { id: 1, is_bot: true, first_name: 'Yori', username: 'YoriTestBot' };
    } else if (/^send/.test(method) && method !== 'sendChatAction') {
      result = { message_id: 700 + calls.length, date: 1, chat: { id: Number(params.chat_id), type: 'private' } };
      if (params.ephemeral_message_parameters) {
        // An ephemeral message has no visible message_id, only an ephemeral id.
        result.message_id = 0;
        result.ephemeral_message_id = 9000 + calls.length;
      }
    } else if (method === 'answerInlineQuery' || method === 'answerGuestQuery') {
      result = { inline_message_id: 'inline-' + calls.length };
    }
    return new Response(JSON.stringify({ ok: true, result }), {
      status: 200, headers: { 'content-type': 'application/json' }
    });
  };

  const { buildBot } = require('../src/telegram');
  const store = new Store(tmpFile());
  const { bot, adapter, bootstrap } = buildBot('123456:TEST-TOKEN', {
    store, setProfile: false, botOptions: { fetch: fakeFetch }
  });

  const me = await bootstrap();
  assert.strictEqual(me.ok, true, 'bootstrap succeeded');
  assert.strictEqual(adapter.username, 'YoriTestBot', 'username learned from getMe');
  assert.strictEqual(adapter.name, 'Yori', 'the real bot name is used when BOT_NAME is unset');
  assert(!calls.some((c) => c.method === 'setMyName'), 'we never rename a bot that did not ask for it');
  const groupCmds = calls.find((c) => c.method === 'setMyCommands' &&
    c.params.scope && c.params.scope.type === 'all_group_chats');
  assert(groupCmds && groupCmds.params.commands.some((x) => x.is_ephemeral === true),
    'group commands registered with is_ephemeral (Bot API 10.2)');

  // --- a whisper in a group goes out as an ephemeral message -----------------
  store.getOrCreateUser('5001', { username: 'alice' });
  calls.length = 0;
  await bot.handleUpdate({
    update_id: 11,
    message: {
      message_id: 5, date: 1, chat: { id: -100, type: 'supergroup', title: 'G' },
      from: { id: 777, first_name: 'Sam', username: 'sam' },
      text: '/w @alice the meeting is cancelled'
    }
  });
  const wsend = calls.find((c) => c.method === 'sendMessage' && c.params.ephemeral_message_parameters);
  assert(wsend, 'ephemeral whisper reached the wire');
  assert.strictEqual(Number(wsend.params.ephemeral_message_parameters.receiver_user_id), 5001,
    'addressed to alice and nobody else');
  assert.strictEqual(wsend.params.parse_mode, 'HTML');
  assert(wsend.params.reply_markup && Array.isArray(wsend.params.reply_markup.inline_keyboard),
    'reply_markup is a real object, not a JSON string');
  assert(wsend.params.link_preview_options && wsend.params.link_preview_options.is_disabled === true,
    'link previews disabled');
  assert(calls.some((c) => c.method === 'setMessageReaction'), 'the sender gets a reaction');
  assert(calls.every((c) => c.method !== 'sendMessage' || c.params.ephemeral_message_parameters),
    'nothing about this whisper was posted publicly');

  // --- burning it deletes the ephemeral message -----------------------------
  const w = store.activeWhispers()[0];
  assert(w, 'whisper recorded');
  calls.length = 0;
  await bot.handleUpdate({
    update_id: 12,
    callback_query: {
      id: 'cb1', chat_instance: 'ci', from: { id: 5001, first_name: 'Alice', username: 'alice' },
      data: 'w_burn:' + w.id
    }
  });
  assert(calls.some((c) => c.method === 'answerCallbackQuery'), 'callback acknowledged');
  assert(calls.some((c) => c.method === 'deleteEphemeralMessage'),
    'burn deletes the ephemeral message, got: ' + calls.map((c) => c.method).join(','));

  // --- inline mode ----------------------------------------------------------
  calls.length = 0;
  await bot.handleUpdate({
    update_id: 13,
    inline_query: { id: 'iq1', from: { id: 777, first_name: 'Sam' }, query: '@bob a quiet note', offset: '' }
  });
  const aiq = calls.find((c) => c.method === 'answerInlineQuery');
  assert(aiq, 'inline query answered');
  assert(aiq.params.is_personal === true || aiq.params.is_personal === 'true',
    'inline result is personal to the sender');
  assert.strictEqual(aiq.params.results[0].type, 'article', 'whisper card is an article');
  assert(aiq.params.results[0].reply_markup, 'inline whisper card carries buttons');
  assert(aiq.params.results[0].input_message_content.message_text.includes('from Sam to @bob'),
    'signed sender → recipient card is serialized on the wire');
  assert(!aiq.params.results[0].input_message_content.message_text.includes('a quiet note'),
    'the inline card does not expose the secret on the wire');

  calls.length = 0;
  await bot.handleUpdate({
    update_id: 130,
    inline_query: { id: 'iq-anon', from: { id: 777, first_name: 'Sam' }, query: '123456789 a quiet note 0', offset: '' }
  });
  const aiqAnon = calls.find((c) => c.method === 'answerInlineQuery');
  assert(aiqAnon, 'anonymous inline query answered');
  const anonCard = aiqAnon.params.results[0].input_message_content.message_text;
  assert(anonCard.includes('Whisper for user 123456789') && !anonCard.includes('Sam'),
    'trailing 0 removes the sender label from the wire payload');

  // --- structured rich table + in-place rich and media edits on the real client
  calls.length = 0;
  const richTable = ui.adminRichMessage({ users: 4, groups: 1, transport: 'polling', rich: 'on' });
  await adapter.sendRich(999, richTable, { parse_mode: 'HTML' });
  await adapter.editRich(999, 888, richTable, {});
  await adapter.editMedia(5001, 889, 'photo', 'server-photo-id', '🤫 private', { parse_mode: 'HTML', has_spoiler: true });
  const richSend = calls.find((c) => c.method === 'sendRichMessage');
  const richEdit = calls.find((c) => c.method === 'editMessageText');
  const mediaEdit = calls.find((c) => c.method === 'editMessageMedia');
  assert(richSend && richSend.params.rich_message.blocks.some((b) => b.type === 'table'), 'rich table serialized');
  assert(!richSend.params.parse_mode, 'legacy parse_mode is not sent with a rich message');
  assert(richEdit && richEdit.params.rich_message.blocks.some((b) => b.type === 'table') && !richEdit.params.text,
    'editMessageText edits rich blocks without an incompatible text parameter');
  assert(mediaEdit && mediaEdit.params.media.media === 'server-photo-id' && mediaEdit.params.media.has_spoiler,
    'editMessageMedia uses an InputMediaPhoto file_id and spoiler');

  // --- staged inline photo: PUBLIC article + protected PRIVATE delivery -------
  calls.length = 0;
  await bot.handleUpdate({ update_id: 131, message: {
    message_id: 32, date: 1, chat: { id: 888, type: 'private' },
    from: { id: 888, first_name: 'Sam', username: 'sam' }, text: '/wi @alice 0'
  } });
  await bot.handleUpdate({ update_id: 132, message: {
    message_id: 33, date: 1, chat: { id: 888, type: 'private' },
    from: { id: 888, first_name: 'Sam', username: 'sam' },
    photo: [{ file_id: 'private-photo-id' }], caption: 'a quiet photo'
  } });
  const prepared = store.activeWhispers().find((x) => x.inlinePrepared);
  assert(prepared && prepared.media.fileId === 'private-photo-id', 'real handler staged file by Telegram file_id');
  calls.length = 0;
  await bot.handleUpdate({ update_id: 133, inline_query: {
    id: 'photo-iq', from: { id: 888, first_name: 'Sam', username: 'sam' }, query: 'share:' + prepared.id, offset: ''
  } });
  const photoResult = calls.find((c) => c.method === 'answerInlineQuery').params.results[0];
  assert.strictEqual(photoResult.type, 'article', 'not a public inline photo');
  assert(!JSON.stringify(photoResult).includes('private-photo-id') && !JSON.stringify(photoResult).includes('a quiet photo'),
    'file id and caption stay out of the public inline response');
  calls.length = 0;
  await bot.handleUpdate({ update_id: 134, callback_query: {
    id: 'open-private', from: { id: 5001, username: 'alice' }, inline_message_id: 'im-photo',
    chat_instance: 'not-a-chat-id', data: 'w_open:' + prepared.id
  } });
  assert(calls.find((c) => c.method === 'answerCallbackQuery').params.url.endsWith('wm_' + prepared.id),
    'callback offers an authorized deep link instead of guessing a chat_id');
  calls.length = 0;
  await bot.handleUpdate({ update_id: 135, message: {
    message_id: 34, date: 1, chat: { id: 5001, type: 'private' },
    from: { id: 5001, username: 'alice' }, text: '/start wm_' + prepared.id
  } });
  const protectedPhoto = calls.find((c) => c.method === 'sendPhoto');
  assert(protectedPhoto && protectedPhoto.params.chat_id === '5001', 'photo only goes to recipient DM');
  assert(protectedPhoto.params.protect_content && protectedPhoto.params.has_spoiler,
    'private reveal uses protected content and spoiler');
  assert(protectedPhoto.params.photo === 'private-photo-id' && protectedPhoto.params.caption.includes('a quiet photo'));
  assert(!calls.find((c) => c.method === 'sendPhoto' && c.params.chat_id === '-100'),
    'never published photo in an inline chat');

  // --- guest mode (Bot API 10.0): works without the bot being in the chat ----
  calls.length = 0;
  await bot.handleUpdate({
    update_id: 14,
    guest_message: {
      id: 'gm1', date: 1, text: '@bob a guest secret',
      from: { id: 31337, first_name: 'Guest', supports_guest_queries: true },
      guest_query_id: 'gm1', chat: { id: -100, type: 'supergroup' }
    }
  });
  const agq = calls.find((c) => c.method === 'answerGuestQuery');
  assert(agq, 'guest query answered: ' + calls.map((c) => c.method).join(','));
  assert.strictEqual(agq.params.guest_query_id, 'gm1', 'answered with the right query id');
  assert(agq.params.result && agq.params.result.input_message_content, 'guest result carries a card');

  // --- an ordinary group message must cost nothing ---------------------------
  calls.length = 0;
  await bot.handleUpdate({
    update_id: 15,
    message: {
      message_id: 9, date: 1, chat: { id: -100, type: 'supergroup' },
      from: { id: 42, first_name: 'Someone' }, text: 'just chatting about lunch'
    }
  });
  assert.strictEqual(calls.length, 0,
    'unrelated chat traffic makes no API calls, got: ' + calls.map((c) => c.method).join(','));

  await store.close();
});

test('process boot: it LISTENS ON A PORT with no BOT_TOKEN (the deploy failure)', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'yoribot-boot-'));
  const dataFile = path.join(cwd, 'data.json');
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'index.js')], {
    cwd, // a clean cwd so a developer's local .env can't leak a real token in
    env: { ...process.env, PORT: '0', HOST: '127.0.0.1', BOT_TOKEN: '', WHISPER_DATA: dataFile, LOG_LEVEL: 'info' },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });

  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the server never opened a port within 20s:\n' + out)), 20000);
    const check = () => {
      const m = /listening on [^:]+:(\d+)/.exec(out);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); return; }
      setTimeout(check, 100);
    };
    check();
  });

  const res = await fetch(`http://127.0.0.1:${port}/healthz`);
  assert.strictEqual(res.status, 200, '/healthz answers even without a token');
  const body = await res.json();
  assert.strictEqual(body.tokenConfigured, false, 'it reports the missing token honestly');

  const ready = await fetch(`http://127.0.0.1:${port}/ready`);
  assert.strictEqual(ready.status, 503, '/ready is 503 without a token');

  const exitCode = await new Promise((resolve) => {
    child.on('exit', (code) => resolve(code));
    child.kill('SIGTERM');
    setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } resolve('timeout'); }, 8000);
  });
  assert.strictEqual(exitCode, 0, 'SIGTERM shuts the process down cleanly');
  assert(out.includes('BOT_TOKEN is missing'), 'the logs explain what to do');
  fs.rmSync(cwd, { recursive: true, force: true });
});

// ================================================================== runner

(async () => {
  const started = Date.now();
  let pass = 0;
  const failures = [];
  console.log(`\n🧪 YoriBot self-test — ${tests.length} checks\n`);
  for (const t of tests) {
    try {
      await t.fn();
      pass++;
      console.log(`  ✅ ${t.name}`);
    } catch (err) {
      failures.push({ name: t.name, err });
      console.log(`  ❌ ${t.name}`);
      console.log(`      ${err && err.message ? err.message : err}`);
    }
  }
  const ms = Date.now() - started;
  if (failures.length) {
    console.log(`\n❌ ${failures.length}/${tests.length} FAILED (${ms}ms)\n`);
    for (const f of failures) {
      console.log(`— ${f.name}`);
      console.log((f.err && f.err.stack ? f.err.stack.split('\n').slice(0, 4).join('\n') : String(f.err)) + '\n');
    }
    process.exit(1);
  }
  console.log(`\n✅ ALL ${pass} SELFTESTS PASSED (${ms}ms)\n`);
  process.exit(0);
})();
