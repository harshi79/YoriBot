'use strict';
/*
 * Persistent store for YoriBot (whispers + anonymous inbox).
 *
 * JSON-file backed, zero native deps, so it deploys anywhere. Two things a
 * viral bot cannot afford:
 *
 *   • A synchronous write on every mutation (this file is hit on every message).
 *     -> writes are debounced and coalesced.
 *   • A half-written file after an OOM kill or a container stop.
 *     -> writes go to a temp file and are atomically renamed, and we flush on
 *        SIGTERM/SIGINT before exiting.
 *
 * The engine only depends on these method names, so swapping in SQLite or
 * Postgres later means re-implementing this one file.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const MAX_LINKS = 50000;      // chatId:messageId -> threadId entries kept
const MAX_WHISPERS = 20000;   // whisper records kept

const emptyState = () => ({
  version: 2,
  users: {},           // chatId -> user
  tokens: {},          // anon-link token -> chatId
  usernames: {},       // lowercase username -> chatId
  sessions: {},        // senderChatId -> anonymous compose session
  threads: {},         // threadId -> thread
  activePair: {},      // owner:sender -> threadId
  linkMap: {},         // chatId:messageId -> threadId
  sendLog: {},         // sender -> [ts]
  pairLog: {},         // sender:target -> [ts]
  blocked: {},         // owner -> [senderChatId]
  reports: [],         // [{owner, sender, threadId, reason, ts}]
  groups: {},          // groupId -> {groupId, token, active, questions}
  groupTokens: {},     // token -> groupId
  groupSessions: {},   // senderChatId -> group Q&A session
  whisperSessions: {}, // userId -> whisper compose session (user-scoped: two
                       //            people can compose in the same group at once)
  whispers: {},        // whisperId -> whisper
  whisperDedupe: {},   // hash -> {id, ts}   (inline queries fire while typing)
  whisperContext: {},  // chatId:userId -> {whisperId, peerId, ts}  (for /r)
  chatCaps: {},        // chatId -> {ephemeral, rich}  (capability latches)
  pendingDeletes: [],  // [{chatId, messageId, at, ephemeral?}]
  counters: {},        // aggregate stats
  panels: {}           // chatId -> last panel message id (smooth re-renders)
});

class Store {
  constructor(file) {
    this.file = file || process.env.WHISPER_DATA || path.join(__dirname, '..', 'data', 'whisper.json');
    this.debounceMs = Math.max(0, Number(process.env.SAVE_DEBOUNCE_MS || 400));
    this.state = this._load();
    this._timer = null;
    this._dirty = false;
    this._closed = false;
  }

  // ---------------------------------------------------------------- persistence

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const base = emptyState();
      // Merge, so a file written by an older version still boots.
      for (const k of Object.keys(base)) {
        if (raw[k] !== undefined && raw[k] !== null) base[k] = raw[k];
      }
      base.counters = Object.assign({}, base.counters, raw.counters || {});
      return base;
    } catch {
      return emptyState();
    }
  }

  /** Queue a write. Coalesces bursts into one atomic rename. */
  _save() {
    if (this._closed) return;
    this._dirty = true;
    if (this.debounceMs === 0) return this._writeNow();
    if (this._timer) return;
    this._timer = setTimeout(() => { this._timer = null; this._writeNow(); }, this.debounceMs);
    if (typeof this._timer.unref === 'function') this._timer.unref();
  }

  _writeNow() {
    if (!this._dirty) return false;
    this._dirty = false;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.state));
      fs.renameSync(tmp, this.file); // atomic on POSIX
      return true;
    } catch (e) {
      // Never let a storage hiccup kill an update handler.
      if (process.env.DEBUG_BOT) console.warn('[store] write failed:', e && e.message);
      return false;
    }
  }

  /** Flush pending writes (called on shutdown and by tests). */
  flush() { return this._writeNow(); }

  close() {
    this._closed = true;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    return this._writeNow();
  }

  _token(bytes = 5, taken = this.state.tokens) {
    let t;
    do { t = crypto.randomBytes(bytes).toString('hex'); } while (taken[t]);
    return t;
  }

  bump(name, by = 1) {
    this.state.counters[name] = (this.state.counters[name] || 0) + by;
    this._save();
  }

  counters() { return { ...this.state.counters }; }

  // ------------------------------------------------------------------- users

  getOrCreateUser(chatId, from = {}) {
    chatId = String(chatId);
    let u = this.state.users[chatId];
    if (!u) {
      const token = this._token();
      u = {
        chatId,
        token,
        username: from.username || null,
        firstName: from.firstName || from.first_name || null,
        receiving: true,
        protect: false,
        spoiler: false,
        autoDeleteMs: 0,        // burn-after-reading for received messages
        silent: false,          // deliver without a notification sound
        received: 0,
        sent: 0,
        whispersSent: 0,
        whispersGot: 0,
        createdAt: Date.now(),
        lastSeenAt: Date.now()
      };
      this.state.users[chatId] = u;
      this.state.tokens[token] = chatId;
      this.bump('users');
    } else {
      u.lastSeenAt = Date.now();
      if (from.username && u.username !== from.username) u.username = from.username;
      const name = from.firstName || from.first_name;
      if (name && u.firstName !== name) u.firstName = name;
    }
    if (u.username) this.indexUsername(u.username, chatId);
    this._save();
    return u;
  }

  indexUsername(username, chatId) {
    if (!username) return;
    const key = String(username).toLowerCase();
    if (this.state.usernames[key] !== String(chatId)) {
      this.state.usernames[key] = String(chatId);
      this._save();
    }
  }

  getUser(chatId) { return this.state.users[String(chatId)] || null; }
  getUserByUsername(username) {
    if (!username) return null;
    const id = this.state.usernames[String(username).toLowerCase().replace(/^@/, '')];
    return id ? this.state.users[id] || null : null;
  }
  getTargetByToken(token) { const c = this.state.tokens[token]; return c ? String(c) : null; }
  userCount() { return Object.keys(this.state.users).length; }
  setField(chatId, field, value) {
    const u = this.getUser(chatId);
    if (!u) return null;
    u[field] = value;
    this._save();
    return u;
  }
  toggle(user, field) { user[field] = !user[field]; this._save(); return user[field]; }
  setReceiving(chatId, v) { this.setField(chatId, 'receiving', !!v); }
  recordSent(chatId) { const u = this.getUser(chatId); if (u) { u.sent++; this._save(); } }
  recordReceived(chatId) { const u = this.getUser(chatId); if (u) { u.received++; this._save(); } }
  recordWhisperSent(chatId) { const u = this.getUser(chatId); if (u) { u.whispersSent++; this._save(); } }
  recordWhisperGot(chatId) { const u = this.getUser(chatId); if (u) { u.whispersGot++; this._save(); } }

  /** Auto-delete (burn after reading) schedule for a delivered message. */
  scheduleDelete(chatId, messageId, delayMs, extra = {}) {
    if (!chatId || !messageId || !delayMs) return;
    this.state.pendingDeletes.push({ chatId: String(chatId), messageId, at: Date.now() + delayMs, ...extra });
    this._save();
  }
  dueDeletes(now = Date.now()) {
    const due = this.state.pendingDeletes.filter((d) => d.at <= now);
    if (due.length) {
      this.state.pendingDeletes = this.state.pendingDeletes.filter((d) => d.at > now);
      this._save();
    }
    return due;
  }

  // ---------------------------------------------------------------- sessions

  setSession(senderChatId, session) {
    this.state.sessions[String(senderChatId)] = { senderId: String(senderChatId), ...session };
    this._save();
  }
  getSession(senderChatId) { return this.state.sessions[String(senderChatId)] || null; }
  clearSession(senderChatId) { delete this.state.sessions[String(senderChatId)]; this._save(); }

  // ----------------------------------------------------------------- threads

  getOrCreateThread(owner, sender) {
    owner = String(owner); sender = String(sender);
    const key = owner + ':' + sender;
    const existing = this.state.activePair[key];
    if (existing && this.state.threads[existing] && this.state.threads[existing].active) {
      return this.state.threads[existing];
    }
    const id = crypto.randomBytes(6).toString('hex');
    const t = { id, owner, sender, createdAt: Date.now(), count: 0, active: true, lastOwnerMsgId: null, lastSenderMsgId: null };
    this.state.threads[id] = t;
    this.state.activePair[key] = id;
    this._save();
    return t;
  }
  getThread(id) { return this.state.threads[id] || null; }

  linkMessage(chatId, messageId, threadId) {
    if (!chatId || !messageId) return;
    const map = this.state.linkMap;
    const key = String(chatId) + ':' + messageId;
    map[key] = threadId;
    const keys = Object.keys(map);
    if (keys.length > MAX_LINKS) {
      // Object string keys keep insertion order: drop the oldest 10%.
      for (const k of keys.slice(0, Math.ceil(MAX_LINKS * 0.1))) delete map[k];
    }
    this._save();
  }
  threadByLink(chatId, messageId) { return this.state.linkMap[String(chatId) + ':' + messageId] || null; }
  setThreadField(id, field, value) { const t = this.getThread(id); if (t) { t[field] = value; this._save(); } }
  closeThread(id) { const t = this.getThread(id); if (t) { t.active = false; this._save(); } }

  // ------------------------------------------------------------- rate limits

  rateCheck(sender, target, cfg = {}) {
    sender = String(sender); target = String(target);
    const now = Date.now();
    const g = (this.state.sendLog[sender] || []).filter((t) => now - t < HOUR);
    this.state.sendLog[sender] = g;
    if (g.length >= (cfg.globalPerHour || 80)) {
      return { ok: false, reason: "You've hit the hourly message limit. Take a breather and try later." };
    }
    const pk = sender + ':' + target;
    const p = (this.state.pairLog[pk] || []).filter((t) => now - t < HOUR);
    this.state.pairLog[pk] = p;
    const pairCap = target.startsWith('w:') ? (cfg.whisperPerHour || 40) : (cfg.pairPerHour || 40);
    if (p.length >= pairCap) {
      return { ok: false, reason: "Whoa, that's a lot to one person this hour. Slow down." };
    }
    const last = g[g.length - 1] || 0;
    if (now - last < (cfg.minIntervalMs || 1200)) {
      return { ok: false, reason: 'Slow down a second… 🐢' };
    }
    g.push(now); p.push(now);
    this._save();
    return { ok: true };
  }

  // --------------------------------------------------------- block / report

  isBlocked(owner, sender) {
    owner = String(owner); sender = String(sender);
    return !!(this.state.blocked[owner] && this.state.blocked[owner].includes(sender));
  }
  block(owner, sender) {
    owner = String(owner); sender = String(sender);
    this.state.blocked[owner] = this.state.blocked[owner] || [];
    if (!this.state.blocked[owner].includes(sender)) { this.state.blocked[owner].push(sender); this._save(); }
  }
  unblock(owner, sender) {
    owner = String(owner); sender = String(sender);
    if (this.state.blocked[owner]) {
      this.state.blocked[owner] = this.state.blocked[owner].filter((s) => s !== sender);
      this._save();
    }
  }
  listBlocked(owner) { return this.state.blocked[String(owner)] || []; }
  addReport(r) {
    this.state.reports.push({ ts: Date.now(), ...r });
    if (this.state.reports.length > 1000) this.state.reports = this.state.reports.slice(-1000);
    this.bump('reports');
    this._save();
  }
  getReports(limit = 50) { return this.state.reports.slice(-limit); }

  // --------------------------------------------- group "ask me anything"

  getOrCreateGroup(groupId) {
    groupId = String(groupId);
    if (this.state.groups[groupId]) return this.state.groups[groupId].token;
    const token = this._token();
    this.state.groups[groupId] = { groupId, token, active: true, questions: 0, createdAt: Date.now() };
    this.state.groupTokens[token] = groupId;
    this._save();
    return token;
  }
  getGroup(groupId) { return this.state.groups[String(groupId)] || null; }
  getGroupByToken(token) { const g = this.state.groupTokens[token]; return g ? String(g) : null; }
  setGroupActive(groupId, v) { const g = this.getGroup(groupId); if (g) { g.active = !!v; this._save(); } }
  recordGroupQuestion(groupId) { const g = this.getGroup(groupId); if (g) { g.questions++; this.bump('groupQuestions'); this._save(); } }
  setWhisperSession(userId, session) {
    this.state.whisperSessions[String(userId)] = { senderId: String(userId), ...session };
    this._save();
  }
  getWhisperSession(userId) { return this.state.whisperSessions[String(userId)] || null; }
  clearWhisperSession(userId) { delete this.state.whisperSessions[String(userId)]; this._save(); }

  setGroupSession(sender, session) {
    this.state.groupSessions[String(sender)] = { senderId: String(sender), ...session };
    this._save();
  }
  getGroupSession(sender) { return this.state.groupSessions[String(sender)] || null; }
  clearGroupSession(sender) { delete this.state.groupSessions[String(sender)]; this._save(); }
  groupCount() { return Object.keys(this.state.groups).length; }

  // --------------------------------------------------------------- whispers

  createWhisper(w) {
    const id = w.id || crypto.randomBytes(6).toString('hex');
    const rec = {
      id,
      status: 'active',
      createdAt: Date.now(),
      chatId: w.chatId != null ? String(w.chatId) : null,   // where it lives
      chatType: w.chatType || 'private',
      chatTitle: w.chatTitle || null,
      fromId: String(w.fromId),
      fromLabel: w.fromLabel || 'Someone',
      signed: !!w.signed,
      targets: w.targets || [],
      targetLabel: w.targetLabel || 'someone',
      text: w.text || '',
      media: w.media || null,           // {kind, type, fileId, caption, params}
      inlinePrepared: !!w.inlinePrepared, // photo staged in DM; never in the public card
      oneTime: !!w.oneTime,
      allowSenderReopen: w.allowSenderReopen !== false,
      expiresAt: w.expiresAt || (Date.now() + 7 * DAY),
      openedBy: [],
      peeks: 0,
      delivery: null,                   // 'ephemeral' | 'card' | 'dm'
      cardMessageId: null,
      ephemerals: [],                   // [{receiverUserId, ephemeralMessageId}]
      dmMessageIds: {}                  // userId -> messageId
    };
    this.state.whispers[id] = rec;
    this.bump('whispers');
    this._capWhispers();
    this._save();
    return rec;
  }

  _capWhispers() {
    const keys = Object.keys(this.state.whispers);
    if (keys.length <= MAX_WHISPERS) return;
    for (const k of keys.slice(0, keys.length - MAX_WHISPERS)) delete this.state.whispers[k];
  }

  getWhisper(id) { return this.state.whispers[id] || null; }
  activeWhispers() { return Object.values(this.state.whispers).filter((w) => w.status === 'active'); }
  whispersFor(userId) {
    const id = String(userId);
    return Object.values(this.state.whispers)
      .filter((w) => w.fromId === id || (w.targets || []).some((t) => t.userId === id))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 20);
  }
  updateWhisper(id, patch) {
    const w = this.getWhisper(id);
    if (!w) return null;
    Object.assign(w, patch);
    this._save();
    return w;
  }
  removeWhisper(id) {
    if (!this.state.whispers[id]) return false;
    delete this.state.whispers[id];
    this._save();
    return true;
  }
  dueWhispers(now = Date.now()) {
    return Object.values(this.state.whispers).filter((w) => w.status === 'active' && w.expiresAt <= now);
  }
  recordPeek(id) { const w = this.getWhisper(id); if (w) { w.peeks++; this.bump('whisperPeeks'); this._save(); } return w; }
  recordOpen(id, userId) {
    const w = this.getWhisper(id);
    if (!w) return null;
    const uid = String(userId);
    if (!w.openedBy.includes(uid)) { w.openedBy.push(uid); this.bump('whisperOpens'); }
    this._save();
    return w;
  }

  /** Inline queries fire on every keystroke — reuse a record for identical input. */
  dedupeWhisperKey(hash, ttlMs = 60000) {
    const hit = this.state.whisperDedupe[hash];
    const now = Date.now();
    if (hit && now - hit.ts < ttlMs && this.state.whispers[hit.id]) return this.state.whispers[hit.id];
    return null;
  }
  rememberWhisperKey(hash, id) {
    this.state.whisperDedupe[hash] = { id, ts: Date.now() };
    const keys = Object.keys(this.state.whisperDedupe);
    if (keys.length > 5000) for (const k of keys.slice(0, 1000)) delete this.state.whisperDedupe[k];
    this._save();
  }

  /** Who am I talking to in this chat, for the invisible `/r` reply command. */
  setWhisperContext(chatId, userId, ctx) {
    this.state.whisperContext[String(chatId) + ':' + String(userId)] = { ...ctx, ts: Date.now() };
    this._save();
  }
  getWhisperContext(chatId, userId) {
    const c = this.state.whisperContext[String(chatId) + ':' + String(userId)];
    if (!c) return null;
    if (Date.now() - c.ts > 7 * DAY) { delete this.state.whisperContext[String(chatId) + ':' + String(userId)]; this._save(); return null; }
    return c;
  }

  // --------------------------------------------------- capability latches

  /** @returns {boolean|undefined} undefined = "unknown, try it" */
  chatCap(chatId, cap) {
    const c = this.state.chatCaps[String(chatId)];
    return c ? c[cap] : undefined;
  }
  setChatCap(chatId, cap, value) {
    const k = String(chatId);
    this.state.chatCaps[k] = this.state.chatCaps[k] || {};
    if (this.state.chatCaps[k][cap] === value) return;
    this.state.chatCaps[k][cap] = value;
    this._save();
  }
  /** Forget a latch — used when the bot is promoted, so we retry the feature. */
  clearChatCap(chatId, cap) {
    const k = String(chatId);
    const c = this.state.chatCaps[k];
    if (c && cap in c) { delete c[cap]; this._save(); }
  }

  // ------------------------------------------------------------------ panels

  setPanel(chatId, messageId) { this.state.panels[String(chatId)] = messageId; this._save(); }
  getPanel(chatId) { return this.state.panels[String(chatId)] || null; }

  // ------------------------------------------------------------------ prune

  /** Drop stale bookkeeping. Safe to call on a timer. */
  prune(now = Date.now()) {
    let removed = 0;
    for (const [k, arr] of Object.entries(this.state.sendLog)) {
      const fresh = arr.filter((t) => now - t < HOUR);
      if (fresh.length !== arr.length) { this.state.sendLog[k] = fresh; removed++; }
      if (!fresh.length) delete this.state.sendLog[k];
    }
    for (const [k, arr] of Object.entries(this.state.pairLog)) {
      const fresh = arr.filter((t) => now - t < HOUR);
      if (fresh.length !== arr.length) { this.state.pairLog[k] = fresh; removed++; }
      if (!fresh.length) delete this.state.pairLog[k];
    }
    for (const [id, w] of Object.entries(this.state.whispers)) {
      // Keep burned/expired records briefly (for the "🔥 burned" card), then drop.
      if (w.status !== 'active' && now - w.createdAt > DAY) { delete this.state.whispers[id]; removed++; }
      else if (now - w.createdAt > 30 * DAY) { delete this.state.whispers[id]; removed++; }
    }
    for (const [k, v] of Object.entries(this.state.whisperDedupe)) {
      if (now - v.ts > HOUR) { delete this.state.whisperDedupe[k]; removed++; }
    }
    this.state.pendingDeletes = this.state.pendingDeletes.filter((d) => now - d.at < DAY);
    if (removed) this._save();
    return removed;
  }
}

module.exports = Store;
