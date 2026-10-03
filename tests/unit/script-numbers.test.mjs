// Unit tests for the script numbers' pure helpers
// (src/extension/script-numbers.ts): handing numbers out, holding a
// removed script's number back, and which scripts get one.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { numberedScriptIds, reconcileScriptNumbers, scriptNumbersFrom } from '../../dist/extension/script-numbers.js';

const DAY = 24 * 60 * 60 * 1000;
const empty = { byScript: {}, retired: {} };

test('new scripts get the lowest free numbers, in the order given', () => {
  const { numbers, changed } = reconcileScriptNumbers(empty, ['a', 'b', 'c'], 0);
  assert.equal(changed, true);
  assert.deepEqual(numbers, { byScript: { a: 1, b: 2, c: 3 }, retired: {} });
  // Nothing to do the second time.
  assert.equal(reconcileScriptNumbers(numbers, ['a', 'b', 'c'], 0).changed, false);
});

test('a removed script\'s number is held for 7 days, then reused', () => {
  const start = { byScript: { a: 1, b: 2, c: 3 }, retired: {} };
  const removed = reconcileScriptNumbers(start, ['a', 'c'], 100).numbers;
  assert.deepEqual(removed, { byScript: { a: 1, c: 3 }, retired: { 2: 100 } });
  // A new script skips the held number.
  assert.deepEqual(reconcileScriptNumbers(removed, ['a', 'c', 'd'], 100 + DAY).numbers.byScript, { a: 1, c: 3, d: 4 });
  // After 7 days it is free again, and lowest.
  const later = reconcileScriptNumbers(removed, ['a', 'c', 'd'], 100 + 7 * DAY).numbers;
  assert.deepEqual(later, { byScript: { a: 1, c: 3, d: 2 }, retired: {} });
});

test('a number already retired keeps its first time; one in use again is no longer retired', () => {
  const prior = { byScript: { a: 1, b: 3, gone: 2 }, retired: { 2: 50, 3: 60 } };
  const { numbers } = reconcileScriptNumbers(prior, ['a', 'b'], 1000);
  assert.deepEqual(numbers, { byScript: { a: 1, b: 3 }, retired: { 2: 50 } });
});

test('two scripts sharing a number: the first keeps it, the other gets a new one', () => {
  const { numbers } = reconcileScriptNumbers({ byScript: { a: 1, b: 1 }, retired: {} }, ['a', 'b'], 0);
  assert.deepEqual(numbers.byScript, { a: 1, b: 2 });
});

test('a malformed row reads as empty', () => {
  assert.deepEqual(scriptNumbersFrom(undefined), empty);
  assert.deepEqual(scriptNumbersFrom('x'), empty);
});

test('scripts in sm-dev test collections get no number; collections are taken by path', () => {
  const scripts = ['s1', 's2', 'run1', 'loose'];
  const collections = [
    { path: 'file:///z/', scriptIds: ['s2'] },
    { path: 'container:sm-dev:D1-ab12', scriptIds: ['run1'] },
    { path: 'file:///a/', scriptIds: ['s1', 'missing'] },
  ];
  assert.deepEqual(numberedScriptIds(scripts, collections), ['s1', 's2', 'loose']);
});
