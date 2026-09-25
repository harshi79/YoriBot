'use strict';
/*
 * Message reactions — the FREE tier only.
 *
 * Two hard constraints from the Bot API (see `setMessageReaction` /
 * `ReactionTypeEmoji`):
 *   1. `emoji` must be one of the ~72 reactions Telegram whitelists. Anything
 *      else is rejected with `BAD_REQUEST: REACTION_INVALID`. Emojis that look
 *      right in a string literal (✅, 💬, 🤫, 📨, 🚩) are NOT on that list, which
 *      is why a "nice" reaction silently never appears.
 *   2. As non-premium users, bots may set exactly ONE reaction per message, and
 *      paid reactions are forbidden outright.
 *
 * So: pick from this list, or don't react at all.
 */

/** The complete whitelisted free-reaction set (Bot API `ReactionTypeEmoji`). */
const FREE_EMOJI = [
  '❤', '👍', '👎', '🔥', '🥰', '👏', '😁', '🤔', '🤯', '😱', '🤬', '😢',
  '🎉', '🤩', '🤮', '💩', '🙏', '👌', '🕊', '🤡', '🥱', '🥴', '😍', '🐳',
  '❤‍🔥', '🌚', '🌭', '💯', '🤣', '⚡', '🍌', '🏆', '💔', '🤨', '😐', '🍓',
  '🍾', '💋', '🖕', '😈', '😴', '😭', '🤓', '👻', '👨‍💻', '👀', '🎃', '🙈',
  '😇', '😨', '🤝', '✍', '🤗', '🫡', '🎅', '🎄', '☃', '💅', '🤪', '🗿',
  '🆒', '💘', '🙉', '🦄', '😘', '💊', '🙊', '😎', '👾', '🤷‍♂', '🤷', '🤷‍♀', '😡'
];
const FREE_SET = new Set(FREE_EMOJI);

/**
 * Semantic signals used across the bot. Every value is on the whitelist —
 * that is the whole point of this table.
 */
const SIGNAL = {
  sent: '👍',        // your anonymous message went out
  delivered: '👀',   // someone is looking at it
  whisper: '🙈',     // a whisper was delivered
  burned: '🔥',      // self-destructed
  reply: '🤝',       // threaded reply
  opened: '👀',      // whisper opened by its recipient
  peeked: '🤨',      // you tried to open someone else's whisper
  blocked: '👎',     // sender blocked
  reported: '😡',    // reported to the admin
  idea: '🤔',        // stuck for words
  welcome: '🤗',     // hello
  wall: '🏆',        // posted to the public wall
  paused: '😴',      // inbox paused
  resumed: '⚡',     // inbox live again
  group: '👻'        // anonymous group question posted
};

/** Random "someone saw this" flavour — again, all whitelisted. */
const FLAVOUR = ['👀', '🙈', '👻', '🌚', '💯', '🔥', '🥰', '🤩', '😎', '🗿'];

const isValid = (emoji) => FREE_SET.has(emoji);

/** Coerce anything to a valid free reaction, so the API call can't be rejected. */
function safeReaction(emoji) {
  return isValid(emoji) ? emoji : SIGNAL.delivered;
}

/** `{ type: 'emoji', emoji }[]` — the only shape a non-premium bot may send. */
const reactionOf = (emoji) => [{ type: 'emoji', emoji: safeReaction(emoji) }];

module.exports = { FREE_EMOJI, FREE_SET, SIGNAL, FLAVOUR, isValid, safeReaction, reactionOf };
