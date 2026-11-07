'use strict';
const fs = require('node:fs/promises');
const { openArchive } = require('./lib/archive.cjs');

// Eagle provides this DOM-enabled thumbnail context and its output path.
module.exports = async ({ src, dest, item, extraModule }) => {
  const archive = await openArchive(src);
  let url, video;
  try {
    const firstImage = archive.pages?.findIndex(page => page.kind === 'image') ?? 0;
    let page;
    if (firstImage >= 0) page = await archive.readPage(firstImage);
    else {
      const videoTools = require('./lib/video.cjs');
      let available = false;
      try { await videoTools.ffmpegPaths({ extraModule }); available = true; }
      catch { /* Do not extract a large video just to draw the fallback icon. */ }
      if (available) {
        video = await videoTools.prepareVideo(archive, 0, { extraModule });
        await video.posterReady;
        page = video.poster;
      }
      if (!page) {
        // A poster is optional. Keep video-only archives recognizable when the
        // dependency/codec is unavailable, without importing a separate item.
        const canvas = document.createElement('canvas'); canvas.width = 400; canvas.height = 225;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#2b2d31'; ctx.fillRect(0, 0, 400, 225);
        ctx.fillStyle = '#dfe3eb'; ctx.beginPath(); ctx.moveTo(175, 75); ctx.lineTo(235, 112); ctx.lineTo(175, 150); ctx.closePath(); ctx.fill();
        await fs.writeFile(dest, Buffer.from(canvas.toDataURL('image/png').split(',')[1], 'base64'));
        item.width = 400; item.height = 225;
        return item;
      }
    }
    url = URL.createObjectURL(new Blob([page.bytes], { type: page.mime }));
    const image = new Image();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('ZIPの表紙画像の表示が時間切れになりました。')), 15000);
      function finish(error) {
        clearTimeout(timer);
        image.onload = image.onerror = null;
        if (error) { image.removeAttribute('src'); reject(error); } else resolve();
      }
      image.onload = () => finish();
      image.onerror = () => finish(new Error('ZIPの先頭画像を表示できません。'));
      image.src = url;
    });
    // Use decoded dimensions so JPEG EXIF rotation does not distort the cover.
    const width = image.naturalWidth || page.width, height = image.naturalHeight || page.height;
    const scale = Math.min(1, 400 / Math.max(width, height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
    const bytes = Buffer.from(canvas.toDataURL('image/png').split(',')[1], 'base64');
    await fs.writeFile(dest, bytes);
    item.width = width;
    item.height = height;
    return item;
  } finally { if (url) URL.revokeObjectURL(url); archive.close(); if (video) await video.release(); }
};
