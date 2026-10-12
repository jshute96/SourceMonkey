// Unit tests for src/harness/run-logs.ts (compiled to
// lib/harness/run-logs.js): a run's log lines, their sources, positions
// and how they read.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_LOG_SOURCES, inSources, logsLines, parseLogSources, parsePosition, parseTail, RunLog, shortConsoleText, streamText, textMatcher, timeOfDay,
} from '../../../lib/harness/run-logs.js';
import { plainLine } from '../../../lib/harness/output-style.js';

test('--log-source takes a comma list, or all', () => {
  assert.deepEqual([...parseLogSources('sm,page')], ['sm', 'page']);
  assert.deepEqual([...parseLogSources('all')], ['sm', 'event', 'script', 'page']);
  assert.deepEqual(parseLogSources('sm,pages'), { error: 'The --log-source flag takes sm, event, script, page or all, or multiple separated by commas, not pages' });
  assert.equal('error' in parseLogSources(''), true);
  assert.deepEqual([...DEFAULT_LOG_SOURCES], ['sm', 'event', 'script']);
});

test('a line is in its own source and any it also belongs to', () => {
  const threw = { source: 'event', also: ['sm', 'script'], kind: 'threw', text: 'X threw: boom' };
  for (const source of ['sm', 'event', 'script']) assert.ok(inSources(threw, new Set([source])), source);
  assert.ok(!inSources(threw, new Set(['page'])));
  assert.ok(inSources({ source: 'page', kind: 'log', text: 'hi' }, new Set(['page'])));
  // Shown under its first source's prefix.
  assert.equal(streamText(threw), '[event] X threw: boom');
});

test('log IDs are unique and increasing, and lines can be read from a position', () => {
  const log = new RunLog();
  const a = log.add({ source: 'script', kind: 'log', tab: 1, text: 'a' });
  const b = log.add({ source: 'script', kind: 'log', tab: 1, text: 'b' });
  assert.ok(b.id > a.id);
  assert.deepEqual(log.since(a.id).map((r) => r.text), ['b']);
  assert.equal(log.position(), b.id);
  assert.equal(log.lostAfter(0), undefined);
});

test('a log with no lines yet is at now, and lines after it come later', () => {
  const log = new RunLog();
  const at = log.position();
  assert.ok(Math.abs(at - Date.now() * 1000) < 5e6);
  assert.ok(log.add({ source: 'event', kind: 'load', text: 'x' }).id > at);
});

test('the oldest lines go past a cap, and a read from before them says so', () => {
  const log = new RunLog();
  const first = log.add({ source: 'page', kind: 'log', text: '0' });
  for (let i = 1; i <= 5000; i++) log.add({ source: 'page', kind: 'log', text: String(i) });
  assert.equal(log.all().length, 5000);
  assert.equal(log.all()[0].text, '1');
  assert.equal(log.lostAfter(first.id - 1), log.all()[0].id);
  assert.equal(log.lostAfter(first.id), undefined);
});

test('--since takes a log ID, an ISO 8601 time, or a time of day', () => {
  assert.equal(parsePosition('1759512345678901'), 1759512345678901);
  assert.equal(parsePosition('2026-10-03T14:05:12.345Z'), Date.parse('2026-10-03T14:05:12.345Z') * 1000);
  const now = new Date(2026, 9, 3, 20, 0, 0);
  assert.equal(parsePosition('14:05:12.5', now), new Date(2026, 9, 3, 14, 5, 12).getTime() * 1000 + 500000);
  assert.equal(parsePosition('14:05', now), new Date(2026, 9, 3, 14, 5, 0).getTime() * 1000);
  assert.match(parsePosition('soon').error, /^The --since flag takes a log ID/);
  assert.match(parsePosition('25:00').error, /^The --since flag takes/);
});

test('--tail takes a number of lines or a time', () => {
  assert.deepEqual(parseTail('50'), { lines: 50 });
  assert.deepEqual(parseTail('30s'), { micros: 30e6 });
  assert.deepEqual(parseTail('5m'), { micros: 300e6 });
  assert.deepEqual(parseTail('500ms'), { micros: 500e3 });
  assert.match(parseTail('0').error, /^The --tail flag takes/);
});

test('text to find is a substring, or a /regex/', () => {
  const plain = textMatcher('a.b');
  assert.equal(plain.matches('xa.by'), true);
  assert.equal(plain.matches('axb'), false);
  const regex = textMatcher('/a.b/g');
  assert.equal(regex.matches('axb'), true);
  assert.equal(regex.matches('axb'), true);
  assert.match(textMatcher('/(/').error, /^\/\(\/ is not a valid regular expression for --find/);
});

test('lines read with their source, and their tab after T1', () => {
  assert.equal(streamText({ source: 'script', kind: 'log', tab: 1, text: 'hi' }), '[script log] hi');
  assert.equal(streamText({ source: 'page', kind: 'warning', tab: 2, text: 'x' }), '[T2] [page warning] x');
  assert.equal(streamText({ source: 'event', kind: 'started', tab: 1, text: 'A started on u' }), '[event] A started on u');
  // An iframe's line names its frame, on T1 too.
  assert.equal(streamText({ source: 'event', kind: 'started', tab: 1, frame: 3, text: 'A started in an iframe on u' }), '[T1.F3] [event] A started in an iframe on u');
  assert.equal(streamText({ source: 'sm', kind: 'error', text: 'A: no' }), '[sm error] A: no');
  // Long console lines are cut in the stream, but not when whole.
  const long = { source: 'script', kind: 'log', tab: 1, text: 'x'.repeat(1500) };
  assert.match(streamText(long), /\.\.\. \(1500 chars; logs shows it all\)$/);
  assert.equal(streamText(long, true).length, '[script log] '.length + 1500);
});

test('logs prints the time and tab, and each run of identical lines once', () => {
  const at = new Date(2026, 9, 3, 14, 5, 12, 345).getTime() * 1000;
  const records = [
    { id: at, source: 'event', kind: 'started', tab: 1, text: 'A started' },
    { id: at + 1, source: 'script', kind: 'log', tab: 1, text: 'tick' },
    { id: at + 2, source: 'script', kind: 'log', tab: 1, text: 'tick' },
    { id: at + 3, source: 'sm', kind: 'error', text: 'A: no' },
    { id: at + 4, source: 'page', kind: 'log', tab: 12, text: 'x' },
  ];
  assert.deepEqual(logsLines(records).map(plainLine), [
    '14:05:12.345 T1  [event] A started',
    '14:05:12.345 T1  [script log] tick (2 times)',
    '14:05:12.345     [sm error] A: no',
    '14:05:12.345 T12 [page log] x',
  ]);
  assert.equal(timeOfDay(at), '14:05:12.345');
  assert.deepEqual(logsLines([{ id: at, source: 'sm', kind: 'info', text: 'A: ok' }]).map(plainLine), ['14:05:12.345 [sm info] A: ok']);
  // A script's own text keeps its backticks, error or not.
  assert.deepEqual(logsLines([{ id: at, source: 'script', kind: 'error', text: 'bad `42` and `--x`' }]).map(plainLine), ['14:05:12.345 [script error] bad `42` and `--x`']);
  // An iframe's line: its tab and frame.
  assert.deepEqual(logsLines([records[0], { id: at + 5, source: 'event', kind: 'started', tab: 1, frame: 4, text: 'A started' }]).map(plainLine), [
    '14:05:12.345 T1    [event] A started',
    '14:05:12.345 T1.F4 [event] A started',
  ]);
});

test('the stream cuts a long console line, with its length', () => {
  assert.equal(shortConsoleText('short'), 'short');
  const long = 'x'.repeat(1500);
  assert.equal(shortConsoleText(long), `${'x'.repeat(1000)}... (1500 chars; logs shows it all)`);
});

test('a line past what logs keeps says so, and is cut whole characters', () => {
  assert.match(shortConsoleText('x'.repeat(3000)), /\(3000 chars; logs shows the first 2000\)$/);
  // An emoji straddling the cut is left out, not halved.
  const record = new RunLog().add({ source: 'page', kind: 'log', text: `${'x'.repeat(1999)}😀tail` });
  assert.equal(record.text, `${'x'.repeat(1999)}…`);
});
