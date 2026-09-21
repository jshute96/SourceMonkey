// Tests for `onlyProbesChanged`, the predicate that decides whether a
// `script:*` write is allowed to skip `notifyChange` — and therefore
// skip a full unregister-all + register-all across every script.
//
// The two failure directions are wildly asymmetric, and only one of
// them is recoverable:
//
//   - Too CONSERVATIVE (say a probe-only write matters): a redundant
//     re-registration. Slow, which is the bug this predicate exists to
//     fix, but nothing runs the wrong code.
//   - Too EAGER (say a real change is probe-only): the change never
//     reaches Chrome's registration set. An edited script keeps running
//     its OLD body until something else happens to write its row. Silent
//     and indefinite.
//
// So most of what follows pins down the eager direction: every field
// that is not `versionProbes` must read as a change.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { onlyProbesChanged } from '../../dist/match-index.js';

const ROW = {
  id: 'a',
  collectionId: 'c',
  relativePath: 'a.user.js',
  fileUrl: 'file:///a.user.js',
  status: 'ok',
  enabled: true,
  loadedAt: 100,
  contentHash: 'h1',
  bodyText: 'console.log(1);',
  headerText: '// ==UserScript==\n// @name A\n// ==/UserScript==',
  matching: { matches: ['https://e.com/*'], excludes: [], includes: [] },
};

const probe = (version) => [{ kinds: ['update'], url: 'https://e/x.meta.js', checkedAt: 1, version }];

test('a write that moves only versionProbes is probe-only', () => {
  assert.equal(
    onlyProbesChanged({ ...ROW, versionProbes: probe('1.0') }, { ...ROW, versionProbes: probe('2.0') }),
    true,
  );
});

test('adding or clearing versionProbes is still probe-only', () => {
  // The two shapes `setVersionProbes` actually produces: a first probe
  // landing on a row that had none, and a row whose targets went away.
  assert.equal(onlyProbesChanged(ROW, { ...ROW, versionProbes: probe('2.0') }), true);
  assert.equal(onlyProbesChanged({ ...ROW, versionProbes: probe('2.0') }, ROW), true);
});

test('a byte-identical rewrite is probe-only (nothing moved at all)', () => {
  // Not a probe update, but the verdict is the same and for the same
  // reason: there is nothing for a re-registration to pick up.
  assert.equal(onlyProbesChanged(ROW, { ...ROW }), true);
});

// ---- the eager direction: these must all report a real change ----

test('a body edit is NOT probe-only', () => {
  // The regression that matters most. Body changes do not move `name`,
  // `matching`, or `enabled`, so a predicate written against the match
  // index's derived entry would wrongly call this unchanged and leave
  // the old body registered and running.
  assert.equal(
    onlyProbesChanged(ROW, { ...ROW, bodyText: 'console.log(2);', contentHash: 'h2' }),
    false,
  );
});

test('a body edit alongside a probe update is NOT probe-only', () => {
  assert.equal(
    onlyProbesChanged(
      { ...ROW, versionProbes: probe('1.0') },
      { ...ROW, bodyText: 'console.log(2);', versionProbes: probe('2.0') },
    ),
    false,
  );
});

test('enable / disable is NOT probe-only', () => {
  assert.equal(onlyProbesChanged(ROW, { ...ROW, enabled: false }), false);
});

test('a matching change is NOT probe-only', () => {
  assert.equal(
    onlyProbesChanged(ROW, {
      ...ROW,
      matching: { matches: ['https://other.com/*'], excludes: [], includes: [] },
    }),
    false,
  );
});

test('a status change is NOT probe-only', () => {
  // status gates whether the script is eligible for a spec at all.
  assert.equal(onlyProbesChanged(ROW, { ...ROW, status: 'invalid' }), false);
});

test('a @require body change is NOT probe-only', () => {
  // Requires are concatenated into the registered source, so a changed
  // dependency has to re-register even though the script's own row is
  // otherwise untouched.
  assert.equal(
    onlyProbesChanged(
      { ...ROW, requires: [{ url: 'u', contentHash: 'r1', source: 'var x=1;' }] },
      { ...ROW, requires: [{ url: 'u', contentHash: 'r2', source: 'var x=2;' }] },
    ),
    false,
  );
});

test('a headerText change is NOT probe-only', () => {
  // @grant / @run-at / @inject-into all live here and all change the spec.
  assert.equal(onlyProbesChanged(ROW, { ...ROW, headerText: '// @grant GM_setValue' }), false);
});

test('a creation or deletion is never probe-only', () => {
  // No prior row to have "only" changed one field of, and a deletion has
  // to reach the injector so the spec stops being registered.
  assert.equal(onlyProbesChanged(undefined, ROW), false);
  assert.equal(onlyProbesChanged(ROW, undefined), false);
  assert.equal(onlyProbesChanged(undefined, undefined), false);
});
