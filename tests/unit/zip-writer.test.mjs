// Unit tests for the backup export's zip writer (src/extension/zip-writer.ts),
// read back with an independent reader (tests/fixtures/zip-read.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildZip } from '../../dist/extension/zip-writer.js';
import { readZip } from '../fixtures/zip-read.mjs';

const enc = new TextEncoder();

test('entries read back in order, with their bytes', () => {
  const entries = [
    { path: 'script_manifest.json', data: enc.encode('{"a":1}') },
    { path: 'Café ☕.user.js', data: enc.encode('// x\n'.repeat(200)) },
    { path: 'cdn.example.com/lib/x.js', data: new Uint8Array([0, 1, 2, 255]) },
  ];
  const got = readZip(buildZip(entries));
  assert.deepEqual(got.map((e) => e.path), entries.map((e) => e.path));
  for (const [i, e] of got.entries()) assert.deepEqual(new Uint8Array(e.data), entries[i].data);
  // A non-ASCII name is marked UTF-8, so readers decode it as such.
  assert.ok((got[1].flags & 0x0800) !== 0);
});

test('an empty archive is still a valid zip', () => {
  assert.deepEqual(readZip(buildZip([])), []);
});

test('two entries with one path are refused', () => {
  assert.throws(
    () => buildZip([{ path: 'a', data: new Uint8Array() }, { path: 'a', data: new Uint8Array() }]),
    /two entries named a/,
  );
});
