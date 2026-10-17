// Tests for src/extension/storage-breakdown.ts (compiled to
// dist/extension/storage-breakdown.js): the storage debug page's
// per-script, per-file and GM-value breakdowns, and their sorting.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildStorageBreakdown,
  fileIdentity,
  sortFiles,
  sortScripts,
  sortValues,
} from '../../dist/extension/storage-breakdown.js';

const bytes = (key, value) => new TextEncoder().encode(key + JSON.stringify(value)).length;

const blob = (data) => ({ encoding: 'text', data });
const ref = (hash) => ({ hash, size: 10 });
const header = (name) => ({ tags: [{ tag: 'name', value: name }] });

function collection(id, displayName) {
  return { id, path: `https://example.com/${id}/`, displayName, lastRefreshedAt: 0, scriptIds: [] };
}

// Two collections; jQuery is a `@require` in two scripts and a
// `@resource` in a third; one blob nothing uses.
function sampleRows() {
  return {
    'collection:c1': collection('c1', 'Alpha'),
    'collection:c2': collection('c2', 'Beta'),
    'script:s1': {
      collectionId: 'c1', relativePath: 'one.user.js', fileUrl: 'https://example.com/c1/one.user.js',
      header: header('One'),
      bodyBlobRef: ref('b1'),
      requires: [{ url: 'https://cdn/jq.js', blobRef: ref('jq') }],
    },
    'script:s2': {
      collectionId: 'c1', relativePath: 'two.user.js', fileUrl: 'https://example.com/c1/two.user.js',
      header: header('Two'),
      bodyBlobRef: ref('b2'),
      requires: [{ url: 'https://cdn/jq.js', blobRef: ref('jq') }],
    },
    'script:s3': {
      collectionId: 'c2', relativePath: 'three.user.js', fileUrl: 'https://example.com/c2/three.user.js',
      header: header('Three'),
      bodyBlobRef: ref('b3'),
      resources: [{ name: 'jq', url: 'https://other/jq.js', blobRef: ref('jq') }],
    },
    'blob:b1': blob('a'.repeat(100)),
    'blob:b2': blob('b'.repeat(50)),
    'blob:b3': blob('c'.repeat(10)),
    'blob:jq': blob('j'.repeat(5000)),
    'blob:old': blob('o'.repeat(20)),
    'gmval:s1:k1': 'v1',
    'gmval:s1:k2': 'v2',
    'gmval:gone:k': 1,
  };
}

test('splits each script into its body, files and metadata', () => {
  const rows = sampleRows();
  const b = buildStorageBreakdown(rows);
  const s1 = b.scripts.find((s) => s.scriptId === 's1');
  assert.equal(s1.collectionName, 'Alpha');
  assert.equal(s1.scriptName, 'One');
  const byKind = Object.fromEntries(s1.items.map((i) => [i.kind, i]));
  assert.equal(byKind.script.bytes, bytes('blob:b1', rows['blob:b1']));
  assert.equal(byKind.script.shared, 1);
  assert.equal(byKind.require.bytes, bytes('blob:jq', rows['blob:jq']));
  // The require, the other script's require and the resource.
  assert.equal(byKind.require.shared, 3);
  assert.equal(byKind.metadata.bytes, bytes('script:s1', rows['script:s1']));
  assert.equal(s1.bytes, byKind.script.bytes + byKind.require.bytes + byKind.metadata.bytes);
  assert.equal(s1.shared, 3);
});

test('groups uses of the same stored file, and lists unused blobs', () => {
  const b = buildStorageBreakdown(sampleRows());
  const jq = b.files.find((f) => f.key === 'blob:jq');
  assert.deepEqual(jq.uses.map((u) => [u.scriptId, u.kind]), [['s1', 'require'], ['s2', 'require'], ['s3', 'resource']]);
  assert.deepEqual(b.unused.map((f) => f.key), ['blob:old']);
  // Metadata is not a stored file.
  assert.ok(b.files.every((f) => f.uses.every((u) => u.kind !== 'metadata')));
});

test('a file heading names what every use agrees on', () => {
  const use = (kind, location, name) => ({ kind, location, name });
  const file = (...uses) => ({ key: 'k', bytes: 1, uses });
  const id = (...uses) => {
    const { kind, sameName, sameLocation } = fileIdentity(file(...uses));
    return { kind, sameName, sameLocation };
  };
  assert.deepEqual(id(use('require', 'a'), use('require', 'a')), { kind: 'require', sameName: true, sameLocation: true });
  assert.deepEqual(id(use('require', 'a'), use('require', 'b')), { kind: 'require', sameName: true, sameLocation: false });
  // Only the @resource name differs: the location still goes in the heading.
  assert.deepEqual(id(use('resource', 'a', 'x'), use('resource', 'a', 'y')),
    { kind: 'resource', sameName: false, sameLocation: true });
  assert.deepEqual(id(use('require', 'a'), use('resource', 'a', 'r')), { kind: null, sameName: false, sameLocation: false });
});

test('a blob missing from storage is marked, and sized from its ref', () => {
  const rows = { 'script:s': { collectionId: 'c', relativePath: 'p.user.js', bodyBlobRef: { hash: 'gone', size: 42 } } };
  const b = buildStorageBreakdown(rows);
  const body = b.scripts[0].items.find((i) => i.kind === 'script');
  assert.equal(body.bytes, 42);
  assert.equal(body.missing, true);
  assert.equal(b.files.find((f) => f.key === 'blob:gone').missing, true);
});

test('sm-dev rows whose script is gone are listed as unused', () => {
  const b = buildStorageBreakdown({
    'scratch:scratch:///run1/old.user.js': 'text',
    'scratchFiles:scratch:///run1/old.user.js': {},
  });
  assert.deepEqual(b.unused.map((f) => f.key).sort(),
    ['scratch:scratch:///run1/old.user.js', 'scratchFiles:scratch:///run1/old.user.js']);
});

test('format 1 bodies count as their own files, out of the metadata', () => {
  const requires = [{ url: 'https://x/a.js', source: 'a'.repeat(500) }];
  const row = { collectionId: 'c', relativePath: 'p.user.js', bodyText: 'body', requires };
  const [s] = buildStorageBreakdown({ 'script:s': row }).scripts;
  const byKind = Object.fromEntries(s.items.map((i) => [i.kind, i]));
  assert.equal(byKind.require.bytes, JSON.stringify(requires[0]).length);
  assert.equal(byKind.script.bytes, JSON.stringify('body').length);
  assert.equal(s.bytes, bytes('script:s', row));
  assert.equal(s.collectionId, '');
});

test('a scratch script includes sm-dev text and pushed files', () => {
  const url = 'scratch:///run1/demo.user.js';
  const files = { 'lib/a.js': { url: 'file:///home/x/lib/a.js', bytesBase64: 'QUJD', contentType: 'text/javascript' } };
  const rows = {
    'script:s': { collectionId: 'c', relativePath: url, bodyBlobRef: ref('b') },
    'blob:b': blob('x'),
    [`scratch:${url}`]: 'text',
    [`scratchSource:${url}`]: { fileUrl: 'file:///home/x/demo.user.js', given: 'demo' },
    [`scratchFiles:${url}`]: files,
  };
  const [s] = buildStorageBreakdown(rows).scripts;
  const byKind = Object.fromEntries(s.items.map((i) => [i.kind, i]));
  assert.equal(byKind['smdev-text'].bytes,
    bytes(`scratch:${url}`, 'text') + bytes(`scratchSource:${url}`, rows[`scratchSource:${url}`]));
  assert.equal(byKind['smdev-file'].location, 'file:///home/x/lib/a.js');
});

test('GM values grouped by script, including a removed one', () => {
  const b = buildStorageBreakdown(sampleRows());
  const s1 = b.values.find((v) => v.scriptId === 's1');
  assert.equal(s1.count, 2);
  assert.equal(s1.bytes, bytes('gmval:s1:k1', 'v1') + bytes('gmval:s1:k2', 'v2'));
  assert.equal(s1.script.scriptName, 'One');
  assert.equal(b.values.find((v) => v.scriptId === 'gone').script, undefined);
});

test('sorts by column, breaking ties by collection then script', () => {
  const b = buildStorageBreakdown(sampleRows());
  const names = (list) => list.map((s) => s.scriptName);
  // s1 and s2 both hold jQuery; s1's body is bigger.
  assert.deepEqual(names(sortScripts(b.scripts, 'size', 'desc')), ['One', 'Two', 'Three']);
  assert.deepEqual(names(sortScripts(b.scripts, 'size', 'asc')), ['Three', 'Two', 'One']);
  assert.deepEqual(names(sortScripts(b.scripts, 'collection', 'desc')), ['Three', 'One', 'Two']);
  // All three share jQuery: a tie, so collection then script.
  assert.deepEqual(names(sortScripts(b.scripts, 'shared', 'desc')), ['One', 'Two', 'Three']);
  // A script's items, largest first.
  assert.equal(sortScripts(b.scripts, 'size', 'desc')[0].items[0].kind, 'require');

  const files = sortFiles(b.files, 'size', 'desc');
  assert.equal(files[0].key, 'blob:jq');
  // jQuery's 3 uses first; the rest tie on shared copies, so by size.
  assert.deepEqual(sortFiles(b.files, 'shared', 'desc').map((f) => f.key), ['blob:jq', 'blob:b1', 'blob:b2', 'blob:b3']);
  assert.deepEqual(sortFiles(b.files, 'shared', 'asc').map((f) => f.key), ['blob:b1', 'blob:b2', 'blob:b3', 'blob:jq']);

  assert.deepEqual(sortValues(b.values, 'count', 'desc').map((v) => v.scriptId), ['s1', 'gone']);
});
