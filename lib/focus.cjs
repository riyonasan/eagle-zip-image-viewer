'use strict';

// A Format Extension lives in a guest webview. Its script can run before Eagle
// finishes attaching/initializing that guest. Make one request after host-ready,
// not during evaluation, and abandon it as soon as the user takes over.
function focusOnOpen(win, doc, stage) {
  let stopped = false, scheduled = false, frame = null, deadline;
  const listeners = [];
  const idle = () => !doc.activeElement || doc.activeElement === doc.body || doc.activeElement === doc.documentElement;
  function listen(target, type, fn, capture = false) {
    target.addEventListener(type, fn, capture);
    listeners.push(() => target.removeEventListener(type, fn, capture));
  }
  function stop() {
    if (stopped) return;
    stopped = true;
    win.clearTimeout(deadline);
    if (frame !== null) win.cancelAnimationFrame(frame);
    for (const remove of listeners) remove();
  }
  function ready() {
    if (stopped || scheduled) return;
    scheduled = true;
    frame = win.requestAnimationFrame(() => {
      frame = null;
      if (stopped) return;
      const allowed = doc.visibilityState !== 'hidden' && !doc.prerendering && idle();
      stop(); // No later event, read completion or reload may take focus back.
      if (!allowed) return;
      try { win.focus(); } catch { /* The guest may reject focus. */ }
      try { stage.focus({ preventScroll: true }); } catch { /* Clicking still works. */ }
    });
  }
  if (doc.visibilityState === 'hidden' || doc.prerendering || !idle()) return stop;
  listen(doc, 'pointerdown', stop, true);
  listen(doc, 'keydown', stop, true);
  listen(doc, 'focusin', event => { if (event.target !== doc.body && event.target !== doc.documentElement) stop(); });
  listen(win, 'blur', stop);
  listen(win, 'beforeunload', stop);
  listen(doc, 'visibilitychange', () => { if (doc.visibilityState === 'hidden') stop(); });
  // Do not take focus unexpectedly if a host-ready notification arrives late.
  deadline = win.setTimeout(stop, 1500);
  try {
    if (typeof win.eagle?.onPluginRun === 'function') {
      win.eagle.onPluginRun(ready);
      return stop;
    }
  } catch { /* Older hosts may not support lifecycle registration. */ }
  if (doc.readyState === 'complete') ready();
  else listen(win, 'load', ready);
  return stop;
}

module.exports = { focusOnOpen };
