// Tests for src/raw-view.ts (compiled to dist/raw-view.js).
//
// The script preview hands a fetched script to its raw-source tab
// through a session-storage row. These cover the key shape, the
// round-trip, and the rejection of keys we didn't mint.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const EXT_ID = 'mock-ext-id';
const sessionStore = new Map();

globalThis.chrome = {
  runtime: {
    getURL: (path) => `chrome-extension://${EXT_ID}/${path.replace(/^\//, '')}`,
  },
  storage: {
    session: {
      get: async (key) =>
        sessionStore.has(key) ? { [key]: sessionStore.get(key) } : {},
      set: async (obj) => {
        for (const [k, v] of Object.entries(obj)) sessionStore.set(k, v);
      },
      remove: async (key) => {
        sessionStore.delete(key);
      },
    },
  },
};

const { dropRawView, getRawView, isRawViewKey, putRawView, RAW_VIEW_PAGE, RAW_VIEW_PREFIX } =
  await import('../../dist/raw-view.js');

function keyFrom(url) {
  return new URL(url).searchParams.get('key');
}

test('put returns a raw.html URL carrying the key', async () => {
  const url = await putRawView({ title: 'foo.user.js', text: 'body' });
  assert.ok(url.startsWith(`chrome-extension://${EXT_ID}/${RAW_VIEW_PAGE}?`));
  assert.ok(isRawViewKey(keyFrom(url)));
});

test('round-trips title and text', async () => {
  const view = { title: 'foo.user.js', text: '// ==UserScript==\nline two\n' };
  const url = await putRawView(view);
  assert.deepEqual(await getRawView(keyFrom(url)), view);
});

test('each put gets its own key', async () => {
  const a = keyFrom(await putRawView({ title: 'a', text: 'a' }));
  const b = keyFrom(await putRawView({ title: 'b', text: 'b' }));
  assert.notEqual(a, b);
  assert.equal((await getRawView(a)).text, 'a');
});

test('drop makes the view unreadable', async () => {
  const key = keyFrom(await putRawView({ title: 'gone', text: 'gone' }));
  await dropRawView(key);
  assert.equal(await getRawView(key), null);
});

test('keys we did not mint are rejected without a storage read', async () => {
  // A hand-edited `?key=` must not turn the raw page into a dumper for
  // arbitrary session rows.
  sessionStore.set('gmval:secret:token', { title: 'x', text: 'secret' });
  assert.ok(!'gmval:secret:token'.startsWith(RAW_VIEW_PREFIX));
  assert.equal(isRawViewKey('gmval:secret:token'), false);
  assert.equal(await getRawView('gmval:secret:token'), null);
  assert.equal(await getRawView('rawview:'), null);
  assert.equal(await getRawView(''), null);
});

test('malformed rows read back as null', async () => {
  sessionStore.set('rawview:bad', { title: 'no text field' });
  assert.equal(await getRawView('rawview:bad'), null);
});

test('a missing title reads back as empty, not undefined', async () => {
  sessionStore.set('rawview:untitled', { text: 'body' });
  assert.deepEqual(await getRawView('rawview:untitled'), { title: '', text: 'body' });
});
