// Tests for src/extension/popup-view.ts (compiled to dist/extension/popup-view.js):
// which scripts the toolbar popup lists, under which collection, with
// what status, tooltip and reload banner.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bannerText, buildPopupView } from '../../dist/extension/popup-view.js';
import { computeBadge } from '../../dist/extension/tab-status.js';

const URL_ = 'https://example.com/';
const COLLS = [
  { id: 'A', name: 'Alpha coll', path: '/a', enabled: true },
  { id: 'B', name: 'Beta coll', path: '/b', enabled: true },
];

function script(id, collectionId, extra = {}) {
  return { id, name: id, collectionId, enabled: true, identity: null, version: null, headerWarnings: false, ...extra };
}

function state(extra = {}) {
  return { documentId: 'd1', url: URL_, matches: [], actual: {}, loadMatchIds: [], ...extra };
}

function view({ st = state(), scripts, collections = COLLS, matching, commands = new Map(), rejected = {}, keepIds, loadUrlMatchingIds, deletedIds }) {
  const badgeRows = st ? computeBadge(st, new Set(Object.keys(rejected))).rows : [];
  return buildPopupView({
    url: URL_, injectable: true, state: st, badgeRows, rejected,
    matchingIds: new Set(matching ?? scripts.map((s) => s.id)),
    scripts, collections, menuCommands: commands, keepIds, loadUrlMatchingIds, deletedIds,
  });
}

const m = (id, collectionId = 'A') => ({ id, name: id, collectionId, matching: {}, world: 'USER_SCRIPT' });
const names = (groups) => groups.map((g) => `${g.collection.id}: ${g.rows.map((r) => `${r.name}=${r.status}`).join(', ')}`);

test('groups by collection in collection order, scripts by name, enabled apart from disabled', () => {
  const v = view({
    st: state({
      matches: [m('z', 'B'), m('b'), m('a')],
      actual: { z: { state: 'started', name: 'z' }, b: { state: 'started', name: 'b' }, a: { state: 'started', name: 'a' } },
      loadMatchIds: ['z', 'b', 'a'],
    }),
    scripts: [script('z', 'B'), script('b', 'A'), script('a', 'A'), script('off', 'A', { enabled: false })],
  });
  assert.deepEqual(names(v.enabled), ['A: a=OK, b=OK', 'B: z=OK']);
  assert.deepEqual(names(v.disabled), ['A: off=null']);
  assert.equal(v.banner, null);
});

test('one row per identity: a running copy hides the disabled one', () => {
  const v = view({
    st: state({ matches: [m('s1')], actual: { s1: { state: 'started', name: 's1' } }, loadMatchIds: ['s1'] }),
    scripts: [
      script('s1', 'A', { identity: 'ns\u0000S', name: 'S' }),
      script('s2', 'B', { identity: 'ns\u0000S', name: 'S', enabled: false }),
    ],
  });
  assert.deepEqual(names(v.enabled), ['A: S=OK']);
  assert.deepEqual(v.disabled, []);
});

test('a kept row stays listed when another copy of its script takes over', () => {
  const v = view({
    st: state(),
    scripts: [
      script('s1', 'A', { identity: 'ns\u0000S', name: 'S', enabled: false }),
      script('s2', 'B', { identity: 'ns\u0000S', name: 'S' }),
    ],
    keepIds: new Set(['s1']),
  });
  assert.deepEqual(names(v.enabled), ['B: S=PENDING']);
  assert.deepEqual(names(v.disabled), ['A: S=null']);
});

test('two active copies both show, each with its version', () => {
  const v = view({
    st: state({
      matches: [m('s1'), m('s2', 'B')],
      actual: { s1: { state: 'started', name: 'S' }, s2: { state: 'started', name: 'S' } },
      loadMatchIds: ['s1', 's2'],
    }),
    scripts: [
      script('s1', 'A', { identity: 'ns\u0000S', name: 'S', version: '1.0' }),
      script('s2', 'B', { identity: 'ns\u0000S', name: 'S', version: '2.0' }),
    ],
  });
  assert.deepEqual(v.enabled.map((g) => g.rows[0].versionLine), ['Version 1.0', 'Version 2.0']);
});

test('with no copy running, one stands for the script: preferring one whose collection is off', () => {
  const v = view({
    st: state(),
    collections: [COLLS[0], { ...COLLS[1], enabled: false }],
    scripts: [
      script('s1', 'A', { identity: 'ns\u0000S', name: 'S', enabled: false }),
      script('s2', 'B', { identity: 'ns\u0000S', name: 'S' }),
    ],
  });
  assert.deepEqual(names(v.disabled), ['B: S=null']);
  assert.equal(v.disabled[0].rows[0].checked, true);
  assert.equal(v.disabled[0].rows[0].active, false);
});

test('toggles since load: Reload to run, Still running, and the banner', () => {
  const v = view({
    st: state({ matches: [m('was')], actual: { was: { state: 'started', name: 'was' } }, loadMatchIds: ['was'] }),
    scripts: [script('was', 'A', { enabled: false }), script('now', 'A')],
  });
  assert.deepEqual(names(v.enabled), ['A: now=PENDING']);
  assert.deepEqual(names(v.disabled), ['A: was=STILL_RUNNING']);
  assert.equal(v.banner, 'Reload required: Enabled scripts changed');
  assert.match(v.disabled[0].rows[0].tooltip, /^Disabled since this page loaded/);
  // A click on Reload to run reloads; the other pills open the Log.
  assert.match(v.enabled[0].rows[0].tooltip, /\nClick to reload the page\.$/);
  assert.match(v.disabled[0].rows[0].tooltip, /\nClick to open the script log\.$/);
});

test('a running script whose collection was turned off says so', () => {
  const v = view({
    st: state({ matches: [m('s')], actual: { s: { state: 'started', name: 's' } }, loadMatchIds: ['s'] }),
    collections: [{ ...COLLS[0], enabled: false }],
    scripts: [script('s', 'A')],
  });
  assert.equal(v.disabled[0].rows[0].status, 'STILL_RUNNING');
  assert.match(v.disabled[0].rows[0].tooltip, /^Its collection was disabled/);
  assert.equal(v.banner, 'Reload required: Scripts disabled');
});

test('an updated script raises the updated banner; tooltips carry details', () => {
  const v = view({
    st: state({
      matches: [m('u'), m('e')],
      actual: { u: { state: 'started', name: 'u' }, e: { state: 'error', name: 'e', message: 'Boom' } },
      loadMatchIds: ['u', 'e'],
      staleScriptIds: ['u'],
    }),
    scripts: [script('u', 'A'), script('e', 'A')],
  });
  assert.equal(v.banner, 'Reload required: Scripts updated');
  const e = v.enabled[0].rows.find((r) => r.id === 'e');
  assert.equal(e.tooltip, 'Boom\nClick to open the script log.');
});

test('a reload with only one script names it in the others\' tooltips', () => {
  const v = view({
    st: state({ matches: [m('one'), m('two')], actual: { one: { state: 'started', name: 'one' } }, loadMatchIds: ['one', 'two'], skipOnly: 'one' }),
    scripts: [script('one', 'A', { name: 'One' }), script('two', 'A', { name: 'Two' })],
  });
  const two = v.enabled[0].rows.find((r) => r.id === 'two');
  assert.equal(two.status, 'NOT_LOADED');
  assert.match(two.tooltip, /^Not run: the page was reloaded with only One\n/);
  assert.equal(v.perScriptReload, true);
});

test('an sm-dev tab: no per-script reloads, and a script it kept out is not "Reload to run"', () => {
  const v = view({
    st: state({ matches: [m('k')], loadMatchIds: [], smDevAllow: null, smDevRun: 'R1' }),
    scripts: [script('k', 'A')],
  });
  assert.equal(v.smDev, true);
  assert.equal(v.perScriptReload, false);
  assert.equal(v.enabled[0].rows[0].status, 'NOT_LOADED');
  assert.equal(v.banner, null);
});

test('menu commands list under running scripts only', () => {
  const cmds = new Map([['s', [{ commandId: 'c1', name: 'Do it' }]], ['off', [{ commandId: 'c2', name: 'Gone' }]]]);
  const v = view({
    st: state({ matches: [m('s')], actual: { s: { state: 'started', name: 's' } }, loadMatchIds: ['s'] }),
    scripts: [script('s', 'A'), script('off', 'A', { enabled: false })],
    commands: cmds,
  });
  assert.deepEqual(v.enabled[0].rows[0].commands, [{ commandId: 'c1', name: 'Do it' }]);
  assert.deepEqual(v.disabled[0].rows[0].commands, []);
});

test('a page no script can run on lists nothing', () => {
  const v = buildPopupView({
    url: 'chrome://version', injectable: false, state: null, badgeRows: [], rejected: {},
    matchingIds: new Set(), scripts: [], collections: COLLS, menuCommands: new Map(),
  });
  assert.equal(v.injectable, false);
  assert.deepEqual(v.enabled, []);
});

test('a script Chrome refuses stays Rejected, not Reload to run', () => {
  const v = view({
    st: state({ matches: [m('r')], loadMatchIds: [] }),
    scripts: [script('r', 'A')],
    rejected: { r: 'Bad pattern' },
  });
  assert.equal(v.enabled[0].rows[0].status, 'REJECTED');
  assert.match(v.enabled[0].rows[0].tooltip, /^Bad pattern\n/);
  assert.equal(v.banner, null);
});

test('a script matching only the URL the page moved to in place says so', () => {
  const v = view({
    st: state({ matches: [m('spa')], loadMatchIds: [] }),
    scripts: [script('spa', 'A')],
    // It didn't match the load URL, so it wasn't left out by being off.
    loadUrlMatchingIds: new Set(),
  });
  const row = v.enabled[0].rows[0];
  assert.equal(row.status, 'PENDING');
  assert.match(row.tooltip, /^This page changed its address since it loaded/);
  assert.equal(v.banner, 'Reload required: Some scripts haven\'t run on this page yet');
});

test('one that did match the load URL was enabled since', () => {
  const v = view({
    st: state({ matches: [m('late')], loadMatchIds: [] }),
    scripts: [script('late', 'A')],
    loadUrlMatchingIds: new Set(['late']),
  });
  assert.equal(v.banner, 'Reload required: Scripts enabled');
});

test('banner wording', () => {
  assert.equal(bannerText({ updated: true }), 'Reload required: Scripts updated');
  assert.equal(bannerText({ updated: true, enabled: true }), 'Reload required: Scripts enabled');
  assert.equal(bannerText({ disabled: true }), 'Reload required: Scripts disabled');
  assert.equal(bannerText({ enabled: true, disabled: true }), 'Reload required: Enabled scripts changed');
  assert.equal(bannerText({ missing: true, updated: true }), 'Reload required: Scripts updated');
  assert.equal(bannerText({ notYetRun: true, missing: true }), 'Reload required: Some scripts haven\'t run on this page yet');
  assert.equal(bannerText({ missing: true }), 'Reload required: Some scripts are missing');
  assert.equal(bannerText({ unexpected: true }), 'Reload required: Unexpected scripts are running');
  assert.equal(bannerText({ missing: true, unexpected: true }), 'Reload required: Some scripts are missing or unexpected');
  assert.equal(bannerText({}), null);
});

test('a missing script raises the banner', () => {
  const v = view({
    st: state({ matches: [m('gone')], loadMatchIds: ['gone'] }),
    scripts: [script('gone', 'A')],
  });
  assert.equal(v.enabled[0].rows[0].status, 'MISSING');
  assert.equal(v.banner, 'Reload required: Some scripts are missing');
});

test('a running script with a warning shows Warning; every other status outranks it', () => {
  const v = view({
    st: state({
      matches: [m('hdr'), m('tab'), m('err'), m('quiet'), m('missing')],
      actual: {
        hdr: { state: 'started', name: 'hdr' },
        tab: { state: 'started', name: 'tab' },
        err: { state: 'error', name: 'err', message: 'boom' },
        quiet: { state: 'started', name: 'quiet' },
      },
      loadMatchIds: ['hdr', 'tab', 'err', 'quiet', 'missing'],
      warnedIds: ['tab', 'err', 'missing'],
    }),
    scripts: [
      script('hdr', 'A', { headerWarnings: true }), script('tab', 'A'), script('err', 'A'),
      script('quiet', 'A'), script('missing', 'A', { headerWarnings: true }),
    ],
  });
  const rows = v.enabled[0].rows;
  assert.deepEqual(rows.map((r) => `${r.name}=${r.status}${r.warned ? '+warned' : ''}`), [
    'err=ERROR+warned', 'hdr=WARNING+warned', 'missing=MISSING', 'quiet=OK', 'tab=WARNING+warned',
  ]);
  assert.match(rows.find((r) => r.name === 'tab').tooltip, /^Running on this page, with warnings\n/);
});

test('a script deleted since it ran is listed apart as Still running, and the banner says so', () => {
  const v = view({
    st: state({
      matches: [m('a'), m('gone')],
      actual: { a: { state: 'started', name: 'a' }, gone: { state: 'started', name: 'Gone' } },
      loadMatchIds: ['a', 'gone'],
    }),
    scripts: [script('a', 'A')],
    commands: new Map([['gone', [{ commandId: 'c1', name: 'Do it' }]]]),
    deletedIds: new Set(['gone']),
  });
  assert.deepEqual(names(v.enabled), ['A: a=OK']);
  assert.deepEqual(v.deleted.map((r) => `${r.name}=${r.status}`), ['Gone=STILL_RUNNING']);
  assert.match(v.deleted[0].tooltip, /^Deleted since this page loaded\. It keeps running until a reload\.\nClick to reload the page\.$/);
  assert.deepEqual(v.deleted[0].commands.map((c) => c.name), ['Do it']);
  assert.equal(v.banner, 'Reload required: Scripts deleted');
});

test('banner names deleted and disabled scripts together', () => {
  assert.equal(bannerText({ disabled: true, deleted: true }), 'Reload required: Scripts disabled or deleted');
  assert.equal(bannerText({ enabled: true, deleted: true }), 'Reload required: Enabled scripts changed');
});
