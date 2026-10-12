// Unit tests for the one parser of every sm-dev command's words
// (src/harness/command-args.ts, compiled to lib/harness/command-args.js):
// splitting and quotes, flags, a leading tab, text, forms and blocks, as
// each command's syntax (command-list.ts) declares them.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseCommandArgs, splitWords, unquoteWhole } from '../../../lib/harness/command-args.js';

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
  assert.deepEqual(typed('snapshot', '--out'), { error: 'The `--out` flag needs a value: `--out FILE`', flag: '--out' });
  assert.deepEqual(typed('snapshot', '--out='), { error: 'The `--out` flag needs a value: `--out FILE`', flag: '--out' });
  assert.deepEqual(typed('snapshot', '--out --visible'), { error: 'The `--out` flag needs a value: `--out FILE`', flag: '--out' });
  assert.deepEqual(typed('snapshot', '--visible --visible'), { error: 'The --visible flag can be given once', flag: '--visible' });
  // A value only after =.
  assert.deepEqual(typed('status', '--json=multi').flags, { '--json': 'multi' });
  assert.deepEqual(typed('values', '2 --json').flags, { '--json': true });
  assert.deepEqual(typed('snapshot', '--deep'), { error: 'The `snapshot` command has no `--deep` flag. It takes `--visible`, `--out`, `--find`, `--up`, `--context`, `--limit`, `--timeout-seconds`, `--frame`.', flag: '--deep' });
  // A quoted word is never a flag.
  assert.deepEqual(typed('probe', `'--x' .y`).words, ['--x', '.y']);
  // Also on a command that takes few.
  assert.deepEqual(typed('status', '--bad'), { error: 'The `status` command has no `--bad` flag. It takes `--frames`, `--json`, `--nojson`.', flag: '--bad' });
});

test('a flag with an optional value takes it only after =', () => {
  assert.deepEqual(typed('eval', '--script=Foo x'), { flags: { '--script': 'Foo' }, words: [], text: 'x' });
  // Bare, it never takes the next word: that's the tab, or the code.
  assert.deepEqual(typed('eval', '--script T2 x'), { flags: { '--script': true }, tab: 'T2', words: [], text: 'x' });
  assert.deepEqual(typed('eval', '--script GM_info'), { flags: { '--script': true }, words: [], text: 'GM_info' });
  assert.deepEqual(typed('eval', '--script='), { error: 'The `--script` flag needs a value: `--script=<script>`', flag: '--script' });
  assert.deepEqual(typed('eval', '--script=a --script'), { error: 'The --script flag can be given once', flag: '--script' });
  // Sent as words, as `sm-dev eval --script=2 x` does.
  assert.deepEqual(sent('eval', '--script=2', 'x').flags, { '--script': '2' });
});

test('arguments a command doesn\'t take are refused, with its usage', () => {
  assert.deepEqual(typed('status', 'extra'), { error: 'The `status` command takes no arguments' });
  assert.deepEqual(typed('focus', 'T1 T2 T3'), { error: 'The `focus` command takes at most one argument besides a tab (focus [T<n>])' });
  assert.deepEqual(typed('attach', 'D1 D2'), { error: 'The `attach` command takes at most one argument (attach [ID])' });
  assert.deepEqual(typed('logs', 'all 1 x'), { error: 'The `logs` command takes at most two arguments besides a tab (logs [tab|all] [script])' });
  assert.deepEqual(typed('status', '\nline'), { error: 'The `status` command takes no {{ block' });
});

test('--help asks for the command\'s help, where a flag can go', () => {
  assert.equal(typed('closetab', '--help').help, true);
  assert.equal(typed('click', '.x --help').help, true);
  assert.deepEqual(sent('stop', '--help').help, true);
  // In text too; quoted, it's text.
  assert.equal(typed('eval', 'x --help').help, true);
  assert.equal(typed('eval', `x '--help'`).help, undefined);
});

test('a tab can lead a page command\'s arguments, among its flags', () => {
  assert.deepEqual(typed('eval', 'T2 --script document.title'), { flags: { '--script': true }, tab: 'T2', words: [], text: 'document.title' });
  assert.deepEqual(typed('eval', '--script T2 x').tab, 'T2');
  assert.deepEqual(typed('probe', '[targetId=ABC123] .x'), { flags: {}, tab: '[targetId=ABC123]', words: ['.x'] });
  assert.equal(typed('focus', '[targetId=ABC123]').tab, '[targetId=ABC123]');
  // Only first: a later T2 is an argument.
  assert.deepEqual(typed('key', 'j T2').words, ['j', 'T2']);
});

test('text is the rest of the line, less the flags in it', () => {
  assert.equal(typed('eval', '"abc".length').text, '"abc".length');
  assert.deepEqual(typed('eval', 'x --script'), { flags: { '--script': true }, words: [], text: 'x' });
  // A flag anywhere in the text, with its value, as typed or from a shell.
  const js = 'new Promise((r) => setTimeout(r, 30000))';
  assert.deepEqual(typed('eval', `T2 '${js}' --timeout-seconds 45`), { flags: { '--timeout-seconds': '45' }, tab: 'T2', words: [], text: `'${js}'` });
  assert.deepEqual(sent('eval', 'T2', js, '--timeout-seconds', '45'), { flags: { '--timeout-seconds': '45' }, tab: 'T2', words: [], text: js });
  assert.deepEqual(typed('eval', 'a --timeout-seconds=4 + b').text, 'a + b');
  // An unknown one is refused, not run as code; a global one is named as such.
  assert.equal(typed('eval', 'x --y').error, 'The `eval` command has no `--y` flag. It takes `--page`, `--script`, `--file`, `--out`, `--timeout-seconds`, `--frame`.');
  assert.equal(typed('eval', '1 --run D1').error, 'The `--run` flag is for the whole command line, so it goes first, before any command: `sm-dev --run ... <command>`');
  // Code that only looks like one somewhere stays code: quoted, inside a
  // word, or not a name after the dashes.
  for (const code of [`a = '--y'`, 'i--', '--i;', 'x -- y', 'f(--n)']) assert.equal(typed('eval', code).text, code, code);
  assert.equal(sent('eval', 'x = 1 --y').text, 'x = 1 --y');
  assert.deepEqual(typed('set', `k '["a"]'`), { flags: {}, words: ['k'], text: '["a"]' });
  assert.equal(typed('set', 'k "metric"').text, '"metric"');
  assert.deepEqual(typed('set', 'k --file v.json'), { flags: { '--file': 'v.json' }, words: ['k'], text: '' });
  assert.equal(typed('set', 'k --flie v.json').error, 'The `set` command has no `--flie` flag. It takes `--file`, `--force`.');
  // set's flags can also end its JSON, which can't end with one.
  for (const line of ['k "def" --force', '--force k "def"', 'k --force "def"']) {
    assert.deepEqual(typed('set', line), { flags: { '--force': true }, words: ['k'], text: '"def"' }, line);
  }
  assert.deepEqual(typed('set', 'k "x --force"'), { flags: {}, words: ['k'], text: '"x --force"' });
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

test('wait: a tab, then the form, and flags in wait log\'s text', () => {
  assert.deepEqual(typed('wait', 'T1 selector #go'), { flags: {}, tab: 'T1', form: 'selector', words: [], text: '#go' });
  assert.deepEqual(typed('wait', 'log ready --timeout-seconds 9'), { flags: { '--timeout-seconds': '9' }, form: 'log', words: [], text: 'ready' });
  assert.deepEqual(typed('wait', 'log ready --timeout-seconds=9').flags, { '--timeout-seconds': '9' });
  // Any other --name is refused.
  assert.equal(typed('wait', 'log ready --timeout 40').error, 'The `wait` command has no `--timeout` flag. It takes `--timeout-seconds`, `--log-source`, `--find`, `--since`, `--frame`.');
  assert.equal(typed('wait', 'log Running --dry-run mode').error, 'The `wait` command has no `--dry-run` flag. It takes `--timeout-seconds`, `--log-source`, `--find`, `--since`, `--frame`.');
  // Quoted, or a regex, it's all text.
  assert.equal(typed('wait', `log 'x --timeout 40'`).text, 'x --timeout 40');
  assert.equal(typed('wait', 'log /a --timeout b/').text, '/a --timeout b/');
  // Flags can follow the regex, typed or from a shell.
  assert.deepEqual(typed('wait', 'log /a --b c/ --timeout-seconds 3'), { flags: { '--timeout-seconds': '3' }, form: 'log', words: [], text: '/a --b c/' });
  assert.deepEqual(sent('wait', 'log', '/a', '--b', 'c/', '--timeout-seconds', '3').flags, { '--timeout-seconds': '3' });
  assert.equal(sent('wait', 'log', '/a', '--b', 'c/', '--timeout-seconds', '3').text, '/a --b c/');
  // From a shell, only a word of its own is a flag.
  assert.equal(sent('wait', 'log', 'Running --timeout mode').text, 'Running --timeout mode');
  assert.equal(sent('wait', 'log', 'x', '--timeout', '40').error, 'The `wait` command has no `--timeout` flag. It takes `--timeout-seconds`, `--log-source`, `--find`, `--since`, `--frame`.');
  assert.deepEqual(sent('wait', '2s').words, ['2s']);
  // Flags anywhere in it are taken.
  assert.deepEqual(typed('wait', 'log --timeout-seconds 4 x').flags, { '--timeout-seconds': '4' });
  assert.deepEqual(typed('wait', 'log a --timeout-seconds 4 b'), { flags: { '--timeout-seconds': '4' }, form: 'log', words: [], text: 'a b' });
  // The text with --find instead, and the log flags ending it too.
  assert.deepEqual(typed('wait', 'log --find ready'), { flags: { '--find': 'ready' }, form: 'log', words: [], text: '' });
  assert.deepEqual(typed('wait', 'log ready --since 14:05:12 --log-source all').flags, { '--since': '14:05:12', '--log-source': 'all' });
  assert.equal(typed('wait', 'log a --other=b').error, 'The `wait` command has no `--other` flag. It takes `--timeout-seconds`, `--log-source`, `--find`, `--since`, `--frame`.');
});

test('sm-dev\'s own commands read the same way', () => {
  assert.deepEqual(sent('start', 'a.user.js', '--watch', '--browser=9300', 'https://x.com/'), {
    flags: { '--watch': true, '--browser': '9300' }, words: ['a.user.js', 'https://x.com/'],
  });
  assert.equal(sent('stop', '--watch').error, 'The `stop` command has no `--watch` flag. It takes `--all`.');
  assert.equal(sent('list', 'x').error, 'The `list` command takes no arguments');
});

test('a form can name what it acts on before its keyword, or leave it out', () => {
  assert.deepEqual(typed('script', 'E4 move C2'), { flags: {}, form: 'move', subject: 'E4', words: ['C2'] });
  assert.deepEqual(typed('script', 'move C2'), { flags: {}, form: 'move', words: ['C2'] });
  assert.deepEqual(typed('script', '"Dark mode" enable --json'), { flags: { '--json': true }, form: 'enable', subject: 'Dark mode', words: [] });
  assert.deepEqual(sent('collection', 'C3', 'rename', 'My', 'scripts'), { flags: {}, form: 'rename', subject: 'C3', words: ['My', 'scripts'] });
  // Not for a form that takes none: list's argument comes after it.
  assert.deepEqual(typed('script', 'list C3'), { flags: {}, form: 'list', words: ['C3'] });
  assert.equal(typed('script', 'C3 list').form, undefined);
  // The old order says the new one.
  assert.deepEqual(typed('script', 'enable E4'), { error: 'Name the script before the verb: script E4 enable' });
  assert.deepEqual(typed('script', 'move E4 C2'), { error: 'Name the script before the verb: script E4 move C2' });
});
