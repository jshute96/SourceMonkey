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
};

const {
  LOG_CAP,
  appendScriptLog,
  clearScriptLog,
  getScriptLog,
  getMaxLogLevel,
  getAllMaxLogLevels,
  logScriptEvent,
  _flushScriptLogQueueForTests,
} = await import('../../dist/script-log.js');

beforeEach(() => {
  store.clear();
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
