// Unit tests for the SW-side `GM_getTab` / `GM_saveTab` / `GM_getTabs`
// store, over a stubbed `chrome.storage.session`.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

const session = new Map();
let setError = null;
// Fails the next write only.
let failNext = null;

globalThis.chrome = {
  storage: {
    session: {
      get: async (keys) => {
        assert.equal(keys, null);
        return Object.fromEntries(session);
      },
      set: async (items) => {
        if (setError) throw setError;
        if (failNext) { const err = failNext; failNext = null; throw err; }
        for (const [k, v] of Object.entries(items)) session.set(k, structuredClone(v));
      },
      remove: async (key) => { session.delete(key); },
    },
  },
};

const {
  getTabData,
  saveTabData,
  listTabData,
  dropTabData,
  forgetTabDataForTests,
} = await import('../../dist/extension/gm-tab-data.js');

function reset() {
  session.clear();
  setError = null;
  failNext = null;
  forgetTabDataForTests();
}

test('getTab gives {} at first and records the tab for getTabs', async () => {
  reset();
  assert.deepEqual(await getTabData(5, 's1'), {});
  assert.deepEqual(await listTabData('s1'), { 5: {} });
  assert.deepEqual(await listTabData('s2'), {});
});

test('saveTab stores a copy per tab and script', async () => {
  reset();
  const obj = { a: 1 };
  await saveTabData(5, 's1', obj);
  obj.a = 2;
  await saveTabData(6, 's1', { b: 2 });
  await saveTabData(5, 's2', { c: 3 });
  assert.deepEqual(await getTabData(5, 's1'), { a: 1 });
  assert.deepEqual(await listTabData('s1'), { 5: { a: 1 }, 6: { b: 2 } });
  assert.deepEqual(await listTabData('s2'), { 5: { c: 3 } });
});

test('saveTab with null or undefined saves nothing; a non-object is refused', async () => {
  reset();
  await saveTabData(5, 's1', { a: 1 });
  await saveTabData(5, 's1', null);
  await saveTabData(5, 's1', undefined);
  assert.deepEqual(await getTabData(5, 's1'), { a: 1 });
  await assert.rejects(saveTabData(5, 's1', 'x'), /must be an object/);
});

test('data survives a worker restart through session storage', async () => {
  reset();
  await saveTabData(5, 's1', { a: 1 });
  forgetTabDataForTests();
  assert.deepEqual(await getTabData(5, 's1'), { a: 1 });
});

test('closing a tab drops its data, in memory and in storage', async () => {
  reset();
  await saveTabData(5, 's1', { a: 1 });
  await saveTabData(6, 's1', { b: 2 });
  await dropTabData(5);
  assert.deepEqual(await listTabData('s1'), { 6: { b: 2 } });
  assert.equal(session.has('gmtab:5'), false);
  forgetTabDataForTests();
  assert.deepEqual(await listTabData('s1'), { 6: { b: 2 } });
});

test('a failed write leaves the old value', async () => {
  reset();
  await saveTabData(5, 's1', { a: 1 });
  setError = new Error('Quota exceeded');
  await assert.rejects(saveTabData(5, 's1', { a: 2 }), /Quota exceeded/);
  setError = null;
  assert.deepEqual(await getTabData(5, 's1'), { a: 1 });
});

test('a failed write puts back only its own script\'s entry', async () => {
  reset();
  await saveTabData(5, 's1', { a: 1 });
  // Fails s1's write only; s2's save lands in memory before s1's
  // failure rolls back, and has to survive it.
  failNext = new Error('Quota exceeded');
  const failing = saveTabData(5, 's1', { a: 2 });
  const other = saveTabData(5, 's2', { b: 1 });
  await assert.rejects(failing, /Quota exceeded/);
  await other;
  assert.deepEqual(await getTabData(5, 's1'), { a: 1 });
  assert.deepEqual(await getTabData(5, 's2'), { b: 1 });
});
