'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const { createHash, randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');

const PROTOCOL = 'eagle-zip-video-pipe-v1';
const BUSY = '別の動画を準備中です。少し待って再試行してください。';

async function acquirePipe(root) {
  // Stable across versions, contexts and processes; aliases of one directory
  // must not create independent mutexes. This is local IPC, never TCP/network.
  const canonical = (await fs.realpath(root)).toLowerCase();
  const hash = createHash('sha256').update(canonical).digest('hex');
  const address = `\\\\.\\pipe\\eagle-zip-video-${hash}`;
  const server = net.createServer(socket => socket.destroy());
  return new Promise((resolve, reject) => {
    const bindError = error => { server.close(); reject(error); };
    server.once('error', bindError);
    server.listen({ path: address, exclusive: true }, () => {
      server.removeListener('error', bindError);
      // An accept error does not release the bound pipe. Keep ownership until
      // the protected write has stopped and its normal finally releases us.
      server.on('error', () => {});
      resolve(() => new Promise((done, fail) => server.close(error => error ? fail(error) : done())));
    });
  });
}

async function inspectGuard(file) {
  let stat;
  try { stat = await fs.lstat(file); } catch (error) { if (error.code === 'ENOENT') return 'gone'; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024) throw new Error('動画の一時ロックを安全に確認できません。自動削除せず停止しました。');
  let text;
  try { text = (await fs.readFile(file, 'utf8')).trim(); } catch (error) { if (error.code === 'ENOENT') return 'gone'; throw error; }
  let record;
  try { record = JSON.parse(text); } catch { /* Legacy PID-only format is handled below. */ }
  if (record?.protocol === PROTOCOL && Number.isSafeInteger(record.pid) && record.pid > 0) return 'new-format';
  if (!/^[1-9]\d{0,9}$/.test(text) || Number(text) > 2147483647) throw new Error('動画の一時ロックの所有者が不明です。自動削除せず停止しました。');
  try { process.kill(Number(text), 0); return 'alive'; }
  catch (error) {
    if (error.code === 'ESRCH') return 'dead';
    throw new Error('動画の一時ロックの所有者を確認できません。自動削除せず停止しました。');
  }
}

async function acquireVideoLock(root, { signal, lockTimeoutMs = 130000 } = {}) {
  const deadline = Date.now() + lockTimeoutMs;
  const file = path.join(root, 'quota.lock');
  let releasePipe, handle;
  async function pause() {
    signal?.throwIfAborted();
    if (Date.now() >= deadline) throw new Error(BUSY);
    await delay(Math.min(150, deadline - Date.now()), undefined, { signal });
  }
  try {
    if (process.platform === 'win32') {
      while (!releasePipe) {
        signal?.throwIfAborted();
        try { releasePipe = await acquirePipe(root); }
        catch (error) { if (error.code !== 'EADDRINUSE') throw error; await pause(); }
      }
    }
    while (!handle) {
      signal?.throwIfAborted();
      try { handle = await fs.open(file, 'wx', 0o600); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        // Never recover without owning the OS mutex. This also keeps legacy
        // 0.3.0 writers protected by their original wx file guard.
        if (!releasePipe) throw new Error(`${BUSY} このOSでは残った一時ロックの手動確認が必要です。`);
        const owner = await inspectGuard(file);
        if (owner === 'gone') continue;
        if (owner === 'dead' || owner === 'new-format') {
          // All new-version recovery runs under the same pipe. A legacy owner
          // cannot remove/recreate its guard after its process has exited.
          await fs.unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
        } else await pause();
      }
    }
    const owner = JSON.stringify({ protocol: PROTOCOL, pid: process.pid, token: randomUUID() });
    await handle.writeFile(owner);
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      try {
        await handle.close();
        if (await fs.readFile(file, 'utf8') !== owner) throw new Error('動画の一時ロックの所有者が変わったため、削除せず停止しました。');
        await fs.unlink(file);
      }
      finally { if (releasePipe) await releasePipe(); }
    };
  } catch (error) {
    if (handle) { await handle.close().catch(() => {}); await fs.unlink(file).catch(() => {}); }
    if (releasePipe) await releasePipe();
    throw error;
  }
}

module.exports = { acquireVideoLock, PROTOCOL };
