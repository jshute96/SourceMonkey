// Tests for src/diagnostic-location.ts (compiled to
// dist/diagnostic-location.js).
//
// This module is the shared vocabulary for "what's wrong, and where" —
// every content-derived verdict in the extension formats through it, so
// the phrasing here is what the sources page's hover text, the viewer's
// message bar, the install preview's warning and the Log tab all say.
// The interesting behaviour is what it does with a PARTIAL location,
// because the producers genuinely differ in how much they know.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  describeDiagnostic,
  locationLabel,
  validLocation,
} from '../../dist/diagnostic-location.js';

test('locationLabel grows with what the producer knew', () => {
  // The parse check's shape: V8 reports both coordinates.
  assert.equal(
    locationLabel({ file: 'my.user.js', line: 12, column: 5 }),
    'my.user.js, line 12, column 5',
  );
  // A header diagnostic's shape: a line, and no meaningful column.
  assert.equal(locationLabel({ file: 'my.user.js', line: 12 }), 'my.user.js, line 12');
  // `no metadata block`: the whole file is the answer.
  assert.equal(locationLabel({ file: 'my.user.js' }), 'my.user.js');
});

test('locationLabel drops a column that has no line to sit on', () => {
  // A column without a line points nowhere, so it is not rendered even
  // when a caller supplies one.
  assert.equal(locationLabel({ file: 'a.js', column: 4 }), 'a.js');
});

test('describeDiagnostic is the message alone when there is nowhere to point', () => {
  assert.equal(describeDiagnostic('fetch failed', undefined), 'fetch failed');
});

test('describeDiagnostic wraps the label in the shared phrasing', () => {
  assert.equal(
    describeDiagnostic("Unexpected token ';'", {
      file: 'https://cdn.example/lib.js',
      line: 2,
      column: 31,
    }),
    "Unexpected token ';' (in https://cdn.example/lib.js, line 2, column 31)",
  );
  assert.equal(
    describeDiagnostic('missing @name', { file: 'a.user.js', line: 1 }),
    'missing @name (in a.user.js, line 1)',
  );
});

test('validLocation rejects anything that names no file', () => {
  for (const bad of [undefined, {}, { file: '' }, { file: 42 }, { line: 3 }]) {
    assert.equal(validLocation(bad), undefined, `expected undefined for ${JSON.stringify(bad)}`);
  }
});

test('validLocation rejects a line that is not a line', () => {
  // A caller that MEANT to supply a line and got it wrong is a bug we
  // want visible as "no location" rather than as a jump to line 0 — so
  // the whole location is dropped, not just the bad field.
  for (const line of [0, -1, 1.5, NaN, Infinity, '3']) {
    assert.equal(
      validLocation({ file: 'a.js', line }),
      undefined,
      `expected undefined for line ${String(line)}`,
    );
  }
});

test('validLocation keeps a file-only location', () => {
  assert.deepEqual(validLocation({ file: 'a.js' }), { file: 'a.js' });
  // An explicitly-absent line is not a malformed one.
  assert.deepEqual(validLocation({ file: 'a.js', line: undefined }), { file: 'a.js' });
});

test('validLocation drops a bad column but keeps the line', () => {
  // Asymmetric with `line` on purpose: the line is what gets the reader
  // to the right place, and the column is only an accent on top of it.
  // Losing the accent is not worth losing the jump.
  assert.deepEqual(validLocation({ file: 'a.js', line: 4, column: 0 }), { file: 'a.js', line: 4 });
  assert.deepEqual(validLocation({ file: 'a.js', line: 4, column: NaN }), { file: 'a.js', line: 4 });
  assert.deepEqual(
    validLocation({ file: 'a.js', line: 4, column: 9 }),
    { file: 'a.js', line: 4, column: 9 },
  );
});

test('validLocation drops a column with no line, rather than keeping a half-place', () => {
  assert.deepEqual(validLocation({ file: 'a.js', column: 9 }), { file: 'a.js' });
});

test('validLocation returns a fresh object, not the caller\'s', () => {
  // These come off persisted rows and out of postMessage payloads, and
  // are handed to UI code that holds onto them. Copying keeps an extra
  // field on the input from riding along into storage or the DOM.
  const input = { file: 'a.js', line: 2, column: 3, extra: 'nope' };
  const out = validLocation(input);
  assert.deepEqual(out, { file: 'a.js', line: 2, column: 3 });
  assert.notEqual(out, input);
});
