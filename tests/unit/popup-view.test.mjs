// Tests for src/extension/popup-view.ts (compiled to dist/extension/popup-view.js):
// which scripts the toolbar popup lists, under which collection, with
// what status, tooltip and reload banner.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  bannerText, buildPopupView, runNowTooltip,
  RUN_NOW_WARNING_DOCUMENT_START, RUN_NOW_WARNING_LOADED_BEFORE, RUN_NOW_WARNING_OTHER_COPY, RUN_NOW_WARNING_RERUN,
} from '../../dist/extension/popup-view.js';
import { computeBadge } from '../../dist/extension/tab-status.js';

const URL_ = 'https://example.com/';
const COLLS = [
  { id: 'A', name: 'Alpha coll', path: '/a', enabled: true },
  { id: 'B', name: 'Beta coll', path: '/b', enabled: true },
];

function script(id, collectionId, extra = {}) {
  return { id, name: id, collectionId, enabled: true, identity: null, version: null, location: `/${collectionId}/${id}`, headerWarnings: false, ...extra };
}

function state(extra = {}) {
  return { documentId: 'd1', url: URL_, matches: [], actual: {}, loadMatchIds: [], ...extra };
}

function view({ st = state(), scripts, collections = COLLS, matching, commands = new Map(), rejected = {}, keepIds, loadUrlMatchingIds, deletedIds, runnable, now, userScriptsDisabled }) {
  const badgeRows = st ? computeBadge(st, new Set(Object.keys(rejected)), userScriptsDisabled).rows : [];
  return buildPopupView({
    url: URL_, injectable: true, state: st, badgeRows, rejected, userScriptsDisabled,
    matchingIds: new Set(matching ?? scripts.map((s) => s.id)),
    scripts, collections, menuCommands: commands, keepIds, loadUrlMatchingIds, deletedIds, now,
    // By default, every manual script can run here.
    manualRunnableIds: new Set(runnable ?? scripts.filter((s) => s.manual).map((s) => s.id)),
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

// With no copy running, the copy shown is the one closest to running
// and most likely to be turned back on (docs/script-enablement.md).
function shownCopy({ collections = COLLS, copies }) {
  const v = view({
    st: state(),
    collections,
    scripts: copies.map(([id, coll, extra]) => script(id, coll, { identity: 'ns\u0000S', name: 'S', ...extra })),
  });
  assert.equal(v.disabled.length, 1);
  assert.equal(v.disabled[0].rows.length, 1);
  return v.disabled[0].rows[0].id;
}

test('with no copy running: one in an enabled collection before one ticked under a disabled collection', () => {
  const collections = [COLLS[0], { ...COLLS[1], enabled: false }];
  assert.equal(shownCopy({ collections, copies: [['s1', 'A', { enabled: false }], ['s2', 'B']] }), 's1');
});

test('with no copy running, under disabled collections: a ticked copy before an unticked one', () => {
  const collections = [{ ...COLLS[0], enabled: false }, { ...COLLS[1], enabled: false }];
  const id = shownCopy({ collections, copies: [['s1', 'A', { enabled: false, inactiveSince: 9 }], ['s2', 'B']] });
  assert.equal(id, 's2');
});

test('with no copy running: the most recently stopped, then collection name', () => {
  const off = { enabled: false };
  assert.equal(shownCopy({ copies: [['s1', 'A', { ...off, inactiveSince: 1 }], ['s2', 'B', { ...off, inactiveSince: 2 }]] }), 's2');
  assert.equal(shownCopy({ copies: [['s1', 'B', off], ['s2', 'A', off]] }), 's2');
});

test('with no copy running, in one collection: highest version, then location', () => {
  const off = { enabled: false };
  assert.equal(shownCopy({ copies: [['s1', 'A', { ...off, version: '1.10' }], ['s2', 'A', { ...off, version: '1.9' }]] }), 's1');
  assert.equal(shownCopy({ copies: [['s1', 'A', { ...off, location: '/z' }], ['s2', 'A', { ...off, location: '/a' }]] }), 's2');
});

test('a row says whether other copies of its script match the page', () => {
  const v = view({
    st: state(),
    scripts: [
      script('s1', 'A', { identity: 'ns\u0000S', name: 'S', enabled: false }),
      script('s2', 'B', { identity: 'ns\u0000S', name: 'S', enabled: false }),
      script('t', 'A'),
    ],
  });
  const rows = [...v.enabled, ...v.disabled].flatMap((g) => g.rows);
  assert.deepEqual(rows.map((r) => [r.name, r.otherCopies]).sort(), [['S', true], ['t', false]]);
});

test('toggles since load: Reload to run, Still running, and the banner', () => {
  const v = view({
    st: state({ matches: [m('was')], actual: { was: { state: 'started', name: 'was' } }, loadMatchIds: ['was'] }),
    scripts: [script('was', 'A', { enabled: false }), script('now', 'A')],
  });
  // Still running in the page, so listed with the active scripts.
  assert.deepEqual(names(v.enabled), ['A: now=PENDING, was=STILL_RUNNING']);
  assert.deepEqual(v.disabled, []);
  assert.equal(v.banner, 'Reload required: Enabled scripts changed');
  const was = v.enabled[0].rows.find((r) => r.id === 'was');
  const now = v.enabled[0].rows.find((r) => r.id === 'now');
  assert.match(was.tooltip, /^Disabled since this page loaded/);
  // A click on Reload to run reloads; the other pills open the Log.
  assert.match(now.tooltip, /\nClick to reload the page\.$/);
  assert.match(was.tooltip, /\nClick to open the script log\.$/);
});

test('a running script whose collection was turned off says so', () => {
  const v = view({
    st: state({ matches: [m('s')], actual: { s: { state: 'started', name: 's' } }, loadMatchIds: ['s'] }),
    collections: [{ ...COLLS[0], enabled: false }],
    scripts: [script('s', 'A')],
  });
  assert.equal(v.enabled[0].rows[0].status, 'STILL_RUNNING');
  assert.match(v.enabled[0].rows[0].tooltip, /^Its collection was disabled/);
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
  // It can be run now, but wasn't newly enabled.
  assert.deepEqual(row.runNow, { kind: 'run', warnings: [] });
  assert.equal(v.runEnabled, undefined);
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

test('a missing script raises no banner while the page is still loading', () => {
  const v = view({
    st: state({ matches: [m('slow')], loadMatchIds: ['slow'], settleBy: 2000 }),
    scripts: [script('slow', 'A')],
    now: 1000,
  });
  assert.equal(v.enabled[0].rows[0].status, 'MISSING');
  assert.equal(v.banner, null);
  assert.equal(v.bannerRecheckAt, 2000);
});

test('a missing script raises the banner once the settling deadline passes', () => {
  const v = view({
    st: state({ matches: [m('slow')], loadMatchIds: ['slow'], settleBy: 2000 }),
    scripts: [script('slow', 'A')],
    now: 2000,
  });
  assert.equal(v.banner, 'Reload required: Some scripts are missing');
  assert.equal(v.bannerRecheckAt, null);
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

test('an invalid script that targets the page shows as Invalid, with no banner', () => {
  const v = view({
    st: state(),
    scripts: [script('bad', 'A', { invalid: 'The @require lib.js could not be loaded' }), script('off', 'A', { enabled: false, invalid: '' })],
  });
  assert.deepEqual(names(v.enabled), ['A: bad=INVALID']);
  assert.match(v.enabled[0].rows[0].tooltip, /failed to load, so it can't run: The @require lib\.js could not be loaded/);
  // Disabled, it says Invalid too.
  assert.deepEqual(names(v.disabled), ['A: off=INVALID']);
  assert.equal(v.banner, null);
});

test('an unexpected script running in the page is listed with the active scripts', () => {
  const v = view({
    st: state({ actual: { u: { state: 'started', name: 'u' } } }),
    scripts: [script('u', 'A', { enabled: false })],
    matching: [],
  });
  assert.deepEqual(names(v.enabled), ['A: u=STILL_RUNNING']);
});

test('a script removed since the page loaded that still runs gets a group of its own', () => {
  const v = view({
    st: state({ actual: { gone: { state: 'started', name: 'Gone Script' } }, matches: [m('gone')], loadMatchIds: ['gone'] }),
    scripts: [],
    matching: [],
  });
  assert.deepEqual(names(v.enabled), ['sm:removed: Gone Script=STILL_RUNNING']);
  assert.equal(v.enabled[0].collection.name, 'Removed scripts');
  assert.match(v.enabled[0].rows[0].tooltip, /^Removed since this page loaded/);
  assert.equal(v.banner, 'Reload required: Scripts removed');
});

test('a hidden script running in the page is not taken for a removed one', () => {
  const v = view({
    st: state({ actual: { scratch: { state: 'started', name: 'Scratch' } } }),
    scripts: [],
    matching: [],
  });
  assert.equal(v.enabled.length, 1);
  const hidden = buildPopupView({
    url: URL_, injectable: true, state: state({ actual: { scratch: { state: 'started', name: 'Scratch' } } }),
    badgeRows: [], rejected: {}, matchingIds: new Set(), scripts: [], collections: COLLS,
    menuCommands: new Map(), hiddenIds: new Set(['scratch']),
  });
  assert.deepEqual(hidden.enabled, []);
});

test('the banner names both disabled and removed scripts', () => {
  assert.equal(bannerText({ disabled: true, removed: true }), 'Reload required: Scripts disabled and removed');
});

// ---- Manual scripts (`@run-at context-menu`) ----

test('a manual script on the page is listed under Manual, not run, with Run this script', () => {
  const v = view({
    st: state(),
    scripts: [script('man', 'A', { manual: true }), script('man-off', 'A', { manual: true, enabled: false })],
  });
  assert.deepEqual(v.enabled, []);
  assert.deepEqual(names(v.manual), ['A: man=NOT_RUN']);
  assert.equal(v.manual[0].rows[0].runnable, true);
  // Turned off: in Disabled, with nothing to run.
  assert.deepEqual(names(v.disabled), ['A: man-off=null']);
  assert.equal(v.disabled[0].rows[0].runnable, undefined);
  // Nothing expects it to run, so a reload has nothing to fix.
  assert.equal(v.banner, null);
});

test('a manual script that ran shows its outcome, and how many times it ran', () => {
  const v = view({
    st: state({
      actual: { man: { state: 'started', name: 'man' }, bad: { state: 'error', name: 'bad', message: 'Boom' } },
      manualRuns: { man: 2, bad: 1 },
    }),
    scripts: [script('man', 'A', { manual: true }), script('bad', 'A', { manual: true })],
    commands: new Map([['man', [{ commandId: 'c1', name: 'Clear' }]]]),
  });
  assert.deepEqual(names(v.manual), ['A: bad=ERROR, man=OK']);
  const man = v.manual[0].rows.find((r) => r.id === 'man');
  assert.match(man.tooltip, /^Ran 2 times on this page\n/);
  assert.deepEqual(man.commands.map((c) => c.name), ['Clear']);
  assert.equal(man.runnable, true);
  assert.equal(v.banner, null);
});

test('a manual script turned off after it ran is still running, under Manual', () => {
  const v = view({
    st: state({ actual: { man: { state: 'started', name: 'man' } }, manualRuns: { man: 1 } }),
    scripts: [script('man', 'A', { manual: true, enabled: false })],
  });
  assert.deepEqual(names(v.manual), ['A: man=STILL_RUNNING']);
  assert.equal(v.manual[0].rows[0].runnable, undefined);
});

test('no Run this script where the worker wouldn\'t run it (an sm-dev tab, or a URL its rules miss)', () => {
  const v = view({
    st: state({ actual: { man: { state: 'started', name: 'man' } }, manualRuns: { man: 1 } }),
    scripts: [script('man', 'A', { manual: true })],
    runnable: [],
  });
  assert.deepEqual(names(v.manual), ['A: man=OK']);
  assert.equal(v.manual[0].rows[0].runnable, undefined);
});

test('in a tab an sm-dev run controls, a manual script it keeps out is Not loaded, with no Run', () => {
  const v = view({
    st: state({ smDevAllow: null, smDevRun: 'r1' }),
    scripts: [script('man', 'A', { manual: true })],
    runnable: [],
  });
  assert.deepEqual(names(v.manual), ['A: man=NOT_LOADED']);
  assert.match(v.manual[0].rows[0].tooltip, /^Not run: the sm-dev run controlling this tab kept it out\n/);
  assert.equal(v.manual[0].rows[0].runnable, undefined);
});

test('a page loaded before the extension started: Reload, with a reload banner', () => {
  const v = view({
    st: state({ matches: [m('a')], loadMatchIds: ['a'], loadedBefore: true }),
    scripts: [script('a', 'A'), script('later', 'A')],
    matching: ['a', 'later'],
  });
  // One enabled since the extension started was never going to run: Reload to run.
  assert.deepEqual(names(v.enabled), ['A: a=UNTRACKED, later=PENDING']);
  assert.equal(v.banner, 'Reload required: Page loaded before SourceMonkey started');
  assert.equal(
    v.enabled[0].rows[0].tooltip,
    'This page loaded before SourceMonkey started, so its status is unknown. Reload to restart.\nClick to reload the page.',
  );
});

test('a page loaded while user scripts were disabled: Reload, with its own banner', () => {
  const v = view({
    st: state({ matches: [m('a')], loadMatchIds: ['a'], loadedWithoutUserscripts: true }),
    scripts: [script('a', 'A')],
    matching: ['a'],
  });
  assert.deepEqual(names(v.enabled), ['A: a=UNTRACKED']);
  assert.equal(v.banner, 'Reload required: Page loaded while user scripts were disabled');
  assert.equal(
    v.enabled[0].rows[0].tooltip,
    'This page loaded while user scripts were disabled, so its scripts didn\'t run. Reload to run them.\nClick to reload the page.',
  );
});

test('a page loaded while user scripts are still disabled: Not loaded, and no reload banner', () => {
  const v = view({
    st: state({ matches: [m('a')], loadMatchIds: ['a'], loadedWithoutUserscripts: true }),
    scripts: [script('a', 'A')],
    matching: ['a'],
    userScriptsDisabled: true,
  });
  assert.deepEqual(names(v.enabled), ['A: a=NOT_LOADED']);
  assert.equal(v.banner, null);
  assert.equal(v.userScriptsDisabled, true);
  assert.match(v.enabled[0].rows[0].tooltip, /^Not run: user scripts are disabled\n/);
});

test('a script running only in frames is listed under Active in frames, once', () => {
  const v = view({
    st: state({
      matches: [m('top'), m('both')],
      actual: { top: { state: 'started', name: 'top' } },
      loadMatchIds: ['top', 'both'],
      frameRuns: {
        both: { fd1: { state: 'started', name: 'both', frameId: 1, url: 'https://f/' } },
        framed: {
          fd1: { state: 'started', name: 'framed', frameId: 1, url: 'https://f/' },
          fd2: { state: 'started', name: 'framed', frameId: 2, url: 'https://f/' },
        },
      },
    }),
    scripts: [script('top', 'A'), script('both', 'A'), script('framed', 'B')],
    matching: ['top', 'both'],
  });
  // `both` matched the top frame too (and is Missing there): not a
  // frames-only script.
  assert.deepEqual(names(v.enabled), ['A: both=MISSING, top=OK']);
  assert.deepEqual(names(v.frames), ['B: framed=OK']);
  assert.match(v.frames[0].rows[0].tooltip, /^Running in frames on this page/);
});

test('a frames-only script disabled since the page loaded is Still running, in its section', () => {
  const v = view({
    st: state({ frameRuns: { framed: { fd1: { state: 'started', name: 'framed', frameId: 1, url: 'https://f/' } } } }),
    scripts: [script('framed', 'A', { enabled: false })],
    matching: [],
  });
  assert.deepEqual(names(v.frames), ['A: framed=STILL_RUNNING']);
  assert.equal(v.banner, 'Reload required: Scripts disabled');
});

// ---- Run now (docs/run-now.md) ----

const runItem = (v, id) => [...v.enabled, ...v.frames, ...v.disabled].flatMap((g) => g.rows).find((r) => r.id === id)?.runNow;

test('Run now: offered on scripts that haven\'t started here, and on disabled ones', () => {
  const v = view({
    st: state({
      matches: [m('kept'), m('missing'), m('ran')],
      actual: { ran: { state: 'started', name: 'ran' } },
      loadMatchIds: ['kept', 'missing', 'ran'],
      skipWithout: 'kept',
    }),
    scripts: [script('kept', 'A'), script('missing', 'A'), script('ran', 'A'), script('new', 'A'), script('off', 'A', { enabled: false })],
  });
  assert.deepEqual(runItem(v, 'kept'), { kind: 'run', warnings: [] });
  assert.deepEqual(runItem(v, 'missing'), { kind: 'run', warnings: [] });
  assert.deepEqual(runItem(v, 'new'), { kind: 'run', warnings: [] });
  assert.deepEqual(runItem(v, 'off'), { kind: 'run', warnings: [] });
  assert.equal(runItem(v, 'ran'), undefined);
  // The page menu's run of all newly enabled scripts.
  assert.deepEqual(v.runEnabled, { ids: ['new'], warnings: [] });
  assert.equal(v.rerunUpdated, undefined);
});

test('Run now: an updated script is rerun, with its warnings, and joins the page menu\'s rerun', () => {
  const v = view({
    st: state({
      matches: [m('u')],
      actual: { u: { state: 'started', name: 'u' } },
      loadMatchIds: ['u'],
      staleScriptIds: ['u'],
    }),
    scripts: [script('u', 'A', { documentStart: true })],
  });
  assert.deepEqual(runItem(v, 'u'), { kind: 'rerun', warnings: [RUN_NOW_WARNING_DOCUMENT_START, RUN_NOW_WARNING_RERUN] });
  assert.deepEqual(v.rerunUpdated, { ids: ['u'], warnings: [RUN_NOW_WARNING_DOCUMENT_START, RUN_NOW_WARNING_RERUN] });
});

test('Run now: warns about another copy running, and a page loaded before SourceMonkey started', () => {
  const v = view({
    st: state({ matches: [m('a')], actual: { a: { state: 'started', name: 'S' } }, loadMatchIds: ['a'], loadedBefore: true }),
    scripts: [
      script('a', 'A', { identity: 'ns\u0000S', name: 'S' }),
      script('b', 'B', { identity: 'ns\u0000S', name: 'S', enabled: false }),
    ],
    keepIds: new Set(['b']),
  });
  assert.deepEqual(runItem(v, 'b').warnings, [RUN_NOW_WARNING_OTHER_COPY, RUN_NOW_WARNING_LOADED_BEFORE]);
  assert.match(runNowTooltip(runItem(v, 'b').warnings), /^The script may not work as expected:\n• Another copy/);
});

test('Run now: none in an sm-dev tab, for a manual script, or for an invalid one', () => {
  const smDev = view({
    st: state({ matches: [m('a')], loadMatchIds: ['a'], smDevAllow: null }),
    scripts: [script('a', 'A')],
  });
  assert.equal(runItem(smDev, 'a'), undefined);
  const others = view({
    st: state(),
    scripts: [script('man', 'A', { manual: true }), script('bad', 'A', { invalid: 'Broken' })],
  });
  assert.equal(others.manual.flatMap((g) => g.rows)[0].runNow, undefined);
  assert.equal(runItem(others, 'bad'), undefined);
});

test('a disabled script run manually reads Running, with no reload asked for', () => {
  const v = view({
    st: state({ actual: { off: { state: 'started', name: 'off' } }, manualRuns: { off: 1 } }),
    scripts: [script('off', 'A', { enabled: false })],
  });
  assert.deepEqual(names(v.enabled), ['A: off=OK']);
  assert.match(v.enabled[0].rows[0].tooltip, /^Run manually\n/);
  assert.equal(v.banner, null);
});

test('a script rerun manually says so', () => {
  const v = view({
    st: state({
      matches: [m('a')], actual: { a: { state: 'started', name: 'a' } }, loadMatchIds: ['a'],
      manualRuns: { a: 1 }, rerunIds: ['a'],
    }),
    scripts: [script('a', 'A')],
  });
  assert.match(v.enabled[0].rows[0].tooltip, /^Rerun manually\n/);
});
