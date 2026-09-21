// Tests for src/refresh-targets.ts (compiled to dist/refresh-targets.js).
//
// Pure target selection behind the collections page's `?refresh_local`
// and `?refresh_file=<path>` triggers.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isLocalCollection,
  localRefreshTargets,
  pathRefreshTargets,
  pathsOverlap,
  refreshPathProblem,
  toFsPath,
} from '../../dist/refresh-targets.js';

// Minimal stand-ins for the stored shapes: the selectors only read
// `id` / `path` off a collection and `id` / `fileUrl` off a script.
function collection(id, path, scripts = []) {
  return { collection: { id, path }, scripts };
}
function script(id, fileUrl) {
  return { id, fileUrl };
}

const DIR = collection('c-dir', '/home/me/scripts', [
  script('s-a', 'file:///home/me/scripts/a.user.js'),
  script('s-b', 'file:///home/me/scripts/sub/b.user.js'),
]);
const MANIFEST = collection('c-man', '/home/me/other/script_manifest.json', [
  script('s-c', 'file:///home/me/other/c.user.js'),
]);
// A container may mix schemes; only its local rows are ever targets.
const CONTAINER = collection('c-local', 'container:file', [
  script('s-d', 'file:///home/me/loose/d.user.js'),
  script('s-e', 'file:///elsewhere/e.user.js'),
  script('s-web', 'https://example.com/web.user.js'),
]);
const HTTP = collection('c-http', 'https://example.com/scripts/');
const GITHUB = collection('c-gh', 'https://github.com/o/r/tree/main');
const ALL = [DIR, MANIFEST, CONTAINER, HTTP, GITHUB];

// ---------- classification ----------

test('isLocalCollection: local dirs, local manifests, and the file container', () => {
  assert.equal(isLocalCollection(DIR.collection), true);
  assert.equal(isLocalCollection(MANIFEST.collection), true);
  assert.equal(isLocalCollection(CONTAINER.collection), true);
  assert.equal(isLocalCollection(HTTP.collection), false);
  assert.equal(isLocalCollection(GITHUB.collection), false);
});

// ---------- path helpers ----------

test('toFsPath: decodes file:// URLs and drops trailing slashes', () => {
  assert.equal(toFsPath('file:///home/me/my%20scripts/'), '/home/me/my scripts');
  assert.equal(toFsPath('  /home/me/scripts/  '), '/home/me/scripts');
  assert.equal(toFsPath('/'), '/');
});

test('pathsOverlap: either containment direction, on `/` boundaries', () => {
  assert.equal(pathsOverlap('/a/b', '/a/b/c.user.js'), true);
  assert.equal(pathsOverlap('/a/b/c.user.js', '/a/b'), true);
  assert.equal(pathsOverlap('/a/b', '/a/b'), true);
  assert.equal(pathsOverlap('/a/b', '/a/bc'), false);
  assert.equal(pathsOverlap('/a/b', '/other'), false);
});

// ---------- refresh_local ----------

test('localRefreshTargets: scanned local collections whole, container rows one by one, nothing remote', () => {
  assert.deepEqual(localRefreshTargets(ALL), {
    collectionIds: ['c-dir', 'c-man'],
    scripts: [
      { id: 's-d', collectionId: 'c-local' },
      { id: 's-e', collectionId: 'c-local' },
    ],
  });
});

// ---------- refresh_file ----------

test('pathRefreshTargets: a file picks the scanning collection, not the script', () => {
  // Whole-collection so a sibling file added or renamed in the same
  // pass is noticed too.
  assert.deepEqual(pathRefreshTargets(ALL, '/home/me/scripts/a.user.js'), {
    collectionIds: ['c-dir'],
    scripts: [],
  });
});

test('pathRefreshTargets: a file the collection has never seen still selects it', () => {
  assert.deepEqual(pathRefreshTargets(ALL, '/home/me/scripts/sub/brand-new.user.js'), {
    collectionIds: ['c-dir'],
    scripts: [],
  });
});

test('pathRefreshTargets: a directory above several collections selects them all', () => {
  assert.deepEqual(pathRefreshTargets(ALL, '/home/me'), {
    collectionIds: ['c-dir', 'c-man'],
    scripts: [{ id: 's-d', collectionId: 'c-local' }],
  });
});

test('pathRefreshTargets: a manifest collection matches on its own directory', () => {
  assert.deepEqual(pathRefreshTargets(ALL, '/home/me/other/c.user.js'), {
    collectionIds: ['c-man'],
    scripts: [],
  });
});

test('pathRefreshTargets: container scripts are selected one by one', () => {
  assert.deepEqual(pathRefreshTargets(ALL, '/home/me/loose/d.user.js'), {
    collectionIds: [],
    scripts: [{ id: 's-d', collectionId: 'c-local' }],
  });
  assert.deepEqual(pathRefreshTargets(ALL, '/elsewhere'), {
    collectionIds: [],
    scripts: [{ id: 's-e', collectionId: 'c-local' }],
  });
});

test('pathRefreshTargets: file:// spelling matches the raw-path spelling', () => {
  assert.deepEqual(
    pathRefreshTargets(ALL, 'file:///home/me/scripts/a.user.js'),
    { collectionIds: ['c-dir'], scripts: [] },
  );
});

test('pathRefreshTargets: a path no local collection covers selects nothing', () => {
  assert.deepEqual(pathRefreshTargets(ALL, '/tmp/nowhere/x.user.js'), {
    collectionIds: [],
    scripts: [],
  });
});

test('pathRefreshTargets: a manifest listing a file outside its directory still matches', () => {
  const outside = collection('c-out', '/home/me/manifests/script_manifest.json', [
    script('s-f', 'file:///var/scripts/f.user.js'),
  ]);
  assert.deepEqual(pathRefreshTargets([outside], '/var/scripts/f.user.js'), {
    collectionIds: ['c-out'],
    scripts: [],
  });
});

test('pathRefreshTargets: an http collection is never selected, even for a file:// row', () => {
  // "Local" is the collection's own location — an http manifest that
  // happens to list a local file stays out of a local-only refresh.
  const httpManifest = collection('c-hman', 'https://example.com/script_manifest.json', [
    script('s-g', 'file:///home/me/scripts/g.user.js'),
  ]);
  assert.deepEqual(pathRefreshTargets([httpManifest], '/home/me/scripts/g.user.js'), {
    collectionIds: [],
    scripts: [],
  });
});

// ---------- refresh_file validation ----------

test('refreshPathProblem: accepts absolute paths and POSIX file:// URLs', () => {
  assert.equal(refreshPathProblem('/home/me/scripts'), null);
  assert.equal(refreshPathProblem('  /home/me/a.user.js  '), null);
  assert.equal(refreshPathProblem('file:///home/me/a.user.js'), null);
});

test('refreshPathProblem: rejects relative paths and http URLs on shape', () => {
  for (const bad of ['scripts/a.user.js', 'a.user.js', 'https://example.com/a.user.js']) {
    assert.match(refreshPathProblem(bad), /^Refresh path must be a file:\/\/ URL/);
    assert.ok(refreshPathProblem(bad).endsWith(bad), 'message echoes the offending value');
  }
});

test('refreshPathProblem: rejects file:// URLs whose path we would mangle', () => {
  // Both shapes lose information through `locationFsPath` — the host is
  // dropped, so the comparison would run against a different place than
  // the caller named.
  assert.match(refreshPathProblem('file://server/share/a.user.js'), /POSIX file:\/\/ URL/);
  assert.match(refreshPathProblem('file:///C:/scripts/a.user.js'), /POSIX file:\/\/ URL/);
});

test('refreshPathProblem: rejects anything resolving to the filesystem root', () => {
  for (const bad of ['/', 'file:///', 'file://']) {
    assert.match(refreshPathProblem(bad), /below the filesystem root/);
  }
});
