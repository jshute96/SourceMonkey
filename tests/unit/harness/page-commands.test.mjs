// Unit tests for how the page commands name the keys `key` presses, read `click`'s flags and `cdp`'s calls,
// word Playwright's errors, and collapse repeated `logs` lines (src/harness/page-commands.ts,
// compiled to lib/harness/page-commands.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseCommandArgs } from '../../../lib/harness/command-args.js';
import { cdpCallsTyped, clickOptions, keyName, plain } from '../../../lib/harness/page-commands.js';

// click's or hover's options, from a line as the command's syntax reads it.
const clickLine = (line, command = 'click') => {
  const parsed = parseCommandArgs(command, { line });
  return 'error' in parsed ? parsed.error : clickOptions(parsed.flags, parsed.text);
};

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
  assert.deepEqual(cdpCallsTyped(['Page.reload'].join(' ')), [{ method: 'Page.reload', params: {} }]);
  assert.deepEqual(cdpCallsTyped(['Input.dispatchMouseEvent', '{"type": "mousePressed"}'].join(' ')), [{ method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed' } }]);
  // Params split at their spaces still read as one.
  assert.deepEqual(cdpCallsTyped(['Runtime.evaluate', '{"expression":', '"1', '+', '1"}'].join(' ')), [{ method: 'Runtime.evaluate', params: { expression: '1 + 1' } }]);
});

test('cdp says what is wrong with its call', () => {
  assert.match(cdpCallsTyped([].join(' ')), /^The cdp command needs a method/);
  assert.equal(cdpCallsTyped(['{"x": 1}'].join(' ')), '{"x": is not a CDP method. Methods are named Domain.method, as in Page.reload.');
  assert.match(cdpCallsTyped(['Page.reload', '{nope}'].join(' ')), /^The params for Page.reload are not valid JSON/);
  assert.match(cdpCallsTyped('Page.reload [1]'), /^The params for Page.reload must be a JSON object/);
  assert.match(cdpCallsTyped(['Page.enable', 'Page.reload'].join(' ')), /^A cdp command makes one call/);
  // Trailing words after the params.
  assert.equal(cdpCallsTyped(['Page.reload', '{}', 'x'].join(' ')), 'The params for Page.reload have more after them: x');
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
  const typed = (line) => clickLine(line);
  assert.deepEqual(typed(`--button right div > a`), { selector: 'div > a', click: { button: 'right' }, how: ['the right button'] });
  assert.deepEqual(typed(`'#a b' --count 2 --modifiers ctrl+shift`), {
    selector: '#a b', click: { clickCount: 2, modifiers: ['Control', 'Shift'] }, how: ['Control+Shift held', '2 clicks'],
  });
  // A word that's an object's own property is no flag.
  assert.deepEqual(typed(`toString`), { selector: 'toString', click: {}, how: [] });
  // Plain values say nothing extra.
  assert.deepEqual(typed(`e4 --button left --count 1`), { selector: 'e4', click: { button: 'left', clickCount: 1 }, how: [] });
  // Sent as words from another shell, and a flag's value after =.
  const sent = parseCommandArgs('click', { words: ['e4', '--modifiers=Alt'] });
  assert.deepEqual(clickOptions(sent.flags, sent.text), {
    selector: 'e4', click: { modifiers: ['Alt'] }, how: ['Alt held'],
  });
});

test('click says what is wrong with its flags', () => {
  const typed = (line) => clickLine(line);
  assert.equal(typed('e4 --button'), 'The --button flag needs a value: --button <name>');
  assert.equal(typed('e4 --button back'), 'back is not a mouse button. Use left, right or middle.');
  assert.equal(typed('e4 --modifiers Shift+Q'), 'Q is not a modifier key. Use Alt, Control, ControlOrMeta, Meta, Shift, joined by +.');
  assert.equal(typed('e4 --count 0'), 'The --count flag takes a number of clicks from 1 to 10, not 0');
  assert.equal(typed('e4 --at 5'), 'The --at flag takes x,y in pixels from the element\'s top left corner, e.g. --at 10,5, not 5');
});

test('click and hover take --at, and hover --modifiers but no click-only flags', () => {
  assert.deepEqual(clickLine('.row --at 300,12'), {
    selector: '.row', click: { position: { x: 300, y: 12 } }, how: ['the mouse at 300,12 in it'],
  });
  const hover = (line) => clickLine(line, 'hover');
  assert.deepEqual(hover('img --modifiers Alt --at 4,4'), {
    selector: 'img', click: { modifiers: ['Alt'], position: { x: 4, y: 4 } }, how: ['Alt held', 'the mouse at 4,4 in it'],
  });
  assert.equal(hover('img --count 2'),
    'The hover command has no --count flag. It takes --modifiers, --at, --nowait.');
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

