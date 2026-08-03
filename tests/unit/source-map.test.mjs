// Tests for src/source-map.ts (compiled to dist/source-map.js).
//
// The generator is deliberately narrow — line-level mappings at column
// 0, one segment per generated line — so the tests focus on the two
// things that can actually go wrong: the VLQ delta encoding, and the
// generated→original line correspondence. The injector-side tests in
// injector.test.mjs cover the map as it appears on a real entry.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSourceMap,
  encodeVlq,
  inlineSourceMapComment,
} from '../../dist/source-map.js';

// ---------- encodeVlq ----------

test('encodeVlq: known values from the Source Map v3 spec', () => {
  assert.equal(encodeVlq(0), 'A');
  assert.equal(encodeVlq(1), 'C');
  assert.equal(encodeVlq(-1), 'D');
  assert.equal(encodeVlq(2), 'E');
  assert.equal(encodeVlq(-2), 'F');
  assert.equal(encodeVlq(16), 'gB');
  assert.equal(encodeVlq(-16), 'hB');
});

test('encodeVlq: values needing multiple 5-bit groups round-trip', () => {
  // Continuation bit handling is the only subtle part. Decode with an
  // independent implementation rather than trusting the encoder twice.
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const decode = (s) => {
    let shift = 0;
    let value = 0;
    for (const ch of s) {
      const digit = B64.indexOf(ch);
      value += (digit & 31) << shift;
      if (!(digit & 32)) break;
      shift += 5;
    }
    return (value & 1) ? -(value >> 1) : (value >> 1);
  };
  for (const n of [0, 1, -1, 15, 16, 31, 32, 511, 512, -512, 100000, -100000]) {
    assert.equal(decode(encodeVlq(n)), n, `round-trip ${n}`);
  }
});

// ---------- buildSourceMap ----------

// Decode `mappings` into one {source, line} (1-based) per generated
// line, or null where the generated line is unmapped.
function resolve(map) {
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const decodeGroup = (group) => {
    const out = [];
    let shift = 0;
    let value = 0;
    for (const ch of group) {
      const digit = B64.indexOf(ch);
      value += (digit & 31) << shift;
      if (digit & 32) { shift += 5; continue; }
      out.push((value & 1) ? -(value >> 1) : (value >> 1));
      shift = 0;
      value = 0;
    }
    return out;
  };
  let srcIdx = 0;
  let origLine = 0;
  return map.mappings.split(';').map((group) => {
    if (!group) return null;
    const [genCol, dSrc, dLine, origCol] = decodeGroup(group);
    srcIdx += dSrc;
    origLine += dLine;
    return { source: map.sources[srcIdx], line: origLine + 1, genCol, origCol };
  });
}

const SEGMENTS = [
  { url: 'sourcemonkey://x/lib.js', content: 'L1\nL2\nL3', generatedLine: 1, lineCount: 3 },
  { url: 'sourcemonkey://x/main.js', content: 'M1\nM2', generatedLine: 5, lineCount: 2 },
];

test('buildSourceMap: shape and metadata', () => {
  const map = buildSourceMap({ file: 'gen.js', segments: SEGMENTS, totalLines: 8 });
  assert.equal(map.version, 3);
  assert.equal(map.file, 'gen.js');
  assert.deepEqual(map.sources, ['sourcemonkey://x/lib.js', 'sourcemonkey://x/main.js']);
  assert.deepEqual(map.sourcesContent, ['L1\nL2\nL3', 'M1\nM2']);
  assert.deepEqual(map.names, []);
});

test('buildSourceMap: every generated line resolves to its original file and line', () => {
  const map = buildSourceMap({ file: 'gen.js', segments: SEGMENTS, totalLines: 8 });
  const got = resolve(map);
  assert.equal(got.length, 8);
  // Line 0 is the wrap head — deliberately unmapped.
  assert.equal(got[0], null);
  assert.deepEqual(got[1], { source: 'sourcemonkey://x/lib.js', line: 1, genCol: 0, origCol: 0 });
  assert.deepEqual(got[2], { source: 'sourcemonkey://x/lib.js', line: 2, genCol: 0, origCol: 0 });
  assert.deepEqual(got[3], { source: 'sourcemonkey://x/lib.js', line: 3, genCol: 0, origCol: 0 });
  // Line 4 is the `;` separator — unmapped.
  assert.equal(got[4], null);
  assert.deepEqual(got[5], { source: 'sourcemonkey://x/main.js', line: 1, genCol: 0, origCol: 0 });
  assert.deepEqual(got[6], { source: 'sourcemonkey://x/main.js', line: 2, genCol: 0, origCol: 0 });
  // Line 7 is the wrap tail — unmapped.
  assert.equal(got[7], null);
});

test('buildSourceMap: source index ascends one per segment', () => {
  // `sources` is built 1:1 from `segments`, and segments are always
  // emitted in ascending generated-line order, so the source-index
  // delta is always +1. (A negative delta is therefore unreachable by
  // construction — worth stating, since the VLQ encoder supports it
  // and a future dedupe of repeated require URLs would need it.)
  const map = buildSourceMap({
    file: 'gen.js',
    segments: [
      { url: 'a.js', content: 'A', generatedLine: 0, lineCount: 1 },
      { url: 'b.js', content: 'B', generatedLine: 1, lineCount: 1 },
      { url: 'c.js', content: 'C', generatedLine: 2, lineCount: 1 },
    ],
    totalLines: 3,
  });
  assert.deepEqual(resolve(map).map((g) => g.source), ['a.js', 'b.js', 'c.js']);
  // Every group encodes a +1 source delta and a 0 original-line delta.
  assert.deepEqual(map.mappings.split(';'), ['AAAA', 'ACAA', 'ACAA']);
});

test('buildSourceMap: no segments → all lines unmapped', () => {
  const map = buildSourceMap({ file: 'gen.js', segments: [], totalLines: 3 });
  assert.equal(map.mappings, ';;');
  assert.deepEqual(resolve(map), [null, null, null]);
});

test('buildSourceMap: sourcesContent is always embedded, at any size', () => {
  // No size cap on purpose. `sourcemonkey://` URLs aren't fetchable,
  // so dropping the text is the same as having no map worth opening —
  // and the only constraint that actually binds (does
  // chrome.userScripts.register accept the payload?) already fails
  // loudly and by name via registerWithFallback.
  const big = 'x'.repeat(2 * 1024 * 1024);
  const map = buildSourceMap({
    file: 'gen.js',
    segments: [{ url: 'big.js', content: big, generatedLine: 0, lineCount: 1 }],
    totalLines: 1,
  });
  assert.deepEqual(map.sourcesContent, [big]);
});

// ---------- inlineSourceMapComment ----------

test('inlineSourceMapComment: emits a decodable base64 data URI', () => {
  const map = buildSourceMap({ file: 'gen.js', segments: SEGMENTS, totalLines: 8 });
  const comment = inlineSourceMapComment(map);
  const m = comment.match(/^\/\/# sourceMappingURL=data:application\/json;charset=utf-8;base64,(.+)$/);
  assert.ok(m, 'comment is not a base64 json data URI');
  assert.deepEqual(JSON.parse(Buffer.from(m[1], 'base64').toString('utf8')), map);
});

test('inlineSourceMapComment: survives source text above U+00FF', () => {
  // `btoa` alone throws on any code point past Latin-1, and userscripts
  // are full of them — the script that prompted Mode A is half Chinese.
  const map = buildSourceMap({
    file: 'gen.js',
    segments: [{ url: 'zh.js', content: '// 增强\nconst 名前 = "🎉";', generatedLine: 0, lineCount: 2 }],
    totalLines: 2,
  });
  const comment = inlineSourceMapComment(map);
  const b64 = comment.slice(comment.indexOf('base64,') + 7);
  const decoded = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  assert.deepEqual(decoded.sourcesContent, ['// 增强\nconst 名前 = "🎉";']);
});

test('inlineSourceMapComment: emits no newline of its own', () => {
  // The injector appends it after the sourceURL line and adds the
  // trailing newline itself; an extra one here would shift nothing but
  // would make the entry's line count disagree with `totalLines`.
  const map = buildSourceMap({ file: 'gen.js', segments: [], totalLines: 1 });
  assert.doesNotMatch(inlineSourceMapComment(map), /\n/);
});
