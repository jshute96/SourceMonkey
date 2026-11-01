// The base64 pair in dist/bytes.js. Both directions matter now that
// binary bodies (a favicon's PNG bytes) travel base64 across the
// page → service-worker read hop: a round-trip bug there would surface
// only as a mis-rendered icon, miles from its cause.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bytesToBase64, base64ToBytes, decodeDataUrl } from '../../dist/bytes.js';

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

test('decodeDataUrl: base64 and plain payloads, type defaults and parameters', () => {
  const b64 = decodeDataUrl('data:image/png;base64,AAEC/w==');
  assert.equal(b64.contentType, 'image/png');
  assert.deepEqual([...b64.bytes], [0, 1, 2, 255]);
  // Percent escapes become bytes, even ones that aren't UTF-8.
  const plain = decodeDataUrl('data:text/plain;charset=utf-8,a%20b%FF%2');
  assert.equal(plain.contentType, 'text/plain');
  assert.deepEqual([...plain.bytes], [0x61, 0x20, 0x62, 0xff, 0x25, 0x32]);
  // No type means text/plain; non-ASCII text is kept as UTF-8.
  const bare = decodeDataUrl('data:,hé');
  assert.equal(bare.contentType, 'text/plain');
  assert.equal(new TextDecoder().decode(bare.bytes), 'hé');
});

test('decodeDataUrl: null for malformed URLs', () => {
  assert.equal(decodeDataUrl('data:text/plain'), null);
  assert.equal(decodeDataUrl('data:;base64,@@@'), null);
  assert.equal(decodeDataUrl('https://example.com/,x'), null);
});
