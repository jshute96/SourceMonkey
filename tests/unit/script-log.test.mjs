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
          return key in Object.fromEntries(store) || store.has(key)
            ? { [key]: store.get(key) }
            : {};
        }
        // get(null) → everything; not used here but matches the real shape
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
    source: 'wrapper',
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

test('appendScriptLog defaults timestamp to Date.now()', async () => {
  const before = Date.now();
  await appendScriptLog('s1', { level: 'info', source: 'x', message: 'now' });
  const after = Date.now();
  const entries = await getScriptLog('s1');
  assert.ok(entries[0].timestamp >= before && entries[0].timestamp <= after);
});
