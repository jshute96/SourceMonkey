// Unit tests for how the page commands split a typed line into words,
// name the keys `key` presses, and read `cdp`'s calls (src/harness/page-commands.ts,
// compiled to lib/harness/page-commands.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { cdpCalls, cdpCallsTyped, keyName, splitWords } from '../../lib/harness/page-commands.js';

const words = (line) => splitWords(line).map((w) => w.text);

test('quotes group words, as in a shell', () => {
  assert.deepEqual(words(`type 'input[name=q]' "hello world"`), ['type', 'input[name=q]', 'hello world']);
  assert.deepEqual(words(`'e' "f"`), ['e', 'f']);
  assert.deepEqual(words(`"say \\"hi\\""`), ['say "hi"']);
  assert.deepEqual(words(`  spaced   out  `), ['spaced', 'out']);
  // An unclosed quote runs to the end.
  assert.deepEqual(words(`'unclosed text`), ['unclosed text']);
});

test('quotes inside a word are the word\'s own, as in a selector', () => {
  assert.deepEqual(words(`probe css=a[href="security.html"]`), ['probe', 'css=a[href="security.html"]']);
  // They still keep its spaces together.
  assert.deepEqual(words(`a[title="a b"] x`), ['a[title="a b"]', 'x']);
  assert.deepEqual(words(`a"b c"d`), ['a"b c"d']);
  assert.deepEqual(words(`p[data-x='1 2']`), [`p[data-x='1 2']`]);
  // A word quoted whole is unquoted, with inner quotes as they are.
  assert.deepEqual(words(`'a[href="x y"]'`), ['a[href="x y"]']);
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

test('cdp reads one method with its JSON params', () => {
  assert.deepEqual(cdpCalls(['Page.reload']), [{ method: 'Page.reload', params: {} }]);
  assert.deepEqual(cdpCalls(['Input.dispatchMouseEvent', '{"type": "mousePressed"}']), [{ method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed' } }]);
  // Params split at their spaces still read as one.
  assert.deepEqual(cdpCalls(['Runtime.evaluate', '{"expression":', '"1', '+', '1"}']), [{ method: 'Runtime.evaluate', params: { expression: '1 + 1' } }]);
});

test('cdp says what is wrong with its call', () => {
  assert.match(cdpCalls([]), /^The cdp command needs a method/);
  assert.equal(cdpCalls(['{"x": 1}']), '{"x": is not a CDP method. Methods are named Domain.method, as in Page.reload.');
  assert.match(cdpCalls(['Page.reload', '{nope}']), /^The params for Page.reload are not valid JSON/);
  assert.match(cdpCalls(['Page.reload', '[1]']), /^The params for Page.reload must be a JSON object/);
  assert.match(cdpCalls(['Page.enable', 'Page.reload']), /^A cdp command makes one call/);
  // The same message for trailing words, sent or typed.
  assert.equal(cdpCalls(['Page.reload', '{}', 'x']), 'The params for Page.reload have more after them: x');
});

test('typed cdp keeps the quotes in its JSON, and takes one call per line', () => {
  assert.deepEqual(cdpCallsTyped(' Runtime.evaluate {"expression": "1 + 1"}'), [{ method: 'Runtime.evaluate', params: { expression: '1 + 1' } }]);
  assert.deepEqual(
    cdpCallsTyped(`\n# press\nInput.dispatchMouseEvent '{"type": "mousePressed"}'\n\n  Input.dispatchMouseEvent {"type": "mouseReleased", "text": "a } b"}\nPage.reload\n`),
    [
      { method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed' } },
      { method: 'Input.dispatchMouseEvent', params: { type: 'mouseReleased', text: 'a } b' } },
      { method: 'Page.reload', params: {} },
    ],
  );
  // Single quotes around params with a ' in their strings.
  assert.deepEqual(
    cdpCallsTyped(`Runtime.evaluate '{"expression": "matchMedia('(x)').matches"}'`),
    [{ method: 'Runtime.evaluate', params: { expression: "matchMedia('(x)').matches" } }],
  );
  assert.match(cdpCallsTyped(''), /^The cdp command needs a method/);
  assert.equal(cdpCallsTyped('Page.reload {"x": '), 'The params for Page.reload have no closing }. A call and its params go on one line.');
  assert.match(cdpCallsTyped(`Page.reload '{"x": 1}`), /open with a ' that doesn't close/);
  assert.match(cdpCallsTyped('Page.enable Page.reload'), /^A cdp command makes one call/);
  assert.match(cdpCallsTyped('Page.reload {} Page.enable'), /^A cdp command makes one call/);
  assert.match(cdpCallsTyped('Page.reload {} x'), /^The params for Page.reload have more after them: x/);
  // A block or file names the line.
  assert.equal(
    cdpCallsTyped('\nPage.enable\nnope', { first: 0, name: (n) => `Line ${n} of the block` }),
    'Line 2 of the block: nope is not a CDP method. Methods are named Domain.method, as in Page.reload.',
  );
});
