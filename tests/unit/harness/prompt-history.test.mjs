// Unit tests for src/harness/prompt-history.ts (compiled to
// lib/harness/prompt-history.js): the `--interactive` prompt's history
// file, shared by sessions that append to it.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { appendHistory, HISTORY_SIZE, historyFile, loadHistory } from '../../../lib/harness/prompt-history.js';

const dir = mkdtempSync(path.join(os.tmpdir(), 'sm-prompt-history-'));
after(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const fresh = () => path.join(dir, `history-${++n}`);

test('a missing file is no history', () => {
  assert.deepEqual(loadHistory(fresh()), []);
});

test('entries load newest first, a block as one entry', () => {
  const file = fresh();
  appendHistory(file, 'tabs');
  appendHistory(file, 'eval {{\nconst x = 1;\n\nx\n}}');
  assert.deepEqual(loadHistory(file), ['eval {{\nconst x = 1;\n\nx\n}}', 'tabs']);
});

test('two sessions open at once keep each other\'s entries', () => {
  const file = fresh();
  appendHistory(file, 'old');
  // Both load, then each appends in turn.
  assert.deepEqual(loadHistory(file), ['old']);
  assert.deepEqual(loadHistory(file), ['old']);
  appendHistory(file, 'first session');
  appendHistory(file, 'second session');
  appendHistory(file, 'first again');
  assert.deepEqual(loadHistory(file), ['first again', 'second session', 'first session', 'old']);
});

test('a line cut short is ended, so the next entry is kept', () => {
  const file = fresh();
  writeFileSync(file, '"a"\n"cut sh');
  assert.deepEqual(loadHistory(file), ['a']);
  appendHistory(file, 'b');
  assert.deepEqual(loadHistory(file), ['b', 'a']);
});

test('every write leaves the file readable only by its owner', () => {
  const mode = (file) => statSync(file).mode & 0o777;
  const made = fresh();
  appendHistory(made, 'a');
  assert.equal(mode(made), 0o600);
  const open = fresh();
  writeFileSync(open, '"a"', { mode: 0o644 });
  loadHistory(open);
  assert.equal(mode(open), 0o600);
  writeFileSync(open, '"a"\n', { mode: 0o644 });
  chmodSync(open, 0o644);
  appendHistory(open, 'b');
  assert.equal(mode(open), 0o600);
  const trimmed = fresh();
  writeFileSync(trimmed, '"a"\n'.repeat(2 * HISTORY_SIZE), { mode: 0o644 });
  loadHistory(trimmed);
  assert.equal(mode(trimmed), 0o600);
});

test('a damaged line and repeats in a row are skipped', () => {
  const file = fresh();
  writeFileSync(file, '"a"\n"b"\n"b"\n"c\n"d"\n');
  assert.deepEqual(loadHistory(file), ['d', 'b', 'a']);
});

test('loads the last HISTORY_SIZE entries, and cuts the file back at twice that', () => {
  const file = fresh();
  const many = (count) => Array.from({ length: count }, (_, i) => JSON.stringify(`c${i}`)).join('\n') + '\n';
  writeFileSync(file, many(2 * HISTORY_SIZE - 1));
  const loaded = loadHistory(file);
  assert.equal(loaded.length, HISTORY_SIZE);
  assert.equal(loaded[0], `c${2 * HISTORY_SIZE - 2}`);
  assert.equal(readFileSync(file, 'utf8').split('\n').length - 1, 2 * HISTORY_SIZE - 1);
  writeFileSync(file, many(2 * HISTORY_SIZE));
  loadHistory(file);
  const kept = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  assert.equal(kept.length, HISTORY_SIZE);
  assert.equal(kept.at(-1), JSON.stringify(`c${2 * HISTORY_SIZE - 1}`));
});

test('SM_DEV_HISTORY moves the file, and empty turns it off', () => {
  const saved = process.env.SM_DEV_HISTORY;
  try {
    delete process.env.SM_DEV_HISTORY;
    assert.equal(historyFile(), path.join(os.homedir(), '.sm-dev-history'));
    process.env.SM_DEV_HISTORY = '/x/h';
    assert.equal(historyFile(), '/x/h');
    process.env.SM_DEV_HISTORY = 'rel/h';
    assert.equal(historyFile(), path.resolve('rel/h'));
    process.env.SM_DEV_HISTORY = '';
    assert.equal(historyFile(), null);
  } finally {
    if (saved === undefined) delete process.env.SM_DEV_HISTORY;
    else process.env.SM_DEV_HISTORY = saved;
  }
});
