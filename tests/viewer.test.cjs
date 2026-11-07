'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

class Element {
  constructor(tagName = 'DIV') { this.tagName = tagName; this.events = {}; this.dataset = {}; this.children = []; this.value = ''; }
  addEventListener(type, fn) { this.events[type] = fn; }
  replaceChildren(...children) { this.children = children.flatMap(c => c.tagName === 'FRAGMENT' ? c.children : [c]); }
  appendChild(child) { this.children.push(child); }
  removeAttribute(name) { delete this[name]; }
  set innerHTML(_) { throw new Error('Untrusted HTML injection'); }
  fire(type, event = {}) { this.events[type]?.(event); }
}
function harness(options = {}) {
  const elements = Object.fromEntries(['previous','next','counter','pages','fit','encoding','reload','stage','page','status','filename','video-card','video-open','video-note'].map(id => [id, new Element()]));
  elements.encoding.value = 'auto'; elements.fit.value = 'contain';
  const document = new Element();
  document.body=new Element('BODY');document.documentElement=new Element('HTML');
  document.activeElement=options.activeControl?elements.pages:document.body;
  document.visibilityState=options.hidden?'hidden':'visible';
  Object.assign(document, { getElementById: id => elements[id], createElement: tag => new Element(tag.toUpperCase()), createDocumentFragment: () => new Element('FRAGMENT') });
  const window = new Element(); window.location = { search: '?path=C%3A%5Csynthetic.zip' };
  const focus={window:0,stage:0,options:null};
  window.focus=()=>{focus.window++;if(options.focusError)throw Error('focus restricted');};
  elements.stage.focus=opts=>{focus.stage++;focus.options=opts;document.activeElement=elements.stage;};
  const handles = [], reads = [], revoked = [], urls = [];
  let num = 0;
  const context = vm.createContext({ document, window, URLSearchParams, Blob, AbortController, setTimeout, clearTimeout,
    URL: { createObjectURL: () => { const url = `blob:${++num}`; urls.push(url); return url; }, revokeObjectURL: url => revoked.push(url) },
    Image: class extends Element { set src(value) { if (value) queueMicrotask(() => options.decodeError ? this.onerror?.() : this.onload?.()); } },
    require: name => {
      if (name === './lib/immersive.cjs') return { observeFullscreen: () => () => {} };
      if (name === './lib/retry.cjs') return { retry:(work,opts)=>require('../lib/retry.cjs').retry(work,{...opts,delays:options.retryDelays || [0,0,0]}) };
      if (name === './lib/video.cjs') return { prepareVideo: options.prepareVideo || (async () => { throw Error('unexpected video'); }) };
      assert.equal(name, './lib/archive.cjs');
      return { openArchive: async (_source, opts) => {
        if (options.open) await options.open();
        if (options.openError) throw new Error('bad ZIP');
        const handle = { pages: options.pages || [{name:'<script>.png'}, {name:'2.png'}, {name:'10.png'}], closed: false, encoding: opts.encoding,
          close() { this.closed = true; },
          async readPage(i) { reads.push(i); if (options.read) await options.read(i); if (options.badPage === i) throw new Error('bad image'); return { bytes: new Uint8Array([1]), mime:'image/png', name:this.pages[i].name }; } };
        handles.push(handle); return handle;
      } };
    }
  });
  vm.runInContext(fs.readFileSync(require.resolve('../viewer.js'), 'utf8'), context);
  return { elements, document, window, handles, reads, urls, revoked, context, focus,
    settled: () => vm.runInContext('queue', context) };
}
test('viewer renders cover, safe names, count, last/first boundaries, and fit', async () => {
  const h = harness(); await h.settled();
  const e = h.elements;
  assert.equal(e.counter.textContent, '1 / 3'); assert.equal(e.previous.disabled, true); assert.equal(e.page.hidden, false);
  assert.equal(e.pages.children[0].textContent, '1. <script>.png');
  e.pages.value = '2'; e.pages.fire('change'); await h.settled();
  assert.equal(e.counter.textContent, '3 / 3'); assert.equal(e.next.disabled, true);
  e.fit.value = 'width'; e.fit.fire('change'); assert.equal(e.stage.dataset.fit, 'width');
  h.window.fire('beforeunload'); assert.ok(h.handles[0].closed); assert.equal(h.revoked.length, h.urls.length);
});
test('rapid navigation coalesces stale requests and releases old image', async () => {
  const h = harness(); await h.settled();
  h.elements.next.fire('click'); h.elements.next.fire('click'); await h.settled();
  assert.deepEqual(h.reads, [0,2]); assert.equal(h.elements.counter.textContent,'3 / 3');
  assert.deepEqual(h.revoked,['blob:1']); h.window.fire('beforeunload');
});
test('a damaged page gives error and navigation recovers', async () => {
  const h = harness({badPage:1}); await h.settled();
  h.elements.next.fire('click'); await h.settled();
  assert.match(h.elements.status.textContent,/bad image/); assert.equal(h.elements.page.hidden,true);
  h.elements.next.fire('click'); await h.settled();
  assert.equal(h.elements.status.hidden,true); assert.equal(h.elements.page.hidden,false); h.window.fire('beforeunload');
});
test('reload closes old archive, refreshes encoding, and resets page', async () => {
  const h = harness(); await h.settled();
  h.elements.next.fire('click'); await h.settled();
  h.elements.encoding.value='cp437'; h.elements.encoding.fire('change'); await h.settled();
  assert.ok(h.handles[0].closed); assert.equal(h.handles[1].encoding,'cp437'); assert.equal(h.elements.counter.textContent,'1 / 3'); h.window.fire('beforeunload');
});
test('opening and decoder errors remain visible; failed URL is revoked', async () => {
  const a = harness({openError:true}); await a.settled();
  assert.match(a.elements.status.textContent,/bad ZIP/); assert.equal(a.elements.next.disabled,true);
  const b = harness({decodeError:true}); await b.settled();
  assert.match(b.elements.status.textContent,/Eagle/); assert.deepEqual(b.revoked,b.urls); b.window.fire('beforeunload');
});
test('newer request wins over in-flight read; unload stops queued work', async () => {
  let resume;
  const h = harness({read: i => i === 1 ? new Promise(resolve => {resume=resolve;}) : undefined}); await h.settled();
  h.elements.next.fire('click'); await new Promise(setImmediate);
  h.elements.next.fire('click'); resume(); await h.settled();
  assert.equal(h.elements.counter.textContent,'3 / 3'); assert.equal(h.elements.page.alt,'10.png');
  h.elements.previous.fire('click'); h.window.fire('beforeunload'); await h.settled();
  assert.ok(h.handles[0].closed); assert.deepEqual(h.revoked.sort(),h.urls.sort());
});
test('keyboard shortcuts do not steal select/button interactions or Escape', async () => {
  const h = harness(); await h.settled(); let prevented=0;
  const press=(key,tag='DIV')=>h.document.fire('keydown',{key,target:{tagName:tag},preventDefault:()=>prevented++});
  press('ArrowRight','SELECT'); press('Escape'); assert.equal(prevented,0);
  press('End'); await h.settled(); assert.equal(h.elements.counter.textContent,'3 / 3');
  press('Home'); await h.settled(); assert.equal(h.elements.counter.textContent,'1 / 3');
  press('f'); assert.equal(h.elements.stage.dataset.fit,'width'); h.window.fire('beforeunload');
});

test('video poster has an explicit open button; image navigation releases only through the handle', async () => {
  let opened = 0, released = 0;
  const h = harness({ pages: [{name:'1.mp4',kind:'video'}, {name:'2.png',kind:'image'}], prepareVideo: async () => ({
    poster: {bytes:new Uint8Array([1]),mime:'image/png',at:1}, openExternal:async()=>{opened++;}, release:async()=>{released++;}
  }) }); await h.settled();
  assert.equal(opened,0); assert.equal(h.elements['video-card'].hidden,false); assert.equal(h.elements.page.hidden,false);
  assert.equal(h.elements['video-note'].textContent,'');assert.equal(h.elements['video-note'].hidden,true);
  await h.elements['video-open'].events.click(); assert.equal(opened,1);
  h.elements.next.fire('click'); await h.settled();
  assert.equal(released,1); assert.equal(h.elements['video-card'].hidden,true); assert.equal(h.elements.page.alt,'2.png');
  h.window.fire('beforeunload');
});

test('unavailable poster still permits opening; shell failure is visible', async () => {
  const h = harness({ pages:[{name:'1.avi',kind:'video'}],prepareVideo:async()=>({posterError:'FFmpeg unavailable',release:async()=>{},openExternal:async()=>{throw Error('no player');}}) });
  await h.settled(); assert.equal(h.elements['video-open'].disabled,false); assert.equal(h.elements.page.hidden,true);
  assert.equal(h.elements['video-note'].textContent,'FFmpeg unavailable');
  await h.elements['video-open'].events.click(); assert.equal(h.elements['video-note'].textContent,'no player');
  assert.equal(h.elements['video-open'].disabled,false); h.window.fire('beforeunload');
});

test('navigation cancels a preparing video and releases a late handle without changing the current page', async () => {
  let resolve, signal, released=0;
  const h = harness({ pages:[{name:'1.mp4',kind:'video'},{name:'2.png',kind:'image'}],prepareVideo:async(_,__,opts)=>{signal=opts.signal;return new Promise(r=>{resolve=r;});} });
  await new Promise(setImmediate); h.elements.next.fire('click'); assert.ok(signal.aborted);
  resolve({release:async()=>{released++;}}); await h.settled();
  assert.equal(released,1); assert.equal(h.elements.page.alt,'2.png'); assert.equal(h.elements['video-card'].hidden,true);
  h.window.fire('beforeunload');
});

test('external button appears during extraction and becomes usable before a slow poster completes', async () => {
  let finishExtraction,finishPoster,opened=0;
  const handle={release:async()=>{},openExternal:async()=>{opened++;}};
  handle.posterReady=new Promise(resolve=>{finishPoster=()=>{handle.posterError='poster unavailable';resolve();};});
  const h=harness({pages:[{name:'large.mp4',kind:'video'}],prepareVideo:()=>new Promise(resolve=>{finishExtraction=()=>resolve(handle);})});
  await new Promise(setImmediate);
  assert.equal(h.elements['video-card'].hidden,false);assert.equal(h.elements['video-open'].disabled,true);
  finishExtraction();await new Promise(setImmediate);
  assert.equal(h.elements['video-open'].disabled,false);assert.equal(h.elements.page.hidden,true);
  await h.elements['video-open'].events.click();assert.equal(opened,1);
  finishPoster();await h.settled();assert.equal(h.elements['video-note'].textContent,'');assert.equal(h.elements['video-note'].hidden,true);
  assert.equal(h.elements['video-open'].disabled,false);h.window.fire('beforeunload');
});

test('all page errors retry at most three times, reopening the ZIP and keeping the selected page', async () => {
  let failures=0;
  const h=harness({read:i=>{if(i===1 && failures++<3)throw Object.assign(Error('temporary read failure'),{code:'ENOENT'});}});
  await h.settled();h.elements.next.fire('click');await h.settled();
  assert.equal(failures,4);assert.deepEqual(h.reads,[0,1,1,1,1]);assert.equal(h.elements.page.alt,'2.png');
  assert.equal(h.handles.length,4);assert.ok(h.handles.slice(0,-1).every(x=>x.closed));h.window.fire('beforeunload');
  const bad=harness({read:()=>{throw Object.assign(Error('corrupt image'),{code:'CRC'});}});
  await bad.settled();assert.equal(bad.reads.length,4);assert.match(bad.elements.status.textContent,/corrupt image/);bad.window.fire('beforeunload');
});

test('initial open errors also stop after three retries', async () => {
  let opens=0;
  const h=harness({open:()=>{opens++;throw Error('open unavailable');}});await h.settled();
  assert.equal(opens,4);assert.match(h.elements.status.textContent,/open unavailable/);h.window.fire('beforeunload');
});

test('page navigation and unload cancel scheduled retries', async () => {
  const h=harness({retryDelays:[1000,1000,1000],read:i=>{if(i===1)throw Error('retry later');}});
  await h.settled();h.elements.next.fire('click');await new Promise(setImmediate);
  h.elements.next.fire('click');await h.settled();assert.deepEqual(h.reads,[0,1,2]);assert.equal(h.elements.page.alt,'10.png');
  h.elements.previous.fire('click');await new Promise(setImmediate);h.window.fire('beforeunload');await h.settled();
  assert.deepEqual(h.reads,[0,1,2,1]);
});

test('external player failure is never automatically retried and successful launch adds no explanation', async () => {
  let opens=0;
  const h=harness({pages:[{name:'clip.mp4',kind:'video'}],prepareVideo:async()=>({posterReady:Promise.resolve(),release:async()=>{},openExternal:async()=>{opens++;if(opens===1)throw Object.assign(Error('launch failed'),{code:'ENOENT'});}})});
  await h.settled();await h.elements['video-open'].events.click();await new Promise(setImmediate);
  assert.equal(opens,1);assert.equal(h.elements['video-note'].textContent,'launch failed');
  await h.elements['video-open'].events.click();assert.equal(opens,2);assert.equal(h.elements['video-note'].hidden,true);h.window.fire('beforeunload');
});

test('navigation during an automatic reopen discards the old result and loads the new selection', async () => {
  let opens=0,resume,failed=false;
  const h=harness({open:()=>++opens===2?new Promise(resolve=>{resume=resolve;}):undefined,read:i=>{if(i===1&&!failed){failed=true;throw Error('reopen once');}}});
  await h.settled();h.elements.next.fire('click');
  while(!resume)await new Promise(setImmediate);
  h.elements.next.fire('click');resume();await h.settled();
  assert.deepEqual(h.reads,[0,1,2]);assert.equal(h.elements.page.alt,'10.png');assert.ok(h.handles[1].closed);
  h.window.fire('beforeunload');
});

test('normal interface has no explanatory caption or shortcut legend',()=>{
  const script=fs.readFileSync(require.resolve('../viewer.js'),'utf8'),html=fs.readFileSync(require.resolve('../index.html'),'utf8');
  assert.doesNotMatch(script,/サムネイル:|外部プレイヤーは今すぐ|再生中のファイルを守る/);
  assert.doesNotMatch(html,/Home \/ End|ページ送り ·|操作案内/);
  assert.match(html,/id="filename"/);assert.match(html,/外部プレイヤーで開く/);
});

test('startup focuses the viewer once so arrows work without an image click',async()=>{
  const h=harness();assert.equal(h.focus.window,1);assert.equal(h.focus.stage,1);assert.equal(h.focus.options.preventScroll,true);
  await h.settled();let prevented=0;
  h.document.fire('keydown',{key:'ArrowRight',target:h.document.activeElement,preventDefault:()=>prevented++});await h.settled();
  assert.equal(h.elements.counter.textContent,'2 / 3');assert.equal(prevented,1);
  h.elements.reload.fire('click');await h.settled();assert.equal(h.focus.stage,1);assert.equal(h.focus.window,1);
  h.window.fire('beforeunload');
  assert.match(fs.readFileSync(require.resolve('../index.html'),'utf8'),/id="stage"[^>]*tabindex="-1"/);
});

test('startup does not steal focus from controls or a hidden view, and host refusal is harmless',async()=>{
  for(const options of [{activeControl:true},{hidden:true}]) {
    const h=harness(options);await h.settled();assert.equal(h.focus.window,0);assert.equal(h.focus.stage,0);h.window.fire('beforeunload');
  }
  const restricted=harness({focusError:true});await restricted.settled();
  assert.equal(restricted.focus.stage,1);assert.equal(restricted.elements.counter.textContent,'1 / 3');restricted.window.fire('beforeunload');
});
