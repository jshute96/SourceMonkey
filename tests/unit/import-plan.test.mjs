// Unit tests for the import planner (src/extension/import-plan.ts): what
// matches a backup's scripts here, how the copies compare, and what the
// dialog's choices do to each.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  actionFor,
  actionText,
  buildImportRequest,
  DEFAULT_CHOICES,
  hereText,
  planImport,
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
    header: parseHeader(text(name, over.version)), contentHash: `hash-${id}`, enabled: true, stored: false, ...over,
  };
}

const backup = (scripts) => ({ source: 'tampermonkey', label: 'Tampermonkey backup', scripts, collections: [], problems: [] });

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
  assert.match(hereText(p).title, /Copies in: \* New, Old$/);
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
  const act = (choices) => plan.map((p) => actionFor(p, { ...DEFAULT_CHOICES, ...choices }));

  const newer = act({});
  assert.deepEqual(newer[0], { kind: 'install', followUrl: 'https://example.com/w.user.js' });
  // Edited in the other manager: kept as its text.
  assert.deepEqual(newer[1], { kind: 'install' });
  // A copy that loads from its location keeps its text.
  assert.deepEqual(newer[2], { kind: 'update', text: false, values: true, enabled: false });
  assert.deepEqual(newer[3], { kind: 'update', text: true, values: false, enabled: true });
  assert.deepEqual(newer[4], { kind: 'skip' });
  assert.equal(actionText(newer[3], plan[3]), 'Replace its text and on/off state');
  assert.equal(actionText(newer[0], plan[0]), 'Install, updating from its web address');

  assert.deepEqual(act({ followUrls: false })[0], { kind: 'install' });
  assert.deepEqual(act({ existing: 'leave' }).slice(2).map((a) => a.kind), ['skip', 'skip', 'skip']);
  // Replace them all: the same text still takes the file's values.
  assert.deepEqual(act({ existing: 'always' })[4], { kind: 'update', text: false, values: true, enabled: false });
  assert.deepEqual(act({ existing: 'always', values: false })[4], { kind: 'skip' });
  // A newer version for a copy with a location, and nothing else to change.
  const located = act({ values: false })[2];
  assert.deepEqual(located, { kind: 'skip', located: true });
  assert.equal(actionText(located, plan[2]), 'Leave as it is: it loads from its own location');
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
  const request = buildImportRequest(b, plan, new Set([0, 1]), { ...DEFAULT_CHOICES, enabledFromFile: false }, { newCollectionName: 'Imported' });
  assert.equal(request.source, 'tampermonkey');
  assert.deepEqual(request.into, { newCollectionName: 'Imported' });
  assert.equal(request.installs.length, 1);
  assert.deepEqual(
    { ...request.installs[0], text: undefined },
    { name: 'New', text: undefined, enabled: false, foreignId: 'tm-1', values: { a: 1 }, files: scripts[0].files },
  );
  assert.deepEqual(request.updates, [{ scriptId: 'u', text: scripts[1].text, files: {} }]);
});
