// Unit tests for the sticky numbers' pure helpers
// (src/extension/sticky-numbers.ts): handing numbers out, holding a
// removed item's number back, and which scripts and collections get one.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  numberedCollectionIds, numberedScriptIds, numbersFrom, reconcileNumbers,
} from '../../dist/extension/sticky-numbers.js';

const DAY = 24 * 60 * 60 * 1000;
const empty = { byId: {}, retired: {} };

test('new items get the lowest free numbers, in the order given', () => {
  const { numbers, changed } = reconcileNumbers(empty, ['a', 'b', 'c'], 0);
  assert.equal(changed, true);
  assert.deepEqual(numbers, { byId: { a: 1, b: 2, c: 3 }, retired: {} });
  // Nothing to do the second time.
  assert.equal(reconcileNumbers(numbers, ['a', 'b', 'c'], 0).changed, false);
});

test('a removed item\'s number is held for 7 days, then reused', () => {
  const start = { byId: { a: 1, b: 2, c: 3 }, retired: {} };
  const removed = reconcileNumbers(start, ['a', 'c'], 100).numbers;
  assert.deepEqual(removed, { byId: { a: 1, c: 3 }, retired: { 2: 100 } });
  // A new item skips the held number.
  assert.deepEqual(reconcileNumbers(removed, ['a', 'c', 'd'], 100 + DAY).numbers.byId, { a: 1, c: 3, d: 4 });
  // After 7 days it is free again, and lowest.
  const later = reconcileNumbers(removed, ['a', 'c', 'd'], 100 + 7 * DAY).numbers;
  assert.deepEqual(later, { byId: { a: 1, c: 3, d: 2 }, retired: {} });
});

test('a number already retired keeps its first time; one in use again is no longer retired', () => {
  const prior = { byId: { a: 1, b: 3, gone: 2 }, retired: { 2: 50, 3: 60 } };
  const { numbers } = reconcileNumbers(prior, ['a', 'b'], 1000);
  assert.deepEqual(numbers, { byId: { a: 1, b: 3 }, retired: { 2: 50 } });
});

test('two items sharing a number: the first keeps it, the other gets a new one', () => {
  const { numbers } = reconcileNumbers({ byId: { a: 1, b: 1 }, retired: {} }, ['a', 'b'], 0);
  assert.deepEqual(numbers.byId, { a: 1, b: 2 });
});

test('a malformed row reads as empty', () => {
  assert.deepEqual(numbersFrom(undefined), empty);
  assert.deepEqual(numbersFrom('x'), empty);
});

const collections = [
  { id: 'cz', path: 'file:///z/', scriptIds: ['s2'] },
  { id: 'run', path: 'container:sm-dev:D1-ab12', scriptIds: ['run1'] },
  { id: 'ca', path: 'file:///a/', scriptIds: ['s1', 'missing'] },
];

test('scripts in sm-dev test collections get no number; collections are taken by path', () => {
  assert.deepEqual(numberedScriptIds(['s1', 's2', 'run1', 'loose'], collections), ['s1', 's2', 'loose']);
});

test('collections are numbered by path, except sm-dev test collections', () => {
  assert.deepEqual(numberedCollectionIds(collections), ['ca', 'cz']);
});
