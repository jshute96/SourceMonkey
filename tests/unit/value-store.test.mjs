// Unit tests for the worker's value store (src/extension/value-store.ts),
// over a chrome.storage.local stub.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Rows, plus a log of the storage calls, and a gate that holds every
// `set` until released, to see what happens while a save is in flight.
const rows = new Map();
const calls = [];
let gate = null;
globalThis.chrome = {
  storage: {
    local: {
      async getKeys() { return [...rows.keys()]; },
      async get(keys) {
        const out = {};
        for (const k of keys ?? rows.keys()) if (rows.has(k)) out[k] = rows.get(k);
        return out;
      },
      async set(obj) {
        calls.push(['set', Object.keys(obj)]);
        if (gate) await gate.promise;
        for (const [k, v] of Object.entries(obj)) rows.set(k, v);
      },
      async remove(keys) {
        calls.push(['remove', keys]);
        for (const k of [].concat(keys)) rows.delete(k);
      },
    },
  },
};

function holdSaves() {
  let release;
  const promise = new Promise((r) => { release = r; });
  gate = { promise, release: () => { gate = null; release(); } };
  return gate;
}

const {
  readValues, writeValues, wipeValues, valueWritesSaved, forgetLoadedValues, onValueSaveFailed,
} = await import('../../dist/extension/value-store.js');

function reset() {
  rows.clear();
  calls.length = 0;
  forgetLoadedValues();
}

test('reads load the stored rows once', async () => {
  reset();
  rows.set('gmval:s1:a', 1);
  rows.set('gmval:s2:a', 2);
  const [x, y] = await Promise.all([readValues('s1'), readValues('s1')]);
  assert.deepEqual(x.values, { a: 1 });
  assert.deepEqual(y.values, { a: 1 });
  rows.set('gmval:s1:b', 3);
  assert.deepEqual((await readValues('s1')).values, { a: 1 }, 'served from memory');
});

test('a write is readable before it reaches disk', async () => {
  reset();
  const g = holdSaves();
  await writeValues('s1', [{ key: 'a', value: 1 }, { key: 'gone', deleted: true }]);
  assert.deepEqual((await readValues('s1')).values, { a: 1 });
  assert.equal(rows.has('gmval:s1:a'), false);
  g.release();
  await valueWritesSaved();
  assert.equal(rows.get('gmval:s1:a'), 1);
});

test('sequence numbers increase, and a snapshot is current to the last one', async () => {
  reset();
  const first = await writeValues('s1', [{ key: 'a', value: 1 }]);
  const second = await writeValues('s2', [{ key: 'a', value: 1 }]);
  assert.ok(second > first);
  assert.ok((await readValues('s1')).seq >= second);
  await valueWritesSaved();
});

test('writes made while a save is in flight go to disk together, latest winning', async () => {
  reset();
  const g = holdSaves();
  await writeValues('s1', [{ key: 'a', value: 1 }]);
  await writeValues('s1', [{ key: 'a', value: 2 }, { key: 'b', value: 1 }]);
  await writeValues('s1', [{ key: 'b', deleted: true }]);
  g.release();
  await valueWritesSaved();
  assert.deepEqual(calls, [['set', ['gmval:s1:a']], ['set', ['gmval:s1:a']], ['remove', ['gmval:s1:b']]]);
  assert.equal(rows.get('gmval:s1:a'), 2);
  assert.equal(rows.has('gmval:s1:b'), false);
});

test('an empty write leaves nothing to wait for', async () => {
  reset();
  await writeValues('s1', []);
  // Counted in turns rather than timed: a wait that never ends here
  // spins on settled promises, which holds off every timer.
  const settles = async (promise) => {
    let done = false;
    void promise.then(() => { done = true; });
    for (let i = 0; i < 20 && !done; i++) await null;
    return done;
  };
  assert.equal(await settles(valueWritesSaved()), true);
  // A wipe waits for the script's save the same way.
  assert.equal(await settles(wipeValues('s1')), true);
  assert.deepEqual(calls.filter(([op]) => op === 'set'), []);
});

test('wipe removes saved and unsaved values', async () => {
  reset();
  rows.set('gmval:s1:old', 1);
  const g = holdSaves();
  await writeValues('s1', [{ key: 'a', value: 1 }]);
  const wiped = wipeValues('s1');
  g.release();
  await wiped;
  assert.deepEqual((await readValues('s1')).values, {});
  await valueWritesSaved();
  assert.deepEqual([...rows.keys()], []);
});

test('a write whose map can\'t be loaded is refused and reported once', async () => {
  reset();
  const reported = [];
  onValueSaveFailed((id, err) => reported.push([id, err.message]));
  const local = globalThis.chrome.storage.local;
  const { getKeys, get } = local;
  local.getKeys = async () => { throw new Error('no keys'); };
  local.get = async () => { throw new Error('read failed'); };
  try {
    await assert.rejects(writeValues('s1', [{ key: 'a', value: 1 }]), /read failed/);
    await assert.rejects(writeValues('s1', [{ key: 'a', value: 2 }]), /read failed/);
  } finally {
    Object.assign(local, { getKeys, get });
    onValueSaveFailed(() => undefined);
  }
  assert.deepEqual(reported, [['s1', 'read failed']]);
  assert.deepEqual(calls, [], 'nothing went to disk');
});

test('nothing but the value store uses the row layer', () => {
  const src = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../src');
  const found = [];
  const walk = (dir) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (/\.(ts|js)$/.test(ent.name) && !p.endsWith('value-store.ts') && !p.endsWith('gm-values.ts')) {
        for (const m of readFileSync(p, 'utf8').matchAll(/import\s+(?!type\b)\{([^}]*)\}\s+from\s+'[^']*gm-values\.js'/g)) {
          const names = m[1].split(',').map((n) => n.trim().split(/\s+as\s+/)[0]).filter(Boolean);
          // The row prefix is only a name, for telling rows apart.
          const others = names.filter((n) => n !== 'VALUE_PREFIX');
          if (others.length) found.push(`${path.relative(src, p)}: ${others.join(', ')}`);
        }
      }
    }
  };
  walk(src);
  assert.deepEqual(found, [], 'Go through value-store.ts instead.');
});
