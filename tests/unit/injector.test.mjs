// Tests for src/injector.ts (compiled to dist/injector.js).
//
// Only the pure helpers are exercised here — the chrome.userScripts
// runtime sync (syncRegistrations) is glue I/O and is covered by the
// e2e smoke layer instead.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// chrome.storage stub — buildGmBindingsForScript reads chrome.storage.local
// at register time for storage-granting scripts to bake in the initial
// cache. The unknown-@grant warning path also appends to a per-script
// log via chrome.storage.session. Unit tests run in plain Node so we
// install a minimal stub for both areas.
const sessionStore = new Map();
globalThis.chrome = globalThis.chrome ?? {
  storage: {
    local: {
      get: async () => ({}),
    },
    session: {
      get: async (key) => (sessionStore.has(key) ? { [key]: sessionStore.get(key) } : {}),
      set: async (obj) => { for (const [k, v] of Object.entries(obj)) sessionStore.set(k, v); },
      remove: async (key) => { sessionStore.delete(key); },
    },
  },
};

import {
  BRIDGE_SCRIPT_ID,
  buildBridgeSpec,
  buildConfigBlob,
  buildRegistrationSpec,
  buildSwapEvalBody,
  collectActiveSpecs,
  composeRequiredBody,
  normalizeDeclaredRunAt,
  resolveWorld,
  wrapMainBodyEntry,
  wrapPreludeEntry,
  wrapRequireEntry,
} from '../../dist/injector.js';
import { WRAPPER_BRIDGE, WRAPPER_PRELUDE } from '../../dist/generated-wrappers.js';

// ---------- normalizeDeclaredRunAt ----------

test('normalizeDeclaredRunAt: recognized values pass through (lowercased)', () => {
  assert.equal(normalizeDeclaredRunAt('document-start'), 'document-start');
  assert.equal(normalizeDeclaredRunAt('document-body'), 'document-body');
  assert.equal(normalizeDeclaredRunAt('document-end'), 'document-end');
  assert.equal(normalizeDeclaredRunAt('document-idle'), 'document-idle');
});

test('normalizeDeclaredRunAt: missing / unknown values default to document-idle', () => {
  assert.equal(normalizeDeclaredRunAt(undefined), 'document-idle');
  assert.equal(normalizeDeclaredRunAt(''), 'document-idle');
  assert.equal(normalizeDeclaredRunAt('context-menu'), 'document-idle');
  assert.equal(normalizeDeclaredRunAt('whatever'), 'document-idle');
});

test('normalizeDeclaredRunAt: case-insensitive', () => {
  assert.equal(normalizeDeclaredRunAt('DOCUMENT-START'), 'document-start');
  assert.equal(normalizeDeclaredRunAt('Document-End'), 'document-end');
});

// ---------- buildConfigBlob ----------

test('buildConfigBlob: emits a queue-or-init call with the cfg object', () => {
  const blob = buildConfigBlob({
    id: 'abc',
    logLabel: 'foo.user.js',
    name: 'Foo',
    sourceUrl: 'sourcemonkey://SourceMonkey/foo/foo.user.js',
    loadedAt: 1737051234567,
    runAt: 'document-idle',
    needsGmValues: false,
    matching: null,
    startupLogs: [],
    requireUrls: [],
  });
  // Both transport branches are present — direct init() when prelude
  // is already loaded, queue-push otherwise.
  assert.match(blob, /self\.__smPrelude\.init/);
  assert.match(blob, /self\.__smCfgQueue=self\.__smCfgQueue\|\|\[\]/);
  // The cfg literal carries the script identity.
  assert.match(blob, /"id":"abc"/);
  assert.match(blob, /"name":"Foo"/);
  assert.match(blob, /"loadedAt":1737051234567/);
  assert.match(blob, /"runAt":"document-idle"/);
  // Trailing sourceURL uses the script's folder under SourceMonkey/.
  assert.match(blob, /sourceURL=sourcemonkey:\/\/SourceMonkey\/foo\/__config\.js/);
});

test('buildConfigBlob: omits matching when null and startupLogs when empty', () => {
  const blob = buildConfigBlob({
    id: 'x', logLabel: 'x.user.js', name: 'X',
    sourceUrl: 'sourcemonkey://SourceMonkey/x/x.user.js',
    loadedAt: 0, runAt: 'document-idle', needsGmValues: false,
    matching: null, startupLogs: [], requireUrls: [],
  });
  assert.doesNotMatch(blob, /"matching"/);
  assert.doesNotMatch(blob, /"startupLogs"/);
  assert.doesNotMatch(blob, /"requireUrls"/);
});

test('buildConfigBlob: serializes matching, startupLogs, requireUrls when present', () => {
  const blob = buildConfigBlob({
    id: 'x', logLabel: 'x.user.js', name: 'X',
    sourceUrl: 'sourcemonkey://SourceMonkey/x/x.user.js',
    loadedAt: 0, runAt: 'document-idle', needsGmValues: false,
    matching: { matches: ['https://e/*'], includes: ['/r/'], excludes: [] },
    startupLogs: [{ level: 'warn', message: 'hi' }],
    requireUrls: ['sourcemonkey://SourceMonkey/x/cdn/a.js'],
  });
  assert.match(blob, /"matching":\{"matches":\["https:\/\/e\/\*"\],"includes":\["\/r\/"\],"excludes":\[\]\}/);
  assert.match(blob, /"startupLogs":\[\{"level":"warn","message":"hi"\}\]/);
  assert.match(blob, /"requireUrls":\["sourcemonkey:\/\/SourceMonkey\/x\/cdn\/a\.js"\]/);
});

// ---------- wrapRequireEntry ----------

test('wrapRequireEntry: prefix on physical line 1; body lines preserved; sourceURL at end', () => {
  // The require body's line N must land at physical line N of the
  // wrapped entry so devtools shows the right line in stack traces.
  const wrapped = wrapRequireEntry({
    scriptId: 'abc',
    source: 'LINE1\nLINE2\nLINE3',
    sourceUrl: 'sourcemonkey://SourceMonkey/foo/cdn/x.js',
  });
  const lines = wrapped.split('\n');
  assert.match(lines[0], /LINE1$/);
  assert.equal(lines[1], 'LINE2');
  assert.equal(lines[2], 'LINE3');
  // The trailing sourceURL comment lives at the very bottom so the
  // engine attributes the whole entry to it.
  assert.ok(wrapped.endsWith('//# sourceURL=sourcemonkey://SourceMonkey/foo/cdn/x.js\n'));
});

test('wrapRequireEntry: gates body on __smActive and routes throws to __smErr', () => {
  const wrapped = wrapRequireEntry({
    scriptId: 'abc',
    source: 'doStuff();',
    sourceUrl: 'sourcemonkey://SourceMonkey/foo/cdn/x.js',
  });
  assert.match(wrapped, /if\(self\.__smActive\("abc"\)\)\{try\{/);
  assert.match(wrapped, /catch\(__smE\)\{self\.__smErr\("abc",__smE\);\}\}/);
});

test('wrapRequireEntry: no exportedNames → no Object.assign tail', () => {
  // Byte-identical to the pre-feature shape so requires without
  // `/* exported */` directives carry no per-require overhead.
  const wrapped = wrapRequireEntry({
    scriptId: 'abc',
    source: 'doStuff();',
    sourceUrl: 'sourcemonkey://SourceMonkey/foo/cdn/x.js',
  });
  assert.doesNotMatch(wrapped, /__smReqScope/);
  assert.doesNotMatch(wrapped, /Object\.assign/);
});

test('wrapRequireEntry: exportedNames → trailing Object.assign onto __smReqScope[id]', () => {
  // The forwarding goes AFTER the body, inside the try, so the body's
  // line N still lands at physical line N — what stack traces need.
  const wrapped = wrapRequireEntry({
    scriptId: 'abc',
    source: 'const on = () => {};\nconst $ = () => {};',
    sourceUrl: 'sourcemonkey://SourceMonkey/foo/cdn/x.js',
    exportedNames: ['on', '$'],
  });
  assert.match(
    wrapped,
    /;Object\.assign\(self\.__smReqScope\["abc"\],\{on,\$\}\);/,
  );
  // Body line numbers unaffected: the body's two lines still land on
  // physical lines 1 and 2 of the wrapped output (the forwarder
  // arrives on line 3, AFTER the body).
  const lines = wrapped.split('\n');
  assert.match(lines[0], /const on = \(\) => \{\};$/);
  assert.match(lines[1], /^const \$ = \(\) => \{\};$/);
});

// ---------- wrapMainBodyEntry ----------

test('wrapMainBodyEntry: head on physical line 1; body lines preserved; sourceURL at end', () => {
  const wrapped = wrapMainBodyEntry({
    scriptId: 'abc',
    sourceUrl: 'sourcemonkey://abc/Foo.user.js',
    body: 'LINE1\nLINE2\nLINE3',
    gmBindings: '',
    gmPrelude: '',
  });
  const lines = wrapped.split('\n');
  // The first physical line ends with the body's first line of code.
  assert.match(lines[0], /LINE1$/);
  assert.equal(lines[1], 'LINE2');
  assert.equal(lines[2], 'LINE3');
  // Closing brace + sourceURL trail.
  assert.ok(wrapped.endsWith('//# sourceURL=sourcemonkey://abc/Foo.user.js\n'));
});

test('wrapMainBodyEntry: defers execution via self.__smRun and exposes per-script vars', () => {
  const wrapped = wrapMainBodyEntry({
    scriptId: 'abc',
    sourceUrl: 'sourcemonkey://abc/Foo.user.js',
    body: '',
    gmBindings: '',
    gmPrelude: '',
  });
  assert.match(wrapped, /self\.__smRun\("abc",function\(__smE\)/);
  // The declaration preamble pulls per-script identity out of the
  // entry the prelude passes in — gm-bindings.ts's emit relies on
  // these names being in scope.
  assert.match(wrapped, /var __smDecision=__smE\.decision/);
  assert.match(wrapped, /var __smName=__smE\.cfg\.name/);
  assert.match(wrapped, /var __smId=__smE\.cfg\.id/);
  assert.match(wrapped, /var __smLoadedAt=__smE\.cfg\.loadedAt/);
  assert.match(wrapped, /var __smSend=self\.__smPrelude\.send/);
});

test('wrapMainBodyEntry: splices gmBindings + gmPrelude before body', () => {
  const wrapped = wrapMainBodyEntry({
    scriptId: 'abc',
    sourceUrl: 'sourcemonkey://abc/Foo.user.js',
    body: 'BODYTOP',
    gmBindings: '/*BIND*/',
    gmPrelude: '/*PRE*/',
  });
  // The order is fixed: declarations → bindings → prelude → body.
  // Everything before the body lives on physical line 1 with the
  // body's first line to preserve line-number alignment.
  const bindPos = wrapped.indexOf('/*BIND*/');
  const prePos = wrapped.indexOf('/*PRE*/');
  const bodyPos = wrapped.indexOf('BODYTOP');
  assert.ok(bindPos > 0 && prePos > bindPos && bodyPos > prePos);
});

test('wrapMainBodyEntry: no requireExports → no destructure emitted', () => {
  const wrapped = wrapMainBodyEntry({
    scriptId: 'abc',
    sourceUrl: 'sourcemonkey://abc/Foo.user.js',
    body: 'BODYTOP',
    gmBindings: '',
    gmPrelude: '',
  });
  assert.doesNotMatch(wrapped, /__smReqScope/);
});

test('wrapMainBodyEntry: requireExports → destructure from __smReqScope[id] on the head line', () => {
  // Destructure must land on physical line 1 (alongside declPreamble +
  // gmBindings + gmPrelude) so the body's line 1 stays at physical
  // line 1. Anything else breaks the stack-trace line contract.
  const wrapped = wrapMainBodyEntry({
    scriptId: 'abc',
    sourceUrl: 'sourcemonkey://abc/Foo.user.js',
    body: 'BODYTOP',
    gmBindings: '',
    gmPrelude: '',
    requireExports: ['on', '$', '$$'],
  });
  assert.match(wrapped, /var\{on,\$,\$\$\}=self\.__smReqScope\["abc"\];/);
  const lines = wrapped.split('\n');
  // The body's first line still arrives at physical line 1.
  assert.match(lines[0], /BODYTOP$/);
});

// ---------- buildConfigBlob: __smReqScope init ----------

test('buildConfigBlob: initializes self.__smReqScope[id] = {} before init/queue', () => {
  // Entry 0 in the js[] array. Runs before any @require entry so the
  // require's Object.assign has a target object. Re-runs per
  // registration (incl. refresh) so a stale scope from a prior load
  // doesn't bleed into the new one.
  const blob = buildConfigBlob({
    id: 'abc', logLabel: 'x.user.js', name: 'X',
    sourceUrl: 'sourcemonkey://SourceMonkey/x/x.user.js',
    loadedAt: 0, runAt: 'document-idle', needsGmValues: false,
    matching: null, startupLogs: [], requireUrls: [],
  });
  assert.match(blob, /\(self\.__smReqScope=self\.__smReqScope\|\|\{\}\)\[c\.id\]=\{\};/);
});

// ---------- composeRequiredBody (kept for reload-fast-path) ----------

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
    header: { tags: [{ tag: 'name', value: 'Hello' }] },
    matching: { matches: ['https://example.com/*'], excludes: [], includes: [] },
    loadedAt: 0,
    enabled: true,
    ...over,
  };
}

test('composeRequiredBody: passes through bodyText when no @require', () => {
  assert.equal(composeRequiredBody(makeScript()), 'console.log("hi");');
});

test('composeRequiredBody: includes leadingText + headerText so injected line numbers match the file', () => {
  // The metadata block is comment-only JS, so the engine treats it as
  // inert noise — but its presence keeps the file's line numbers
  // intact in stack traces.
  const header = '// ==UserScript==\n// @name X\n// ==/UserScript==';
  const out = composeRequiredBody(makeScript({
    leadingText: '// shebang-ish comment\n',
    headerText: header,
    bodyText: 'console.log("hi");',
  }));
  assert.equal(
    out,
    '// shebang-ish comment\n' +
    '// ==UserScript==\n// @name X\n// ==/UserScript==\n' +
    'console.log("hi");',
  );
});

test('composeRequiredBody: prepends every require body in declaration order', () => {
  const script = makeScript({
    requires: [
      { url: 'https://cdn.example.com/a.js', source: 'var A=1;', ref: 'a', size: 0, contentHash: '', loadedAt: 0 },
      { url: 'https://cdn.example.com/b.js', source: 'var B=2;', ref: 'b', size: 0, contentHash: '', loadedAt: 0 },
    ],
  });
  const out = composeRequiredBody(script);
  const aPos = out.indexOf('var A=1;');
  const bPos = out.indexOf('var B=2;');
  const bodyPos = out.indexOf('console.log("hi");');
  assert.ok(aPos >= 0 && bPos > aPos && bodyPos > bPos);
});

test('composeRequiredBody: separator prevents ASI hazards between segments', () => {
  const out = composeRequiredBody(makeScript({
    bodyText: '(function(){})()',
    requires: [{ url: 'https://x/r.js', source: '(function(){return 1})()', ref: '', size: 0, contentHash: '', loadedAt: 0 }],
  }));
  assert.match(out, /\(function\(\)\{return 1\}\)\(\)\n;/);
});

// ---------- buildSwapEvalBody ----------

test('buildSwapEvalBody: prepends GM bindings ahead of the composed body', async () => {
  // The reload-fast-path swap eval runs at runMain's function scope —
  // not inside the main-body wrap function — so any `GM_*` reference
  // in the swapped body would ReferenceError unless we prepend the
  // bindings here. The single (0,eval) call evaluates the whole
  // string in one environment, so `const`-declared bindings at the
  // top are in scope for the body that follows.
  const script = makeScript({
    header: { tags: [{ tag: 'name', value: 'S' }, { tag: 'grant', value: 'GM_setValue' }] },
    bodyText: 'GM_setValue("k","v");',
  });
  const body = await buildSwapEvalBody(script, '0.0.0');
  const gmPos = body.indexOf('const GM_setValue');
  const userPos = body.indexOf('GM_setValue("k","v")');
  assert.ok(gmPos >= 0, 'GM_setValue binding should be prepended');
  assert.ok(userPos > gmPos, 'user-code reference should follow the binding');
  // GM_info is also prepended (implicit, TM/VM compat) so a swapped
  // body that touches GM_info doesn't ReferenceError.
  assert.match(body, /const GM_info = /);
});

test('buildSwapEvalBody: MAIN-world script still gets GM_info prepended', async () => {
  // @grant none / no-grants lands in MAIN. The swap eval scope can't
  // see the wrap function's `const GM_info`, so a swap on a body
  // that does `GM_info.script.name` would ReferenceError without
  // this prefix.
  const script = makeScript({
    header: { tags: [{ tag: 'name', value: 'MainSwap' }] },
    bodyText: 'document.title = GM_info.script.name;',
  });
  const body = await buildSwapEvalBody(script, '0.0.0');
  assert.match(body, /const GM_info = /);
  // No __SM_GM__ in MAIN, so non-info bindings aren't included.
  assert.doesNotMatch(body, /__SM_GM__/);
});

test('buildSwapEvalBody: passes through plain body when no header (defensive)', async () => {
  // Headerless scripts aren't a production case (validateHeader
  // rejects them), but the helper should still return something
  // eval-able rather than throwing.
  const script = { ...makeScript(), header: null };
  const body = await buildSwapEvalBody(script, '0.0.0');
  assert.equal(body, 'console.log("hi");');
});

// ---------- buildRegistrationSpec ----------

test('buildRegistrationSpec: passes @match values through as matches', async () => {
  const spec = await buildRegistrationSpec(makeScript());
  assert.deepEqual(spec.matches, ['https://example.com/*']);
});

test('buildRegistrationSpec: @include glob → includeGlobs; /regex/ form goes to wrapper', async () => {
  const spec = await buildRegistrationSpec(makeScript({
    matching: {
      matches: [],
      excludes: [],
      includes: ['*://example.com/*', '/^https:\\/\\/foo\\..*$/'],
    },
  }));
  assert.deepEqual(spec.includeGlobs, ['*://example.com/*']);
  // The regex pattern travels through the config blob into the
  // prelude's runtime matcher.
  const cfg = spec.js[0];
  assert.ok('code' in cfg);
  assert.match(cfg.code, /"matching"/);
});

test('buildRegistrationSpec: @exclude glob → excludeGlobs; /regex/ form goes to wrapper', async () => {
  const spec = await buildRegistrationSpec(makeScript({
    matching: {
      matches: ['https://example.com/*'],
      excludes: ['*/admin/*', '/danger/'],
      includes: [],
    },
  }));
  assert.deepEqual(spec.excludeGlobs, ['*/admin/*']);
  const cfg = spec.js[0];
  assert.ok('code' in cfg);
  assert.match(cfg.code, /"matching"/);
});

test('buildRegistrationSpec: regex-only @include registers <all_urls> and defers to the wrapper', async () => {
  const spec = await buildRegistrationSpec(makeScript({
    matching: { matches: [], excludes: [], includes: ['/^https:\\/\\/foo\\..*$/'] },
  }));
  assert.deepEqual(spec.matches, ['<all_urls>']);
  assert.equal(spec.includeGlobs, undefined);
});

test('buildRegistrationSpec: pure @match script omits the wrapper-side matcher block', async () => {
  const spec = await buildRegistrationSpec(makeScript());
  const cfg = spec.js[0];
  assert.ok('code' in cfg);
  assert.doesNotMatch(cfg.code, /"matching"/);
});

test('buildRegistrationSpec: registers every script at document_start regardless of @run-at', async () => {
  for (const declared of ['document-start', 'document-body', 'document-end', 'document-idle']) {
    const spec = await buildRegistrationSpec(makeScript({
      header: {
        tags: [
          { tag: 'name', value: 'X' },
          { tag: 'run-at', value: declared },
        ],
      },
    }));
    assert.equal(spec.runAt, 'document_start', `runAt for @run-at ${declared}`);
  }
});

test('buildRegistrationSpec: threads the declared @run-at through the config blob', async () => {
  const spec = await buildRegistrationSpec(makeScript({
    header: {
      tags: [
        { tag: 'name', value: 'X' },
        { tag: 'run-at', value: 'document-end' },
      ],
    },
  }));
  const cfg = spec.js[0];
  assert.ok('code' in cfg);
  assert.match(cfg.code, /"runAt":"document-end"/);
});

test('buildRegistrationSpec: defaults the wrapper @run-at to document-idle when header omits it', async () => {
  const spec = await buildRegistrationSpec(makeScript());
  const cfg = spec.js[0];
  assert.ok('code' in cfg);
  assert.match(cfg.code, /"runAt":"document-idle"/);
});

test('buildRegistrationSpec: js[] shape is [config, prelude, ...requires, main]', async () => {
  const spec = await buildRegistrationSpec(makeScript({
    requires: [
      { url: 'https://cdn.example.com/a.js', source: 'A();', ref: 'a', size: 0, contentHash: '', loadedAt: 0 },
      { url: 'https://cdn.example.com/b.js', source: 'B();', ref: 'b', size: 0, contentHash: '', loadedAt: 0 },
    ],
  }));
  // makeScript()'s relativePath is `a.user.js` → default logLabel
  // (basename, no dedup) → folder `a` under SourceMonkey/.
  // 1 config + 1 prelude + 2 requires + 1 main = 5.
  // The prelude is inline (not a separate singleton registration) —
  // cross-registration order isn't guaranteed by chrome.userScripts,
  // and the main body's self.__smRun() call has no safety net.
  assert.equal(spec.js.length, 5);
  assert.ok('code' in spec.js[0]);
  // Config blob carries a per-script `__config.js` sourceURL.
  assert.match(spec.js[0].code, /sourceURL=sourcemonkey:\/\/SourceMonkey\/a\/__config\.js/);
  // Prelude inclusion — bytes are WRAPPER_PRELUDE; URL is the
  // page-wide `__prelude.js` so devtools tree-dedups all N
  // inclusions into one visible entry.
  assert.ok('code' in spec.js[1]);
  assert.ok(spec.js[1].code.startsWith(WRAPPER_PRELUDE));
  assert.match(spec.js[1].code, /sourceURL=sourcemonkey:\/\/SourceMonkey\/__prelude\.js/);
  // Require entries get synthetic sourcemonkey:// URLs that nest
  // them under the script's folder, with the require's real host +
  // path as subfolders so provenance is still visible in the tree.
  assert.ok('code' in spec.js[2]);
  assert.match(spec.js[2].code, /A\(\);/);
  assert.match(spec.js[2].code, /sourceURL=sourcemonkey:\/\/SourceMonkey\/a\/cdn\.example\.com\/a\.js/);
  assert.ok('code' in spec.js[3]);
  assert.match(spec.js[3].code, /B\(\);/);
  assert.match(spec.js[3].code, /sourceURL=sourcemonkey:\/\/SourceMonkey\/a\/cdn\.example\.com\/b\.js/);
  assert.ok('code' in spec.js[4]);
  assert.match(spec.js[4].code, /console\.log\("hi"\);/);
  assert.match(spec.js[4].code, /sourceURL=sourcemonkey:\/\/SourceMonkey\/a\/a\.user\.js/);
});

test('buildRegistrationSpec: js[] shape with no requires is [config, prelude, main]', async () => {
  const spec = await buildRegistrationSpec(makeScript());
  assert.equal(spec.js.length, 3);
  assert.ok('code' in spec.js[0]);
  assert.match(spec.js[0].code, /sourceURL=sourcemonkey:\/\/SourceMonkey\/a\/__config\.js/);
  assert.ok('code' in spec.js[1]);
  assert.ok(spec.js[1].code.startsWith(WRAPPER_PRELUDE));
  assert.ok('code' in spec.js[2]);
  assert.match(spec.js[2].code, /console\.log\("hi"\);/);
});

test('buildRegistrationSpec: logLabel arg picks the devtools folder name', async () => {
  // Caller passes the dedup-aware label (e.g. `foo.user.js#2`) so
  // multiple scripts sharing a basename land in distinct folders.
  const spec = await buildRegistrationSpec(
    makeScript({ id: 'abc-123' }),
    '0.0.0',
    'shared.user.js#2',
  );
  const cfg = spec.js[0];
  assert.ok('code' in cfg);
  // The `#2` dedup suffix percent-encodes to `%232` so URL parsers
  // (including devtools') don't treat `#` as a fragment separator.
  assert.match(cfg.code, /"sourceUrl":"sourcemonkey:\/\/SourceMonkey\/shared%232\/shared\.user\.js"/);
  // The main body's trailing sourceURL marker uses the same value.
  const main = spec.js[spec.js.length - 1];
  assert.ok('code' in main);
  assert.match(main.code, /sourceURL=sourcemonkey:\/\/SourceMonkey\/shared%232\/shared\.user\.js/);
});

test('buildRegistrationSpec: header without @grant defaults to MAIN world (TM-compatible @grant none)', async () => {
  const spec = await buildRegistrationSpec(makeScript());
  assert.equal(spec.world, 'MAIN');
});

test('buildRegistrationSpec: @grant none → MAIN world', async () => {
  const spec = await buildRegistrationSpec(makeScript({
    header: { tags: [{ tag: 'name', value: 'X' }, { tag: 'grant', value: 'none' }] },
  }));
  assert.equal(spec.world, 'MAIN');
});

test('buildRegistrationSpec: any real @grant → USER_SCRIPT world', async () => {
  const spec = await buildRegistrationSpec(makeScript({
    header: { tags: [{ tag: 'name', value: 'X' }, { tag: 'grant', value: 'GM_setValue' }] },
  }));
  assert.equal(spec.world, 'USER_SCRIPT');
});

test('buildRegistrationSpec: @inject-into page wins over @grant', async () => {
  const spec = await buildRegistrationSpec(makeScript({
    header: {
      tags: [
        { tag: 'name', value: 'X' },
        { tag: 'grant', value: 'GM_setValue' },
        { tag: 'inject-into', value: 'page' },
      ],
    },
  }));
  assert.equal(spec.world, 'MAIN');
});

test('buildRegistrationSpec: @inject-into content wins over @grant none', async () => {
  const spec = await buildRegistrationSpec(makeScript({
    header: {
      tags: [
        { tag: 'name', value: 'X' },
        { tag: 'grant', value: 'none' },
        { tag: 'inject-into', value: 'content' },
      ],
    },
  }));
  assert.equal(spec.world, 'USER_SCRIPT');
});

test('buildRegistrationSpec: storage grant flips needsGmValues in the config blob', async () => {
  const spec = await buildRegistrationSpec(makeScript({
    header: { tags: [{ tag: 'name', value: 'X' }, { tag: 'grant', value: 'GM_setValue' }] },
  }));
  const cfg = spec.js[0];
  assert.ok('code' in cfg);
  assert.match(cfg.code, /"needsGmValues":true/);
});

test('buildRegistrationSpec: GM bindings spliced into BOTH main body and @require entries', async () => {
  // Each js[] entry is its own V8 script with its own lexical scope,
  // so a `const GM_setValue` declared in the main-body wrap is
  // invisible to require entries. TM/VM concatenate everything into
  // one IIFE; we repeat the binding prefix per entry to match
  // semantics. See wrapRequireEntry in src/injector.ts.
  const spec = await buildRegistrationSpec(makeScript({
    header: { tags: [{ tag: 'name', value: 'X' }, { tag: 'grant', value: 'GM_setValue' }] },
    requires: [{ url: 'https://cdn/a.js', source: 'A();', ref: 'a', size: 0, contentHash: '', loadedAt: 0 }],
  }));
  // Shape: [config, prelude, require, main].
  const requireEntry = spec.js[2];
  const mainEntry = spec.js[3];
  assert.ok('code' in requireEntry);
  assert.ok('code' in mainEntry);
  assert.match(mainEntry.code, /const GM_setValue/);
  assert.match(requireEntry.code, /const GM_setValue/);
  // Both wraps bake in the SAME scriptId so they target the same
  // storage bucket.
  assert.match(mainEntry.code, /__SM_GM__\.storage\.set\("script-1"/);
  assert.match(requireEntry.code, /__SM_GM__\.storage\.set\("script-1"/);
});

test('buildRegistrationSpec: @require entries get GM_info even without any other @grant', async () => {
  // GM_info is implicit (TM/VM compat). A library require that does
  // `typeof GM_info !== "undefined"` should pass even when the host
  // script has no grants at all.
  const spec = await buildRegistrationSpec(makeScript({
    header: { tags: [{ tag: 'name', value: 'Hello' }] },
    requires: [{ url: 'https://cdn/p.js', source: 'P();', ref: 'p', size: 0, contentHash: '', loadedAt: 0 }],
  }));
  // [config, prelude, require, main]
  const requireEntry = spec.js[2];
  assert.ok('code' in requireEntry);
  assert.match(requireEntry.code, /const GM_info = Object\.freeze/);
});

test('buildRegistrationSpec: /* exported */ in a @require forwards names to the main body', async () => {
  // The github-html-preview style: utilsjs.js declares `const on/$/$$`
  // with a `/* exported */` directive at the top. Without forwarding,
  // the main body's `on(...)` call throws ReferenceError because each
  // js[] entry is its own V8 top-level scope.
  const utilsSrc = `/* exported $ $$ on */
"use strict";
const $ = (s, el) => (el || document).querySelector(s);
const $$ = (s, el) => [...(el || document).querySelectorAll(s)];
const on = (el, ev, cb) => el.addEventListener(ev, cb);`;
  const spec = await buildRegistrationSpec(makeScript({
    header: { tags: [{ tag: 'name', value: 'Hello' }] },
    bodyText: 'on(document, "x", () => {});',
    requires: [{
      url: 'https://cdn/utils.js', source: utilsSrc, ref: 'u',
      size: 0, contentHash: '', loadedAt: 0,
    }],
  }));
  // [config, prelude, require, main]
  const requireEntry = spec.js[2];
  const mainEntry = spec.js[3];
  assert.ok('code' in requireEntry);
  assert.ok('code' in mainEntry);
  // Producer side: the require entry's tail Object.assigns all three
  // names onto its per-script scope object.
  assert.match(
    requireEntry.code,
    /Object\.assign\(self\.__smReqScope\["script-1"\],\{\$,\$\$,on\}\);/,
  );
  // Consumer side: the main body destructures them back out at the
  // top of its head one-liner.
  assert.match(
    mainEntry.code,
    /var\{\$,\$\$,on\}=self\.__smReqScope\["script-1"\];/,
  );
});

test('buildRegistrationSpec: multiple @requires union their exported names', async () => {
  // Two libraries each export distinct names → main body's destructure
  // pulls from both. Declaration order is preserved across the union.
  const a = `/* exported foo */\nconst foo = 1;`;
  const b = `/* exported bar baz */\nconst bar = 2; const baz = 3;`;
  const spec = await buildRegistrationSpec(makeScript({
    header: { tags: [{ tag: 'name', value: 'X' }] },
    bodyText: 'foo;bar;baz;',
    requires: [
      { url: 'https://cdn/a.js', source: a, ref: 'a', size: 0, contentHash: '', loadedAt: 0 },
      { url: 'https://cdn/b.js', source: b, ref: 'b', size: 0, contentHash: '', loadedAt: 0 },
    ],
  }));
  // [config, prelude, a, b, main]
  const mainEntry = spec.js[4];
  assert.ok('code' in mainEntry);
  assert.match(
    mainEntry.code,
    /var\{foo,bar,baz\}=self\.__smReqScope\["script-1"\];/,
  );
});

test('buildRegistrationSpec: name collisions across @requires dedup (last-write-wins at runtime)', async () => {
  // Both requires export `helper`. The destructure mentions it once.
  // Each require's own Object.assign overwrites the prior — last
  // require's value wins, matching TM/VM concat semantics.
  const a = `/* exported helper */\nconst helper = "A";`;
  const b = `/* exported helper */\nconst helper = "B";`;
  const spec = await buildRegistrationSpec(makeScript({
    requires: [
      { url: 'https://cdn/a.js', source: a, ref: 'a', size: 0, contentHash: '', loadedAt: 0 },
      { url: 'https://cdn/b.js', source: b, ref: 'b', size: 0, contentHash: '', loadedAt: 0 },
    ],
  }));
  const mainEntry = spec.js[4];
  assert.ok('code' in mainEntry);
  // Single occurrence in the destructure list.
  const matches = mainEntry.code.match(/var\{([^}]+)\}=self\.__smReqScope/);
  assert.ok(matches);
  assert.deepEqual(matches[1].split(','), ['helper']);
});

test('buildRegistrationSpec: /* exported */ names colliding with GM (bare) or unsafeWindow are filtered', async () => {
  // gm-bindings.ts emits `const GM = ...` and `const unsafeWindow = window;`
  // unconditionally on the main-body head line. A `var{GM}=...` /
  // `var{unsafeWindow}=...` destructure on the same line would
  // redeclare them — hard SyntaxError that kills the whole main body.
  const src = `/* exported GM unsafeWindow ok */\nconst ok = 1;`;
  const spec = await buildRegistrationSpec(makeScript({
    header: { tags: [{ tag: 'name', value: 'X' }, { tag: 'grant', value: 'GM_setValue' }] },
    requires: [{
      url: 'https://cdn/x.js', source: src, ref: 'x',
      size: 0, contentHash: '', loadedAt: 0,
    }],
  }));
  // [config, prelude, require, main]
  const requireEntry = spec.js[2];
  const mainEntry = spec.js[3];
  assert.ok('code' in requireEntry);
  assert.ok('code' in mainEntry);
  const assignMatch = requireEntry.code.match(/Object\.assign\(self\.__smReqScope\["script-1"\],\{([^}]*)\}\)/);
  assert.ok(assignMatch);
  assert.deepEqual(assignMatch[1].split(',').filter(Boolean), ['ok']);
  const destructureMatch = mainEntry.code.match(/var\{([^}]*)\}=self\.__smReqScope\["script-1"\]/);
  assert.ok(destructureMatch);
  assert.deepEqual(destructureMatch[1].split(',').filter(Boolean), ['ok']);
});

test('buildRegistrationSpec: /* exported */ names colliding with GM_*/__sm* are filtered', async () => {
  // Forwarding `GM_foo` would redeclare a `const` we emit (SyntaxError);
  // `__sm*` is SourceMonkey's internal namespace. Both classes are
  // dropped from the forwarder on safety grounds.
  const src = `/* exported GM_bad __smHack ok */\nconst ok = 1;`;
  const spec = await buildRegistrationSpec(makeScript({
    requires: [{
      url: 'https://cdn/x.js', source: src, ref: 'x',
      size: 0, contentHash: '', loadedAt: 0,
    }],
  }));
  // [config, prelude, require, main]
  const requireEntry = spec.js[2];
  const mainEntry = spec.js[3];
  assert.ok('code' in requireEntry);
  assert.ok('code' in mainEntry);
  // The filter applies to the forwarder list, not to the require's
  // own source — the original `/* exported */` comment passes through
  // verbatim (it's just a comment).
  const assignMatch = requireEntry.code.match(/Object\.assign\(self\.__smReqScope\["script-1"\],\{([^}]*)\}\)/);
  assert.ok(assignMatch);
  assert.deepEqual(assignMatch[1].split(',').filter(Boolean), ['ok']);
  const destructureMatch = mainEntry.code.match(/var\{([^}]*)\}=self\.__smReqScope\["script-1"\]/);
  assert.ok(destructureMatch);
  assert.deepEqual(destructureMatch[1].split(',').filter(Boolean), ['ok']);
});

test('buildRegistrationSpec: @require with no /* exported */ directive emits no forwarder', async () => {
  // No regression for libraries that don't include the directive. The
  // require still runs; only `var`/`function` top-level declarations
  // leak through globalThis (the legacy behavior).
  const spec = await buildRegistrationSpec(makeScript({
    requires: [{
      url: 'https://cdn/x.js', source: 'window.lib = {};', ref: 'x',
      size: 0, contentHash: '', loadedAt: 0,
    }],
  }));
  const requireEntry = spec.js[2];
  const mainEntry = spec.js[3];
  assert.ok('code' in requireEntry);
  assert.ok('code' in mainEntry);
  assert.doesNotMatch(requireEntry.code, /Object\.assign\(self\.__smReqScope/);
  assert.doesNotMatch(mainEntry.code, /__smReqScope\["script-1"\]/);
});

test('buildRegistrationSpec: two scripts sharing an @require URL bake their OWN scriptId into the require wrap', async () => {
  // Each script's registration is built independently — the require
  // source bytes are shared (file-loader dedups by canonical URL),
  // but each script's require wrap is generated with that script's
  // own scriptId baked into the gm bindings. Without this,
  // GM_setValue calls inside the shared require would route to the
  // wrong storage bucket.
  const sharedRequire = { url: 'https://cdn/lib.js', source: 'L();', ref: 'lib', size: 0, contentHash: '', loadedAt: 0 };
  const specA = await buildRegistrationSpec(makeScript({
    id: 'script-A',
    header: { tags: [{ tag: 'name', value: 'A' }, { tag: 'grant', value: 'GM_setValue' }] },
    requires: [sharedRequire],
  }));
  const specB = await buildRegistrationSpec(makeScript({
    id: 'script-B',
    header: { tags: [{ tag: 'name', value: 'B' }, { tag: 'grant', value: 'GM_setValue' }] },
    requires: [sharedRequire],
  }));
  // [config, prelude, require, main]
  const requireA = specA.js[2];
  const requireB = specB.js[2];
  assert.ok('code' in requireA);
  assert.ok('code' in requireB);
  assert.match(requireA.code, /__SM_GM__\.storage\.set\("script-A"/);
  assert.match(requireB.code, /__SM_GM__\.storage\.set\("script-B"/);
  // Sanity: each only references its own id.
  assert.doesNotMatch(requireA.code, /"script-B"/);
  assert.doesNotMatch(requireB.code, /"script-A"/);
});

test('buildRegistrationSpec: MAIN-world script gets GM_info only (no other bindings)', async () => {
  // @grant none + no grants both land in MAIN world (resolveWorld);
  // we don't have a USER_SCRIPT-world __SM_GM__ runtime there, so
  // only GM_info — which is a baked literal with no runtime
  // dependency — is exposed. Other GM_* would ReferenceError, which
  // is the documented limitation.
  const spec = await buildRegistrationSpec(makeScript({
    header: { tags: [{ tag: 'name', value: 'M' }] },
  }));
  assert.equal(spec.world, 'MAIN');
  // Shape: [config, prelude, main]
  const mainEntry = spec.js[spec.js.length - 1];
  assert.ok('code' in mainEntry);
  assert.match(mainEntry.code, /const GM_info = Object\.freeze/);
  assert.doesNotMatch(mainEntry.code, /__SM_GM__/);
});

test('buildRegistrationSpec: passes script.startupLogs through to the config blob', async () => {
  const script = makeScript({
    id: 'forwarded',
    startupLogs: [{ level: 'warn', message: 'unknown @grant entries dropped: GM_audio' }],
  });
  const spec = await buildRegistrationSpec(script);
  const cfg = spec.js[0];
  assert.ok('code' in cfg);
  assert.match(cfg.code, /"startupLogs":\[/);
  assert.match(cfg.code, /unknown @grant entries dropped: GM_audio/);
});

// ---------- resolveWorld ----------

function makeHeader(tags) {
  return { tags };
}

test('resolveWorld: no header → MAIN (defensive default)', () => {
  assert.equal(resolveWorld(null), 'MAIN');
  assert.equal(resolveWorld(undefined), 'MAIN');
});

test('resolveWorld: empty header (no @grant) → MAIN', () => {
  assert.equal(resolveWorld(makeHeader([{ tag: 'name', value: 'X' }])), 'MAIN');
});

test('resolveWorld: @inject-into page → MAIN regardless of @grant', () => {
  const h = makeHeader([
    { tag: 'grant', value: 'GM_xmlhttpRequest' },
    { tag: 'inject-into', value: 'page' },
  ]);
  assert.equal(resolveWorld(h), 'MAIN');
});

test('resolveWorld: @inject-into content → USER_SCRIPT regardless of @grant', () => {
  const h = makeHeader([
    { tag: 'grant', value: 'none' },
    { tag: 'inject-into', value: 'content' },
  ]);
  assert.equal(resolveWorld(h), 'USER_SCRIPT');
});

test('resolveWorld: @inject-into auto falls through to @grant logic', () => {
  assert.equal(
    resolveWorld(makeHeader([{ tag: 'inject-into', value: 'auto' }])),
    'MAIN',
  );
  assert.equal(
    resolveWorld(makeHeader([
      { tag: 'inject-into', value: 'auto' },
      { tag: 'grant', value: 'GM_setValue' },
    ])),
    'USER_SCRIPT',
  );
});

test('resolveWorld: multi @grant — all "none" → MAIN, any real grant → USER_SCRIPT', () => {
  assert.equal(
    resolveWorld(makeHeader([
      { tag: 'grant', value: 'none' },
      { tag: 'grant', value: 'none' },
    ])),
    'MAIN',
  );
  assert.equal(
    resolveWorld(makeHeader([
      { tag: 'grant', value: 'none' },
      { tag: 'grant', value: 'GM_setValue' },
    ])),
    'USER_SCRIPT',
  );
});

test('resolveWorld: @inject-into value is case-insensitive', () => {
  assert.equal(
    resolveWorld(makeHeader([{ tag: 'inject-into', value: 'PAGE' }])),
    'MAIN',
  );
  assert.equal(
    resolveWorld(makeHeader([{ tag: 'inject-into', value: 'Content' }])),
    'USER_SCRIPT',
  );
});

// ---------- prelude matcher round-trip ----------

// The prelude's __smMatchScript must agree with urlMatchesScript()
// from url-match.ts. The prelude file's matcher is the same algorithm
// (now lives inside src/userscript-prelude.js). We eval just the helpers
// from the built prelude to drive direct asserts.

async function loadPreludeMatcher() {
  // The matcher helpers are bundled into WRAPPER_PRELUDE but are
  // function declarations inside the IIFE, so we can't easily call
  // them from outside. Re-define them here to exercise the same
  // algorithm — kept in sync by inspection (and by the e2e tests).
  const harness = `
    /* Re-evaluate the matcher helpers in this scope. */
    function escRx(s) { return s.replace(/[.+?^${"$"}{}()|[\\]\\\\]/g, "\\\\$&"); }
    function globRx(g) { return new RegExp("^" + escRx(g).replace(/\\*/g, ".*") + "$"); }
    function includeMatch(pat, url) {
      if (pat.length >= 2 && pat.charAt(0) === "/" && pat.charAt(pat.length - 1) === "/") {
        try { return new RegExp(pat.slice(1, -1)).test(url); } catch (_e) { return false; }
      }
      try { return globRx(pat).test(url); } catch (_e) { return false; }
    }
    function matchPattern(pat, url) {
      if (pat === "<all_urls>") return /^(https?|file|ftp):/i.test(url);
      var parts = /^(\\*|https?|file|ftp):\\/\\/([^/]*)(\\/.*)$/i.exec(pat);
      if (!parts) return false;
      var scheme = parts[1], host = parts[2], path = parts[3];
      var u; try { u = new URL(url); } catch (_e) { return false; }
      if (scheme === "*") {
        if (u.protocol !== "http:" && u.protocol !== "https:") return false;
      } else if (u.protocol !== scheme.toLowerCase() + ":") return false;
      if (host === "*") {
      } else if (host.indexOf("*.") === 0) {
        var suffix = host.slice(2).toLowerCase();
        var h = u.hostname.toLowerCase();
        if (h !== suffix && h.slice(-(suffix.length + 1)) !== "." + suffix) return false;
      } else if (host === "") {
        if (u.hostname !== "") return false;
      } else if (u.hostname.toLowerCase() !== host.toLowerCase()) return false;
      var tail = u.pathname + u.search + u.hash;
      try { return globRx(path).test(tail); } catch (_e) { return false; }
    }
    return function matchScript(url, m) {
      for (var i = 0; i < m.excludes.length; i++) if (includeMatch(m.excludes[i], url)) return false;
      for (var j = 0; j < m.matches.length; j++) if (matchPattern(m.matches[j], url)) return true;
      for (var k = 0; k < m.includes.length; k++) if (includeMatch(m.includes[k], url)) return true;
      return false;
    };
  `;
  // eslint-disable-next-line no-new-func
  return new Function('URL', harness)(URL);
}

test('prelude matcher: @match passes', async () => {
  const match = await loadPreludeMatcher();
  assert.equal(match('https://example.com/x', { matches: ['https://example.com/*'], excludes: [], includes: [] }), true);
});

test('prelude matcher: /regex/ @include matches when glob would not', async () => {
  const match = await loadPreludeMatcher();
  const m = { matches: [], excludes: [], includes: ['/^https:\\/\\/foo\\.example\\.com\\/.*$/'] };
  assert.equal(match('https://foo.example.com/page', m), true);
  assert.equal(match('https://bar.example.com/page', m), false);
});

test('prelude matcher: /regex/ @exclude beats a @match', async () => {
  const match = await loadPreludeMatcher();
  const m = { matches: ['https://example.com/*'], excludes: ['/\\/admin\\//'], includes: [] };
  assert.equal(match('https://example.com/admin/x', m), false);
  assert.equal(match('https://example.com/public/x', m), true);
});

test('prelude matcher: <all_urls> matches http/https/file/ftp only', async () => {
  const match = await loadPreludeMatcher();
  const m = { matches: ['<all_urls>'], excludes: [], includes: [] };
  assert.equal(match('https://example.com/', m), true);
  assert.equal(match('chrome://settings', m), false);
});

// ---------- buildBridgeSpec ----------

test('buildBridgeSpec: returns null when no MAIN-world script is active', () => {
  const specs = [
    { id: 'a', world: 'USER_SCRIPT', matches: ['https://x/*'], js: [{ code: '' }], runAt: 'document_idle' },
    { id: 'b', world: 'USER_SCRIPT', matches: ['https://y/*'], js: [{ code: '' }], runAt: 'document_idle' },
  ];
  assert.equal(buildBridgeSpec(specs), null);
});

test('buildBridgeSpec: returns null on an empty active set', () => {
  assert.equal(buildBridgeSpec([]), null);
});

test('buildBridgeSpec: emits a USER_SCRIPT spec at <all_urls> when any MAIN-world script exists', () => {
  const specs = [
    { id: 'a', world: 'USER_SCRIPT', matches: ['https://x/*'], js: [{ code: '' }], runAt: 'document_idle' },
    { id: 'b', world: 'MAIN', matches: ['https://y/*'], js: [{ code: '' }], runAt: 'document_idle' },
  ];
  const bridge = buildBridgeSpec(specs);
  assert.ok(bridge, 'expected a bridge spec');
  assert.equal(bridge.id, BRIDGE_SCRIPT_ID);
  assert.equal(bridge.world, 'USER_SCRIPT');
  assert.deepEqual(bridge.matches, ['<all_urls>']);
  assert.equal(bridge.runAt, 'document_start');
  assert.match(bridge.js[0].code, /sourcemonkey-bridge/);
  // Tagged with a page-wide sourceURL so devtools shows it under a
  // friendly name rather than a UUID.
  assert.match(bridge.js[0].code, /sourceURL=sourcemonkey:\/\/SourceMonkey\/__bridge\.js/);
});

// ---------- wrapPreludeEntry ----------

test('wrapPreludeEntry: appends the page-wide prelude sourceURL', () => {
  // All N inclusions get the same URL so devtools tree-dedups them
  // into a single visible entry — see injector.ts's URL layout
  // comment for why we inline rather than register-once.
  const code = wrapPreludeEntry();
  assert.ok(code.startsWith(WRAPPER_PRELUDE));
  assert.match(code, /sourceURL=sourcemonkey:\/\/SourceMonkey\/__prelude\.js/);
});

// ---------- wrapper-bridge: filter behavior ----------

// Eval the bridge source inside a fake DOM harness. The bridge is an
// IIFE that closes over global `window` + `chrome`; passing those as
// parameters to a wrapping Function constructor lets us drive
// synthetic `message` events through it and observe what reaches the
// SW.
function setupBridgeHarness() {
  const sent = [];
  const fakeChrome = {
    runtime: {
      sendMessage(payload) {
        sent.push(payload);
        return Promise.resolve();
      },
    },
  };
  let listener = null;
  const fakeWindow = {
    addEventListener(type, fn, _capture) {
      if (type === 'message') listener = fn;
    },
  };
  // eslint-disable-next-line no-new-func
  new Function('window', 'chrome', WRAPPER_BRIDGE)(fakeWindow, fakeChrome);
  if (!listener) throw new Error('bridge did not install a message listener');
  const dispatch = (event) => listener(event);
  const goodEvent = (overrides = {}) => ({
    source: fakeWindow,
    data: { __sm: 'sourcemonkey-bridge', payload: { type: 'sm:start', id: 'x', url: 'https://e/' } },
    ...overrides,
  });
  return { sent, dispatch, goodEvent, fakeWindow };
}

test('wrapper-bridge: forwards well-formed sm:start events', () => {
  const { sent, dispatch, goodEvent } = setupBridgeHarness();
  dispatch(goodEvent());
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'sm:start');
  assert.equal(sent[0].id, 'x');
});

test('wrapper-bridge: forwards well-formed sm:error events', () => {
  const { sent, dispatch, goodEvent } = setupBridgeHarness();
  dispatch(goodEvent({
    data: { __sm: 'sourcemonkey-bridge', payload: { type: 'sm:error', id: 'x', message: 'boom' } },
  }));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'sm:error');
  assert.equal(sent[0].message, 'boom');
});

test('wrapper-bridge: ignores messages from a different source window', () => {
  const { sent, dispatch, goodEvent } = setupBridgeHarness();
  dispatch(goodEvent({ source: { not: 'our window' } }));
  assert.equal(sent.length, 0);
});

test('wrapper-bridge: ignores messages without the SourceMonkey marker', () => {
  const { sent, dispatch, goodEvent } = setupBridgeHarness();
  dispatch(goodEvent({ data: { payload: { type: 'sm:start', id: 'x' } } }));
  dispatch(goodEvent({ data: { __sm: 'something-else', payload: { type: 'sm:start', id: 'x' } } }));
  assert.equal(sent.length, 0);
});

test('wrapper-bridge: ignores messages whose payload is missing or non-object', () => {
  const { sent, dispatch, goodEvent } = setupBridgeHarness();
  dispatch(goodEvent({ data: { __sm: 'sourcemonkey-bridge' } }));
  dispatch(goodEvent({ data: { __sm: 'sourcemonkey-bridge', payload: null } }));
  dispatch(goodEvent({ data: { __sm: 'sourcemonkey-bridge', payload: 'string-payload' } }));
  assert.equal(sent.length, 0);
});

test('wrapper-bridge: only forwards sm:start / sm:error payload types', () => {
  const { sent, dispatch, goodEvent } = setupBridgeHarness();
  dispatch(goodEvent({
    data: { __sm: 'sourcemonkey-bridge', payload: { type: 'sm:exec', code: 'evil' } },
  }));
  dispatch(goodEvent({
    data: { __sm: 'sourcemonkey-bridge', payload: { type: '', id: 'x' } },
  }));
  assert.equal(sent.length, 0);
});

test('wrapper-bridge: silently no-ops when chrome.runtime is unavailable', () => {
  let listener = null;
  const fakeWindow = {
    addEventListener(type, fn) { if (type === 'message') listener = fn; },
  };
  // eslint-disable-next-line no-new-func
  new Function('window', 'chrome', WRAPPER_BRIDGE)(fakeWindow, {});
  assert.equal(listener, null);
});

// ---------- collectActiveSpecs ----------

function makeSource(over = {}) {
  return {
    id: 'source-1',
    path: '/p',
    lastRefreshedAt: 0,
    scriptIds: [],
    enabled: true,
    ...over,
  };
}

test('collectActiveSpecs: error scripts never run; missing scripts run only when explicitly enabled', async () => {
  const sources = new Map([['source-1', makeSource()]]);
  const specs = await collectActiveSpecs([
    makeScript({ id: 's1', status: 'error', errorMessage: 'x' }),
    makeScript({ id: 's2', status: 'missing', enabled: false }),
    makeScript({ id: 's3', status: 'missing', enabled: true }),
    makeScript({ id: 's4' }),
  ], sources);
  assert.deepEqual(specs.map((s) => s.id).sort(), ['s3', 's4']);
});

test('collectActiveSpecs: skips disabled scripts', async () => {
  const sources = new Map([['source-1', makeSource()]]);
  const specs = await collectActiveSpecs([
    makeScript({ id: 's1', enabled: false }),
    makeScript({ id: 's2' }),
  ], sources);
  assert.deepEqual(specs.map((s) => s.id), ['s2']);
});

test('collectActiveSpecs: skips every script under a disabled source', async () => {
  const sources = new Map([['source-1', makeSource({ enabled: false })]]);
  const specs = await collectActiveSpecs([
    makeScript({ id: 's1' }),
    makeScript({ id: 's2' }),
  ], sources);
  assert.deepEqual(specs.map((s) => s.id), []);
});

test('collectActiveSpecs: skips scripts whose source is missing entirely', async () => {
  const sources = new Map();
  const specs = await collectActiveSpecs([makeScript()], sources);
  assert.deepEqual(specs, []);
});

test('collectActiveSpecs: treats undefined `enabled` as true (back-compat)', async () => {
  const script = makeScript();
  delete script.enabled;
  const source = makeSource();
  delete source.enabled;
  const specs = await collectActiveSpecs([script], new Map([['source-1', source]]));
  assert.equal(specs.length, 1);
});
