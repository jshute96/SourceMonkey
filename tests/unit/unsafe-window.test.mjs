// Tests for the `unsafeWindow` grant.
//
// `unsafeWindow` is defined as the PAGE's window object. In Chrome that
// only exists in MAIN world, so granting it is a world request, not
// just a binding request. These tests pin the three pieces that make
// that true:
//
//   1. resolveWorld sends `@grant unsafeWindow` scripts to MAIN.
//   2. The rest of the GM_* surface is still emitted there, and the
//      shared runtime is registered in MAIN so those bindings resolve.
//   3. The one case that can't work — `@inject-into content` pinning
//      the script to the isolated world — is diagnosed instead of
//      silently answering with the wrong window.
//
// See docs/injection.md#unsafewindow-forces-main-world.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Same chrome stub shape as injector.test.mjs — buildRegistrationSpec
// reaches into chrome.storage for the per-script log.
const sessionStore = new Map();
globalThis.chrome = globalThis.chrome ?? {
  storage: {
    local: { get: async () => ({}) },
    session: {
      get: async (key) => {
        if (key == null) return Object.fromEntries(sessionStore);
        const keys = Array.isArray(key) ? key : [key];
        const out = {};
        for (const k of keys) if (sessionStore.has(k)) out[k] = sessionStore.get(k);
        return out;
      },
      set: async (obj) => { for (const [k, v] of Object.entries(obj)) sessionStore.set(k, v); },
      remove: async (key) => {
        for (const k of (Array.isArray(key) ? key : [key])) sessionStore.delete(k);
      },
    },
  },
};

import {
  GM_RUNTIME_MAIN_SCRIPT_ID,
  GM_RUNTIME_SCRIPT_ID,
  buildGmRuntimeSpecs,
  buildRegistrationSpec,
  collectActiveSpecs,
  grantsUnsafeWindow,
  needsGmRuntime,
  resolveWorld,
} from '../../dist/injector.js';
import { emitGmBindings } from '../../dist/gm-bindings.js';
import { extractStartupLogs } from '../../dist/script-store.js';
import { WRAPPER_BRIDGE, WRAPPER_GM_RUNTIME } from '../../dist/generated-wrappers.js';

function makeHeader(tags) {
  return { tags };
}

function grantHeader(...grants) {
  return makeHeader([
    { tag: 'name', value: 'X' },
    ...grants.map((g) => ({ tag: 'grant', value: g })),
  ]);
}

function makeScript(over = {}) {
  return {
    id: 'script-1',
    sourceId: 'source-1',
    relativePath: 'a.user.js',
    fileUrl: 'file:///a.user.js',
    status: 'ok',
    size: 10,
    headerText: '',
    bodyText: 'console.log("hi");',
    header: grantHeader('unsafeWindow'),
    matching: { matches: ['https://example.com/*'], excludes: [], includes: [] },
    loadedAt: 0,
    enabled: true,
    ...over,
  };
}

// ---------- grantsUnsafeWindow ----------

test('grantsUnsafeWindow: recognizes the grant, ignores unrelated ones', () => {
  assert.equal(grantsUnsafeWindow(grantHeader('unsafeWindow')), true);
  assert.equal(grantsUnsafeWindow(grantHeader('GM_setValue', 'unsafeWindow')), true);
  assert.equal(grantsUnsafeWindow(grantHeader('GM_setValue')), false);
  assert.equal(grantsUnsafeWindow(grantHeader('none')), false);
  assert.equal(grantsUnsafeWindow(makeHeader([{ tag: 'name', value: 'X' }])), false);
  assert.equal(grantsUnsafeWindow(null), false);
});

test('grantsUnsafeWindow: canonicalization is exact — no case folding', () => {
  // TM/VM treat @grant names as case-sensitive, and so does our
  // catalog. `unsafewindow` is simply an unknown grant.
  assert.equal(grantsUnsafeWindow(grantHeader('unsafewindow')), false);
});

// ---------- resolveWorld ----------

test('resolveWorld: @grant unsafeWindow → MAIN (that is where the page window is)', () => {
  assert.equal(resolveWorld(grantHeader('unsafeWindow')), 'MAIN');
});

test('resolveWorld: unsafeWindow alongside real GM_* grants still → MAIN', () => {
  // The motivating case: reaching page globals AND persisting state.
  // Before this change the GM_* grants alone pinned the script to
  // USER_SCRIPT, where unsafeWindow silently could not work.
  assert.equal(
    resolveWorld(grantHeader('unsafeWindow', 'GM_setValue', 'GM_xmlhttpRequest')),
    'MAIN',
  );
});

test('resolveWorld: @inject-into content beats the unsafeWindow grant', () => {
  const h = makeHeader([
    { tag: 'inject-into', value: 'content' },
    { tag: 'grant', value: 'unsafeWindow' },
  ]);
  assert.equal(resolveWorld(h), 'USER_SCRIPT');
});

test('resolveWorld: GM_* grants without unsafeWindow still → USER_SCRIPT', () => {
  assert.equal(resolveWorld(grantHeader('GM_setValue')), 'USER_SCRIPT');
  assert.equal(resolveWorld(grantHeader('GM.setValue')), 'USER_SCRIPT');
});

test('resolveWorld: mixing @grant none with unsafeWindow keeps the pre-existing USER_SCRIPT answer', () => {
  // Documenting existing behavior, not endorsing it. `resolveGrants`
  // says a `none` line anywhere wins (so this script gets NO bindings),
  // but `resolveWorld` only takes the MAIN branch when EVERY line is
  // `none` — so the script lands isolated with nothing. Deliberately
  // left alone here: it is a pre-existing inconsistency in the
  // `none`-plus-something case, it has its own test in
  // injector.test.mjs, and zero of the top-2000 GreasyFork scripts
  // pair `none` with `unsafeWindow` (4 pair it with anything at all).
  // Called out as an open question on the PR instead.
  assert.equal(resolveWorld(grantHeader('none', 'unsafeWindow')), 'USER_SCRIPT');
});

// ---------- needsGmRuntime ----------

test('needsGmRuntime: false when nothing but GM_info / unsafeWindow is granted', () => {
  // Both are satisfied without `window.__SM_GM__` — GM_info is a baked
  // literal, unsafeWindow is a plain `window` alias. Keeping the
  // runtime off these pages is what stops `@grant none` MAIN-world
  // scripts from putting extension machinery on the page.
  assert.equal(needsGmRuntime(makeHeader([{ tag: 'name', value: 'X' }])), false);
  assert.equal(needsGmRuntime(grantHeader('none')), false);
  assert.equal(needsGmRuntime(grantHeader('unsafeWindow')), false);
  assert.equal(needsGmRuntime(grantHeader('GM_info')), false);
  assert.equal(needsGmRuntime(grantHeader('unsafeWindow', 'GM_info')), false);
  assert.equal(needsGmRuntime(null), false);
});

test('needsGmRuntime: true as soon as a runtime-backed API is granted', () => {
  assert.equal(needsGmRuntime(grantHeader('unsafeWindow', 'GM_setValue')), true);
  assert.equal(needsGmRuntime(grantHeader('GM_addStyle')), true);
  assert.equal(needsGmRuntime(grantHeader('GM.xmlHttpRequest')), true);
});

test('needsGmRuntime: unknown grants alone do not pull in the runtime', () => {
  assert.equal(needsGmRuntime(grantHeader('GM_bogusApi')), false);
});

// ---------- binding emission ----------

const INFO = {
  scriptId: 'script-1',
  name: 'X',
  matches: [],
  includes: [],
  excludes: [],
  grants: ['unsafeWindow'],
  scriptMetaStr: '',
  scriptHandlerVersion: '0.0.0',
  resources: {},
};

test('emitGmBindings: unsafeWindow is a plain window alias, not a stub', () => {
  const { js } = emitGmBindings(['unsafeWindow'], INFO);
  assert.match(js, /const unsafeWindow = window;/);
  // It must NOT go through the notImplemented fall-through — that
  // would throw on first use.
  assert.doesNotMatch(js, /notImplemented\("unsafeWindow"\)/);
});

test('emitGmBindings: unsafeWindow gets no GM. alias (matches TM/VM)', () => {
  const { js } = emitGmBindings(['unsafeWindow'], INFO);
  assert.doesNotMatch(js, /unsafeWindow:/);
});

// ---------- registration ----------

test('buildRegistrationSpec: an unsafeWindow script registers in MAIN world', async () => {
  const spec = await buildRegistrationSpec(makeScript());
  assert.equal(spec.world, 'MAIN');
});

test('buildRegistrationSpec: MAIN-world scripts get REAL GM_* bindings, not just GM_info', async () => {
  const spec = await buildRegistrationSpec(makeScript({
    header: grantHeader('unsafeWindow', 'GM_setValue', 'GM_getValue'),
  }));
  assert.equal(spec.world, 'MAIN');
  const combined = spec.js[2].code;
  assert.match(combined, /const unsafeWindow = window;/);
  // The bodies delegate to the shared runtime, which is registered in
  // MAIN too — so these resolve rather than ReferenceError.
  assert.match(combined, /const GM_setValue = function[^]*__SM_GM__\.storage\.set/);
  assert.match(combined, /const GM_getValue = function[^]*__SM_GM__\.storage\.get/);
  assert.match(combined, /const GM_info = Object\.freeze/);
});

test('buildRegistrationSpec: a storage-granting MAIN script still asks for its snapshot', async () => {
  // needsGmValues drives the sm:check-pending `needsValues` flag; in
  // MAIN world that request rides the bridge and is gated SW-side.
  const spec = await buildRegistrationSpec(makeScript({
    header: grantHeader('unsafeWindow', 'GM_setValue'),
  }));
  assert.match(spec.js[0].code, /"needsGmValues":true/);
});

test('buildRegistrationSpec: @grant none MAIN scripts are unchanged (GM_info only)', async () => {
  const spec = await buildRegistrationSpec(makeScript({ header: grantHeader('none') }));
  assert.equal(spec.world, 'MAIN');
  const combined = spec.js[2].code;
  assert.match(combined, /const GM_info = Object\.freeze/);
  assert.doesNotMatch(combined, /const unsafeWindow/);
  assert.doesNotMatch(combined, /__SM_GM__/);
});

// ---------- runtime registration ----------

function makeSource(over = {}) {
  return { id: 'source-1', path: '/p', lastRefreshedAt: 0, scriptIds: [], enabled: true, ...over };
}

test('collectActiveSpecs: an unsafeWindow + GM_* script asks for the MAIN runtime', async () => {
  const { specs, gmRuntimeWorlds } = await collectActiveSpecs(
    [makeScript({ header: grantHeader('unsafeWindow', 'GM_setValue') })],
    new Map([['source-1', makeSource()]]),
  );
  assert.equal(specs.length, 1);
  assert.deepEqual([...gmRuntimeWorlds], ['MAIN']);
});

test('collectActiveSpecs: unsafeWindow alone needs no runtime anywhere', async () => {
  const { gmRuntimeWorlds } = await collectActiveSpecs(
    [makeScript({ header: grantHeader('unsafeWindow') })],
    new Map([['source-1', makeSource()]]),
  );
  assert.deepEqual([...gmRuntimeWorlds], []);
});

test('collectActiveSpecs: both worlds can need the runtime at once', async () => {
  const { gmRuntimeWorlds } = await collectActiveSpecs(
    [
      makeScript({ id: 's1', header: grantHeader('unsafeWindow', 'GM_addStyle') }),
      makeScript({ id: 's2', header: grantHeader('GM_addStyle') }),
    ],
    new Map([['source-1', makeSource()]]),
  );
  assert.deepEqual([...gmRuntimeWorlds].sort(), ['MAIN', 'USER_SCRIPT']);
});

test('buildGmRuntimeSpecs: one registration per requested world, distinct ids', () => {
  assert.deepEqual(buildGmRuntimeSpecs(new Set()), []);

  const userOnly = buildGmRuntimeSpecs(new Set(['USER_SCRIPT']));
  assert.equal(userOnly.length, 1);
  assert.equal(userOnly[0].id, GM_RUNTIME_SCRIPT_ID);
  assert.equal(userOnly[0].world, 'USER_SCRIPT');

  const both = buildGmRuntimeSpecs(new Set(['MAIN', 'USER_SCRIPT']));
  assert.deepEqual(both.map((s) => s.world), ['USER_SCRIPT', 'MAIN']);
  assert.deepEqual(both.map((s) => s.id), [GM_RUNTIME_SCRIPT_ID, GM_RUNTIME_MAIN_SCRIPT_ID]);
  // Same source in both worlds — one implementation, two transports.
  assert.equal(both[0].js[0].code, both[1].js[0].code);
  for (const s of both) {
    assert.deepEqual(s.matches, ['<all_urls>']);
    assert.equal(s.runAt, 'document_start');
  }
});

// ---------- the case that can't work ----------

test('extractStartupLogs: warns on @grant unsafeWindow + @inject-into content', () => {
  const logs = extractStartupLogs(makeHeader([
    { tag: 'inject-into', value: 'content' },
    { tag: 'grant', value: 'unsafeWindow' },
  ]));
  assert.equal(logs.length, 1);
  assert.equal(logs[0].level, 'warn');
  assert.match(logs[0].message, /unsafeWindow/);
  assert.match(logs[0].message, /NOT the page/);
});

test('extractStartupLogs: @inject-into value is matched case-insensitively', () => {
  const logs = extractStartupLogs(makeHeader([
    { tag: 'inject-into', value: '  CONTENT ' },
    { tag: 'grant', value: 'unsafeWindow' },
  ]));
  assert.equal(logs.length, 1);
});

test('extractStartupLogs: silent for the combinations that do work', () => {
  assert.deepEqual(extractStartupLogs(grantHeader('unsafeWindow')), []);
  assert.deepEqual(extractStartupLogs(makeHeader([
    { tag: 'inject-into', value: 'page' },
    { tag: 'grant', value: 'unsafeWindow' },
  ])), []);
  assert.deepEqual(extractStartupLogs(makeHeader([
    { tag: 'inject-into', value: 'content' },
    { tag: 'grant', value: 'GM_setValue' },
  ])), []);
});

// ---------- wrapper plumbing ----------
//
// The MAIN-world runtime is useless without the bridge carrying its
// traffic both ways. These assert the two halves agree on the wire
// markers, since a typo in either would be a silent no-op at runtime.

test('generated wrappers: runtime and bridge agree on the postMessage markers', () => {
  for (const marker of ['sourcemonkey-bridge', 'sourcemonkey-bridge-reply', 'sourcemonkey-bridge-push']) {
    assert.ok(WRAPPER_GM_RUNTIME.includes(marker), `runtime is missing ${marker}`);
    assert.ok(WRAPPER_BRIDGE.includes(marker), `bridge is missing ${marker}`);
  }
});

test('generated wrappers: the bridge relays every GM_* request type the runtime sends', () => {
  // Request types the runtime originates. If a new one is added to the
  // runtime without being allowlisted in the bridge, MAIN-world calls
  // fail silently — the bridge just drops them.
  for (const type of [
    'sm:gm-batch-write', 'sm:gm-xhr-start', 'sm:gm-xhr-abort',
    'sm:gm-tab-open', 'sm:gm-tab-close', 'sm:gm-notification-show',
    'sm:gm-menu-register', 'sm:gm-menu-unregister', 'sm:gm-log',
  ]) {
    assert.ok(WRAPPER_GM_RUNTIME.includes(type), `runtime does not send ${type}`);
    assert.ok(WRAPPER_BRIDGE.includes(type), `bridge does not relay ${type}`);
  }
});

test('generated wrappers: the bridge pushes back every SW-originated type the runtime handles', () => {
  for (const type of [
    'sm:gm-value-update', 'sm:gm-xhr-event', 'sm:gm-tab-closed',
    'sm:gm-notification-event', 'sm:gm-menu-fire',
  ]) {
    assert.ok(WRAPPER_GM_RUNTIME.includes(type), `runtime does not handle ${type}`);
    assert.ok(WRAPPER_BRIDGE.includes(type), `bridge does not push ${type}`);
  }
});
