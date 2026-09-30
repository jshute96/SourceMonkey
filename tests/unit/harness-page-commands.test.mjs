// Unit tests for how the page commands split a typed line into words,
// name the keys `key` presses, read `click`'s flags and `cdp`'s calls,
// and word Playwright's errors (src/harness/page-commands.ts,
// compiled to lib/harness/page-commands.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { cdpCalls, cdpCallsTyped, clickOptions, keyName, plain, splitWords } from '../../lib/harness/page-commands.js';

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

test('click takes its flags anywhere around the selector', () => {
  const typed = (raw) => clickOptions({ raw, typed: true, words: [] });
  assert.deepEqual(typed(`--button right div > a`), { selector: 'div > a', click: { button: 'right' }, how: ['the right button'] });
  assert.deepEqual(typed(`'#a b' --count 2 --modifiers ctrl+shift`), {
    selector: '#a b', click: { clickCount: 2, modifiers: ['Control', 'Shift'] }, how: ['Control+Shift held', '2 clicks'],
  });
  // A word that's an object's own property is no flag.
  assert.deepEqual(typed(`toString`), { selector: 'toString', click: {}, how: [] });
  // Plain values say nothing extra.
  assert.deepEqual(typed(`e4 --button left --count 1`), { selector: 'e4', click: { button: 'left', clickCount: 1 }, how: [] });
  // Sent as words from another shell.
  assert.deepEqual(clickOptions({ raw: '', typed: false, words: ['e4', '--modifiers', 'Alt'] }), {
    selector: 'e4', click: { modifiers: ['Alt'] }, how: ['Alt held'],
  });
});

test('click says what is wrong with its flags', () => {
  const typed = (raw) => clickOptions({ raw, typed: true, words: [] });
  assert.equal(typed('e4 --button'), 'The --button flag needs a value');
  assert.equal(typed('e4 --button back'), 'back is not a mouse button. Use left, right or middle.');
  assert.equal(typed('e4 --modifiers Shift+Q'), 'Q is not a modifier key. Use Alt, Control, ControlOrMeta, Meta, Shift, joined by +.');
  assert.equal(typed('e4 --count 0'), 'The --count flag takes a number of clicks from 1 to 10, not 0');
});

test('a timed-out action says which check its element kept failing', () => {
  // As Playwright words it: the call log's lines dimmed, the last check last.
  const log = (...checks) => new Error(['locator.click: Timeout 5000ms exceeded.', 'Call log:',
    '\x1b[2m  - waiting for locator(\'#x\')\x1b[22m',
    ...checks.map((c) => `\x1b[2m      - ${c}\x1b[22m`)].join('\n'));
  assert.equal(plain(log('element is not visible')), 'The element stayed hidden (or zero-size) for 5 seconds');
  assert.equal(plain(log('element is not visible', 'element is not stable')), 'The element kept moving for 5 seconds');
  assert.equal(plain(log('element is not enabled')), 'The element stayed disabled for 5 seconds');
  assert.equal(plain(log('element is visible, enabled and stable', '<div id="over"></div> intercepts pointer events')),
    'The element stayed covered for 5 seconds, by <div id="over"></div>');
  assert.equal(plain(log()), 'The element wasn\'t ready (visible, stable, and not covered) within 5 seconds');
});
