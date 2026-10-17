// Unit tests for the related-versions lookup (src/extension/script-identity.ts):
// how a script is recognized as another copy of the one on screen.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

const { enableChanges, findRelatedVersions, identityKey, installOptionsFor, locationKey } = await import(
  '../../dist/extension/script-identity.js'
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

// ---------- installOptions ----------

// The "Install into" dropdown's entries: the built-in default for the
// location's scheme first (existing or not), then every other
// container, each marked when it already holds this location.

test('installOptions leads with the scheme default, offered as new when it has no row', () => {
  const r = findRelatedVersions({
    scripts: [],
    collections: [],
    location: 'https://origin.example/a.user.js',
    header: NAMED,
  });
  assert.equal(r.installOptions.length, 1);
  const [def] = r.installOptions;
  assert.equal(def.isDefault, true);
  assert.equal(def.path, 'container:http');
  assert.equal(def.collection, null, 'container does not exist yet');
  assert.equal(def.label, 'Scripts from web');
  assert.equal(def.installed, false);
});

test('installOptions resolves an existing default to its row, under its own name', () => {
  const container = collection({ id: 'c', path: 'container:http', displayName: 'Web stuff' });
  const r = findRelatedVersions({
    scripts: [],
    collections: [container],
    location: 'https://origin.example/a.user.js',
    header: NAMED,
  });
  assert.equal(r.installOptions[0].collection.id, 'c');
  assert.equal(r.installOptions[0].label, 'Web stuff');
});

test('installOptions lists other containers after the default, in page order, never location collections', () => {
  const r = findRelatedVersions({
    scripts: [],
    collections: [
      collection({ id: 'mine', path: 'container:uuid-1', displayName: 'Mine' }),
      collection({ id: 'dir', path: '/home/me/scripts' }),
      collection({ id: 'c', path: 'container:http' }),
      collection({ id: 'local', path: 'container:file' }),
    ],
    location: 'https://origin.example/a.user.js',
    header: NAMED,
  });
  assert.deepEqual(
    r.installOptions.map((o) => [o.path, o.isDefault]),
    [['container:http', true], ['container:uuid-1', false], ['container:file', false]],
  );
});

test('installOptions marks a container that already holds this URL, and keeps the default first', () => {
  const container = collection({ id: 'c', path: 'container:http' });
  const other = collection({ id: 'o', path: 'container:uuid-1', displayName: 'Other' });
  const own = script({
    id: 'own',
    collectionId: 'c',
    relativePath: 'https://origin.example/a.user.js',
    fileUrl: 'https://origin.example/a.user.js',
    header: NAMED,
  });
  const r = findRelatedVersions({
    scripts: [own],
    collections: [other, container],
    location: 'https://origin.example/a.user.js',
    header: NAMED,
  });
  assert.deepEqual(
    r.installOptions.map((o) => [o.path, o.installed]),
    [['container:http', true], ['container:uuid-1', false]],
  );
});

// ---------- installOptionsFor's `current` (the move dropdown) ----------

// The move control asks the same question as Install into, plus which
// entry is where the script lives now.

test('current marks that container, and nothing else', () => {
  const options = installOptionsFor(
    'https://origin.example/a.user.js',
    [],
    [
      collection({ id: 'c', path: 'container:http' }),
      collection({ id: 'mine', path: 'container:uuid-1', displayName: 'Mine' }),
    ],
    'mine',
  );
  assert.deepEqual(
    options.map((o) => [o.path, o.isCurrent]),
    [['container:http', false], ['container:uuid-1', true]],
  );
});

// The list shape doesn't depend on which collection the script is in:
// every script gets the same entries, one of them marked.
test('current does not drop anything, not even the scheme default', () => {
  const collections = [
    collection({ id: 'c', path: 'container:http' }),
    collection({ id: 'mine', path: 'container:uuid-1', displayName: 'Mine' }),
  ];
  const loc = 'https://origin.example/a.user.js';
  const paths = (cur) => installOptionsFor(loc, [], collections, cur).map((o) => o.path);
  assert.deepEqual(paths('c'), ['container:http', 'container:uuid-1']);
  assert.deepEqual(paths('mine'), ['container:http', 'container:uuid-1']);
  assert.deepEqual(paths(undefined), ['container:http', 'container:uuid-1']);
});

test('an install asks without a current, so no entry claims to be one', () => {
  const options = installOptionsFor(
    'https://origin.example/a.user.js',
    [],
    [collection({ id: 'c', path: 'container:http' })],
  );
  assert.equal(options.every((o) => o.isCurrent === false), true);
});

// The synthesized default carries no row, so its id is `undefined` —
// which must not read as "no current was asked for" and match.
test('a not-yet-existing default is not current for an install', () => {
  const [def] = installOptionsFor('https://origin.example/a.user.js', [], []);
  assert.equal(def.collection, null);
  assert.equal(def.isCurrent, false);
});

// A copy inside a repo collection is not a copy of your own, so the
// default stays installable — this is the "already covered by a
// collection" case.
test('installOptions ignores a copy that lives only in a location collection', () => {
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
  assert.equal(r.installOptions[0].path, 'container:http');
  assert.equal(r.installOptions[0].installed, false);
});

test('installOptions picks the github default for a github URL', () => {
  const r = findRelatedVersions({
    scripts: [],
    collections: [],
    location: 'https://raw.githubusercontent.com/o/r/main/a.user.js',
    header: NAMED,
  });
  assert.equal(r.installOptions[0].path, 'container:github');
  assert.equal(r.installOptions[0].label, 'Scripts from GitHub');
});

test('installOptions picks the file default for a local path', () => {
  const r = findRelatedVersions({
    scripts: [],
    collections: [],
    location: '/home/me/a.user.js',
    header: NAMED,
  });
  assert.equal(r.installOptions[0].path, 'container:file');
  assert.equal(r.installOptions[0].label, 'Scripts from local disk');
});

// A disabled collection is a legitimate target — the user may be about
// to switch it back on — so it is marked, not dropped.
test('installOptions marks a disabled collection without removing it', () => {
  const off = collection({ id: 'off', path: 'container:uuid-1', displayName: 'Off', enabled: false });
  const r = findRelatedVersions({
    scripts: [],
    collections: [off],
    location: 'https://origin.example/a.user.js',
    header: NAMED,
  });
  assert.deepEqual(
    r.installOptions.map((o) => [o.path, o.collectionOff]),
    [['container:http', false], ['container:uuid-1', true]],
  );
});

test('no installOptions for something that is not a single-file input', () => {
  const r = findRelatedVersions({
    scripts: [],
    collections: [],
    location: 'https://origin.example/sourcemonkey.json',
    header: NAMED,
  });
  assert.equal(r.installOptions, undefined);
});

// ---------- sm-dev test collections ----------

test('sm-dev test collections are never install or move targets, and a run\'s script has none', () => {
  const collections = [
    collection({ id: 'c', path: 'container:http' }),
    collection({ id: 'run', path: 'container:sm-dev:D2-a3f9', displayName: 'sm-dev test collection (run D2-a3f9)' }),
  ];
  assert.deepEqual(installOptionsFor('https://origin.example/a.user.js', [], collections).map((o) => o.path), ['container:http']);
  assert.equal(installOptionsFor('scratch:///D2-a3f9/a.user.js', [], collections, 'run'), undefined);
});

// ---------- the exclusive enable ----------

test('enabling turns other running copies off, but never an sm-dev run\'s, nor for one', () => {
  const mine = collection({ id: 'mine', path: 'container:local' });
  const run = collection({ id: 'run', path: 'container:sm-dev:D1-ab12' });
  const row = (id, c) => ({ script: script({ id, collectionId: c.id }), collection: c, sameLocation: true, sameIdentity: false });
  const rows = [row('a', mine), row('b', mine), row('r', run)];
  assert.deepEqual(enableChanges('a', true, rows), [{ scriptId: 'a', enabled: true }, { scriptId: 'b', enabled: false }]);
  assert.deepEqual(enableChanges('r', true, rows), [{ scriptId: 'r', enabled: true }]);
  assert.deepEqual(enableChanges('a', false, rows), [{ scriptId: 'a', enabled: false }]);
});
