// Unit tests for how the page commands split a typed line into words,
// and name the keys `key` presses (src/harness/page-commands.ts,
// compiled to lib/harness/page-commands.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { keyName, splitWords } from '../../lib/harness/page-commands.js';

const words = (line) => splitWords(line).map((w) => w.text);

test('quotes group words, as in a shell', () => {
  assert.deepEqual(words(`type 'input[name=q]' "hello world"`), ['type', 'input[name=q]', 'hello world']);
  assert.deepEqual(words(`a"b c"d 'e'`), ['ab cd', 'e']);
  assert.deepEqual(words(`"say \\"hi\\""`), ['say "hi"']);
  assert.deepEqual(words(`  spaced   out  `), ['spaced', 'out']);
  // An unclosed quote runs to the end.
  assert.deepEqual(words(`'unclosed text`), ['unclosed text']);
});

test('key names are case-insensitive, with common aliases', () => {
  assert.equal(keyName('home'), 'Home');
  assert.equal(keyName('ctrl+shift+end'), 'Control+Shift+End');
  assert.equal(keyName('Esc'), 'Escape');
  assert.equal(keyName('pgdn'), 'PageDown');
  assert.equal(keyName('cmd+keya'), 'Meta+KeyA');
  assert.equal(keyName('f12'), 'F12');
});

test('a single character keeps its case, and + can be a key', () => {
  assert.equal(keyName('a'), 'a');
  assert.equal(keyName('Shift+A'), 'Shift+A');
  assert.equal(keyName('+'), '+');
  assert.equal(keyName('ctrl++'), 'Control++');
  assert.equal(keyName('ctrl+plus'), 'Control++');
  // Playwright reads `+++` as a + key between two others.
  assert.equal(keyName('ctrl+plus+a'), 'Control+++a');
});

test('Minus stays the Minus key, which Shift makes _', () => {
  assert.equal(keyName('minus'), 'Minus');
  assert.equal(keyName('shift+minus'), 'Shift+Minus');
});

test('an unknown name is passed on as typed', () => {
  assert.equal(keyName('ctrl+Foo'), 'Control+Foo');
});
