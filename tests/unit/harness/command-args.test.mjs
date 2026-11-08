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
  assert.deepEqual(typed('snapshot', '--out tree.txt --visible --selector main').flags, { '--out': 'tree.txt', '--visible': true, '--selector': 'main' });
  assert.deepEqual(typed('snapshot', '--out=tree.txt').flags, { '--out': 'tree.txt' });
  assert.deepEqual(typed('snapshot', '--visible=yes'), { error: 'The --visible flag takes no value', flag: '--visible' });
  assert.deepEqual(typed('snapshot', '--out'), { error: 'The `--out` flag needs a value: `--out FILE`', flag: '--out' });
  assert.deepEqual(typed('snapshot', '--out='), { error: 'The `--out` flag needs a value: `--out FILE`', flag: '--out' });
  assert.deepEqual(typed('snapshot', '--out --visible'), { error: 'The `--out` flag needs a value: `--out FILE`', flag: '--out' });
  assert.deepEqual(typed('snapshot', '--visible --visible'), { error: 'The --visible flag can be given once', flag: '--visible' });
  // A value only after =.
  assert.deepEqual(typed('status', '--json=multi').flags, { '--json': 'multi' });
  assert.deepEqual(typed('values', '2 --json').flags, { '--json': true });
  // Then its usage and flags, for a guess at either.
  assert.deepEqual(typed('snapshot', '--deep'), {
    error: [
      'The `snapshot` command has no `--deep` flag.',
      '  Usage: `snapshot`',
      '  Flags: `--selector <css>`, `--visible`, `--out FILE`, `--find <text>`, `--up <n>`, `--context`, `--limit <n>`, `--timeout-seconds S`, `--tab <tab>`, `--frame <frame>`',
      '  See `help snapshot`.',
    ].join('\n'),
    flag: '--deep',
  });
  // A quoted word is never a flag.
  assert.deepEqual(typed('probe', `'--x' .y`).words, ['--x', '.y']);
  // Also on a command that takes few.
  assert.equal(typed('status', '--bad').error.split('\n')[0], 'The `status` command has no `--bad` flag.');
});

test('a flag with an optional value takes it only after =', () => {
  assert.deepEqual(typed('eval', '--script=Foo x'), { flags: { '--script': 'Foo' }, words: [], text: 'x' });
  // Bare, it never takes the next word: that's the code.
  assert.deepEqual(typed('eval', '--script x --tab T1'), { flags: { '--script': true }, tab: 'T1', words: [], text: 'x' });
  assert.deepEqual(typed('eval', '--script GM_info'), { flags: { '--script': true }, words: [], text: 'GM_info' });
  assert.deepEqual(typed('eval', '--script='), { error: 'The `--script` flag needs a value: `--script=<script>`', flag: '--script' });
  assert.deepEqual(typed('eval', '--script=a --script'), { error: 'The --script flag can be given once', flag: '--script' });
  // Sent as words, as `sm-dev eval --script=2 x` does.
  assert.deepEqual(sent('eval', '--script=2', 'x').flags, { '--script': '2' });
  // A script ID after a bare --script, with code after it, is its value.
  assert.deepEqual(typed('eval', `--script 1 'document.title'`), { flags: { '--script': '1' }, words: [], text: 'document.title' });
  assert.deepEqual(typed('eval', '--script T2.3 x'), { flags: { '--script': 'T2.3' }, words: [], text: 'x' });
  assert.deepEqual(sent('eval', '--script', 'E4', '1+1'), { flags: { '--script': 'E4' }, words: [], text: '1+1' });
  // Alone after it, the ID is the code; quoted, it is code too.
  assert.deepEqual(typed('eval', '--script 1'), { flags: { '--script': true }, words: [], text: '1' });
  assert.deepEqual(typed('eval', `--script '1' x`), { flags: { '--script': true }, words: [], text: `'1' x` });
  // Before a flag, the ID is the code too.
  assert.deepEqual(typed('eval', '--script 2 --out f'), { flags: { '--script': true, '--out': 'f' }, words: [], text: '2' });
});

test('arguments a command doesn\'t take are refused, with its usage', () => {
  assert.deepEqual(typed('status', 'extra'), {
    error: ['The `status` command takes no arguments.', '  Usage: `status`', '  Flags: `--frames`, `--json[=single|multi]`, `--nojson`', '  See `help status`.'].join('\n'),
  });
  const first = (r) => r.error.split('\n')[0];
  assert.equal(first(typed('focus', 'T1 T2 T3')), 'The `focus` command takes at most one argument besides a tab.');
  assert.deepEqual(typed('attach', 'D1 D2'), { error: ['The `attach` command takes at most one argument.', '  Usage: `attach [ID]`', '  Flags: `--log-source SOURCE`', '  See `help attach`.'].join('\n') });
  assert.equal(first(typed('logs', 'all')), 'The `logs` command takes no arguments.');
  // A word after a flag's value may be the rest of it, unquoted.
  assert.equal(first(typed('logs', '--find /a|b c/')), 'The `logs` command takes no arguments. If `c/` is part of the `--find` value, quote the whole value.');
  // Only after a text value: a number's is whole.
  assert.equal(first(typed('logs', '--tail 20 all')), 'The `logs` command takes no arguments.');
  assert.equal(typed('logs', '--tab all').tab, 'all');
  // An extra argument in screenshot's shows where the element goes.
  assert.match(typed('screenshot', '.btn out.png').error, /^ {2}Flags: `--selector <css>`/m);
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

test('a page command takes its tab as --tab, anywhere among its words', () => {
  assert.deepEqual(typed('eval', '--tab T2 --script document.title'), { flags: { '--script': true }, tab: 'T2', words: [], text: 'document.title' });
  assert.deepEqual(typed('eval', 'x --tab T2').tab, 'T2');
  assert.deepEqual(typed('probe', '.x --tab [targetId=ABC123]'), { flags: {}, tab: '[targetId=ABC123]', words: ['.x'] });
  assert.deepEqual(typed('wait', 'selector .x --tab T1'), { flags: {}, tab: 'T1', form: 'selector', words: [], text: '.x' });
  // A tab leading its arguments is refused, naming --tab.
  for (const [command, line, name] of [['eval', 'T2 x', 'eval'], ['click', 'T1 .x', 'click'], ['open', 'T2 https://x.com/', 'open'], ['wait', 'selector T1 .x', 'wait selector'], ['wait', 'T1 selector .x', 'wait selector']]) {
    assert.equal(typed(command, line).error.split('\n')[0], `The \`${name}\` command takes a tab as \`--tab ${line.match(/T\d/)[0]}\`, not as an argument.`, line);
  }
  // A later T2 is an argument.
  assert.deepEqual(typed('key', 'j T2').words, ['j', 'T2']);
  // --help still shows help, past the mistake.
  assert.equal(typed('click', 'T2 --help').help, true);
  assert.equal(typed('logs', 'all --help').help, true);
  // logs and wait log take --tab all; the page commands don't.
  assert.equal(typed('logs', '--tab all').tab, 'all');
  assert.equal(typed('click', '.x --tab all').error.split('\n')[0], 'The `click` command doesn\'t take `--tab all`. Name one tab, as in `--tab T2`.');
  // wait log watches one tab's lines with --tab, all tabs' without.
  assert.equal(typed('wait', 'log x --tab T1').tab, 'T1');
  assert.equal(typed('wait', 'T1 log x').error.split('\n')[0], 'The `wait log` command takes a tab as `--tab T1`, not as an argument.');
});

test('a command about tabs takes its tab as its argument or as --tab, once', () => {
  assert.equal(typed('focus', '[targetId=ABC123]').tab, '[targetId=ABC123]');
  assert.equal(typed('reload', '--tab T2').tab, 'T2');
  assert.deepEqual(typed('wait', 'T1'), { flags: {}, tab: 'T1', words: [] });
  assert.deepEqual(typed('wait', '--tab T1'), { flags: {}, tab: 'T1', words: [] });
  assert.deepEqual(typed('closetab', 'T2 --tab T3').words, ['T3', 'T2']);
  assert.deepEqual(typed('frames', '--tab T2').words, ['T2']);
  assert.equal(typed('menu', '--tab T2').text, 'T2');
  const first = (r) => r.error.split('\n')[0];
  assert.equal(first(typed('reload', 'T1 --tab T2')), 'The `reload` command takes one tab.');
  assert.equal(first(typed('frames', 'F3 --tab T2')), 'The `frames` command takes at most one argument.');
  assert.equal(first(typed('menu', 'M1 --tab T2')), 'The `menu` command takes one argument.');
  // --tab all is the all argument, where one is taken.
  assert.deepEqual(typed('wait', '--tab all'), { flags: {}, words: ['all'] });
  assert.deepEqual(typed('reload', '--tab=ALL').words, ['all']);
  assert.deepEqual(typed('closetab', '--tab all').words, ['all']);
  assert.equal(first(typed('focus', '--tab all')), 'The `focus` command doesn\'t take `--tab all`. Name one tab, as in `--tab T2`.');
});

test('text is the rest of the line, less the flags in it', () => {
  assert.equal(typed('eval', '"abc".length').text, '"abc".length');
  // Quotes around all of it are a shell's, taken off; JavaScript's stay.
  assert.equal(typed('eval', "'document.title'").text, 'document.title');
  assert.equal(typed('eval', `"a" + 'b'`).text, `"a" + 'b'`);
  assert.deepEqual(typed('eval', 'x --script'), { flags: { '--script': true }, words: [], text: 'x' });
  // A flag anywhere in the text, with its value, as typed or from a shell.
  const js = 'new Promise((r) => setTimeout(r, 30000))';
  assert.deepEqual(typed('eval', `--tab T2 '${js}' --timeout-seconds 45`), { flags: { '--timeout-seconds': '45' }, tab: 'T2', words: [], text: js });
  assert.deepEqual(sent('eval', '--tab', 'T2', js, '--timeout-seconds', '45'), { flags: { '--timeout-seconds': '45' }, tab: 'T2', words: [], text: js });
  assert.deepEqual(typed('eval', 'a --timeout-seconds=4 + b').text, 'a + b');
  // An unknown one is refused, not run as code; a global one is named as such.
  assert.equal(typed('eval', 'x --y').error.split('\n')[0], 'The `eval` command has no `--y` flag.');
  assert.equal(typed('eval', '1 --run D1').error, 'The `--run` flag is for the whole command line, so it goes first, before any command: `sm-dev --run ... <command>`');
  // Any command takes --timeout-seconds, and one that waits on nothing
  // ignores it; its value is still checked.
  assert.deepEqual(typed('accept', 'yes --timeout-seconds 5'), { flags: {}, words: [], text: 'yes' });
  assert.deepEqual(sent('dismiss', '--timeout-seconds=5'), { flags: {}, words: [] });
  assert.equal(typed('accept', '--timeout-seconds x').error, 'The --timeout-seconds flag needs a number of seconds, up to 2147483');
  // Code that only looks like one somewhere stays code: quoted, inside a
  // word, or not a name after the dashes.
  for (const code of [`a = '--y'`, 'i--', '--i;', 'x -- y', 'f(--n)']) assert.equal(typed('eval', code).text, code, code);
  assert.equal(sent('eval', 'x = 1 --y').text, 'x = 1 --y');
  assert.deepEqual(typed('set', `k '["a"]'`), { flags: {}, words: ['k'], text: '["a"]' });
  assert.equal(typed('set', 'k "metric"').text, '"metric"');
  assert.deepEqual(typed('set', 'k --file v.json'), { flags: { '--file': 'v.json' }, words: ['k'], text: '' });
  assert.equal(typed('set', 'k --flie v.json').error.split('\n')[0], 'The `set` command has no `--flie` flag.');
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
  assert.equal(typed('hover', `'#a b' --modifiers Alt`).text, '#a b');
  assert.equal(sent('click', 'e4', '--modifiers=Alt').text, 'e4');
});

test('wait: the form, and flags in wait log\'s text', () => {
  assert.deepEqual(typed('wait', 'selector #go --tab T1'), { flags: {}, tab: 'T1', form: 'selector', words: [], text: '#go' });
  assert.deepEqual(typed('wait', 'log ready --timeout-seconds 9'), { flags: { '--timeout-seconds': '9' }, form: 'log', words: [], text: 'ready' });
  assert.deepEqual(typed('wait', 'log ready --timeout-seconds=9').flags, { '--timeout-seconds': '9' });
  // Any other --name is refused.
  assert.equal(typed('wait', 'log ready --timeout 40').error.split('\n')[0], 'The `wait log` command has no `--timeout` flag.');
  assert.equal(typed('wait', 'log Running --dry-run mode').error.split('\n')[0], 'The `wait log` command has no `--dry-run` flag.');
  // Quoted, or a regex, it's all text.
  assert.equal(typed('wait', `log 'x --timeout 40'`).text, 'x --timeout 40');
  assert.equal(typed('wait', 'log /a --timeout b/').text, '/a --timeout b/');
  // Flags can follow the regex, typed or from a shell.
  assert.deepEqual(typed('wait', 'log /a --b c/ --timeout-seconds 3'), { flags: { '--timeout-seconds': '3' }, form: 'log', words: [], text: '/a --b c/' });
  assert.deepEqual(sent('wait', 'log', '/a', '--b', 'c/', '--timeout-seconds', '3').flags, { '--timeout-seconds': '3' });
  assert.equal(sent('wait', 'log', '/a', '--b', 'c/', '--timeout-seconds', '3').text, '/a --b c/');
  // From a shell, only a word of its own is a flag.
  assert.equal(sent('wait', 'log', 'Running --timeout mode').text, 'Running --timeout mode');
  assert.equal(sent('wait', 'log', 'x', '--timeout', '40').error.split('\n')[0], 'The `wait log` command has no `--timeout` flag.');
  assert.deepEqual(sent('wait', '2s').words, ['2s']);
  // Flags anywhere in it are taken.
  assert.deepEqual(typed('wait', 'log --timeout-seconds 4 x').flags, { '--timeout-seconds': '4' });
  assert.deepEqual(typed('wait', 'log a --timeout-seconds 4 b'), { flags: { '--timeout-seconds': '4' }, form: 'log', words: [], text: 'a b' });
  // The text with --find instead, and the log flags ending it too.
  assert.deepEqual(typed('wait', 'log --find ready'), { flags: { '--find': 'ready' }, form: 'log', words: [], text: '' });
  assert.deepEqual(typed('wait', 'log ready --since 14:05:12 --log-source all').flags, { '--since': '14:05:12', '--log-source': 'all' });
  assert.equal(typed('wait', 'log a --other=b').error.split('\n')[0], 'The `wait log` command has no `--other` flag.');
});

test('sm-dev\'s own commands read the same way', () => {
  assert.deepEqual(sent('start', 'a.user.js', '--watch', '--browser=9300', 'https://x.com/'), {
    flags: { '--watch': true, '--browser': '9300' }, words: ['a.user.js', 'https://x.com/'],
  });
  assert.equal(sent('stop', '--watch').error.split('\n')[0], 'The `stop` command has no `--watch` flag.');
  assert.equal(sent('list', 'x').error.split('\n')[0], 'The `list` command takes no arguments.');
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
  assert.deepEqual(typed('script', 'enable E4'), { error: 'Name the script before the verb: `script E4 enable`' });
  assert.deepEqual(typed('script', 'move E4 C2'), { error: 'Name the script before the verb: `script E4 move ...`' });
});

test('each subcommand takes its own flags and the command\'s shared ones, and no other\'s', () => {
  assert.deepEqual(typed('script', 'save /tmp/x --file xx'), {
    error: [
      'The `script save` command has no `--file` flag. The `--file` flag is for `script print`.',
      '  Usage: `script [script] save <dir>`',
      '  Flags: `--include <parts>`, `--flat`, `--force`, `--json[=single|multi]`, `--nojson`',
      '  See `help script save`.',
    ].join('\n'),
    flag: '--file',
  });
  // Given before the subcommand, it is checked once the subcommand is known.
  assert.equal(typed('script', '--out x enable').error.split('\n')[0], 'The `script enable` command has no `--out` flag. The `--out` flag is for `script print`.');
  assert.deepEqual(typed('script', 'E4 print --file jq --json').flags, { '--file': 'jq', '--json': true });
  // The forms with no subcommand take the shared ones only.
  assert.match(typed('script', 'E4 --flat').error, /^The `script` command has no `--flat` flag\. The `--flat` flag is for `script save`\.$/m);
  // An option a section lists for one subcommand (`wait log`).
  assert.deepEqual(typed('wait', 'log ready --since 5').flags, { '--since': '5' });
  assert.match(typed('wait', '2s --since 5').error, /^The `wait` command has no `--since` flag\./);
  assert.match(typed('wait', 'selector .x --frame F2').error ?? '', /^$/);
  assert.match(typed('wait', 'T1 --frame F2').error, /^The `wait` command has no `--frame` flag\./);
  // Any subcommand takes --timeout-seconds, as any command does: checked, then left out.
  assert.deepEqual(typed('script', 'save /tmp/x --timeout-seconds 3').flags, {});
  assert.match(typed('script', 'save /tmp/x --timeout-seconds soon').error, /^The --timeout-seconds flag needs a number of seconds/);
  // Help isn't refused for a slip.
  assert.equal(typed('script', 'save --file x --help').help, true);
});
