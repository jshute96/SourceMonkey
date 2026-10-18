// Unit tests for the import's backup reader (src/extension/import-backup.ts):
// each format in, one ParsedBackup out. Formats: docs/export-format.md.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  decodeStoredValue,
  IMPORT_IS_USERSCRIPT,
  IMPORT_NOT_A_BACKUP,
  IMPORT_NO_SCRIPTS,
  readBackup,
  violentmonkeyNameUri,
} from '../../dist/extension/import-backup.js';
import { planExportEntries } from '../../dist/extension/export-backup.js';
import { buildZip } from '../../dist/extension/zip-writer.js';
import { parseHeader } from '../../dist/userscript-header.js';

const enc = new TextEncoder();
const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');
const fromB64 = (base64) => Buffer.from(base64, 'base64').toString('utf8');

function userscript(name, { namespace = 'ns', version = '1.0', extra = '' } = {}) {
  return `// ==UserScript==\n// @name        ${name}\n// @namespace   ${namespace}\n// @version     ${version}\n${extra}// ==/UserScript==\nrun();\n`;
}

const zip = (files) => buildZip(Object.entries(files).map(([path, data]) => ({
  path, data: typeof data === 'string' ? enc.encode(data) : data,
})));

test('decodeStoredValue reads each type letter', () => {
  assert.equal(decodeStoredValue('sdark'), 'dark');
  assert.equal(decodeStoredValue('n42'), 42);
  assert.equal(decodeStoredValue('btrue'), true);
  assert.equal(decodeStoredValue('bfalse'), false);
  assert.deepEqual(decodeStoredValue('o{"a":[1]}'), { a: [1] });
  assert.equal(decodeStoredValue('onull'), null);
  assert.equal(decodeStoredValue('uundefined'), undefined);
  assert.deepEqual(decodeStoredValue(`x${b64('{"k":"é"}')}`), { k: 'é' });
  // What doesn't decode is kept as written.
  assert.equal(decodeStoredValue('nabc'), 'nabc');
  assert.equal(decodeStoredValue('o{bad'), 'o{bad');
  assert.equal(decodeStoredValue('plain'), 'plain');
  assert.equal(decodeStoredValue(7), 7);
});

test('Tampermonkey JSON: text, values, state, location, dependencies, order', () => {
  const lib = 'var lib = 1;\n';
  // A resource's bytes, each taken as a character, then UTF-8, then base64.
  const resBytes = [0, 200, 255];
  const resSource = Buffer.from(String.fromCharCode(...resBytes), 'utf8').toString('base64');
  const file = {
    created_by: 'Tampermonkey',
    version: '1',
    scripts: [
      {
        name: 'Second', uuid: 'u-2', enabled: false, position: 2,
        source: b64(userscript('Second')), options: { user_modified: 1700000000000 }, storage: { ts: 0, data: {} },
      },
      {
        name: 'First', uuid: 'u-1', enabled: true, position: 1,
        file_url: 'https://example.com/first.user.js',
        source: b64(userscript('First ☕', {
          extra: '// @require     https://cdn.example.com/lib.js\n// @resource    pic https://cdn.example.com/pic.bin\n',
        })),
        storage: { ts: 1, data: { theme: 'sdark', count: 'n3' } },
        requires: [{ meta: { url: 'https://cdn.example.com/lib.js', mimetype: 'text/javascript' }, source: b64(lib) }],
        resources: [{ meta: { url: 'https://cdn.example.com/pic.bin', mimetype: 'image/png' }, source: resSource }],
      },
    ],
  };
  const got = readBackup(enc.encode(JSON.stringify(file)));
  assert.equal(got.source, 'tampermonkey');
  assert.deepEqual(got.scripts.map((s) => s.name), ['First ☕', 'Second']);
  const [first, second] = got.scripts;
  assert.equal(first.index, 0);
  assert.equal(first.enabled, true);
  assert.equal(first.location, 'https://example.com/first.user.js');
  assert.equal(first.foreignId, 'u-1');
  assert.deepEqual(first.values, { theme: 'dark', count: 3 });
  assert.equal(fromB64(first.files['https://cdn.example.com/lib.js'].bytesBase64), lib);
  assert.equal(first.files['https://cdn.example.com/lib.js'].contentType, 'text/javascript');
  assert.deepEqual([...Buffer.from(first.files['https://cdn.example.com/pic.bin'].bytesBase64, 'base64')], resBytes);
  assert.equal(second.enabled, false);
  // An empty store means the values were left out, not that there are none.
  assert.equal(second.values, undefined);
  assert.equal(second.userModified, true);
});

test('one unreadable script is a problem, and the rest still read', () => {
  const file = { scripts: [{ name: 'Good', source: b64(userscript('Good')) }, { name: 'Empty', source: b64('  ') }, 7] };
  const got = readBackup(enc.encode(JSON.stringify(file)));
  assert.deepEqual(got.scripts.map((s) => s.name), ['Good']);
  assert.deepEqual(got.problems, ['Empty: The script is empty', 'Script 3 in the backup could not be read']);
});

test('files that are not backups are refused with a reason', () => {
  assert.throws(() => readBackup(new Uint8Array()), /The file is empty/);
  assert.throws(() => readBackup(enc.encode(userscript('A'))), { message: IMPORT_IS_USERSCRIPT });
  assert.throws(() => readBackup(enc.encode('{"hello": 1}')), { message: IMPORT_NOT_A_BACKUP });
  assert.throws(() => readBackup(enc.encode('not json')), { message: IMPORT_NOT_A_BACKUP });
  assert.throws(() => readBackup(zip({ 'readme.txt': 'hi' })), { message: IMPORT_NOT_A_BACKUP });
  assert.throws(() => readBackup(zip({ 'script_manifest.json': '{"format":"sourcemonkey-export","scripts":[]}' })), { message: IMPORT_NO_SCRIPTS });
  assert.throws(() => readBackup(enc.encode('PK not really')), /This zip file could not be read/);
});

test('Tampermonkey zip: options, storage and dependency files', () => {
  const text = userscript('Zipped', { extra: '// @require     https://cdn.example.com/z.js\n' });
  const got = readBackup(zip({
    'Zipped.user.js': text,
    'Zipped.options.json': JSON.stringify({
      meta: { name: 'Zipped', uuid: 'tm-1', file_url: 'https://example.com/z.user.js' },
      settings: { enabled: false, position: 1 },
      options: { check_for_updates: true },
    }),
    'Zipped.storage.json': JSON.stringify({ ts: 1, data: { k: 'btrue' } }),
    'Zipped.user.js-0123abcd-z.js': 'zlib();',
    'Zipped.user.js-0123abcd-z.js.requires.json': JSON.stringify({ meta: { url: 'https://cdn.example.com/z.js', mimetype: 'text/javascript' } }),
    'Tampermonkey.global.json': '{}',
  }));
  assert.equal(got.source, 'tampermonkey');
  const [s] = got.scripts;
  assert.equal(s.enabled, false);
  assert.equal(s.foreignId, 'tm-1');
  assert.equal(s.location, 'https://example.com/z.user.js');
  assert.deepEqual(s.values, { k: true });
  assert.equal(fromB64(s.files['https://cdn.example.com/z.js'].bytesBase64), 'zlib();');
});

test('Violentmonkey zip: state from its metadata, values by namespace and name', () => {
  const text = userscript('My Script', { namespace: 'https://example.com' });
  const uri = violentmonkeyNameUri(parseHeader(text));
  assert.equal(uri, 'https-3a-2f-2fexample.com-0aMy-20Script-0a');
  const got = readBackup(zip({
    'My Script.user.js': text,
    'Other.user.js': userscript('Other'),
    violentmonkey: JSON.stringify({
      scripts: {
        'My Script': { config: { enabled: 0 }, custom: { lastInstallURL: 'https://example.com/my.user.js' }, position: 2 },
        Other: { config: { enabled: 1 }, custom: {}, position: 1 },
      },
      values: { [uri]: { count: 'n5' } },
    }),
  }));
  assert.equal(got.source, 'violentmonkey');
  assert.deepEqual(got.scripts.map((s) => s.name), ['Other', 'My Script']);
  const mine = got.scripts[1];
  assert.equal(mine.enabled, false);
  assert.equal(mine.location, 'https://example.com/my.user.js');
  assert.deepEqual(mine.values, { count: 5 });
  assert.equal(mine.foreignId, undefined);
});

test('a plain zip of userscripts reads at any depth', () => {
  const got = readBackup(zip({ 'a/b/One.user.js': userscript('One'), '__MACOSX/a/._One.user.js': 'junk' }));
  assert.equal(got.source, 'other');
  assert.deepEqual(got.scripts.map((s) => s.name), ['One']);
  assert.equal(got.scripts[0].enabled, true);
});

test('SourceMonkey export reads back: ids, collections, own flag, values, dependency files', () => {
  const headerText = '// ==UserScript==\n// @name A\n// @namespace ns\n// @version 2\n'
    + '// @require https://cdn.example.com/shared.js\n// @require lib/util.js\n// ==/UserScript==\n';
  const shared = { ref: 'https://cdn.example.com/shared.js', url: 'https://cdn.example.com/shared.js', source: 'shared();' };
  const util = { ref: 'lib/util.js', url: 'file:///home/me/s/lib/util.js', source: 'util();' };
  const a = {
    id: 'id-a', collectionId: 'c-1', relativePath: 'a.user.js', fileUrl: 'file:///home/me/s/a.user.js',
    status: 'ok', size: 10, leadingText: '', headerText, bodyText: 'a();\n',
    header: parseHeader(headerText), loadedAt: 1000, enabled: false, requires: [shared, util],
  };
  const webText = '// ==UserScript==\n// @name Web #1\n// @require https://cdn.example.com/shared.js\n// ==/UserScript==\n';
  const web = {
    id: 'id-w', collectionId: 'c-2', relativePath: 'https://example.com/web.user.js', fileUrl: 'https://example.com/web.user.js',
    status: 'ok', size: 10, leadingText: '', headerText: webText, bodyText: 'w();\n',
    header: parseHeader(webText), loadedAt: 1000, enabled: true, requires: [shared],
  };
  const plan = planExportEntries({
    collections: [
      { collection: { id: 'c-1', path: '/home/me/s', scriptIds: ['id-a'], enabled: true }, scripts: [a] },
      { collection: { id: 'c-2', path: 'container:http', scriptIds: ['id-w'], enabled: false }, scripts: [web] },
    ],
    values: { 'id-a': { theme: 'dark', n: 2 } },
    icons: {},
    options: { values: true, files: true },
    now: 5000,
  });
  const got = readBackup(buildZip(plan.entries, 5000));
  assert.equal(got.source, 'sourcemonkey');
  assert.deepEqual(got.collections.map((c) => [c.uuid, c.kind, c.enabled]), [['c-1', 'directory', true], ['c-2', 'scripts', false]]);
  const [ga, gw] = got.scripts;
  assert.equal(ga.foreignId, 'id-a');
  assert.equal(ga.collection, 'c-1');
  assert.equal(ga.location, '/home/me/s/a.user.js');
  // The script's own flag, not the TM-facing one.
  assert.equal(ga.enabled, false);
  assert.equal(gw.enabled, true);
  assert.deepEqual(ga.values, { theme: 'dark', n: 2 });
  assert.equal(fromB64(ga.files['https://cdn.example.com/shared.js'].bytesBase64), 'shared();');
  assert.equal(fromB64(ga.files['lib/util.js'].bytesBase64), 'util();');
  assert.equal(ga.files['lib/util.js'].url, 'file:///home/me/s/lib/util.js');
  // `#` in a name is percent-encoded in the manifest, not in the zip.
  assert.equal(gw.name, 'Web #1');
  assert.equal(gw.location, 'https://example.com/web.user.js');
  assert.equal(fromB64(gw.files['https://cdn.example.com/shared.js'].bytesBase64), 'shared();');
});

test('an SM script kept only as text has no location, even with a @downloadURL', () => {
  const text = userscript('Kept', { extra: '// @downloadURL https://example.com/kept.user.js\n' });
  const got = readBackup(zip({
    'Kept/Kept.user.js': text,
    'script_manifest.json': JSON.stringify({
      format: 'sourcemonkey-export', collections: [],
      scripts: [{ path: 'Kept/Kept.user.js', uuid: 'id-k', collection: 'c', location: null, enabled: true }],
    }),
  }));
  assert.equal(got.scripts[0].location, undefined);
  // Elsewhere, the header's @downloadURL says where it came from.
  const other = readBackup(zip({ 'Kept.user.js': text }));
  assert.equal(other.scripts[0].location, 'https://example.com/kept.user.js');
});

test('a dependency file ending in .user.js is not taken for a script', () => {
  const text = userscript('Main', { extra: '// @require     https://cdn.example.com/lib.user.js\n' });
  const tm = readBackup(zip({
    'Main.user.js': text,
    'Main.options.json': JSON.stringify({ meta: { name: 'Main', uuid: 'u' }, settings: {}, options: {} }),
    'Main.user.js-0abc-lib.user.js': 'lib();',
    'Main.user.js-0abc-lib.user.js.requires.json': JSON.stringify({ meta: { url: 'https://cdn.example.com/lib.user.js' } }),
  }));
  assert.deepEqual(tm.scripts.map((s) => s.name), ['Main']);
  assert.equal(fromB64(tm.scripts[0].files['https://cdn.example.com/lib.user.js'].bytesBase64), 'lib();');
  const sm = readBackup(zip({
    'Main/Main.user.js': text,
    'Main/cdn.example.com/lib.user.js': 'lib();',
    'script_manifest.json': JSON.stringify({
      format: 'sourcemonkey-export', collections: [],
      scripts: [{ path: 'Main/Main.user.js', uuid: 'id-m', collection: 'c', location: null, enabled: true }],
    }),
  }));
  assert.deepEqual(sm.scripts.map((s) => s.name), ['Main']);
});
