// Unit tests for the SW-side GM_* storage module (src/extension/gm-values.ts).

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

// chrome.storage.local stub. Backs a Map; supports get(null), get(key),
// get([keys]), set and remove. `getKeys` is installed per-test by
// `setGetKeysSupport` rather than here — see READ_MODES.
function installChromeStub() {
  const store = new Map();
  globalThis.chrome = {
    storage: {
      local: {
        async get(keys) {
          if (keys == null) {
            const out = {};
            for (const [k, v] of store) out[k] = v;
            return out;
          }
          if (Array.isArray(keys)) {
            const out = {};
            for (const k of keys) if (store.has(k)) out[k] = store.get(k);
            return out;
          }
          // single-key string
          const out = {};
          if (store.has(keys)) out[keys] = store.get(keys);
          return out;
        },
        async set(obj) {
          for (const [k, v] of Object.entries(obj)) store.set(k, v);
        },
        async remove(keys) {
          const arr = Array.isArray(keys) ? keys : [keys];
          for (const k of arr) store.delete(k);
        },
      },
    },
  };
  return store;
}

const store = installChromeStub();

// `loadAllValues` / `wipeScriptValues` prefer `chrome.storage.local
// .getKeys()` (Chrome 130+) — list names, filter, read only the
// matching rows — and fall back to a full `get(null)` scan when it is
// missing or throws. The narrow path is the one on the reload fast
// path, so both have to produce identical results and both are tested.
const READ_MODES = ['getKeys', 'no-getKeys', 'getKeys throws'];

function setGetKeysSupport(mode) {
  const local = globalThis.chrome.storage.local;
  if (mode === 'no-getKeys') delete local.getKeys;
  else if (mode === 'getKeys throws') {
    local.getKeys = async () => { throw new Error('getKeys unavailable'); };
  } else local.getKeys = async () => [...store.keys()];
}

const {
  valueKey,
  valueKeyPrefix,
  parseValueKey,
  loadAllValues,
  applyBatchValues,
  DELETED_SENTINEL,
  wipeScriptValues,
} = await import('../../dist/extension/gm-values.js');

test('valueKey composes gmval:<scriptId>:<key>', () => {
  assert.equal(valueKey('abc', 'foo'), 'gmval:abc:foo');
  // Colons in the user key are preserved (not split-on).
  assert.equal(valueKey('abc', 'foo:bar'), 'gmval:abc:foo:bar');
});

test('valueKeyPrefix yields the script-namespace prefix', () => {
  assert.equal(valueKeyPrefix('abc'), 'gmval:abc:');
});

test('parseValueKey strips the prefix and returns the user key', () => {
  assert.equal(parseValueKey('gmval:abc:foo', 'abc'), 'foo');
  // Colons in the user key survive.
  assert.equal(parseValueKey('gmval:abc:foo:bar', 'abc'), 'foo:bar');
  // Wrong script — returns null.
  assert.equal(parseValueKey('gmval:abc:foo', 'xyz'), null);
});

for (const mode of READ_MODES) {
  test(`[${mode}] loadAllValues returns only the script's values, stripping the prefix`, async () => {
    setGetKeysSupport(mode);
    store.clear();
    store.set('gmval:scriptA:foo', 'bar');
    store.set('gmval:scriptA:count', 7);
    store.set('gmval:scriptB:other', 'other-value');
    store.set('script:not-a-value', { unrelated: true });
    const got = await loadAllValues('scriptA');
    assert.deepEqual(got, { foo: 'bar', count: 7 });
  });

  test(`[${mode}] loadAllValues returns empty object when the script has no values`, async () => {
    setGetKeysSupport(mode);
    store.clear();
    store.set('gmval:other:foo', 'bar');
    const got = await loadAllValues('scriptA');
    assert.deepEqual(got, {});
  });

  // The prefix is `gmval:<id>:`, and a user key may contain `:` — so a
  // narrow read has to strip exactly the prefix, not split on colons.
  test(`[${mode}] loadAllValues keeps colons in the user key`, async () => {
    setGetKeysSupport(mode);
    store.clear();
    store.set('gmval:scriptA:a:b:c', 'deep');
    const got = await loadAllValues('scriptA');
    assert.deepEqual(got, { 'a:b:c': 'deep' });
  });

  // `gmval:scriptAA:` must not be picked up by a `gmval:scriptA:`
  // read — the prefix includes the trailing colon precisely for this.
  test(`[${mode}] loadAllValues does not match a script whose id is a prefix of another`, async () => {
    setGetKeysSupport(mode);
    store.clear();
    store.set('gmval:scriptA:mine', 1);
    store.set('gmval:scriptAA:theirs', 2);
    const got = await loadAllValues('scriptA');
    assert.deepEqual(got, { mine: 1 });
  });
}

test('applyBatchValues writes sets and removes deletes', async () => {
  store.clear();
  store.set('gmval:scriptA:keep', 'unchanged');
  const result = await applyBatchValues('scriptA', [
    { key: 'foo', value: 'bar' },
    { key: 'count', value: 42 },
    { key: 'keep', value: DELETED_SENTINEL },
  ]);
  assert.deepEqual(result.setKeys.sort(), ['count', 'foo']);
  assert.deepEqual(result.deletedKeys, ['keep']);
  assert.equal(store.get('gmval:scriptA:foo'), 'bar');
  assert.equal(store.get('gmval:scriptA:count'), 42);
  assert.equal(store.has('gmval:scriptA:keep'), false);
});

test('applyBatchValues: last write wins when the same key appears twice', async () => {
  store.clear();
  await applyBatchValues('s1', [
    { key: 'x', value: 'first' },
    { key: 'x', value: 'second' },
  ]);
  assert.equal(store.get('gmval:s1:x'), 'second');
});

test('applyBatchValues: delete-after-set leaves the row absent', async () => {
  store.clear();
  await applyBatchValues('s1', [
    { key: 'x', value: 'first' },
    { key: 'x', value: DELETED_SENTINEL },
  ]);
  assert.equal(store.has('gmval:s1:x'), false);
});

test('applyBatchValues: set-after-delete writes the new value', async () => {
  store.clear();
  store.set('gmval:s1:x', 'pre-existing');
  await applyBatchValues('s1', [
    { key: 'x', value: DELETED_SENTINEL },
    { key: 'x', value: 'restored' },
  ]);
  assert.equal(store.get('gmval:s1:x'), 'restored');
});

test('applyBatchValues: empty batch is a no-op', async () => {
  store.clear();
  store.set('gmval:s1:keep', 'unchanged');
  const r = await applyBatchValues('s1', []);
  assert.deepEqual(r.setKeys, []);
  assert.deepEqual(r.deletedKeys, []);
  assert.equal(store.get('gmval:s1:keep'), 'unchanged');
});

test('applyBatchValues: stores objects and arrays without flattening', async () => {
  store.clear();
  await applyBatchValues('s1', [
    { key: 'obj', value: { nested: { foo: 'bar' } } },
    { key: 'arr', value: [1, 2, 3] },
  ]);
  assert.deepEqual(store.get('gmval:s1:obj'), { nested: { foo: 'bar' } });
  assert.deepEqual(store.get('gmval:s1:arr'), [1, 2, 3]);
});

for (const mode of READ_MODES) {
  test(`[${mode}] wipeScriptValues removes only the script's rows`, async () => {
    setGetKeysSupport(mode);
    store.clear();
    store.set('gmval:s1:a', 1);
    store.set('gmval:s1:b', 2);
    store.set('gmval:s2:c', 3);
    store.set('script:other', 'unrelated');
    const removed = await wipeScriptValues('s1');
    assert.equal(removed, 2);
    assert.equal(store.has('gmval:s1:a'), false);
    assert.equal(store.has('gmval:s1:b'), false);
    assert.equal(store.get('gmval:s2:c'), 3);
    assert.equal(store.get('script:other'), 'unrelated');
  });

  test(`[${mode}] wipeScriptValues: no rows → returns 0`, async () => {
    setGetKeysSupport(mode);
    store.clear();
    const removed = await wipeScriptValues('s1');
    assert.equal(removed, 0);
  });
}
