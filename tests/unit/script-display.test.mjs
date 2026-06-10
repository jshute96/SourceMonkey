// Tests for src/script-display.ts (compiled to dist/script-display.js).
//
// Pure display helpers shared by the sources page + userscript viewer.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  effectiveScriptStatus,
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
  assert.equal(formatScriptSize({ status: 'invalid', size: null }), '—');
  assert.equal(formatScriptSize({ status: 'missing', size: null }), '—');
});

test('formatScriptSize: ok status renders the byte count', () => {
  assert.equal(formatScriptSize({ status: 'ok', size: 1234 }), '1.2 KB');
});

test('formatScriptSize: zero-byte file renders "0 B", not MISSING', () => {
  // An empty file is a real (if degenerate) file — it parses to a
  // header-less error, but the size cell should show "0 B" so the
  // user can see it's not missing.
  assert.equal(formatScriptSize({ status: 'invalid', size: 0 }), '0 B');
  assert.equal(formatScriptSize({ status: 'ok', size: 0 }), '0 B');
});

test('formatScriptSize: error with known size still renders the bytes', () => {
  // Errored fetches preserve the prior size; show it so the user can
  // see the row didn't vanish.
  assert.equal(formatScriptSize({ status: 'invalid', size: 500 }), '500 B');
});

// ---------- formatScriptStatusLabel ----------

test('formatScriptStatusLabel: distinct labels per display status', () => {
  // OK is the calm state; INVALID and MISSING are the persisted load
  // failures; REFRESH FAILED means the script still runs from its cached
  // copy but the last update attempt failed; WARNING and ERROR come from
  // the per-script Log carrying entries at that level.
  assert.equal(formatScriptStatusLabel('ok'), 'OK');
  assert.equal(formatScriptStatusLabel('invalid'), 'INVALID');
  assert.equal(formatScriptStatusLabel('missing'), 'MISSING');
  assert.equal(formatScriptStatusLabel('refresh-failed'), 'REFRESH FAILED');
  assert.equal(formatScriptStatusLabel('warning'), 'WARNING');
  assert.equal(formatScriptStatusLabel('error'), 'ERROR');
});

// ---------- effectiveScriptStatus ----------

test('effectiveScriptStatus: invalid always wins', () => {
  // INVALID is the most-actionable surface: the script literally
  // can't run, so we don't surface log-derived levels alongside it.
  assert.equal(effectiveScriptStatus({ status: 'invalid' }, undefined), 'invalid');
  assert.equal(effectiveScriptStatus({ status: 'invalid' }, 'info'), 'invalid');
  assert.equal(effectiveScriptStatus({ status: 'invalid' }, 'warning'), 'invalid');
  assert.equal(effectiveScriptStatus({ status: 'invalid' }, 'error'), 'invalid');
});

test('effectiveScriptStatus: missing wins over log-derived levels', () => {
  assert.equal(effectiveScriptStatus({ status: 'missing' }, undefined), 'missing');
  assert.equal(effectiveScriptStatus({ status: 'missing' }, 'warning'), 'missing');
  assert.equal(effectiveScriptStatus({ status: 'missing' }, 'error'), 'missing');
});

test('effectiveScriptStatus: ok script reflects highest log level', () => {
  assert.equal(effectiveScriptStatus({ status: 'ok' }, undefined), 'ok');
  // info collapses to OK (we still track it internally, but the Status
  // column only ramps when there's something actionable).
  assert.equal(effectiveScriptStatus({ status: 'ok' }, 'info'), 'ok');
  assert.equal(effectiveScriptStatus({ status: 'ok' }, 'warning'), 'warning');
  assert.equal(effectiveScriptStatus({ status: 'ok' }, 'error'), 'error');
});

test('effectiveScriptStatus: refreshError surfaces as refresh-failed', () => {
  // A row that's still `ok` (running from its cached copy) but carries a
  // refreshError shows REFRESH FAILED. It ranks above the log-derived
  // levels — the staleness is a distinct, specific signal — but below
  // invalid/missing, which mean the script can't run at all.
  assert.equal(
    effectiveScriptStatus({ status: 'ok', refreshError: 'permission denied' }, undefined),
    'refresh-failed',
  );
  assert.equal(
    effectiveScriptStatus({ status: 'ok', refreshError: 'permission denied' }, 'error'),
    'refresh-failed',
  );
  // invalid / missing still win — the script genuinely can't run.
  assert.equal(
    effectiveScriptStatus({ status: 'invalid', refreshError: 'x' }, undefined),
    'invalid',
  );
  assert.equal(
    effectiveScriptStatus({ status: 'missing', refreshError: 'x' }, undefined),
    'missing',
  );
});
