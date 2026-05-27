// Tests for the pure ref parser used by the userscript viewer to
// turn `sourcemonkey://…:L:C` stack refs in log messages into
// clickable links. Compiled output lives at dist/stack-link.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseStackRefs } from '../../dist/stack-link.js';

test('parseStackRefs: empty / no match yields a single text run', () => {
  assert.deepEqual(parseStackRefs('hello world', 'id-1'), [
    { kind: 'text', text: 'hello world' },
  ]);
  // Empty input emits no runs; the caller's fast-path covers display.
  assert.deepEqual(parseStackRefs('', 'id-1'), []);
});

test('parseStackRefs: missing scriptId disables matching', () => {
  const t = 'at sourcemonkey://abc/foo.user.js:5:3';
  assert.deepEqual(parseStackRefs(t, ''), [{ kind: 'text', text: t }]);
});

test('parseStackRefs: refs for a different script id stay plain text', () => {
  const t = 'at sourcemonkey://other-id/Foo.user.js:5:3';
  assert.deepEqual(parseStackRefs(t, 'this-id'), [{ kind: 'text', text: t }]);
});

test('parseStackRefs: extracts URL + line + col for each match', () => {
  const id = 'aaaa-bbbb';
  const t =
    'TypeError: x\n    at sourcemonkey://aaaa-bbbb/Foo.user.js:53:31\n' +
    '    at sourcemonkey://aaaa-bbbb/Foo.user.js:1:4664';
  const runs = parseStackRefs(t, id);
  // text, ref, text, ref — no trailing text since the input ends on
  // the second ref.
  assert.equal(runs.length, 4);
  assert.equal(runs[0].kind, 'text');

  assert.equal(runs[1].kind, 'ref');
  assert.equal(runs[1].text, 'sourcemonkey://aaaa-bbbb/Foo.user.js:53:31');
  assert.equal(runs[1].url, 'sourcemonkey://aaaa-bbbb/Foo.user.js');
  assert.equal(runs[1].line, 53);
  assert.equal(runs[1].col, 31);

  assert.equal(runs[2].kind, 'text');

  assert.equal(runs[3].kind, 'ref');
  assert.equal(runs[3].url, 'sourcemonkey://aaaa-bbbb/Foo.user.js');
  assert.equal(runs[3].line, 1);
  assert.equal(runs[3].col, 4664);
});

test('parseStackRefs: V8 named-frame `at fn (URL:L:C)` shape parses without the trailing paren', () => {
  const id = 'X';
  const t = '    at __smWaitForRunAt (sourcemonkey://X/Foo.user.js:1:4602)';
  const runs = parseStackRefs(t, id);
  const refs = runs.filter((r) => r.kind === 'ref');
  assert.equal(refs.length, 1);
  assert.equal(refs[0].url, 'sourcemonkey://X/Foo.user.js');
  assert.equal(refs[0].line, 1);
  assert.equal(refs[0].col, 4602);
  assert.equal(refs[0].text, 'sourcemonkey://X/Foo.user.js:1:4602');
});

test('parseStackRefs: refs with different filenames keep distinct URLs', () => {
  // A future per-require sourceURL scheme would surface as different
  // filename segments under the same scriptId. The parser keeps each
  // URL verbatim so the caller can route to the right tab.
  const id = 'X';
  const t =
    'at sourcemonkey://X/main.user.js:7:1\n' +
    'at sourcemonkey://X/require-jquery.js:42:9';
  const runs = parseStackRefs(t, id);
  const refs = runs.filter((r) => r.kind === 'ref');
  assert.equal(refs.length, 2);
  assert.equal(refs[0].url, 'sourcemonkey://X/main.user.js');
  assert.equal(refs[1].url, 'sourcemonkey://X/require-jquery.js');
});
