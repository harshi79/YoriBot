'use strict';
/*
 * Error classification for Telegram API failures.
 *
 * The bot has to degrade gracefully instead of dying: an ephemeral message needs
 * admin rights, a rich message needs a recent client, an edit fails after 48h.
 * Every one of those has a fallback path, so we map the wire error onto a small
 * set of intents and let the caller pick the fallback.
 *
 * `node-telegram-bot-api` v2 throws `TelegramApiError` with structured fields
 * (`errorCode`, `description`, `retryAfter`). We also accept the plain
 * `Error` shapes a mock adapter produces, so the engine stays testable.
 */

const KINDS = {
  NOT_MODIFIED: 'not_modified',   // edit was a no-op -> treat as success
  UNEDITABLE: 'uneditable',       // message too old / gone -> re-create it
  CAPABILITY: 'capability',       // feature unsupported here -> use fallback
  FORBIDDEN: 'forbidden',         // blocked / no rights / chat gone
  NOT_FOUND: 'not_found',         // target or message does not exist
  RATE_LIMIT: 'rate_limit',       // 429 -> back off
  TOO_LONG: 'too_long',           // text/utf8 over the limit -> split or trim
  BAD_REQUEST: 'bad_request',     // our payload was wrong
  UNKNOWN: 'unknown'
};

const NOT_MODIFIED = [
  'message is not modified',
  'message_is_not_modified'
];
const UNEDITABLE = [
  "message can't be edited",
  'message to edit not found',
  'message is not modifiable',
  'replied message not found',
  'message_id_invalid',
  'message identifier is not valid',
  'too old',
  'message can\u2019t be edited'
];
const CAPABILITY = [
  'method is not supported',
  'is not supported',
  'unsupported',
  'method not available',
  'unsupported method',
  'unknown method',
  'not supported on this chat',
  'ephemeral messages are not supported',
  'chat_admin_required',
  'reply markup is not supported',
  'wrong type of the web page',
  'requested action is not supported'
];
const FORBIDDEN = [
  'bot was blocked by the user',
  'user is deactivated',
  'not enough rights',
  'have no rights',
  'bot can\u2019t initiate conversation',
  "bot can't initiate conversation",
  'chat not found',
  'participant_tg_channel_invalid',
  'peer_id_invalid',
  'bot was kicked from the group chat',
  'need administrator rights',
  'forbidden'
];
const NOT_FOUND = [
  'reply_to_message_not_found',
  'message to reply not found',
  'user not found',
  'not found'
];
const TOO_LONG = [
  'message is too long',
  'too many utf-16 codepoints',
  'maximum utf-16 codepoints count exceeded',
  'field overflow'
];
const REACTION_INVALID = ['reaction_invalid', 'unsupported reaction'];

const includes = (hay, list) => list.some((n) => hay.includes(n));

/**
 * Classify anything thrown by an API call.
 * @param {unknown} err
 * @returns {{kind:string, description:string, errorCode:number|null, retryAfter:number|null, fatal:boolean}}
 */
function classifyError(err) {
  if (!err) return { kind: KINDS.UNKNOWN, description: '', errorCode: null, retryAfter: null, fatal: false };

  // An adapter (or a test mock) may pre-classify with `err.tg = { kind }`.
  const pre = err.tg && err.tg.kind;
  const description = String(err.description || err.message || err || '').toLowerCase();
  const errorCode = typeof err.errorCode === 'number' ? err.errorCode
    : (typeof err.code === 'number' ? err.code : null);
  const retryAfter = typeof err.retryAfter === 'number' ? err.retryAfter
    : (err.parameters && typeof err.parameters.retry_after === 'number' ? err.parameters.retry_after : null);

  const base = { description, errorCode, retryAfter, fatal: errorCode === 401 || errorCode === 404 };

  if (pre && Object.values(KINDS).includes(pre)) return { ...base, kind: pre };
  if (errorCode === 429) return { ...base, kind: KINDS.RATE_LIMIT };
  if (includes(description, NOT_MODIFIED)) return { ...base, kind: KINDS.NOT_MODIFIED };
  if (includes(description, REACTION_INVALID)) return { ...base, kind: KINDS.CAPABILITY };
  if (includes(description, TOO_LONG)) return { ...base, kind: KINDS.TOO_LONG };
  if (includes(description, UNEDITABLE)) return { ...base, kind: KINDS.UNEDITABLE };
  if (includes(description, FORBIDDEN)) return { ...base, kind: KINDS.FORBIDDEN };
  if (includes(description, CAPABILITY)) return { ...base, kind: KINDS.CAPABILITY };
  if (errorCode === 400 && includes(description, NOT_FOUND)) return { ...base, kind: KINDS.NOT_FOUND };
  if (errorCode === 400) return { ...base, kind: KINDS.BAD_REQUEST };
  if (errorCode && errorCode >= 500) return { ...base, kind: KINDS.UNKNOWN, fatal: false };
  return { ...base, kind: KINDS.UNKNOWN };
}

const isKind = (err, kind) => classifyError(err).kind === kind;

/** Swallow best-effort calls (reactions, typing, edits of a panel) but report them. */
async function bestEffort(promise, label) {
  try {
    return { ok: true, value: await promise };
  } catch (err) {
    const c = classifyError(err);
    if (process.env.DEBUG_BOT && label) {
      console.warn(`[best-effort:${label}] ${c.kind}: ${c.description || err}`);
    }
    return { ok: false, kind: c.kind, err };
  }
}

module.exports = { KINDS, classifyError, isKind, bestEffort };
