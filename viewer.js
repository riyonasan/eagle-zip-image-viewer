'use strict';

const { openArchive } = require('./lib/archive.cjs');
const { observeFullscreen } = require('./lib/immersive.cjs');
const { prepareVideo } = require('./lib/video.cjs');
const { retry } = require('./lib/retry.cjs');
const { focusOnOpen } = require('./lib/focus.cjs');
const stopObservingFullscreen = observeFullscreen(window, document);
const ui = Object.fromEntries(['previous', 'next', 'counter', 'pages', 'fit', 'encoding', 'reload', 'stage', 'page', 'status', 'filename', 'video-card', 'video-open', 'video-note'].map(id => [id, document.getElementById(id)]));
const source = new URLSearchParams(window.location.search).get('path');
let archive = null, index = 0, ticket = 0, currentURL = null, disposed = false;
let archiveNeedsRefresh = false;
let queue = Promise.resolve();
let video = null, videoAbort = null, loadAbort = null;
let videoNotice = false;

function releaseImage() {
  videoAbort?.abort(); videoAbort = null;
  let cleanup = Promise.resolve();
  if (video) { cleanup = video.release().catch(() => {}); video = null; }
  videoNotice = false;
  videoError('');
  ui['video-card'].hidden = true;
  ui['video-open'].disabled = true;
  ui.page.hidden = true;
  ui.page.removeAttribute('src');
  if (currentURL) URL.revokeObjectURL(currentURL);
  currentURL = null;
  return cleanup;
}
function videoError(message) {
  ui['video-note'].textContent = message || '';
  ui['video-note'].hidden = !message;
}
function newLoad() {
  loadAbort?.abort();
  loadAbort = new AbortController();
  return loadAbort.signal;
}
function status(message, error = false) {
  ui.status.textContent = message;
  ui.status.hidden = !message;
  ui.status.className = error ? 'error' : '';
}
function controls() {
  const count = archive?.pages.length || 0;
  ui.previous.disabled = !count || index <= 0;
  ui.next.disabled = !count || index >= count - 1;
  ui.pages.disabled = !count;
  ui.pages.value = String(index);
  ui.counter.textContent = count ? `${index + 1} / ${count}` : '0 / 0';
  ui.filename.textContent = archive?.pages[index]?.name || '';
}
function decode(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const timer = setTimeout(() => finish(new Error('画像の表示処理が時間切れになりました。')), 15000);
    function finish(error) {
      clearTimeout(timer);
      image.onload = image.onerror = null;
      image.removeAttribute('src');
      error ? reject(error) : resolve();
    }
    image.onload = () => finish();
    image.onerror = () => finish(new Error('この画像はEagleで表示できません。別のページを選べます。'));
    image.src = url;
  });
}
async function showPageOnce(mine, selected) {
  if (mine !== ticket || disposed || !archive) return;
  let url;
  let prepared;
  try {
    let page;
    const selectedPage = archive.pages[selected];
    ui.stage.dataset.kind = selectedPage.kind || 'image';
    if (selectedPage.kind === 'video') {
      ui['video-card'].hidden = false;
      videoError('');
      status('');
      videoAbort = new AbortController();
      prepared = await prepareVideo(archive, selected, { host: window.eagle, signal: videoAbort.signal });
      if (mine !== ticket || disposed) return;
      video = prepared; prepared = null;
      ui['video-card'].hidden = false;
      ui['video-open'].disabled = false;
      await video.posterReady;
      if (mine !== ticket || disposed) return;
      if (!videoNotice) videoError(video.poster ? '' : video.posterError);
      status('');
      if (!video.poster) return;
      page = { ...video.poster, name: selectedPage.name };
    } else page = await archive.readPage(selected);
    if (mine !== ticket || disposed) return;
    url = URL.createObjectURL(new Blob([page.bytes], { type: page.mime }));
    await decode(url);
    if (mine !== ticket || disposed) return;
    currentURL = url;
    url = null;
    ui.page.src = currentURL;
    ui.page.alt = page.name;
    ui.page.hidden = false;
    ui.stage.scrollTop = ui.stage.scrollLeft = 0;
    status('');
  } finally { if (url) URL.revokeObjectURL(url); if (prepared) await prepared.release().catch(() => {}); }
}
async function showPage(mine, selected, signal, refresh = false) {
  const originalName = archive?.pages[selected]?.name;
  try {
    await retry(async attempt => {
      if (mine !== ticket || disposed) return;
      if (attempt) {
        await releaseImage();
        if (mine !== ticket || disposed) return;
        archive?.close(); archiveNeedsRefresh = true;
      }
      if (refresh || attempt || !archive || archiveNeedsRefresh) {
        const opened = await openArchive(source, { encoding: ui.encoding.value });
        if (mine !== ticket || disposed) { opened.close(); return; }
        archive = opened;
        archiveNeedsRefresh = false;
        if (originalName && archive.pages[selected]?.name !== originalName) {
          const same = archive.pages.findIndex(page => page.name === originalName);
          if (same >= 0) selected = same;
        }
        index = selected = Math.max(0, Math.min(archive.pages.length - 1, selected));
        const fragment = document.createDocumentFragment();
        archive.pages.forEach((page, i) => {
          const option = document.createElement('option'); option.value = String(i);
          option.textContent = `${i + 1}. ${page.name}`; fragment.appendChild(option);
        });
        ui.pages.replaceChildren(fragment); controls();
      }
      await showPageOnce(mine, selected);
    }, { signal });
  } catch (error) {
    if (mine === ticket && !disposed) {
      if (!video) ui['video-card'].hidden = true;
      controls();
      status(error.message, true);
    }
  }
}
function navigate(next) {
  if (!archive || disposed) return;
  index = Math.max(0, Math.min(archive.pages.length - 1, next));
  const selected = index, mine = ++ticket;
  const signal = newLoad();
  releaseImage();
  controls();
  status(archive.pages[index].kind === 'video' ? '動画を準備しています…' : '画像を読み込んでいます…');
  queue = queue.then(() => showPage(mine, selected, signal));
}
function reload() {
  const mine = ++ticket;
  const signal = newLoad();
  archive?.close();
  archive = null;
  index = 0;
  releaseImage();
  ui.pages.replaceChildren();
  controls();
  status('ZIPを開いています…');
  queue = queue.then(() => showPage(mine, 0, signal, true));
}
ui.previous.addEventListener('click', () => navigate(index - 1));
ui.next.addEventListener('click', () => navigate(index + 1));
ui.pages.addEventListener('change', () => navigate(Number(ui.pages.value)));
ui.reload.addEventListener('click', reload);
ui.encoding.addEventListener('change', reload);
ui.fit.addEventListener('change', () => { ui.stage.dataset.fit = ui.fit.value; });
ui['video-open'].addEventListener('click', async () => {
  const selected = video;
  if (!selected || ui['video-open'].disabled) return;
  ui['video-open'].disabled = true;
  videoNotice = true;
  videoError('');
  try {
    await selected.openExternal();
  } catch (error) {
    if (selected === video) videoError(error.message);
  } finally { if (selected === video) ui['video-open'].disabled = false; }
});
document.addEventListener('keydown', event => {
  if (event.ctrlKey || event.altKey || event.metaKey || /^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(event.target.tagName)) return;
  const action = {
    ArrowLeft: () => navigate(index - 1), ArrowRight: () => navigate(index + 1),
    PageUp: () => navigate(index - 1), PageDown: () => navigate(index + 1),
    ' ': () => navigate(index + (event.shiftKey ? -1 : 1)),
    Home: () => navigate(0), End: () => navigate((archive?.pages.length || 1) - 1),
    f: () => { const modes = ['contain', 'width', 'actual']; ui.fit.value = modes[(modes.indexOf(ui.fit.value) + 1) % modes.length]; ui.stage.dataset.fit = ui.fit.value; }
  }[event.key];
  if (action) { event.preventDefault(); action(); }
});
const stopInitialFocus = focusOnOpen(window, document, ui.stage);
window.addEventListener('beforeunload', () => { disposed = true; ticket++; loadAbort?.abort(); stopInitialFocus(); stopObservingFullscreen(); archive?.close(); releaseImage(); });
reload();
