// Unit tests for the one parser of every sm-dev command's words
// (src/harness/command-args.ts, compiled to lib/harness/command-args.js):
// splitting and quotes, flags, a leading tab, text, forms and blocks, as
// each command's syntax (command-list.ts) declares them.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseCommandArgs, splitWords, unquoteWhole } from '../../lib/harness/command-args.js';

const words = (line) => splitWords(line).map((w) => w.text);
const typed = (command, line) => parseCommandArgs(command, { line });
const sent = (command, ...words) => parseCommandArgs(command, { words });

test('quotes group words, as in a shell', () => {
  assert.deepEqual(words(`type 'input[name=q]' "hello world"`), ['type', 'input[name=q]', 'hello world']);
  assert.deepEqual(words(`'e' "f"`), ['e', 'f']);
  assert.deepEqual(words(`"say \\"hi\\""`), ['say "hi"']);
  assert.deepEqual(words(`  spaced   out  `), ['spaced', 'out']);
  // An unclosed quote runs to the end.
  assert.deepEqual(words(`'unclosed text`), ['unclosed text']);
  assert.deepEqual(splitWords(`'--x' y`).map((w) => w.quoted), [true, false]);
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

test('text quoted as a whole is unquoted, single quotes only for JSON', () => {
  assert.deepEqual(unquoteWhole(`'Toggle dark'`), { text: 'Toggle dark', quoted: true });
  assert.deepEqual(unquoteWhole(`"say \\"hi\\""`), { text: 'say "hi"', quoted: true });
  assert.deepEqual(unquoteWhole(`'a' 'b'`), { text: `'a' 'b'`, quoted: false });
  assert.deepEqual(unquoteWhole(`"metric"`, 'single'), { text: '"metric"', quoted: false });
});

test('flags take a value after them or after =, and are checked', () => {
  assert.deepEqual(typed('snapshot', '--out tree.txt --visible main').flags, { '--out': 'tree.txt', '--visible': true });
  assert.deepEqual(typed('snapshot', '--out=tree.txt').flags, { '--out': 'tree.txt' });
  assert.deepEqual(typed('snapshot', '--visible=yes'), { error: 'The --visible flag takes no value', flag: '--visible' });
  assert.deepEqual(typed('snapshot', '--out'), { error: 'The --out flag needs a value: --out FILE', flag: '--out' });
  assert.deepEqual(typed('snapshot', '--out='), { error: 'The --out flag needs a value: --out FILE', flag: '--out' });
  assert.deepEqual(typed('snapshot', '--out --visible'), { error: 'The --out flag needs a value: --out FILE', flag: '--out' });
  assert.deepEqual(typed('snapshot', '--visible --visible'), { error: 'The --visible flag can be given once', flag: '--visible' });
  assert.deepEqual(typed('snapshot', '--deep'), { error: 'The snapshot command has no --deep flag. It takes --visible, --out.', flag: '--deep' });
  // A quoted word is never a flag.
  assert.deepEqual(typed('probe', `'--x' .y`).words, ['--x', '.y']);
  // Also on a command that takes nothing else.
  assert.deepEqual(typed('status', '--bad'), { error: 'The status command has no --bad flag. It takes no flags.', flag: '--bad' });
});

test('arguments a command doesn\'t take are refused, with its usage', () => {
  assert.deepEqual(typed('status', 'extra'), { error: 'The status command takes no arguments' });
  assert.deepEqual(typed('focus', 'T1 T2 T3'), { error: 'The focus command takes at most one argument besides a tab (focus [T<n>])' });
  assert.deepEqual(typed('attach', 'D1 D2'), { error: 'The attach command takes at most one argument (attach [ID])' });
  assert.deepEqual(typed('logs', 'T2 x'), { error: 'The logs command takes nothing besides a tab' });
  assert.deepEqual(typed('status', '\nline'), { error: 'The status command takes no {{ block' });
});

test('--help asks for the command\'s help, where a flag can go', () => {
  assert.equal(typed('closetab', '--help').help, true);
  assert.equal(typed('click', '.x --help').help, true);
  assert.deepEqual(sent('stop', '--help').help, true);
  // In text, it's text.
  assert.equal(typed('eval', 'x --help').text, 'x --help');
  assert.equal(typed('eval', 'x --help').help, undefined);
});

test('a tab can lead a page command\'s arguments, among its flags', () => {
  assert.deepEqual(typed('eval', 'T2 --script document.title'), { flags: { '--script': true }, tab: 'T2', words: [], text: 'document.title' });
  assert.deepEqual(typed('eval', '--script T2 x').tab, 'T2');
  assert.deepEqual(typed('probe', '[targetId=ABC123 pageId=4] .x'), { flags: {}, tab: '[targetId=ABC123 pageId=4]', words: ['.x'] });
  assert.equal(typed('focus', '[targetId=ABC123 pageId=4]').tab, '[targetId=ABC123 pageId=4]');
  // Only first: a later T2 is an argument.
  assert.deepEqual(typed('key', 'j T2').words, ['j', 'T2']);
});

test('text is the rest of the line, its --words its own', () => {
  assert.equal(typed('eval', '"abc".length').text, '"abc".length');
  assert.equal(typed('eval', 'x --script').text, 'x --script');
  assert.deepEqual(typed('set', `k '["a"]'`), { flags: {}, words: ['k'], text: '["a"]' });
  assert.equal(typed('set', 'k "metric"').text, '"metric"');
  assert.deepEqual(typed('set', 'k --file v.json'), { flags: { '--file': 'v.json' }, words: ['k'], text: '' });
  assert.equal(typed('set', 'k --flie v.json').error, 'The set command has no --flie flag. It takes --file.');
  // A menu label is unquoted by menu itself, after any T2. before it.
  assert.equal(typed('menu', `T2.'Toggle dark'`).text, `T2.'Toggle dark'`);
  assert.equal(typed('type', `'#x' 'Test User'`).text, 'Test User');
  assert.deepEqual(typed('eval', '--script\nconst a = 1;\na').block, 'const a = 1;\na');
});

test('a selector is the rest of the line less its flags, which go anywhere', () => {
  assert.deepEqual(typed('click', '--button right div > a'), { flags: { '--button': 'right' }, words: [], text: 'div > a' });
  assert.equal(typed('click', `div > a --count 2`).text, 'div > a');
  assert.equal(typed('snapshot', `'#a b' --visible`).text, '#a b');
  assert.equal(sent('click', 'e4', '--modifiers=Alt').text, 'e4');
});

test('wait: a tab, then the form, and flags ending wait log\'s text', () => {
  assert.deepEqual(typed('wait', 'T1 selector #go'), { flags: {}, tab: 'T1', form: 'selector', words: [], text: '#go' });
  assert.deepEqual(typed('wait', 'log ready --timeout-seconds 9'), { flags: { '--timeout-seconds': '9' }, form: 'log', words: [], text: 'ready' });
  assert.deepEqual(typed('wait', 'log ready --timeout-seconds=9').flags, { '--timeout-seconds': '9' });
  // A near miss of it is refused; other --words are text.
  assert.equal(typed('wait', 'log ready --timeout 40').error, 'The wait command has no --timeout flag. It takes --timeout-seconds.');
  assert.equal(typed('wait', 'log Running --dry-run mode').text, 'Running --dry-run mode');
  // Quoted, or a regex, it's all text.
  assert.equal(typed('wait', `log 'x --timeout 40'`).text, 'x --timeout 40');
  assert.equal(typed('wait', 'log /a --timeout b/').text, '/a --timeout b/');
  // From a shell, only a word of its own is a flag.
  assert.equal(sent('wait', 'log', 'Running --timeout mode').text, 'Running --timeout mode');
  assert.equal(sent('wait', 'log', 'x', '--timeout', '40').error, 'The wait command has no --timeout flag. It takes --timeout-seconds.');
  assert.deepEqual(sent('wait', '2s').words, ['2s']);
  // A near miss is one that starts like a flag, or a flag's start.
  assert.equal(typed('wait', 'log x --timeouts 4').error, 'The wait command has no --timeouts flag. It takes --timeout-seconds.');
  assert.equal(typed('wait', 'log x --help-me').text, 'x --help-me');
  // Only flags that end the text are taken.
  assert.deepEqual(typed('wait', 'log --timeout-seconds 4 x').flags, { '--timeout-seconds': '4' });
  assert.equal(typed('wait', 'log a --other=b').text, 'a --other=b');
});

test('sm-dev\'s own commands read the same way', () => {
  assert.deepEqual(sent('start', 'a.user.js', '--watch', '--cdp=9300', 'https://x.com/'), {
    flags: { '--watch': true, '--cdp': '9300' }, words: ['a.user.js', 'https://x.com/'],
  });
  assert.equal(sent('stop', '--watch').error, 'The stop command has no --watch flag. It takes --all.');
  assert.equal(sent('list', 'x').error, 'The list command takes no arguments');
});
