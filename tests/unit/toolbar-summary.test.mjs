// Tests for src/extension/toolbar-summary.ts (compiled to
// dist/extension/toolbar-summary.js): the toolbar badge's count and
// color, and its tooltip lines, from the popup's view of a tab.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildPopupView } from '../../dist/extension/popup-view.js';
import { computeBadge, BADGE_GREEN, BADGE_ORANGE, BADGE_PURPLE, BADGE_RED } from '../../dist/extension/tab-status.js';
import { summarizeToolbar } from '../../dist/extension/toolbar-summary.js';

const URL_ = 'https://example.com/';
const HINT = 'Click for details. Double-click for collections.';
const COLLS = [{ id: 'A', name: 'Alpha coll', path: '/a', enabled: true }];

const m = (id) => ({ id, name: id, collectionId: 'A', matching: {}, world: 'USER_SCRIPT' });
const started = (id) => ({ state: 'started', name: id });

function script(id, extra = {}) {
  return { id, name: id, collectionId: 'A', enabled: true, identity: null, version: null, headerWarnings: false, ...extra };
}

function summary({ st, scripts, rejected = {}, injectable = true, deletedIds }) {
  const badge = st ? computeBadge(st, new Set(Object.keys(rejected))) : null;
  const view = buildPopupView({
    url: URL_, injectable, state: st, badgeRows: badge?.rows ?? [], rejected,
    matchingIds: new Set(scripts.map((s) => s.id)),
    scripts, collections: COLLS, menuCommands: new Map(), deletedIds,
    manualRunnableIds: new Set(scripts.filter((s) => s.manual).map((s) => s.id)),
  });
  return summarizeToolbar(view, st);
}

// The status lines, without the name and the click hint.
const lines = (s) => {
  const all = s.title.split('\n');
  assert.equal(all[0], 'SourceMonkey');
  assert.equal(all.at(-1), HINT);
  return all.slice(1, -1);
};

test('all running: one line, green', () => {
  const s = summary({
    st: { documentId: 'd', url: URL_, matches: [m('a'), m('b')], actual: { a: started('a'), b: started('b') }, loadMatchIds: ['a', 'b'] },
    scripts: [script('a'), script('b')],
  });
  assert.deepEqual(lines(s), ['2 scripts running.']);
  assert.equal(s.color, BADGE_GREEN);
  assert.equal(s.count, 2);
});

test('every condition gets its own line, in order; the first with a color sets it', () => {
  const s = summary({
    st: {
      documentId: 'd', url: URL_,
      matches: [m('ok'), m('err'), m('rej'), m('stale'), m('miss')],
      actual: { ok: started('ok'), err: { state: 'error', name: 'err', message: 'x' }, stale: started('stale'), surprise: started('surprise') },
      staleScriptIds: ['stale'],
      loadMatchIds: ['ok', 'err', 'rej', 'stale', 'miss'],
      warnedIds: ['ok'],
    },
    scripts: [script('ok'), script('err'), script('rej'), script('stale'), script('miss'), script('surprise')],
    rejected: { rej: 'Refused' },
  });
  // Running counts every script that reported, the errored one too.
  assert.deepEqual(lines(s), [
    '4 scripts running.',
    '1 script has errors.',
    'Chrome rejected 1 script.',
    'Reload needed to update 1 script.',
    '1 expected script is not running.',
    '1 unexpected script is running.',
    '1 script has warnings.',
  ]);
  assert.equal(s.color, BADGE_RED);
});

test('enabled or disabled since the page loaded: purple, and a script waiting to run counts on the badge', () => {
  const s = summary({
    st: { documentId: 'd', url: URL_, matches: [m('a'), m('off')], actual: { a: started('a'), off: started('off') }, loadMatchIds: ['a', 'off'] },
    scripts: [script('a'), script('off', { enabled: false }), script('new')],
  });
  assert.deepEqual(lines(s), ['2 scripts running.', 'Reload needed to add 1 script.', 'Reload needed to remove 1 script.']);
  assert.equal(s.color, BADGE_PURPLE);
  assert.equal(s.count, 3);
});

test('a script enabled since load is counted once, after a refresh adds it to the expected set', () => {
  // The refresh path merges what matches now into `matches`, so
  // computeBadge already counts the newly enabled script.
  const s = summary({
    st: { documentId: 'd', url: URL_, matches: [m('a'), m('new')], actual: { a: started('a') }, loadMatchIds: ['a'] },
    scripts: [script('a'), script('new')],
  });
  assert.deepEqual(lines(s), ['1 script running.', 'Reload needed to add 1 script.']);
  assert.equal(s.count, 2);
});

test('a script deleted since it ran counts as one a reload removes', () => {
  const s = summary({
    st: { documentId: 'd', url: URL_, matches: [m('a'), m('gone')], actual: { a: started('a'), gone: started('gone') }, loadMatchIds: ['a', 'gone'] },
    scripts: [script('a')],
    deletedIds: new Set(['gone']),
  });
  assert.deepEqual(lines(s), ['2 scripts running.', 'Reload needed to remove 1 script.']);
  assert.equal(s.color, BADGE_PURPLE);
  assert.equal(s.count, 2);
});

test('a script disabled since load that never started drops out of the count, as from the lines', () => {
  const s = summary({
    st: { documentId: 'd', url: URL_, matches: [m('a'), m('off')], actual: { a: started('a') }, loadMatchIds: ['a', 'off'] },
    scripts: [script('a'), script('off', { enabled: false })],
  });
  assert.deepEqual(lines(s), ['1 script running.']);
  assert.equal(s.count, 1);
});

test('warnings get a line but leave the color alone', () => {
  const s = summary({
    st: { documentId: 'd', url: URL_, matches: [m('a')], actual: { a: started('a') }, loadMatchIds: ['a'] },
    scripts: [script('a', { headerWarnings: true })],
  });
  assert.deepEqual(lines(s), ['1 script running.', '1 script has warnings.']);
  assert.equal(s.color, BADGE_GREEN);
});

test('missing and unexpected say which', () => {
  const s = summary({
    st: { documentId: 'd', url: URL_, matches: [m('a'), m('b')], actual: { z: started('z') }, loadMatchIds: ['a', 'b'] },
    scripts: [script('a'), script('b'), script('z')],
  });
  assert.deepEqual(lines(s), ['1 script running.', '2 expected scripts are not running.', '1 unexpected script is running.']);
  assert.equal(s.color, BADGE_ORANGE);
});

test('no scripts, or a page scripts cannot run on: no badge', () => {
  const none = summary({ st: { documentId: 'd', url: URL_, matches: [], actual: {}, loadMatchIds: [] }, scripts: [] });
  assert.deepEqual(lines(none), ['No scripts match this page.']);
  assert.equal(none.color, null);
  const blocked = summary({ st: null, scripts: [], injectable: false });
  assert.deepEqual(lines(blocked), ['SourceMonkey can\'t run scripts on this page.']);
  assert.equal(blocked.color, null);
});

test('a tab an sm-dev run controls says so under the name', () => {
  const s = summary({
    st: { documentId: 'd', url: URL_, matches: [m('a')], actual: { a: started('a') }, loadMatchIds: ['a'], smDevAllow: ['a'] },
    scripts: [script('a')],
  });
  assert.deepEqual(lines(s), ['Page under sm-dev control', '1 script running.']);
});

test('a manual script not run yet gets no line and no badge; once run, it counts like any other', () => {
  const st = { documentId: 'd', url: URL_, matches: [], actual: {}, loadMatchIds: [] };
  const notRun = summary({ st, scripts: [script('man', { manual: true })] });
  assert.deepEqual(lines(notRun), []);
  assert.equal(notRun.color, null);
  assert.equal(notRun.count, 0);

  const ran = summary({
    st: { ...st, actual: { man: started('man') }, manualRuns: { man: 2 } },
    scripts: [script('man', { manual: true })],
  });
  assert.deepEqual(lines(ran), ['1 script running.']);
  assert.equal(ran.color, BADGE_GREEN);
  assert.equal(ran.count, 1);
});

test('a page loaded before the extension started: purple, with its own line', () => {
  const s = summary({
    st: { documentId: 'd', url: URL_, matches: [m('a'), m('b')], actual: {}, loadMatchIds: ['a', 'b'], loadedBefore: true },
    scripts: [script('a'), script('b')],
  });
  assert.deepEqual(lines(s), ['Page loaded before SourceMonkey started. Reload needed for 2 scripts.']);
  assert.equal(s.color, BADGE_PURPLE);
  assert.equal(s.count, 2);
});
