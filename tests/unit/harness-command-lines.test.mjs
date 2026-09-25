// Unit tests for src/harness/command-lines.ts (compiled to
// lib/harness/command-lines.js): `eval {{ ... }}` blocks, comments, and
// lists of commands sent in one go.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CommandAssembler, ONLY_EVAL_TAKES_A_BLOCK, echoCommand, parseCommandList, unclosedBlockMessage,
} from '../../lib/harness/command-lines.js';

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

test('a lone } inside a block is JavaScript, and }} may be indented', () => {
  const result = parseCommandList('eval {{\nfunction f() {\n  return 1;\n}\nf()\n  }}  ');
  assert.deepEqual(texts(result), ['eval\nfunction f() {\n  return 1;\n}\nf()']);
});

test('an empty block is eval with nothing to evaluate', () => {
  assert.deepEqual(texts(parseCommandList('eval {{\n\n}}')), ['eval']);
});

test('{{ after another command refuses the whole list', () => {
  assert.deepEqual(parseCommandList('status\ntabs {{\n}}'), { error: `Line 2: ${ONLY_EVAL_TAKES_A_BLOCK}. None of the commands were run.` });
});

test('a refused block\'s lines are skipped, not run as commands', () => {
  const a = new CommandAssembler();
  assert.deepEqual(a.push('tabs {{'), { error: ONLY_EVAL_TAKES_A_BLOCK });
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
  assert.deepEqual(echoCommand(command), ['> eval T2 {{', '...   1 + 1', '... }}']);
});
