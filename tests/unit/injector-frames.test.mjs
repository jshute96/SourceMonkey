// Frame targeting: `@noframes` → allFrames:false, everything else →
// allFrames:true (the TM/VM default). See docs/injection.md#frames.
//
// Tests the pure helpers in src/injector.ts (compiled to
// dist/injector.js). The actual per-frame injection is covered by
// tests/e2e/frames.spec.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// buildRegistrationSpec reads chrome.storage at register time (GM
// bindings) and the unknown-@grant path appends to a per-script log.
// Same minimal stub as tests/unit/injector.test.mjs.
const sessionStore = new Map();
globalThis.chrome = globalThis.chrome ?? {
  storage: {
    local: { get: async () => ({}) },
    session: {
      get: async (key) => {
        if (key === null || key === undefined) return Object.fromEntries(sessionStore);
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
  BRIDGE_SCRIPT_ID,
  GM_RUNTIME_SCRIPT_ID,
  buildBridgeSpec,
  buildGmRuntimeSpecs,
  buildRegistrationSpec,
  collectActiveSpecs,
  resolveAllFrames,
} from '../../dist/injector.js';
import { parseHeader } from '../../dist/userscript-header.js';

const header = (...tags) => ({ tags: [{ tag: 'name', value: 'Hello' }, ...tags] });

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
    header: header(),
    matching: { matches: ['https://example.com/*'], excludes: [], includes: [] },
    loadedAt: 0,
    enabled: true,
    ...over,
  };
}

// ---------- resolveAllFrames ----------

test('resolveAllFrames: no @noframes → runs in every matching frame', () => {
  assert.equal(resolveAllFrames(header()), true);
});

test('resolveAllFrames: @noframes → top frame only', () => {
  assert.equal(resolveAllFrames(header({ tag: 'noframes', value: '' })), false);
});

test('resolveAllFrames: @noframes is a flag — any value still disables frames', () => {
  // TM never parses a value here, so `@noframes false` is `@noframes`.
  // Reading it as a boolean would silently do the opposite of what
  // both TM and the script's own author expect.
  assert.equal(resolveAllFrames(header({ tag: 'noframes', value: 'false' })), false);
  assert.equal(resolveAllFrames(header({ tag: 'noframes', value: '0' })), false);
});

test('resolveAllFrames: a header written `// @NoFrames` still disables frames', () => {
  // `hasTag` lowercases only the *query*, so the case-insensitivity
  // lives in parseHeader. Go through the real parser rather than a
  // hand-built header, which is the only way this asserts anything.
  const header = parseHeader([
    '// ==UserScript==',
    '// @name        Mixed Case',
    '// @NoFrames',
    '// ==/UserScript==',
  ].join('\n'));
  assert.equal(resolveAllFrames(header), false);
});

test('resolveAllFrames: a headerless script gets the default', () => {
  assert.equal(resolveAllFrames(null), true);
  assert.equal(resolveAllFrames(undefined), true);
});

// ---------- buildRegistrationSpec ----------

test('buildRegistrationSpec: sets allFrames explicitly, not by omission', async () => {
  // Chrome's own default is false, so an omitted field would be
  // top-frame-only. The field must always be present.
  const spec = await buildRegistrationSpec(makeScript());
  assert.equal(spec.allFrames, true);
  assert.ok(Object.prototype.hasOwnProperty.call(spec, 'allFrames'));
});

test('buildRegistrationSpec: @noframes → allFrames false', async () => {
  const spec = await buildRegistrationSpec(makeScript({
    header: header({ tag: 'noframes', value: '' }),
  }));
  assert.equal(spec.allFrames, false);
});

test('buildRegistrationSpec: frame targeting is independent of world and run-at', async () => {
  // @noframes composes with everything else; a MAIN-world
  // document-start script honours it just the same.
  const spec = await buildRegistrationSpec(makeScript({
    header: header(
      { tag: 'noframes', value: '' },
      { tag: 'grant', value: 'none' },
      { tag: 'run-at', value: 'document-start' },
    ),
  }));
  assert.equal(spec.allFrames, false);
  assert.equal(spec.world, 'MAIN');
  assert.equal(spec.runAt, 'document_start');
});

test('collectActiveSpecs: per-script frame targeting survives the batch build', async () => {
  const collections = new Map([['collection-1', { id: 'collection-1', enabled: true }]]);
  const { specs } = await collectActiveSpecs([
    makeScript({ id: 'frames' }),
    makeScript({ id: 'noframes', header: header({ tag: 'noframes', value: '' }) }),
  ], collections);
  const byId = new Map(specs.map((s) => [s.id, s]));
  assert.equal(byId.get('frames').allFrames, true);
  assert.equal(byId.get('noframes').allFrames, false);
});

// ---------- helper registrations (bridge + GM runtime) ----------
//
// Both install per-frame globals, so they have to reach the frames the
// user scripts reach — otherwise a MAIN-world script in an iframe loses
// every telemetry report and a USER_SCRIPT-world one ReferenceErrors on
// its first GM_* call.

const spec = (over) => ({
  id: 'x', world: 'USER_SCRIPT', matches: ['https://x/*'],
  js: [{ code: '' }], runAt: 'document_start', allFrames: true, ...over,
});

test('buildBridgeSpec: follows the active set into frames', () => {
  const bridge = buildBridgeSpec([spec({ world: 'MAIN' })]);
  assert.equal(bridge.id, BRIDGE_SCRIPT_ID);
  assert.equal(bridge.allFrames, true);
});

test('buildBridgeSpec: stays top-frame-only when every script is @noframes', () => {
  // The helpers register at <all_urls>, so this is the difference
  // between injecting into every ad iframe on the web and not.
  const bridge = buildBridgeSpec([spec({ world: 'MAIN', allFrames: false })]);
  assert.equal(bridge.allFrames, false);
});

test('buildBridgeSpec: one frame-running script is enough', () => {
  const bridge = buildBridgeSpec([
    spec({ id: 'a', world: 'MAIN', allFrames: false }),
    spec({ id: 'b', world: 'MAIN', allFrames: true }),
  ]);
  assert.equal(bridge.allFrames, true);
});

// The runtime's scope is the per-world union `collectActiveSpecs`
// derives from the scripts that need it, so frame scope is asserted on
// that union and on the spec built from it.
const grantsStorage = ({ tags = [], ...over } = {}) => makeScript({
  header: header({ tag: 'grant', value: 'GM_getValue' }, ...tags),
  ...over,
});

test('buildGmRuntimeSpecs: follows the active set into frames', async () => {
  const collections = new Map([['collection-1', { id: 'collection-1', enabled: true }]]);
  const { gmRuntimeScope } = await collectActiveSpecs([grantsStorage()], collections);
  assert.equal(gmRuntimeScope.get('USER_SCRIPT').allFrames, true);
  const [rt] = buildGmRuntimeSpecs(gmRuntimeScope);
  assert.equal(rt.id, GM_RUNTIME_SCRIPT_ID);
  assert.equal(rt.allFrames, true);
});

test('buildGmRuntimeSpecs: stays top-frame-only when every script is @noframes', async () => {
  const collections = new Map([['collection-1', { id: 'collection-1', enabled: true }]]);
  const { gmRuntimeScope } = await collectActiveSpecs([
    grantsStorage({ tags: [{ tag: 'noframes', value: '' }] }),
  ], collections);
  assert.equal(gmRuntimeScope.get('USER_SCRIPT').allFrames, false);
  const [rt] = buildGmRuntimeSpecs(gmRuntimeScope);
  assert.equal(rt.allFrames, false);
});

test('buildGmRuntimeSpecs: one frame-running script is enough', async () => {
  const collections = new Map([['collection-1', { id: 'collection-1', enabled: true }]]);
  const { gmRuntimeScope } = await collectActiveSpecs([
    grantsStorage({ id: 'a', tags: [{ tag: 'noframes', value: '' }] }),
    grantsStorage({ id: 'b' }),
  ], collections);
  const [rt] = buildGmRuntimeSpecs(gmRuntimeScope);
  assert.equal(rt.allFrames, true);
});
