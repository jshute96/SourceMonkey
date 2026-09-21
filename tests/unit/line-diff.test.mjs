// Unit tests for the compare page's line diff (src/line-diff.ts): the
// edit script it finds, the hunks it folds that into, and the counts.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

const { countChanges, diffLines, splitLines, toHunks } = await import('../../dist/line-diff.js');

// The diff as a compact script, one op per line: ` same`, `-del`, `+add`.
function script(ops) {
  return ops.map((op) => (op.kind === 'same' ? ' ' : op.kind === 'del' ? '-' : '+') + op.text);
}

// Replaying the ops must rebuild both inputs exactly; every diff below
// is checked against this before anything about its shape.
function assertRoundTrips(a, b, ops) {
  const fromA = ops.filter((op) => op.kind !== 'add').map((op) => op.text);
  const fromB = ops.filter((op) => op.kind !== 'del').map((op) => op.text);
  assert.deepEqual(fromA, a);
  assert.deepEqual(fromB, b);
  // Line numbers count up on each side without gaps.
  let aLine = 0;
  let bLine = 0;
  for (const op of ops) {
    if (op.kind !== 'add') assert.equal(op.aLine, ++aLine);
    else assert.equal(op.aLine, undefined);
    if (op.kind !== 'del') assert.equal(op.bLine, ++bLine);
    else assert.equal(op.bLine, undefined);
  }
}

test('splitLines: no phantom last line after a trailing newline', () => {
  assert.deepEqual(splitLines(''), []);
  assert.deepEqual(splitLines('a'), ['a']);
  assert.deepEqual(splitLines('a\n'), ['a']);
  assert.deepEqual(splitLines('a\n\n'), ['a', '']);
  assert.deepEqual(splitLines('a\nb'), ['a', 'b']);
});

test('identical inputs are all same', () => {
  const a = ['x', 'y', 'z'];
  const ops = diffLines(a, [...a]);
  assertRoundTrips(a, a, ops);
  assert.deepEqual(script(ops), [' x', ' y', ' z']);
  assert.deepEqual(countChanges(ops), { removed: 0, added: 0 });
  assert.deepEqual(toHunks(ops), []);
});

test('empty against something is all added, and the reverse all removed', () => {
  const ops = diffLines([], ['a', 'b']);
  assertRoundTrips([], ['a', 'b'], ops);
  assert.deepEqual(script(ops), ['+a', '+b']);
  const back = diffLines(['a', 'b'], []);
  assertRoundTrips(['a', 'b'], [], back);
  assert.deepEqual(script(back), ['-a', '-b']);
  assert.deepEqual(diffLines([], []), []);
});

test('a changed line in the middle is one deletion beside one insertion', () => {
  const a = ['one', 'two', 'three'];
  const b = ['one', 'TWO', 'three'];
  const ops = diffLines(a, b);
  assertRoundTrips(a, b, ops);
  assert.deepEqual(script(ops), [' one', '-two', '+TWO', ' three']);
  assert.deepEqual(countChanges(ops), { removed: 1, added: 1 });
});

test('the classic Myers example finds a shortest script', () => {
  const a = 'ABCABBA'.split('');
  const b = 'CBABAC'.split('');
  const ops = diffLines(a, b);
  assertRoundTrips(a, b, ops);
  // The shortest edit script for this pair has 5 edits.
  const { removed, added } = countChanges(ops);
  assert.equal(removed + added, 5);
});

test('changes far apart become separate hunks with three lines of context', () => {
  const a = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
  const b = [...a];
  b[4] = 'changed 5';
  b.splice(20, 0, 'inserted after 20');
  const ops = diffLines(a, b);
  assertRoundTrips(a, b, ops);
  const hunks = toHunks(ops);
  assert.equal(hunks.length, 2);
  assert.deepEqual(script(hunks[0].ops), [
    ' line 2', ' line 3', ' line 4', '-line 5', '+changed 5', ' line 6', ' line 7', ' line 8',
  ]);
  assert.deepEqual(
    [hunks[0].aStart, hunks[0].aCount, hunks[0].bStart, hunks[0].bCount],
    [2, 7, 2, 7],
  );
  assert.deepEqual(script(hunks[1].ops), [
    ' line 18', ' line 19', ' line 20', '+inserted after 20', ' line 21', ' line 22', ' line 23',
  ]);
  assert.deepEqual(
    [hunks[1].aStart, hunks[1].aCount, hunks[1].bStart, hunks[1].bCount],
    [18, 6, 18, 7],
  );
});

test('changes within twice the context share a hunk', () => {
  const a = Array.from({ length: 12 }, (_, i) => `l${i + 1}`);
  const b = [...a];
  b[2] = 'x';
  b[8] = 'y';
  const hunks = toHunks(diffLines(a, b));
  assert.equal(hunks.length, 1);
  assert.equal(hunks[0].aStart, 1);
  assert.equal(hunks[0].aCount, 12);
});

test('hunks at the very start and end are not padded past the file', () => {
  const a = ['first', 'mid', 'last'];
  const b = ['FIRST', 'mid', 'LAST'];
  const hunks = toHunks(diffLines(a, b), 1);
  assert.equal(hunks.length, 1);
  assert.deepEqual(script(hunks[0].ops), ['-first', '+FIRST', ' mid', '-last', '+LAST']);
  // An insertion into an empty file starts at 0 on the empty side.
  const [ins] = toHunks(diffLines([], ['a']));
  assert.deepEqual([ins.aStart, ins.aCount, ins.bStart, ins.bCount], [0, 0, 1, 1]);
});

test('a large edit count falls back to a whole replacement that still round-trips', () => {
  const a = Array.from({ length: 4000 }, (_, i) => `a${i}`);
  const b = Array.from({ length: 4000 }, (_, i) => `b${i}`);
  const ops = diffLines(a, b);
  assertRoundTrips(a, b, ops);
  assert.deepEqual(countChanges(ops), { removed: 4000, added: 4000 });
});

test('a long file with a small edit stays fast and exact', () => {
  const a = Array.from({ length: 20000 }, (_, i) => `line ${i}`);
  const b = [...a];
  b.splice(10000, 2, 'new one', 'new two', 'new three');
  const started = Date.now();
  const ops = diffLines(a, b);
  assert.ok(Date.now() - started < 1000);
  assertRoundTrips(a, b, ops);
  assert.deepEqual(countChanges(ops), { removed: 2, added: 3 });
});

test('duplicate lines are matched sensibly', () => {
  const a = ['}', '', 'function f() {', '  return 1;', '}', ''];
  const b = ['}', '', 'function f() {', '  return 2;', '}', '', 'function g() {', '}', ''];
  const ops = diffLines(a, b);
  assertRoundTrips(a, b, ops);
  assert.deepEqual(countChanges(ops), { removed: 1, added: 4 });
});
