'use strict';
/*
 * Env-based configuration.
 *
 * Everything here is optional except BOT_TOKEN, and even that must not take the
 * process down: a PaaS that deploys this repo probes a TCP port for up to three
 * minutes and aborts the release if nothing is listening. So config never
 * throws and never calls process.exit — index.js decides what to do.
 */

const num = (raw, fallback) => {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
};

const bool = (raw, fallback) => {
  if (raw === undefined || raw === null || raw === '') return fallback;
  return /^(1|true|yes|y|on)$/i.test(String(raw).trim());
};

const choice = (raw, fallback, allowed) => {
  const v = String(raw || '').trim().toLowerCase();
  return allowed.includes(v) ? v : fallback;
};

const csv = (raw) => String(raw || '').split(',').map((s) => s.trim()).filter(Boolean);

/**
 * Public URL of this container, as published by the common PaaS providers.
 * Used only to *suggest* a webhook URL when WEBHOOK_MODE=auto — we never guess
 * a webhook on our own, because pointing Telegram at a dead URL silently stops
 * every update.
 */
const PLATFORM_URL_VARS = [
  'PUBLIC_URL',
  'APP_URL',
  'SERVICE_URL',
  'RAILWAY_PUBLIC_URL',
  'RAILWAY_PUBLIC_DOMAIN',
  'RENDER_EXTERNAL_URL',
  'KOYEB_PUBLIC_DOMAIN',
  'ZEABUR_SERVICE_DOMAIN',
  'FLY_APP_NAME',
  'VERCEL_URL'
];

function platformPublicUrl() {
  for (const key of PLATFORM_URL_VARS) {
    const raw = process.env[key];
    if (!raw) continue;
    const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    try {
      const u = new URL(withScheme);
      if (!u.hostname.includes('.')) continue; // not a real domain
      return u.origin;
    } catch { /* ignore malformed value */ }
  }
  return null;
}

function load() {
  const env = process.env;
  const webhookMode = choice(env.WEBHOOK_MODE, env.WEBHOOK_URL ? 'force' : 'longpoll',
    ['longpoll', 'auto', 'force', 'off']);

  const cfg = {
    // --- identity ---
    BOT_TOKEN: (env.BOT_TOKEN || '').trim() || null,
    BOT_USERNAME: (env.BOT_USERNAME || '').trim() || null,
    // null means "not set": we never rename someone else's bot behind their back.
    BOT_NAME: (env.BOT_NAME || '').trim() || null,
    BOT_DESCRIPTION: (env.BOT_DESCRIPTION || '').trim() ||
      '🤫 Whisper anything to anyone — invisible in groups, anonymous in DMs. Plus a two-way anonymous inbox with your own secret link.',
    BOT_SHORT_DESCRIPTION: (env.BOT_SHORT_DESCRIPTION || '').trim() ||
      'Secret whispers & anonymous messages.',
    SET_PROFILE: bool(env.SET_PROFILE, true),

    // --- channels & admins ---
    CHANNEL_ID: (env.CHANNEL_ID || '').trim() || null,
    ADMIN_IDS: csv(env.ADMIN_ID || env.ADMIN_IDS).map((s) => s.replace(/^@/, '')),
    BANNED_WORDS: env.BANNED_WORDS,

    // --- transport ---
    HOST: (env.HOST || '').trim() || '0.0.0.0',
    PORT: num(env.PORT, 3000),
    WEBHOOK_URL: (env.WEBHOOK_URL || '').trim() || null,
    WEBHOOK_PATH: (env.WEBHOOK_PATH || '').trim() || null, // default: /telegram/<token-tail>
    WEBHOOK_SECRET: (env.WEBHOOK_SECRET || '').trim() || null,
    WEBHOOK_MODE: webhookMode === 'off' ? 'longpoll' : webhookMode,
    PLATFORM_PUBLIC_URL: platformPublicUrl(),
    POLL_TIMEOUT: num(env.POLL_TIMEOUT, 30),

    // --- anti-abuse ---
    GLOBAL_PER_HOUR: num(env.GLOBAL_PER_HOUR, 80),
    PAIR_PER_HOUR: num(env.PAIR_PER_HOUR, 40),
    WHISPER_PER_HOUR: num(env.WHISPER_PER_HOUR, 40),
    MIN_INTERVAL_MS: num(env.MIN_INTERVAL_MS, 1200),
    MAX_WHISPER_LENGTH: num(env.MAX_WHISPER_LENGTH, 3500),
    MAX_WHISPER_TARGETS: num(env.MAX_WHISPER_TARGETS, 5),

    // --- whisper behaviour ---
    WHISPER_TTL_MS: num(env.WHISPER_TTL_MS, 7 * 24 * 3600 * 1000), // card lifetime
    SWEEP_INTERVAL_MS: num(env.SWEEP_INTERVAL_MS, 30 * 1000),      // expiry sweeper

    // --- rendering ---
    RICH_MESSAGES: choice(env.RICH_MESSAGES, 'off', ['off', 'auto', 'on']),
    TYPING_INDICATORS: bool(env.TYPING_INDICATORS, true),
    ALLOW_GUEST_MODE: bool(env.ALLOW_GUEST_MODE, true),

    // --- storage ---
    DATA_FILE: (env.WHISPER_DATA || '').trim() || null,
    SAVE_DEBOUNCE_MS: num(env.SAVE_DEBOUNCE_MS, 400),

    // --- ops ---
    LOG_LEVEL: choice(env.LOG_LEVEL, 'info', ['silent', 'error', 'warn', 'info', 'debug']),
    NODE_ENV: env.NODE_ENV || 'development'
  };

  cfg.ADMIN_ID = cfg.ADMIN_IDS[0] || null;
  return cfg;
}

const config = load();

/** Human-readable summary for the health endpoint / boot log (no secrets). */
function describe(c = config) {
  return {
    bot: c.BOT_USERNAME || '(auto-detect)',
    tokenConfigured: !!c.BOT_TOKEN,
    transport: c.WEBHOOK_MODE,
    host: c.HOST,
    port: c.PORT,
    webhookUrl: c.WEBHOOK_URL,
    channel: c.CHANNEL_ID,
    admins: c.ADMIN_IDS.length,
    richMessages: c.RICH_MESSAGES,
    dataFile: c.DATA_FILE || '(default ./data/whisper.json)'
  };
}

config.describe = describe;
config.load = load;

module.exports = config;
