import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MARKUP, asError, cmd, echoLine, err, id, markupLines, message, paintOutput, plainLine, quoted, ui, url, warn,
} from '../../../lib/harness/output-style.js';

const RED = '\x1b[1m\x1b[31m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const RESET = '\x1b[0m';

test('a line with no markup, and none of sm-dev\'s prefixes, passes through as it is', () => {
  for (const line of ['plain <b>text</b> & more', 'x `y` z', '\u0000sm-dev:json {"a":1}']) {
    assert.equal(paintOutput(line, true), line);
    assert.equal(plainLine(line), line);
  }
});

test('markup is plain text without color, and roles painted with it', () => {
  const line = ui`Tab ${id('T1')}: ${url('https://x.test/?a=1&b=<2>')}`;
  assert.equal(plainLine(line), 'Tab T1: https://x.test/?a=1&b=<2>');
  assert.equal(paintOutput(line, true), `Tab ${GREEN}T1${RESET}: \x1b[4mhttps://x.test/?a=1&b=<2>${RESET}`);
});

test('text put into markup is escaped, so tags in it are text', () => {
  const line = ui`Script ${'<id>evil</id> & co'} loaded`;
  assert.equal(plainLine(line), 'Script <id>evil</id> & co loaded');
  assert.doesNotMatch(paintOutput(line, true), /\x1b/);
});

test('plain text before the markup is kept, as text', () => {
  assert.equal(plainLine(`[sm-dev] a<b ${id(3)}`), '[sm-dev] a<b 3');
});

test('an error or warning covers the plain prefix before it', () => {
  assert.equal(paintOutput(`[sm-dev] ${err('It failed')}`, true), `${RED}[sm-dev] It failed${RESET}`);
  assert.equal(plainLine(`[sm-dev] ${warn('Careful')}`), '[sm-dev] Careful');
});

test('sm-dev\'s own lines are told by their prefix, with commands in backticks', () => {
  assert.equal(paintOutput('[sm-dev] ERROR: No tab T4. Use `tabs` to list them.', true),
    `${RED}[sm-dev] ERROR: No tab T4. Use ${CYAN}tabs${RESET}${RED} to list them.${RESET}`);
  // Plain, backticks stay where they help the command read apart.
  assert.equal(plainLine('ERROR: Use `tabs` or `T2` or `sm-dev list`'), 'ERROR: Use `tabs` or T2 or `sm-dev list`');
  assert.match(paintOutput('Warning: Watch out', true), /^\x1b\[1m\x1b\[35mWarning: Watch out/);
  // A note is not colored, but its commands are.
  assert.equal(paintOutput('[sm-dev] Ready. Use `help` to list them.', true), `[sm-dev] Ready. Use ${CYAN}help${RESET} to list them.`);
});

test('message() marks a sentence\'s backticked commands, and cmd() one command', () => {
  assert.equal(plainLine(message('Start one with `sm-dev start`.')), 'Start one with `sm-dev start`.');
  assert.equal(plainLine(`Use ${cmd('tabs')}`), 'Use `tabs`');
  assert.equal(plainLine(`Use ${cmd('--frames')}`), 'Use --frames');
});

test('an echoed command is the prompt mark, then the command', () => {
  assert.equal(plainLine(echoLine('stdin >', 'eval 1 < 2')), 'stdin > eval 1 < 2');
  assert.equal(paintOutput(echoLine('>', 'tabs'), true), `\x1b[1m${GREEN}>${RESET} ${CYAN}tabs${RESET}`);
});

test('unknown tags and stray characters in markup are text', () => {
  assert.equal(plainLine(`${MARKUP}a <b>c</b> & d`), 'a <b>c</b> & d');
});

test('text sm-dev didn\'t write keeps its backticks, colored or not', () => {
  const line = asError('Script said `42` and `--x`');
  assert.equal(plainLine(line), 'Script said `42` and `--x`');
  assert.equal(paintOutput(line, true), `${RED}Script said \`42\` and \`--x\`${RESET}`);
});

test('a page\'s own U+E000 (an icon font\'s glyph) is text, not markup', () => {
  const line = '\ue000<code>hi</code> &amp;';
  assert.equal(plainLine(line), line);
  assert.equal(paintOutput(line, true), line);
  assert.equal(plainLine(ui`x ${line}`), `x ${line}`);
});

test('message() reads backticks in the plain text before markup, and keeps the markup', () => {
  assert.equal(plainLine(message(`Use \`tabs\` on ${id('T1')}`)), 'Use `tabs` on T1');
});

test('quoted() puts text holding a backtick in double ones, and messages read it back whole', () => {
  assert.equal(quoted('tabs'), '`tabs`');
  assert.equal(quoted('#no`pe'), '`` #no`pe ``');
  // Plain, the selector keeps its own backtick; in color it is one command.
  assert.equal(plainLine(`ERROR: No element matches ${quoted('#no`pe')}`), 'ERROR: No element matches #no`pe');
  assert.match(paintOutput(`ERROR: Use ${quoted('a `b` c')} now`, true), new RegExp(`${CYAN.replace('[', '\\[')}a \`b\` c`));
});

test('markupLines: each line of multi-line markup stands alone', () => {
  // A stack trace in one error, read by a client line by line: the
  // lines after the first must not show tags or escapes as text.
  const line = ui`[script error] ${asError('TypeError: x\n    at Array.<anonymous> (a.user.js:1:2)\n    at b (a.user.js:3:4)')}`;
  const lines = markupLines(line);
  assert.equal(lines.length, 3);
  assert.deepEqual(lines.map((l) => paintOutput(l, false)), [
    '[script error] TypeError: x',
    '    at Array.<anonymous> (a.user.js:1:2)',
    '    at b (a.user.js:3:4)',
  ]);
  // Still an error on every line, in color.
  for (const l of lines) assert.match(paintOutput(l, true), /\x1b\[1m\x1b\[31m/);
  // A plain prefix stays at the start of the first line, where readers
  // look for it (`--json` sends `[sm-dev] ` lines to stderr).
  const prefixed = markupLines('[sm-dev] ' + err('Locator failed\nCall log:\n  - waiting'));
  assert.ok(prefixed[0].startsWith('[sm-dev] '));
  assert.deepEqual(prefixed.map((l) => paintOutput(l, false)), ['[sm-dev] Locator failed', 'Call log:', '  - waiting']);
  // Nested roles reopen on the next line.
  const across = markupLines(MARKUP + '<warn>a <id>T1\nT2</id> b</warn>');
  assert.deepEqual(across, [MARKUP + '<warn>a <id>T1</id></warn>', MARKUP + '<warn><id>T2</id> b</warn>']);
  // Plain text is split, each line read by its own prefix.
  assert.deepEqual(markupLines('plain\ntwo'), ['plain', 'two']);
  assert.deepEqual(markupLines('[sm-dev] note\nERROR: bad').map((l) => paintOutput(l, true).includes('\x1b[31m')), [false, true]);
  assert.deepEqual(markupLines(line.split('\n')[0]), [line.split('\n')[0]]);
});
