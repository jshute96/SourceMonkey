// Tests for src/extension/script-blobs.ts (compiled to
// dist/extension/script-blobs.js): storage format 2, where script rows
// point at their bodies in shared `blob:<sha256>` rows.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  carryBodyRef,
  droppedBlobRefs,
  fromStorage,
  hasSweepCandidates,
  hasInlineBodies,
  hydrateScriptRows,
  markMissingBlobs,
  migrateToBlobs,
  MIGRATE_BATCH,
  MISSING_BLOB_MESSAGE,
  STORE_FORMAT_KEY,
  storedForm,
  sweepUnusedBlobs,
  SWEEP_GRACE_MS,
  toStorage,
  withBlobs,
} from '../../dist/extension/script-blobs.js';
import { sha256Hex } from '../../dist/bytes.js';

// A fake `chrome.storage`: plain objects for `local` and `session`,
// plus a log of local `set`s. `failSetAfter` makes the local `set`
// after that many succeed throw, as a full store would.
let store;
let session;
let sets;
let failSetAfter;
function area(get) {
  return {
    async get(keys) {
      const data = get();
      if (keys === null) return structuredClone(data);
      const list = typeof keys === 'string' ? [keys] : keys;
      return Object.fromEntries(list.filter((k) => k in data).map((k) => [k, structuredClone(data[k])]));
    },
    async remove(keys) { for (const k of typeof keys === 'string' ? [keys] : keys) delete get()[k]; },
    async getKeys() { return Object.keys(get()); },
  };
}
beforeEach(() => {
  store = {};
  session = {};
  sets = [];
  failSetAfter = Infinity;
  globalThis.chrome = {
    storage: {
      local: {
        ...area(() => store),
        async set(items) {
          if (sets.length >= failSetAfter) throw new Error('QUOTA_BYTES quota exceeded');
          sets.push(Object.keys(items));
          Object.assign(store, structuredClone(items));
        },
      },
      session: { ...area(() => session), async set(items) { Object.assign(session, structuredClone(items)); } },
    },
  };
});

const script = (over = {}) => ({
  id: 's1',
  collectionId: 'c1',
  relativePath: 'a.user.js',
  fileUrl: 'file:///a.user.js',
  status: 'ok',
  size: 40,
  headerText: '// ==UserScript==\n// ==/UserScript==\n',
  bodyText: 'console.log(1);\n',
  header: null,
  matching: { matches: [], excludes: [], includes: [] },
  loadedAt: 1,
  enabled: true,
  ...over,
});

const req = (source) => ({ ref: 'lib.js', url: 'https://x/lib.js', size: source.length, contentHash: 'h', loadedAt: 1, source });
const res = (bytesBase64) => ({ ref: 'r.png', url: 'https://x/r.png', name: 'r', size: 3, contentHash: 'h', loadedAt: 1, contentType: 'image/png', bytesBase64 });

test('a row splits into a small row plus blobs, and reads back the same', async () => {
  const full = script({ requires: [req('lib();')], resources: [res('QUJD')] });
  const blobs = new Map();
  const row = await toStorage(full, blobs);

  assert.equal(row.bodyText, undefined);
  assert.equal(hasInlineBodies(row), false);
  assert.deepEqual(row.bodyBlobRef, { hash: await sha256Hex('console.log(1);\n'), size: 16 });
  assert.equal(row.requires[0].source, undefined);
  assert.equal(row.requires[0].blobRef.hash, await sha256Hex('lib();'));
  // The resource's key is the hash of its bytes, not of the base64.
  assert.equal(row.resources[0].blobRef.hash, await sha256Hex('ABC'));
  assert.deepEqual(row.resources[0].blobRef, { hash: await sha256Hex('ABC'), size: 3 });
  assert.equal(blobs.size, 3);

  Object.assign(store, Object.fromEntries(blobs));
  const [back] = await fromStorage([row]);
  assert.deepEqual(back, full);
});

test('identical bodies share one blob', async () => {
  const blobs = new Map();
  await toStorage(script({ id: 'a', headerText: '// v1' }), blobs);
  await toStorage(script({ id: 'b', headerText: '// v2' }), blobs);
  assert.equal(blobs.size, 1);
});

test('a require and a resource with the same bytes share a blob, read in either form', async () => {
  const blobs = new Map();
  // 'ABC' as text, and as base64 'QUJD'.
  const row = await toStorage(script({ requires: [req('ABC')], resources: [res('QUJD')] }), blobs);
  assert.equal(blobs.size, 2); // the body, and one shared file
  assert.equal(row.requires[0].blobRef.hash, row.resources[0].blobRef.hash);
  Object.assign(store, Object.fromEntries(blobs));
  const [back] = await fromStorage([row]);
  assert.equal(back.requires[0].source, 'ABC');
  assert.equal(back.resources[0].bytesBase64, 'QUJD');
});

test('a row that never loaded has no body ref, and reads back with an empty body', async () => {
  const row = await toStorage(script({ size: null, bodyText: '' }), new Map());
  assert.equal(row.bodyBlobRef, undefined);
  const [back] = await fromStorage([row]);
  assert.equal(back.bodyText, '');
  // An empty body that did load still gets a blob.
  const loaded = await toStorage(script({ size: 30, bodyText: '' }), new Map());
  assert.equal(loaded.bodyBlobRef.size, 0);
});

test('a format 1 row reads as it is', async () => {
  const full = script({ requires: [req('lib();')] });
  const [back] = await fromStorage([full]);
  assert.deepEqual(back, full);
});

test('a missing blob makes the script invalid and drops what would skip the refetch', async () => {
  const blobs = new Map();
  const row = await toStorage(script({ contentHash: 'c', httpEtag: 'e', requires: [req('lib();')] }), blobs);
  // Keep the require's blob, lose the body's.
  for (const [k, v] of blobs) if (k.endsWith(row.requires[0].blobRef.hash)) store[k] = v;
  const [back] = await fromStorage([row]);
  assert.equal(back.status, 'invalid');
  assert.equal(back.errorMessage, MISSING_BLOB_MESSAGE);
  assert.equal(back.contentHash, undefined);
  assert.equal(back.httpEtag, undefined);
  assert.equal(back.requires.length, 1);

  // A lost require is dropped, so a refresh fetches it like a new one,
  // and the script's own validators stay.
  store = {};
  for (const [k, v] of blobs) if (k.endsWith(row.bodyBlobRef.hash)) store[k] = v;
  const [back2] = await fromStorage([row]);
  assert.equal(back2.status, 'invalid');
  assert.equal(back2.requires.length, 0);
  assert.equal(back2.contentHash, 'c');
});

test('markMissingBlobs saves a row the way reading it shows a missing blob', async () => {
  const blobs = new Map();
  const row = await toStorage(script({ contentHash: 'c', httpEtag: 'e', requires: [req('lib();')] }), blobs);
  const all = Object.fromEntries(blobs);
  assert.equal(markMissingBlobs(row, all), null, 'nothing missing, nothing to save');

  const noBody = { ...all };
  delete noBody[`blob:${row.bodyBlobRef.hash}`];
  const marked = markMissingBlobs(row, noBody);
  assert.equal(marked.status, 'invalid');
  assert.equal(marked.errorMessage, MISSING_BLOB_MESSAGE);
  assert.equal(marked.contentHash, undefined);
  assert.equal(marked.httpEtag, undefined);
  assert.equal(marked.requires.length, 1);
  assert.equal(hasInlineBodies(marked), false, 'still a small row');

  const noLib = { ...all };
  delete noLib[`blob:${row.requires[0].blobRef.hash}`];
  const marked2 = markMissingBlobs(row, noLib);
  assert.equal(marked2.status, 'invalid');
  assert.equal(marked2.requires.length, 0);
  assert.equal(marked2.contentHash, 'c');

  const unknown = { ...all, [`blob:${row.bodyBlobRef.hash}`]: { encoding: 'zstd', data: '' } };
  assert.equal(markMissingBlobs(row, unknown).status, 'invalid', 'an unknown encoding counts as missing');

  assert.equal(markMissingBlobs(script(), {}), null, 'a body inline on the row is there');
});

test('withBlobs writes only blobs not already stored, and leaves other keys alone', async () => {
  const first = await withBlobs({ 'script:a': script({ id: 'a' }), other: 1 });
  assert.equal(first.other, 1);
  const blobKeys = Object.keys(first).filter((k) => k.startsWith('blob:'));
  assert.equal(blobKeys.length, 1);
  Object.assign(store, first);

  const second = await withBlobs({ 'script:b': script({ id: 'b' }) });
  assert.deepEqual(Object.keys(second), ['script:b']);
  // A row already small passes through untouched.
  const small = await withBlobs({ 'script:a': store['script:a'] });
  assert.deepEqual(small, { 'script:a': store['script:a'] });
});

test('hydrateScriptRows turns script values of a read into full scripts', async () => {
  const full = script({ id: 'a' });
  Object.assign(store, await withBlobs({ 'script:a': full, 'collection:c1': { id: 'c1' } }));
  const got = await hydrateScriptRows(await chrome.storage.local.get(['script:a', 'collection:c1']));
  assert.deepEqual(got['script:a'], full);
  assert.deepEqual(got['collection:c1'], { id: 'c1' });
});

test('migration converts format 1 rows once and records format 2', async () => {
  const a = script({ id: 'a', requires: [req('lib();')] });
  const b = script({ id: 'b' });
  store = { 'script:a': structuredClone(a), 'script:b': structuredClone(b), other: 1 };
  await migrateToBlobs();

  assert.equal(store[STORE_FORMAT_KEY], 2);
  assert.equal(hasInlineBodies(store['script:a']), false);
  assert.equal(hasInlineBodies(store['script:b']), false);
  // Two script bodies are the same bytes; plus the require.
  assert.equal(Object.keys(store).filter((k) => k.startsWith('blob:')).length, 2);
  const back = await fromStorage([store['script:a'], store['script:b']]);
  assert.deepEqual(back, [a, b]);

  // Already format 2: nothing more is written.
  sets = [];
  await migrateToBlobs();
  assert.deepEqual(sets, []);
});

test('a row half in each format reads each body as it finds it', async () => {
  const blobs = new Map();
  const row = await toStorage(script({ requires: [req('lib();')] }), blobs);
  Object.assign(store, Object.fromEntries(blobs));
  // An inline body beside blob-form requires, as a test edit makes.
  const [back] = await fromStorage([{ ...row, bodyText: 'edited();' }]);
  assert.equal(back.bodyText, 'edited();');
  assert.equal(back.requires[0].source, 'lib();');
  assert.equal(back.status, 'ok');
});

test('a leading byte-order mark survives a text read of a base64 blob', async () => {
  const blobs = new Map();
  // U+FEFF then "A", as UTF-8 bytes EF BB BF 41.
  const row = await toStorage(script({ resources: [res('77u/QQ==')] }), blobs);
  Object.assign(store, Object.fromEntries(blobs));
  const ref = row.resources[0].blobRef;
  const [back] = await fromStorage([{ ...row, requires: [{ ...req(''), source: undefined, blobRef: ref }] }]);
  assert.equal(back.requires[0].source, '\uFEFFA');
});

test('a blob in an encoding this build does not know reads as missing', async () => {
  const blobs = new Map();
  const row = await toStorage(script(), blobs);
  store[`blob:${row.bodyBlobRef.hash}`] = { encoding: 'gzip-base64', data: 'xyz' };
  const [back] = await fromStorage([row]);
  assert.equal(back.status, 'invalid');
  assert.equal(back.errorMessage, MISSING_BLOB_MESSAGE);
});

test('migration across several batches shares blobs between batches', async () => {
  const count = MIGRATE_BATCH * 2 + 3;
  for (let i = 0; i < count; i++) store[`script:${i}`] = script({ id: String(i), requires: [req('lib();')] });
  await migrateToBlobs();
  assert.equal(store[STORE_FORMAT_KEY], 2);
  // Three batches, then the format key.
  assert.equal(sets.length, 4);
  // Every row has the same body and require.
  assert.equal(Object.keys(store).filter((k) => k.startsWith('blob:')).length, 2);
  assert.ok(Object.keys(store).filter((k) => k.startsWith('script:')).every((k) => !hasInlineBodies(store[k])));
});

test('a failed migration stops for the session, and a later run finishes it', async () => {
  for (let i = 0; i < MIGRATE_BATCH * 2; i++) store[`script:${i}`] = script({ id: String(i), bodyText: `body${i}();` });
  failSetAfter = 1;
  await assert.rejects(migrateToBlobs());
  assert.equal(store[STORE_FORMAT_KEY], undefined);
  const converted = Object.keys(store).filter((k) => k.startsWith('script:') && !hasInlineBodies(store[k]));
  assert.equal(converted.length, MIGRATE_BATCH);

  // Not again this session.
  failSetAfter = Infinity;
  sets = [];
  await migrateToBlobs();
  assert.deepEqual(sets, []);

  // A new session finishes, converting only what's left.
  session = {};
  await migrateToBlobs();
  assert.equal(store[STORE_FORMAT_KEY], 2);
  assert.equal(sets.length, 2);
  const back = await fromStorage(Object.keys(store).filter((k) => k.startsWith('script:')).map((k) => store[k]));
  assert.deepEqual(back.map((s) => s.bodyText).sort(), [...Array(MIGRATE_BATCH * 2).keys()].map((i) => `body${i}();`).sort());
});

test('cleanup deletes a blob only once two checks a wait apart found it unused', async () => {
  Object.assign(store, await withBlobs({ 'script:a': script({ id: 'a' }), 'script:b': script({ id: 'b', bodyText: 'other();' }) }));
  const bKey = `blob:${store['script:b'].bodyBlobRef.hash}`;
  delete store['script:b'];

  const t0 = 1_000_000;
  assert.deepEqual(await sweepUnusedBlobs(t0), { checked: 2, removed: 0, waiting: 1 });
  assert.ok(bKey in store);
  // Too soon.
  assert.deepEqual(await sweepUnusedBlobs(t0 + SWEEP_GRACE_MS - 1), { checked: 2, removed: 0, waiting: 1 });
  assert.deepEqual(await sweepUnusedBlobs(t0 + SWEEP_GRACE_MS), { checked: 2, removed: 1, waiting: 0 });
  assert.ok(!(bKey in store));
  // The blob still in use stays.
  assert.ok(`blob:${store['script:a'].bodyBlobRef.hash}` in store);
});

test('cleanup keeps a blob a row points at again before the second check', async () => {
  Object.assign(store, await withBlobs({ 'script:a': script({ id: 'a' }) }));
  const row = store['script:a'];
  delete store['script:a'];
  await sweepUnusedBlobs(0);
  store['script:b'] = { ...row, id: 'b' };
  assert.deepEqual(await sweepUnusedBlobs(SWEEP_GRACE_MS), { checked: 1, removed: 0, waiting: 0 });
  assert.equal(Object.keys(store).filter((k) => k.startsWith('blob:')).length, 1);
});

test('droppedBlobRefs says when a change leaves a blob unused by that row', async () => {
  const a = await toStorage(script(), new Map());
  const edited = await toStorage(script({ bodyText: 'new();' }), new Map());
  assert.equal(droppedBlobRefs(a, undefined), true);
  assert.equal(droppedBlobRefs(a, edited), true);
  assert.equal(droppedBlobRefs(a, { ...a, enabled: false }), false);
  assert.equal(droppedBlobRefs(undefined, a), false);
});

// Counts SHA-256 digests while `fn` runs.
async function countDigests(fn) {
  const subtle = globalThis.crypto.subtle;
  const orig = subtle.digest;
  let n = 0;
  subtle.digest = function (...args) { n++; return orig.apply(subtle, args); };
  try { await fn(); } finally { subtle.digest = orig; }
  return n;
}

test('writing back what was read reuses the file entries\' hashes, and rewrites a lost blob', async () => {
  Object.assign(store, await withBlobs({ 'script:a': script({ id: 'a', requires: [req('lib();')], resources: [res('QUJD')] }) }));
  const [read] = await fromStorage([store['script:a']]);
  // The store's writers copy the script; the entries come along as they are.
  const copy = { ...read, enabled: false };
  let out;
  const digests = await countDigests(async () => { out = await withBlobs({ 'script:a': copy }); });
  // Only the body, whose script object is a new one.
  assert.equal(digests, 1);
  assert.deepEqual(out['script:a'].requires[0].blobRef, store['script:a'].requires[0].blobRef);
  assert.deepEqual(Object.keys(out), ['script:a']);

  // A reused ref whose blob is gone gets it written again.
  const libKey = `blob:${store['script:a'].requires[0].blobRef.hash}`;
  delete store[libKey];
  out = await withBlobs({ 'script:a': copy });
  assert.deepEqual(out[libKey], { encoding: 'text', data: 'lib();' });
});

test('carryBodyRef lets a rebuilt script with the same body skip hashing it', async () => {
  Object.assign(store, await withBlobs({ 'script:a': script({ id: 'a' }) }));
  const [read] = await fromStorage([store['script:a']]);
  const rebuilt = { ...read, loadedAt: 2 };
  carryBodyRef(read, rebuilt);
  let form;
  assert.equal(await countDigests(async () => { form = await storedForm(rebuilt); }), 0);
  assert.deepEqual(form.row.bodyBlobRef, store['script:a'].bodyBlobRef);

  // A different body is hashed after all.
  const changed = { ...read, bodyText: 'other();' };
  carryBodyRef(read, changed);
  const other = await storedForm(changed);
  assert.equal(other.row.bodyBlobRef.hash, await sha256Hex('other();'));
});

test('an entry changed after it was read is hashed again', async () => {
  Object.assign(store, await withBlobs({ 'script:a': script({ id: 'a', requires: [req('lib();')] }) }));
  const [read] = await fromStorage([store['script:a']]);
  read.requires[0].source = 'changed();';
  const out = await withBlobs({ 'script:a': read });
  assert.equal(out['script:a'].requires[0].blobRef.hash, await sha256Hex('changed();'));
});

test('hasSweepCandidates is true only while unused blobs wait', async () => {
  assert.equal(await hasSweepCandidates(), false);
  Object.assign(store, await withBlobs({ 'script:a': script({ id: 'a' }) }));
  delete store['script:a'];
  await sweepUnusedBlobs(0);
  assert.equal(await hasSweepCandidates(), true);
  await sweepUnusedBlobs(SWEEP_GRACE_MS);
  assert.equal(await hasSweepCandidates(), false);
});
