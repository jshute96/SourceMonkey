// Unit tests for the import planner (src/extension/import-plan.ts): what
// matches a backup's scripts here, how the copies compare, and what the
// dialog's choices do to each.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  actionFor,
  addingScripts,
  buildImportRequest,
  collectionScripts,
  contentText,
  DEFAULT_CHOICES,
  hereTitle,
  locationChange,
  planCollections,
  planImport,
  restorable,
  restorePath,
  updatable,
  valuesText,
  versionText,
} from '../../dist/extension/import-plan.js';
import { parseHeader } from '../../dist/userscript-header.js';

function text(name, version = '1.0', namespace = 'ns') {
  return `// ==UserScript==\n// @name ${name}\n// @namespace ${namespace}\n// @version ${version}\n// ==/UserScript==\n`;
}

function backupScript(index, name, over = {}) {
  const t = over.text ?? text(name, over.version);
  return {
    index, name, namespace: 'ns', version: over.version ?? '1.0', header: parseHeader(t), text: t,
    enabled: true, files: {}, ...over,
  };
}

function copy(id, name, over = {}) {
  return {
    id, collectionId: 'c', collectionName: 'Mine', fileUrl: `https://example.com/${id}.user.js`,
    header: parseHeader(text(name, over.version)), contentHash: `hash-${id}`, enabled: true, stored: false, inScripts: true, ...over,
  };
}

const backup = (scripts) => ({ source: 'tampermonkey', scripts, collections: [], problems: [] });

test('matches by id, then location, then namespace and name', () => {
  const scripts = [
    backupScript(0, 'ById', { foreignId: 'id-1' }),
    backupScript(1, 'ByImportRecord', { foreignId: 'tm-9' }),
    backupScript(2, 'ByLocation', { location: 'https://example.com/loc.user.js' }),
    backupScript(3, 'ByName'),
    backupScript(4, 'Fresh'),
  ];
  const installed = [
    copy('id-1', 'Renamed'),
    copy('imp', 'Other', { importedId: 'tm-9' }),
    copy('loc', 'Different'),
    copy('nm', 'ByName'),
  ];
  const plan = planImport(backup(scripts), installed, scripts.map(() => 'h'));
  assert.deepEqual(plan.map((p) => [p.match?.id, p.matchedBy]), [
    ['id-1', 'id'], ['imp', 'id'], ['loc', 'location'], ['nm', 'name'], [undefined, undefined],
  ]);
  assert.equal(plan[4].here, 'new');
});

test('an active copy is the one an update goes to', () => {
  const scripts = [backupScript(0, 'Dup')];
  const installed = [copy('off', 'Dup', { enabled: false, collectionName: 'Old' }), copy('on', 'Dup', { collectionName: 'New' })];
  const [p] = planImport(backup(scripts), installed, ['h']);
  assert.equal(p.match.id, 'on');
  assert.equal(p.copies.length, 2);
  assert.match(hereTitle(p), /Copies in: \* New, Old$/);
});

test('the Existing table shows installed values, and installed \u2192 backup where they differ', () => {
  const installed = [copy('a', 'A', { contentHash: 'h0' }), copy('b', 'B'), copy('c', 'C')];
  const plan = planImport(backup([
    backupScript(0, 'A'), backupScript(1, 'B', { version: '2.0' }), backupScript(2, 'C', { version: '0.9' }),
  ]), installed, ['h0', 'h1', 'h2']);
  assert.deepEqual(plan.map(versionText), ['1.0', '1.0 \u2192 2.0 (Newer)', '1.0 \u2192 0.9 (Older)']);
  assert.deepEqual(plan.map(contentText), ['Same', 'Different', 'Different']);

  const v = { a: 1 };
  assert.equal(valuesText({}, undefined), '');
  assert.equal(valuesText(v, undefined), '\u2713');
  assert.equal(valuesText({}, {}), '');
  assert.equal(valuesText({}, v), '\u2205 \u2192 \u2713');
  assert.equal(valuesText(v, {}), '\u2713 \u2192 \u2205');
  assert.equal(valuesText(v, { a: 1 }), '\u2713 (Same)');
  assert.equal(valuesText(v, { a: 1 }, false), '\u2713');
  assert.equal(valuesText(v, { a: 2 }), '\u2713 \u2192 \u2713 (Different)');
  // Key order doesn't count.
  assert.equal(valuesText({ a: { x: 1, y: 2 } }, { a: { y: 2, x: 1 } }), '\u2713 (Same)');
});

test('compares by text, then @version', () => {
  const scripts = [
    backupScript(0, 'Same'),
    backupScript(1, 'Up', { version: '2.0' }),
    backupScript(2, 'Down', { version: '0.5' }),
    backupScript(3, 'Edit'),
  ];
  const installed = [copy('s', 'Same', { contentHash: 'h0' }), copy('u', 'Up'), copy('d', 'Down'), copy('e', 'Edit')];
  const plan = planImport(backup(scripts), installed, ['h0', 'h1', 'h2', 'h3']);
  assert.deepEqual(plan.map((p) => p.here), ['same', 'older-here', 'newer-here', 'changed']);
});

test('the choices decide each script', () => {
  const scripts = [
    backupScript(0, 'Web', { location: 'https://example.com/w.user.js' }),
    backupScript(1, 'Edited', { location: 'https://example.com/e.user.js', userModified: true }),
    backupScript(2, 'Up', { version: '2.0', values: { a: 1 } }),
    backupScript(3, 'Kept', { version: '2.0', enabled: false }),
    backupScript(4, 'Same', { values: { b: 2 } }),
  ];
  const installed = [copy('u', 'Up'), copy('k', 'Kept', { stored: true }), copy('s', 'Same', { contentHash: 'h4' })];
  const plan = planImport(backup(scripts), installed, ['h0', 'h1', 'h2', 'h3', 'h4']);
  const act = ({ fresh = {}, existing = {} } = {}) => plan.map((p) => actionFor(p, {
    ...DEFAULT_CHOICES,
    new: { ...DEFAULT_CHOICES.new, ...fresh },
    existing: { ...DEFAULT_CHOICES.existing, ...existing },
  }));

  // The defaults: only a newer text changes an existing script.
  const newer = act();
  assert.deepEqual(newer[0], { kind: 'install', linkTo: 'https://example.com/w.user.js' });
  // Edited in the other manager: kept as its text.
  assert.deepEqual(newer[1], { kind: 'install' });
  // A copy that loads from its location takes the newer text too.
  assert.deepEqual(newer[2], { kind: 'update', text: true, values: false, enabled: false });
  assert.deepEqual(newer[3], { kind: 'update', text: true, values: false, enabled: false });
  assert.deepEqual(newer[4], { kind: 'skip' });

  // Values and enabled state apply whatever the text choice.
  const all = act({ existing: { values: true, enabled: true } });
  assert.deepEqual(all[2], { kind: 'update', text: true, values: true, enabled: false });
  assert.deepEqual(all[3], { kind: 'update', text: true, values: false, enabled: true });
  assert.deepEqual(all[4], { kind: 'update', text: false, values: true, enabled: false });
  assert.deepEqual(act({ existing: { text: 'leave' } }).slice(2).map((a) => a.kind), ['skip', 'skip', 'skip']);
  assert.deepEqual(act({ existing: { text: 'leave', enabled: true } })[3], { kind: 'update', text: false, values: false, enabled: true });
  assert.deepEqual(act({ existing: { text: 'always' } })[4], { kind: 'update', text: true, values: false, enabled: false });
  // Always replaces a stored copy's text even when it's the same.
  const same = planImport(backup([backupScript(0, 'Kept')]), [copy('k', 'Kept', { stored: true, contentHash: 'h0' })], ['h0']);
  assert.equal(same[0].here, 'same');
  assert.deepEqual(actionFor(same[0], { ...DEFAULT_CHOICES, existing: { ...DEFAULT_CHOICES.existing, text: 'always' } }),
    { kind: 'update', text: true, values: false, enabled: false });
});

test('the request carries what each kept row needs', () => {
  const scripts = [
    backupScript(0, 'New', { enabled: false, foreignId: 'tm-1', values: { a: 1 }, files: { 'x.js': { url: 'https://e.com/x.js', bytesBase64: '', contentType: 'text/javascript' } } }),
    backupScript(1, 'Up', { version: '2.0' }),
    backupScript(2, 'Unchecked'),
  ];
  const installed = [copy('u', 'Up', { stored: true })];
  const b = backup(scripts);
  const plan = planImport(b, installed, ['h0', 'h1', 'h2']);
  // Without the file's enabled states, a new script loads enabled.
  const request = buildImportRequest(b, plan, new Set([0, 1]),
    { ...DEFAULT_CHOICES, new: { ...DEFAULT_CHOICES.new, enabled: false } }, { newCollectionName: 'Imported' });
  assert.equal(request.source, 'tampermonkey');
  assert.deepEqual(request.into, { newCollectionName: 'Imported' });
  assert.equal(request.installs.length, 1);
  assert.deepEqual(
    { ...request.installs[0], text: undefined },
    { name: 'New', text: undefined, enabled: true, foreignId: 'tm-1', values: { a: 1 }, files: scripts[0].files },
  );
  assert.deepEqual(request.updates, [{ scriptId: 'u', text: scripts[1].text, files: {} }]);
});

test('replacing the text in a scripts collection moves it to where an install would put it', () => {
  const at = 'https://example.com/a.user.js';
  const p = (script, match) => planImport(backup([script]), [match], ['new'])[0];
  // Kept as text, and the backup has a location: linked to it.
  const linking = p(backupScript(0, 'A', { location: at }), copy('a', 'A', { stored: true }));
  assert.equal(locationChange(linking), at);
  // Linked, and the backup has none: kept as its text.
  assert.equal(locationChange(p(backupScript(0, 'A'), copy('a', 'A'))), null);
  // Edited in the other manager: kept as its text, as an install keeps it.
  assert.equal(locationChange(p(backupScript(0, 'A', { location: at, userModified: true }), copy('a', 'A', { fileUrl: at }))), null);
  // The same location, or a collection that says where: no change.
  assert.equal(locationChange(p(backupScript(0, 'A', { location: at }), copy('a', 'A', { fileUrl: at }))), undefined);
  assert.equal(locationChange(p(backupScript(0, 'A'), copy('a', 'A', { inScripts: false }))), undefined);
  assert.equal(locationChange(p(backupScript(0, 'A'), copy('a', 'A', { stored: true }))), undefined);

  const b = backup([backupScript(0, 'A', { location: at, version: '2.0', foreignId: 'f' })]);
  const plan = planImport(b, [copy('a', 'A', { stored: true })], ['new']);
  const [update] = buildImportRequest(b, plan, new Set([0]), DEFAULT_CHOICES, { newCollectionName: 'I' }).updates;
  assert.deepEqual(update.relink, { to: at, name: 'A', location: at, foreignId: 'f' });
});

test('a directory collection here gets the scripts it doesn\'t have', () => {
  const dir = { uuid: 'd', name: 'Dir', kind: 'directory', location: '/home/me/s', enabled: false, localFiles: true };
  const scripts = [
    backupScript(0, 'Have', { collection: 'd', location: '/home/me/s/have.user.js' }),
    backupScript(1, 'Missing', { collection: 'd', location: '/home/me/s/sub/missing.user.js', values: { v: 1 } }),
  ];
  const b = { ...backup(scripts), collections: [dir] };
  const plan = planImport(b, [copy('h', 'Have', { fileUrl: 'file:///home/me/s/have.user.js', inScripts: false })], ['h0', 'h1']);
  const collections = planCollections(b, [{ id: 'here', name: 'Dir', path: 'file:///home/me/s', enabled: true, scriptCount: 1 }]);
  assert.deepEqual(addingScripts(collections[0], plan), [1]);
  assert.equal(updatable(collections[0], plan), true);
  // Its scripts leave the New section whether it's checked or not.
  assert.deepEqual([...collectionScripts(collections, plan)], [1]);

  const request = buildImportRequest(b, plan, new Set([0, 1]), DEFAULT_CHOICES, { newCollectionName: 'I' }, collections, new Set(['d']));
  assert.equal(request.installs.length, 0);
  assert.equal(request.restores, undefined);
  assert.deepEqual(request.additions.map((a) => ({ ...a, installs: a.installs.map((i) => [i.name, i.relativePath, i.values]) })), [
    { collectionId: 'here', installs: [['Missing', 'sub/missing.user.js', { v: 1 }]] },
  ]);
  assert.equal(buildImportRequest(b, plan, new Set([0, 1]), DEFAULT_CHOICES, { newCollectionName: 'I' }, collections, new Set()).additions, undefined);
});

test('backup collections match by id, location, built-in scheme, or a scripts collection\'s name', () => {
  const collections = [
    { uuid: 'c-id', name: 'X', kind: 'scripts', location: null, enabled: true, localFiles: true },
    { uuid: 'c-dir', name: 'Dir', kind: 'directory', location: '/home/me/s', enabled: true, localFiles: true },
    { uuid: 'c-http', name: 'Web', kind: 'scripts', location: null, builtin: 'http', enabled: true, localFiles: true },
    { uuid: 'c-mine', name: 'Mine', kind: 'scripts', location: null, enabled: true, localFiles: true },
    { uuid: 'c-gone', name: 'Gone', kind: 'manifest', location: 'https://example.com/script_manifest.json', enabled: false, localFiles: true },
    { uuid: 'c-empty', name: 'Empty', kind: 'scripts', location: null, enabled: true, localFiles: true },
  ];
  const scripts = collections.filter((c) => c.uuid !== 'c-empty').map((c, i) => backupScript(i, `S${i}`, {
    collection: c.uuid, location: c.location ? `${c.location.replace(/script_manifest.json$/, '')}/s${i}.user.js` : undefined,
    relativePath: c.kind === 'manifest' ? `s${i}.user.js` : undefined,
  }));
  const here = [
    { id: 'c-id', name: 'Renamed', path: 'container:abc', enabled: true, scriptCount: 0 },
    { id: 'h-dir', name: 'Other name', path: 'file:///home/me/s', enabled: true, scriptCount: 0 },
    { id: 'h-http', name: 'Scripts from web', path: 'container:http', enabled: true, scriptCount: 0 },
    { id: 'h-mine', name: 'mine', path: 'container:def', enabled: true, scriptCount: 0 },
  ];
  const plan = planCollections({ ...backup(scripts), collections }, here);
  // A collection with no scripts in the backup has nothing to restore.
  assert.deepEqual(plan.map((c) => [c.collection.uuid, c.here?.id, c.scripts, c.cantRestore]), [
    ['c-id', 'c-id', [0], undefined], ['c-dir', 'h-dir', [1], undefined], ['c-http', 'h-http', [2], undefined],
    ['c-mine', 'h-mine', [3], undefined], ['c-gone', undefined, [4], undefined],
  ]);
  // A manifest from an export without `relative_path` can't be restored.
  const old = scripts.map((x) => ({ ...x, relativePath: undefined }));
  const [gone] = planCollections({ ...backup(old), collections }, here).filter((c) => c.collection.uuid === 'c-gone');
  assert.deepEqual([gone.scripts, gone.cantRestore], [[4], true]);
  assert.equal(buildImportRequest({ ...backup(old), collections }, planImport(backup(old), [], old.map(() => 'h')), new Set([4]),
    DEFAULT_CHOICES, { newCollectionName: 'I' }, [gone], new Set(['c-gone'])).installs.length, 1);
});

test('a script\'s path in its restored collection: given, or worked out for a directory', () => {
  const dir = { uuid: 'd', name: 'D', kind: 'directory', location: '/home/me/s/', enabled: true, localFiles: true };
  const manifest = { ...dir, uuid: 'm', kind: 'manifest', location: 'https://example.com/script_manifest.json' };
  const scripts = { ...dir, uuid: 'c', kind: 'scripts', location: null };
  assert.equal(restorePath(backupScript(0, 'A', { collection: 'd', location: '/home/me/s/sub/a.user.js' }), dir), 'sub/a.user.js');
  assert.equal(restorePath(backupScript(0, 'A', { collection: 'd', location: '/elsewhere/a.user.js' }), dir), null);
  assert.equal(restorePath(backupScript(0, 'A', { collection: 'd', relativePath: 'given.user.js' }), dir), 'given.user.js');
  const gh = { ...dir, uuid: 'g', location: 'https://github.com/o/r/tree/main/tests/examples' };
  assert.equal(restorePath(backupScript(0, 'A', {
    collection: 'g', location: 'https://raw.githubusercontent.com/o/r/main/tests/examples/a/a.user.js',
  }), gh), 'a/a.user.js');
  assert.equal(restorePath(backupScript(0, 'A', { collection: 'g', location: 'https://raw.githubusercontent.com/o/r/dev/x.user.js' }), gh), null);
  // From an export that didn't record it, a manifest's entry is unknown.
  assert.equal(restorePath(backupScript(0, 'A', { collection: 'm', location: 'https://example.com/a.user.js' }), manifest), null);
  assert.equal(restorePath(backupScript(0, 'A', { collection: 'c' }), scripts), '');
  assert.equal(restorePath(backupScript(0, 'A', { collection: 'other' }), scripts), null);
});

test('a restore takes its collection\'s scripts whatever their match; scripts collections go by name', () => {
  const collections = [
    { uuid: 'd', name: 'Dir', kind: 'directory', location: '/home/me/s', enabled: false, localFiles: false },
    { uuid: 'w', name: 'Web', kind: 'scripts', location: null, builtin: 'http', enabled: false, localFiles: true },
    { uuid: 'm', name: 'Mine', kind: 'scripts', location: null, enabled: true, localFiles: true },
  ];
  const scripts = [
    backupScript(0, 'InDir', { collection: 'd', location: '/home/me/s/a.user.js', relativePath: 'a.user.js', values: { a: 1 } }),
    backupScript(1, 'OnWeb', { collection: 'w', location: 'https://example.com/w.user.js' }),
    backupScript(2, 'Loose'),
    backupScript(3, 'Kept', { collection: 'm' }),
  ];
  const b = { ...backup(scripts), collections };
  // InDir is installed elsewhere too; the restore still takes it.
  const plan = planImport(b, [copy('x', 'InDir')], ['h0', 'h1', 'h2', 'h3']);
  // Mine is here already.
  const planned = planCollections(b, [{ id: 'mine-here', name: 'mine', path: 'container:user-1' }]);
  assert.deepEqual(planned.filter(restorable).map((c) => c.collection.uuid), ['d']);
  // Only a directory, manifest or GitHub collection restores, even if asked.
  const request = buildImportRequest(b, plan, new Set(), DEFAULT_CHOICES, { newCollectionName: 'Imported' }, planned, new Set(['d', 'w']));
  assert.deepEqual(request.restores.map((r) => ({ ...r, installs: r.installs.map((i) => [i.name, i.relativePath, i.linkTo, i.values]) })), [
    { name: 'Dir', kind: 'directory', location: '/home/me/s', enabled: false, localFiles: false,
      installs: [['InDir', 'a.user.js', undefined, { a: 1 }]] },
  ]);
  assert.deepEqual(request.installs, []);
  assert.equal(request.named, undefined);
  // A restore follows its own section's choices, not the New section's.
  const own = buildImportRequest(b, plan, new Set(), { ...DEFAULT_CHOICES, restore: { values: false, enabled: false } },
    { newCollectionName: 'Imported' }, planned, new Set(['d']));
  assert.deepEqual(own.restores.map((r) => [r.enabled, r.installs.map((i) => [i.linkTo, i.values])]), [[true, [[undefined, undefined]]]]);

  // New scripts from scripts collections go into them by name: the one
  // here, or one made like the backup's. The rest go `into`.
  const named = buildImportRequest(b, plan, new Set([1, 2, 3]), DEFAULT_CHOICES, { newCollectionName: 'Imported' }, planned, new Set(['d']));
  assert.deepEqual(named.named.map((g) => ({ ...g, installs: g.installs.map((i) => [i.name, i.linkTo]) })), [
    { create: { name: 'Web', kind: 'scripts', location: null, builtin: 'http', enabled: false, localFiles: true },
      installs: [['OnWeb', 'https://example.com/w.user.js']] },
    { collectionId: 'mine-here', installs: [['Kept', undefined]] },
  ]);
  assert.deepEqual(named.installs.map((i) => i.name), ['Loose']);
  // Picking a collection instead puts them all there.
  const picked = buildImportRequest(b, plan, new Set([0, 1, 2, 3]),
    { ...DEFAULT_CHOICES, new: { ...DEFAULT_CHOICES.new, byCollection: false } }, { newCollectionName: 'Imported' }, planned, new Set());
  assert.equal(picked.restores, undefined);
  assert.equal(picked.named, undefined);
  assert.deepEqual(picked.installs.map((i) => i.name), ['OnWeb', 'Loose', 'Kept']);
});
