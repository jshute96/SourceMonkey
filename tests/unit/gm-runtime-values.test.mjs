// Unit tests for how src/wrapper-gm-runtime.js orders GM value updates
// (docs/GM-APIs-storage.md#ordering-writes): its own writes' answers,
// other tabs' broadcasts and resync snapshots, each carrying the worker's
// sequence number, in whatever order they arrive.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WRAPPER_GM_RUNTIME } from '../../dist/generated-wrappers.js';

const EXT_ID = 'abcdefghijklmnopabcdefghijklmnop';

// The runtime in USER_SCRIPT world, with every message to the worker
// held until the test answers it, and a way to push the worker's
// messages in.
function loadRuntime() {
  const sent = [];
  let onMessage = null;
  const chrome = { runtime: {
    id: EXT_ID,
    sendMessage: (msg) => new Promise((resolve) => { sent.push({ msg, answer: resolve }); }),
    onMessage: { addListener: (fn) => { onMessage = fn; } },
  } };
  const window = Object.create(globalThis);
  window.addEventListener = () => {};
  window.postMessage = () => {};
  const document = { visibilityState: 'visible', addEventListener: () => {}, dispatchEvent: () => true };
  new Function('window', 'document', 'chrome', WRAPPER_GM_RUNTIME)(window, document, chrome);
  const storage = window.__SM_GM__.storage;
  return {
    storage,
    // Messages of one type sent so far, oldest first.
    sentOf: (type) => sent.filter((s) => s.msg.type === type),
    push: (msg) => onMessage(msg, { id: EXT_ID }),
    update: (writes, seq) => onMessage({ type: 'sm:gm-value-update', scriptId: 's', writes, seq }, { id: EXT_ID }),
  };
}

// Lets the runtime's microtask send, and answer handlers, run.
const settle = () => new Promise((r) => setTimeout(r, 0));

test('writes made in one run go to the worker as one batch, a microtask later', async () => {
  const rt = loadRuntime();
  rt.storage.init('s', {}, 100);
  rt.storage.set('s', 'a', 1);
  rt.storage.set('s', 'b', 2);
  rt.storage.del('s', 'a');
  assert.equal(rt.sentOf('sm:gm-batch-write').length, 0);
  await settle();
  const batches = rt.sentOf('sm:gm-batch-write');
  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0].msg.writes, [
    { key: 'a', value: 1 }, { key: 'b', value: 2 }, { key: 'a', deleted: true },
  ]);
});

test('a broadcast for a key with an unanswered write waits, then applies if newer', async () => {
  const rt = loadRuntime();
  rt.storage.init('s', {}, 100);
  rt.storage.set('s', 'k', 'mine');
  await settle();
  rt.update([{ key: 'k', value: 'theirs' }], 102);
  assert.equal(rt.storage.get('s', 'k'), 'mine', 'held while ours is unanswered');
  rt.sentOf('sm:gm-batch-write')[0].answer({ ok: true, seq: 101 });
  await settle();
  assert.equal(rt.storage.get('s', 'k'), 'theirs', 'the worker took theirs last');
});

test('a held broadcast older than our answered write is dropped', async () => {
  const rt = loadRuntime();
  rt.storage.init('s', {}, 100);
  rt.storage.del('s', 'k');
  await settle();
  rt.update([{ key: 'k', value: 'theirs' }], 101);
  rt.sentOf('sm:gm-batch-write')[0].answer({ ok: true, seq: 102 });
  await settle();
  assert.equal(rt.storage.get('s', 'k', 'absent'), 'absent', 'our later delete stands');
});

test('a broadcast older than what the key already has is dropped', () => {
  const rt = loadRuntime();
  rt.storage.init('s', {}, 100);
  rt.update([{ key: 'k', value: 'new' }], 105);
  rt.update([{ key: 'k', value: 'old' }], 104);
  assert.equal(rt.storage.get('s', 'k'), 'new');
});

test('a batch writing one key twice applies both, in order', () => {
  const rt = loadRuntime();
  rt.storage.init('s', {}, 100);
  rt.update([{ key: 'k', value: 'x' }, { key: 'k', deleted: true }], 110);
  assert.equal(rt.storage.get('s', 'k', 'absent'), 'absent');
});

test('a broadcast at the snapshot\'s own number is already in it, and fires nothing', () => {
  const rt = loadRuntime();
  rt.storage.init('s', { k: 1 }, 200);
  const fired = [];
  rt.storage.addValueChangeListener('s', 'k', (...args) => fired.push(args));
  rt.update([{ key: 'k', value: 1 }], 200);
  assert.deepEqual(fired, []);
  rt.update([{ key: 'k', value: 2 }], 201);
  assert.deepEqual(fired, [['k', 1, 2, true]]);
});

test('a broadcast before the script starts is ignored; the worker\'s stale notice brings it in', async () => {
  const rt = loadRuntime();
  rt.update([{ key: 'k', value: 'missed' }], 150);
  rt.storage.init('s', {}, 100);
  assert.equal(rt.storage.get('s', 'k', 'absent'), 'absent');
  rt.push({ type: 'sm:gm-values-stale', scriptId: 's' });
  const resync = rt.sentOf('sm:gm-resync');
  assert.equal(resync.length, 1, 'a stale notice resyncs without a listener or rate limit');
  resync[0].answer({ ok: true, values: { k: 'missed' }, seq: 150 });
  await settle();
  assert.equal(rt.storage.get('s', 'k'), 'missed');
});

test('a resync that skips an unanswered key doesn\'t make a newer held broadcast look old', async () => {
  // The order from the code review: our write goes out, another tab's
  // newer write is held, then a resync reply (newer still, for an
  // unrelated key) beats the answer to ours.
  const rt = loadRuntime();
  rt.storage.init('s', { k: 'a0' }, 100);
  rt.storage.set('s', 'k', 'a');
  await settle();
  rt.update([{ key: 'k', value: 'b' }], 102);
  rt.push({ type: 'sm:gm-values-stale', scriptId: 's' });
  rt.sentOf('sm:gm-resync')[0].answer({ ok: true, values: { k: 'b', other: 1 }, seq: 103 });
  await settle();
  assert.equal(rt.storage.get('s', 'k'), 'a', 'the resync skips a key with an unanswered write');
  rt.sentOf('sm:gm-batch-write')[0].answer({ ok: true, seq: 101 });
  await settle();
  assert.equal(rt.storage.get('s', 'k'), 'b', 'the held broadcast is still newer than ours');
  assert.equal(rt.storage.get('s', 'other'), 1);
});

test('a late broadcast older than a resync doesn\'t undo it', async () => {
  // The key has its own number (101) from a broadcast; a resync current
  // to 103 then sets it, and a broadcast numbered 102 arrives after.
  const rt = loadRuntime();
  rt.storage.init('s', {}, 100);
  rt.update([{ key: 'k', value: 'x' }], 101);
  rt.push({ type: 'sm:gm-values-stale', scriptId: 's' });
  rt.sentOf('sm:gm-resync')[0].answer({ ok: true, values: { k: 'z' }, seq: 103 });
  await settle();
  rt.update([{ key: 'k', value: 'y' }], 102);
  assert.equal(rt.storage.get('s', 'k'), 'z');
});

test('a late broadcast older than a second init doesn\'t undo it', () => {
  const rt = loadRuntime();
  rt.storage.init('s', {}, 100);
  rt.update([{ key: 'k', value: 'x' }], 101);
  rt.storage.init('s', { k: 'z' }, 103);
  rt.update([{ key: 'k', value: 'y' }], 102);
  assert.equal(rt.storage.get('s', 'k'), 'z');
});

test('a write the worker didn\'t take releases its held broadcast', async () => {
  const rt = loadRuntime();
  rt.storage.init('s', {}, 100);
  rt.storage.set('s', 'k', 'mine');
  await settle();
  rt.update([{ key: 'k', value: 'theirs' }], 101);
  rt.sentOf('sm:gm-batch-write')[0].answer({ ok: false, error: 'refused' });
  await settle();
  assert.equal(rt.storage.get('s', 'k'), 'theirs');
});
