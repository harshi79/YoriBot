'use strict';
/*
 * Persistent store for AgrrhBot.
 * JSON-file backed (zero native deps). For a viral-scale deployment, swap this
 * for SQLite/Postgres — the engine only depends on these method names.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_FILE = process.env.WHISPER_DATA || path.join(__dirname, '..', 'data', 'whisper.json');
const HOUR = 3600 * 1000;

class Store {
  constructor(file = DEFAULT_FILE) {
    this.file = file;
    this.state = this._load();
  }

  _load() {
    try {
      const s = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return {
        users: s.users || {},
        tokens: s.tokens || {},
        sessions: s.sessions || {},
        threads: s.threads || {},
        activePair: s.activePair || {},
        linkMap: s.linkMap || {},
        sendLog: s.sendLog || {},
        pairLog: s.pairLog || {}
      };
    } catch {
      return { users: {}, tokens: {}, sessions: {}, threads: {}, activePair: {}, linkMap: {}, sendLog: {}, pairLog: {} };
    }
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.state));
    } catch (e) { /* demo: ignore transient write errors */ }
  }

  _token() {
    let t;
    do { t = crypto.randomBytes(5).toString('hex'); } while (this.state.tokens[t]);
    return t;
  }

  getOrCreateUser(chatId, from = {}) {
    chatId = String(chatId);
    let u = this.state.users[chatId];
    if (!u) {
      const token = this._token();
      u = {
        chatId, token,
        username: from.username || null,
        firstName: from.firstName || null,
        receiving: true, protect: false, spoiler: false,
        received: 0, sent: 0, createdAt: Date.now()
      };
      this.state.users[chatId] = u;
      this.state.tokens[token] = chatId;
      this._save();
    } else {
      if (from.username && u.username !== from.username) { u.username = from.username; this._save(); }
      if (from.firstName && u.firstName !== from.firstName) { u.firstName = from.firstName; this._save(); }
    }
    return u;
  }

  getUser(chatId) { return this.state.users[String(chatId)] || null; }
  getTargetByToken(token) { const c = this.state.tokens[token]; return c ? String(c) : null; }

  setSession(senderChatId, session) { this.state.sessions[String(senderChatId)] = session; this._save(); }
  getSession(senderChatId) { return this.state.sessions[String(senderChatId)] || null; }
  clearSession(senderChatId) { delete this.state.sessions[String(senderChatId)]; this._save(); }

  setReceiving(chatId, v) { const u = this.getUser(chatId); if (u) { u.receiving = !!v; this._save(); } }
  toggle(user, field) { user[field] = !user[field]; this._save(); return user[field]; }
  recordSent(chatId) { const u = this.getUser(chatId); if (u) { u.sent++; this._save(); } }
  recordReceived(chatId) { const u = this.getUser(chatId); if (u) { u.received++; this._save(); } }

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
    this.state.linkMap[String(chatId) + ':' + messageId] = threadId;
    this._save();
  }
  threadByLink(chatId, messageId) { return this.state.linkMap[String(chatId) + ':' + messageId] || null; }
  setThreadField(id, field, value) { const t = this.getThread(id); if (t) { t[field] = value; this._save(); } }

  // Anti-abuse: per-sender global hourly cap, per-pair hourly cap, min interval.
  rateCheck(sender, target, cfg = {}) {
    sender = String(sender); target = String(target);
    const now = Date.now();
    const g = (this.state.sendLog[sender] || []).filter(t => now - t < HOUR);
    this.state.sendLog[sender] = g;
    if (g.length >= (cfg.globalPerHour || 80)) {
      return { ok: false, reason: "You've hit the hourly message limit. Take a breather and try later." };
    }
    const pk = sender + ':' + target;
    const p = (this.state.pairLog[pk] || []).filter(t => now - t < HOUR);
    this.state.pairLog[pk] = p;
    if (p.length >= (cfg.pairPerHour || 40)) {
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
}

module.exports = Store;
