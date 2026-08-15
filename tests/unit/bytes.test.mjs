// The base64 pair in dist/bytes.js. Both directions matter now that
// binary bodies (a favicon's PNG bytes) travel base64 across the
// page → service-worker read hop: a round-trip bug there would surface
// only as a mis-rendered icon, miles from its cause.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bytesToBase64, base64ToBytes } from '../../dist/bytes.js';

test('round-trips every byte value', () => {
  const original = new Uint8Array(256);
  for (let i = 0; i < 256; i++) original[i] = i;
  const back = new Uint8Array(base64ToBytes(bytesToBase64(original)));
  assert.deepEqual([...back], [...original]);
});

test('round-trips an empty body', () => {
  assert.equal(bytesToBase64(new Uint8Array(0)), '');
  assert.equal(base64ToBytes('').byteLength, 0);
});

test('round-trips past the 32 KiB chunk boundary', () => {
  // `bytesToBase64` walks the buffer in 0x8000-byte slices; a body
  // spanning several slices is where a concatenation bug would show.
  const size = 0x8000 * 3 + 17;
  const original = new Uint8Array(size);
  for (let i = 0; i < size; i++) original[i] = (i * 31) % 256;
  const back = new Uint8Array(base64ToBytes(bytesToBase64(original)));
  assert.equal(back.length, size);
  assert.deepEqual([...back.slice(0, 64)], [...original.slice(0, 64)]);
  assert.deepEqual([...back.slice(-64)], [...original.slice(-64)]);
});
