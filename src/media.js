'use strict';
/*
 * Turn a raw Telegram Message into something the engine can re-send
 * anonymously.
 *
 * Rule #1 of an anonymity bot: NEVER call forwardMessage / forwardMessages.
 * A forward carries `forward_origin` with the sender's name and id. Instead we
 * re-send the bytes by file_id (Telegram keeps the file on its servers, so this
 * is a pointer copy, not a download) and re-create non-file payloads by value.
 *
 * Kinds:
 *   text        -> { text }
 *   media       -> { type, fileId, caption, payload? }   re-sent by file_id
 *   native      -> { type, params }                      re-created by value
 *   unsupported -> { reason }
 */

const NATIVE = new Set(['poll', 'dice', 'venue', 'location', 'contact', 'checklist']);
const FILE_TYPES = ['photo', 'sticker', 'voice', 'audio', 'video', 'video_note',
  'animation', 'document', 'live_photo'];

const bestPhoto = (sizes) => (Array.isArray(sizes) && sizes.length ? sizes[sizes.length - 1].file_id : null);

/**
 * @param {object} msg a Telegram Message
 * @returns {{kind:string, type?:string, fileId?:string, caption?:string, payload?:object, params?:object, text?:string, reason?:string}}
 */
function classifyMessage(msg) {
  if (!msg) return { kind: 'unsupported', reason: 'empty' };

  // Text (commands are routed before we get here, but guard anyway).
  if (typeof msg.text === 'string' && msg.text && !msg.text.startsWith('/')) {
    return { kind: 'text', text: msg.text };
  }

  // --- file-backed media: re-send by file_id ---
  if (msg.photo && msg.photo.length) {
    return { kind: 'media', type: 'photo', fileId: bestPhoto(msg.photo), caption: msg.caption || '' };
  }
  if (msg.live_photo) {
    // sendLivePhoto wants BOTH parts: the motion file and the still frame.
    return {
      kind: 'media', type: 'live_photo', fileId: msg.live_photo.file_id, caption: msg.caption || '',
      payload: { photo: bestPhoto(msg.live_photo.photo) || msg.live_photo.file_id }
    };
  }
  if (msg.sticker) return { kind: 'media', type: 'sticker', fileId: msg.sticker.file_id, caption: '' };
  if (msg.voice) return { kind: 'media', type: 'voice', fileId: msg.voice.file_id, caption: msg.caption || '' };
  if (msg.audio) return { kind: 'media', type: 'audio', fileId: msg.audio.file_id, caption: msg.caption || '' };
  if (msg.video) return { kind: 'media', type: 'video', fileId: msg.video.file_id, caption: msg.caption || '' };
  if (msg.video_note) return { kind: 'media', type: 'video_note', fileId: msg.video_note.file_id, caption: '' };
  if (msg.animation) return { kind: 'media', type: 'animation', fileId: msg.animation.file_id, caption: msg.caption || '' };
  if (msg.document) return { kind: 'media', type: 'document', fileId: msg.document.file_id, caption: msg.caption || '' };

  // --- value payloads: re-created from scratch ---
  if (msg.contact) return { kind: 'native', type: 'contact', params: msg.contact, caption: '' };
  if (msg.location) {
    return {
      kind: 'native', type: 'location', caption: '',
      params: { latitude: msg.location.latitude, longitude: msg.location.longitude, horizontal_accuracy: msg.location.horizontal_accuracy }
    };
  }
  if (msg.venue) {
    return {
      kind: 'native', type: 'venue', caption: '',
      params: {
        latitude: msg.venue.location.latitude, longitude: msg.venue.location.longitude,
        title: msg.venue.title, address: msg.venue.address,
        foursquare_id: msg.venue.foursquare_id, foursquare_type: msg.venue.foursquare_type
      }
    };
  }
  if (msg.dice) return { kind: 'native', type: 'dice', caption: '', params: { emoji: msg.dice.emoji } };
  if (msg.poll && msg.poll.options) {
    return {
      kind: 'native', type: 'poll', caption: '',
      params: {
        question: msg.poll.question,
        options: msg.poll.options.map((o) => ({ text: o.text })),
        is_anonymous: msg.poll.is_anonymous,
        type: msg.poll.type,
        allows_multiple_answers: msg.poll.allows_multiple_answers,
        correct_option_id: msg.poll.correct_option_id,
        explanation: msg.poll.explanation
      }
    };
  }
  if (msg.checklist && msg.checklist.tasks) {
    return {
      kind: 'native', type: 'checklist', caption: '',
      params: {
        title: msg.checklist.title,
        tasks: msg.checklist.tasks.map((t, i) => ({ id: t.id != null ? t.id : i + 1, text: t.text }))
      }
    };
  }

  // --- things we deliberately do not carry ---
  if (msg.paid_media) return { kind: 'unsupported', reason: 'paid media (Telegram Stars) cannot be re-sent' };
  if (msg.game) return { kind: 'unsupported', reason: 'games cannot be re-sent' };
  if (msg.invoice || msg.successful_payment) return { kind: 'unsupported', reason: 'payments cannot be re-sent' };
  if (msg.story) return { kind: 'unsupported', reason: 'stories cannot be re-sent' };
  if (msg.new_chat_members || msg.left_chat_member || msg.new_chat_title || msg.delete_chat_photo) {
    return { kind: 'unsupported', reason: 'service message' };
  }
  if (typeof msg.text === 'string' && msg.text.startsWith('/')) {
    return { kind: 'unsupported', reason: 'command' };
  }
  return { kind: 'unsupported', reason: 'unknown content' };
}

function hasMedia(msg) {
  if (!msg) return false;
  if (FILE_TYPES.some((t) => !!msg[t])) return true;
  for (const t of NATIVE) if (msg[t]) return true;
  return false;
}

/** The chat action that matches a payload, for the "typing…" bubble. */
function chatActionFor(cls) {
  if (!cls || cls.kind === 'text') return 'typing';
  switch (cls.type) {
    case 'photo': case 'live_photo': return 'upload_photo';
    case 'video': case 'video_note': case 'animation': return 'upload_video';
    case 'voice': return 'upload_voice';
    case 'audio': return 'upload_audio';
    case 'document': return 'upload_document';
    case 'sticker': return 'choose_sticker';
    case 'location': case 'venue': return 'find_location';
    case 'contact': return 'typing';
    default: return 'typing';
  }
}

module.exports = { classifyMessage, hasMedia, chatActionFor, FILE_TYPES };
