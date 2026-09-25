'use strict';
/*
 * Turn a raw Telegram Message into a normalized classification the engine can
 * forward anonymously. We never use forwardMessage() (that leaks the sender),
 * we re-send the media by file_id instead.
 */
function classifyMessage(msg) {
  if (msg.text && typeof msg.text === 'string' && !msg.text.startsWith('/')) {
    return { kind: 'text', text: msg.text };
  }
  if (msg.photo && msg.photo.length) {
    return { kind: 'media', type: 'photo', fileId: msg.photo[msg.photo.length - 1].file_id, caption: msg.caption || '' };
  }
  if (msg.sticker) return { kind: 'media', type: 'sticker', fileId: msg.sticker.file_id, caption: '' };
  if (msg.voice) return { kind: 'media', type: 'voice', fileId: msg.voice.file_id, caption: msg.caption || '' };
  if (msg.audio) return { kind: 'media', type: 'audio', fileId: msg.audio.file_id, caption: msg.caption || '' };
  if (msg.video) return { kind: 'media', type: 'video', fileId: msg.video.file_id, caption: msg.caption || '' };
  if (msg.video_note) return { kind: 'media', type: 'video_note', fileId: msg.video_note.file_id, caption: '' };
  if (msg.animation) return { kind: 'media', type: 'animation', fileId: msg.animation.file_id, caption: msg.caption || '' };
  if (msg.document) return { kind: 'media', type: 'document', fileId: msg.document.file_id, caption: msg.caption || '' };
  if (msg.contact) return { kind: 'media', type: 'contact', payload: msg.contact, caption: '' };
  if (msg.location) return { kind: 'media', type: 'location', payload: msg.location, caption: '' };
  return { kind: 'unsupported' };
}

function hasMedia(msg) {
  return !!(msg.photo || msg.sticker || msg.voice || msg.audio || msg.video ||
    msg.video_note || msg.animation || msg.document || msg.contact || msg.location);
}

module.exports = { classifyMessage, hasMedia };
