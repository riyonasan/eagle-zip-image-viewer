'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { observeFullscreen } = require('../lib/immersive.cjs');

class Events {
  constructor() { this.events = new Map(); }
  addEventListener(type, fn) { if (!this.events.has(type)) this.events.set(type, new Set()); this.events.get(type).add(fn); }
  removeEventListener(type, fn) { this.events.get(type)?.delete(fn); }
  fire(type, event = {}) { for (const fn of this.events.get(type) || []) fn(event); }
}
function fixture(query) {
  const win = new Events(), doc = new Events(), media = new Events(), classes = new Set(), timers = new Map();
  let timerId = 0;
  doc.body = { classList: { add: x => classes.add(x), remove: x => classes.delete(x), toggle: (x, on) => on ? classes.add(x) : classes.delete(x) } };
  win.innerWidth = 10000; win.innerHeight = 10000;
  win.matchMedia = () => media;
  win.setTimeout = (fn, ms) => { timers.set(++timerId, { fn, ms }); return timerId; };
  win.clearTimeout = id => timers.delete(id);
  if (query) win.eagle = { window: { isFullScreen: query } };
  const dispose = observeFullscreen(win, doc);
  return { win, doc, media, classes, timers, dispose,
    tick(ms) { for (const [id, timer] of [...timers]) if (timer.ms === ms) { timers.delete(id); timer.fn(); } },
    async settled() { for (let i = 0; i < 8; i++) await Promise.resolve(); }
  };
}

test('native fullscreen enter/exit updates only the layout; no dimension guessing', async () => {
  const absent = fixture(); await absent.settled(); assert.ok(!absent.classes.has('immersive')); absent.dispose();
  let full = true;
  const h = fixture(() => full); await h.settled(); assert.ok(h.classes.has('immersive'));
  full = false; h.win.fire('focus'); await h.settled(); assert.ok(!h.classes.has('immersive')); h.dispose();
});

test('unknown, failed and timed out native reads retain ordinary controls', async () => {
  for (const query of [() => undefined, () => 'true', () => { throw Error('unsupported'); }, () => Promise.reject(Error('unavailable'))]) {
    const h = fixture(query); await h.settled(); assert.ok(!h.classes.has('immersive')); assert.equal(h.timers.size, 0); h.dispose();
  }
  const h = fixture(() => new Promise(() => {})); h.tick(500); await h.settled();
  assert.ok(!h.classes.has('immersive')); assert.equal(h.timers.size, 0); h.dispose();
});

test('stale fullscreen reads cannot overwrite a newer state or update after disposal', async () => {
  const resolvers = [];
  const h = fixture(() => new Promise(resolve => resolvers.push(resolve)));
  h.win.fire('focus'); resolvers[1](false); await h.settled(); resolvers[0](true); await h.settled();
  assert.ok(!h.classes.has('immersive'));
  h.win.fire('focus'); h.dispose(); resolvers[2](true); await h.settled();
  assert.ok(!h.classes.has('immersive')); assert.equal(h.timers.size, 0);
});

test('HTML/display fullscreen events are supported without the optional Eagle API', async () => {
  const h = fixture(); h.doc.fullscreenElement = {}; h.doc.fire('fullscreenchange'); await h.settled(); assert.ok(h.classes.has('immersive'));
  h.doc.fullscreenElement = null; h.doc.fire('fullscreenchange'); await h.settled(); assert.ok(!h.classes.has('immersive'));
  h.media.matches = true; h.media.fire('change'); await h.settled(); assert.ok(h.classes.has('immersive'));
  h.media.matches = false; h.media.fire('change'); await h.settled(); assert.ok(!h.classes.has('immersive')); h.dispose();
});

test('resize is coalesced and cleanup removes listeners and scheduled work', async () => {
  let reads = 0; const h = fixture(() => { reads++; return false; }); await h.settled();
  h.win.fire('resize'); h.win.fire('resize'); h.win.fire('resize'); assert.equal(h.timers.size, 1);
  h.tick(100); await h.settled(); assert.equal(reads, 2);
  h.win.fire('resize'); h.dispose(); assert.equal(h.timers.size, 0);
  h.win.fire('resize'); h.win.fire('focus'); h.media.fire('change'); await h.settled(); assert.equal(reads, 2);
});

test('Tab reveals focused bars; pointer use clears it without intercepting F5 or arrows', () => {
  const h = fixture(); const event = { preventDefault() { assert.fail('must not intercept'); }, stopPropagation() { assert.fail('must not intercept'); } };
  h.doc.fire('keydown', { ...event, key: 'Tab' }); assert.ok(h.classes.has('keyboard-focus'));
  h.doc.fire('pointerdown'); assert.ok(!h.classes.has('keyboard-focus'));
  for (const key of ['F5', 'Escape', 'ArrowLeft', 'ArrowRight']) h.doc.fire('keydown', { ...event, key });
  assert.ok(!h.classes.has('keyboard-focus')); h.dispose();
});

test('fullscreen CSS overlays bars and retains keyboard/reduced-motion access', () => {
  const css = fs.readFileSync(require.resolve('../viewer.css'), 'utf8');
  const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
  assert.match(css, /\.immersive #stage\s*\{[^}]*position: absolute; inset: 0;/);
  assert.match(css, /\.immersive \.edge-panel\s*\{[^}]*position: fixed;[^}]*height: 10px;/);
  assert.match(css, /\.immersive \.edge-panel:hover/);
  assert.match(css, /\.immersive\.keyboard-focus \.edge-panel:focus-within/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(html, /<footer tabindex="0" aria-label=/);
});
