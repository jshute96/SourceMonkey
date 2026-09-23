// The Node port of the sandbox's compile-only parse check
// (`src/harness/parse-check-node.ts`), which `scripts/validate-userscripts.mjs`
// uses in place of Chrome's sandboxed page.
//
// What's worth pinning here is the part that had to be rewritten: the
// verdict is `new Function` either way, but the location probes go
// through `vm.Script` and a stack-trace parse rather than a `<script>`
// element and a window `error` event. If that parse stops producing
// line/column pairs, `selectParseLocation` silently has nothing to
// choose between and every corpus error loses its position — a
// degradation with no other symptom.

import test from 'node:test';
import assert from 'node:assert/strict';

import { checkParseNode } from '../../lib/harness/parse-check-node.js';
import { selectParseLocation } from '../../dist/parse-location.js';

test('valid source compiles as a function body', () => {
  // A top-level `return` is legal in the entry we inject, so it must
  // not read as an error here either.
  assert.deepEqual(checkParseNode('var a = 1;\nreturn a;\n'), { status: 'ok' });
});

test('a syntax error reports the message V8 gave', () => {
  const verdict = checkParseNode('var a = ;\n');
  assert.equal(verdict.status, 'syntax-error');
  assert.equal(verdict.message, "Unexpected token ';'");
});

test('both probes report a line and a column', () => {
  const verdict = checkParseNode('var a = 1;\nlet ] = 2;\n');
  assert.equal(verdict.probes.wrapped.line, 2);
  assert.equal(verdict.probes.wrapped.column, 5);
  assert.equal(verdict.probes.raw.line, 2);
  assert.equal(verdict.probes.raw.column, 5);
});

test('a stray brace is placed by the raw probe', () => {
  // The brace closes the wrapped probe's own wrapper, so that probe
  // lands past the end of the source (line 5 of a 3-line file) and the
  // range check hands the answer to the raw probe.
  const source = 'var a = 1;\nfunction b() {}\n}\n';
  const verdict = checkParseNode(source);
  const hit = selectParseLocation({
    verdictMessage: verdict.message,
    probes: verdict.probes,
    lineCount: source.split('\n').length,
  });
  assert.equal(hit.line, 3);
});

test('a minified (over-long) line keeps its line number, column falls back', () => {
  // V8 clips the frame it renders in `err.stack` at ~1020 characters,
  // so on a longer line there is no caret to read a column off. Pinned
  // because the fallback has to stay a fallback: the LINE is what names
  // the file, and losing it on every minified script would gut the
  // tool's usefulness on real corpora.
  const source = `var a = 1;\n${'x'.repeat(5000)} let ] = 2;\n`;
  const verdict = checkParseNode(source);
  assert.equal(verdict.status, 'syntax-error');
  assert.equal(verdict.probes.raw.line, 2);
  assert.equal(verdict.probes.raw.column, 1);
  // Same input just under the clip still measures a real column, so the
  // fallback is genuinely about the clip and not about long lines.
  const shorter = checkParseNode(`var a = 1;\n${'x'.repeat(500)} let ] = 2;\n`);
  assert.equal(shorter.probes.raw.line, 2);
  assert.equal(shorter.probes.raw.column, 502);
});

test('a raw probe reporting a Script-only diagnostic is discarded', () => {
  // `return` at top level is fine in a function body, so the raw
  // probe's "Illegal return statement" describes a program we never
  // compile. The wrapped probe's position wins.
  const source = 'return 1;\nvar a = ;\n';
  const verdict = checkParseNode(source);
  assert.equal(verdict.probes.raw.message, 'Illegal return statement');
  const hit = selectParseLocation({
    verdictMessage: verdict.message,
    probes: verdict.probes,
    lineCount: source.split('\n').length,
  });
  assert.equal(hit.line, 2);
});
