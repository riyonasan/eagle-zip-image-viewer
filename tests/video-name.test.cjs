'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { videoFilename } = require('../lib/video-name.cjs');
const dir=path.resolve('synthetic-temp','video-unique');

test('preserve safe original basename including Japanese, spaces and extension case',()=>{
  assert.equal(videoFilename('folder/動画 01 & 雪.MP4','mp4',dir),'動画 01 & 雪.MP4');
  assert.equal(videoFilename('nested\\clip.avi','avi',dir),'clip.avi');
  assert.equal(videoFilename('タイトル ..MP4','mp4',dir),'タイトル ..MP4');
});

test('names never escape the unique directory or use Windows devices/streams/control characters',()=>{
  for(const original of ['../../clip.mp4','C:\\other\\clip.mp4','CON.mp4','con.extra.mp4','CON .mp4','LPT¹.mp4','COM9.mp4','CONOUT$.mp4','bad:name?.mp4','bad\u202e.exe.mp4']) {
    const name=videoFilename(original,'mp4',dir);
    assert.equal(path.dirname(path.join(dir,name)),dir);assert.equal(path.basename(name),name);
    assert.doesNotMatch(name,/[<>:"/\\|?*\x00-\x1f\u202e]/);assert.equal(path.extname(name).toLowerCase(),'.mp4');
    if(/^(CON|LPT|COM)/i.test(path.win32.basename(original)))assert.ok(name.startsWith('_'));
  }
  assert.throws(()=>videoFilename('run.exe','exe',dir));
});

test('long Unicode names are shortened with stable distinct hashes and a valid extension',()=>{
  const original='長い😀'.repeat(150)+'.mp4', name=videoFilename(original,'mp4',dir);
  assert.ok(Buffer.byteLength(name,'utf8')<=240);assert.ok(path.join(dir,name).length<=240);
  assert.match(name,/~[a-f0-9]{8}\.mp4$/);assert.equal(videoFilename(original,'mp4',dir),name);
  assert.notEqual(videoFilename(original.replace('長','違'),'mp4',dir),name);
});
