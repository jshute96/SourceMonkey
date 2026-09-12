// Unit tests for src/script-log.ts. Exercises the public API end-to-
// end against an in-memory chrome.storage.session stub so we cover the
// read/modify/write append loop, the per-script serialization, and the
// LOG_CAP rotation.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// In-memory chrome.storage.session stub. Each test resets the store
// via beforeEach. The script-log module pulls chrome.storage.session
// lazily through the chrome global; assigning before importing the
// module under test is sufficient.
const store = new Map();
globalThis.chrome = {
  storage: {
    session: {
      get: async (key) => {
        if (typeof key === 'string') {
          return store.has(key) ? { [key]: store.get(key) } : {};
        }
        if (Array.isArray(key)) {
          const out = {};
          for (const k of key) if (store.has(k)) out[k] = store.get(k);
          return out;
        }
        // get(null) → everything
        const out = {};
        for (const [k, v] of store) out[k] = v;
        return out;
      },
      set: async (obj) => {
        for (const [k, v] of Object.entries(obj)) store.set(k, v);
      },
      remove: async (key) => {
        if (Array.isArray(key)) {
          for (const k of key) store.delete(k);
        } else {
          store.delete(key);
        }
      },
    },
  },
  // Only the page-relay tests use this. `sendMessage` records what it
  // was handed, and `sendFails` makes it reject the way a missing
  // receiving end does.
  runtime: {
    sendMessage: async (msg) => {
      sent.push(msg);
      if (sendFails) throw new Error('Could not establish connection');
      return sendReply;
    },
  },
};

let sent = [];
let sendFails = false;
// What the worker answers. `true` is the ack; `undefined` is what Chrome
// resolves with when nothing handled the message, or when the handler
// threw — which is why the page has to read the reply, not just await
// it.
let sendReply = true;

// The module decides where to write by asking whether it is running in
// a page (`document` exists) or the service worker (it doesn't). Node
// has no `document`, so every other test in this file runs the worker
// path; these two helpers borrow the page one.
// Only safe because the modules read `isPageContext()` synchronously,
// before their first await — the `finally` runs while `fn`'s promise is
// still pending. An await placed ahead of that branch would break this.
function asPage(fn) {
  globalThis.document = {};
  try {
    return fn();
  } finally {
    delete globalThis.document;
  }
}

const {
  LOG_CAP,
  appendScriptLog,
  clearScriptLog,
  getScriptLog,
  getMaxLogLevel,
  getAllMaxLogLevels,
  logScriptEvent,
  forgetScriptLogs,
  handleScriptLogWrite,
  SCRIPT_LOG_WRITE_MESSAGE,
  _flushScriptLogQueueForTests,
} = await import('../../dist/script-log.js');

beforeEach(() => {
  store.clear();
  sent = [];
  sendFails = false;
  sendReply = true;
});

test('appendScriptLog persists an entry and getScriptLog returns it', async () => {
  await appendScriptLog('s1', {
    level: 'info',
    source: 'refresh',
    message: 'hello',
    timestamp: 1000,
  });
  const entries = await getScriptLog('s1');
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0], {
    timestamp: 1000,
    level: 'info',
    source: 'refresh',
    message: 'hello',
  });
});

test('appendScriptLog preserves tabId when provided', async () => {
  await appendScriptLog('s1', {
    level: 'error',
    source: 'script-wrapper',
    tabId: 42,
    message: 'boom',
    timestamp: 2000,
  });
  const entries = await getScriptLog('s1');
  assert.equal(entries[0].tabId, 42);
});

test('appendScriptLog drops tabId field when not provided', async () => {
  await appendScriptLog('s1', {
    level: 'info',
    source: 'refresh',
    message: 'plain',
  });
  const entries = await getScriptLog('s1');
  assert.equal('tabId' in entries[0], false);
});

test('appendScriptLog appends in order and preserves prior entries', async () => {
  await appendScriptLog('s1', { level: 'info', source: 'a', message: 'one', timestamp: 1 });
  await appendScriptLog('s1', { level: 'info', source: 'b', message: 'two', timestamp: 2 });
  await appendScriptLog('s1', { level: 'info', source: 'c', message: 'three', timestamp: 3 });
  const entries = await getScriptLog('s1');
  assert.deepEqual(entries.map((e) => e.message), ['one', 'two', 'three']);
});

test('concurrent appends to the same script are serialized without loss', async () => {
  // Issue N appends in parallel. Without the per-script queue, the
  // read/modify/write race would lose all but the last write.
  const N = 25;
  const pending = [];
  for (let i = 0; i < N; i++) {
    pending.push(appendScriptLog('s1', {
      level: 'info',
      source: 'refresh',
      message: `msg-${i}`,
      timestamp: i,
    }));
  }
  await Promise.all(pending);
  const entries = await getScriptLog('s1');
  assert.equal(entries.length, N);
  // Order is preserved because the queue is a strict promise chain.
  for (let i = 0; i < N; i++) {
    assert.equal(entries[i].message, `msg-${i}`);
  }
});

test('appends for different scripts do not interfere', async () => {
  await Promise.all([
    appendScriptLog('a', { level: 'info', source: 'x', message: 'A1', timestamp: 1 }),
    appendScriptLog('b', { level: 'info', source: 'x', message: 'B1', timestamp: 1 }),
    appendScriptLog('a', { level: 'info', source: 'x', message: 'A2', timestamp: 2 }),
    appendScriptLog('b', { level: 'info', source: 'x', message: 'B2', timestamp: 2 }),
  ]);
  const a = await getScriptLog('a');
  const b = await getScriptLog('b');
  assert.deepEqual(a.map((e) => e.message), ['A1', 'A2']);
  assert.deepEqual(b.map((e) => e.message), ['B1', 'B2']);
});

test('LOG_CAP drops oldest entries on overflow', async () => {
  for (let i = 0; i < LOG_CAP + 5; i++) {
    await appendScriptLog('s1', {
      level: 'info',
      source: 'refresh',
      message: `m${i}`,
      timestamp: i,
    });
  }
  const entries = await getScriptLog('s1');
  assert.equal(entries.length, LOG_CAP);
  // The oldest five should have been dropped.
  assert.equal(entries[0].message, 'm5');
  assert.equal(entries[entries.length - 1].message, `m${LOG_CAP + 4}`);
});

test('clearScriptLog wipes only the targeted script', async () => {
  await appendScriptLog('a', { level: 'info', source: 'x', message: 'A', timestamp: 1 });
  await appendScriptLog('b', { level: 'info', source: 'x', message: 'B', timestamp: 1 });
  await clearScriptLog('a');
  assert.deepEqual(await getScriptLog('a'), []);
  assert.equal((await getScriptLog('b')).length, 1);
});

test('logScriptEvent is fire-and-forget but its write lands', async () => {
  logScriptEvent('s1', {
    level: 'warning',
    source: 'icon',
    message: 'no favicon',
    timestamp: 7,
  });
  await _flushScriptLogQueueForTests('s1');
  const entries = await getScriptLog('s1');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].level, 'warning');
});

// ---------- Max-log-level tracking ----------

test('appendScriptLog seeds the max log level from the first entry', async () => {
  // First entry is info → max level = info. Promotes Status display
  // from "no logs" to "had info logs"; the column still shows OK but
  // the data is there for future surfacing.
  await appendScriptLog('s1', { level: 'info', source: 'x', message: 'hi', timestamp: 1 });
  assert.equal(await getMaxLogLevel('s1'), 'info');
});

test('appendScriptLog only bumps the max when the new entry is strictly higher', async () => {
  // Start at warning, then add info: max stays at warning. Then add
  // error: max promotes to error. Then add warning again: max stays
  // at error — once we've seen an error we don't go back down.
  await appendScriptLog('s1', { level: 'warning', source: 'x', message: 'w', timestamp: 1 });
  assert.equal(await getMaxLogLevel('s1'), 'warning');
  await appendScriptLog('s1', { level: 'info', source: 'x', message: 'i', timestamp: 2 });
  assert.equal(await getMaxLogLevel('s1'), 'warning');
  await appendScriptLog('s1', { level: 'error', source: 'x', message: 'e', timestamp: 3 });
  assert.equal(await getMaxLogLevel('s1'), 'error');
  await appendScriptLog('s1', { level: 'warning', source: 'x', message: 'w2', timestamp: 4 });
  assert.equal(await getMaxLogLevel('s1'), 'error');
});

test('an entry carrying a state is stored but never bumps the max log level', async () => {
  // A load-state transition (REFRESH FAILED, INVALID, …) is badged by
  // the row, which clears on recovery. If it also drove the sentinel,
  // the badge would fall through to WARNING for the rest of the session
  // after the row had recovered.
  await appendScriptLog('s1', {
    level: 'warning', state: 'refresh-failed', source: 'x', message: 'Refresh failed: HTTP 404', timestamp: 1,
  });
  assert.equal(await getMaxLogLevel('s1'), undefined);
  await appendScriptLog('s1', {
    level: 'error', state: 'invalid', source: 'x', message: 'bad', timestamp: 2,
  });
  assert.equal(await getMaxLogLevel('s1'), undefined);
  const entries = await getScriptLog('s1');
  assert.deepEqual(entries.map((e) => e.state), ['refresh-failed', 'invalid']);
  // A script-originated entry still counts.
  await appendScriptLog('s1', { level: 'warning', source: 'x', message: 'w', timestamp: 3 });
  assert.equal(await getMaxLogLevel('s1'), 'warning');
});

test('clearScriptLog wipes the max-log-level alongside the entries', async () => {
  await appendScriptLog('s1', { level: 'error', source: 'x', message: 'boom', timestamp: 1 });
  assert.equal(await getMaxLogLevel('s1'), 'error');
  await clearScriptLog('s1');
  assert.equal(await getMaxLogLevel('s1'), undefined);
});

test('getAllMaxLogLevels returns each script keyed by id', async () => {
  await appendScriptLog('a', { level: 'warning', source: 'x', message: 'a', timestamp: 1 });
  await appendScriptLog('b', { level: 'error',   source: 'x', message: 'b', timestamp: 1 });
  await appendScriptLog('c', { level: 'info',    source: 'x', message: 'c', timestamp: 1 });
  const all = await getAllMaxLogLevels();
  assert.equal(all.get('a'), 'warning');
  assert.equal(all.get('b'), 'error');
  assert.equal(all.get('c'), 'info');
  // Cleared scripts should drop out of the bulk result.
  await clearScriptLog('c');
  const after = await getAllMaxLogLevels();
  assert.equal(after.has('c'), false);
});

test('appendScriptLog defaults timestamp to Date.now()', async () => {
  const before = Date.now();
  await appendScriptLog('s1', { level: 'info', source: 'x', message: 'now' });
  const after = Date.now();
  const entries = await getScriptLog('s1');
  assert.ok(entries[0].timestamp >= before && entries[0].timestamp <= after);
});

// ---------- repeated messages ----------

test('appendScriptLog appends an identical message every time', async () => {
  // Callers reach here because they observed something, so the entry
  // is written whatever it says. A caller that fires on its own
  // schedule (the injector's per-sync pass) decides for itself whether
  // anything happened before calling.
  await appendScriptLog('s1', { level: 'error', source: 'a', message: 'boom' });
  await appendScriptLog('s1', { level: 'error', source: 'a', message: 'boom' });
  assert.equal((await getScriptLog('s1')).length, 2);
});


// ---------- Page → worker relay ----------
//
// `log:<id>` is read-modify-written, and the per-script queue that
// serializes those writes is module state — so it only orders the
// writes made in one JS context. Both write: the worker logs injection
// and refresh events, a page logs through the `script-store` code it
// shares with the worker, and the viewer's Clear log button removes the
// key. Two chains on one key drop entries, or resurrect ones a clear
// just removed. So a page hands every MUTATION to the worker and the
// worker's chain is the only one that touches the key.

test('a page hands its append to the worker instead of writing itself', async () => {
  await asPage(() => appendScriptLog('s1', {
    level: 'info', source: 'add', message: 'hello',
  }));
  assert.deepEqual(sent, [{
    type: SCRIPT_LOG_WRITE_MESSAGE,
    op: 'append',
    scriptId: 's1',
    input: { level: 'info', source: 'add', message: 'hello' },
  }]);
  // Nothing written locally: the worker owns the key.
  assert.deepEqual(await getScriptLog('s1'), []);
});

test('a page hands its clear to the worker too', async () => {
  await appendScriptLog('s1', { level: 'info', source: 'worker', message: 'kept' });
  await asPage(() => clearScriptLog('s1'));
  assert.deepEqual(sent, [{
    type: SCRIPT_LOG_WRITE_MESSAGE, op: 'clear', scriptId: 's1',
  }]);
  // Still there — the stub never delivered the message to a handler,
  // which is exactly the point: the page didn't do the removal itself.
  assert.equal((await getScriptLog('s1')).length, 1);
});

test('a page writes locally when the worker does not answer', async () => {
  sendFails = true;
  await asPage(() => appendScriptLog('s1', {
    level: 'warning', source: 'add', message: 'no receiving end',
  }));
  const entries = await getScriptLog('s1');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].message, 'no receiving end');
  assert.equal(await getMaxLogLevel('s1'), 'warning');
});

test('the worker side of the relay performs the write', async () => {
  await handleScriptLogWrite({
    op: 'append',
    scriptId: 's1',
    input: { level: 'error', source: 'relay', message: 'landed' },
  });
  assert.equal((await getScriptLog('s1'))[0].message, 'landed');
  assert.equal(await getMaxLogLevel('s1'), 'error');

  await handleScriptLogWrite({ op: 'clear', scriptId: 's1' });
  assert.deepEqual(await getScriptLog('s1'), []);
  assert.equal(await getMaxLogLevel('s1'), undefined);
});

test('a page writes locally when the worker answers without an ack', async () => {
  // The handler threw, so Chrome resolved the message with `undefined`
  // rather than rejecting it. Awaiting alone would read that as success
  // and drop the entry.
  sendReply = undefined;
  await asPage(() => appendScriptLog('s1', {
    level: 'info', source: 'add', message: 'unacked',
  }));
  assert.equal(sent.length, 1);
  const entries = await getScriptLog('s1');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].message, 'unacked');
});

test('an unacked clear is performed locally too', async () => {
  await appendScriptLog('s1', { level: 'info', source: 'worker', message: 'gone' });
  sendReply = undefined;
  await asPage(() => clearScriptLog('s1'));
  assert.deepEqual(await getScriptLog('s1'), []);
});

test('the worker writes directly, without a message', async () => {
  await appendScriptLog('s1', { level: 'info', source: 'worker', message: 'direct' });
  await clearScriptLog('s2');
  assert.deepEqual(sent, []);
  assert.equal((await getScriptLog('s1'))[0].message, 'direct');
});

test('a page relays one clear per script it forgets', async () => {
  await asPage(() => forgetScriptLogs(['s1', 's2']));
  assert.deepEqual(sent.map((m) => [m.op, m.scriptId]), [['clear', 's1'], ['clear', 's2']]);
});
