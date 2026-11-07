'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const yauzl = require('yauzl');
const iconv = require('iconv-lite');
const { imageSize } = require('image-size');
const { pipeline } = require('node:stream/promises');
const { isTransient } = require('./retry.cjs');

const MiB = 1024 * 1024;
const LIMITS = Object.freeze({ archiveBytes: 4 * 1024 * MiB, entries: 20000,
  pageBytes: 64 * MiB, totalBytes: 8 * 1024 * MiB, pixels: 60_000_000,
  dimension: 32768, metadataBytes: 8 * MiB, nameLength: 4096, timeoutMs: 30000,
  videoBytes: 2 * 1024 * MiB, videoTimeoutMs: 120000 });
const MIME = { jpg: 'image/jpeg', png: 'image/png', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp' };
const VIDEO_EXTENSIONS = Object.freeze(['mp4', 'm4v', 'mov', 'avi', 'mkv', 'webm']);
const collator = new Intl.Collator('ja', { numeric: true, sensitivity: 'base' });

function fail(code, message) { return Object.assign(new Error(message), { code }); }
function localPath(value) {
  if (typeof value !== 'string' || !value || value.includes('\0')) throw fail('PATH', 'ZIPの場所が指定されていません。');
  if (/^file:/i.test(value)) value = fileURLToPath(value);
  if (!path.isAbsolute(value)) throw fail('PATH', 'ローカルのZIPファイルを選んでください。');
  return value;
}

// Incremental ZIP CRC-32. Also used to authenticate Unicode filename extra fields.
const crcTable = Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = (n >>> 1) ^ ((n & 1) ? 0xedb88320 : 0);
  return n >>> 0;
});
function crc32(bytes, previous = 0) {
  let crc = previous ^ -1;
  for (const b of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ b) & 255];
  return (crc ^ -1) >>> 0;
}

function filename(entry, encoding) {
  const raw = entry.fileName;
  const utf8 = () => new TextDecoder('utf-8', { fatal: true }).decode(raw);
  if (entry.generalPurposeBitFlag & 0x800) return utf8();
  const unicode = entry.extraFields.find(f => f.id === 0x7075 && f.data.length >= 5 &&
    f.data[0] === 1 && f.data.readUInt32LE(1) === crc32(raw));
  if (unicode) return new TextDecoder('utf-8', { fatal: true }).decode(unicode.data.subarray(5));
  if (encoding === 'cp437') return iconv.decode(raw, 'cp437');
  if (encoding === 'shift_jis') return iconv.decode(raw, 'shift_jis');
  try { return utf8(); } catch { return iconv.decode(raw, 'shift_jis'); }
}

async function openArchive(source, options = {}) {
  const limits = { ...LIMITS, ...options.limits };
  const sourcePath = localPath(source);
  const stat = await fs.promises.stat(sourcePath);
  if (!stat.isFile()) throw fail('PATH', '通常のZIPファイルではありません。');
  if (stat.size > limits.archiveBytes) throw fail('LIMIT', 'ZIPが容量上限（4 GiB）を超えています。');
  let zip;
  try {
    zip = await yauzl.openPromise(sourcePath, { lazyEntries: true, autoClose: false,
      decodeStrings: false, validateEntrySizes: true });
  } catch (error) { if (isTransient(error)) throw error; throw fail('ZIP', 'ZIPを開けません。破損したZIPや分割ZIPは非対応です。'); }
  const pages = [];
  let fatalError = null;
  let closed = false;
  let active = null;
  let reading = false;
  zip.on('error', error => { fatalError = error; });
  function close() {
    if (closed) return;
    closed = true;
    active?.destroy(fail('CLOSED', 'ZIPを閉じました。'));
    zip.close();
  }
  try {
    if (zip.fileSize > limits.archiveBytes) throw fail('LIMIT', 'ZIPが容量上限（4 GiB）を超えています。');
    if (zip.entryCount > limits.entries) throw fail('LIMIT', 'ZIP内の項目数が上限（20,000件）を超えています。');
    await new Promise((resolve, reject) => {
      let count = 0, total = 0, metadataBytes = 0;
      const timer = setTimeout(() => finish(fail('TIMEOUT', 'ZIPの一覧読み込みが時間切れになりました。')), limits.timeoutMs);
      function finish(error) {
        clearTimeout(timer);
        zip.removeListener('entry', onEntry);
        zip.removeListener('end', onEnd);
        zip.removeListener('error', onError);
        if (error) { close(); reject(error); } else resolve();
      }
      const onError = error => finish(isTransient(error) ? error : fail('ZIP', 'ZIPの一覧を読めません。破損や非対応の暗号化方式を確認してください。'));
      const onEnd = () => finish();
      function onEntry(entry) {
        try {
          if (++count > limits.entries) throw fail('LIMIT', 'ZIP内の項目数が多すぎます。');
          metadataBytes += 46 + entry.fileNameLength + entry.extraFieldLength + entry.fileCommentLength;
          if (metadataBytes > limits.metadataBytes) throw fail('LIMIT', 'ZIPの一覧情報が上限（8 MiB）を超えています。');
          if (entry.fileNameLength > limits.nameLength) throw fail('LIMIT', 'ZIP内のファイル名が長すぎます（上限4,096）。');
          total += entry.uncompressedSize;
          if (!Number.isSafeInteger(total) || total > limits.totalBytes) throw fail('LIMIT', 'ZIPの展開後合計が上限（8 GiB）を超えています。');
          const name = filename(entry, options.encoding || 'auto').replace(/\\/g, '/');
          if (name.length > limits.nameLength) throw fail('LIMIT', 'ZIP内のファイル名が長すぎます（上限4,096）。');
          if (yauzl.validateFileName(name) || /[\x00-\x1f]/.test(name)) throw fail('ZIP', 'ZIP内に不正なファイル名があります。');
          if (((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000) throw fail('ZIP', 'シンボリックリンクを含むZIPは非対応です。');
          const parts = name.split('/');
          const ext = path.posix.extname(name).slice(1).toLowerCase();
          const kind = VIDEO_EXTENSIONS.includes(ext) ? 'video' : /^(jpe?g|png|gif|bmp|webp)$/.test(ext) ? 'image' : null;
          if (!name.endsWith('/') && !parts.some(p => p.startsWith('.') || p === '__MACOSX') && kind) {
            if (entry.generalPurposeBitFlag & 1) throw fail('ENCRYPTED', 'パスワード付きZIPは非対応です。');
            if (![0, 8].includes(entry.compressionMethod)) throw fail('COMPRESSION', 'このZIPの圧縮方式は非対応です（Store / Deflateのみ）。');
            const cap = kind === 'video' ? limits.videoBytes : limits.pageBytes;
            if (entry.uncompressedSize > cap || entry.compressedSize > cap) throw fail('LIMIT', kind === 'video' ? '1本の動画が上限（2 GiB）を超えています。' : '1枚の画像が上限（64 MiB）を超えています。');
            // Retain only fields used by openReadStream/readLocalFileHeader and CRC.
            // The original Entry's name/extra/comment Buffers can be up to 192 KiB.
            const readEntry = Object.assign(new yauzl.Entry(), {
              generalPurposeBitFlag: entry.generalPurposeBitFlag,
              compressionMethod: entry.compressionMethod,
              compressedSize: entry.compressedSize,
              uncompressedSize: entry.uncompressedSize,
              relativeOffsetOfLocalHeader: entry.relativeOffsetOfLocalHeader,
              crc32: entry.crc32
            });
            pages.push({ name, kind, ext, entry: readEntry, order: count });
          }
          zip.readEntry();
        } catch (error) { finish(error.code ? error : fail('ZIP', 'ZIPのファイル名または項目が壊れています。')); }
      }
      zip.on('entry', onEntry).once('end', onEnd).once('error', onError);
      zip.readEntry();
    });
    if (!pages.length) throw fail('EMPTY', '対応する画像・動画がありません（JPEG / PNG / GIF / BMP / WebP、MP4 / M4V / MOV / AVI / MKV / WebM）。');
    pages.sort((a, b) => collator.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : a.order - b.order));
  } catch (error) { close(); throw error; }

  async function readPage(index) {
    if (closed || fatalError) throw fail('CLOSED', 'ZIPを読み直してください。');
    if (!Number.isInteger(index) || !pages[index]) throw fail('PAGE', 'ページ番号が範囲外です。');
    if (pages[index].kind !== 'image') throw fail('PAGE', '動画は画像として読み込めません。');
    if (reading) throw fail('BUSY', '前の画像を読み込み中です。');
    reading = true;
    const entry = pages[index].entry;
    let stream;
    try {
      stream = await zip.openReadStreamPromise(entry);
      if (closed) { stream.destroy(); throw fail('CLOSED', 'ZIPを閉じました。'); }
      active = stream;
      const timer = setTimeout(() => stream.destroy(fail('TIMEOUT', '画像の読み込みが時間切れになりました。')), limits.timeoutMs);
      let bytes;
      try {
        const chunks = []; let size = 0, crc = 0;
        for await (const chunk of stream) {
          size += chunk.length;
          if (size > limits.pageBytes || size > entry.uncompressedSize) throw fail('LIMIT', '画像の展開サイズが上限または申告サイズを超えています。');
          crc = crc32(chunk, crc);
          chunks.push(chunk);
        }
        if (size !== entry.uncompressedSize || crc !== entry.crc32) throw fail('CRC', '画像データが壊れています（サイズまたはCRC不一致）。');
        bytes = Buffer.concat(chunks, size);
      } finally { clearTimeout(timer); stream.destroy(); active = null; }
      let info;
      try { info = imageSize(bytes); } catch { throw fail('IMAGE', '画像の形式が不正、または画像が壊れています。'); }
      if (!MIME[info.type]) throw fail('IMAGE', 'この画像形式は表示できません。');
      if (!(info.width > 0 && info.height > 0) || info.width > limits.dimension || info.height > limits.dimension || info.width * info.height > limits.pixels) {
        throw fail('LIMIT', '画像の解像度が上限（6,000万画素・各辺32,768）を超えています。');
      }
      return { bytes, mime: MIME[info.type], width: info.width, height: info.height, name: pages[index].name };
    } catch (error) {
      if (error.code && !/^(Z_|ERR_)/.test(error.code)) throw error;
      throw fail('ZIP', 'ZIP内の画像を読み出せません。ファイルの破損を確認してください。');
    } finally { reading = false; }
  }
  async function writeVideo(index, destination, { signal } = {}) {
    if (closed || fatalError) throw fail('CLOSED', 'ZIPを読み直してください。');
    const page = pages[index];
    if (!Number.isInteger(index) || !page || page.kind !== 'video') throw fail('PAGE', '動画を選んでください。');
    if (reading) throw fail('BUSY', '前のファイルを読み込み中です。');
    signal?.throwIfAborted();
    reading = true;
    let stream, timer;
    try {
      stream = await zip.openReadStreamPromise(page.entry);
      if (closed) throw fail('CLOSED', 'ZIPを閉じました。');
      active = stream;
      timer = setTimeout(() => stream.destroy(fail('TIMEOUT', '動画の展開が時間切れになりました。')), limits.videoTimeoutMs);
      // Destination is a safe basename in a fresh private temp directory, never
      // an archive directory path. wx forbids overwriting an existing file/link.
      await pipeline(stream, async function* (source) {
        let size = 0, crc = 0;
        for await (const chunk of source) {
          size += chunk.length;
          if (size > limits.videoBytes || size > page.entry.uncompressedSize) throw fail('LIMIT', '動画の展開サイズが上限または申告サイズを超えています。');
          crc = crc32(chunk, crc);
          yield chunk;
        }
        if (size !== page.entry.uncompressedSize || crc !== page.entry.crc32) throw fail('CRC', '動画データが壊れています（サイズまたはCRC不一致）。');
      }, fs.createWriteStream(destination, { flags: 'wx', mode: 0o600 }), { signal });
    } finally {
      clearTimeout(timer); stream?.destroy(); active = null; reading = false;
    }
  }
  return { pages: pages.map(({ name, kind, ext, entry }) => ({ name, kind, ext, size: entry.uncompressedSize })), readPage, writeVideo, close };
}

module.exports = { openArchive, LIMITS, localPath, crc32, VIDEO_EXTENSIONS };
