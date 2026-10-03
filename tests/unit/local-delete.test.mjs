import test from 'node:test';
import assert from 'node:assert/strict';

import { copyDeletePlan, deletableCopyPath, deleteCopyFiles } from '../../dist/extension/local-delete.js';

const DIR = '/home/me/Downloads';
const COPIES = '/home/me/Downloads/SourceMonkey';
const SETTING = { downloadsDir: DIR, collectionId: 'c-1' };
// The collection a deletable row has to be in: the directory collection
// at the copies directory itself.
const COPIES_COLLECTION = { path: COPIES };

// A stored row with just the fields the delete logic reads.
function script(overrides = {}) {
  return {
    id: 'id-1',
    collectionId: 'c-1',
    relativePath: 'hello.user.js',
    fileUrl: `file://${COPIES}/hello.user.js`,
    status: 'ok',
    size: 10,
    headerText: '',
    bodyText: '',
    header: null,
    matching: {},
    loadedAt: 0,
    enabled: true,
    ...overrides,
  };
}

// A `@require` entry as the store holds it, with the local stand-in the
// load pipeline actually read from.
function req(url, localPath) {
  return { url, source: '', contentHash: 'h', ...(localPath ? { localUrl: `file://${localPath}` } : {}) };
}

test('deletableCopyPath accepts a file under the copies directory', () => {
  assert.equal(deletableCopyPath(script(), COPIES_COLLECTION, SETTING), `${COPIES}/hello.user.js`);
  assert.equal(
    deletableCopyPath(
      script({ fileUrl: `file://${COPIES}/sub/hello.user.js` }), COPIES_COLLECTION, SETTING),
    `${COPIES}/sub/hello.user.js`,
  );
  // However the collection was spelled when it was added.
  assert.equal(
    deletableCopyPath(script(), { path: `file://${COPIES}/` }, SETTING),
    `${COPIES}/hello.user.js`,
  );
});

test('deletableCopyPath refuses anything else', () => {
  // Elsewhere on disk, on the web, the copies directory itself, no
  // setting yet, and a row whose file has already gone.
  const at = (overrides) => deletableCopyPath(script(overrides), COPIES_COLLECTION, SETTING);
  assert.equal(at({ fileUrl: 'file:///home/me/scripts/a.user.js' }), null);
  assert.equal(at({ fileUrl: 'https://example.com/a.user.js' }), null);
  assert.equal(at({ fileUrl: `file://${COPIES}` }), null);
  assert.equal(deletableCopyPath(script(), COPIES_COLLECTION, null), null);
});

test('deletableCopyPath refuses a row filed outside the copies collection', () => {
  // The file is in the copies directory, but the row belongs somewhere
  // else — a script the user added by hand at that path, say. Deleting
  // through it would compute the shared/own split against the wrong
  // collection's scripts.
  assert.equal(deletableCopyPath(script(), { path: 'container:file' }, SETTING), null);
  assert.equal(deletableCopyPath(script(), { path: '/home/me/scripts' }, SETTING), null);
  assert.equal(deletableCopyPath(script(), { path: `${COPIES}/sub` }, SETTING), null);
  assert.equal(deletableCopyPath(script(), null, SETTING), null);
});

test('deletableCopyPath decodes a percent-encoded path', () => {
  assert.equal(
    deletableCopyPath(
      script({ fileUrl: `file://${COPIES}/my%20copy.user.js` }), COPIES_COLLECTION, SETTING),
    `${COPIES}/my copy.user.js`,
  );
});

test('copyDeletePlan lists the script and its own dependencies', () => {
  const s = script({
    requires: [req('https://cdn.example.com/lib/util.js', `${COPIES}/cdn.example.com/lib/util.js`)],
    resources: [{ url: 'https://cdn.example.com/x.css', bytesBase64: '', contentHash: 'h', localUrl: `file://${COPIES}/cdn.example.com/x.css` }],
  });
  const plan = copyDeletePlan(s, [s], COPIES);
  assert.equal(plan.path, `${COPIES}/hello.user.js`);
  assert.equal(plan.relativePath, 'hello.user.js');
  assert.deepEqual(plan.own.map((d) => d.relativePath), [
    'cdn.example.com/lib/util.js',
    'cdn.example.com/x.css',
  ]);
  assert.deepEqual(plan.shared, []);
});

test('copyDeletePlan skips dependencies that are not local files under the copies directory', () => {
  const s = script({
    requires: [
      req('https://cdn.example.com/a.js'),                                   // loaded from the web
      req('https://cdn.example.com/b.js', '/home/me/scripts/b.js'),          // a stand-in elsewhere
    ],
  });
  assert.deepEqual(copyDeletePlan(s, [s], COPIES).own, []);
});

test('copyDeletePlan files a dependency another script loads as shared', () => {
  const url = 'https://cdn.example.com/lib/util.js';
  const local = `${COPIES}/cdn.example.com/lib/util.js`;
  const mine = script({ requires: [req(url, local)] });
  const theirs = script({
    id: 'id-2',
    relativePath: 'other.user.js',
    fileUrl: `file://${COPIES}/other.user.js`,
    requires: [req(url, local)],
  });
  const plan = copyDeletePlan(mine, [mine, theirs], COPIES);
  assert.deepEqual(plan.own, []);
  assert.equal(plan.shared.length, 1);
  assert.equal(plan.shared[0].relativePath, 'cdn.example.com/lib/util.js');
  assert.equal(plan.shared[0].url, url);
});

test('copyDeletePlan dedupes one file declared twice', () => {
  const local = `${COPIES}/cdn.example.com/lib/util.js`;
  const s = script({
    requires: [
      req('https://cdn.example.com/lib/util.js', local),
      req('https://cdn.example.com/lib/util.js?v=2', local),
    ],
  });
  assert.equal(copyDeletePlan(s, [s], COPIES).own.length, 1);
});

// ---------- The `chrome.downloads` half ----------

// A stand-in for the download history: records keyed by absolute path,
// with the calls the deletion makes recorded in order. `removeFile`
// refuses a record marked `exists: false` the way Chrome does, and the
// search filters on it the way `completedDownloads` asks it to.
function fakeDownloads(records) {
  const calls = [];
  const byId = new Map(records.map((r) => [r.id, { state: 'complete', exists: true, ...r }]));
  globalThis.chrome = {
    downloads: {
      async search({ filename, state, exists }) {
        calls.push(`search ${filename}`);
        return [...byId.values()].filter((r) => r.filename === filename
          && (state === undefined || r.state === state)
          && (exists === undefined || r.exists === exists));
      },
      async removeFile(id) {
        calls.push(`removeFile ${id}`);
        const item = byId.get(id);
        if (!item?.exists) throw new Error('Download file already deleted');
        item.exists = false;
      },
      async erase({ id }) {
        calls.push(`erase ${id}`);
        byId.delete(id);
      },
    },
  };
  return { calls, byId };
}

const SCRIPT = { path: `${COPIES}/hello.user.js`, relativePath: 'hello.user.js' };
const LIB = { path: `${COPIES}/lib/util.js`, relativePath: 'lib/util.js' };

test('the newest record for a path is the one deleted, and every record is erased after', async () => {
  // Two Replace copies wrote this path; only the later record's file is
  // the one on disk now.
  const { calls } = fakeDownloads([
    { id: 1, filename: SCRIPT.path, startTime: '2024-01-01T00:00:00Z' },
    { id: 2, filename: SCRIPT.path, startTime: '2024-06-01T00:00:00Z' },
  ]);
  const result = await deleteCopyFiles({ script: SCRIPT, dependencies: [] });
  assert.equal(result.scriptError, null);
  assert.deepEqual(calls, [`search ${SCRIPT.path}`, 'removeFile 2', 'erase 2', 'erase 1']);
});

test('a record whose file Chrome has marked gone is neither used nor erased', async () => {
  // The record exists but `exists: false`, so the search that asks for
  // live files finds nothing: nothing is removed, and the record is
  // left alone — it is the only handle on that file there will ever be.
  const { calls, byId } = fakeDownloads([
    { id: 1, filename: SCRIPT.path, exists: false, startTime: '2024-01-01T00:00:00Z' },
  ]);
  const result = await deleteCopyFiles({ script: SCRIPT, dependencies: [] });
  assert.match(result.scriptError, /^Script file is no longer in Chrome download history/);
  assert.deepEqual(calls, [`search ${SCRIPT.path}`]);
  assert.equal(byId.has(1), true);
});

test('a failed removeFile leaves the record in place and reports the reason', async () => {
  // The record says the file is live, but Chrome refuses at the moment
  // of the call — the answer went stale between the dialog and the
  // click. Erasing here would strand the file forever.
  const { calls, byId } = fakeDownloads([
    { id: 1, filename: SCRIPT.path, startTime: '2024-01-01T00:00:00Z' },
  ]);
  globalThis.chrome.downloads.removeFile = async (id) => {
    calls.push(`removeFile ${id}`);
    throw new Error('Download file already deleted');
  };
  const result = await deleteCopyFiles({ script: SCRIPT, dependencies: [] });
  assert.equal(result.scriptError, 'Deleting hello.user.js failed: Download file already deleted.');
  assert.deepEqual(calls, [`search ${SCRIPT.path}`, 'removeFile 1']);
  assert.equal(byId.has(1), true);
});

test('the script goes first, and a failure there leaves the dependencies alone', async () => {
  const { calls, byId } = fakeDownloads([
    { id: 1, filename: SCRIPT.path, exists: false, startTime: '2024-01-01T00:00:00Z' },
    { id: 2, filename: LIB.path, startTime: '2024-01-01T00:00:00Z' },
  ]);
  const result = await deleteCopyFiles({ script: SCRIPT, dependencies: [LIB] });
  assert.ok(result.scriptError);
  assert.deepEqual(result.dependencyErrors, []);
  assert.deepEqual(calls, [`search ${SCRIPT.path}`]);
  assert.equal(byId.has(2), true);
});

test('a dependency that cannot be deleted is reported, and the script still went', async () => {
  const { calls } = fakeDownloads([
    { id: 1, filename: SCRIPT.path, startTime: '2024-01-01T00:00:00Z' },
    { id: 2, filename: LIB.path, exists: false, startTime: '2024-01-01T00:00:00Z' },
  ]);
  const result = await deleteCopyFiles({ script: SCRIPT, dependencies: [LIB] });
  assert.equal(result.scriptError, null);
  assert.equal(result.dependencyErrors.length, 1);
  assert.match(result.dependencyErrors[0], /^File lib\/util\.js is no longer in Chrome download history/);
  assert.deepEqual(calls, [`search ${SCRIPT.path}`, 'removeFile 1', 'erase 1', `search ${LIB.path}`]);
});
