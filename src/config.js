'use strict';
module.exports = {
  BOT_TOKEN: process.env.BOT_TOKEN,
  BOT_USERNAME: process.env.BOT_USERNAME,
  CHANNEL_ID: process.env.CHANNEL_ID,
  ADMIN_ID: process.env.ADMIN_ID,
  WEBHOOK_URL: process.env.WEBHOOK_URL,
  WEBHOOK_SECRET: process.env.WEBHOOK_SECRET,
  PORT: process.env.PORT ? Number(process.env.PORT) : 3000,
  GLOBAL_PER_HOUR: process.env.GLOBAL_PER_HOUR ? Number(process.env.GLOBAL_PER_HOUR) : 80,
  PAIR_PER_HOUR: process.env.PAIR_PER_HOUR ? Number(process.env.PAIR_PER_HOUR) : 40,
  MIN_INTERVAL_MS: process.env.MIN_INTERVAL_MS ? Number(process.env.MIN_INTERVAL_MS) : 1200,
  DATA_FILE: process.env.WHISPER_DATA
};
