'use strict';
const { deflateRawSync } = require('node:zlib');
const { crc32 } = require('../lib/archive.cjs');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
function zip(entries) {
  const locals = [], central = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.isBuffer(e.name) ? e.name : Buffer.from(e.name);
    const data = e.data || PNG;
    const method = e.method ?? 8;
    const compressed = method === 8 ? deflateRawSync(data) : data;
    const flags = e.flags ?? 0x800;
    const crc = e.crc ?? crc32(data);
    const size = e.size ?? data.length;
    const extra = e.extra || Buffer.alloc(0), comment = e.comment || Buffer.alloc(0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(size, 22); local.writeUInt16LE(name.length, 26);
    locals.push(local, name, compressed);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50); header.writeUInt16LE(0x314, 4); header.writeUInt16LE(20, 6);
    header.writeUInt16LE(flags, 8); header.writeUInt16LE(method, 10);
    header.writeUInt32LE(crc, 16); header.writeUInt32LE(compressed.length, 20);
    header.writeUInt32LE(size, 24); header.writeUInt16LE(name.length, 28);
    header.writeUInt16LE(extra.length, 30); header.writeUInt16LE(comment.length, 32);
    header.writeUInt32LE(e.attributes ?? 0, 38); header.writeUInt32LE(offset, 42);
    central.push(header, name, extra, comment);
    offset += local.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
module.exports = { zip, PNG };
