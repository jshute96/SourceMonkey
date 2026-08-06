// Unit tests for the shared log formatting in src/log-format.ts —
// the cell strings the Log pane renders and the CSV its Save / Copy
// buttons hand out.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  csvField,
  foldToOneLine,
  formatLogCsv,
  formatLogSource,
  formatLogTimestamp,
  logFileName,
} from '../../dist/log-format.js';

// Local time, so build the expectation from a local-time Date rather
// than from a fixed UTC string.
const AT = new Date(2026, 7, 5, 14, 3, 22, 17).getTime();
const AT_TEXT = '2026-08-05 14:03:22.017';

function entry(over = {}) {
  return { timestamp: AT, level: 'info', source: 'manual-refresh', message: 'Loaded', ...over };
}

test('formatLogTimestamp: zero-pads every field', () => {
  assert.equal(formatLogTimestamp(AT), AT_TEXT);
  assert.equal(formatLogTimestamp(new Date(2026, 0, 2, 3, 4, 5, 6).getTime()),
    '2026-01-02 03:04:05.006');
});

test('formatLogSource: tab-scoped entries name their tab', () => {
  assert.equal(formatLogSource(entry()), 'manual-refresh');
  assert.equal(formatLogSource(entry({ source: 'script-wrapper', tabId: 17 })),
    'tab 17 · script-wrapper');
});

test('csvField: leaves an unambiguous value bare', () => {
  assert.equal(csvField('info'), 'info');
  assert.equal(csvField('script-wrapper'), 'script-wrapper');
  assert.equal(csvField(''), '');
});

test('csvField: quotes on separator, space and quote', () => {
  assert.equal(csvField('a,b'), '"a,b"');
  assert.equal(csvField('two words'), '"two words"');
  assert.equal(csvField(' leading'), '" leading"');
  assert.equal(csvField('say "hi"'), '"say ""hi"""');
});

test('foldToOneLine: folds a value onto one line, reversibly', () => {
  assert.equal(foldToOneLine('line1\nline2'), 'line1\\nline2');
  assert.equal(foldToOneLine('a\r\nb'), 'a\\r\\nb');
  // Backslash first, so a literal `\n` in the text and a real newline
  // don't decode back to the same string.
  assert.equal(foldToOneLine('C:\\temp'), 'C:\\\\temp');
  assert.equal(foldToOneLine('a\\nb'), 'a\\\\nb');
});

test('foldToOneLine: leaves a value with nothing to fold alone', () => {
  assert.equal(foldToOneLine('plain text'), 'plain text');
});

test('formatLogCsv: header row, newest entry first', () => {
  const rows = formatLogCsv([
    entry({ timestamp: AT, message: 'first' }),
    entry({ timestamp: AT + 1000, message: 'second' }),
  ]).split('\n');
  assert.equal(rows[0], 'Time,Level,Source,Message');
  assert.match(rows[1], /,second$/);
  assert.match(rows[2], /,first$/);
  // Trailing newline: the last element is the empty tail of the split.
  assert.equal(rows[3], '');
});

test('formatLogCsv: an empty log is just the header row', () => {
  assert.equal(formatLogCsv([]), 'Time,Level,Source,Message\n');
});

test('formatLogCsv: cells match what the pane renders', () => {
  const [, row] = formatLogCsv([
    entry({ level: 'error', source: 'script-wrapper', tabId: 4, message: 'Boom, it broke' }),
  ]).split('\n');
  assert.equal(row, `"${AT_TEXT}",error,"tab 4 · script-wrapper","Boom, it broke"`);
});

test('formatLogCsv: a stack trace is one line, so line tools still work', () => {
  const rows = formatLogCsv([
    entry({ level: 'error', message: 'Error: boom\n    at f (main.user.js:3:9)' }),
  ]).split('\n');
  // Header + the one entry + the trailing newline's empty tail: a
  // multi-frame trace must not add lines of its own.
  assert.equal(rows.length, 3);
  assert.equal(rows[0], 'Time,Level,Source,Message');
  assert.equal(
    rows[1],
    `"${AT_TEXT}",error,manual-refresh,"Error: boom\\n    at f (main.user.js:3:9)"`,
  );
});

test('formatLogCsv: the caller can supply its own Message renderer', () => {
  // The viewer passes the renderer behind its own table, which resolves
  // stack refs the pure default can't see.
  const [, row] = formatLogCsv(
    [entry({ message: 'generated' })],
    (e) => `resolved:${e.message}`,
  ).split('\n');
  assert.match(row, /,resolved:generated$/);
});

test('formatLogCsv: a derived location is flattened into the message', () => {
  const [, row] = formatLogCsv([
    entry({
      level: 'error',
      source: 'parser',
      message: 'Unexpected token',
      location: { file: 'a.user.js', line: 12, column: 5 },
    }),
  ]).split('\n');
  assert.match(row, /"Unexpected token \(in a\.user\.js, line 12, column 5\)"$/);
});

test('logFileName: swaps the userscript extension for .log', () => {
  assert.equal(logFileName('bold-on-hover.user.js'), 'bold-on-hover.log');
  assert.equal(logFileName('helper.js'), 'helper.log');
  assert.equal(logFileName('notes.txt'), 'notes.txt.log');
});

test('logFileName: strips the extension once, not twice', () => {
  // `.js` here is part of the name, not a second extension.
  assert.equal(logFileName('bar.js.user.js'), 'bar.js.log');
});

test('logFileName: a literal # in the name is not read as a dupe suffix', () => {
  assert.equal(logFileName('Chapter #2.user.js'), 'Chapter #2.log');
});

test('logFileName: control characters never reach the filename', () => {
  assert.equal(logFileName('a\u0000b\u001fc.user.js'), 'a_b_c.log');
});

test('logFileName: keeps the dedup suffix so dupes differ', () => {
  assert.equal(logFileName('bold-on-hover.user.js#2'), 'bold-on-hover#2.log');
});

test('logFileName: falls back when there is no label', () => {
  assert.equal(logFileName(''), 'script.log');
  assert.equal(logFileName('  '), 'script.log');
  assert.equal(logFileName('.user.js'), 'script.log');
});
