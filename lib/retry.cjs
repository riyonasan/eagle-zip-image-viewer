'use strict';
const { setTimeout: delay } = require('node:timers/promises');
// Preserve useful I/O diagnostics in archive.cjs. This is not a retry filter:
// retry() below handles every operation error except cancellation.
const TRANSIENT = new Set(['ENOENT', 'EIO', 'EBUSY', 'EMFILE', 'ENFILE', 'ETIMEDOUT', 'CLOSED']);
function isTransient(error) { return TRANSIENT.has(error?.code); }

async function retry(operation, { signal, delays = [250, 500, 1000] } = {}) {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    try { return await operation(attempt); }
    catch (error) {
      signal?.throwIfAborted();
      if (attempt >= 3 || error?.name === 'AbortError') throw error;
      await delay(delays[attempt] ?? 1000, undefined, { signal });
    }
  }
}

module.exports = { retry, isTransient };
