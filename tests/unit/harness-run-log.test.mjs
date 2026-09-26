// Unit tests for a run's log files
// (src/harness/run-log.ts, compiled to lib/harness/).

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.TZ = 'UTC';
const DIR = mkdtempSync(path.join(os.tmpdir(), 'sm-dev-logs-test-'));
process.env.SM_DEV_LOGS_DIR = DIR;
after(() => rmSync(DIR, { recursive: true, force: true }));

const { createRunLog, logTimestamp, LOG_LINE_PREFIX, openRunLog } = await import('../../lib/harness/run-log.js');

test('logTimestamp is local time down to the millisecond', () => {
  assert.equal(logTimestamp(Date.UTC(2026, 3, 8, 20, 30, 12, 345)), '20260408-203012-345');
  assert.match(`${logTimestamp()} line`, LOG_LINE_PREFIX);
});

test('createRunLog names each file by its time, and never reuses one', async () => {
  const made = await Promise.all([createRunLog(), createRunLog(), createRunLog()]);
  for (const { handle } of made) await handle.close();
  const names = made.map((m) => path.basename(m.file));
  for (const name of names) assert.match(name, /^sm-dev-\d{8}-\d{6}-\d{3}\.log$/);
  assert.equal(new Set(names).size, names.length);
  assert.ok(made.every((m) => path.dirname(m.file) === DIR));
});

test('openRunLog stamps each line it copies, and nothing after close', async () => {
  const log = await openRunLog();
  log.write('first');
  log.write('two\nlines');
  log.write('');
  await log.close();
  log.write('too late');
  const lines = readFileSync(log.file, 'utf8').split('\n');
  assert.deepEqual(lines.map((l) => l.replace(LOG_LINE_PREFIX, '')), ['first', 'two', 'lines', '', '']);
  assert.match(lines[0], LOG_LINE_PREFIX);
  // An empty line unstamped, as in a detached run's log.
  assert.equal(lines[3], '');
});
