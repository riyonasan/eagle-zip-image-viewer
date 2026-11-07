'use strict';
// Reproducible small project icon, no graphics runtime or external asset.
const fs = require('node:fs');
const { deflateSync } = require('node:zlib');
const { crc32 } = require('../lib/archive.cjs');
const size = 128, rows = Buffer.alloc(size * (1 + size * 4));
for (let y=0;y<size;y++) for(let x=0;x<size;x++) {
  let color = [43,45,55,255];
  if (x>=24 && x<104 && y>=14 && y<114) color=[190,177,229,255];
  if (x>=36 && x<92 && y>=50 && y<97) color=[70,72,92,255];
  if (y>=82-Math.abs(x-56)*0.6 && x>=40 && x<88 && y<93) color=[131,159,198,255];
  if ((x-78)**2+(y-62)**2<25) color=[240,218,163,255];
  if (x>=59 && x<69 && y>=14 && y<45 && (Math.floor(y/4)%2===0)) color=[70,72,92,255];
  const i=y*(1+size*4)+1+x*4; rows.set(color,i);
}
function chunk(type,data){const t=Buffer.from(type),n=Buffer.alloc(4),c=Buffer.alloc(4);n.writeUInt32BE(data.length);c.writeUInt32BE(crc32(Buffer.concat([t,data])));return Buffer.concat([n,t,data,c]);}
const header=Buffer.alloc(13);header.writeUInt32BE(size);header.writeUInt32BE(size,4);header[8]=8;header[9]=6;
fs.writeFileSync(require('node:path').join(__dirname,'..','logo.png'),Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',deflateSync(rows)),chunk('IEND',Buffer.alloc(0))]));
