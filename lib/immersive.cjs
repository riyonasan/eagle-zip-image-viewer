'use strict';

// Observe the host's state; never toggle Eagle fullscreen or intercept F5.
// Unknown/failed responses retain the ordinary layout, not a size-based guess.
function observeFullscreen(win, doc) {
  let disposed = false, ticket = 0, resizeTimer = null;
  const media = win.matchMedia?.('(display-mode: fullscreen)');
  const cleanups = [];
  function listen(target, type, handler) {
    target.addEventListener(type, handler);
    cleanups.push(() => target.removeEventListener(type, handler));
  }
  async function update() {
    const mine = ++ticket;
    let native = false, timeout;
    try {
      const query = win.eagle?.window?.isFullScreen;
      if (typeof query === 'function') {
        native = await Promise.race([
          Promise.resolve(query.call(win.eagle.window)),
          new Promise(resolve => { timeout = win.setTimeout(() => resolve(false), 500); })
        ]);
      }
    } catch { /* A missing/older host API must not hide the controls. */ }
    finally { if (timeout !== undefined) win.clearTimeout(timeout); }
    if (!disposed && mine === ticket) {
      doc.body.classList.toggle('immersive', native === true || !!doc.fullscreenElement || !!media?.matches);
    }
  }
  function resize() {
    win.clearTimeout(resizeTimer);
    resizeTimer = win.setTimeout(() => { resizeTimer = null; void update(); }, 100);
  }
  listen(win, 'resize', resize);
  listen(win, 'focus', update);
  listen(doc, 'fullscreenchange', update);
  listen(doc, 'visibilitychange', update);
  if (media?.addEventListener) listen(media, 'change', update);
  // Mouse clicks must not pin bars open after leaving. Tab may reveal a focused
  // control so hidden controls remain reachable without a pointer.
  listen(doc, 'keydown', event => {
    if (event.key === 'Tab') doc.body.classList.add('keyboard-focus');
  });
  listen(doc, 'pointerdown', () => doc.body.classList.remove('keyboard-focus'));
  void update();
  return () => {
    disposed = true; ticket++;
    win.clearTimeout(resizeTimer);
    for (const cleanup of cleanups) cleanup();
  };
}

module.exports = { observeFullscreen };
