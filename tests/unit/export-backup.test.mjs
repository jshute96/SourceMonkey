// Unit tests for the backup export's planner (src/extension/export-backup.ts):
// rows in, zip entries out. Format: docs/export-format.md#sourcemonkey.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  encodeExportValue,
  exportFileName,
  exportFilePath,
  safeFileName,
  planExportEntries,
  saveFailureMessage,
} from '../../dist/extension/export-backup.js';

const header = (name, extra = []) => ({
  tags: [{ tag: 'name', value: name }, ...extra.map(([tag, value]) => ({ tag, value }))],
});

function script(over) {
  return {
    id: 'id-1',
    collectionId: 'c-1',
    relativePath: 'a.user.js',
    fileUrl: 'file:///home/me/s/a.user.js',
    status: 'ok',
    size: 10,
    leadingText: '',
    headerText: '// ==UserScript==\n// ==/UserScript==\n',
    bodyText: 'body();\n',
    header: header('A'),
    loadedAt: 1000,
    enabled: true,
    ...over,
  };
}

const dirCollection = { id: 'c-1', path: '/home/me/s', scriptIds: ['id-1'], enabled: true };

function plan(collections, extra = {}) {
  return planExportEntries({
    collections,
    values: {},
    icons: {},
    options: { values: true, files: false },
    now: 5000,
    ...extra,
  });
}

const text = (entry) => new TextDecoder().decode(entry.data);
const jsonOf = (p, path) => JSON.parse(text(p.entries.find((e) => e.path === path)));

test('encodeExportValue uses the type letters both managers read', () => {
  assert.equal(encodeExportValue('dark'), 'sdark');
  assert.equal(encodeExportValue(3), 'n3');
  assert.equal(encodeExportValue(false), 'bfalse');
  assert.equal(encodeExportValue(null), 'onull');
  assert.equal(encodeExportValue({ a: [1] }), 'o{"a":[1]}');
  assert.equal(encodeExportValue(undefined), undefined);
});

test('safeFileName replaces unsafe characters, trims, and caps the length', () => {
  assert.equal(safeFileName('a/b: c?', 'script'), 'a-b- c-');
  assert.equal(safeFileName('  ..hidden ', 'script'), 'hidden');
  assert.equal(safeFileName('   ', 'script'), 'script');
  assert.equal(safeFileName('x'.repeat(300), 'script').length, 100);
});

test('script names are deduped ignoring case', () => {
  const p = plan([{ collection: dirCollection, scripts: [
    script({ header: header('Same') }),
    script({ id: 'id-2', header: header('same') }),
  ] }]);
  assert.deepEqual(jsonOf(p, 'script_manifest.json').scripts.map((s) => s.path),
    ['Same/Same.user.js', 'same (2)/same (2).user.js']);
});

test('exportFileName is the TM-style timestamp', () => {
  assert.equal(exportFileName(Date.UTC(2026, 9, 17, 12, 34, 56, 789)),
    'sourcemonkey-backup-2026-10-17T12-34-56-789Z.zip');
});

test('exportFilePath: relative refs at their path, others mirrored', () => {
  assert.equal(exportFilePath('lib/util.js', 'file:///home/me/s/lib/util.js'), 'lib/util.js');
  assert.equal(exportFilePath('./icon.png', 'file:///home/me/s/icon.png'), 'icon.png');
  assert.equal(exportFilePath('https://cdn.example.com/x/y.js', 'https://cdn.example.com/x/y.js'),
    'cdn.example.com/x/y.js');
  assert.equal(exportFilePath('../up.js', 'file:///home/me/up.js'), 'home/me/up.js');
});

test('the manifest comes first, with collections and per-script fields', () => {
  const p = plan([{ collection: dirCollection, scripts: [script()] }]);
  assert.equal(p.entries[0].path, 'script_manifest.json');
  const m = jsonOf(p, 'script_manifest.json');
  assert.equal(m.format, 'sourcemonkey-export');
  assert.equal(m.exported_at, 5000);
  assert.deepEqual(m.collections, [{
    uuid: 'c-1', name: '/home/me/s', kind: 'directory', location: '/home/me/s', enabled: true, local_files: true,
  }]);
  assert.deepEqual(m.scripts, [{
    path: 'A/A.user.js', uuid: 'id-1', collection: 'c-1', location: '/home/me/s/a.user.js', enabled: true,
  }]);
});

test('a built-in scripts collection has no location and names its kind', () => {
  const c = { id: 'c-2', path: 'container:http', scriptIds: ['id-1'], enabled: true, localFiles: false };
  const s = script({ collectionId: 'c-2', relativePath: 'https://e.com/a.user.js', fileUrl: 'https://e.com/a.user.js' });
  const m = jsonOf(plan([{ collection: c, scripts: [s] }]), 'script_manifest.json');
  assert.deepEqual(m.collections[0], {
    uuid: 'c-2', name: 'Scripts from web', kind: 'scripts', location: null,
    enabled: true, local_files: false, builtin: 'http',
  });
  assert.equal(m.scripts[0].location, 'https://e.com/a.user.js');
});

test('.options.json: TM metadata, active state, and a URL only for web scripts', () => {
  const web = script({ id: 'w', fileUrl: 'https://e.com/w.user.js', header: header('Web') });
  const off = { ...dirCollection, enabled: false, scriptIds: ['id-1', 'w'] };
  const p = plan([{ collection: off, scripts: [script(), web] }]);
  const local = jsonOf(p, 'A/A.options.json');
  assert.deepEqual(local, {
    meta: { name: 'A', uuid: 'id-1', modified: 1000 },
    // Its collection is off, so TM and VM get it off.
    settings: { enabled: false, position: 1 },
    options: { check_for_updates: false },
  });
  const remote = jsonOf(p, 'Web/Web.options.json');
  assert.equal(remote.meta.file_url, 'https://e.com/w.user.js');
  assert.deepEqual(remote.options, { check_for_updates: true });
  assert.equal(remote.settings.position, 2);
  // The script's own flag stays in the manifest.
  assert.equal(jsonOf(p, 'script_manifest.json').scripts[0].enabled, true);
});

test('values: encoded, and no file for a script with none', () => {
  const two = script({ id: 'id-2', header: header('B') });
  const p = plan([{ collection: dirCollection, scripts: [script(), two] }], {
    values: { 'id-1': { theme: 'dark', n: 1, gone: undefined } },
  });
  assert.deepEqual(jsonOf(p, 'A/A.storage.json'), { ts: 5000, data: { theme: 'sdark', n: 'n1' } });
  assert.equal(p.entries.some((e) => e.path === 'B/B.storage.json'), false);
});

test('values off writes no storage files', () => {
  const p = plan([{ collection: dirCollection, scripts: [script()] }], {
    values: { 'id-1': { theme: 'dark' } },
    options: { values: false, files: false },
  });
  assert.equal(p.entries.some((e) => e.path.endsWith('.storage.json')), false);
});

test('an empty or never-loaded script still goes in, named from its file', () => {
  const p = plan([{ collection: dirCollection, scripts: [
    script({ relativePath: 'empty.user.js', size: 0, bodyText: '', headerText: '', header: null }),
    script({ id: 'id-2', relativePath: 'gone.user.js', size: null, bodyText: '', headerText: '', header: null }),
  ] }]);
  assert.equal(p.scriptCount, 2);
  assert.equal(text(p.entries.find((e) => e.path === 'empty/empty.user.js')), '');
  assert.ok(p.entries.some((e) => e.path === 'gone/gone.user.js'));
  assert.deepEqual(jsonOf(p, 'script_manifest.json').scripts.map((s) => s.uuid), ['id-1', 'id-2']);
});

test('files: dependencies and the icon, shared between scripts', () => {
  const lib = { ref: 'https://cdn.e.com/lib.js', url: 'https://cdn.e.com/lib.js', source: 'lib();' };
  const a = script({
    requires: [lib, { ref: 'local.js', url: 'file:///home/me/s/local.js', source: 'local();' }],
    resources: [{ ref: 'https://e.com/r.txt', url: 'https://e.com/r.txt', bytesBase64: btoa('res'), contentType: 'text/plain' }],
    header: header('A', [['icon', 'https://e.com/i.png']]),
  });
  const b = script({ id: 'id-2', header: header('B'), requires: [lib] });
  const p = plan([{ collection: dirCollection, scripts: [a, b] }], {
    options: { values: false, files: true },
    icons: { 'https://e.com/i.png': new Uint8Array([1, 2, 3]) },
  });
  const files = p.entries.filter((e) => !/\.(user\.js|json)$/.test(e.path)).map((e) => e.path);
  // Shared with the same bytes: at the top. Used by one script, or named
  // by a relative ref: in its folder.
  assert.deepEqual(files.sort(), ['A/e.com/i.png', 'A/e.com/r.txt', 'A/local.js', 'cdn.e.com/lib.js']);
  assert.equal(text(p.entries.find((e) => e.path === 'A/e.com/r.txt')), 'res');
});

test('the manifest path is URL-encoded, so # and % survive a manifest load', () => {
  const p = plan([{ collection: dirCollection, scripts: [script({ header: header('Script #2 100%') })] }]);
  const entry = jsonOf(p, 'script_manifest.json').scripts[0].path;
  assert.equal(entry, 'Script %232 100%25/Script %232 100%25.user.js');
  assert.equal(decodeURIComponent(new URL(entry, 'file:///x/').pathname.slice(3)),
    'Script #2 100%/Script #2 100%.user.js');
  assert.ok(p.entries.some((e) => e.path === 'Script #2 100%/Script #2 100%.user.js'));
});

test('relative-ref files stay in each script\'s folder, even when identical', () => {
  const rel = (url, source) => ({ ref: 'lib/util.js', url, source });
  const p = plan([{ collection: dirCollection, scripts: [
    script({ requires: [rel('file:///one/lib/util.js', 'same();')] }),
    script({ id: 'id-2', header: header('B'), requires: [rel('file:///two/lib/util.js', 'same();')] }),
  ] }], { options: { values: false, files: true } });
  assert.equal(text(p.entries.find((e) => e.path === 'A/lib/util.js')), 'same();');
  assert.equal(text(p.entries.find((e) => e.path === 'B/lib/util.js')), 'same();');
  assert.equal(p.entries.some((e) => e.path === 'lib/util.js'), false);
});

test('a shared URL: the most-used version at the top, others in their scripts\' folders', () => {
  const lib = (source) => ({ ref: 'https://cdn.e.com/lib.js', url: 'https://cdn.e.com/lib.js', source });
  const p = plan([{ collection: dirCollection, scripts: [
    script({ requires: [lib('v1')] }),
    script({ id: 'id-2', header: header('B'), requires: [lib('v1')] }),
    script({ id: 'id-3', header: header('C'), requires: [lib('v2')] }),
  ] }], { options: { values: false, files: true } });
  const libs = p.entries.filter((e) => e.path.endsWith('cdn.e.com/lib.js')).map((e) => [e.path, text(e)]);
  assert.deepEqual(libs.sort(), [['C/cdn.e.com/lib.js', 'v2'], ['cdn.e.com/lib.js', 'v1']]);
});

test('more than one collection: a folder per collection', () => {
  const web = { id: 'c-2', path: 'container:http', scriptIds: ['w'], enabled: true };
  const w = script({ id: 'w', collectionId: 'c-2', header: header('W'), fileUrl: 'https://e.com/w.user.js' });
  const p = plan([{ collection: dirCollection, scripts: [script()] }, { collection: web, scripts: [w] }]);
  assert.deepEqual(jsonOf(p, 'script_manifest.json').scripts.map((s) => s.path),
    ['s/A/A.user.js', 'Scripts from web/W/W.user.js']);
});

test('saveFailureMessage words the common reasons and shows the rest', () => {
  assert.equal(saveFailureMessage('FILE_NO_SPACE'), 'The disk is full');
  assert.equal(saveFailureMessage('NETWORK_FAILED'), 'Chrome stopped the save (NETWORK_FAILED)');
  assert.equal(saveFailureMessage(undefined), 'Chrome stopped the save (no reason given)');
});
