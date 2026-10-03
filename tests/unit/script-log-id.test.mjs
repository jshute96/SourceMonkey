// Unit tests for the pure helpers in src/extension/script-log-id.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeLogIds } from '../../dist/extension/script-log-id.js';
import { buildSourceUrl } from '../../dist/script-source-url.js';

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

test('computeLogIds: a URL relativePath contributes its decoded filename', () => {
  // Scripts installed from the web store the full URL. The log ID is
  // what the user reads in the viewer and in SW console lines, so it
  // gets the filename a human would recognise — no `%20`, no query.
  const m = computeLogIds([
    { id: 'a', relativePath: 'https://update.greasyfork.org/scripts/1/My%20Script.user.js?v=2' },
  ]);
  assert.equal(m.get('a'), 'My Script.user.js');
});

test('computeLogIds: two URLs that decode to the same filename still dedup', () => {
  const m = computeLogIds([
    { id: 'a', relativePath: 'https://a.example/x/My%20Script.user.js' },
    { id: 'b', relativePath: 'https://b.example/y/My Script.user.js' },
  ]);
  assert.equal(m.get('a'), 'My Script.user.js#1');
  assert.equal(m.get('b'), 'My Script.user.js#2');
});

// ---------- the seam with script-source-url ----------
//
// computeLogIds produces a *display* string; buildSourceUrl has to
// turn that back into something URL-safe. Both ends are tested on
// their own above and in script-source-url.test.mjs — these pin the
// composition, which is where the round-trip can silently rot.

test('a GreasyFork URL survives the log-ID → sourceURL round trip', () => {
  const url = 'https://update.greasyfork.org/scripts/34613/My%20Script%20%F0%9F%9A%80.user.js';
  const label = computeLogIds([{ id: 'a', relativePath: url }]).get('a');
  assert.equal(label, 'My Script 🚀.user.js');
  // Re-encoded back to exactly the escapes the URL carried, so devtools
  // and any already-stored stack refs still line up.
  assert.equal(
    buildSourceUrl(label),
    'sourcemonkey://SourceMonkey/My%20Script%20%F0%9F%9A%80/My%20Script%20%F0%9F%9A%80.user.js',
  );
});

test('a dupe suffix survives the round trip without colliding with the name', () => {
  const m = computeLogIds([
    { id: 'a', relativePath: 'https://a.example/My%20Script.user.js' },
    { id: 'b', relativePath: 'https://b.example/My%20Script.user.js' },
  ]);
  assert.equal(buildSourceUrl(m.get('a')), 'sourcemonkey://SourceMonkey/My%20Script%231/My%20Script.user.js');
  assert.equal(buildSourceUrl(m.get('b')), 'sourcemonkey://SourceMonkey/My%20Script%232/My%20Script.user.js');
});

test('no log ID can produce a sourceURL the stack-ref parser would truncate', () => {
  // parseStackRefs stops a ref at whitespace or a paren, so a label
  // that leaked either would stop linkifying its own stack frames.
  const paths = [
    'https://x/Foo%20(Beta)%20%E2%80%94%20v2.user.js',
    'https://x/a%2Fb.user.js',
    'https://x/tab%09sep.user.js',
    'plain/on-disk name.user.js',
  ];
  for (const [i, relativePath] of paths.entries()) {
    const label = computeLogIds([{ id: String(i), relativePath }]).get(String(i));
    assert.match(buildSourceUrl(label), /^[^\s()#]+$/, `label ${JSON.stringify(label)}`);
  }
});
