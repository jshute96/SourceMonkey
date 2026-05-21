// Tests for src/tab-status.ts (compiled to dist/tab-status.js).
//
// The module owns the pure helpers behind the per-tab toolbar badge:
// classifying each expected/actual script into OK/ERROR/MISSING/
// UNEXPECTED, picking the badge color, and merging incoming wrapper
// reports.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyScriptReport,
  clearScriptStale,
  computeBadge,
  getCurrentState,
  getDocState,
  markScriptStale,
  mergeMatches,
  setCurrentDoc,
  writeDocState,
  BADGE_GREEN,
  BADGE_ORANGE,
  BADGE_PURPLE,
  BADGE_RED,
  MAX_DOCS_PER_TAB,
} from '../../dist/tab-status.js';

// Shared default — the tests below don't care about documentId, they
// just need the state shape to be valid.
const DOC = 'doc-1';

function expected(id, name = id) {
  return {
    id,
    name,
    sourceId: 'src-1',
    matching: { matches: [], excludes: [], includes: [] },
  };
}

// ---------- computeBadge: classification ----------

test('computeBadge: expected + started → OK, GREEN', () => {
  const view = computeBadge({
    documentId: DOC, url: 'https://x',
    matches: [expected('a', 'Alpha'), expected('b', 'Beta')],
    actual: {
      a: { state: 'started', name: 'Alpha' },
      b: { state: 'started', name: 'Beta' },
    },
  });
  assert.equal(view.count, 2);
  assert.equal(view.color, BADGE_GREEN);
  assert.deepEqual(view.rows.map((r) => `${r.name}|${r.status}`), [
    'Alpha|OK',
    'Beta|OK',
  ]);
});

test('computeBadge: expected but no report → MISSING, ORANGE', () => {
  const view = computeBadge({
    documentId: DOC, url: 'https://x',
    matches: [expected('a', 'Alpha'), expected('b', 'Beta')],
    actual: { a: { state: 'started', name: 'Alpha' } },
  });
  assert.equal(view.count, 2);
  assert.equal(view.color, BADGE_ORANGE);
  const beta = view.rows.find((r) => r.name === 'Beta');
  assert.equal(beta.status, 'MISSING');
});

test('computeBadge: actual without expected → UNEXPECTED, ORANGE', () => {
  const view = computeBadge({
    documentId: DOC, url: 'https://x',
    matches: [expected('a', 'Alpha')],
    actual: {
      a: { state: 'started', name: 'Alpha' },
      z: { state: 'started', name: 'Surprise' },
    },
  });
  assert.equal(view.count, 2);
  assert.equal(view.color, BADGE_ORANGE);
  const surprise = view.rows.find((r) => r.name === 'Surprise');
  assert.equal(surprise.status, 'UNEXPECTED');
});

test('computeBadge: any ERROR forces RED, even with MISSING/UNEXPECTED', () => {
  const view = computeBadge({
    documentId: DOC, url: 'https://x',
    matches: [expected('a', 'Alpha'), expected('b', 'Beta')],
    actual: {
      a: { state: 'error', name: 'Alpha', message: 'boom' },
      // b is MISSING — but ERROR wins.
    },
  });
  assert.equal(view.color, BADGE_RED);
  const alpha = view.rows.find((r) => r.name === 'Alpha');
  assert.equal(alpha.status, 'ERROR');
  assert.equal(alpha.message, 'boom');
});

test('computeBadge: ERROR overrides expected/unexpected classification', () => {
  // An UNEXPECTED script that errored should still surface as ERROR
  // (the error matters more than whether we expected it).
  const view = computeBadge({
    documentId: DOC, url: 'https://x',
    matches: [],
    actual: { z: { state: 'error', name: 'Surprise', message: 'oops' } },
  });
  assert.equal(view.color, BADGE_RED);
  assert.equal(view.rows[0].status, 'ERROR');
});

test('computeBadge: empty state → count 0, GREEN, just header in title', () => {
  const view = computeBadge({ documentId: DOC, url: 'https://x', matches: [], actual: {} });
  assert.equal(view.count, 0);
  assert.equal(view.color, BADGE_GREEN);
  assert.equal(view.title, 'SourceMonkey');
});

test('computeBadge: rows sorted by name; tooltip is "NAME | STATUS" per row', () => {
  const view = computeBadge({
    documentId: DOC, url: 'https://x',
    matches: [expected('c', 'Charlie'), expected('a', 'Alpha')],
    actual: {
      c: { state: 'started', name: 'Charlie' },
      // a missing
      b: { state: 'error', name: 'Bravo', message: 'x' },
    },
  });
  assert.deepEqual(view.title.split('\n'), [
    'SourceMonkey',
    'Alpha | MISSING',
    'Bravo | ERROR',
    'Charlie | OK',
  ]);
});

test('computeBadge: prefers actual-side name over expected-side', () => {
  // The wrapper's reported name reflects what's actually running; use
  // it in preference to a possibly-stale name from the cache.
  const view = computeBadge({
    documentId: DOC, url: 'https://x',
    matches: [expected('a', 'OldName')],
    actual: { a: { state: 'started', name: 'NewName' } },
  });
  assert.equal(view.rows[0].name, 'NewName');
});

// ---------- computeBadge: RELOAD / PURPLE ----------

test('computeBadge: started + stale → RELOAD, PURPLE, tooltip says "Reload to update"', () => {
  const view = computeBadge({
    documentId: DOC, url: 'https://x',
    matches: [expected('a', 'Alpha'), expected('b', 'Beta')],
    actual: {
      a: { state: 'started', name: 'Alpha' },
      b: { state: 'started', name: 'Beta' },
    },
    staleScriptIds: ['a'],
  });
  assert.equal(view.color, BADGE_PURPLE);
  const alpha = view.rows.find((r) => r.name === 'Alpha');
  assert.equal(alpha.status, 'RELOAD');
  // The tooltip surfaces the verbose label, not the raw enum value.
  assert.ok(view.title.includes('Alpha | Reload to update'), view.title);
  assert.ok(view.title.includes('Beta | OK'), view.title);
});

test('computeBadge: non-stale ERROR still beats RELOAD for color', () => {
  // Beta errored and its file on disk has NOT changed → row stays ERROR,
  // badge stays RED. Stale alpha is still RELOAD on its row but RED
  // wins for the overall color.
  const view = computeBadge({
    documentId: DOC, url: 'https://x',
    matches: [expected('a', 'Alpha'), expected('b', 'Beta')],
    actual: {
      a: { state: 'started', name: 'Alpha' },
      b: { state: 'error', name: 'Beta', message: 'boom' },
    },
    staleScriptIds: ['a'],
  });
  assert.equal(view.color, BADGE_RED);
  const alpha = view.rows.find((r) => r.name === 'Alpha');
  assert.equal(alpha.status, 'RELOAD');
  const beta = view.rows.find((r) => r.name === 'Beta');
  assert.equal(beta.status, 'ERROR');
});

test('computeBadge: stale ERROR row becomes RELOAD', () => {
  // The error was from outdated content; the user's fix on disk may
  // address it. We don't keep showing red — purple/Reload to update is
  // the more actionable signal.
  const view = computeBadge({
    documentId: DOC, url: 'https://x',
    matches: [expected('a', 'Alpha')],
    actual: { a: { state: 'error', name: 'Alpha', message: 'boom' } },
    staleScriptIds: ['a'],
  });
  assert.equal(view.color, BADGE_PURPLE);
  assert.equal(view.rows[0].status, 'RELOAD');
});

test('computeBadge: stale id with no started report → not RELOAD (only running code reloads)', () => {
  // The wrapper hasn't reported for `a` yet, so there is no "running
  // code" to flag. The row stays MISSING; no RELOAD/purple.
  const view = computeBadge({
    documentId: DOC, url: 'https://x',
    matches: [expected('a', 'Alpha')],
    actual: {},
    staleScriptIds: ['a'],
  });
  assert.equal(view.color, BADGE_ORANGE);
  assert.equal(view.rows[0].status, 'MISSING');
});

// ---------- markScriptStale ----------

test('markScriptStale: marks a started script as stale', () => {
  const state = {
    documentId: DOC, url: 'https://x', matches: [],
    actual: { a: { state: 'started', name: 'A' } },
  };
  const next = markScriptStale(state, 'a');
  assert.deepEqual(next.staleScriptIds, ['a']);
  assert.notEqual(next, state);
});

test('markScriptStale: no-op when the script never reported started', () => {
  const state = { documentId: DOC, url: 'https://x', matches: [], actual: {} };
  const next = markScriptStale(state, 'a');
  // Same object back — callers can cheap-test for "nothing to write".
  assert.equal(next, state);
});

test('markScriptStale: no-op when already stale', () => {
  const state = {
    documentId: DOC, url: 'https://x', matches: [],
    actual: { a: { state: 'started', name: 'A' } },
    staleScriptIds: ['a'],
  };
  const next = markScriptStale(state, 'a');
  assert.equal(next, state);
});

test('markScriptStale: an errored script also becomes stale (RELOAD wins over ERROR)', () => {
  // A wrapper that errored was running OLD content; the on-disk fix
  // is the actionable next step, so we promote to RELOAD.
  const state = {
    documentId: DOC, url: 'https://x', matches: [],
    actual: { a: { state: 'error', name: 'A', message: 'boom' } },
  };
  const next = markScriptStale(state, 'a');
  assert.deepEqual(next.staleScriptIds, ['a']);
});

// ---------- clearScriptStale ----------

test('clearScriptStale: drops the id and the field when last one out', () => {
  const state = {
    documentId: DOC, url: 'https://x', matches: [],
    actual: { a: { state: 'started', name: 'A' } },
    staleScriptIds: ['a'],
  };
  const next = clearScriptStale(state, 'a');
  // The field is removed entirely when empty so computeBadge takes its
  // zero-stale fast path.
  assert.equal('staleScriptIds' in next, false);
  assert.notEqual(next, state);
});

test('clearScriptStale: keeps other ids when one is cleared', () => {
  const state = {
    documentId: DOC, url: 'https://x', matches: [],
    actual: {
      a: { state: 'started', name: 'A' },
      b: { state: 'started', name: 'B' },
    },
    staleScriptIds: ['a', 'b'],
  };
  const next = clearScriptStale(state, 'a');
  assert.deepEqual(next.staleScriptIds, ['b']);
});

test('clearScriptStale: no-op when id is not stale', () => {
  const state = {
    documentId: DOC, url: 'https://x', matches: [],
    actual: { a: { state: 'started', name: 'A' } },
    staleScriptIds: ['b'],
  };
  // Same object back so callers can cheap-test for "no write needed".
  const next = clearScriptStale(state, 'a');
  assert.equal(next, state);
});

test('clearScriptStale: no-op when the field is absent', () => {
  const state = { documentId: DOC, url: 'https://x', matches: [], actual: {} };
  const next = clearScriptStale(state, 'a');
  assert.equal(next, state);
});

// ---------- applyScriptReport ----------

test('applyScriptReport: adds a started entry', () => {
  const state = { documentId: DOC, url: 'https://x', matches: [], actual: {} };
  const next = applyScriptReport(state, 'a', { state: 'started', name: 'A' });
  assert.deepEqual(next.actual, { a: { state: 'started', name: 'A' } });
  // Original state is untouched (returns a fresh object).
  assert.deepEqual(state.actual, {});
});

test('applyScriptReport: error replaces a prior started entry', () => {
  const state = {
    documentId: DOC, url: 'https://x', matches: [],
    actual: { a: { state: 'started', name: 'A' } },
  };
  const next = applyScriptReport(state, 'a', { state: 'error', name: 'A', message: 'boom' });
  assert.equal(next.actual.a.state, 'error');
  assert.equal(next.actual.a.message, 'boom');
});

test('applyScriptReport: started does NOT downgrade a prior error', () => {
  // Errors are sticky so a delayed/retry sm:start can't silently hide
  // a real failure from the badge.
  const state = {
    documentId: DOC, url: 'https://x', matches: [],
    actual: { a: { state: 'error', name: 'A', message: 'boom' } },
  };
  const next = applyScriptReport(state, 'a', { state: 'started', name: 'A' });
  assert.equal(next, state);
  assert.equal(next.actual.a.state, 'error');
});

// ---------- mergeMatches ----------

test('mergeMatches: union by id, sorted by name', () => {
  const out = mergeMatches(
    [expected('a', 'Alpha'), expected('c', 'Charlie')],
    [expected('b', 'Bravo'), expected('a', 'Alpha')],
  );
  assert.deepEqual(out.map((m) => m.id), ['a', 'b', 'c']);
});

test('mergeMatches: incoming entry wins on duplicate id (name refresh)', () => {
  const out = mergeMatches(
    [expected('a', 'OldName')],
    [expected('a', 'NewName')],
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'NewName');
});

test('mergeMatches: empty existing → returns sorted incoming', () => {
  const out = mergeMatches(
    [],
    [expected('b', 'Bravo'), expected('a', 'Alpha')],
  );
  assert.deepEqual(out.map((m) => m.name), ['Alpha', 'Bravo']);
});

// ---------- TabRecord: setCurrentDoc / writeDocState / LRU / getDocState ----------

function makeState(doc, url, actual = {}) {
  return { documentId: doc, url, matches: [], actual };
}

test('setCurrentDoc: creates a record from null with one doc as current', () => {
  const rec = setCurrentDoc(null, 'd1', makeState('d1', 'https://x'));
  assert.equal(rec.currentDocId, 'd1');
  assert.deepEqual(rec.docOrder, ['d1']);
  assert.ok(rec.byDoc.d1);
});

test('setCurrentDoc: navigating to a new doc preserves the prior doc in byDoc', () => {
  // This is the bfcache prerequisite — page A's state must survive
  // navigation to page B so we can rehydrate it on back.
  let rec = setCurrentDoc(null, 'd1', makeState('d1', 'https://a', { s: { state: 'started', name: 'S' } }));
  rec = setCurrentDoc(rec, 'd2', makeState('d2', 'https://b'));
  assert.equal(rec.currentDocId, 'd2');
  assert.deepEqual(rec.docOrder, ['d1', 'd2']);
  assert.ok(rec.byDoc.d1, 'd1 state must survive nav to d2');
  assert.deepEqual(rec.byDoc.d1.actual, { s: { state: 'started', name: 'S' } });
});

test('setCurrentDoc: returning to a known doc bumps it to most-recent (bfcache restore)', () => {
  let rec = setCurrentDoc(null, 'd1', makeState('d1', 'https://a'));
  rec = setCurrentDoc(rec, 'd2', makeState('d2', 'https://b'));
  // Back to d1 — same documentId, simulating a bfcache restore. The
  // navigation handler will call setCurrentDoc with whatever state it
  // built; the LRU should put d1 at the end so it survives eviction.
  rec = setCurrentDoc(rec, 'd1', makeState('d1', 'https://a'));
  assert.equal(rec.currentDocId, 'd1');
  assert.deepEqual(rec.docOrder, ['d2', 'd1']);
});

test('setCurrentDoc: evicts the oldest non-current doc when the cap is exceeded', () => {
  let rec = null;
  for (let i = 0; i < MAX_DOCS_PER_TAB + 2; i++) {
    rec = setCurrentDoc(rec, `d${i}`, makeState(`d${i}`, `https://x${i}`));
  }
  assert.equal(rec.docOrder.length, MAX_DOCS_PER_TAB);
  // The oldest entries should have been dropped.
  assert.equal(rec.byDoc.d0, undefined);
  assert.equal(rec.byDoc.d1, undefined);
  // And the newest is still current.
  assert.equal(rec.currentDocId, `d${MAX_DOCS_PER_TAB + 1}`);
});

test('writeDocState: updates a doc without changing currentDocId', () => {
  // A sm:start that arrives from a doc that isn't currently displayed
  // (e.g. during teardown of the doc we just navigated away from)
  // should record into its doc's slot but NOT steal the badge.
  let rec = setCurrentDoc(null, 'd1', makeState('d1', 'https://a'));
  rec = setCurrentDoc(rec, 'd2', makeState('d2', 'https://b'));
  const nextD1 = makeState('d1', 'https://a', { s: { state: 'started', name: 'S' } });
  rec = writeDocState(rec, 'd1', nextD1);
  assert.equal(rec.currentDocId, 'd2', 'currentDocId must remain d2');
  assert.deepEqual(rec.byDoc.d1.actual, { s: { state: 'started', name: 'S' } });
  // d1 is touched in the LRU even though it's not current.
  assert.deepEqual(rec.docOrder, ['d2', 'd1']);
});

test('writeDocState: bootstraps a record from null and makes the doc current', () => {
  // When the message handler runs before any navigation event (cold SW
  // start), there's no record at all. The new doc is the only thing
  // we know about, so it has to be current — there's no other choice.
  const rec = writeDocState(null, 'd1', makeState('d1', 'https://a'));
  assert.equal(rec.currentDocId, 'd1');
  assert.deepEqual(rec.docOrder, ['d1']);
});

test('getDocState / getCurrentState: lookups behave', () => {
  let rec = setCurrentDoc(null, 'd1', makeState('d1', 'https://a'));
  rec = setCurrentDoc(rec, 'd2', makeState('d2', 'https://b'));
  assert.equal(getDocState(rec, 'd1').url, 'https://a');
  assert.equal(getDocState(rec, 'd2').url, 'https://b');
  assert.equal(getDocState(rec, 'unknown'), null);
  assert.equal(getDocState(null, 'd1'), null);
  assert.equal(getCurrentState(rec).url, 'https://b');
  assert.equal(getCurrentState(null), null);
});
