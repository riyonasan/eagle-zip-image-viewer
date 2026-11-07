'use strict';
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { imageSize } = require('image-size');
const { VIDEO_EXTENSIONS } = require('./archive.cjs');
const { acquireVideoLock } = require('./video-lock.cjs');
const { videoFilename } = require('./video-name.cjs');
const { retry } = require('./retry.cjs');

const CACHE_BYTES = 8 * 1024 ** 3;
const CACHE_ENTRIES = 128;
const FORMATS = 'mov,avi,matroska,webm';
const ROOT_NAME = 'eagle-zip-image-viewer-videos';

function run(binary, args, { signal, maxBuffer = 2 * 1024 ** 2 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(binary, args, { windowsHide: true, timeout: 20000, maxBuffer, signal, encoding: 'buffer' }, (error, stdout) => {
      if (error) reject(Object.assign(new Error(signal?.aborted ? '動画の準備を中止しました。' : '動画サムネイルを生成できません。非対応形式・破損・処理時間の上限を確認してください。'), { code: error.code }));
      else resolve(stdout);
    });
  });
}

async function ffmpegPaths({ extraModule, host } = {}) {
  // Only Eagle's documented dependency handoff. No PATH search, guessed
  // installation directories, app internals or user-specific absolute paths.
  let paths;
  if (extraModule?.ffmpeg?.isInstalled === true) paths = extraModule.ffmpeg.paths;
  else if (host?.extraModule?.ffmpeg?.getPaths) {
    let timer;
    try { paths = await Promise.race([host.extraModule.ffmpeg.getPaths(), new Promise(resolve => { timer = setTimeout(() => resolve(null), 2000); })]); }
    catch { /* Fall through to the dependency guidance below. */ }
    finally { clearTimeout(timer); }
  }
  for (const key of ['ffmpeg', 'ffprobe']) {
    const value = paths?.[key];
    if (typeof value !== 'string' || !path.isAbsolute(value) || /^[/\\]{2}/.test(value) || !(await fs.stat(value).catch(() => null))?.isFile()) {
      throw new Error('サムネイルにはEagleのFFmpeg依存プラグインが必要です。Eagleで導入・有効化後、ZIPを開き直してください。外部プレイヤーでは開けます。');
    }
  }
  return paths;
}

function frameTime(duration) { return Number.isFinite(duration) && duration <= 1 ? 0 : 1; }

async function validateVideoHeader(file, ext) {
  const handle = await fs.open(file, 'r');
  try {
    const bytes = Buffer.alloc(12), { bytesRead } = await handle.read(bytes, 0, 12, 0);
    const atom = bytes.toString('ascii', 4, 8);
    const valid = bytesRead === 12 && (
      (['mp4', 'm4v'].includes(ext) && atom === 'ftyp') ||
      (ext === 'mov' && ['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip'].includes(atom)) ||
      (ext === 'avi' && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'AVI ') ||
      (['mkv', 'webm'].includes(ext) && bytes.readUInt32BE(0) === 0x1a45dfa3)
    );
    if (!valid) throw new Error('動画の拡張子と内容が一致しない、または動画が壊れています。外部アプリには渡しません。');
  } finally { await handle.close(); }
}

async function createPoster(file, options = {}) {
  const binaries = await ffmpegPaths(options), execute = options.run || run;
  const common = ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-format_whitelist', FORMATS];
  const data = await execute(binaries.ffprobe, [...common, '-select_streams', 'v:0', '-show_entries', 'stream=width,height,duration:format=duration', '-of', 'json', file], { signal: options.signal, maxBuffer: 65536 });
  let info;
  try { info = JSON.parse(data.toString('utf8')); } catch { throw new Error('動画の情報を読み取れません。'); }
  const stream = info.streams?.[0], width = Number(stream?.width), height = Number(stream?.height);
  if (!(width > 0 && height > 0) || width > 32768 || height > 32768 || width * height > 60_000_000) throw new Error('動画の解像度が非対応、または上限を超えています。');
  const duration = Number(stream?.duration ?? info.format?.duration);
  let at = frameTime(duration);
  async function frame(time) {
    return execute(binaries.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-protocol_whitelist', 'file,pipe', '-format_whitelist', FORMATS, '-threads', '1', '-i', file, '-ss', String(time), '-map', '0:v:0', '-frames:v', '1', '-an', '-sn', '-dn', '-vf', 'scale=w=800:h=800:force_original_aspect_ratio=decrease', '-threads', '1', '-c:v', 'png', '-f', 'image2pipe', 'pipe:1'], { signal: options.signal });
  }
  let bytes = await frame(at);
  // A clip may end before 1s even when its container reports a longer duration.
  if (!bytes.length && at !== 0) { at = 0; bytes = await frame(at); }
  let image;
  try { image = imageSize(bytes); } catch { throw new Error('動画の静止画を生成できません。'); }
  if (image.type !== 'png' || !(image.width > 0 && image.height > 0) || image.width > 800 || image.height > 800) throw new Error('動画の静止画が不正です。');
  return { bytes, mime: 'image/png', width, height, at };
}

async function safeDirectory(dir) {
  const stat = await fs.lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('動画の一時保存先が通常のフォルダーではありません。');
}

async function allocate(archive, index, options) {
  const root = options.root || path.join(os.tmpdir(), ROOT_NAME);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  await safeDirectory(root);
  const releaseLock = await acquireVideoLock(root, options);
  let dir, file;
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    if (entries.length > (options.entryLimit || CACHE_ENTRIES)) throw new Error('一時動画の件数上限です。外部プレイヤーを閉じてから、一時保存先を整理してください。');
    let size = 0;
    for (const entry of entries) {
      if (entry.name === 'quota.lock') continue;
      const folder = path.join(root, entry.name);
      if (!entry.name.startsWith('video-')) throw new Error('動画の一時保存先に不明な項目があります。');
      let names;
      try { await safeDirectory(folder); names = await fs.readdir(folder); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      for (const name of names) {
        // Another context can release an older immutable generated file while
        // we count it. Only disappearance is harmless; every other error fails.
        const stat = await fs.lstat(path.join(folder, name)).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
        if (!stat) continue;
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('動画の一時保存先に不明な項目があります。');
        size += stat.size;
      }
    }
    if (size + archive.pages[index].size + 64 > (options.byteLimit || CACHE_BYTES)) throw new Error('一時動画の容量上限（8 GiB）です。外部プレイヤーを閉じてから、一時保存先を整理してください。');
    options.signal?.throwIfAborted();
    dir = await fs.mkdtemp(path.join(root, 'video-'));
    file = path.join(dir, videoFilename(archive.pages[index].name, archive.pages[index].ext, dir));
    if (path.dirname(file) !== dir) throw new Error('動画の一時保存先の範囲外です。');
    await archive.writeVideo(index, file, { signal: options.signal });
    return { root, dir, file };
  } catch (error) {
    if (dir) await removeOwned(root, dir, file).catch(() => {});
    throw error;
  } finally { await releaseLock(); }
}

async function removeOwned(root, dir, file) {
  if (path.dirname(path.resolve(dir)) !== path.resolve(root) || !path.basename(dir).startsWith('video-')) throw new Error('一時保存先の範囲外です。');
  await safeDirectory(root); await safeDirectory(dir);
  if (await fs.stat(path.join(dir, 'opened.json')).catch(error => { if (error.code === 'ENOENT') return null; throw error; })) return;
  // Never enumerate/delete arbitrary names. This exact path is owned by this
  // handle; original ZIP directories are never used as extraction directories.
  if (file) {
    if (path.dirname(path.resolve(file)) !== path.resolve(dir) || !VIDEO_EXTENSIONS.includes(path.extname(file).slice(1).toLowerCase())) throw new Error('一時動画の保存先が不正です。');
    await fs.unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  await fs.rmdir(dir);
}

async function prepareVideo(archive, index, options = {}) {
  const page = archive.pages[index];
  if (page?.kind !== 'video' || !VIDEO_EXTENSIONS.includes(page.ext)) throw new Error('対応する動画を選んでください。');
  const allocated = await allocate(archive, index, options);
  try { await validateVideoHeader(allocated.file, page.ext); }
  catch (error) { await removeOwned(allocated.root, allocated.dir, allocated.file); throw error; }
  let retained = false, released = false;
  const posterAbort = new AbortController();
  const abortPoster = () => posterAbort.abort();
  options.signal?.addEventListener('abort', abortPoster, { once: true });
  if (options.signal?.aborted) abortPoster();
  const result = {
    file: allocated.file,
    async release() {
      abortPoster();
      await result.posterReady;
      if (released || retained) return;
      released = true;
      await removeOwned(allocated.root, allocated.dir, allocated.file);
    },
    async openExternal() {
      if (released) throw new Error('動画を選び直してください。');
      const open = options.host?.shell?.openPath;
      if (typeof open !== 'function') throw new Error('このEagle環境では外部プレイヤーを開けません。');
      // Persist before launching: shell.openPath only confirms launch, not that
      // a player has finished. Even an uncertain result must retain the file.
      retained = true;
      await fs.writeFile(path.join(allocated.dir, 'opened.json'), '{"retain":true}\n', { mode: 0o600 });
      const error = await open.call(options.host.shell, allocated.file);
      if (typeof error === 'string' && error) throw new Error('外部プレイヤーを開けません。OSの既定アプリ設定を確認してください。');
    }
  };
  // The verified file is usable immediately. Poster generation shares this
  // extraction but must never gate the user's external-open action.
  result.posterReady = retry(() => createPoster(allocated.file, { ...options, signal: posterAbort.signal }), { signal: posterAbort.signal })
    .then(poster => { result.poster = poster; })
    .catch(error => { result.posterError = error.message; })
    .finally(() => options.signal?.removeEventListener('abort', abortPoster));
  return result;
}

module.exports = { prepareVideo, createPoster, ffmpegPaths, frameTime, CACHE_BYTES, CACHE_ENTRIES, ROOT_NAME };
