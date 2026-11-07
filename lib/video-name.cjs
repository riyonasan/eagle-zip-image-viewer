'use strict';
const path = require('node:path');
const { createHash } = require('node:crypto');
const { VIDEO_EXTENSIONS } = require('./archive.cjs');

function videoFilename(original, ext, directory) {
  if (!VIDEO_EXTENSIONS.includes(ext)) throw new Error('非対応の動画拡張子です。');
  const base = path.posix.basename(String(original).replace(/\\/g, '/'));
  const suffix = path.posix.extname(base);
  const extension = suffix.toLowerCase() === `.${ext}` ? suffix : `.${ext}`;
  let stem = (suffix ? base.slice(0, -suffix.length) : base)
    .replace(/[<>:"/\\|?*\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, '_');
  if (!stem) stem = 'video';
  if (/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)$/i.test(stem.split('.')[0].replace(/[ .]+$/g, ''))) stem = `_${stem}`;
  // Keep a conservative full Windows path and a portable component byte limit.
  // Each extraction has its own unique directory, so equal names never collide.
  const limit = Math.min(240, 240 - directory.length - 1);
  if (limit < 24) throw new Error('動画の一時保存先のパスが長すぎます。');
  const fits = name => name.length <= limit && Buffer.byteLength(name, 'utf8') <= 240;
  if (fits(stem + extension)) return stem + extension;
  const tail = `~${createHash('sha256').update(base).digest('hex').slice(0, 8)}${extension}`;
  const characters = Array.from(stem);
  while (characters.length && !fits(characters.join('') + tail)) characters.pop();
  return characters.join('') + tail;
}

module.exports = { videoFilename };
