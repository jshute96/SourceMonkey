// Unit tests for the related-versions lookup (src/script-identity.ts):
// how a script is recognized as another copy of the one on screen.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

const { findRelatedVersions, identityKey, locationKey } = await import(
  '../../dist/script-identity.js'
);

// ---------- fixtures ----------

// Minimal stand-in for a parsed header: only the tags the lookup reads.
function header(tags) {
  return { tags: Object.entries(tags).map(([tag, value]) => ({ tag, value })) };
}

function script(over) {
  return {
    id: 'id-' + (over.relativePath ?? over.fileUrl),
    collectionId: 'src',
    relativePath: '',
    fileUrl: '',
    status: 'ok',
    size: 0,
    headerText: '',
    bodyText: '',
    header: null,
    matching: {},
    loadedAt: 0,
    enabled: true,
    ...over,
  };
}

function collection(over) {
  return {
    id: 'src',
    path: '/repo',
    lastRefreshedAt: 0,
    scriptIds: [],
    enabled: true,
    ...over,
  };
}

const NAMED = header({ name: 'Cool Script', namespace: 'https://example.com/ns' });

// ---------- identityKey ----------

test('identityKey pairs namespace with name', () => {
  assert.equal(identityKey(NAMED), 'https://example.com/ns\u0000Cool Script');
});

test('identityKey trims both fields', () => {
  assert.equal(
    identityKey(header({ name: '  Cool Script ', namespace: ' https://example.com/ns  ' })),
    'https://example.com/ns\u0000Cool Script',
  );
});

test('identityKey treats a missing namespace as the empty one', () => {
  assert.equal(identityKey(header({ name: 'Cool Script' })), '\u0000Cool Script');
});

test('identityKey is null without a name — nothing to key on', () => {
  assert.equal(identityKey(header({ namespace: 'https://example.com/ns' })), null);
  assert.equal(identityKey(header({ name: '   ' })), null);
  assert.equal(identityKey(null), null);
});

test('identityKey does not case-fold — other managers do not either', () => {
  assert.notEqual(identityKey(header({ name: 'Cool Script' })), identityKey(header({ name: 'cool script' })));
});

// ---------- locationKey ----------

test('locationKey collapses a file:// URL to its bare path', () => {
  assert.equal(locationKey('file:///home/me/a.user.js'), '/home/me/a.user.js');
  assert.equal(locationKey('/home/me/a.user.js'), '/home/me/a.user.js');
});

test('locationKey leaves http URLs alone', () => {
  assert.equal(locationKey('https://example.com/a.user.js'), 'https://example.com/a.user.js');
});

// ---------- findRelatedVersions ----------

// The case the whole feature exists for: a script inside a directory
// collection stores a repo-relative path, so only its absolute `fileUrl`
// can match a standalone install of the same file.
test('a collection copy matches a standalone copy on absolute URL', () => {
  const inRepo = script({
    id: 'repo-copy',
    collectionId: 'dir',
    relativePath: 'scripts/a.user.js',
    fileUrl: 'file:///home/me/userscripts/scripts/a.user.js',
    header: NAMED,
  });
  const standalone = script({
    id: 'own-copy',
    collectionId: 'container',
    relativePath: '/home/me/userscripts/scripts/a.user.js',
    fileUrl: 'file:///home/me/userscripts/scripts/a.user.js',
    header: NAMED,
  });
  const r = findRelatedVersions({
    scripts: [inRepo, standalone],
    collections: [collection({ id: 'dir' }), collection({ id: 'container', path: 'container:file' })],
    location: standalone.fileUrl,
    header: NAMED,
  });
  assert.deepEqual(r.sameLocation.map((x) => x.script.id).sort(), ['own-copy', 'repo-copy']);
  assert.equal(r.sameIdentity.length, 0);
});

test('same @name and @namespace from a different URL lands in sameIdentity', () => {
  const mirror = script({
    id: 'mirror',
    relativePath: 'https://mirror.example/a.user.js',
    fileUrl: 'https://mirror.example/a.user.js',
    header: NAMED,
  });
  const r = findRelatedVersions({
    scripts: [mirror],
    collections: [collection({ path: 'container:http' })],
    location: 'https://origin.example/a.user.js',
    header: NAMED,
  });
  assert.equal(r.sameLocation.length, 0);
  assert.deepEqual(r.sameIdentity.map((x) => x.script.id), ['mirror']);
});

test('the two lists are disjoint — a location match is never repeated', () => {
  const same = script({
    id: 'same',
    relativePath: 'https://origin.example/a.user.js',
    fileUrl: 'https://origin.example/a.user.js',
    header: NAMED,
  });
  const r = findRelatedVersions({
    scripts: [same],
    collections: [collection({ path: 'container:http' })],
    location: 'https://origin.example/a.user.js',
    header: NAMED,
  });
  assert.equal(r.sameLocation.length, 1);
  assert.equal(r.sameIdentity.length, 0);
  assert.equal(r.sameLocation[0].sameIdentity, true, 'still reports both relationships');
});

test('a different script at a different URL matches nothing', () => {
  const other = script({
    id: 'other',
    relativePath: 'https://elsewhere.example/b.user.js',
    fileUrl: 'https://elsewhere.example/b.user.js',
    header: header({ name: 'Other Script', namespace: 'https://example.com/ns' }),
  });
  const r = findRelatedVersions({
    scripts: [other],
    collections: [collection({ path: 'container:http' })],
    location: 'https://origin.example/a.user.js',
    header: NAMED,
  });
  assert.equal(r.sameLocation.length, 0);
  assert.equal(r.sameIdentity.length, 0);
});

test('an unparseable file still gets its location match', () => {
  const same = script({
    id: 'same',
    relativePath: 'https://origin.example/a.user.js',
    fileUrl: 'https://origin.example/a.user.js',
    header: null,
  });
  const r = findRelatedVersions({
    scripts: [same],
    collections: [collection({ path: 'container:http' })],
    location: 'https://origin.example/a.user.js',
    header: null,
  });
  assert.deepEqual(r.sameLocation.map((x) => x.script.id), ['same']);
});

test('each row carries the collection that holds it', () => {
  const s = collection({ id: 'dir', path: '/repo', displayName: 'My repo' });
  const row = script({
    id: 'row',
    collectionId: 'dir',
    relativePath: 'a.user.js',
    fileUrl: 'https://origin.example/a.user.js',
    header: NAMED,
  });
  const r = findRelatedVersions({
    scripts: [row],
    collections: [s],
    location: 'https://origin.example/a.user.js',
    header: NAMED,
  });
  assert.equal(r.sameLocation[0].collection.displayName, 'My repo');
});

test('a dangling collectionId yields a null collection rather than throwing', () => {
  const row = script({
    id: 'row',
    collectionId: 'gone',
    relativePath: 'a.user.js',
    fileUrl: 'https://origin.example/a.user.js',
    header: NAMED,
  });
  const r = findRelatedVersions({
    scripts: [row],
    collections: [],
    location: 'https://origin.example/a.user.js',
    header: NAMED,
  });
  assert.equal(r.sameLocation[0].collection, null);
});

// ---------- installTarget ----------

test('installTarget names the container a single-file install would land in', () => {
  const r = findRelatedVersions({
    scripts: [],
    collections: [],
    location: 'https://origin.example/a.user.js',
    header: NAMED,
  });
  assert.equal(r.installTarget.kind, 'http');
  assert.equal(r.installTarget.path, 'container:http');
  assert.equal(r.installTarget.collection, null, 'container does not exist yet');
});

test('installTarget resolves an existing container to its row', () => {
  const container = collection({ id: 'c', path: 'container:http' });
  const r = findRelatedVersions({
    scripts: [],
    collections: [container],
    location: 'https://origin.example/a.user.js',
    header: NAMED,
  });
  assert.equal(r.installTarget.collection.id, 'c');
});

test('installTarget is absent once the container already holds this URL', () => {
  const container = collection({ id: 'c', path: 'container:http' });
  const own = script({
    id: 'own',
    collectionId: 'c',
    relativePath: 'https://origin.example/a.user.js',
    fileUrl: 'https://origin.example/a.user.js',
    header: NAMED,
  });
  const r = findRelatedVersions({
    scripts: [own],
    collections: [container],
    location: 'https://origin.example/a.user.js',
    header: NAMED,
  });
  assert.equal(r.installTarget, undefined);
});

// A copy inside a repo collection is not a copy of your own, so the offer
// stands — this is the "already covered by a collection" case.
test('installTarget survives a copy that lives only in a collection', () => {
  const inRepo = script({
    id: 'repo',
    collectionId: 'dir',
    relativePath: 'a.user.js',
    fileUrl: 'https://origin.example/a.user.js',
    header: NAMED,
  });
  const r = findRelatedVersions({
    scripts: [inRepo],
    collections: [collection({ id: 'dir', path: 'https://origin.example/sourcemonkey.json' })],
    location: 'https://origin.example/a.user.js',
    header: NAMED,
  });
  assert.equal(r.sameLocation.length, 1);
  assert.equal(r.installTarget.path, 'container:http');
});

test('installTarget picks the github container for a github URL', () => {
  const r = findRelatedVersions({
    scripts: [],
    collections: [],
    location: 'https://raw.githubusercontent.com/o/r/main/a.user.js',
    header: NAMED,
  });
  assert.equal(r.installTarget.kind, 'github');
});

test('installTarget picks the file container for a local path', () => {
  const r = findRelatedVersions({
    scripts: [],
    collections: [],
    location: '/home/me/a.user.js',
    header: NAMED,
  });
  assert.equal(r.installTarget.kind, 'file');
});

test('no installTarget for something that is not a single-file input', () => {
  const r = findRelatedVersions({
    scripts: [],
    collections: [],
    location: 'https://origin.example/sourcemonkey.json',
    header: NAMED,
  });
  assert.equal(r.installTarget, undefined);
});
