import test from 'node:test';
import assert from 'node:assert/strict';

import {
  REFRESH_ERRORS_KEY,
  coerceRefreshErrorMap,
  describeRefreshError,
} from '../../dist/extension/refresh-error.js';

test('the storage key is the documented one', () => {
  // Named in docs/storage.md and read by the collections page's
  // session-change listener; a rename has to move both.
  assert.equal(REFRESH_ERRORS_KEY, 'refresh-errors');
});

test('the message names the consequence and carries the reason', () => {
  const msg = describeRefreshError('The disk is full');
  assert.match(msg, /could not be saved/);
  assert.match(msg, /The disk is full/);
  // House style: capitalized, no trailing period — the same string is
  // rendered alone and after prefixes.
  assert.match(msg, /^[A-Z]/);
  assert.ok(!msg.endsWith('.'));
});

test('coerce keeps string reasons and drops everything else', () => {
  assert.deepEqual(
    coerceRefreshErrorMap({ a: 'full', b: 7, c: null, d: { x: 1 }, e: 'busy' }),
    { a: 'full', e: 'busy' },
  );
});

// The coercion runs on both the direct read and the `storage.onChanged`
// newValue, and the change event delivers `undefined` when the key is
// removed — so a non-object must be an empty map, not a throw.
test('coerce turns a missing or non-object value into an empty map', () => {
  for (const value of [undefined, null, 'nope', 42, true]) {
    assert.deepEqual(coerceRefreshErrorMap(value), {}, `for ${String(value)}`);
  }
});

test('coerce does not alias its input', () => {
  const input = { a: 'full' };
  const out = coerceRefreshErrorMap(input);
  out.b = 'added';
  assert.deepEqual(input, { a: 'full' });
});
