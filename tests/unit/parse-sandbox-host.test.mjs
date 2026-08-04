// Tests for the verdict guard in src/parse-sandbox-host.ts (compiled
// to dist/parse-sandbox-host.js).
//
// The sandbox is the only part of this feature that can accuse a
// script, and `applyParseCheck` treats any status that isn't `ok` or
// `unknown` as `invalid`. So a reply in an unexpected shape — a typo'd
// status, a truncated object, a `null` in the array — must be rejected
// at the transport boundary rather than passed through to become a
// disabled script.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isParseVerdict } from '../../dist/parse-sandbox-host.js';

test('accepts the three real statuses', () => {
  assert.equal(isParseVerdict({ status: 'ok' }), true);
  assert.equal(isParseVerdict({ status: 'unknown' }), true);
  assert.equal(isParseVerdict({ status: 'syntax-error', message: 'boom' }), true);
});

test('rejects anything else', () => {
  // A near-miss spelling is the dangerous one: it is not `ok` and not
  // `unknown`, so passing it through reads as `invalid`.
  assert.equal(isParseVerdict({ status: 'syntaxError' }), false);
  assert.equal(isParseVerdict({ status: 'error' }), false);
  assert.equal(isParseVerdict({ status: 'OK' }), false);
  assert.equal(isParseVerdict({}), false);
  assert.equal(isParseVerdict({ status: 1 }), false);
  assert.equal(isParseVerdict(null), false);
  assert.equal(isParseVerdict(undefined), false);
  assert.equal(isParseVerdict('ok'), false);
});
