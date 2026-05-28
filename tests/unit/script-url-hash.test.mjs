// Tests for the pure URL-fragment helpers used by the viewer's
// hash-navigation. Compiled output lives at dist/script-url-hash.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseHash, buildHash } from '../../dist/script-url-hash.js';

test('parseHash: empty and "#" both map to empty', () => {
  assert.deepEqual(parseHash(''), { kind: 'empty' });
  assert.deepEqual(parseHash('#'), { kind: 'empty' });
});

test('parseHash: "Log" routes to the log pane', () => {
  assert.deepEqual(parseHash('Log'), { kind: 'log' });
  assert.deepEqual(parseHash('#Log'), { kind: 'log' });
});

test('parseHash: case-sensitive — "log" is treated as a filename', () => {
  // We intentionally don't normalize case; "log" parses as a filename
  // so a script named log.user.js still resolves.
  assert.deepEqual(parseHash('log'), { kind: 'code', filename: 'log' });
});

test('parseHash: bare filename', () => {
  assert.deepEqual(parseHash('foo.user.js'), {
    kind: 'code',
    filename: 'foo.user.js',
  });
  assert.deepEqual(parseHash('#foo.user.js'), {
    kind: 'code',
    filename: 'foo.user.js',
  });
});

test('parseHash: filename + line', () => {
  assert.deepEqual(parseHash('foo.user.js:42'), {
    kind: 'code',
    filename: 'foo.user.js',
    line: 42,
  });
});

test('parseHash: filename + line + column', () => {
  assert.deepEqual(parseHash('foo.user.js:42:7'), {
    kind: 'code',
    filename: 'foo.user.js',
    line: 42,
    col: 7,
  });
});

test('parseHash: invalid line drops line and column', () => {
  assert.deepEqual(parseHash('foo.user.js:abc:7'), {
    kind: 'code',
    filename: 'foo.user.js',
  });
  assert.deepEqual(parseHash('foo.user.js:0:7'), {
    kind: 'code',
    filename: 'foo.user.js',
  });
  assert.deepEqual(parseHash('foo.user.js:-1'), {
    kind: 'code',
    filename: 'foo.user.js',
  });
});

test('parseHash: percent-decodes the filename', () => {
  assert.deepEqual(parseHash('My%20Script.user.js:5'), {
    kind: 'code',
    filename: 'My Script.user.js',
    line: 5,
  });
});

test('parseHash: malformed percent-escape returns raw filename without throwing', () => {
  assert.deepEqual(parseHash('%E0%A4.user.js'), {
    kind: 'code',
    filename: '%E0%A4.user.js',
  });
});

test('buildHash: main tab without highlight → empty fragment', () => {
  assert.equal(buildHash({ tab: 'main' }), '');
});

test('buildHash: log tab', () => {
  assert.equal(buildHash({ tab: 'log' }), 'Log');
});

test('buildHash: main tab with highlight includes the filename', () => {
  assert.equal(
    buildHash({ tab: 'main', filename: 'foo.user.js', line: 7 }),
    'foo.user.js:7',
  );
  assert.equal(
    buildHash({ tab: 'main', filename: 'foo.user.js', line: 7, col: 3 }),
    'foo.user.js:7:3',
  );
});

test('buildHash: require tab with and without highlight', () => {
  assert.equal(
    buildHash({ tab: 'require', filename: 'jquery.js' }),
    'jquery.js',
  );
  assert.equal(
    buildHash({ tab: 'require', filename: 'jquery.js', line: 42 }),
    'jquery.js:42',
  );
});

test('buildHash: percent-encodes spaces and other non-URL chars in filename', () => {
  assert.equal(
    buildHash({ tab: 'main', filename: 'My Script.user.js', line: 5 }),
    'My%20Script.user.js:5',
  );
});

test('round-trip: build → parse preserves filename / line / col', () => {
  const h = buildHash({
    tab: 'require',
    filename: 'jquery-3.6.0.js',
    line: 100,
    col: 5,
  });
  assert.deepEqual(parseHash(h), {
    kind: 'code',
    filename: 'jquery-3.6.0.js',
    line: 100,
    col: 5,
  });
});
