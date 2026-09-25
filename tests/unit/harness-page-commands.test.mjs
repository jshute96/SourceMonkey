// Unit tests for how the page commands split a typed line into words
// (src/harness/page-commands.ts, compiled to lib/harness/page-commands.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { splitWords } from '../../lib/harness/page-commands.js';

const words = (line) => splitWords(line).map((w) => w.text);

test('quotes group words, as in a shell', () => {
  assert.deepEqual(words(`type 'input[name=q]' "hello world"`), ['type', 'input[name=q]', 'hello world']);
  assert.deepEqual(words(`a"b c"d 'e'`), ['ab cd', 'e']);
  assert.deepEqual(words(`"say \\"hi\\""`), ['say "hi"']);
  assert.deepEqual(words(`  spaced   out  `), ['spaced', 'out']);
  // An unclosed quote runs to the end.
  assert.deepEqual(words(`'unclosed text`), ['unclosed text']);
});
