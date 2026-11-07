'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const iconv = require('iconv-lite');
const { openArchive, crc32, localPath } = require('../lib/archive.cjs');
const { zip, PNG } = require('./fixture.cjs');

async function fixture(t, entries) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zip-viewer-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'synthetic.zip');
  await fs.writeFile(file, Buffer.isBuffer(entries) ? entries : zip(entries));
  return file;
}
async function opened(t, entries, options) {
  const file = await fixture(t, entries);
  const archive = await openArchive(file, options);
  t.after(() => archive.close());
  return archive;
}

test('natural full-path order; hidden/resource/non-images ignored; duplicate order deterministic', async t => {
  const archive = await opened(t, ['10.png', '2.PNG', 'a/11.jpg', 'a/2.jpg', '__MACOSX/1.png', '.hidden.jpg', 'folder/.secret/a.png', 'readme.txt', 'nested.zip', 'view.svg', '2.PNG'].map(name => ({ name })));
  assert.deepEqual(archive.pages.map(p => p.name), ['2.PNG', '2.PNG', '10.png', 'a/2.jpg', 'a/11.jpg']);
  const page = await archive.readPage(0);
  assert.equal(page.width, 1); assert.equal(page.height, 1); assert.equal(page.mime, 'image/png');
  assert.deepEqual(page.bytes, PNG);
});
test('STORE and DEFLATE reads, file URL and repeat reads', async t => {
  const file = await fixture(t, [{ name: '1.png', method: 0 }, { name: '2.png' }]);
  const archive = await openArchive(pathToFileURL(file).href); t.after(() => archive.close());
  for (const i of [0, 1, 0]) assert.deepEqual((await archive.readPage(i)).bytes, PNG);
});
test('UTF8 and unflagged CP932 filenames; explicit CP437', async t => {
  const entries = [{ name: iconv.encode('絵2.png', 'shift_jis'), flags: 0 }, { name: iconv.encode('絵10.png', 'shift_jis'), flags: 0 }];
  const archive = await opened(t, entries);
  assert.deepEqual(archive.pages.map(p => p.name), ['絵2.png', '絵10.png']);
  const western = await opened(t, [{ name: iconv.encode('é.png', 'cp437'), flags: 0 }], { encoding: 'cp437' });
  assert.equal(western.pages[0].name, 'é.png');
});
test('empty or no supported images produces useful error', async t => {
  for (const entries of [[], [{ name: 'readme.txt' }], [{ name: 'a.svg' }]]) {
    await assert.rejects(openArchive(await fixture(t, entries)), { code: 'EMPTY' });
  }
});
test('corrupt/truncated archive is rejected', async t => {
  await assert.rejects(openArchive(await fixture(t, Buffer.from('not a zip'))), { code: 'ZIP' });
  await assert.rejects(openArchive(await fixture(t, zip([{ name: '1.png' }]).subarray(0, 40))), { code: 'ZIP' });
});
test('unsafe names and symbolic links are rejected; nothing is extracted', async t => {
  for (const name of ['../outside.png', '/absolute.png', 'C:/absolute.png', 'a/../../outside.png', 'a\0.png']) {
    await assert.rejects(openArchive(await fixture(t, [{ name }])), { code: 'ZIP' });
  }
  await assert.rejects(openArchive(await fixture(t, [{ name: 'link.png', attributes: (0xa000 << 16) >>> 0 }])), { code: 'ZIP' });
});
test('encrypted and unsupported compression errors', async t => {
  await assert.rejects(openArchive(await fixture(t, [{ name: '1.png', flags: 0x801 }])), { code: 'ENCRYPTED' });
  await assert.rejects(openArchive(await fixture(t, [{ name: '1.png', method: 12 }])), { code: 'COMPRESSION' });
});
test('archive, entry count, per-page, and total declared sizes bounded before reading', async t => {
  const file = await fixture(t, [{ name: '1.png' }, { name: '2.png' }]);
  for (const limits of [{ archiveBytes: 10 }, { entries: 1 }, { pageBytes: 10 }, { totalBytes: 10 }]) {
    await assert.rejects(openArchive(file, { limits }), { code: 'LIMIT' });
  }
});
test('central metadata including ignored-file comments/extra fields is bounded', async t => {
  const extra = Buffer.alloc(84); extra.writeUInt16LE(0xcafe); extra.writeUInt16LE(80,2);
  for (const fields of [{comment:Buffer.alloc(80)}, {extra}]) {
    const file = await fixture(t, [{name:'1.png'}, {name:'ignored.txt',...fields}]);
    await assert.rejects(openArchive(file,{limits:{metadataBytes:128}}), {code:'LIMIT'});
  }
  const file = await fixture(t,[{name:'x'.repeat(4097)+'.png'}]);
  await assert.rejects(openArchive(file),{code:'LIMIT'});
});
test('image read retains only scalar fields, not central-directory Buffers', async t => {
  const yauzl=require('yauzl'), original=yauzl.ZipFile.prototype.openReadStreamPromise;
  let retained;
  yauzl.ZipFile.prototype.openReadStreamPromise=function(entry,...args){retained=entry;return original.call(this,entry,...args);};
  t.after(()=>{yauzl.ZipFile.prototype.openReadStreamPromise=original;});
  const archive=await opened(t,[{name:'1.png',comment:Buffer.alloc(2048)}]);
  await archive.readPage(0);
  assert.deepEqual(Object.keys(retained).sort(), ['compressedSize','compressionMethod','crc32','generalPurposeBitFlag','relativeOffsetOfLocalHeader','uncompressedSize'].sort());
  assert.ok(Object.values(retained).every(v=>typeof v==='number'));
});
test('CRC mismatch detected on demand, with navigation still usable', async t => {
  const archive = await opened(t, [{ name: '1.png', crc: 0 }, { name: '2.png' }]);
  await assert.rejects(archive.readPage(0), { code: 'CRC' });
  assert.deepEqual((await archive.readPage(1)).bytes, PNG);
});
test('inflation beyond declared size and invalid image bytes rejected', async t => {
  const archive = await opened(t, [{ name: '1.png', size: 1 }, { name: '2.png', data: Buffer.from('fake image') }]);
  await assert.rejects(archive.readPage(0));
  await assert.rejects(archive.readPage(1), { code: 'IMAGE' });
});
test('resolution is checked before image decoder', async t => {
  const archive = await opened(t, [{ name: '1.png' }], { limits: { pixels: 0 } });
  await assert.rejects(archive.readPage(0), { code: 'LIMIT' });
});
test('bad page, parallel read, close and idempotent cleanup', async t => {
  const archive = await opened(t, [{ name: '1.png' }]);
  await assert.rejects(archive.readPage(-1), { code: 'PAGE' });
  const first = archive.readPage(0);
  await assert.rejects(archive.readPage(0), { code: 'BUSY' });
  await first;
  archive.close(); archive.close();
  await assert.rejects(archive.readPage(0), { code: 'CLOSED' });
});
test('close during pending read rejects rather than leaking/hanging', async t => {
  const archive = await opened(t, [{ name: '1.png' }]);
  const reading = archive.readPage(0); archive.close();
  await assert.rejects(reading);
});
test('CRC known vector and incremental updates; network paths rejected', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.equal(crc32(Buffer.from('56789'), crc32(Buffer.from('1234'))), 0xcbf43926);
  assert.throws(() => localPath('https://example.com/file.zip'), { code: 'PATH' });
  assert.throws(() => localPath('relative.zip'), { code: 'PATH' });
});
