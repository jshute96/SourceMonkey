// Tests for src/script-display.ts (compiled to dist/script-display.js).
//
// Pure display helpers shared by the options page + userscript viewer.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  formatBytes,
  formatScriptSize,
  formatScriptStatusLabel,
} from '../../dist/script-display.js';

// ---------- formatBytes ----------

test('formatBytes: bytes under 1 KB', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1), '1 B');
  assert.equal(formatBytes(1023), '1023 B');
});

test('formatBytes: kilobytes 1 KB through < 1 MB, one decimal', () => {
  assert.equal(formatBytes(1024), '1.0 KB');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(1024 * 1024 - 1), '1024.0 KB');
});

test('formatBytes: megabytes >= 1 MB, one decimal', () => {
  assert.equal(formatBytes(1024 * 1024), '1.0 MB');
  assert.equal(formatBytes(2 * 1024 * 1024 + 512 * 1024), '2.5 MB');
});

// ---------- formatScriptSize ----------

test('formatScriptSize: missing status shows the cached content size', () => {
  // The file is gone but we still hold its last-read bytes; reflect
  // that in the size column. The Status cell (separately) shows MISSING.
  assert.equal(formatScriptSize({ status: 'missing', size: 100 }), '100 B');
});

test('formatScriptSize: null size → "—" (unknown)', () => {
  // Only buildInitialErrorEntry produces size=null — the first fetch
  // failed with no prior content to fall back on. Render an em dash
  // rather than "0 B" (wrong) or "MISSING" (conflates with the missing
  // status).
  assert.equal(formatScriptSize({ status: 'error', size: null }), '—');
  assert.equal(formatScriptSize({ status: 'missing', size: null }), '—');
});

test('formatScriptSize: ok status renders the byte count', () => {
  assert.equal(formatScriptSize({ status: 'ok', size: 1234 }), '1.2 KB');
});

test('formatScriptSize: zero-byte file renders "0 B", not MISSING', () => {
  // An empty file is a real (if degenerate) file — it parses to a
  // header-less error, but the size cell should show "0 B" so the
  // user can see it's not missing.
  assert.equal(formatScriptSize({ status: 'error', size: 0 }), '0 B');
  assert.equal(formatScriptSize({ status: 'ok', size: 0 }), '0 B');
});

test('formatScriptSize: error with known size still renders the bytes', () => {
  // Errored fetches preserve the prior size; show it so the user can
  // see the row didn't vanish.
  assert.equal(formatScriptSize({ status: 'error', size: 500 }), '500 B');
});

// ---------- formatScriptStatusLabel ----------

test('formatScriptStatusLabel: distinct labels per status', () => {
  // Before the fix, missing scripts rendered "ERROR" while their size
  // cell rendered "MISSING" — visibly inconsistent.
  assert.equal(formatScriptStatusLabel('ok'), 'OK');
  assert.equal(formatScriptStatusLabel('error'), 'ERROR');
  assert.equal(formatScriptStatusLabel('missing'), 'MISSING');
});
