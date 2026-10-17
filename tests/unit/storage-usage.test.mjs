// Tests for src/extension/storage-usage.ts (compiled to
// dist/extension/storage-usage.js): sorting storage rows into the
// Options page's usage table.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  summarizeLocalStorage,
  toWholeKb,
  withRemainder,
} from '../../dist/extension/storage-usage.js';

const bytes = (key, value) => new TextEncoder().encode(key + JSON.stringify(value)).length;
const byLabel = (rows) => Object.fromEntries(rows.map((r) => [r.label, r]));

test('splits @require and @resource bodies out of script rows', () => {
  const requires = [{ url: 'https://x/a.js', source: 'a'.repeat(500) }];
  const resources = [{ name: 'r', bytesBase64: 'QUJD' }, { name: 's', bytesBase64: 'REVG' }];
  const script = { bodyText: 'body', requires, resources };
  const rows = byLabel(summarizeLocalStorage({ 'script:1': script, 'script:2': { bodyText: 'x' } }));

  assert.equal(rows['Scripts'].count, '2 scripts');
  assert.equal(rows['@require files'].count, '1 file');
  assert.equal(rows['@require files'].bytes, JSON.stringify(requires).length);
  assert.equal(rows['@resource files'].count, '2 files');
  assert.equal(rows['@resource files'].bytes, JSON.stringify(resources).length);
  // The three add up to the whole rows.
  const total = rows['Scripts'].bytes + rows['@require files'].bytes + rows['@resource files'].bytes;
  assert.equal(total, bytes('script:1', script) + bytes('script:2', { bodyText: 'x' }));
});

test('groups icons, GM values, scratch scripts, collections and the rest', () => {
  const rows = byLabel(summarizeLocalStorage({
    'siteIcon:https://a': { d: 1 },
    'pathIcon:https://a/b': { d: 1 },
    'iconUrl:https://a/i.png': { d: 1 },
    'gmval:s1:k1': 1,
    'gmval:s1:k2': 2,
    'gmval:s2:k1': 3,
    'scratch:scratch:///a.user.js': 'text',
    'scratchFiles:scratch:///a.user.js': {},
    'collection:c1': {},
    collections: ['c1'],
    smDebugLogging: true,
  }));
  assert.equal(rows['Site and script icons'].count, '3 icons');
  assert.equal(rows['Script values (GM_setValue)'].count, '3 values in 2 scripts');
  assert.equal(rows['Scripts run by sm-dev'].count, '1 script');
  assert.equal(rows['Collections'].count, '1 collection');
  assert.equal(rows['Other'].bytes, bytes('smDebugLogging', true));
});

test('withRemainder makes the rows sum to the total', () => {
  const rows = withRemainder([
    { label: 'A', count: '', bytes: 100 },
    { label: 'Other', count: '', bytes: 5 },
  ], 130);
  assert.equal(rows[1].bytes, 30);
  assert.equal(withRemainder(rows, 50)[1].bytes, 0);
});

test('toWholeKb rounds so the rows sum to the rounded total', () => {
  // Rounded alone: 1, 1, 1 = 3 KB under a 2 KB total.
  const rows = [600, 600, 848].map((bytes) => ({ label: '', count: '', bytes }));
  const kb = toWholeKb(rows, 2048);
  assert.equal(kb.reduce((a, b) => a + b, 0), 2);
  assert.deepEqual(kb, [1, 0, 1]);
});

test('toWholeKb takes back an excess from the largest rows', () => {
  // Measured 10 KB of rows, but Chrome reports 8 KB.
  const rows = [7, 2, 1].map((k) => ({ label: '', count: '', bytes: k * 1024 }));
  const kb = toWholeKb(rows, 8 * 1024);
  assert.equal(kb.reduce((a, b) => a + b, 0), 8);
  assert.deepEqual(kb, [5, 2, 1]);
});

test('counts shared blobs once, under the kind that points at them', () => {
  const body = { encoding: 'text', data: 'x'.repeat(100) };
  const lib = { encoding: 'text', data: 'y'.repeat(50) };
  const stray = { encoding: 'text', data: 'z' };
  const row = (id) => ({ id, bodyBlobRef: { hash: 'b1', size: 100 }, requires: [{ url: 'u', blobRef: { hash: 'r1', size: 50 } }] });
  const rows = byLabel(summarizeLocalStorage({
    'script:1': row('1'),
    'script:2': row('2'),
    'blob:b1': body,
    'blob:r1': lib,
    'blob:zz': stray,
  }));
  assert.equal(rows['Scripts'].count, '2 scripts (1 unique)');
  assert.equal(rows['Scripts'].bytes, bytes('script:1', row('1')) + bytes('script:2', row('2')) + bytes('blob:b1', body));
  assert.equal(rows['@require files'].count, '2 files (1 unique)');
  assert.equal(rows['@require files'].bytes, bytes('blob:r1', lib));
  assert.equal(rows['Stored files no script uses'].count, '1 file');
  assert.equal(rows['Stored files no script uses'].bytes, bytes('blob:zz', stray));
});

test('unique counts ignore files not stored as blobs, and count each kind\'s own blobs', () => {
  const shared = { encoding: 'text', data: 'ABC' };
  const rows = byLabel(summarizeLocalStorage({
    // Never loaded: no body blob.
    'script:1': { id: '1' },
    'script:2': { id: '2', bodyBlobRef: { hash: 'b2', size: 1 } },
    'script:3': { id: '3', bodyBlobRef: { hash: 'b3', size: 1 } },
    // Format 1: inline body and require.
    'script:4': { id: '4', bodyText: 'x', requires: [{ url: 'u', source: 'y' }] },
    // One blob used as both a require and a resource.
    'script:5': {
      id: '5',
      bodyBlobRef: { hash: 'b3', size: 1 },
      requires: [{ url: 'r', blobRef: { hash: 's', size: 3 } }],
      resources: [{ name: 'n', blobRef: { hash: 's', size: 3 } }],
    },
    'blob:b2': { encoding: 'text', data: '2' },
    'blob:b3': { encoding: 'text', data: '3' },
    'blob:s': shared,
  }));
  // Scripts 2, 3, 5 have bodies in blobs, 3 and 5 sharing; 1 and 4 count as unique.
  assert.equal(rows['Scripts'].count, '5 scripts (4 unique)');
  // The inline require and the blob one: nothing shared.
  assert.equal(rows['@require files'].count, '2 files');
  assert.equal(rows['@resource files'].count, '1 file');
  // The shared blob is sized once, under the require that claimed it.
  assert.equal(rows['@resource files'].bytes, 0);
});
