// Pure helper from the viewer's tabbed code view. The view itself is
// DOM-bound (e2e territory); this is the one piece of arithmetic in it
// that's worth pinning down directly.
//
// V8 reports a stack frame's column counting each tab character as one
// column. The code pane renders tabs at `tab-size` width, so the
// column-accent bar has to be placed at the *visual* column or it
// lands nowhere near the character the trace named.

import test from 'node:test';
import assert from 'node:assert/strict';

// `code-tabs.js` pulls in `prism-userscript.js` for its side effect
// (registering the metadata-block grammar), which reaches for the
// `Prism` global the extension pages load via a <script> tag. Stub the
// one method it calls so the module can be imported under Node.
globalThis.Prism = { languages: { insertBefore() {} } };

const { expandToVisualColumn } = await import('../../dist/code-tabs.js');

test('expandToVisualColumn: no tabs means col-1 (0-based)', () => {
  assert.equal(expandToVisualColumn('const x = 1;', 1, 4), 0);
  assert.equal(expandToVisualColumn('const x = 1;', 7, 4), 6);
});

test('expandToVisualColumn: a leading tab advances to the next tab stop', () => {
  // `\tfoo` — column 2 is `f`, rendered at visual column 4.
  assert.equal(expandToVisualColumn('\tfoo', 2, 4), 4);
  assert.equal(expandToVisualColumn('\t\tfoo', 3, 4), 8);
});

test('expandToVisualColumn: a tab mid-line fills to the boundary, not a fixed width', () => {
  // `ab\tc`: `ab` occupies 0-1, the tab fills 2-3, so `c` is at 4.
  assert.equal(expandToVisualColumn('ab\tc', 4, 4), 4);
  // Same line at tab-size 8: the tab fills 2-7 and `c` lands at 8.
  assert.equal(expandToVisualColumn('ab\tc', 4, 8), 8);
});

test('expandToVisualColumn: columns outside the line are clamped', () => {
  // Past the end (a trace pointing at a line the file no longer has
  // the same shape for) walks the whole line rather than overrunning.
  assert.equal(expandToVisualColumn('\tx', 99, 4), 5);
  // Column 0 / negative can't happen from V8 but must not go negative.
  assert.equal(expandToVisualColumn('abc', 0, 4), 0);
});
