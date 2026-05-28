// Tests for the pure ref parser used by the userscript viewer to
// turn stack-trace `<scheme>://…:L:C` refs in log messages into
// clickable links. Compiled output lives at dist/stack-link.js.
//
// The parser is a pure URL extractor — it doesn't know which refs
// belong to which script. The viewer filters by matching URLs
// against its tabs.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseStackRefs } from '../../dist/stack-link.js';

test('parseStackRefs: empty input yields no runs', () => {
  assert.deepEqual(parseStackRefs(''), []);
});

test('parseStackRefs: no recognized URL yields a single text run', () => {
  assert.deepEqual(parseStackRefs('hello world'), [
    { kind: 'text', text: 'hello world' },
  ]);
});

test('parseStackRefs: extracts sourcemonkey:// refs with line + col', () => {
  const t =
    'TypeError: x\n    at sourcemonkey://aaaa-bbbb/Foo.user.js:53:31\n' +
    '    at sourcemonkey://aaaa-bbbb/Foo.user.js:1:4664';
  const runs = parseStackRefs(t);
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

test('parseStackRefs: extracts http/https URLs too (for @require refs)', () => {
  // A frame from inside a require's body carries the require URL as
  // its sourceURL — the parser has to extract those so the viewer
  // can linkify them to the corresponding require tab.
  const t = '    at https://cdn.example.com/jquery.js:97:11';
  const runs = parseStackRefs(t);
  const refs = runs.filter((r) => r.kind === 'ref');
  assert.equal(refs.length, 1);
  assert.equal(refs[0].url, 'https://cdn.example.com/jquery.js');
  assert.equal(refs[0].line, 97);
  assert.equal(refs[0].col, 11);
});

test('parseStackRefs: query strings are part of the URL, not the line:col', () => {
  // The real-world @require URL the gm4-polyfill carries a
  // `?updated=20180103` cache-bust suffix. The engine reports stack
  // frames with the suffix intact; the parser must keep it in the
  // URL portion and only peel off the final `:97:11` as line:col.
  const t = '    at https://greasemonkey.github.io/gm4-polyfill/gm4-polyfill.js?updated=20180103:97:11';
  const runs = parseStackRefs(t);
  const refs = runs.filter((r) => r.kind === 'ref');
  assert.equal(refs.length, 1);
  assert.equal(
    refs[0].url,
    'https://greasemonkey.github.io/gm4-polyfill/gm4-polyfill.js?updated=20180103',
  );
  assert.equal(refs[0].line, 97);
  assert.equal(refs[0].col, 11);
});

test('parseStackRefs: port numbers in the authority do not confuse line:col', () => {
  // Greedy `[^\s()]+` plus `:(\d+):(\d+)` anchored at the end means
  // the engine backtracks to the FINAL `:digits:digits` even when the
  // URL has its own `:port` mid-string.
  const t = 'at http://localhost:8080/foo.js:97:11';
  const runs = parseStackRefs(t);
  const refs = runs.filter((r) => r.kind === 'ref');
  assert.equal(refs.length, 1);
  assert.equal(refs[0].url, 'http://localhost:8080/foo.js');
  assert.equal(refs[0].line, 97);
  assert.equal(refs[0].col, 11);
});

test('parseStackRefs: V8 named-frame `at fn (URL:L:C)` shape parses without the trailing paren', () => {
  const t = '    at someFn (sourcemonkey://X/Foo.user.js:1:4602)';
  const runs = parseStackRefs(t);
  const refs = runs.filter((r) => r.kind === 'ref');
  assert.equal(refs.length, 1);
  assert.equal(refs[0].url, 'sourcemonkey://X/Foo.user.js');
  assert.equal(refs[0].line, 1);
  assert.equal(refs[0].col, 4602);
  assert.equal(refs[0].text, 'sourcemonkey://X/Foo.user.js:1:4602');
});

test('parseStackRefs: refs with different filenames keep distinct URLs', () => {
  // Per-require sourceURLs surface as different URLs in the stack.
  // The parser keeps each URL verbatim; the viewer routes to the
  // right tab by matching URL to tab.sourceUrl.
  const t =
    'at sourcemonkey://X/main.user.js:7:1\n' +
    'at https://cdn/require-jquery.js:42:9';
  const runs = parseStackRefs(t);
  const refs = runs.filter((r) => r.kind === 'ref');
  assert.equal(refs.length, 2);
  assert.equal(refs[0].url, 'sourcemonkey://X/main.user.js');
  assert.equal(refs[1].url, 'https://cdn/require-jquery.js');
});

test('parseStackRefs: file:// URLs (e.g. local require) are recognized', () => {
  const t = '    at file:///home/u/scripts/mylib.js:12:34';
  const runs = parseStackRefs(t);
  const refs = runs.filter((r) => r.kind === 'ref');
  assert.equal(refs.length, 1);
  assert.equal(refs[0].url, 'file:///home/u/scripts/mylib.js');
});
