'use strict';
/*
 * The HTTP server. This file exists because of a deployment failure mode:
 *
 *   "Deploy aborted — the new version was not listening on any port during the
 *    180s window. Nothing is running for this service now."
 *
 * A long-polling Telegram bot opens no sockets, so every PaaS that probes a port
 * (Railway, Render, Koyeb, Zeabur, Fly, Cloud Run, Heroku…) declares the release
 * dead and rolls it back — even though the bot is perfectly healthy.
 *
 * So: we ALWAYS listen, on 0.0.0.0:$PORT, before anything else happens.
 *   GET  /            human-readable status page
 *   GET  /healthz     liveness  -> 200 as long as the process is up
 *   GET  /ready       readiness -> 200 only when the bot is actually connected
 *   GET  /metrics     JSON counters (uptime, mode, store size, caps)
 *   POST <webhook>    Telegram updates, when webhook mode is on
 *
 * The server is deliberately dependency-free (node:http) and never throws: a
 * broken route must not take the bot down with it.
 */
const http = require('http');

const HEALTH_PATHS = new Set(['/healthz', '/health', '/live', '/liveness', '/ping', '/healthcheck']);
const READY_PATHS = new Set(['/ready', '/readyz', '/readiness']);
const startedAt = Date.now();

const uptime = () => {
  const s = Math.floor((Date.now() - startedAt) / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s % 60}s`;
  return `${s}s`;
};

const json = (res, code, body) => {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store'
  });
  res.end(payload);
};

const html = (res, code, body) => {
  res.writeHead(code, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(body);
};

const text = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
};

const readBody = (req, limit = 2 * 1024 * 1024) => new Promise((resolve, reject) => {
  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > limit) { reject(new Error('payload too large')); req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', reject);
});

/**
 * @param {object} deps
 * @param {() => object} deps.status      live status snapshot (mode, token, bot name, caps)
 * @param {(update:object, req:object) => Promise<void>} [deps.onWebhook]
 * @param {string} [deps.webhookPath]
 * @param {string} [deps.secretToken]
 */
function createServer(deps = {}) {
  const stats = { requests: 0, webhookUpdates: 0, webhookRejected: 0, errors: 0 };

  // Every dependency is resolved per request, so index.js can wire the webhook
  // up *after* the server is already listening (the port must open first).
  const status = typeof deps.status === 'function' ? deps.status : () => ({});
  const hookOf = () => (typeof deps.onWebhook === 'function' ? deps.onWebhook : null);
  const pathOf = () => (typeof deps.webhookPath === 'function' ? deps.webhookPath() : (deps.webhookPath || null));
  const secretOf = () => (typeof deps.secretToken === 'function' ? deps.secretToken() : (deps.secretToken || null));

  const server = http.createServer(async (req, res) => {
    stats.requests++;
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname.replace(/\/+$/, '') || '/';

    try {
      // ---- webhook ----
      const onWebhook = hookOf();
      const webhookPath = pathOf();
      if (onWebhook && webhookPath && req.method === 'POST' && path === webhookPath) {
        const secretToken = secretOf();
        if (secretToken) {
          const got = req.headers['x-telegram-bot-api-secret-token'];
          if (got !== secretToken) {
            stats.webhookRejected++;
            return text(res, 401, 'unauthorized');
          }
        }
        const raw = await readBody(req);
        let update;
        try { update = JSON.parse(raw.toString('utf8')); }
        catch { return text(res, 400, 'bad json'); }
        // ACK fast: Telegram redelivers if we don't answer in time, and a slow
        // handler must never look like a failed delivery.
        text(res, 200, 'ok');
        stats.webhookUpdates++;
        try { await onWebhook(update, req); }
        catch (err) { stats.errors++; if (deps.verbose) console.error('[webhook handler]', err && err.message); }
        return;
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') return text(res, 405, 'method not allowed');

      // ---- liveness: the process is up. This is what the platform probes. ----
      if (HEALTH_PATHS.has(path)) {
        const s = status();
        return json(res, 200, { status: 'ok', uptime: uptime(), mode: s.mode, bot: s.botUsername || null, tokenConfigured: !!s.tokenConfigured });
      }

      // ---- readiness: we are actually talking to Telegram ----
      if (READY_PATHS.has(path)) {
        const s = status();
        const ready = !!s.connected;
        return json(res, ready ? 200 : 503, {
          status: ready ? 'ready' : 'not-ready',
          reason: ready ? undefined : (s.tokenConfigured ? 'not connected to Telegram yet' : 'BOT_TOKEN is not set'),
          uptime: uptime(), mode: s.mode, bot: s.botUsername || null
        });
      }

      if (path === '/metrics' || path === '/status.json') {
        const s = status();
        return json(res, 200, {
          uptime: uptime(), uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
          node: process.version, pid: process.pid, rssMb: Math.round(process.memoryUsage().rss / 1048576),
          http: stats, ...s
        });
      }

      if (path === '/favicon.ico') return text(res, 204, '');

      if (path === '/') return html(res, 200, statusPage(status(), stats));

      return text(res, 404, 'not found');
    } catch (err) {
      stats.errors++;
      try { text(res, 500, 'internal error'); } catch { /* headers already sent */ }
    }
  });

  server.stats = stats;
  server.uptime = uptime;
  return server;
}

function statusPage(s, stats) {
  const esc = (v) => String(v == null ? '—' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const rows = [
    ['Status', s.connected ? '🟢 connected to Telegram' : (s.tokenConfigured ? '🟡 starting…' : '🔴 BOT_TOKEN not set')],
    ['Bot', s.botUsername ? '@' + esc(s.botUsername) : '(unknown)'],
    ['Transport', esc(s.mode)],
    ['Uptime', esc(uptime())],
    ['Users', esc(s.users)],
    ['Whispers sent', esc(s.whispersSent)],
    ['Anonymous messages', esc(s.anonReceived)],
    ['Groups', esc(s.groups)],
    ['Node', esc(process.version)],
    ['Memory', esc(Math.round(process.memoryUsage().rss / 1048576) + ' MB')]
  ];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>YoriBot</title>
<style>
:root{color-scheme:dark}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b1020;color:#e8ecff;
font:16px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{width:min(560px,92vw);padding:32px;border-radius:20px;background:#141a33;border:1px solid #26305a;
box-shadow:0 24px 60px rgba(0,0,0,.45)}
h1{margin:0 0 4px;font-size:26px;letter-spacing:.2px}
p.sub{margin:0 0 24px;color:#9aa6d8}
dl{display:grid;grid-template-columns:1fr auto;gap:10px 16px;margin:0}
dt{color:#9aa6d8}dd{margin:0;text-align:right;font-weight:600}
footer{margin-top:24px;font-size:13px;color:#7c88bb}
code{background:#0b1020;padding:2px 6px;border-radius:6px}
</style></head><body><main>
<h1>🤫 YoriBot</h1>
<p class="sub">Whispers &amp; anonymous messages for Telegram — running, healthy, and listening.</p>
<dl>${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>
<footer>HTTP ${esc(stats.requests)} req · ${esc(stats.webhookUpdates)} webhook updates · <code>/healthz</code> <code>/ready</code> <code>/metrics</code></footer>
</main></body></html>`;
}

module.exports = { createServer, statusPage, uptime, HEALTH_PATHS, READY_PATHS, readBody };
