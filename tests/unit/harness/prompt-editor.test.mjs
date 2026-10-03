// Unit tests for src/harness/prompt-editor.ts (compiled to
// lib/harness/prompt-editor.js): multi-line editing at the
// `--interactive` prompt, on a terminal-mode readline over in-memory
// streams. It replaces readline methods Node doesn't document, so these
// also catch a Node upgrade that changes them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import readline from 'node:readline';
import { PassThrough } from 'node:stream';

import { endsOutsideBlock } from '../../../lib/harness/command-lines.js';
import { editMultiLine } from '../../../lib/harness/prompt-editor.js';

const UP = '\x1b[A';
const DOWN = '\x1b[B';
const LEFT = '\x1b[D';

// A prompt over fake streams. `type` writes keys one chunk at a time;
// a chunk of several characters is a paste.
function prompt(history = [], { columns = 80, rows = 24 } = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  // Read by readline as the terminal's size.
  Object.assign(output, { columns, rows });
  let drawn = '';
  output.on('data', (chunk) => { drawn += chunk; });
  const rl = readline.createInterface({ input, output, terminal: true, prompt: '> ', history: [...history], escapeCodeTimeout: 10 });
  const cleared = [];
  const editor = editMultiLine(rl, '... ', endsOutsideBlock, (text) => cleared.push(text));
  const sent = [];
  rl.on('line', (line) => sent.push(line));
  const type = (...chunks) => { for (const chunk of chunks) input.write(chunk); };
  return { rl, editor, sent, cleared, type, drawn: () => drawn, close: () => rl.close() };
}

test('Enter inside a block adds a line, and sends the block once closed', () => {
  const p = prompt();
  p.type('eval {{\r', 'const x = 1\r', 'x\r');
  assert.deepEqual(p.sent, []);
  assert.equal(p.rl.line, 'eval {{\nconst x = 1\nx\n');
  p.type('}}\r');
  assert.deepEqual(p.sent, ['eval {{\nconst x = 1\nx\n}}']);
  p.type('tabs\r');
  assert.equal(p.sent.at(-1), 'tabs');
  p.close();
});

test('Enter mid-line in a block splits it; Alt-Enter adds a line to a complete one', () => {
  const p = prompt();
  p.type('eval {{\r', 'ab', LEFT, '\r');
  assert.equal(p.rl.line, 'eval {{\na\nb');
  p.close();
  const q = prompt();
  q.type('tabs', '\x1b\r', 'status');
  assert.equal(q.rl.line, 'tabs\nstatus');
  assert.deepEqual(q.sent, []);
  q.close();
});

test('a pasted block arrives as one', () => {
  const p = prompt();
  p.type('eval {{\rconst long = "pasted text";\r}}\r');
  assert.deepEqual(p.sent, ['eval {{\nconst long = "pasted text";\n}}']);
  p.close();
});

test('Up and Down move between lines, and through the history at the ends', () => {
  const p = prompt(['eval {{\nx\n}}', 'older']);
  p.type('eval {{\r', 'abc\r', 'de');
  p.type(UP);
  assert.equal(p.rl.cursor, 'eval {{\nab'.length, 'up a line, same column on screen');
  p.type(UP, UP);
  assert.equal(p.rl.line, 'eval {{\nx\n}}', 'from the first line, the history');
  // Still browsing, so a recalled block is passed in one step.
  p.type(UP);
  assert.equal(p.rl.line, 'older');
  p.type(DOWN, DOWN);
  assert.equal(p.rl.line, 'eval {{\nabc\nde', 'past the newest entry, the draft');
  p.close();
});

test('after another key, Up and Down move within a recalled block again', () => {
  const p = prompt(['eval {{\nabc\n}}', 'older']);
  p.type(UP);
  assert.equal(p.rl.line, 'eval {{\nabc\n}}');
  p.type(LEFT, UP);
  assert.equal(p.rl.line, 'eval {{\nabc\n}}');
  assert.equal(p.rl.cursor, 'eval {{\na'.length);
  p.type('\x10');
  assert.equal(p.rl.line, 'older', 'Ctrl-P always steps entries');
  p.close();
});

test('Esc clears the buffer, passing on what it held', async () => {
  const p = prompt();
  p.type('eval {{\r', 'abc', '\x1b');
  // A lone Esc is taken once no more of a sequence follows.
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(p.rl.line, '');
  assert.deepEqual(p.cleared, ['eval {{\nabc']);
  p.close();
});

test('Up with no older entry leaves the buffer as it is', () => {
  const p = prompt();
  p.type('eval {{\r', 'abc', LEFT, UP, UP);
  assert.equal(p.rl.line, 'eval {{\nabc');
  p.close();
  // readline would leave just the text before the cursor here.
  const q = prompt(['tabs']);
  q.type('zzz', LEFT, UP);
  assert.equal(q.rl.line, 'zzz');
  q.close();
});

test('a one-line draft finds entries starting with its text', () => {
  const p = prompt(['tabs T2', 'status', 'tabs']);
  p.type('ta', UP);
  assert.equal(p.rl.line, 'tabs T2');
  p.type(UP);
  assert.equal(p.rl.line, 'tabs');
  p.close();
});

test('line keys act on the cursor\'s line', () => {
  const p = prompt();
  p.type('eval {{\r', 'abc\r', 'def', LEFT, '\x01');
  assert.equal(p.rl.cursor, 'eval {{\nabc\n'.length, 'Ctrl-A');
  p.type('\x05');
  assert.equal(p.rl.cursor, p.rl.line.length, 'Ctrl-E');
  p.type('\x15');
  assert.equal(p.rl.line, 'eval {{\nabc\n', 'Ctrl-U');
  p.type(UP, '\x01', '\x0b');
  assert.equal(p.rl.line, 'eval {{\n\n', 'Ctrl-K');
  p.editor.clear();
  assert.equal(p.rl.line, '');
  p.close();
});

test('lines after the first are drawn after the continuation prompt', () => {
  const p = prompt();
  p.type('eval {{\r', 'a', 'b');
  assert.match(p.drawn(), /> eval \{\{\r\n\.\.\. /);
  p.close();
});

test('an arrow that does nothing doesn\'t change what the next one does', () => {
  const p = prompt(['older']);
  p.type('eval {{\r', 'abc', DOWN, UP);
  assert.equal(p.rl.line, 'eval {{\nabc', 'Down on the last line, then Up moves a line');
  assert.equal(p.rl.cursor, 'eval'.length + 1);
  p.close();
  const q = prompt();
  q.type('eval {{\r', 'abc', UP, UP, DOWN);
  assert.equal(q.rl.cursor, 'eval {{\nabc'.length, 'Up with no older entry, then Down moves a line');
  q.close();
});

test('a buffer starting with a newline', () => {
  const p = prompt(['older']);
  p.type('\x1b\r', 'abc', UP);
  assert.equal(p.rl.cursor, 0);
  p.type(UP);
  assert.equal(p.rl.line, 'older');
  p.close();
  const q = prompt();
  q.type('\x1b\r', 'abc', UP, '\x15');
  assert.equal(q.rl.line, '\nabc', 'Ctrl-U at the start deletes nothing');
  q.close();
});

test('Up and Down keep to screen columns and whole characters', () => {
  const p = prompt();
  // Each emoji is two columns, and two UTF-16 units.
  p.type('eval {{\r', '😀😀x', '\x1b\r', 'abc');
  // Column 3 of the line is inside the second emoji: the cursor stops
  // before it.
  p.type(UP);
  assert.equal(p.rl.cursor, 'eval {{\n😀'.length);
  p.close();
});

test('an edited entry is kept as the draft, not lost by Down', () => {
  const p = prompt(['tabs T2']);
  p.type('ta', UP, ' more', DOWN);
  assert.equal(p.rl.line, 'tabs T2 more');
  p.close();
});

test('Shift-Up and Shift-Down move as Up and Down do', () => {
  const p = prompt(['older']);
  p.type('eval {{\r', 'abc', '\x1b[1;2A');
  assert.equal(p.rl.line, 'eval {{\nabc');
  // Column 7 on screen, past `> ev`.
  assert.equal(p.rl.cursor, 5);
  p.close();
});

test('Ctrl-U and Ctrl-K text comes back with Ctrl-Y', () => {
  const p = prompt();
  p.type('hello', '\x15');
  assert.equal(p.rl.line, '');
  p.type('\x19');
  assert.equal(p.rl.line, 'hello');
  p.type('eval {{\r', 'abc', '\x01', '\x0b', '\x19');
  assert.equal(p.rl.line, 'helloeval {{\nabc');
  p.close();
});

test('a wrapped paste leaves readline\'s record of the rows drawn right', () => {
  const p = prompt([], { columns: 20 });
  p.type('eval {{\r' + 'a long line that wraps around the narrow terminal twice');
  assert.equal(p.rl.prevRows, p.rl.getCursorPos().rows);
  assert.equal(p.rl.getCursorPos().rows, 3);
  p.close();
});

test('a buffer taller than the terminal is drawn as a window around the cursor', () => {
  const p = prompt([], { rows: 6 });
  p.type('eval {{\r');
  for (let i = 1; i <= 10; i++) p.type(`line ${i}\r`);
  // Five rows fit, one spare: the cursor is on the last.
  assert.equal(p.rl.getCursorPos().rows, 4);
  for (let i = 0; i < 11; i++) p.type(UP);
  assert.equal(p.rl.cursor, 2);
  assert.equal(p.rl.getCursorPos().rows, 0, 'scrolled to the top');
  assert.equal(p.rl.prevRows, 0);
  const before = p.drawn().length;
  for (let i = 0; i < 11; i++) p.type(DOWN);
  p.type('}}\r');
  assert.equal(p.sent.length, 1);
  // Sent, it is drawn whole, for the scrollback.
  assert.match(p.drawn().slice(before), /line 1\r\n[^]*line 10/);
  p.close();
});

test('Up and Down count a pasted tab to its tab stop on screen', () => {
  const p = prompt();
  // `... a\tbc`: the tab runs from column 5 to 8, so the cursor after c
  // is at column 10, not 14 as when tabs are counted from the line's
  // start.
  p.type('eval {{\r', 'xxxxxxxxxx\r', 'a\tbc', UP);
  assert.equal(p.rl.cursor, 'eval {{\nxxxxxx'.length);
  p.close();
});
