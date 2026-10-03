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
//   4. A body that names `unsafeWindow` with NO grant line gets the same
//      treatment, because TM and VM both expose the name ungranted. The
//      scan itself is tested in unsafe-window-use.test.mjs.
//
// See docs/injection.md#unsafewindow-forces-main-world.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

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
  NO_PAGE_MATCH,
  buildGmBindingsForScript,
  buildGmRuntimeSpecs,
  buildRegistrationSpec,
  collectActiveSpecs,
  grantsUnsafeWindow,
  needsGmRuntime,
} from '../../dist/injector.js';
import { resolveScriptWorld, resolveWorld } from '../../dist/script-world.js';
import { grantedSubsystems } from '../../dist/gm-api-catalog.js';
import { emitGmBindings } from '../../dist/gm-bindings.js';
import {
  IMPLICIT_UNSAFE_WINDOW_INFO,
  ISOLATED_UNSAFE_WINDOW_WARNING,
  extractStartupLogs,
} from '../../dist/script-store.js';
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
    collectionId: 'collection-1',
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

test('resolveWorld: @grant none wins over other grants, as it does in resolveGrants', () => {
  // One rule in both places: a `none` line anywhere means no bindings
  // AND MAIN world — a plain `@grant none` script, which is how TM
  // reads it. The old rule (MAIN only when every line was `none`) left
  // a mixed script isolated with nothing.
  assert.equal(resolveWorld(grantHeader('none', 'unsafeWindow')), 'MAIN');
  assert.equal(resolveWorld(grantHeader('GM_setValue', 'none')), 'MAIN');
});

test('extractStartupLogs: warns when @grant none overrides other grants', () => {
  const logs = extractStartupLogs(makeHeader([
    { tag: 'grant', value: 'GM_setValue' },
    { tag: 'grant', value: 'none' },
    { tag: 'grant', value: 'unsafeWindow' },
  ]), 'x.user.js');
  assert.equal(logs.length, 1);
  assert.equal(logs[0].level, 'warn');
  assert.match(logs[0].message, /^@grant none overrides @grant GM_setValue, unsafeWindow.*\.$/);
  assert.deepEqual(extractStartupLogs(makeHeader([{ tag: 'grant', value: 'none' }]), 'x.user.js'), []);
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
  passthrough: {},
  requires: [],
  resourceList: [],
  connects: [],
  noframes: false,
  userAgentData: null,
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

function makeCollection(over = {}) {
  return { id: 'collection-1', path: '/p', lastRefreshedAt: 0, scriptIds: [], enabled: true, ...over };
}

test('collectActiveSpecs: an unsafeWindow + GM_* script asks for the MAIN runtime', async () => {
  const { specs, gmRuntimeScope } = await collectActiveSpecs(
    [makeScript({ header: grantHeader('unsafeWindow', 'GM_setValue') })],
    new Map([['collection-1', makeCollection()]]),
  );
  assert.equal(specs.length, 1);
  assert.deepEqual([...gmRuntimeScope.keys()], ['MAIN']);
  // Scoped to the script's own patterns, not <all_urls> — in MAIN the
  // runtime is a page-visible global, so it goes only where its
  // scripts go.
  assert.deepEqual([...gmRuntimeScope.get('MAIN').matches], ['https://example.com/*']);
});

test('collectActiveSpecs: unsafeWindow alone needs no runtime anywhere', async () => {
  const { gmRuntimeScope } = await collectActiveSpecs(
    [makeScript({ header: grantHeader('unsafeWindow') })],
    new Map([['collection-1', makeCollection()]]),
  );
  assert.equal(gmRuntimeScope.size, 0);
});

test('collectActiveSpecs: both worlds can need the runtime at once, each with its own scope', async () => {
  const { gmRuntimeScope } = await collectActiveSpecs(
    [
      makeScript({
        id: 's1',
        header: grantHeader('unsafeWindow', 'GM_addStyle'),
        matching: { matches: ['https://main.example/*'], excludes: [], includes: [] },
      }),
      makeScript({
        id: 's2',
        header: grantHeader('GM_addStyle'),
        matching: { matches: ['https://iso.example/*'], excludes: [], includes: ['*://glob/*'] },
      }),
    ],
    new Map([['collection-1', makeCollection()]]),
  );
  assert.deepEqual([...gmRuntimeScope.keys()].sort(), ['MAIN', 'USER_SCRIPT']);
  assert.deepEqual([...gmRuntimeScope.get('MAIN').matches], ['https://main.example/*']);
  // A spec with globs carries NO_PAGE_MATCH, so the runtime's scope
  // does too: it registers on the same globs.
  assert.deepEqual([...gmRuntimeScope.get('USER_SCRIPT').matches], ['https://iso.example/*', NO_PAGE_MATCH]);
  assert.deepEqual([...gmRuntimeScope.get('USER_SCRIPT').includeGlobs], ['*://glob/*']);
});

test('collectActiveSpecs: the scope unions every script in the world', async () => {
  const { gmRuntimeScope } = await collectActiveSpecs(
    [
      makeScript({
        id: 's1',
        header: grantHeader('unsafeWindow', 'GM_addStyle'),
        matching: { matches: ['https://a.example/*'], excludes: [], includes: [] },
      }),
      makeScript({
        id: 's2',
        header: grantHeader('unsafeWindow', 'GM_setValue'),
        matching: { matches: ['https://b.example/*'], excludes: [], includes: [] },
      }),
    ],
    new Map([['collection-1', makeCollection()]]),
  );
  assert.deepEqual(
    [...gmRuntimeScope.get('MAIN').matches].sort(),
    ['https://a.example/*', 'https://b.example/*'],
  );
});

function scopeOf(matches, includeGlobs = []) {
  return { matches: new Set(matches), includeGlobs: new Set(includeGlobs) };
}

test('buildGmRuntimeSpecs: one registration per requested world, distinct ids, scoped patterns', () => {
  assert.deepEqual(buildGmRuntimeSpecs(new Map()), []);

  const userOnly = buildGmRuntimeSpecs(new Map([
    ['USER_SCRIPT', scopeOf(['https://x.example/*'])],
  ]));
  assert.equal(userOnly.length, 1);
  assert.equal(userOnly[0].id, GM_RUNTIME_SCRIPT_ID);
  assert.equal(userOnly[0].world, 'USER_SCRIPT');
  assert.deepEqual(userOnly[0].matches, ['https://x.example/*']);

  const both = buildGmRuntimeSpecs(new Map([
    ['MAIN', scopeOf(['https://m.example/*'])],
    ['USER_SCRIPT', scopeOf([], ['*://glob/*'])],
  ]));
  assert.deepEqual(both.map((s) => s.world), ['USER_SCRIPT', 'MAIN']);
  assert.deepEqual(both.map((s) => s.id), [GM_RUNTIME_SCRIPT_ID, GM_RUNTIME_MAIN_SCRIPT_ID]);
  // Same source in both worlds — one implementation, two transports.
  assert.equal(both[0].js[0].code, both[1].js[0].code);
  // Glob-only scope emits includeGlobs and no matches.
  assert.equal(both[0].matches, undefined);
  assert.deepEqual(both[0].includeGlobs, ['*://glob/*']);
  for (const s of both) assert.equal(s.runAt, 'document_start');
});

test('buildGmRuntimeSpecs: an empty scope still registers something Chrome accepts', () => {
  // Unreachable in production (a script with no patterns never gets a
  // spec), but a registration with neither `matches` nor
  // `includeGlobs` is rejected — and one rejection takes the whole
  // batch, and every GM_* call with it.
  const [spec] = buildGmRuntimeSpecs(new Map([['MAIN', scopeOf([])]]));
  assert.deepEqual(spec.matches, ['<all_urls>']);
});

// ---------- the case that can't work ----------

test('extractStartupLogs: warns on @grant unsafeWindow + @inject-into content', () => {
  const logs = extractStartupLogs(makeHeader([
    { tag: 'inject-into', value: 'content' },
    { tag: 'grant', value: 'unsafeWindow' },
  ]));
  assert.equal(logs.length, 1);
  assert.equal(logs[0].level, 'warn');
  assert.equal(logs[0].message, ISOLATED_UNSAFE_WINDOW_WARNING);
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

// ---------- unsafeWindow without a grant ----------
//
// TM and VM both hand out `unsafeWindow` with no `@grant` line, so a
// script written against either may never declare it — 112 of the
// GreasyFork top 2000 don't. `StoredScript.usesUnsafeWindow` (from the
// load-time body scan) makes those scripts behave as though they had.

test('resolveScriptWorld: an ungranted reference moves the script to MAIN', () => {
  const script = makeScript({ header: grantHeader('GM_setValue'), usesUnsafeWindow: true });
  assert.equal(resolveScriptWorld(script), 'MAIN');
  // Without the flag it is the isolated world, as before.
  assert.equal(resolveScriptWorld({ ...script, usesUnsafeWindow: undefined }), 'USER_SCRIPT');
  // And the header-only form still answers on the header alone, which is
  // why production code goes through resolveScriptWorld.
  assert.equal(resolveWorld(script.header), 'USER_SCRIPT');
});

test('resolveScriptWorld: @inject-into content still beats the reference', () => {
  const script = makeScript({
    header: makeHeader([
      { tag: 'inject-into', value: 'content' },
      { tag: 'grant', value: 'GM_setValue' },
    ]),
    usesUnsafeWindow: true,
  });
  assert.equal(resolveScriptWorld(script), 'USER_SCRIPT');
});

test('buildRegistrationSpec: the spec Chrome gets says MAIN', async () => {
  // The world reaches Chrome through the spec, so the flag has to
  // survive the whole build, not just resolveScriptWorld.
  const spec = await buildRegistrationSpec(
    makeScript({ header: grantHeader('GM_setValue'), usesUnsafeWindow: true }),
    '0.0.0',
    'a',
  );
  assert.equal(spec.world, 'MAIN');
});

test('buildGmBindingsForScript: an ungranted reference still gets the binding', async () => {
  // Without it the script would reach MAIN world and then throw a
  // ReferenceError on the name that took it there.
  const { js } = await buildGmBindingsForScript(
    makeScript({ header: grantHeader('GM_setValue'), usesUnsafeWindow: true }),
    '0.0.0',
  );
  assert.match(js, /const unsafeWindow = window;/);
  // GM_info reports the script's own metadata, not our inference.
  assert.doesNotMatch(js, /"grant":\[[^\]]*unsafeWindow/);
  assert.match(js, /"grant":\["GM_setValue"\]/);
});

test('buildGmBindingsForScript: @grant none plus a reference gets the alias and nothing else', async () => {
  // `@grant none` is already MAIN world, so the only thing missing was
  // the binding. It must not drag any GM_* API back in.
  const { js } = await buildGmBindingsForScript(
    makeScript({ header: grantHeader('none', 'GM_setValue'), usesUnsafeWindow: true }),
    '0.0.0',
  );
  assert.match(js, /const unsafeWindow = window;/);
  assert.doesNotMatch(js, /const GM_setValue/);
});

test('buildGmBindingsForScript: a @require that declares the name keeps our binding', async () => {
  // The user program runs in a scope nested inside our bindings, so the
  // library's own `const unsafeWindow` shadows ours instead of being a
  // duplicate declaration. Nothing needs to step aside.
  const script = makeScript({
    header: grantHeader('GM_setValue'),
    usesUnsafeWindow: true,
    requires: [{ url: 'https://lib/x.js', source: 'const unsafeWindow = window.wrappedJSObject || window;' }],
  });
  const { js } = await buildGmBindingsForScript(script, '0.0.0');
  assert.match(js, /const unsafeWindow = window;/);
  assert.equal(resolveScriptWorld(script), 'MAIN');
});

test('an ungranted reference grants no SW-side capability', () => {
  // The bridge gate (`bridgeMayActAs`) checks a relayed request against
  // the script's granted subsystems, and those stay header-derived.
  // `unsafeWindow` has no subsystem to ask for anyway — it is a `window`
  // alias — so this adds a binding and a world, never an API.
  const header = grantHeader('GM_setValue');
  assert.deepEqual([...grantedSubsystems(header)], ['storage']);
});

test('extractStartupLogs: says so at info level when the reference moved the script', () => {
  const logs = extractStartupLogs(grantHeader('GM_setValue'), 'x.user.js', true);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].level, 'info');
  assert.equal(logs[0].message, IMPLICIT_UNSAFE_WINDOW_INFO);
});

test('extractStartupLogs: silent when the script was headed for MAIN anyway', () => {
  // Nothing moved — these scripts only gained a `window` alias.
  assert.deepEqual(extractStartupLogs(makeHeader([{ tag: 'name', value: 'X' }]), 'x.user.js', true), []);
  assert.deepEqual(extractStartupLogs(grantHeader('none'), 'x.user.js', true), []);
  assert.deepEqual(extractStartupLogs(makeHeader([
    { tag: 'inject-into', value: 'page' },
    { tag: 'grant', value: 'GM_setValue' },
  ]), 'x.user.js', true), []);
  // A declared grant is the author saying it out loud already.
  assert.deepEqual(extractStartupLogs(grantHeader('unsafeWindow', 'GM_setValue'), 'x.user.js', true), []);
});

test('extractStartupLogs: a grant-free script pinned isolated is warned too', () => {
  // Reachable only through the implicit path: with no `@grant` lines
  // there was nothing for the old check (which lived inside the
  // grants-present branch) to fire on, and the script still ends up with
  // a binding that is the isolated realm's own window.
  const logs = extractStartupLogs(makeHeader([
    { tag: 'name', value: 'X' },
    { tag: 'inject-into', value: 'content' },
  ]), 'x.user.js', true);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].level, 'warn');
  assert.equal(logs[0].message, ISOLATED_UNSAFE_WINDOW_WARNING);
});

test('buildGmBindingsForScript: a @require that only READS the name keeps our binding', async () => {
  // A library that merely uses the name needs the binding as much as
  // the body does.
  const { js } = await buildGmBindingsForScript(makeScript({
    header: grantHeader('GM_setValue'),
    usesUnsafeWindow: true,
    requires: [{ url: 'https://lib/x.js', source: 'unsafeWindow.hookedByLib = 1;' }],
  }), '0.0.0');
  assert.match(js, /const unsafeWindow = window;/);
});

test('extractStartupLogs: the isolated dead end is one message, grant or not', () => {
  const pinned = makeHeader([
    { tag: 'inject-into', value: 'content' },
    { tag: 'grant', value: 'GM_setValue' },
  ]);
  const logs = extractStartupLogs(pinned, 'x.user.js', true);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].message, ISOLATED_UNSAFE_WINDOW_WARNING);
  // And it isn't said twice when the script both grants and uses it.
  const both = extractStartupLogs(makeHeader([
    { tag: 'inject-into', value: 'content' },
    { tag: 'grant', value: 'unsafeWindow' },
  ]), 'x.user.js', true);
  assert.equal(both.length, 1);
});

// ---------- wrapper plumbing ----------
//
// The MAIN-world runtime is useless without the bridge carrying its
// traffic both ways. These assert the two halves agree on the wire
// markers, since a typo in either would be a silent no-op at runtime.
// One per direction: the request event, and the reply / push
// postMessages coming back.

test('generated wrappers: runtime and bridge agree on the wire markers', () => {
  for (const marker of ['sourcemonkey-bridge-sync', 'sourcemonkey-bridge-reply', 'sourcemonkey-bridge-push']) {
    assert.ok(WRAPPER_GM_RUNTIME.includes(marker), `runtime is missing ${marker}`);
    assert.ok(WRAPPER_BRIDGE.includes(marker), `bridge is missing ${marker}`);
  }
});

// The message types each side names, pulled from the un-minified
// sources rather than listed here — a list would go stale the moment a
// new API landed, and a type the runtime sends but the bridge doesn't
// allowlist fails silently in MAIN world (the bridge just drops it).
const RUNTIME_SRC = readFileSync(new URL('../../src/wrapper-gm-runtime.js', import.meta.url), 'utf8');
const BRIDGE_SRC = readFileSync(new URL('../../src/wrapper-bridge.js', import.meta.url), 'utf8');
const smTypes = (src) => new Set(src.match(/"sm:[a-z-]+"/g).map((m) => JSON.parse(m)));
// Push types are the ones the runtime compares an incoming `msg.type`
// against; everything else it names is a request it originates.
const runtimePushTypes = new Set(
  [...RUNTIME_SRC.matchAll(/msg\.type\s*[!=]==\s*("sm:[a-z-]+")/g)].map((m) => JSON.parse(m[1])),
);
const runtimeRequestTypes = [...smTypes(RUNTIME_SRC)].filter((t) => !runtimePushTypes.has(t));
const bridgeList = (name) => {
  const m = BRIDGE_SRC.match(new RegExp(`var ${name} = \\[([^\\]]*)\\]`));
  assert.ok(m, `bridge has no ${name} list`);
  return new Set(m[1].match(/"sm:[a-z-]+"/g).map((t) => JSON.parse(t)));
};

test('generated wrappers: the bridge relays every GM_* request type the runtime sends', () => {
  const allowed = bridgeList('ALLOWED');
  assert.ok(runtimeRequestTypes.length >= 10, 'extraction found the runtime\'s request types');
  for (const type of runtimeRequestTypes) {
    assert.ok(allowed.has(type), `bridge does not relay ${type}`);
    assert.ok(WRAPPER_GM_RUNTIME.includes(type), `minified runtime lost ${type}`);
  }
});

test('generated wrappers: the bridge pushes back every SW-originated type the runtime handles', () => {
  const pushed = new Set([...bridgeList('PUSHED'), ...bridgeList('PUSHED_ANY_WORLD')]);
  assert.ok(runtimePushTypes.size >= 5, 'extraction found the runtime\'s push handlers');
  for (const type of runtimePushTypes) {
    assert.ok(pushed.has(type), `bridge does not push ${type}`);
    assert.ok(WRAPPER_GM_RUNTIME.includes(type), `minified runtime lost ${type}`);
  }
});

test('generated wrappers: the bridge relays a push only when it is addressed to MAIN', () => {
  // Load-bearing, not a hint: re-posting a push makes its payload
  // readable by the page, and these payloads carry an isolated
  // script's stored values and cross-origin response bodies. Losing
  // this check would be a silent data leak on any page that runs both
  // a MAIN-world and a USER_SCRIPT-world script. The SW stamps the
  // field (`pushWorld` in background.ts).
  assert.match(WRAPPER_BRIDGE, /smWorld\s*!==\s*"MAIN"/);
});
