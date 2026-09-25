'use strict';
require('dotenv').config();
const { buildBot } = require('./telegram');
const config = require('./config');

const token = config.BOT_TOKEN;
if (!token) {
  console.error('❌ BOT_TOKEN is missing. Copy .env.example to .env and add your token from @BotFather.');
  process.exit(1);
}

const { bot } = buildBot(token);

if (config.WEBHOOK_URL) {
  // ---- Webhook mode (production / serverless) ----
  const { webhookCallback } = require('node-telegram-bot-api');
  const http = require('http');
  const url = config.WEBHOOK_URL.replace(/\/$/, '');
  const path = `/bot${token}`;
  bot.api.setWebhook({ url: url + path, secret_token: config.WEBHOOK_SECRET || undefined, drop_pending_updates: true })
    .then(() => console.log('🔗 Webhook set:', url + path))
    .catch((e) => console.error('setWebhook failed:', e && e.message));

  const handler = webhookCallback(bot, { secretToken: config.WEBHOOK_SECRET, allowUnauthenticated: !config.WEBHOOK_SECRET });
  const port = config.PORT || 3000;
  http.createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === path) {
      try {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const request = new Request(req.url, {
          method: 'POST',
          body: Buffer.concat(chunks),
          headers: req.headers
        });
        const response = await handler(request);
        const body = await response.text();
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(body);
      } catch (e) {
        res.writeHead(500); res.end('error');
      }
    } else {
      res.writeHead(200); res.end('AgrrhBot');
    }
  }).listen(port, () => console.log(`🤖 AgrrhBot webhook listening on :${port}`));
} else {
  // ---- Long-poll mode (works everywhere, no public URL needed) ----
  bot.startPolling().catch((e) => console.error('polling error:', e && e.message));
  console.log('🤖 AgrrhBot is running (long-poll mode)...');
}
