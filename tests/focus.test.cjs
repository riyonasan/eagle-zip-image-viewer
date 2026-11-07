'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { focusOnOpen } = require('../lib/focus.cjs');

class Target {
  listeners = new Map();
  addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  fire(type, event = {}) { for (const fn of [...(this.listeners.get(type) || [])]) fn(event); }
}
function harness(options = {}) {
  const win = new Target(), doc = new Target(), frames = new Map(), timers = new Map();
  const calls = [];
  let id = 0, run;
  Object.assign(doc, { body: {}, documentElement: {}, visibilityState: options.hidden ? 'hidden' : 'visible', prerendering: options.prerender, readyState: options.loaded ? 'complete' : 'loading' });
  doc.activeElement = options.control ? {} : doc.body;
  const stage = { focus: opts => { calls.push(['stage', opts]); doc.activeElement = stage; } };
  Object.assign(win, {
    setTimeout: (fn, delay) => { timers.set(++id, { fn, delay }); return id; },
    clearTimeout: key => timers.delete(key),
    requestAnimationFrame: fn => { frames.set(++id, fn); return id; },
    cancelAnimationFrame: key => frames.delete(key),
    focus: () => { calls.push(['window']); if (options.restricted) throw Error('restricted'); }
  });
  if (options.host !== false) win.eagle = { onPluginRun: fn => { if (options.registrationError) throw Error('unsupported'); run = fn; } };
  const stop = focusOnOpen(win, doc, stage);
  return { win, doc, stage, calls, timers, frames, stop, run: () => run?.(),
    paint: () => { const pending = [...frames.values()]; frames.clear(); for (const fn of pending) fn(); },
    expire: () => { for (const { fn } of [...timers.values()]) fn(); } };
}

test('Eagle readiness is later than script/load, and only its first run can request focus', () => {
  const h = harness();
  h.win.fire('load');h.paint();assert.equal(h.calls.length, 0);
  h.run();h.run();assert.equal(h.frames.size, 1);assert.equal(h.calls.length, 0);
  h.paint();assert.deepEqual(h.calls, [['window'], ['stage', { preventScroll: true }]]);
  assert.equal(h.timers.size, 0);
  h.doc.activeElement = h.doc.body;h.run();h.win.fire('load');h.paint();assert.equal(h.calls.length, 2);
});

test('without a lifecycle hook, load/first paint is used, including already loaded and rejected-hook hosts', () => {
  for (const options of [{ host:false }, { host:false, loaded:true }, { registrationError:true }]) {
    const h = harness(options);assert.equal(h.calls.length, 0);h.win.fire('load');h.paint();assert.equal(h.calls.length, 2);h.stop();
  }
});

test('user interaction, selected controls, blur, hidden state and unloading cancel pending focus', () => {
  for (const action of [h=>h.doc.fire('pointerdown'),h=>h.doc.fire('keydown'),h=>h.doc.fire('focusin',{target:{}}),h=>h.win.fire('blur'),h=>h.win.fire('beforeunload'),h=>{h.doc.visibilityState='hidden';h.doc.fire('visibilitychange');}]) {
    for (const afterReady of [false,true]) {
      const h = harness();if(afterReady)h.run();action(h);h.run();h.paint();assert.equal(h.calls.length,0);assert.equal(h.timers.size,0);
    }
  }
  const h=harness();h.run();h.doc.activeElement={};h.paint();assert.equal(h.calls.length,0);
});

test('background, prerendered and already interacted views never request focus', () => {
  for (const options of [{hidden:true},{prerender:true},{control:true}]) {
    const h=harness(options);h.doc.visibilityState='visible';h.run();h.paint();assert.equal(h.calls.length,0);assert.equal(h.timers.size,0);h.stop();
  }
});

test('late host notification and a delayed animation frame cannot take focus', () => {
  for (const alreadyScheduled of [false,true]) {
    const h=harness();assert.deepEqual([...h.timers.values()].map(x=>x.delay),[1500]);if(alreadyScheduled)h.run();h.expire();h.run();h.paint();assert.equal(h.calls.length,0);
  }
});

test('guest window refusal does not prevent a usable stage or produce repeated requests', () => {
  const h=harness({restricted:true});h.run();assert.doesNotThrow(()=>h.paint());assert.equal(h.doc.activeElement,h.stage);h.run();h.paint();assert.equal(h.calls.length,2);
});

test('pointer/automatic focus has no stage outline while Tab controls keep their focus cues', () => {
  const css=fs.readFileSync(require.resolve('../viewer.css'),'utf8');
  assert.match(css,/#stage:focus\s*\{\s*outline: none;/);
  assert.match(css,/\.keyboard-focus #stage:focus-visible\s*\{\s*outline: 2px/);
  assert.match(css,/button:focus-visible, select:focus-visible/);
  const script=fs.readFileSync(require.resolve('../lib/immersive.cjs'),'utf8');
  assert.match(script,/event.key === 'Tab'/);assert.match(script,/'pointerdown'.*classList.remove\('keyboard-focus'\)/);
});
