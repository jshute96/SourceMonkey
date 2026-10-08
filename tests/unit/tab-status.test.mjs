// Tests for src/extension/tab-status.ts (compiled to dist/extension/tab-status.js).
//
// The module owns the pure helpers behind the per-tab toolbar badge:
// classifying each expected/actual script into OK/ERROR/MISSING/
// UNEXPECTED and merging incoming wrapper reports. The color and
// tooltip come from toolbar-summary.ts; `badge` below runs the whole
// chain, so the color rules are checked here against real statuses.

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
  noteManualRun,
  setCurrentDoc,
  writeDocState,
  BADGE_GREEN,
  BADGE_GREY,
  BADGE_ORANGE,
  BADGE_PURPLE,
  BADGE_RED,
  MAX_DOCS_PER_TAB,
} from '../../dist/extension/tab-status.js';
import { buildPopupView } from '../../dist/extension/popup-view.js';
import { summarizeToolbar } from '../../dist/extension/toolbar-summary.js';

// Shared default — the tests below don't care about documentId, they
// just need the state shape to be valid.
const DOC = 'doc-1';

function expected(id, name = id) {
  return {
    id,
    name,
    collectionId: 'src-1',
    matching: { matches: [], excludes: [], includes: [] },
  };
}

// computeBadge's rows, with the badge count, color and tooltip the
// worker would paint for them: every script stored, enabled, in one
// enabled collection, and matching the page.
function badge(state, rejected = new Set()) {
  const computed = computeBadge(state, rejected);
  const { rows } = computed;
  const view = buildPopupView({
    url: state.url,
    injectable: true,
    state,
    badgeRows: rows,
    rejected: Object.fromEntries([...rejected].map((id) => [id, 'Refused'])),
    matchingIds: new Set(state.matches.map((m) => m.id)),
    scripts: rows.map((r) => ({
      id: r.id, name: r.name, collectionId: 'src-1', enabled: true, identity: null, version: null, headerWarnings: false,
    })),
    collections: [{ id: 'src-1', name: 'Src', path: '/src', enabled: true }],
    menuCommands: new Map(),
  });
  return { rows, ...summarizeToolbar(view, state) };
}

// ---------- computeBadge: classification ----------

test('computeBadge: expected + started → OK, GREEN', () => {
  const view = badge({
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
  const view = badge({
    documentId: DOC, url: 'https://x',
    matches: [expected('a', 'Alpha'), expected('b', 'Beta')],
    actual: { a: { state: 'started', name: 'Alpha' } },
  });
  assert.equal(view.count, 2);
  assert.equal(view.color, BADGE_ORANGE);
  const beta = view.rows.find((r) => r.name === 'Beta');
  assert.equal(beta.status, 'MISSING');
});

test('computeBadge: skipped document → NOT_LOADED, GREY', () => {
  // "Reload page with no userscripts": nothing reported because nothing
  // was asked to run. Grey says "on purpose", where MISSING's amber
  // would say "something's off".
  const view = badge({
    documentId: DOC, url: 'https://x',
    matches: [expected('a', 'Alpha'), expected('b', 'Beta')],
    actual: {},
    scriptsSkipped: true,
  });
  assert.equal(view.count, 2);
  assert.equal(view.color, BADGE_GREY);
  assert.deepEqual(view.rows.map((r) => r.status), ['NOT_LOADED', 'NOT_LOADED']);
  assert.match(view.title, /^2 scripts skipped on this load\.$/m);
});

test('computeBadge: an sm-dev claim keeps the rest out, and stays green when the allowed ones ran', () => {
  // A tab an sm-dev run controls: only `smDevAllow` may run; the rest
  // were told to skip, so NOT_LOADED, and the tab isn't greyed while
  // something did run.
  const view = badge({
    documentId: DOC, url: 'https://x',
    matches: [expected('a', 'Alpha'), expected('b', 'Beta')],
    actual: { a: { state: 'started', name: 'Alpha' } },
    smDevAllow: ['a'],
  });
  assert.deepEqual(view.rows.map((r) => [r.name, r.status]), [['Alpha', 'OK'], ['Beta', 'NOT_LOADED']]);
  assert.equal(view.color, BADGE_GREEN);
  // The tooltip says whose tab it is, as the action menu does.
  assert.equal(view.title.split('\n').slice(0, 2).join('\n'), 'SourceMonkey\nPage under sm-dev control');
  // Nothing allowed: nothing ran, so grey.
  const none = badge({
    documentId: DOC, url: 'https://x',
    matches: [expected('a', 'Alpha')],
    actual: {},
    smDevAllow: null,
  });
  assert.equal(none.rows[0].status, 'NOT_LOADED');
  assert.equal(none.color, BADGE_GREY);
  assert.match(none.title, /^Page under sm-dev control$/m);
});

test('computeBadge: NOT_LOADED beats REJECTED, but any real disagreement beats GREY', () => {
  // A refused registration didn't get to matter on a document where
  // nothing was going to run; an UNEXPECTED report still did.
  const skipped = badge({
    documentId: DOC, url: 'https://x',
    matches: [expected('a', 'Alpha')],
    actual: {},
    scriptsSkipped: true,
  }, new Set(['a']));
  assert.equal(skipped.rows[0].status, 'NOT_LOADED');
  assert.equal(skipped.color, BADGE_GREY);

  const mixed = badge({
    documentId: DOC, url: 'https://x',
    matches: [expected('a', 'Alpha')],
    actual: { z: { state: 'started', name: 'Zeta' } },
    scriptsSkipped: true,
  });
  assert.equal(mixed.color, BADGE_ORANGE);
  assert.equal(mixed.rows.find((r) => r.name === 'Alpha').status, 'NOT_LOADED');
  assert.equal(mixed.rows.find((r) => r.name === 'Zeta').status, 'UNEXPECTED');
});

test('computeBadge: a refused registration → REJECTED, RED', () => {
  // MISSING is provisional (the wrapper may still be on its way);
  // REJECTED is settled — Chrome refused the spec, so nothing is
  // coming. Same word the collections page and viewer use, and red because
  // it is as final as a thrown error.
  const view = badge({
    documentId: DOC, url: 'https://x',
    matches: [expected('a', 'Alpha'), expected('b', 'Beta')],
    actual: { a: { state: 'started', name: 'Alpha' } },
  }, new Set(['b']));
  assert.equal(view.color, BADGE_RED);
  assert.equal(view.rows.find((r) => r.name === 'Beta').status, 'REJECTED');
  assert.equal(view.rows.find((r) => r.name === 'Alpha').status, 'OK');
  assert.match(view.title, /^Chrome rejected 1 script\.$/m);
});

test('computeBadge: rejection only refines the never-reported case', () => {
  // A script that DID report is described by its report, not by a
  // rejection record that must predate it.
  const view = badge({
    documentId: DOC, url: 'https://x',
    matches: [expected('a', 'Alpha')],
    actual: { a: { state: 'started', name: 'Alpha' } },
  }, new Set(['a']));
  assert.equal(view.rows[0].status, 'OK');
  assert.equal(view.color, BADGE_GREEN);
});

test('computeBadge: an unrelated rejection leaves the tab alone', () => {
  // The map is global; a script refused elsewhere must not colour a tab
  // that never expected it.
  const view = badge({
    documentId: DOC, url: 'https://x',
    matches: [expected('a', 'Alpha')],
    actual: { a: { state: 'started', name: 'Alpha' } },
  }, new Set(['somebody-else']));
  assert.equal(view.color, BADGE_GREEN);
  assert.equal(view.count, 1);
});

test('computeBadge: no rejection set → unchanged behavior', () => {
  const view = badge({
    documentId: DOC, url: 'https://x',
    matches: [expected('a', 'Alpha')],
    actual: {},
  });
  assert.equal(view.rows[0].status, 'MISSING');
  assert.equal(view.color, BADGE_ORANGE);
});

test('computeBadge: actual without expected → UNEXPECTED, ORANGE', () => {
  const view = badge({
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
  const view = badge({
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
  const view = badge({
    documentId: DOC, url: 'https://x',
    matches: [],
    actual: { z: { state: 'error', name: 'Surprise', message: 'oops' } },
  });
  assert.equal(view.color, BADGE_RED);
  assert.equal(view.rows[0].status, 'ERROR');
});

test('computeBadge: empty state → no badge, tooltip says nothing matches', () => {
  const view = badge({ documentId: DOC, url: 'https://x', matches: [], actual: {} });
  assert.equal(view.count, 0);
  assert.equal(view.color, null);
  assert.equal(view.title, 'SourceMonkey\nNo scripts match this page.\nClick for details. Double-click for collections.');
});

test('computeBadge: rows sorted by name', () => {
  const view = badge({
    documentId: DOC, url: 'https://x',
    matches: [expected('c', 'Charlie'), expected('a', 'Alpha')],
    actual: {
      c: { state: 'started', name: 'Charlie' },
      // a missing
      b: { state: 'error', name: 'Bravo', message: 'x' },
    },
  });
  assert.deepEqual(view.rows.map((r) => `${r.name} | ${r.status}`), [
    'Alpha | MISSING',
    'Bravo | ERROR',
    'Charlie | OK',
  ]);
});

test('computeBadge: names sort like the collections page (case-blind, numeric)', () => {
  const view = badge({
    documentId: DOC, url: 'https://x',
    matches: [expected('a', 'Item 10'), expected('b', 'beta'), expected('c', 'Item 9')],
    actual: {
      a: { state: 'started', name: 'Item 10' },
      b: { state: 'started', name: 'beta' },
      c: { state: 'started', name: 'Item 9' },
    },
  });
  assert.deepEqual(view.rows.map((r) => r.name), ['beta', 'Item 9', 'Item 10']);
});

test('computeBadge: prefers actual-side name over expected-side', () => {
  // The wrapper's reported name reflects what's actually running; use
  // it in preference to a possibly-stale name from the cache.
  const view = badge({
    documentId: DOC, url: 'https://x',
    matches: [expected('a', 'OldName')],
    actual: { a: { state: 'started', name: 'NewName' } },
  });
  assert.equal(view.rows[0].name, 'NewName');
});

// ---------- computeBadge: RELOAD / PURPLE ----------

test('computeBadge: started + stale → RELOAD, PURPLE, tooltip says a reload is needed', () => {
  const view = badge({
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
  assert.deepEqual(view.title.split('\n').slice(1, 3), ['2 scripts running.', 'Reload needed to update 1 script.']);
});

test('computeBadge: non-stale ERROR still beats RELOAD for color', () => {
  // Beta errored and its file on disk has NOT changed → row stays ERROR,
  // badge stays RED. Stale alpha is still RELOAD on its row but RED
  // wins for the overall color.
  const view = badge({
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
  // address it. We don't keep showing red — purple (a reload) is
  // the more actionable signal.
  const view = badge({
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
  const view = badge({
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

// ---------- Manual scripts (`@run-at context-menu`) ----------

test('computeBadge: a manual script that ran is OK, not UNEXPECTED, and counts once', () => {
  let state = { documentId: DOC, url: 'https://x', matches: [], actual: {} };
  state = noteManualRun(state, 'm');
  state = applyScriptReport(state, 'm', { state: 'started', name: 'Manual' }, true);
  state = noteManualRun(state, 'm');
  state = applyScriptReport(state, 'm', { state: 'started', name: 'Manual' }, true);
  assert.deepEqual(state.manualRuns, { m: 2 });
  const view = computeBadge(state);
  assert.equal(view.count, 1);
  assert.deepEqual(view.rows.map((r) => `${r.name}|${r.status}`), ['Manual|OK']);
});

test('computeBadge: a manual script is never stale, since each run uses its current copy', () => {
  const state = {
    documentId: DOC, url: 'https://x', matches: [],
    actual: { m: { state: 'started', name: 'Manual' } },
    manualRuns: { m: 1 },
    staleScriptIds: ['m'],
  };
  assert.deepEqual(computeBadge(state).rows.map((r) => r.status), ['OK']);
});

test('applyScriptReport: a manual run\'s start replaces the last run\'s error', () => {
  const errored = {
    documentId: DOC, url: 'https://x', matches: [],
    actual: { m: { state: 'error', name: 'Manual', message: 'Boom' } },
  };
  assert.equal(applyScriptReport(errored, 'm', { state: 'started', name: 'Manual' }).actual.m.state, 'error');
  assert.equal(applyScriptReport(errored, 'm', { state: 'started', name: 'Manual' }, true).actual.m.state, 'started');
});
