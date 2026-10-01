// Tests for the pure stack-ref helpers the userscript viewer uses to
// turn `<scheme>://…:L:C` refs in log messages into clickable,
// readable links. Compiled output lives at dist/stack-link.js.
//
// `parseStackRefs` is a pure URL extractor — it doesn't know which
// refs belong to which script. The viewer filters by matching URLs
// against its tabs.
//
// `displayRefText` decides how a ref *reads*, which is a separate
// question from which tab it points at: our own synthetic URLs carry a
// percent-encoded log label that has to be undone for display, and
// everything else keeps the bytes it arrived with.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { displayRefText, parseStackRefs, remapStackText } from '../../dist/stack-link.js';

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

// ---------- displayRefText ----------
//
// The decode half of the round trip `script-source-url.ts` opens. Its
// `encodeSegment` escapes everything outside `[A-Za-z0-9._~-]`, which
// includes `%` itself, so `decodeURIComponent` is a strict inverse
// rather than an approximate one — that is what these pin.

const ROOT = 'sourcemonkey://SourceMonkey';

test('displayRefText: the #N dedup suffix reads as a #', () => {
  // The reported bug. `foo.user.js#2` cannot go into a `//# sourceURL=`
  // with a literal `#` (it would start a fragment), so the wire form is
  // `foo%232` and the display form has to undo it.
  const url = `${ROOT}/foo%232/foo.user.js`;
  assert.equal(
    displayRefText(`${url}:12:3`, url),
    `${ROOT}/foo#2/foo.user.js:12:3`,
  );
});

test('displayRefText: a literal percent in a name survives the round trip', () => {
  // A file really called `a%20b.user.js` encodes to `a%2520b`, so
  // decoding once gives back the on-disk name — NOT `a b.user.js`.
  // names-and-paths.md requires the name on screen to be the name on
  // disk, and this is the case a non-inverse decoder would break.
  const url = `${ROOT}/a%2520b/a%2520b.user.js`;
  assert.equal(
    displayRefText(`${url}:1:1`, url),
    `${ROOT}/a%20b/a%20b.user.js:1:1`,
  );
});

test('displayRefText: a malformed escape leaves the ref intact', () => {
  // `100% free.user.js` → the `%20free` fragment below makes
  // decodeURIComponent throw. One undecoded ref beats a blank one.
  const url = `${ROOT}/100%_free/x.user.js`;
  assert.equal(displayRefText(`${url}:1:1`, url), `${url}:1:1`);
});

test('displayRefText: line and column are untouched', () => {
  // Digits never carry escapes, so decoding the whole ref rather than
  // just the URL portion has to be a no-op on the suffix.
  const url = `${ROOT}/x/x.user.js`;
  assert.equal(displayRefText(`${url}:0:0`, url), `${url}:0:0`);
});

test('displayRefText: real URLs keep their escapes', () => {
  // A ref is a coordinate, not a name: `%2F` here is a literal slash
  // inside a path segment, and decoding it would name a different file.
  for (const url of [
    'https://cdn.example.com/a%2Fb/lib%20one.js',
    'http://cdn.example.com/lib%20one.js',
    'file:///home/u/a%20b/lib.js',
  ]) {
    assert.equal(displayRefText(`${url}:9:9`, url), `${url}:9:9`);
  }
});

test('displayRefText: our scheme alone is not enough', () => {
  // The scheme is unregistered, so a hostile script can put any
  // `sourcemonkey://…` string in its own log message. Only the full
  // `sourcemonkey://SourceMonkey/` prefix is ours.
  const url = 'sourcemonkey://elsewhere/%2e%2e/x.js';
  assert.equal(displayRefText(`${url}:1:1`, url), `${url}:1:1`);
});

test('displayRefText: the root prefix must be followed by a slash', () => {
  // `sourcemonkey://SourceMonkeyEvil/…` is a different host that merely
  // starts with our name.
  const url = 'sourcemonkey://SourceMonkeyEvil/a%232/x.js';
  assert.equal(displayRefText(`${url}:1:1`, url), `${url}:1:1`);
});

// ---------- remapStackText ----------
//
// A script's entry with one `@require` (generated lines 2-3) ahead of
// the body (generated lines 5-7). Line 1 is the wrap head and line 4
// the `;` seam: ours, so unmappable.
const ENTRY = 'sourcemonkey://SourceMonkey/foo/foo.user.js';
const LIB = 'sourcemonkey://SourceMonkey/foo/cdn.example.com/lib.js';
const LAYOUT = {
  entryUrl: ENTRY,
  segments: [
    { url: LIB, content: '', generatedLine: 1, lineCount: 2 },
    { url: ENTRY, content: '', generatedLine: 4, lineCount: 3 },
  ],
};

test('remapStackText: frames in a require and in the body each get their own file and line', () => {
  const stack = `Error: x\n    at lib (${ENTRY}:3:9)\n    at ${ENTRY}:6:2`;
  assert.equal(
    remapStackText(stack, [LAYOUT]),
    `Error: x\n    at lib (${LIB}:2:9)\n    at ${ENTRY}:2:2`,
  );
});

test('remapStackText: other files and other scripts stay as they are', () => {
  const other = { entryUrl: 'sourcemonkey://SourceMonkey/bar/bar.user.js', segments: [] };
  const stack = [
    '    at https://example.com/app.js:3:1',
    `    at ${other.entryUrl}:3:1`,
    '    at sourcemonkey://SourceMonkey/__prelude.js:1:9',
  ].join('\n');
  assert.equal(remapStackText(stack, [LAYOUT, other]), stack);
});

test('remapStackText: a frame on our own wrap is named as the wrapper, not the script', () => {
  // Line 1 (the head, with the GM bindings) and line 4 (a seam) belong
  // to no file; left alone they would read as lines of foo.user.js.
  assert.equal(
    remapStackText(`    at ${ENTRY}:1:400\n    at ${ENTRY}:4:1`, [LAYOUT]),
    '    at sourcemonkey://SourceMonkey/foo/__wrapper.js:1:400\n    at sourcemonkey://SourceMonkey/foo/__wrapper.js:4:1',
  );
});

test('remapStackText: an entry URL two different scripts share is left unmapped', () => {
  // Two foo.user.js files in different folders: same URL, different
  // layouts. Either answer could be the wrong file.
  const otherFoo = {
    entryUrl: ENTRY,
    segments: [{ url: ENTRY, content: '', generatedLine: 1, lineCount: 9 }],
  };
  const stack = `    at ${ENTRY}:3:9`;
  assert.equal(remapStackText(stack, [LAYOUT, otherFoo]), stack);
  // One of them without requires makes it just as ambiguous.
  assert.equal(remapStackText(stack, [LAYOUT, { entryUrl: ENTRY, segments: [] }]), stack);
  // Two copies of the same script agree, so they still map.
  const copy = { entryUrl: ENTRY, segments: LAYOUT.segments.map((s) => ({ ...s })) };
  assert.equal(remapStackText(stack, [LAYOUT, copy]), `    at ${LIB}:2:9`);
});

test('remapStackText: a script without requires leaves the text alone', () => {
  const stack = `Error\n    at ${ENTRY}:3:9`;
  assert.equal(remapStackText(stack, [{ entryUrl: ENTRY, segments: [] }]), stack);
  assert.equal(remapStackText(stack, []), stack);
});

test('remapStackText: picks the layout whose entry the frame names', () => {
  const second = {
    entryUrl: 'sourcemonkey://SourceMonkey/bar/bar.user.js',
    segments: [{ url: 'sourcemonkey://SourceMonkey/bar/bar.user.js', content: '', generatedLine: 10, lineCount: 5 }],
  };
  assert.equal(
    remapStackText(`at ${second.entryUrl}:12:1 and ${ENTRY}:5:1`, [LAYOUT, second]),
    `at ${second.entryUrl}:2:1 and ${ENTRY}:1:1`,
  );
});
