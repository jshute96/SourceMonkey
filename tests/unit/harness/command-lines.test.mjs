// Unit tests for src/harness/command-lines.ts (compiled to
// lib/harness/command-lines.js): `{{ ... }}` blocks, comments, and
// lists of commands sent in one go.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CommandAssembler, endsOutsideBlock, NOT_A_BLOCK_COMMAND, OPEN_NOT_LAST, TEXT_AFTER_CLOSE, echoCommand, parseCommandList, unclosedBlockMessage,
} from '../../../lib/harness/command-lines.js';
import { plainLine } from '../../../lib/harness/output-style.js';

const texts = (result) => result.commands.map((c) => c.text);

test('one command per line, blanks and comments skipped', () => {
  const result = parseCommandList('tabs T2\n\n# a comment\n  # indented too\nstatus\n');
  assert.deepEqual(texts(result), ['tabs T2', 'status']);
  assert.deepEqual(result.commands.map((c) => c.line), [1, 5]);
});

test('an eval block keeps its lines, and the tab and flags before {{', () => {
  const result = parseCommandList([
    'eval T2 --script {{',
    '  const rows = [...document.querySelectorAll(".athing")];',
    '',
    '  // ids',
    '  #not a comment in here',
    '  rows.map((r) => r.id)',
    '}}',
    'values',
  ].join('\n'));
  assert.deepEqual(texts(result), [
    'eval T2 --script\n  const rows = [...document.querySelectorAll(".athing")];\n\n  // ids\n  #not a comment in here\n  rows.map((r) => r.id)',
    'values',
  ]);
});

test('code after {{ on its line is refused, rather than its lines run as commands', () => {
  assert.deepEqual(parseCommandList('eval {{ const x = 1;\nx\n}}'), { error: `Line 1: ${OPEN_NOT_LAST}. None of the commands were run.` });
  assert.deepEqual(parseCommandList('eval --script {{ x }}'), { error: `Line 1: ${OPEN_NOT_LAST}. None of the commands were run.` });
  // type's text may hold the word.
  assert.deepEqual(texts(parseCommandList('type #a a {{ b')), ['type #a a {{ b']);
  // As may a quoted string.
  assert.deepEqual(texts(parseCommandList('eval tpl.split(\' {{ \')')), ['eval tpl.split(\' {{ \')']);
  assert.deepEqual(texts(parseCommandList('set k "a {{ b"')), ['set k "a {{ b"']);
});

test('a lone } inside a block is JavaScript, and }} may be indented', () => {
  const result = parseCommandList('eval {{\nfunction f() {\n  return 1;\n}\nf()\n  }}  ');
  assert.deepEqual(texts(result), ['eval\nfunction f() {\n  return 1;\n}\nf()']);
});

test('a block\'s blank lines and trailing spaces are kept, an empty one is no text', () => {
  assert.deepEqual(texts(parseCommandList('eval {{\n}}')), ['eval']);
  assert.deepEqual(texts(parseCommandList('type #a {{\nx  \n\n}}')), ['type #a\nx  \n']);
});

test('a set block is its JSON, lines and all', () => {
  assert.deepEqual(texts(parseCommandList('set prefs {{\n{\n  "units": "metric"\n}\n}}')), ['set prefs\n{\n  "units": "metric"\n}']);
});

test('words after a }} are an error, but }}); and }}, are the block\'s', () => {
  assert.deepEqual(parseCommandList('type #a {{\nhi\n}} --nowait\nstatus'), { error: `Line 3: ${TEXT_AFTER_CLOSE}. None of the commands were run.` });
  assert.deepEqual(texts(parseCommandList('eval {{\nf(() => {g({\n}});\n}}')), ['eval\nf(() => {g({\n}});']);
  const a = new CommandAssembler();
  a.push('set k {{');
  assert.deepEqual(a.push('}} x'), { error: TEXT_AFTER_CLOSE });
  assert.equal(a.open, false);
});

test('a refused one-line {{ skips its lines up to the }}, rather than refusing each', () => {
  const a = new CommandAssembler();
  assert.deepEqual(a.push('eval {{ const x = 1;'), { error: OPEN_NOT_LAST });
  assert.equal(a.open, true);
  assert.equal(a.push('return x;'), null);
  assert.equal(a.push('}}'), null);
  assert.equal(a.open, false);
  assert.equal(a.push('status').command.text, 'status');
  // With a }} on the line too, nothing is left open.
  for (const line of ['eval {{ x }}', 'eval {{ foo}}', 'eval {{ f() }});']) {
    assert.deepEqual(a.push(line), { error: OPEN_NOT_LAST });
    assert.equal(a.open, false);
  }
});

test('a cdp block is its calls, one per line', () => {
  assert.deepEqual(texts(parseCommandList('cdp T2 {{\nPage.enable\nPage.reload {"ignoreCache": true}\n}}')), ['cdp T2\nPage.enable\nPage.reload {"ignoreCache": true}']);
});

test('{{ after another command refuses the whole list', () => {
  assert.deepEqual(parseCommandList('status\ntabs {{\n}}'), { error: `Line 2: ${NOT_A_BLOCK_COMMAND}. None of the commands were run.` });
});

test('a refused block\'s lines are skipped, not run as commands', () => {
  const a = new CommandAssembler();
  assert.deepEqual(a.push('tabs {{'), { error: NOT_A_BLOCK_COMMAND });
  assert.equal(a.open, true);
  assert.equal(a.push('reload'), null);
  assert.equal(a.push('quit'), null);
  assert.equal(a.push('}}'), null);
  assert.equal(a.open, false);
  assert.equal(a.push('status').command.text, 'status');
});

test('{{ in the middle of a line is not a block', () => {
  assert.deepEqual(texts(parseCommandList('eval ({{a: 1}}).a')), ['eval ({{a: 1}}).a']);
});

test('a block left open refuses the whole list', () => {
  assert.deepEqual(parseCommandList('status\neval {{\n1 + 1\n'), {
    error: `${unclosedBlockMessage(2)}. None of the commands were run.`,
  });
});

test('CRLF line ends are taken as plain ones', () => {
  assert.deepEqual(texts(parseCommandList('eval {{\r\n1\r\n}}\r\nstatus\r\n')), ['eval\n1', 'status']);
});

test('the assembler reports an open block, and drop forgets it', () => {
  const a = new CommandAssembler();
  assert.equal(a.push('eval {{'), null);
  assert.equal(a.open, true);
  assert.equal(a.push('1'), null);
  assert.equal(a.drop(), 1);
  assert.equal(a.open, false);
  assert.deepEqual(a.push('status').command.text, 'status');
});

test('echoCommand shows a block as the prompt does', () => {
  const [command] = parseCommandList('  eval T2 {{\n  1 + 1\n}}').commands;
  assert.deepEqual(echoCommand(command).map(plainLine), ['> eval T2 {{', '...   1 + 1', '... }}']);
});

test('endsOutsideBlock: whether typed lines are ready to run', () => {
  assert.equal(endsOutsideBlock('tabs'), true);
  assert.equal(endsOutsideBlock(''), true);
  assert.equal(endsOutsideBlock('eval {{\nconst x = 1'), false);
  assert.equal(endsOutsideBlock('eval {{\nx\n}}'), true);
  // A refused block still waits for its }}, so its lines aren't run.
  assert.equal(endsOutsideBlock('tabs {{\nx'), false);
});
