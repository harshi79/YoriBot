'use strict';
/*
 * YoriBot entry point.
 *
 * Boot order matters:
 *
 *   1. LISTEN on 0.0.0.0:$PORT.        <- before anything else, always
 *   2. Talk to Telegram (getMe, setMyCommands, profile).
 *   3. Start the update pump (long-poll or webhook).
 *
 * Step 1 is first because that is what a PaaS measures. A long-polling bot opens
 * no inbound socket at all, so platforms that probe a port abort the deploy with
 * "was not listening on any port during the 180s window" and roll back — even
 * when the bot itself is fine. Likewise a missing BOT_TOKEN used to call
 * process.exit(1), which guaranteed that failure. Now the server stays up and
 * /healthz tells you exactly what is wrong, and a watchdog starts the bot the
 * moment a token shows up.
 */
require('dotenv').config();

const crypto = require('crypto');
const config = require('./config');
const Store = require('./store');
const { buildBot } = require('./telegram');
const { createServer } = require('./server');
const whisper = require('./whisper');

process.title = 'yoribot';

const HOST = config.HOST || '0.0.0.0';
// PORT=0 is legal (kernel-assigned port), so don't fall back on falsy zero.
const PORT = Number.isFinite(Number(config.PORT)) && Number(config.PORT) >= 0 ? Number(config.PORT) : 3000;

// ---------------------------------------------------------------- live state

let store = null;
let built = null;          // { bot, adapter, cfg, richGate, bootstrap }
let botConnected = false;
let transport = config.WEBHOOK_MODE === 'longpoll' ? 'long-poll' : 'webhook';
let webhookInfo = null;
let lastTokenWarning = 0;

const readToken = () => (process.env.BOT_TOKEN || config.BOT_TOKEN || '').trim() || null;

function status() {
  const counters = store ? store.counters() : {};
  return {
    mode: transport,
    tokenConfigured: !!readToken(),
    connected: botConnected,
    polling: built && built.bot ? built.bot.isRunning() : false,
    botUsername: built && built.adapter ? built.adapter.username : config.BOT_USERNAME,
    webhook: webhookInfo,
    users: store ? store.userCount() : 0,
    groups: store ? store.groupCount() : 0,
    whispersSent: counters.whispersSent || 0,
    anonReceived: counters.anonReceived || 0,
    rich: built && built.richGate ? built.richGate.status() : null,
    version: require('../package.json').version
  };
}

// ------------------------------------------------------------- webhook setup

/**
 * Which URL should Telegram POST to?
 * Only `WEBHOOK_URL` (explicit) or a platform-provided public domain with
 * WEBHOOK_MODE=auto are ever used — guessing a webhook silently stops all
 * updates if the guess is wrong, so the default stays long-polling.
 */
function resolveWebhook(token) {
  if (config.WEBHOOK_MODE === 'longpoll') return null;
  const base = config.WEBHOOK_URL || (config.WEBHOOK_MODE === 'auto' ? config.PLATFORM_PUBLIC_URL : null);
  if (!base) return null;

  const clean = String(base).replace(/\/+$/, '');
  if (!/^https:\/\//i.test(clean)) {
    console.warn('[webhook] refusing non-HTTPS base URL:', clean);
    return null;
  }
  // An unguessable path: webhook payloads are NOT signed by Telegram, so the
  // secret header is the only authentication and the URL should not be trivial.
  const tail = config.WEBHOOK_PATH || `/telegram/${crypto.createHash('sha256').update(token).digest('hex').slice(0, 16)}`;
  const secret = config.WEBHOOK_SECRET ||
    crypto.createHash('sha256').update(`${token}:yoribot-webhook`).digest('hex').slice(0, 40);
  return { url: clean + (tail.startsWith('/') ? tail : '/' + tail), path: tail.startsWith('/') ? tail : '/' + tail, secret };
}

// ------------------------------------------------------------------- boot

async function startBot(token) {
  built = buildBot(token, {
    store,
    transport,
    uptime: () => (server ? server.uptime() : 'n/a'),
    adminIds: config.ADMIN_IDS,
    dataFile: config.DATA_FILE
  });
  const { bot, adapter, bootstrap } = built;

  const me = await bootstrap();
  if (!me.ok) {
    console.error('[boot] getMe failed:', me.error);
    console.error('[boot] Check BOT_TOKEN. The HTTP server stays up so the deploy is not rolled back.');
    botConnected = false;
    return false;
  }
  console.log(`[boot] connected as @${adapter.username}`);

  const wh = resolveWebhook(token);
  if (wh) {
    transport = 'webhook';
    webhookInfo = wh.url;
    activeWebhook = wh; // the HTTP server can now accept Telegram POSTs
    try {
      await bot.api.setWebhook({
        url: wh.url,
        secret_token: wh.secret,
        max_connections: 40,
        allowed_updates: built.UPDATES_WE_HANDLE,
        drop_pending_updates: /^(1|true|yes)$/i.test(process.env.WEBHOOK_DROP_PENDING || '')
      });
      botConnected = true;
      console.log(`[webhook] listening for updates at ${wh.url}`);
      return true;
    } catch (err) {
      console.error('[webhook] setWebhook failed:', err && err.message);
      console.error('[webhook] falling back to long polling.');
      webhookInfo = null;
      activeWebhook = null;
      transport = 'long-poll (webhook failed)';
    }
  }

  // ---- long polling ----
  transport = 'long-poll';
  try {
    // A webhook left over from a previous deploy makes getUpdates fail with 409
    // "can't use getUpdates method while webhook is active" — forever, silently.
    await bot.api.deleteWebhook({ drop_pending_updates: false });
  } catch (err) {
    console.warn('[poll] deleteWebhook failed (continuing):', err && err.message);
  }

  bot.startPolling(undefined, {
    timeout: config.POLL_TIMEOUT,
    allowedUpdates: built.UPDATES_WE_HANDLE,
    retry: true,
    maxBackoffMs: 60000,
    onError: (err) => console.warn('[poll] transient error, backing off:', err && err.message)
  }).then(() => {
    if (botConnected) console.log('[poll] loop ended');
    botConnected = false;
  }).catch((err) => {
    botConnected = false;
    console.error('[poll] fatal:', err && err.message);
  });

  botConnected = true;
  console.log('[poll] long-polling Telegram for updates…');
  return true;
}

// ------------------------------------------------------------------- server

/*
 * The webhook path and secret are resolved lazily: the port has to be open
 * BEFORE we call setWebhook, otherwise Telegram can deliver an update to a
 * server that isn't listening yet.
 */
let activeWebhook = null;

const server = createServer({
  status,
  webhookPath: () => (activeWebhook ? activeWebhook.path : null),
  secretToken: () => (activeWebhook ? activeWebhook.secret : null),
  onWebhook: (update) => (built && built.bot ? built.bot.handleUpdate(update) : Promise.resolve()),
  verbose: config.LOG_LEVEL === 'debug'
});

function listen() {
  return new Promise((resolve, reject) => {
    server.once('error', (err) => {
      if (err && err.code === 'EADDRINUSE') {
        console.error(`[http] port ${PORT} is already in use — set PORT to a free port.`);
      }
      reject(err);
    });
    server.listen(PORT, HOST, () => {
      const addr = server.address();
      console.log(`[http] listening on ${HOST}:${addr && addr.port} (health: /healthz, status: /)`);
      resolve(addr);
    });
  });
}

// ------------------------------------------------------------------ sweepers

function startSweepers() {
  const every = Math.max(5000, config.SWEEP_INTERVAL_MS || 30000);
  const t = setInterval(async () => {
    if (!built || !botConnected) return;
    try {
      const r = await whisper.sweep(built.adapter, store, Date.now());
      const pruned = store.prune();
      if ((r.expired || r.deleted || pruned) && config.LOG_LEVEL === 'debug') {
        console.log(`[sweep] expired=${r.expired} auto-burned=${r.deleted} pruned=${pruned}`);
      }
    } catch (err) {
      console.warn('[sweep] failed:', err && err.message);
    }
  }, every);
  if (typeof t.unref === 'function') t.unref();

  // Token watchdog: if we booted without a token, keep trying (and say so).
  const w = setInterval(async () => {
    if (built) return;
    const token = readToken();
    if (token) {
      console.log('[watchdog] BOT_TOKEN appeared — starting the bot.');
      await startBot(token);
      return;
    }
    const now = Date.now();
    if (now - lastTokenWarning > 5 * 60 * 1000) {
      lastTokenWarning = now;
      console.warn('[watchdog] still no BOT_TOKEN. The HTTP server stays healthy; the bot cannot connect. ' +
        'Set BOT_TOKEN (from @BotFather) in your platform\'s environment variables and redeploy.');
    }
  }, 30000);
  if (typeof w.unref === 'function') w.unref();
}

// ----------------------------------------------------------------- shutdown

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal} received — closing down cleanly.`);
  const timer = setTimeout(() => { console.warn('[shutdown] timed out, exiting.'); process.exit(0); }, 9000);
  if (typeof timer.unref === 'function') timer.unref();
  try { if (built && built.bot) built.bot.stop(); } catch { /* ignore */ }
  try { if (store) store.close(); } catch { /* ignore */ }
  await new Promise((resolve) => server.close(() => resolve()));
  clearTimeout(timer);
  console.log('[shutdown] bye.');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
// Never let a stray rejection kill the listener: the deploy probe would fail.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason && reason.message ? reason.message : reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err && err.stack ? err.stack : err);
});

// --------------------------------------------------------------------- main

(async function main() {
  console.log(`[boot] YoriBot v${require('../package.json').version} on Node ${process.version}`);
  store = new Store(config.DATA_FILE);

  // 1. LISTEN FIRST — this is what the platform waits for.
  try {
    await listen();
  } catch (err) {
    console.error('[boot] could not bind the HTTP port:', err && err.message);
    process.exit(1); // nothing else can work without the port
  }

  startSweepers();

  // 2/3. Then Telegram.
  const token = readToken();
  if (!token) {
    lastTokenWarning = Date.now();
    console.warn('❌ BOT_TOKEN is missing.');
    console.warn('   Copy .env.example to .env (locally) or set BOT_TOKEN in your host\'s env vars.');
    console.warn('   Get a token from @BotFather. The HTTP server stays up meanwhile — /healthz is green, /ready is not.');
    return;
  }
  await startBot(token);
})();
