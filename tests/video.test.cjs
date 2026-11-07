'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { openArchive } = require('../lib/archive.cjs');
const { prepareVideo, createPoster, ffmpegPaths, frameTime } = require('../lib/video.cjs');
const { zip, PNG } = require('./fixture.cjs');
const MP4 = Buffer.concat([Buffer.from([0,0,0,16]), Buffer.from('ftypisom0000')]);
const AVI = Buffer.from('RIFF0000AVI ');

async function fixture(t, entries = [{ name: '1.mp4' }], limits) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zip-video-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  entries = entries.map(entry => ({ ...entry, data:entry.data || (/\.avi$/i.test(entry.name) ? AVI : /\.(mp4|m4v|mov)$/i.test(entry.name) ? MP4 : PNG) }));
  const source = path.join(dir, 'test.zip'); await fs.writeFile(source, zip(entries));
  const archive = await openArchive(source, { limits }); t.after(() => archive.close());
  const root = path.join(dir, 'cache');
  const extraModule = { ffmpeg: { isInstalled: true, paths: { ffmpeg: process.execPath, ffprobe: process.execPath } } };
  const calls = [];
  const run = async (binary, args, options) => {
    calls.push({ binary, args, options });
    return args.includes('-show_entries') ? Buffer.from(JSON.stringify({ streams: [{ width: 640, height: 480 }], format: { duration: '2' } })) : PNG;
  };
  return { dir, root, source, archive, calls, options: { root, extraModule, run } };
}

test('mixed image/video names share natural order; only allowed types are included', async t => {
  const h = await fixture(t, ['10.mp4', '2.png', '1.AVI', 'run.exe', 'playlist.m3u8', '.hidden.mov'].map(name => ({ name })));
  assert.deepEqual(h.archive.pages.map(x => [x.name, x.kind]), [['1.AVI', 'video'], ['2.png', 'image'], ['10.mp4', 'video']]);
  await assert.rejects(h.archive.readPage(0), { code: 'PAGE' });
  assert.deepEqual((await h.archive.readPage(1)).bytes, PNG);
});

test('video is streamed to a generated file, CRC checked, and unlaunched files removed', async t => {
  const data = Buffer.concat([MP4, Buffer.alloc(1024 * 1024, 7)]);
  const h = await fixture(t, [{ name: 'nested/a & b.mp4', data }]);
  const video = await prepareVideo(h.archive, 0, h.options);
  await video.posterReady;
  assert.equal(path.basename(video.file), 'a & b.mp4');
  assert.equal((await fs.stat(video.file)).size, data.length);
  assert.equal(video.poster.at, 1);
  assert.equal(h.calls[1].args[h.calls[1].args.indexOf('-ss') + 1], '1');
  assert.ok(h.calls.every(x => x.args.includes('-protocol_whitelist') && x.args.includes('-format_whitelist')));
  await video.release(); await video.release();
  assert.deepEqual(await fs.readdir(h.root), []);
});

test('CRC failure never opens a player and removes partial output and quota lock', async t => {
  const h = await fixture(t, [{ name: '1.avi', crc: 123 }]);
  await assert.rejects(prepareVideo(h.archive, 0, h.options), { code: 'CRC' });
  assert.deepEqual(await fs.readdir(h.root), []); assert.equal(h.calls.length, 0);
});

test('video limits, unsafe names, encryption, and unsupported compression remain enforced', async t => {
  for (const entry of [{ name: '../x.mp4' }, { name: 'x.mp4', flags: 0x801 }, { name: 'x.mp4', method: 12 }, { name: 'x.mp4', attributes: (0xa000 << 16) >>> 0 }]) {
    await assert.rejects(fixture(t, [entry]));
  }
  await assert.rejects(fixture(t, [{ name: 'x.mp4' }], { videoBytes: 1 }), { code: 'LIMIT' });
});

test('exclusive file creation refuses overwrite; aborted extraction releases its lock', async t => {
  const h = await fixture(t); const dest = path.join(h.dir, 'existing'); await fs.writeFile(dest, 'preserve');
  await assert.rejects(h.archive.writeVideo(0, dest), { code: 'EEXIST' });
  assert.equal(await fs.readFile(dest, 'utf8'), 'preserve');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(prepareVideo(h.archive, 0, { ...h.options, signal: controller.signal }));
  assert.deepEqual(await fs.readdir(h.root), []);
});

test('missing FFmpeg keeps the explicit external-open action usable; opened file stays after release', async t => {
  const h = await fixture(t); let opened = 0;
  const video = await prepareVideo(h.archive, 0, { root: h.root, host: { shell: { openPath: async file => { opened++; assert.equal(file, video.file); } } } });
  await video.posterReady;
  assert.equal(opened, 0); assert.match(video.posterError, /FFmpeg/);
  await video.openExternal(); await video.release();
  assert.equal(opened, 1); assert.ok((await fs.stat(video.file)).isFile());
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(path.dirname(video.file), 'opened.json'), 'utf8')), { retain: true });
});

test('navigation during external launch and failed/uncertain launch must retain the media', async t => {
  const h = await fixture(t); let resolveLaunch;
  const video = await prepareVideo(h.archive, 0, { ...h.options, host: { shell: { openPath: () => new Promise(resolve => { resolveLaunch = resolve; }) } } });
  const launch = video.openExternal(); await video.release();
  while (!resolveLaunch) await new Promise(setImmediate);
  assert.ok((await fs.stat(video.file)).isFile());
  resolveLaunch('failed'); await assert.rejects(launch); await video.release();
  assert.ok((await fs.stat(video.file)).isFile());
});

test('quota and concurrent-extraction locks stop additional writes', async t => {
  const h = await fixture(t);
  await assert.rejects(prepareVideo(h.archive, 0, { ...h.options, byteLimit: 1 }), /容量上限/);
  await fs.writeFile(path.join(h.root, 'quota.lock'), 'test');
  await assert.rejects(prepareVideo(h.archive, 0, h.options), /所有者|別の動画/);
  await fs.unlink(path.join(h.root, 'quota.lock'));
  const video = await prepareVideo(h.archive, 0, { ...h.options, host: { shell: { openPath: async () => {} } } });
  await video.openExternal();
  await assert.rejects(prepareVideo(h.archive, 0, { ...h.options, byteLimit: MP4.length }), /容量上限/);
});

test('dependency resolution uses supplied Eagle paths, not environment search or fixed locations', async () => {
  await assert.rejects(ffmpegPaths(), /FFmpeg/);
  await assert.rejects(ffmpegPaths({ extraModule: { ffmpeg: { isInstalled: true, paths: { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' } } } }), /FFmpeg/);
  const expected = { ffmpeg: process.execPath, ffprobe: process.execPath };
  assert.deepEqual(await ffmpegPaths({ host: { extraModule: { ffmpeg: { getPaths: async () => expected } } } }), expected);
});

test('1s frame target, short clip fallback, invalid probe and empty frame handling', async t => {
  assert.equal(frameTime(0.4), 0); assert.equal(frameTime(1), 0); assert.equal(frameTime(2), 1); assert.equal(frameTime(NaN), 1);
  const h = await fixture(t); const times = [];
  const run = async (_, args) => {
    if (args.includes('-show_entries')) return Buffer.from('{"streams":[{"width":64,"height":48}],"format":{"duration":"3"}}');
    const at = args[args.indexOf('-ss') + 1]; times.push(at); return at === '1' ? Buffer.alloc(0) : PNG;
  };
  assert.equal((await createPoster('synthetic.mp4', { ...h.options, run })).at, 0); assert.deepEqual(times, ['1', '0']);
  await assert.rejects(createPoster('synthetic.mp4', { ...h.options, run: async () => Buffer.from('{"streams":[{"width":999999,"height":999999}]}') }), /解像度/);
  await assert.rejects(createPoster('synthetic.mp4', { ...h.options, run: async () => Buffer.from('invalid') }), /情報/);
});

test('disguised playlist/executable cannot be sent to an external application', async t => {
  for (const data of [Buffer.from('#EXTM3U\nhttps://invalid.example/video\n'),Buffer.from('MZthis-is-not-an-mp4')]) {
    const h=await fixture(t,[{name:'fake.mp4',data}]);
    await assert.rejects(prepareVideo(h.archive,0,h.options),/拡張子と内容/);
    assert.deepEqual(await fs.readdir(h.root),[]);
  }
});

test('large video is extracted once and opens while poster generation is pending or fails', async t => {
  const data = Buffer.concat([MP4, Buffer.alloc(16 * 1024 * 1024, 7)]);
  const h = await fixture(t, [{ name:'large.mp4', data }]);
  let writes=0, opened=0, rejectProbe, probes=0;
  const original = h.archive.writeVideo;
  h.archive.writeVideo = async (...args) => { writes++; return original(...args); };
  const video = await prepareVideo(h.archive, 0, { ...h.options,
    run: () => ++probes===1 ? new Promise((_,reject) => { rejectProbe=reject; }) : Promise.reject(new Error('synthetic codec failure')),
    host:{shell:{openPath:async file=>{opened++;assert.equal((await fs.stat(file)).size,data.length);}}}
  });
  while (!rejectProbe) await new Promise(setImmediate);
  assert.equal(video.poster,undefined);assert.equal(writes,1);
  await video.openExternal();assert.equal(opened,1);
  rejectProbe(new Error('synthetic codec failure'));await video.posterReady;
  assert.match(video.posterError,/codec failure/);
  await video.openExternal();await video.release();
  assert.equal(writes,1);assert.equal(opened,2);assert.ok((await fs.stat(video.file)).isFile());
});

test('release aborts a running poster and waits before deleting the verified video', async t => {
  const h = await fixture(t);let started, stopped=false;
  const ready=new Promise(resolve=>{started=resolve;});
  const video=await prepareVideo(h.archive,0,{...h.options,run:(_,__,{signal})=>new Promise((_,reject)=>{
    signal.addEventListener('abort',()=>setImmediate(()=>{stopped=true;reject(Error('aborted'));}),{once:true});started();
  })});
  await ready;await video.release();
  assert.equal(stopped,true);assert.deepEqual(await fs.readdir(h.root),[]);
});

test('quota scan tolerates only old generated entries disappearing during cleanup', async t => {
  for(const phase of ['folder-stat','folder-read','file-stat']) {
    const h=await fixture(t), first=await prepareVideo(h.archive,0,h.options);
    await first.posterReady;
    const folder=path.dirname(first.file), original=fs.readdir;let injected=false,next;
    fs.readdir=async function(dir,...args) {
      if(phase==='folder-read' && dir===folder && !injected) {injected=true;await first.release();}
      const result=await original.call(this,dir,...args);
      if(!injected && ((phase==='folder-stat' && dir===h.root) || (phase==='file-stat' && dir===folder))) {
        injected=true;await first.release();
      }
      return result;
    };
    try { next=await prepareVideo(h.archive,0,h.options);assert.equal(injected,true); }
    finally {fs.readdir=original;await first.release();if(next)await next.release();}
    assert.deepEqual(await fs.readdir(h.root),[]);
  }
});

test('quota scan still rejects non-ENOENT failures', async t => {
  const h=await fixture(t), first=await prepareVideo(h.archive,0,h.options);
  await first.posterReady;
  const folder=path.dirname(first.file),original=fs.lstat;
  fs.lstat=async function(file,...args) {if(file===folder)throw Object.assign(Error('synthetic denied'),{code:'EACCES'});return original.call(this,file,...args);};
  try {await assert.rejects(prepareVideo(h.archive,0,h.options),{code:'EACCES'});}
  finally {fs.lstat=original;await first.release();}
  assert.deepEqual(await fs.readdir(h.root),[]);
});

test('equal original basenames use separate directories and release only the owning file', async t => {
  const h=await fixture(t,[{name:'a/同じ名前.MP4'},{name:'b/同じ名前.MP4'}]);
  const first=await prepareVideo(h.archive,0,h.options),second=await prepareVideo(h.archive,1,h.options);
  await Promise.all([first.posterReady,second.posterReady]);
  assert.equal(path.basename(first.file),'同じ名前.MP4');assert.equal(path.basename(second.file),'同じ名前.MP4');
  assert.notEqual(first.file,second.file);
  await first.release();assert.ok((await fs.stat(second.file)).isFile());
  const unrelated=path.join(path.dirname(second.file),'leave-this.txt');await fs.writeFile(unrelated,'preserve');
  await assert.rejects(second.release(),{code:'ENOTEMPTY'});
  assert.equal(await fs.readFile(unrelated,'utf8'),'preserve');await assert.rejects(fs.stat(second.file),{code:'ENOENT'});
});

test('poster failure retries on the same extracted original filename, without opening a player', async t => {
  const h=await fixture(t,[{name:'my movie.mp4'}]);let writes=0,probes=0,opened=0;
  const write=h.archive.writeVideo;h.archive.writeVideo=async(...args)=>{writes++;return write(...args);};
  const video=await prepareVideo(h.archive,0,{...h.options,run:async()=>{probes++;throw Error('unsupported');},host:{shell:{openPath:async()=>{opened++;}}}});
  await video.posterReady;
  assert.equal(writes,1);assert.equal(probes,4);assert.equal(opened,0);assert.equal(path.basename(video.file),'my movie.mp4');
  await video.release();assert.deepEqual(await fs.readdir(h.root),[]);
});
