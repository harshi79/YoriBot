'use strict';
/*
 * Lightweight abuse / spam filter. This is demonstration-grade: pair it with the
 * human-report system (already built in) for real moderation. Tune the list via
 * the BANNED_WORDS env var (comma separated). Avoid embedding slurs here — keep
 * the default to obvious spam/scam phrases and let admins extend it.
 */
const DEFAULT_BANNED = [
  'free money', 'click here', 'subscribe now', 'casino', 'loan approval',
  'crypto giveaway', 'dm to earn', 'telegram casino', 'investment guarantee',
  'paypal hack', 'get rich quick'
];

function loadBanned() {
  const env = (process.env.BANNED_WORDS || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return Array.from(new Set([...DEFAULT_BANNED, ...env]));
}
const BANNED = loadBanned();

function checkAbuse(text) {
  if (!text || typeof text !== 'string') return { ok: true };
  const t = text.toLowerCase();
  for (const w of BANNED) {
    if (w && t.includes(w)) return { ok: false, reason: 'banned phrase' };
  }
  // too many links (scam/spam pattern)
  const links = (t.match(/https?:\/\//g) || []).length;
  if (links > 3) return { ok: false, reason: 'too many links' };
  // repeated-character spam e.g. "ahhhhhhhhhh"
  if (/(.)\1{9,}/.test(t)) return { ok: false, reason: 'repetitive spam' };
  // near-all-caps wall (shouting)
  const letters = text.replace(/[^a-z]/gi, '');
  if (letters.length > 25 && (text.replace(/[^A-Z]/g, '').length / letters.length) > 0.85) {
    return { ok: false, reason: 'shouting' };
  }
  return { ok: true };
}

module.exports = { checkAbuse, BANNED };
