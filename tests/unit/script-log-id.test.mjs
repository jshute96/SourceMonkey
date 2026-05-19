// Unit tests for the pure helpers in src/script-log-id.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  basenameOf,
  computeLogIds,
} from '../../dist/script-log-id.js';

test('basenameOf returns leaf of a multi-segment path', () => {
  assert.equal(basenameOf('sites/example.com/foo.user.js'), 'foo.user.js');
});

test('basenameOf returns the input when there is no slash', () => {
  assert.equal(basenameOf('foo.user.js'), 'foo.user.js');
});

test('basenameOf handles a trailing path component with dot prefix', () => {
  assert.equal(basenameOf('a/b/.foo.user.js'), '.foo.user.js');
});

test('computeLogIds: a single script gets the bare basename', () => {
  const m = computeLogIds([{ id: 'a', relativePath: 'foo.user.js' }]);
  assert.deepEqual([...m.entries()], [['a', 'foo.user.js']]);
});

test('computeLogIds: distinct basenames each get the bare name (no #)', () => {
  const m = computeLogIds([
    { id: 'a', relativePath: 'foo.user.js' },
    { id: 'b', relativePath: 'bar.user.js' },
    { id: 'c', relativePath: 'sub/baz.user.js' },
  ]);
  assert.equal(m.get('a'), 'foo.user.js');
  assert.equal(m.get('b'), 'bar.user.js');
  assert.equal(m.get('c'), 'baz.user.js');
});

test('computeLogIds: dupes get #1/#2 suffixes in id-lex order', () => {
  const m = computeLogIds([
    { id: 'zzz', relativePath: 'sites/a/foo.user.js' },
    { id: 'aaa', relativePath: 'sites/b/foo.user.js' },
  ]);
  // Sorted by id ascending → 'aaa' first → #1.
  assert.equal(m.get('aaa'), 'foo.user.js#1');
  assert.equal(m.get('zzz'), 'foo.user.js#2');
});

test('computeLogIds: triplets get #1/#2/#3', () => {
  const m = computeLogIds([
    { id: 'c', relativePath: 'a/x.user.js' },
    { id: 'a', relativePath: 'b/x.user.js' },
    { id: 'b', relativePath: 'c/x.user.js' },
  ]);
  assert.equal(m.get('a'), 'x.user.js#1');
  assert.equal(m.get('b'), 'x.user.js#2');
  assert.equal(m.get('c'), 'x.user.js#3');
});

test('computeLogIds: a non-dupe basename remains unsuffixed even when other dupes exist', () => {
  const m = computeLogIds([
    { id: 'a', relativePath: 'one/dup.user.js' },
    { id: 'b', relativePath: 'two/dup.user.js' },
    { id: 'c', relativePath: 'solo.user.js' },
  ]);
  assert.equal(m.get('c'), 'solo.user.js');
  assert.equal(m.get('a'), 'dup.user.js#1');
  assert.equal(m.get('b'), 'dup.user.js#2');
});

test('computeLogIds: empty input yields empty map', () => {
  const m = computeLogIds([]);
  assert.equal(m.size, 0);
});

test('computeLogIds: assignment is stable across calls with same input', () => {
  const inputs = [
    { id: 'b', relativePath: 'a/x.user.js' },
    { id: 'a', relativePath: 'b/x.user.js' },
  ];
  const first = computeLogIds(inputs);
  const second = computeLogIds(inputs);
  assert.deepEqual([...first.entries()], [...second.entries()]);
});
