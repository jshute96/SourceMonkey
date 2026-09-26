// Tests for src/injector.ts (compiled to dist/injector.js).
//
// Only the pure helpers are exercised here — the chrome.userScripts
// runtime sync (syncRegistrations) is glue I/O and is covered by the
// e2e smoke layer instead.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// chrome.storage stub — buildGmBindingsForScript reads chrome.storage.local
// at register time for storage-granting scripts to bake in the initial
// cache. The unknown-@grant warning path also appends to a per-script
// log via chrome.storage.session. Unit tests run in plain Node so we
// install a minimal stub for both areas.
const sessionStore = new Map();
// Backing store for chrome.storage.local. Mostly unused (the pure
// helpers read nothing), but `retryRejectedRegistrations` rebuilds
// specs from the store, so its tests seed real script/collection rows.
const localStore = new Map();
// `register` / `unregister` are swapped per-test by the
// registerWithFallback and retry blocks at the bottom; the defaults
// are loud so an unconfigured caller can't pass by accident.
const userScripts = {
  register: async () => { throw new Error('userScripts.register not stubbed'); },
  // Faithful to Chrome: unregistering an id nothing holds is an error.
  // A stub that resolved for unknown ids would hide the difference
  // between "already gone" and "dropped it".
  unregister: async ({ ids }) => {
    throw new Error(`No user script with ID '${(ids ?? [])[0]}' is registered`);
  },
  // Faithful too: `update` is how a registration that is STAYING
  // registered is replaced, and Chrome refuses it for an id nothing
  // holds. `placeSpec` uses exactly that to fall back to `register`.
  update: async (batch) => {
    throw new Error(`No user script with ID '${(batch ?? [])[0]?.id}' is registered`);
  },
  // Must precede register(); the retry path calls it via
  // ensureWorldConfigured. Without it here the retry's error
  // containment swallows the TypeError and silently does nothing.
  configureWorld: async () => {},
};
globalThis.chrome = globalThis.chrome ?? {
  runtime: { getManifest: () => ({ version: '0.0.0-test' }) },
  storage: {
    local: {
      get: async (key) => {
        if (key === null || key === undefined) return Object.fromEntries(localStore);
        const keys = Array.isArray(key) ? key : [key];
        const out = {};
        for (const k of keys) if (localStore.has(k)) out[k] = localStore.get(k);
        return out;
      },
      set: async (obj) => { for (const [k, v] of Object.entries(obj)) localStore.set(k, v); },
    },
    session: {
      // Mirrors the real API's key shapes. The array form is
      // load-bearing: the log store reads `[log:<id>, loglevel:<id>]`
      // in one call.
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
  userScripts,
};

import {
  BRIDGE_SCRIPT_ID,
  GM_RUNTIME_SCRIPT_ID,
  GM_RUNTIME_MAIN_SCRIPT_ID,
  registerWithFallback,
  buildBridgeSpec,
  buildConfigBlob,
  buildRegistrationSpec,
  buildSwapEvalBody,
  collectActiveSpecs,
  normalizeDeclaredRunAt,
  resolveWorld,
  wrapCombinedEntry,
  wrapPreludeEntry,
} from '../../dist/injector.js';
import {
  USER_SOURCE_START_LINE,
  composeRequiredBody,
  composeSource,
} from '../../dist/composed-source.js';
import { remapStackRef } from '../../dist/source-map.js';
import { buildRequireSourceUrl, buildSourceUrl } from '../../dist/script-source-url.js';
import { WRAPPER_BRIDGE, WRAPPER_PRELUDE } from '../../dist/generated-wrappers.js';
import { urlMatchesScript } from '../../dist/url-match.js';

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
    matching: null, startupLogs: [],
  });
  assert.doesNotMatch(blob, /"matching"/);
  assert.doesNotMatch(blob, /"startupLogs"/);
  // Regression guard: `requireUrls` was dropped from the blob when
  // requires stopped being separate entries. Nothing can pass it in
  // any more, so this only fires if the field comes back.
  assert.doesNotMatch(blob, /"requireUrls"/);
});

test('buildConfigBlob: serializes matching and startupLogs when present', () => {
  const blob = buildConfigBlob({
    id: 'x', logLabel: 'x.user.js', name: 'X',
    sourceUrl: 'sourcemonkey://SourceMonkey/x/x.user.js',
    loadedAt: 0, runAt: 'document-idle', needsGmValues: false,
    matching: { matches: ['https://e/*'], includes: ['/r/'], excludes: [] },
    startupLogs: [{ level: 'warn', message: 'hi' }],
  });
  assert.match(blob, /"matching":\{"matches":\["https:\/\/e\/\*"\],"includes":\["\/r\/"\],"excludes":\[\]\}/);
  assert.match(blob, /"startupLogs":\[\{"level":"warn","message":"hi"\}\]/);
});

test('buildConfigBlob: a startup log\'s location never reaches the page', () => {
  // The blob is injected as code the page can read. A `StartupLog` also
  // carries the header location the diagnostic is about, and for a
  // single-file source that `file` is an absolute local path — so the
  // prelude, which only echoes level + message to the console, must not
  // be handed it.
  const blob = buildConfigBlob({
    id: 'x', logLabel: 'x.user.js', name: 'X',
    sourceUrl: 'sourcemonkey://SourceMonkey/x/x.user.js',
    loadedAt: 0, runAt: 'document-idle', needsGmValues: false,
    matching: null,
    startupLogs: [{
      level: 'warn',
      message: 'Ignoring unsupported @grant GM_nope',
      location: { file: '/home/someone/private/x.user.js', line: 4 },
    }],
  });
  assert.match(blob, /"message":"Ignoring unsupported @grant GM_nope"/);
  assert.doesNotMatch(blob, /"location"/);
  assert.doesNotMatch(blob, /home\/someone/);
});

// ---------- wrapCombinedEntry ----------

const COMBINED_ARGS = {
  scriptId: 'abc',
  sourceUrl: 'sourcemonkey://SourceMonkey/x/Foo.user.js',
  gmBindings: '',
  gmPrelude: '',
};
const scriptWith = (over) => ({
  id: 'abc', collectionId: 's', relativePath: 'Foo.user.js',
  fileUrl: 'file:///Foo.user.js', status: 'ok', size: 1,
  leadingText: '', headerText: '', bodyText: '',
  header: { tags: [{ tag: 'name', value: 'Foo' }] },
  matching: { matches: ['https://e/*'], includes: [], excludes: [] },
  loadedAt: 0, enabled: true, ...over,
});
const req = (source, url = 'https://cdn/x.js') =>
  ({ url, source, ref: 'x', size: 0, contentHash: '', loadedAt: 0 });

test('wrapCombinedEntry: no requires → head on line 1, body lines preserved, no map', () => {
  // The overwhelmingly common case must be byte-for-byte what it was
  // before Mode A (see docs/injection-modes.md for what the modes are):
  // nothing to concatenate means nothing to shift, so
  // body line N stays at physical line N and no source map is paid for.
  const wrapped = wrapCombinedEntry({
    ...COMBINED_ARGS,
    script: scriptWith({ bodyText: 'LINE1\nLINE2\nLINE3' }),
  });
  const lines = wrapped.split('\n');
  assert.match(lines[0], /^self\.__smRun\("abc",function\(__smE\)\{.*LINE1$/);
  assert.equal(lines[1], 'LINE2');
  assert.equal(lines[2], 'LINE3');
  assert.doesNotMatch(wrapped, /sourceMappingURL/);
  assert.match(wrapped, /\/\/# sourceURL=sourcemonkey:\/\/SourceMonkey\/x\/Foo\.user\.js/);
});

test('wrapCombinedEntry: defers execution via self.__smRun and exposes per-script vars', () => {
  const wrapped = wrapCombinedEntry({
    ...COMBINED_ARGS,
    script: scriptWith({ bodyText: 'BODY' }),
  });
  assert.match(wrapped, /^self\.__smRun\("abc",function\(__smE\)\{/);
  assert.match(wrapped, /var __smDecision=__smE\.decision;/);
  assert.match(wrapped, /var __smName=__smE\.cfg\.name;/);
  assert.match(wrapped, /var __smId=__smE\.cfg\.id;/);
  assert.match(wrapped, /var __smLoadedAt=__smE\.cfg\.loadedAt;/);
  assert.match(wrapped, /var __smSend=self\.__smPrelude\.send;/);
});

test('wrapCombinedEntry: splices gmBindings + gmPrelude before the user source', () => {
  const wrapped = wrapCombinedEntry({
    ...COMBINED_ARGS,
    script: scriptWith({ bodyText: 'BODYTOP' }),
    gmBindings: 'const GM_info = 1; ',
    gmPrelude: 'PRELUDE();',
  });
  const head = wrapped.split('\n')[0];
  assert.ok(head.indexOf('const GM_info = 1;') < head.indexOf('PRELUDE();'));
  assert.ok(head.indexOf('PRELUDE();') < head.indexOf('BODYTOP'));
});

test('wrapCombinedEntry: requires and body land in ONE shared scope', () => {
  // The whole point of Mode A. A library's top-level `const` is simply
  // in scope for the body — no forwarding, no bridge, no name analysis.
  const wrapped = wrapCombinedEntry({
    ...COMBINED_ARGS,
    requireUrls: ['sourcemonkey://SourceMonkey/x/cdn/lib.js'],
    script: scriptWith({
      bodyText: 'return tag("ok");',
      requires: [req('const tag = (s) => "from-require:" + s;')],
    }),
  });
  // Strip the wrap and run it: the body sees the require's binding.
  let got;
  const stub = {
    __smPrelude: { send: () => {} },
    __smRun: (_id, fn) => { got = fn({ decision: {}, cfg: { name: 'n', id: 'abc', loadedAt: 0 } }); },
  };
  new Function('self', wrapped)(stub);
  assert.equal(got, 'from-require:ok');
});

test('wrapCombinedEntry: a `;` separator defeats ASI hazards at the seam', () => {
  const wrapped = wrapCombinedEntry({
    ...COMBINED_ARGS,
    requireUrls: ['sourcemonkey://SourceMonkey/x/cdn/lib.js'],
    script: scriptWith({ bodyText: 'BODY', requires: [req('const a = 1')] }),
  });
  const lines = wrapped.split('\n');
  assert.equal(lines[1], '// @require https://cdn/x.js');
  assert.equal(lines[2], 'const a = 1');
  assert.equal(lines[3], ';');
  assert.equal(lines[4], 'BODY');
});

test('wrapCombinedEntry: requires → an inline source map is appended', () => {
  const wrapped = wrapCombinedEntry({
    ...COMBINED_ARGS,
    requireUrls: ['sourcemonkey://SourceMonkey/x/cdn/lib.js'],
    script: scriptWith({ bodyText: 'B1\nB2', requires: [req('R1\nR2\nR3')] }),
  });
  const map = decodeInlineMap(wrapped);
  assert.deepEqual(map.sources, [
    'sourcemonkey://SourceMonkey/x/cdn/lib.js',
    'sourcemonkey://SourceMonkey/x/Foo.user.js',
  ]);
  assert.deepEqual(map.sourcesContent, ['R1\nR2\nR3', 'B1\nB2']);
  // Every generated line maps back to its original file and line.
  const resolved = resolveMap(map, wrapped);
  const gen = wrapped.split('\n');
  assert.equal(gen[2], 'R1');
  assert.deepEqual(resolved[2], { source: map.sources[0], line: 1 });
  assert.equal(gen[4], 'R3');
  assert.deepEqual(resolved[4], { source: map.sources[0], line: 3 });
  assert.equal(gen[6], 'B1');
  assert.deepEqual(resolved[6], { source: map.sources[1], line: 1 });
  assert.equal(gen[7], 'B2');
  assert.deepEqual(resolved[7], { source: map.sources[1], line: 2 });
  // The head, the `// @require` comment, the `;` and the tail are
  // deliberately unmapped — they aren't the user's code.
  assert.equal(resolved[0], null);
  assert.equal(resolved[1], null);
  assert.equal(resolved[5], null);
});

test('wrapCombinedEntry: line counting matches V8 on every line terminator', () => {
  // The map is only as good as the line arithmetic behind it. V8
  // treats lone \r, U+2028 and U+2029 as line breaks — U+2028 even
  // inside a string literal (legal since ES2019, and minified CDN
  // bundles do embed them). Counting only \n silently shifts every
  // mapping after the offending character, including the user's body.
  const cases = [
    ['LF',              'A\nB'],
    ['CRLF',            'A\r\nB'],
    ['lone CR',         'A\rB'],
    ['U+2028',          'A\u2028B'],
    ['U+2029',          'A\u2029B'],
    ['U+2028 in string', 'var s="A\u2028B";\nC'],
    ['trailing CR', 'A\rB\r'],
    ['CR-only file', 'A\rB\rC\r'],
  ];
  for (const [label, requireSrc] of cases) {
    const wrapped = wrapCombinedEntry({
      ...COMBINED_ARGS,
      requireUrls: ['sourcemonkey://SourceMonkey/x/cdn/lib.js'],
      script: scriptWith({ bodyText: 'BODYLINE', requires: [req(requireSrc)] }),
    });
    // Where the body actually lands, per V8's own line splitting.
    const actual = wrapped.split(V8_LINE_TERMINATORS).findIndex((l) => l === 'BODYLINE');
    const map = decodeInlineMap(wrapped);
    const resolved = resolveMap(map, wrapped);
    assert.deepEqual(
      resolved[actual],
      { source: 'sourcemonkey://SourceMonkey/x/Foo.user.js', line: 1 },
      `${label}: body line is mis-mapped`,
    );
  }
});

test('wrapCombinedEntry: a require ending in a lone CR still owns exactly its own lines', () => {
  // The seam guard. `\r` + the separator's `\n` is a single CRLF, so
  // without an extra `\n` the require's last line and the `;` seam
  // collapse onto one physical line — and the map hands that line to
  // the require, pointing a breakpoint or stack frame at code the
  // user never wrote. (The body itself stays correctly mapped either
  // way, because line numbers are derived from the emitted text
  // rather than from a running total — so asserting on the body's
  // position would NOT catch this.)
  const wrapped = wrapCombinedEntry({
    ...COMBINED_ARGS,
    requireUrls: ['sourcemonkey://SourceMonkey/x/cdn/lib.js'],
    script: scriptWith({ bodyText: 'BODY1', requires: [req('A\rB\r')] }),
  });
  const map = decodeInlineMap(wrapped);
  const resolved = resolveMap(map, wrapped);
  const gen = wrapped.split(V8_LINE_TERMINATORS);

  // The require's three lines — 'A', 'B', and the empty one its
  // trailing CR creates — each map to themselves.
  assert.deepEqual(gen.slice(2, 5), ['A', 'B', '']);
  assert.deepEqual(resolved[2], { source: map.sources[0], line: 1 });
  assert.deepEqual(resolved[3], { source: map.sources[0], line: 2 });
  assert.deepEqual(resolved[4], { source: map.sources[0], line: 3 });
  // The seam is ours, not the require's.
  assert.equal(gen[5], ';');
  assert.equal(resolved[5], null);
  // And the body still lands where the map says.
  assert.equal(gen[6], 'BODY1');
  assert.deepEqual(resolved[6], { source: map.sources[1], line: 1 });
});

test('wrapCombinedEntry: map.file is the entry\'s own sourceURL, which is also a source', () => {
  // The generated script and its own body claim the same URL. That
  // collision is what bundlers avoid with `webpack://`-style prefixes,
  // because devtools keys files by URL — so this is pinned rather than
  // left implicit.
  //
  // Verified in Chrome's Sources panel: the mapped source shadows the
  // generated script, and a one-require script shows exactly two
  // entries (the `.user.js`, and the require nested under a
  // `<host>/<path>` subtree), both with their original text. Keeping
  // the URLs identical is also what lets the Log tab's stack-ref
  // linkification match on a single string.
  const wrapped = wrapCombinedEntry({
    ...COMBINED_ARGS,
    requireUrls: ['sourcemonkey://SourceMonkey/x/cdn/lib.js'],
    script: scriptWith({ bodyText: 'B', requires: [req('R')] }),
  });
  const map = decodeInlineMap(wrapped);
  assert.equal(map.file, 'sourcemonkey://SourceMonkey/x/Foo.user.js');
  assert.equal(map.sources[map.sources.length - 1], map.file);
  assert.match(wrapped, /\/\/# sourceURL=sourcemonkey:\/\/SourceMonkey\/x\/Foo\.user\.js/);
});

test('wrapCombinedEntry: source map survives non-Latin1 source', () => {
  // btoa alone throws on anything above U+00FF, and the script that
  // prompted Mode A is half Chinese.
  const wrapped = wrapCombinedEntry({
    ...COMBINED_ARGS,
    requireUrls: ['sourcemonkey://SourceMonkey/x/cdn/lib.js'],
    script: scriptWith({
      bodyText: 'const 名前 = "增强";',
      requires: [req('// 配置\nconst z = 1;')],
    }),
  });
  const map = decodeInlineMap(wrapped);
  assert.deepEqual(map.sourcesContent, ['// 配置\nconst z = 1;', 'const 名前 = "增强";']);
});

// V8's line terminators, which the source map has to agree with:
// CRLF as one, plus lone CR and the two Unicode separators.
const V8_LINE_TERMINATORS = /\r\n|[\n\r\u2028\u2029]/;

// Pull the inline source map back out of a generated entry.
function decodeInlineMap(code) {
  const m = code.match(/\/\/# sourceMappingURL=data:application\/json;charset=utf-8;base64,(.+)/);
  assert.ok(m, 'no inline source map found');
  return JSON.parse(Buffer.from(m[1], 'base64').toString('utf8'));
}

// Decode `mappings` into one {source, line} (1-based) per generated
// line, or null where the line is unmapped.
function resolveMap(map, code) {
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const decodeGroup = (group) => {
    const out = [];
    let shift = 0;
    let value = 0;
    for (const ch of group) {
      const digit = B64.indexOf(ch);
      value += (digit & 31) << shift;
      if (digit & 32) { shift += 5; continue; }
      out.push((value & 1) ? -(value >> 1) : (value >> 1));
      shift = 0;
      value = 0;
    }
    return out;
  };
  let srcIdx = 0;
  let origLine = 0;
  return map.mappings.split(';').map((group) => {
    if (!group) return null;
    const [, dSrc, dLine] = decodeGroup(group);
    srcIdx += dSrc;
    origLine += dLine;
    return { source: map.sources[srcIdx], line: origLine + 1 };
  });
}


// ---------- composeRequiredBody (kept for reload-fast-path) ----------

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

// 1-based physical line of the (unique) marker in `code`.
function generatedLineOf(code, marker) {
  const lines = code.split('\n');
  const idx = lines.findIndex((l) => l.includes(marker));
  assert.ok(idx >= 0, `marker ${marker} not found in generated code`);
  return idx + 1;
}

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
  const { body } = await buildSwapEvalBody(script, '0.0.0');
  const gmPos = body.indexOf('const GM_setValue');
  const userPos = body.indexOf('GM_setValue("k","v")');
  assert.ok(gmPos >= 0, 'GM_setValue binding should be prepended');
  assert.ok(userPos > gmPos, 'user-code reference should follow the binding');
  // GM_info is also prepended (implicit, TM/VM compat) so a swapped
  // body that touches GM_info doesn't ReferenceError.
  assert.match(body, /const GM_info = /);
});

test('buildSwapEvalBody: reports needsValues from the swapped body\'s own grants', async () => {
  // The SW ships this flag on the run-new reply and the prelude uses
  // it to seed the storage cache before the eval. It has to describe
  // the NEW row — the registered wrapper's own request flag says
  // nothing about a grant the refresh just added.
  const storing = makeScript({
    header: { tags: [{ tag: 'name', value: 'S' }, { tag: 'grant', value: 'GM_getValue' }] },
    bodyText: 'GM_getValue("k");',
  });
  assert.equal((await buildSwapEvalBody(storing, '0.0.0')).needsValues, true);

  // Same script with the storage grant dropped: nothing to seed.
  const plain = makeScript({
    header: { tags: [{ tag: 'name', value: 'S' }, { tag: 'grant', value: 'GM_addStyle' }] },
    bodyText: 'GM_addStyle("body{}");',
  });
  assert.equal((await buildSwapEvalBody(plain, '0.0.0')).needsValues, false);
});

test('buildSwapEvalBody: prepends resource.init so a swapped body sees its @resources', async () => {
  // resource.init lives in `js` precisely so the swap path gets it.
  // Before that move it was prelude-only, and a hot-swapped script's
  // GM_getResourceText read whatever box the prior version left.
  const script = makeScript({
    header: { tags: [{ tag: 'name', value: 'S' }, { tag: 'grant', value: 'GM_getResourceText' }] },
    bodyText: 'GM_getResourceText("r");',
    resources: [{ name: 'r', bytesBase64: 'YQ==', contentType: 'text/plain', url: 'https://cdn/r', ref: 'r', size: 1, contentHash: '', loadedAt: 0 }],
  });
  const { body } = await buildSwapEvalBody(script, '0.0.0');
  assert.match(body, /__SM_GM__\.resource\.init\(/);
  assert.match(body, /"r":\{"b64":"YQ=="/);
});

test('buildSwapEvalBody: a swapped body with @requires shares their scope', async () => {
  // `composeRequiredBody` is now the same concatenation the
  // registration uses, so the swap path gets shared scope for free —
  // but nothing exercised it end-to-end with a require present.
  const script = makeScript({
    bodyText: 'return tag("ok");',
    requires: [{
      url: 'https://cdn/x.js', source: 'const tag = (s) => "from-require:" + s;',
      ref: 'x', size: 0, contentHash: '', loadedAt: 0,
    }],
  });
  const { body } = await buildSwapEvalBody(script, '0.0.0', 'a.user.js');
  // The swap eval is a single (0,eval) of this string, so evaluating
  // it in one scope is exactly what the prelude does.
  assert.equal(new Function(`${body}`)(), 'from-require:ok');
  // It carries the same inline source map a fresh registration emits,
  // so devtools splits a hot-swapped script back into its original
  // files instead of showing concatenated line numbers.
  assert.match(body, /sourceMappingURL=data:application\/json/);
});

test('buildSwapEvalBody: puts user code on the same generated line as the registered entry', async () => {
  // The viewer's Log tab maps a stack line back to its original file
  // without knowing whether the script was registered or hot-swapped,
  // so the two paths must lay their lines out identically. There are
  // TWO layouts to keep in step, and the no-require one is the trap:
  // the registered path deliberately puts the body's first line on the
  // SAME physical line as the wrap head (so generated line N ==
  // original line N and no map is needed), and a swap body that adds a
  // newline there shifts every logged stack line by one — invisibly,
  // because a script with no requires has no segments to map by.
  //
  // Compare the real outputs rather than a hardcoded index: an
  // assertion that doesn't call wrapCombinedEntry can't notice drift.
  const cases = [
    ['no requires, with GM bindings', makeScript({
      header: { tags: [{ tag: 'name', value: 'S' }, { tag: 'grant', value: 'GM_setValue' }] },
      bodyText: 'FIRST_BODY_LINE;',
    })],
    ['no requires, no bindings', { ...makeScript({ bodyText: 'FIRST_BODY_LINE;' }), header: null }],
    ['with requires', makeScript({
      bodyText: 'FIRST_BODY_LINE;',
      requires: [{
        url: 'https://cdn/x.js', source: 'R1;\nR2;',
        ref: 'x', size: 0, contentHash: '', loadedAt: 0,
      }],
    })],
  ];
  for (const [label, script] of cases) {
    const spec = await buildRegistrationSpec(script, '0.0.0', 'a.user.js');
    const swap = await buildSwapEvalBody(script, '0.0.0', 'a.user.js');
    assert.equal(
      generatedLineOf(swap.body, 'FIRST_BODY_LINE;'),
      generatedLineOf(spec.js[2].code, 'FIRST_BODY_LINE;'),
      `${label}: swap and registered disagree on where user code lands`,
    );
  }
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
  const { body } = await buildSwapEvalBody(script, '0.0.0');
  assert.match(body, /const GM_info = /);
  // No __SM_GM__ in MAIN, so non-info bindings aren't included.
  assert.doesNotMatch(body, /__SM_GM__/);
});

test('buildSwapEvalBody: passes through plain body when no header (defensive)', async () => {
  // Headerless scripts aren't a production case (validateHeader
  // rejects them), but the helper should still return something
  // eval-able rather than throwing. No preamble and no requires means
  // the body passes through untouched — same shape the registered
  // path emits after its wrap head.
  const script = { ...makeScript(), header: null };
  const { body } = await buildSwapEvalBody(script, '0.0.0');
  assert.equal(body, 'console.log("hi");');
});

// ---------- buildRegistrationSpec ----------

test('buildRegistrationSpec: passes @match values through as matches', async () => {
  const spec = await buildRegistrationSpec(makeScript());
  assert.deepEqual(spec.matches, ['https://example.com/*']);
});

test('buildRegistrationSpec: drops a @match Chrome would refuse, keeping the rest', async () => {
  // Chrome refuses the whole registration over one malformed pattern,
  // so a script with one good `@match` and one bad one would never run
  // at all if we passed both through. The bad one can't match anything
  // anyway, and the reason is already a warning in the script's Log.
  const spec = await buildRegistrationSpec(makeScript({
    matching: {
      matches: ['https://example.com/*', 'https://example.com', 'https://www.*.com/*'],
      excludes: [],
      includes: [],
    },
  }));
  assert.deepEqual(spec.matches, ['https://example.com/*']);
});

test('buildRegistrationSpec: registers the canonical spelling of a lenient @match', async () => {
  // Chrome's parser refuses a scheme-less pattern and a scheme glob,
  // so what it gets is the `*://…` form that means the same thing —
  // otherwise the pattern would be dropped and the script would stop
  // running where its author said it should.
  const spec = await buildRegistrationSpec(makeScript({
    matching: {
      matches: ['*.example.com/*', 'http*://other.example/*', '*://other.example/*'],
      excludes: [],
      includes: [],
    },
  }));
  // The last two canonicalize to the same pattern; a duplicate is
  // dropped rather than handed to Chrome twice.
  assert.deepEqual(spec.matches, ['*://*.example.com/*', '*://other.example/*']);
});

test('buildRegistrationSpec: a scheme glob naming several schemes registers one pattern each', async () => {
  const spec = await buildRegistrationSpec(makeScript({
    matching: { matches: ['f*://host.example/*'], excludes: [], includes: [] },
  }));
  assert.deepEqual(spec.matches, ['file://host.example/*', 'ftp://host.example/*']);
});

test('buildRegistrationSpec: an expansion Chrome would refuse is dropped, its siblings kept', async () => {
  // `f*` names file and ftp, and an empty host is legal only for file.
  // The good form has to survive on its own — and `matchPatternProblem`
  // agrees the pattern is fine, so nothing warns about it either.
  const spec = await buildRegistrationSpec(makeScript({
    matching: { matches: ['f*:///*'], excludes: [], includes: [] },
  }));
  assert.deepEqual(spec.matches, ['file:///*']);
});

test('buildRegistrationSpec: unusable @match with a regex @include still falls back to <all_urls>', async () => {
  // Nothing left for Chrome to match on, but the wrapper-side matcher
  // has a regex to apply — same path as a script that declared no
  // `@match` at all.
  const spec = await buildRegistrationSpec(makeScript({
    matching: {
      matches: ['https://example.com'],
      excludes: [],
      includes: ['/^https:\\/\\/foo\\..*$/'],
    },
  }));
  assert.deepEqual(spec.matches, ['<all_urls>']);
});

test('buildRegistrationSpec: nothing usable at all registers nothing', async () => {
  // `validateHeader` stores such a script `invalid`, so this is the
  // belt-and-braces case: no spec rather than a spec Chrome refuses.
  const spec = await buildRegistrationSpec(makeScript({
    matching: { matches: ['https://example.com'], excludes: [], includes: [] },
  }));
  assert.equal(spec, null);
});

test('buildRegistrationSpec: @include glob → includeGlobs; /regex/ form goes to wrapper', async () => {
  const spec = await buildRegistrationSpec(makeScript({
    matching: {
      matches: [],
      excludes: [],
      includes: ['*://example.com/*', '/^https:\\/\\/foo\\..*$/'],
    },
  }));
  assert.deepEqual(spec.matches, ['<all_urls>']);
  assert.deepEqual(spec.includeGlobs, ['*://example.com/*']);
  // The regex pattern travels through the config blob into the
  // prelude's runtime matcher.
  const cfg = spec.js[0];
  assert.ok('code' in cfg);
  assert.match(cfg.code, /"matching"/);
});

test('buildRegistrationSpec: glob-only @include still gets a matches pattern', async () => {
  // Chrome refuses a registration without `matches`, so an
  // `@include`-only script rides in on `<all_urls>`.
  const spec = await buildRegistrationSpec(makeScript({
    matching: { matches: [], excludes: [], includes: ['*://example.com/*'] },
  }));
  assert.deepEqual(spec.matches, ['<all_urls>']);
  assert.deepEqual(spec.includeGlobs, ['*://example.com/*']);
  // Chrome ORs includeGlobs with matches, so `<all_urls>` runs the
  // script everywhere — the wrapper's matcher is what holds it to the
  // glob. Its block has to be in the config blob.
  const cfg = spec.js[0];
  assert.ok('code' in cfg);
  assert.match(cfg.code, /"matching"/);
});

test('buildRegistrationSpec: @match beside a glob @include leaves matching to Chrome', async () => {
  // Chrome ORs includeGlobs with matches (measured — see
  // tests/e2e/include-only.spec.ts), which is what the header means,
  // so this shape needs no wrapper-side matcher.
  const spec = await buildRegistrationSpec(makeScript({
    matching: {
      matches: ['https://example.com/*'],
      excludes: [],
      includes: ['*://other.example/*'],
    },
  }));
  assert.deepEqual(spec.matches, ['https://example.com/*']);
  assert.deepEqual(spec.includeGlobs, ['*://other.example/*']);
  const cfg = spec.js[0];
  assert.ok('code' in cfg);
  assert.doesNotMatch(cfg.code, /"matching"/);
});

test('buildRegistrationSpec: all @match patterns refused + glob @include falls back to <all_urls>', async () => {
  // `https://example.com` (no path) is a pattern Chrome's grammar
  // refuses, so it never reaches the spec — leaving the script with
  // globs only, which is the fallback case.
  const spec = await buildRegistrationSpec(makeScript({
    matching: {
      matches: ['https://example.com'],
      excludes: [],
      includes: ['*://example.com/*'],
    },
  }));
  assert.deepEqual(spec.matches, ['<all_urls>']);
  assert.deepEqual(spec.includeGlobs, ['*://example.com/*']);
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

test('buildRegistrationSpec: a regex @include beside a @match still registers <all_urls>', async () => {
  // Registering only the @match would never inject on a page just the
  // regex covers.
  const spec = await buildRegistrationSpec(makeScript({
    matching: { matches: ['https://a.test/*'], excludes: [], includes: ['/^https:\\/\\/b\\.test\\//'] },
  }));
  assert.deepEqual(spec.matches, ['<all_urls>']);
  const cfg = spec.js[0];
  assert.ok('code' in cfg);
  assert.match(cfg.code, /"matching"/);
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

test('buildRegistrationSpec: js[] shape is [config, prelude, combined, seal]', async () => {
  const spec = await buildRegistrationSpec(makeScript({
    requires: [
      { url: 'https://cdn.example.com/a.js', source: 'A();', ref: 'a', size: 0, contentHash: '', loadedAt: 0 },
      { url: 'https://cdn.example.com/b.js', source: 'B();', ref: 'b', size: 0, contentHash: '', loadedAt: 0 },
    ],
  }));
  // makeScript()'s relativePath is `a.user.js` → default logLabel
  // (basename, no dedup) → folder `a` under SourceMonkey/.
  // Requires no longer get their own entries — they're concatenated
  // into js[2] so they share the body's scope, and the source map
  // gives them back their devtools identity.
  // The prelude stays inline (not a separate singleton registration):
  // cross-registration order isn't guaranteed by chrome.userScripts,
  // and the combined entry's self.__smRun() call has no safety net.
  assert.equal(spec.js.length, 4);
  assert.ok('code' in spec.js[0]);
  // Config blob carries a per-script `__config.js` sourceURL.
  assert.match(spec.js[0].code, /sourceURL=sourcemonkey:\/\/SourceMonkey\/a\/__config\.js/);
  // Prelude inclusion — bytes are WRAPPER_PRELUDE; URL is the
  // page-wide `__prelude.js` so devtools tree-dedups all N
  // inclusions into one visible entry.
  assert.ok('code' in spec.js[1]);
  assert.ok(spec.js[1].code.startsWith(WRAPPER_PRELUDE));
  assert.match(spec.js[1].code, /sourceURL=sourcemonkey:\/\/SourceMonkey\/__prelude\.js/);
  // One entry carrying both requires and the body, in order.
  const combined = spec.js[2];
  assert.ok('code' in combined);
  assert.ok(combined.code.indexOf('A();') < combined.code.indexOf('B();'));
  assert.ok(combined.code.indexOf('B();') < combined.code.indexOf('console.log("hi");'));
  assert.match(combined.code, /sourceURL=sourcemonkey:\/\/SourceMonkey\/a\/a\.user\.js/);
  // Require provenance moves from per-entry sourceURLs into the map.
  assert.match(combined.code, /sourceMappingURL=data:application\/json/);
  // Trailing sentinel: its own script, so it still runs when the
  // combined entry fails to parse.
  assert.ok('code' in spec.js[3]);
  assert.match(spec.js[3].code, /^self\.__smSealed\("script-1"\);/);
});

test('buildRegistrationSpec: js[] shape with no requires is [config, prelude, combined, seal]', async () => {
  const spec = await buildRegistrationSpec(makeScript());
  assert.equal(spec.js.length, 4);
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
  // js[2] is the user program; js[3] is the parse-failure sentinel.
  const main = spec.js[2];
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

test('buildRegistrationSpec: ONE GM binding block serves the requires and the body', async () => {
  // Separate entries meant separate lexical scopes, so the binding
  // prefix had to be repeated per require — "tens of KB of duplicated
  // prefix" for a script with a verbose header and several requires.
  // One scope means one copy, which is also what TM/VM do.
  const spec = await buildRegistrationSpec(makeScript({
    header: { tags: [{ tag: 'name', value: 'X' }, { tag: 'grant', value: 'GM_setValue' }] },
    requires: [{ url: 'https://cdn/a.js', source: 'A();', ref: 'a', size: 0, contentHash: '', loadedAt: 0 }],
  }));
  const combined = spec.js[2].code;
  assert.ok('code' in spec.js[2]);
  assert.equal(combined.match(/const GM_setValue/g).length, 1);
  // Emitted ahead of the first require, so library top-level code
  // sees it too.
  assert.ok(combined.indexOf('const GM_setValue') < combined.indexOf('A();'));
  assert.match(combined, /__SM_GM__\.storage\.set\("script-1"/);
});

test('buildRegistrationSpec: @require entries get GM_info even without any other @grant', async () => {
  // GM_info is implicit (TM/VM compat). A library require that does
  // `typeof GM_info !== "undefined"` should pass even when the host
  // script has no grants at all.
  const spec = await buildRegistrationSpec(makeScript({
    header: { tags: [{ tag: 'name', value: 'Hello' }] },
    requires: [{ url: 'https://cdn/p.js', source: 'P();', ref: 'p', size: 0, contentHash: '', loadedAt: 0 }],
  }));
  const combined = spec.js[2];
  assert.ok('code' in combined);
  assert.match(combined.code, /const GM_info = Object\.freeze/);
  assert.ok(combined.code.indexOf('const GM_info') < combined.code.indexOf('P();'));
});

// Every emitted entry must PARSE. The combined entry splices the
// user's requires and body into one function, so any seam bug shows
// up here as a SyntaxError — which at runtime means the script
// silently never runs at all.
function assertAllEntriesParse(spec, label) {
  spec.js.forEach((entry, idx) => {
    if (!('code' in entry)) return;
    assert.doesNotThrow(
      () => new Function('self', entry.code),
      `${label}: js[${idx}] does not parse`,
    );
  });
}

// Run a built spec's combined entry (js[2]) with a stubbed `self` and
// return whatever the user body returned.
function runCombined(spec, extraSelf = {}) {
  let out;
  const stub = {
    __smPrelude: { send: () => {} },
    // A storage grant makes the GM prelude call storage.init off a
    // snapshot the SW attaches to the check-pending reply; without one
    // it bails before the body runs.
    __SM_GM__: { storage: { init: () => {} } },
    __smRun: (_id, fn) => {
      out = fn({
        decision: { gmValues: {} },
        cfg: { name: 'n', id: 'script-1', loadedAt: 0 },
      });
    },
    ...extraSelf,
  };
  stub.window = stub.window ?? stub;
  // The GM bindings reference `window` as a bare identifier, so it has
  // to be a real binding in the evaluated scope, not just `self.window`.
  new Function('self', 'window', spec.js[2].code)(stub, stub.window);
  return out;
}

test('buildRegistrationSpec: a @require top-level const is visible to the body', async () => {
  // The github-html-preview shape: a library declares its helpers as
  // top-level `const`s. Under separate entries these were trapped in
  // the require's own V8 scope and needed a name-forwarding bridge.
  // Concatenated, they are simply in scope.
  const utilsSrc = [
    '"use strict";',
    'const $ = (s) => s;',
    'const on = (a, b) => a + b;',
  ].join('\n');
  const spec = await buildRegistrationSpec(makeScript({
    bodyText: 'return on($("a"), "b");',
    requires: [{
      url: 'https://cdn/utils.js', source: utilsSrc, ref: 'u',
      size: 0, contentHash: '', loadedAt: 0,
    }],
  }));
  assert.equal(runCombined(spec), 'ab');
  assertAllEntriesParse(spec, 'top-level const');
});

test('buildRegistrationSpec: a @require top-level class is visible to the body', async () => {
  // The GM_config case that started this: a minified library whose
  // whole API is one top-level `class`, with no `/* exported */`
  // directive to read and a `GM_`-prefixed name.
  const spec = await buildRegistrationSpec(makeScript({
    header: { tags: [{ tag: 'name', value: 'X' }, { tag: 'grant', value: 'GM_setValue' }] },
    bodyText: 'return GM_config.label("ok");',
    requires: [{
      url: 'https://cdn/config.min.js',
      source: '// ==UserScript==\n// @name C\n// ==/UserScript==\nclass GM_config{static label(s){return "from-class:"+s}}',
      ref: 'c', size: 0, contentHash: '', loadedAt: 0,
    }],
  }));
  assert.equal(runCombined(spec), 'from-class:ok');
  // The GM binding block still emits its own `const GM_setValue`, in
  // the same scope, without colliding.
  assert.match(spec.js[2].code, /const GM_setValue = /);
  assertAllEntriesParse(spec, 'top-level class');
});

test('buildRegistrationSpec: a body IIFE shadows a @require name normally', async () => {
  // Ordinary lexical shadowing now that there is one scope, and the
  // shape nearly every real userscript uses.
  const spec = await buildRegistrationSpec(makeScript({
    bodyText: 'return (function () { const label = "from-body"; return label; })();',
    requires: [{
      url: 'https://cdn/x.js', source: 'const label = "from-require";',
      ref: 'x', size: 0, contentHash: '', loadedAt: 0,
    }],
  }));
  assertAllEntriesParse(spec, 'body IIFE shadows require');
  // Parsing isn't the claim — which binding wins is. Run it.
  assert.equal(runCombined(spec), 'from-body');
});

test('buildRegistrationSpec: a body top-level redeclaration collides, exactly as in TM', async () => {
  // One scope means real JS rules: the body's top-level `const label`
  // beside the require's `const label` is a redeclaration. TM/VM
  // concatenate the same way and fail the same way, so this is
  // compatibility, not a regression — but it IS a behavior change from
  // the separate-entries arrangement, where the two never met. See
  // docs/injection-modes.md.
  const spec = await buildRegistrationSpec(makeScript({
    bodyText: 'const label = "from-body";',
    requires: [{
      url: 'https://cdn/x.js', source: 'const label = "from-require";',
      ref: 'x', size: 0, contentHash: '', loadedAt: 0,
    }],
  }));
  assert.throws(() => new Function('self', spec.js[2].code), /already been declared/);
});

test('buildRegistrationSpec: shapes that used to break the name bridge now just work', async () => {
  // Each of these defeated a heuristic in the separate-entries name
  // bridge — comma declarator lists hid a declarator, destructuring
  // patterns had no single name to read, a named class EXPRESSION
  // looked like a top-level declaration. None of them are special
  // cases any more, because nothing analyses the source at all.
  const cases = [
    ['comma list',   'const helper = 3;', 'const a = 9, other = 1;\nreturn helper + a + other;', 13],
    ['destructure',  'const helper = 7;', 'const {x} = {x: 1};\nreturn helper + x;', 8],
    ['class expr',   'window.lib = class lib { static t(){ return "L" } };', 'return window.lib.t();', 'L'],
    ['minified one-liner', 'class A{static t(){return "A"}}const b=A.t();', 'return b;', 'A'],
  ];
  for (const [label, libSrc, body, expected] of cases) {
    const spec = await buildRegistrationSpec(makeScript({
      bodyText: body,
      requires: [{
        url: 'https://cdn/x.js', source: libSrc, ref: 'x',
        size: 0, contentHash: '', loadedAt: 0,
      }],
    }));
    assertAllEntriesParse(spec, label);
    assert.equal(runCombined(spec, { window: { lib: undefined } }), expected, label);
  }
});

test('buildRegistrationSpec: multiple @requires share the scope in declaration order', async () => {
  const spec = await buildRegistrationSpec(makeScript({
    bodyText: 'return first + second;',
    requires: [
      { url: 'https://cdn/a.js', source: 'const first = "A";', ref: 'a', size: 0, contentHash: '', loadedAt: 0 },
      // The 2nd require can see the 1st — same scope, in order.
      { url: 'https://cdn/b.js', source: 'const second = first + "B";', ref: 'b', size: 0, contentHash: '', loadedAt: 0 },
    ],
  }));
  assert.equal(runCombined(spec), 'AAB');
});

test('buildRegistrationSpec: a require lands in the source map, not its own entry', async () => {
  const spec = await buildRegistrationSpec(makeScript({
    bodyText: 'B1\nB2',
    requires: [{
      url: 'https://cdn/x.js', source: 'R1\nR2', ref: 'x',
      size: 0, contentHash: '', loadedAt: 0,
    }],
  }));
  assert.equal(spec.js.length, 4);
  const m = spec.js[2].code.match(/\/\/# sourceMappingURL=data:application\/json;charset=utf-8;base64,(.+)/);
  assert.ok(m);
  const map = JSON.parse(Buffer.from(m[1], 'base64').toString('utf8'));
  assert.deepEqual(map.sources, [
    'sourcemonkey://SourceMonkey/a/cdn/x.js',
    'sourcemonkey://SourceMonkey/a/a.user.js',
  ]);
  assert.deepEqual(map.sourcesContent, ['R1\nR2', 'B1\nB2']);
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
  // Shape: [config, prelude, combined, seal]
  const mainEntry = spec.js[2];
  assert.ok('code' in mainEntry);
  assert.match(mainEntry.code, /const GM_info = Object\.freeze/);
  assert.doesNotMatch(mainEntry.code, /__SM_GM__/);
});

test('buildRegistrationSpec: passes script.startupLogs through to the config blob', async () => {
  const script = makeScript({
    id: 'forwarded',
    startupLogs: [{ level: 'warn', message: 'Ignoring unsupported @grant GM_audio' }],
  });
  const spec = await buildRegistrationSpec(script);
  const cfg = spec.js[0];
  assert.ok('code' in cfg);
  assert.match(cfg.code, /"startupLogs":\[/);
  assert.match(cfg.code, /Ignoring unsupported @grant GM_audio/);
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

test('resolveWorld: multi @grant — "none" anywhere → MAIN, real grants only → USER_SCRIPT', () => {
  assert.equal(
    resolveWorld(makeHeader([
      { tag: 'grant', value: 'none' },
      { tag: 'grant', value: 'none' },
    ])),
    'MAIN',
  );
  // `none` wins, as it does for the bindings in resolveGrants.
  assert.equal(
    resolveWorld(makeHeader([
      { tag: 'grant', value: 'none' },
      { tag: 'grant', value: 'GM_setValue' },
    ])),
    'MAIN',
  );
  assert.equal(
    resolveWorld(makeHeader([
      { tag: 'grant', value: 'GM_getValue' },
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
// from url-match.ts — including the lenient readings, since the SW
// registers a pattern's canonical spelling and a wrapper that didn't
// know the rewrite would reject a page Chrome injected it on. The
// prelude file's matcher is the same algorithm (it lives inside
// src/userscript-prelude.js); we evaluate that block directly.

const MATCHER_BLOCK_START = '/* ---------- matcher (regex-aware URL recheck) ---------- */';
const MATCHER_BLOCK_END = '/* ---------- startup logs (page-console diagnostics) ---------- */';

async function loadPreludeMatcher() {
  // The matcher helpers are function declarations inside the prelude's
  // IIFE, so they can't be reached from outside it. Slice the block out
  // of the prelude source and evaluate THAT, rather than keeping a copy
  // here: a copy is a second implementation to keep in step, and this
  // one had already drifted (it predated the port handling).
  const source = await readFile(
    new URL('../../src/userscript-prelude.js', import.meta.url),
    'utf8',
  );
  const start = source.indexOf(MATCHER_BLOCK_START);
  const end = source.indexOf(MATCHER_BLOCK_END);
  assert.ok(start >= 0 && end > start, 'matcher block markers moved in userscript-prelude.js');
  const harness = source.slice(start, end) + '\n    return matchScript;';
  // eslint-disable-next-line no-new-func
  return new Function('URL', harness)(URL);
}

test('prelude matcher: @match passes', async () => {
  const match = await loadPreludeMatcher();
  assert.equal(match('https://example.com/x', { matches: ['https://example.com/*'], excludes: [], includes: [] }), true);
});

test('prelude matcher: a regex ignores case, as urlMatchesScript does', async () => {
  const match = await loadPreludeMatcher();
  const url = 'https://example.com/page';
  for (const [m, expected] of [
    [{ matches: [], excludes: [], includes: ['/EXAMPLE\\.COM\\/PAGE/'] }, true],
    [{ matches: ['https://example.com/*'], excludes: ['/PAGE/'], includes: [] }, false],
    [{ matches: [], excludes: [], includes: ['*EXAMPLE.COM*'] }, false],
  ]) {
    assert.equal(match(url, m), expected, JSON.stringify(m));
    assert.equal(urlMatchesScript(url, m), expected, JSON.stringify(m));
  }
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

test('prelude matcher: agrees with url-match.ts on the lenient shapes', async () => {
  const match = await loadPreludeMatcher();
  const cases = [
    ['*.example.com/*', 'https://www.example.com/x'],
    ['*.example.com/*', 'http://example.com/'],
    ['example.com/p/*', 'http://example.com/p/1'],
    ['//example.com/*', 'https://example.com/'],
    ['http*://example.com/*', 'http://example.com/'],
    ['*s://example.com/*', 'https://example.com/'],
    ['f*://example.com/*', 'ftp://example.com/x'],
  ];
  for (const [pattern, url] of cases) {
    const m = { matches: [pattern], excludes: [], includes: [] };
    assert.equal(match(url, m), true, `${pattern} should match ${url}`);
    assert.equal(
      urlMatchesScript(url, m),
      match(url, m),
      `prelude and url-match.ts disagree on ${pattern} / ${url}`,
    );
  }
  // And the negative side of the same shapes.
  for (const [pattern, url] of [
    ['*.example.com/*', 'https://example.org/'],
    ['http*://example.com/*', 'ftp://example.com/'],
    ['*s://example.com/*', 'http://example.com/'],
  ]) {
    const m = { matches: [pattern], excludes: [], includes: [] };
    assert.equal(match(url, m), false, `${pattern} should not match ${url}`);
    assert.equal(urlMatchesScript(url, m), false);
  }
});

test('prelude matcher: @match ignores the #hash, @include and @exclude see it, as urlMatchesScript does', async () => {
  // The bug this pins: Chrome injected a script with an exact @match on
  // a URL with a hash, and the regex @include (which ships the matcher
  // in-page) made the recheck here reject it.
  const match = await loadPreludeMatcher();
  const url = 'https://example.com/foo#part';
  const cases = [
    [{ matches: ['https://example.com/foo'], excludes: [], includes: ['/nomatch/'] }, true],
    [{ matches: ['https://example.com/foo#part'], excludes: [], includes: [] }, false],
    [{ matches: [], excludes: [], includes: ['*#part'] }, true],
    [{ matches: [], excludes: [], includes: ['https://example.com/foo'] }, false],
    [{ matches: ['https://example.com/*'], excludes: ['*#part'], includes: [] }, false],
  ];
  for (const [m, expected] of cases) {
    assert.equal(match(url, m), expected, JSON.stringify(m));
    assert.equal(urlMatchesScript(url, m), expected, JSON.stringify(m));
  }
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

test('buildBridgeSpec: emits a USER_SCRIPT spec on the union of the MAIN-world scripts\' patterns', () => {
  // Every MAIN-world script counts, granted or not (telemetry and the
  // reload handshake ride the bridge too); USER_SCRIPT-world scripts
  // don't, and neither does the bridge land anywhere else — a whole
  // isolated world per document is not free.
  const specs = [
    { id: 'a', world: 'USER_SCRIPT', matches: ['https://x/*'], js: [{ code: '' }], runAt: 'document_idle' },
    { id: 'b', world: 'MAIN', matches: ['https://y/*'], js: [{ code: '' }], runAt: 'document_idle' },
    { id: 'c', world: 'MAIN', matches: ['https://y/*', 'https://z/*'], includeGlobs: ['*://g/*'], js: [{ code: '' }], runAt: 'document_idle' },
  ];
  const bridge = buildBridgeSpec(specs);
  assert.ok(bridge, 'expected a bridge spec');
  assert.equal(bridge.id, BRIDGE_SCRIPT_ID);
  assert.equal(bridge.world, 'USER_SCRIPT');
  assert.deepEqual(bridge.matches, ['https://y/*', 'https://z/*']);
  assert.deepEqual(bridge.includeGlobs, ['*://g/*']);
  assert.equal(bridge.runAt, 'document_start');
  assert.match(bridge.js[0].code, /sourcemonkey-bridge-sync/);
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
// IIFE that closes over global `window` / `document` / `chrome`;
// passing those as parameters to a wrapping Function constructor lets
// us drive synthetic events through it and observe what reaches the SW
// and what it posts back.
//
// Page -> SW is a `sourcemonkey-bridge-sync` CustomEvent on
// `document`; SW -> page (replies, pushes) is window.postMessage.
function setupBridgeHarness(opts = {}) {
  const sent = [];
  const posted = [];
  const fakeChrome = {
    runtime: {
      sendMessage(payload) {
        sent.push(payload);
        if (opts.sendMessage) return opts.sendMessage(payload);
        return Promise.resolve({ ok: true });
      },
    },
  };
  let syncListener = null;
  let messageListener = null;
  const fakeWindow = {
    addEventListener(type, fn, _capture) {
      if (type === 'message') messageListener = fn;
    },
    postMessage(msg) { posted.push(msg); },
  };
  const fakeDocument = {
    addEventListener(type, fn, _capture) {
      if (type === 'sourcemonkey-bridge-sync') syncListener = fn;
    },
  };
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', 'chrome', WRAPPER_BRIDGE)(fakeWindow, fakeDocument, fakeChrome);
  if (!syncListener) throw new Error('bridge did not install the DOM-event listener');
  // Raw `detail`, for the malformed cases.
  const dispatchRaw = (detail) => syncListener({ detail });
  // The shape every page-side sender builds: {requestId?, payload}.
  const dispatch = (payload, requestId) => dispatchRaw(JSON.stringify({ requestId, payload }));
  return { sent, posted, dispatch, dispatchRaw, messageListener, fakeWindow };
}

test('wrapper-bridge: forwards a well-formed sm:start event, stamped', () => {
  const { sent, dispatch } = setupBridgeHarness();
  dispatch({ type: 'sm:start', id: 'x', url: 'https://e/' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'sm:start');
  assert.equal(sent[0].id, 'x');
  // Every relayed payload carries the "may be page-forged" stamp, and
  // a page-supplied `__viaBridge:false` can't suppress it.
  assert.equal(sent[0].__viaBridge, true);
});

test('wrapper-bridge: a page-supplied __viaBridge is overwritten, not honoured', () => {
  const { sent, dispatch } = setupBridgeHarness();
  dispatch({ type: 'sm:error', id: 'x', message: 'boom', __viaBridge: false });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].message, 'boom');
  assert.equal(sent[0].__viaBridge, true);
});

test('wrapper-bridge: page -> SW no longer listens on postMessage', () => {
  // The whole request direction moved onto the DOM event, so a page
  // (or a stale wrapper) posting the old envelope reaches nothing.
  const { sent, messageListener } = setupBridgeHarness();
  assert.equal(messageListener, null, 'no message listener should be installed');
  assert.equal(sent.length, 0);
});

test('wrapper-bridge: ignores a detail that is not a JSON envelope', () => {
  const { sent, dispatch, dispatchRaw } = setupBridgeHarness();
  dispatchRaw({ type: 'sm:start', id: 'x' });   // object, not a string
  dispatchRaw('{not json');
  dispatchRaw(JSON.stringify('a string'));
  dispatchRaw(JSON.stringify(null));
  dispatch(undefined);                          // envelope with no payload
  dispatch('string-payload');
  assert.equal(sent.length, 0);
});

test('wrapper-bridge: only forwards allowlisted payload types', () => {
  const { sent, posted, dispatch } = setupBridgeHarness();
  dispatch({ type: 'sm:exec', code: 'evil' });
  dispatch({ type: '', id: 'x' });
  // Not even a reply: a refused type never reached the SW, and staying
  // silent keeps the bridge from answering "is this type relayed?".
  dispatch({ type: 'sm:exec', code: 'evil' }, 'req-1');
  assert.equal(sent.length, 0);
  assert.equal(posted.length, 0);
});

test('wrapper-bridge: a requestId selects request/reply and posts the SW answer back', async () => {
  const { sent, posted, dispatch } = setupBridgeHarness({
    sendMessage: () => Promise.resolve({ action: 'run-new', body: 'x' }),
  });
  dispatch({ type: 'sm:check-pending', id: 's1', url: 'https://e/' }, 'req-7');
  // The forward is synchronous — that is the point of the event path.
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'sm:check-pending');
  assert.equal(sent[0].__viaBridge, true);
  await Promise.resolve();
  assert.equal(posted.length, 1);
  assert.equal(posted[0].__sm, 'sourcemonkey-bridge-reply');
  assert.equal(posted[0].requestId, 'req-7');
  assert.deepEqual(posted[0].reply, { action: 'run-new', body: 'x' });
});

test("wrapper-bridge: the reply is keyed on the envelope's id, not the payload's own", () => {
  // Several payloads carry a `requestId` of their own — sm:gm-tab-open
  // names the tab it is tracking, sm:gm-download-abort the download.
  // That collision is why the envelope nests the payload instead of
  // sitting beside `type`.
  const { sent, posted, dispatch } = setupBridgeHarness({
    sendMessage: () => ({ ok: true }),   // non-promise: replies synchronously
  });
  dispatch({ type: 'sm:gm-tab-open', scriptId: 's1', requestId: 'tab-1', url: 'https://e/' }, 'env-1');
  assert.equal(sent[0].requestId, 'tab-1', "the payload keeps its own id");
  assert.equal(posted[0].requestId, 'env-1', 'the reply is addressed to the caller');
});

test('wrapper-bridge: a failed SW call still answers the requestId', async () => {
  // The awaiter has to settle on something; `{action:"run"}` is the
  // reading every caller wants (run normally / treat as not-ok).
  const { posted, dispatch } = setupBridgeHarness({
    sendMessage: () => Promise.reject(new Error('worker gone')),
  });
  dispatch({ type: 'sm:check-pending', id: 's1' }, 'req-8');
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(posted.length, 1);
  assert.equal(posted[0].requestId, 'req-8');
  assert.deepEqual(posted[0].reply, { action: 'run' });
});

test('wrapper-bridge: a sendMessage that throws still answers the requestId', async () => {
  const { posted, dispatch } = setupBridgeHarness({
    sendMessage: () => { throw new Error('extension context invalidated'); },
  });
  dispatch({ type: 'sm:gm-batch-write', scriptId: 's1', writes: [] }, 'req-9');
  assert.equal(posted.length, 1, 'replied synchronously');
  assert.deepEqual(posted[0].reply, { action: 'run' });
});

test('wrapper-bridge: fire-and-forget swallows a rejected sendMessage', async () => {
  // No requestId means nobody is listening for an answer, so the bridge
  // has to attach its own `.catch` — an unhandled rejection would
  // surface in the page console as SourceMonkey's fault. Watched for
  // real rather than assumed: without that `.catch` the process hook
  // fires and this fails.
  const seen = [];
  const onUnhandled = (err) => { seen.push(err); };
  process.on('unhandledRejection', onUnhandled);
  try {
    const { sent, posted, dispatch } = setupBridgeHarness({
      sendMessage: () => Promise.reject(new Error('worker gone')),
    });
    dispatch({ type: 'sm:gm-batch-write', scriptId: 's1', writes: [] });
    assert.equal(sent.length, 1);
    assert.equal(posted.length, 0);
    await new Promise((resolve) => { setImmediate(resolve); });
    assert.deepEqual(seen, [], 'the bridge must swallow the rejection itself');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('wrapper-bridge: silently no-ops when chrome.runtime is unavailable', () => {
  let syncListener = null;
  const fakeDocument = {
    addEventListener(type, fn) { if (type === 'sourcemonkey-bridge-sync') syncListener = fn; },
  };
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', 'chrome', WRAPPER_BRIDGE)({ addEventListener() {} }, fakeDocument, {});
  assert.equal(syncListener, null);
});

// ---------- collectActiveSpecs ----------

function makeCollection(over = {}) {
  return {
    id: 'collection-1',
    path: '/p',
    lastRefreshedAt: 0,
    scriptIds: [],
    enabled: true,
    ...over,
  };
}

test('collectActiveSpecs: invalid scripts never run', async () => {
  const collections = new Map([['collection-1', makeCollection()]]);
  const { specs } = await collectActiveSpecs([
    makeScript({ id: 's1', status: 'invalid', errorMessage: 'x' }),
    makeScript({ id: 's2' }),
  ], collections);
  assert.deepEqual(specs.map((s) => s.id), ['s2']);
});

test('collectActiveSpecs: skips disabled scripts', async () => {
  const collections = new Map([['collection-1', makeCollection()]]);
  const { specs } = await collectActiveSpecs([
    makeScript({ id: 's1', enabled: false }),
    makeScript({ id: 's2' }),
  ], collections);
  assert.deepEqual(specs.map((s) => s.id), ['s2']);
});

test('collectActiveSpecs: skips every script under a disabled collection', async () => {
  const collections = new Map([['collection-1', makeCollection({ enabled: false })]]);
  const { specs } = await collectActiveSpecs([
    makeScript({ id: 's1' }),
    makeScript({ id: 's2' }),
  ], collections);
  assert.deepEqual(specs.map((s) => s.id), []);
});

test('collectActiveSpecs: skips scripts whose collection is missing entirely', async () => {
  const collections = new Map();
  const { specs } = await collectActiveSpecs([makeScript()], collections);
  assert.deepEqual(specs, []);
});

test('collectActiveSpecs: treats undefined `enabled` as true (back-compat)', async () => {
  const script = makeScript();
  delete script.enabled;
  const collection = makeCollection();
  delete collection.enabled;
  const { specs } = await collectActiveSpecs([script], new Map([['collection-1', collection]]));
  assert.equal(specs.length, 1);
});

// ---------- Generated-line round-trip ----------
//
// The viewer's Log tab does NOT read a persisted map. It recomputes
// the segment list from the stored script (src/composed-source.ts) and
// applies it to the line numbers in `err.stack`. That only works while
// the recomputed layout matches the code we actually registered, and
// nothing else in the suite would notice if the two drifted — the map
// tests check the map against the segments, and the wrap tests check
// the text, but no test checks the segments against the text.
//
// These do. They locate a marker's REAL physical line in the generated
// code, then assert the mapping sends that line back to the file and
// line the marker was written on.

function markerScript() {
  return makeScript({
    // Two requires with different line counts, so an off-by-one in
    // either the seam handling or the start line shows up as a wrong
    // FILE, not just a wrong line.
    bodyText: 'BODY_MARKER;',
    requires: [
      {
        url: 'https://cdn/a.js',
        source: 'A_FIRST;\nA_MARKER;\nA_LAST;',
        ref: 'a', size: 0, contentHash: '', loadedAt: 0,
      },
      {
        url: 'https://cdn/b.js',
        source: 'B_MARKER;',
        ref: 'b', size: 0, contentHash: '', loadedAt: 0,
      },
    ],
  });
}

// What the viewer computes, from the stored script alone.
function viewerSegments(script, label) {
  return composeSource(script, {
    requireUrls: (script.requires ?? []).map((r) => buildRequireSourceUrl(label, r.url)),
    mainUrl: buildSourceUrl(label),
    startLine: USER_SOURCE_START_LINE,
  }).segments;
}

function assertRoundTrip(code, script, label) {
  const entryUrl = buildSourceUrl(label);
  const segments = viewerSegments(script, label);
  const expected = [
    ['A_FIRST;', buildRequireSourceUrl(label, 'https://cdn/a.js'), 1],
    ['A_MARKER;', buildRequireSourceUrl(label, 'https://cdn/a.js'), 2],
    ['A_LAST;', buildRequireSourceUrl(label, 'https://cdn/a.js'), 3],
    ['B_MARKER;', buildRequireSourceUrl(label, 'https://cdn/b.js'), 1],
    // The body's marker is its only line, but the stored body carries
    // the metadata header ahead of it, so its original line is not 1.
    ['BODY_MARKER;', entryUrl, null],
  ];
  for (const [marker, url, origLine] of expected) {
    const gen = generatedLineOf(code, marker);
    const got = remapStackRef({ url: entryUrl, line: gen, col: 7 }, entryUrl, segments);
    assert.ok(got, `generated line ${gen} (${marker}) did not map`);
    assert.equal(got.url, url, `${marker} mapped to the wrong file`);
    assert.equal(got.col, 7, `${marker} lost its column`);
    if (origLine !== null) assert.equal(got.line, origLine, `${marker} mapped to the wrong line`);
  }
}

test('registered entry: generated lines map back to the file that owns them', async () => {
  const script = markerScript();
  const label = 'a.user.js';
  const spec = await buildRegistrationSpec(script, '0.0.0', label);
  // js[] is [config, prelude, combined, seal] — see assembleEntries.
  assertRoundTrip(spec.js[2].code, script, label);
});

test('swap-eval body: generated lines map back the same way', async () => {
  // The whole reason buildSwapEvalBody keeps its preamble on line 0:
  // the viewer applies ONE layout and can't tell which path ran.
  const script = markerScript();
  const label = 'a.user.js';
  assertRoundTrip((await buildSwapEvalBody(script, '0.0.0', label)).body, script, label);
});

test('registered entry: the body marker maps to its real line in the stored file', async () => {
  // Pinned separately from assertRoundTrip because it's the case a
  // reader is most likely to doubt: the mapped line must be the line
  // in the file the user edits, header included.
  const script = markerScript();
  const label = 'a.user.js';
  const spec = await buildRegistrationSpec(script, '0.0.0', label);
  const entryUrl = buildSourceUrl(label);
  const gen = generatedLineOf(spec.js[2].code, 'BODY_MARKER;');
  const got = remapStackRef({ url: entryUrl, line: gen, col: 1 }, entryUrl, viewerSegments(script, label));
  const storedBody = composeRequiredBody({ ...script, requires: [] });
  assert.equal(storedBody.split('\n')[got.line - 1], 'BODY_MARKER;');
});

// ---------- registerWithFallback: every refused attempt is logged ----------
//
// The Log is a transcript of what happened, and "we offered the spec
// again and Chrome refused again" happened. Suppressing the repeat
// would make a live refusal indistinguishable from a stale one, and
// would leave the row explaining nothing after a "Clear log".

const { getScriptLog, _flushScriptLogQueueForTests } = await import('../../dist/script-log.js');

const SPEC_A = { id: 'a', matches: ['https://e/*'], js: [{ code: '1' }] };

// Drive one sync. `bad` is the set of spec ids Chrome should reject;
// an empty set means the whole batch registers in one call, which is
// the path a recovered script comes back through.
async function syncOnce(specs, bad) {
  userScripts.register = async (batch) => {
    const rejected = batch.filter((s) => bad.has(s.id));
    if (rejected.length > 0) throw new Error(`bad spec: ${rejected[0].id}`);
  };
  await registerWithFallback(specs);
  await _flushScriptLogQueueForTests('a');
}

async function rejectionRows() {
  const log = await getScriptLog('a');
  return log.filter((e) => e.source === 'chrome-injector' && e.level === 'error').length;
}

// The other half of the injector's story: a refusal that finally went
// in. Info level, and required by the "every surfaced failure has a
// matching recovery line" rule in docs/script-log.md.
async function recoveryRows() {
  const log = await getScriptLog('a');
  return log.filter((e) => e.source === 'chrome-injector' && e.level === 'info').length;
}

test('registerWithFallback: every rejected attempt adds a row', async () => {
  sessionStore.clear();
  await syncOnce([SPEC_A], new Set(['a']));
  assert.equal(await rejectionRows(), 1);
  await syncOnce([SPEC_A], new Set(['a']));
  await syncOnce([SPEC_A], new Set(['a']));
  assert.equal(await rejectionRows(), 3, 'a retry that is refused again is a real event');
});

test('registerWithFallback: a cleared log refills on the next attempt', async () => {
  // The case that motivated dropping the old transition guard: with it,
  // "Clear log" then Refresh left the row flagged REJECTED with an
  // empty Log, which reads as though nothing is being retried.
  sessionStore.clear();
  await syncOnce([SPEC_A], new Set(['a']));
  assert.equal(await rejectionRows(), 1);

  const { clearScriptLog } = await import('../../dist/script-log.js');
  await clearScriptLog('a');
  assert.equal(await rejectionRows(), 0);

  await syncOnce([SPEC_A], new Set(['a']));
  assert.equal(await rejectionRows(), 1, 'the next sync must re-explain the badge');
});

test('registerWithFallback: a fix logs one recovery row, then stays quiet', async () => {
  sessionStore.clear();
  await syncOnce([SPEC_A], new Set(['a']));
  assert.equal(await rejectionRows(), 1);
  assert.equal(await recoveryRows(), 0);

  // The fix lands via a clean BATCH registration, which is the common
  // path — fixing the file changes its content, which triggers a sync.
  // The recovery is logged once; a healthy script that keeps
  // registering says nothing more.
  await syncOnce([SPEC_A], new Set());
  assert.equal(await recoveryRows(), 1, 'the user needs to see their fix took');
  await syncOnce([SPEC_A], new Set());
  assert.equal(await recoveryRows(), 1, 'still-healthy is not an event');
  assert.equal(await rejectionRows(), 1);

  await syncOnce([SPEC_A], new Set(['a']));     // broke again
  assert.equal(await rejectionRows(), 2);
});

test('registerWithFallback: logging survives a service-worker restart', async () => {
  // MV3 evicts the SW freely and syncRegistrations runs again on every
  // wake-up. A fresh worker reports the refusal it observes, same as
  // any other sync.
  sessionStore.clear();
  await syncOnce([SPEC_A], new Set(['a']));
  assert.equal(await rejectionRows(), 1);

  // Re-import with the module state thrown away, as a fresh SW would.
  const reloaded = await import(`../../dist/injector.js?sw=${Date.now()}`);
  userScripts.register = async (batch) => { throw new Error(`bad spec: ${batch[0].id}`); };
  await reloaded.registerWithFallback([SPEC_A]);
  await _flushScriptLogQueueForTests('a');
  assert.equal(await rejectionRows(), 2);
});

// ---------- registerWithFallback: the REJECTED state the UI renders ----------
//
// The rejection map in session storage is what the collections page and the
// viewer read to show REJECTED. It has to describe the CURRENT
// registration set, not the history of everything ever refused.

const { readRejections } = await import('../../dist/script-rejection.js');

const SPEC_B = { id: 'b', matches: ['https://f/*'], js: [{ code: '1' }] };

test('registerWithFallback: a refused spec is recorded with Chrome\'s reason', async () => {
  sessionStore.clear();
  await syncOnce([SPEC_A, SPEC_B], new Set(['a']));
  const rejections = await readRejections();
  assert.deepEqual(Object.keys(rejections), ['a'], 'only the refused spec is recorded');
  assert.match(rejections.a, /bad spec: a/);
});

test('registerWithFallback: registering cleanly clears the record', async () => {
  sessionStore.clear();
  await syncOnce([SPEC_A], new Set(['a']));
  assert.equal(Object.keys(await readRejections()).length, 1);

  // Batch path — the common recovery.
  await syncOnce([SPEC_A], new Set());
  assert.deepEqual(await readRejections(), {}, 'a placed script must not stay REJECTED');

  // Per-script fallback path: `a` recovers while `b` is the bad one.
  await syncOnce([SPEC_A, SPEC_B], new Set(['a']));
  await syncOnce([SPEC_A, SPEC_B], new Set(['b']));
  assert.deepEqual(Object.keys(await readRejections()), ['b']);
});

test('registerWithFallback: a script that leaves the active set stops being REJECTED', async () => {
  // Disabling / deleting a rejected script (or its refresh flipping it
  // to INVALID) drops it from the spec list. Without the wholesale
  // rewrite its row would keep a REJECTED badge nobody can clear.
  sessionStore.clear();
  await syncOnce([SPEC_A, SPEC_B], new Set(['a', 'b']));
  assert.deepEqual(Object.keys(await readRejections()).sort(), ['a', 'b']);

  await syncOnce([SPEC_B], new Set(['b']));
  assert.deepEqual(Object.keys(await readRejections()), ['b']);

  // Everything disabled — nothing is offered, so nothing is rejected.
  await syncOnce([], new Set());
  assert.deepEqual(await readRejections(), {});
});

// ---------- retryRejectedRegistrations: one attempt per action ----------
//
// A navigation fans out into several checks of the same script (the
// reload fast-path plus an opportunistic check per commit event, per
// frame). Each one used to re-offer the spec and write its own Log row,
// so a single page load produced a burst of identical entries. The fix
// is to make fewer ATTEMPTS — the logging itself stays unconditional.

const {
  retryRejectedRegistrations,
  _setRetryNowForTests,
  REJECTION_RETRY_MIN_INTERVAL_MS,
} = await import('../../dist/injector.js');

// The retry rebuilds specs from the store, so it needs a script row to
// find. Only the fields collectActiveSpecs reads matter here.
function seedStore(scriptId, { matches = ['https://e/*'], grants = [] } = {}) {
  const script = {
    id: scriptId,
    collectionId: 'src-1',
    relativePath: `bad-${scriptId}.user.js`,
    status: 'ok',
    enabled: true,
    size: 10,
    loadedAt: 1,
    bodyText: 'x',
    headerText: '',
    leadingText: '',
    matching: { matches, includes: [], excludes: [] },
    header: {
      tags: [{ tag: 'name', value: 'Bad' }, ...grants.map((value) => ({ tag: 'grant', value }))],
      startLine: 1,
    },
  };
  localStore.set(`script:${scriptId}`, script);
  const collection = localStore.get('collection:src-1')
    ?? { id: 'src-1', path: '/tmp/x', enabled: true, scriptIds: [] };
  if (!collection.scriptIds.includes(scriptId)) collection.scriptIds.push(scriptId);
  localStore.set('collection:src-1', collection);
}

test('retryRejectedRegistrations: rate-limits automatic retries, not clicks', async () => {
  sessionStore.clear();
  localStore.clear();
  seedStore('a');

  let clock = 1_000_000;
  _setRetryNowForTests(() => clock);
  // Chrome refuses everything for the whole test.
  userScripts.register = async (batch) => { throw new Error(`bad spec: ${batch[0].id}`); };

  // Seed the rejection map the way a sync would.
  await registerWithFallback([SPEC_A]);
  await _flushScriptLogQueueForTests('a');
  assert.equal(await rejectionRows(), 1);

  // A navigation-driven burst: many calls, one attempt.
  for (let i = 0; i < 10; i++) await retryRejectedRegistrations(['a']);
  await _flushScriptLogQueueForTests('a');
  assert.equal(await rejectionRows(), 2, 'a burst of checks must produce one row');

  // Still inside the window — nothing more.
  clock += REJECTION_RETRY_MIN_INTERVAL_MS - 1;
  await retryRejectedRegistrations(['a']);
  await _flushScriptLogQueueForTests('a');
  assert.equal(await rejectionRows(), 2);

  // Past it — one more.
  clock += 2;
  await retryRejectedRegistrations(['a']);
  await _flushScriptLogQueueForTests('a');
  assert.equal(await rejectionRows(), 3);

  // A Refresh click ignores the window entirely: the user asked.
  await retryRejectedRegistrations(['a'], { userInitiated: true });
  await retryRejectedRegistrations(['a'], { userInitiated: true });
  await _flushScriptLogQueueForTests('a');
  assert.equal(await rejectionRows(), 5, 'a click always gets an answer');

  _setRetryNowForTests(() => Date.now());
});

test('retryRejectedRegistrations: a script nobody is refusing is a no-op', async () => {
  sessionStore.clear();
  localStore.clear();
  seedStore('a');
  _setRetryNowForTests(() => 2_000_000);
  let registerCalls = 0;
  userScripts.register = async () => { registerCalls++; };

  await retryRejectedRegistrations(['a'], { userInitiated: true });
  assert.equal(registerCalls, 0, 'nothing rejected → nothing re-offered');
  assert.equal(await rejectionRows(), 0);
  _setRetryNowForTests(() => Date.now());
});

test('retryRejectedRegistrations: a caller is never dropped for arriving late', async () => {
  // The coalescing bug: `if (retryInFlight) return retryInFlight` used
  // to ignore the caller's ids, so a Refresh click on script B landing
  // while a background retry of A was running rode A's promise and B
  // was never re-offered — the exact "I clicked Refresh and got
  // nothing" symptom, just narrower.
  sessionStore.clear();
  localStore.clear();
  seedStore('a');
  seedStore('b');

  let clock = 5_000_000;
  _setRetryNowForTests(() => clock);
  const offered = [];
  userScripts.register = async (batch) => {
    offered.push(batch[0].id);
    throw new Error(`bad spec: ${batch[0].id}`);
  };

  // Seed both as rejected, the way a sync would.
  await registerWithFallback([SPEC_A, SPEC_B]);
  offered.length = 0;

  // Background check for `a` and a Refresh click on `b`, concurrently.
  await Promise.all([
    retryRejectedRegistrations(['a']),
    retryRejectedRegistrations(['b'], { userInitiated: true }),
  ]);
  assert.deepEqual(offered.sort(), ['a', 'b'], 'both callers must get an attempt');

  _setRetryNowForTests(() => Date.now());
});

// ---------- One registration operation at a time ----------
//
// chrome.userScripts is a single mutable set, and every path that
// changes it does so with a getScripts → unregister → register
// sequence Chrome does not make atomic. Two of those interleaving is
// what produced "Duplicate script ID '<uuid>'" against a script that
// was in fact registered and running.

const {
  syncRegistrations,
  forgetRegistrationState,
  _forgetRegistrationForTests,
} = await import('../../dist/injector.js');

// Restore the module-wide stubs to the state the rest of the file
// expects — including `register`'s loud default, so a later test that
// forgets to stub it can't quietly pass on one of these closures.
// Registered with `t.after` rather than called at the end of a body, so
// a failing assertion can't leak a stub (`getScripts` in particular
// changes what `unregisterAll` does) into every test after it.
function resetUserScriptStubs() {
  userScripts.register = async () => { throw new Error('userScripts.register not stubbed'); };
  userScripts.unregister = async ({ ids }) => {
    throw new Error(`No user script with ID '${(ids ?? [])[0]}' is registered`);
  };
  userScripts.update = async (batch) => {
    throw new Error(`No user script with ID '${(batch ?? [])[0]?.id}' is registered`);
  };
  delete userScripts.getScripts;
}

test('syncRegistrations: two overlapping syncs never interleave', async (t) => {
  t.after(resetUserScriptStubs);
  sessionStore.clear();
  localStore.clear();
  forgetRegistrationState();
  seedStore('a');
  const events = [];
  // Every stub yields to the event loop, so an unserialized pair of
  // syncs would visibly interleave here.
  const yieldOnce = () => new Promise((r) => setTimeout(r, 0));
  userScripts.getScripts = async () => { events.push('list'); await yieldOnce(); return [{ id: 'a' }]; };
  userScripts.unregister = async () => { events.push('unregister'); await yieldOnce(); };
  userScripts.register = async () => { events.push('register'); await yieldOnce(); };
  userScripts.update = async () => { events.push('update'); await yieldOnce(); };

  const first = syncRegistrations();
  // Let the first one get past the collapse gate, so the second call is
  // a genuine second sync rather than a join onto a queued one.
  await yieldOnce();
  const second = syncRegistrations();
  await Promise.all([first, second]);

  // Both are full reconciles (no scope), and Chrome already holds `a`,
  // so each one lists the set, registers the MAIN-world bridge the list
  // didn't have, and UPDATES the script in place. Nothing is
  // unregistered: `a` is staying registered, and dropping it first is
  // the window this whole design exists to close.
  assert.deepEqual(events, [
    'list', 'register', 'update',
    'list', 'register', 'update',
  ], 'one sync must finish before the next one lists the registration set');
});

test('syncRegistrations: a sync that has not started yet absorbs later callers', async (t) => {
  // The debounced sync in background.ts plus the SW-startup one plus a
  // refresh can all ask at once. A sync still waiting its turn reads
  // storage after they wrote, so queueing a second is pure duplicate
  // work — and duplicate unregister-all/register-all traffic.
  //
  // The complement matters as much: a caller arriving while a sync is
  // RUNNING must not join it, because that sync's storage read already
  // happened and would miss what the caller just wrote.
  t.after(resetUserScriptStubs);
  sessionStore.clear();
  localStore.clear();
  forgetRegistrationState();
  seedStore('a');
  const yieldOnce = () => new Promise((r) => setTimeout(r, 0));
  let lists = 0;
  userScripts.getScripts = async () => { lists++; await yieldOnce(); return []; };
  userScripts.register = async () => {};

  // Three simultaneous callers, lock idle: one sync.
  await Promise.all([syncRegistrations(), syncRegistrations(), syncRegistrations()]);
  assert.equal(lists, 1, 'three callers, one sync');

  // Now with one already running: the two late callers need a sync that
  // reads storage after them, and they share it.
  const running = syncRegistrations();
  await yieldOnce();
  const late = Promise.all([syncRegistrations(), syncRegistrations()]);
  await Promise.all([running, late]);
  assert.equal(lists, 3, 'a running sync is not joined; a queued one absorbs both late callers');
});

test('syncRegistrations: a batch unregister that fails drops the ids one at a time', async (t) => {
  // Chrome fails the whole call when any single id is unknown — an id
  // another context dropped between our getScripts and the call. The
  // ids left behind are not all replaceable: a script that has been
  // disabled or deleted isn't in the new spec list, so nothing would
  // re-register over it and it would keep injecting.
  t.after(resetUserScriptStubs);
  sessionStore.clear();
  localStore.clear();
  forgetRegistrationState();
  const registered = new Set(['stale-1', 'stale-2']);
  const dropped = [];
  userScripts.getScripts = async () => [...registered].map((id) => ({ id }));
  userScripts.unregister = async ({ ids }) => {
    // 'stale-1' is already gone, so a batch naming it fails whole.
    if (ids.length > 1) throw new Error(`No script with ID '${ids[0]}' is registered`);
    dropped.push(ids[0]);
    registered.delete(ids[0]);
  };
  userScripts.register = async () => {};

  await syncRegistrations();
  assert.deepEqual(dropped.sort(), ['stale-1', 'stale-2'], 'every id must still be dropped');
});

// ---------- Incremental sync ----------
//
// A sync used to unregister EVERYTHING and register it back, on every
// script-row write. Between those two awaits Chrome held no userscripts
// at all, so a document created right then ran nothing — silently, with
// no error and no badge. The tests below pin the two properties that
// replaced it: only the rows that moved are touched, and nothing that
// is staying registered is ever dropped.

// A stand-in for Chrome's registration set that records every call, so
// a test can assert on the ORDER of operations — which is where the
// unregistered window lived.
//
// Faithful to the behaviours of the real API that the sync design turns
// on, each verified against Chrome:
//
//   - **`update` MERGES.** A pattern field the new spec omits keeps its
//     previous value, and an explicit `[]` counts as omitted. Modelling
//     `update` as "replace" would make the fake agree with the
//     assumption the production code must NOT make.
//   - **`update` ignores `includeGlobs` / `excludeGlobs` entirely.** It
//     cannot add, change, or clear them; the call still succeeds and
//     `getScripts` keeps reporting the registered values. Only
//     `matches` really updates.
//   - **`update` moves a registration to the END of the set**, in batch
//     order. That is what makes placement order observable here.
const GLOB_FIELDS = ['includeGlobs', 'excludeGlobs'];

function fakeRegistrationSet(initial = []) {
  const seed = { matches: ['https://seed/*'] };
  const held = new Map(initial.map((id) => [id, { id, ...seed }]));
  const calls = [];
  const merge = (prior, spec) => {
    const next = { ...prior, ...spec };
    // An empty array is "unspecified" to Chrome, so the old value
    // survives it.
    if (!spec.matches || spec.matches.length === 0) next.matches = prior.matches;
    // Globs don't update at all, whatever the spec says.
    for (const f of GLOB_FIELDS) next[f] = prior[f];
    return next;
  };
  userScripts.getScripts = async (filter) => {
    const all = [...held.values()];
    return filter?.ids ? all.filter((s) => filter.ids.includes(s.id)) : all;
  };
  userScripts.register = async (batch) => {
    for (const s of batch) {
      if (held.has(s.id)) throw new Error(`Duplicate script ID '${s.id}'`);
      if (!s.matches || s.matches.length === 0) {
        throw new Error(`User script with ID '${s.id}' must specify 'matches'.`);
      }
    }
    for (const s of batch) { held.set(s.id, { ...s }); calls.push(`register:${s.id}`); }
  };
  userScripts.update = async (batch) => {
    for (const s of batch) {
      if (!held.has(s.id)) throw new Error(`No script with ID '${s.id}' is registered`);
    }
    for (const s of batch) {
      const merged = merge(held.get(s.id), s);
      // Delete then set: a Map preserves insertion order, so this is
      // how the fake reproduces "an updated script moves to the end".
      held.delete(s.id);
      held.set(s.id, merged);
      calls.push(`update:${s.id}`);
    }
  };
  userScripts.unregister = async ({ ids }) => {
    for (const id of ids) {
      if (!held.has(id)) throw new Error(`No script with ID '${id}' is registered`);
    }
    for (const id of ids) { held.delete(id); calls.push(`unregister:${id}`); }
  };
  return {
    calls,
    // Insertion order, NOT sorted — placement order is the thing some
    // of these tests are about.
    order: () => [...held.keys()],
    ids: () => [...held.keys()].sort(),
    spec: (id) => held.get(id),
    reset: () => { calls.length = 0; },
  };
}

// Count `chrome.storage.local.get(null)` calls — the read that pulled
// every script body and the favicon cache into memory on every sync.
function countFullReads() {
  const inner = chrome.storage.local.get;
  const seen = { full: 0, keyed: 0 };
  chrome.storage.local.get = async (key) => {
    if (key === null || key === undefined) seen.full++;
    else seen.keyed++;
    return inner(key);
  };
  seen.restore = () => { chrome.storage.local.get = inner; };
  return seen;
}

test('syncRegistrations: a scoped sync re-registers only the scripts that moved', async (t) => {
  t.after(resetUserScriptStubs);
  sessionStore.clear();
  localStore.clear();
  forgetRegistrationState();
  seedStore('a');
  seedStore('b');
  const chrome_ = fakeRegistrationSet();
  await syncRegistrations();
  assert.deepEqual(chrome_.ids(), ['a', 'b', BRIDGE_SCRIPT_ID].sort());

  chrome_.reset();
  const reads = countFullReads();
  t.after(reads.restore);
  // Only `b` was edited.
  await syncRegistrations({ scriptIds: ['b'], collectionIds: [] });

  assert.deepEqual(chrome_.calls, ['update:b'], 'only the edited script is re-offered');
  assert.deepEqual(chrome_.ids(), ['a', 'b', BRIDGE_SCRIPT_ID].sort(), 'the set is unchanged');
  assert.equal(reads.full, 0, 'a scoped sync must not read every row');
});

test('syncRegistrations: our own specs go in first, runtimes before the bridge', async (t) => {
  t.after(resetUserScriptStubs);
  sessionStore.clear();
  localStore.clear();
  forgetRegistrationState();
  seedStore('a', { matches: ['https://a.example/*'], grants: ['unsafeWindow', 'GM_setValue'] });
  seedStore('b', { matches: ['https://b.example/*'], grants: ['GM_setValue'] });
  const chrome_ = fakeRegistrationSet();
  await syncRegistrations();
  assert.deepEqual(chrome_.order(), [GM_RUNTIME_SCRIPT_ID, GM_RUNTIME_MAIN_SCRIPT_ID, BRIDGE_SCRIPT_ID, 'a', 'b']);
  // Scoped: each own spec on the patterns of the scripts that need it.
  assert.deepEqual(chrome_.spec(GM_RUNTIME_MAIN_SCRIPT_ID).matches, ['https://a.example/*']);
  assert.deepEqual(chrome_.spec(GM_RUNTIME_SCRIPT_ID).matches, ['https://b.example/*']);
  assert.deepEqual(chrome_.spec(BRIDGE_SCRIPT_ID).matches, ['https://a.example/*']);
});

test('syncRegistrations: a scoped sync re-offers the MAIN runtime and the bridge when their union moves', async (t) => {
  // The MAIN runtime is registered under its own id, and every piece of
  // own-spec bookkeeping has to know it — a predicate that only knew
  // the USER_SCRIPT id once left this script with `GM_setValue` bound
  // to a `window.__SM_GM__` that never reached its page.
  t.after(resetUserScriptStubs);
  sessionStore.clear();
  localStore.clear();
  forgetRegistrationState();
  seedStore('a', { matches: ['https://a.example/*'], grants: ['unsafeWindow', 'GM_setValue'] });
  const chrome_ = fakeRegistrationSet();
  await syncRegistrations();
  chrome_.reset();

  seedStore('b', { matches: ['https://b.example/*'], grants: ['unsafeWindow', 'GM_setValue'] });
  await syncRegistrations({ scriptIds: ['b'], collectionIds: [] });

  assert.deepEqual(
    chrome_.calls.slice().sort(),
    [`register:b`, `update:${BRIDGE_SCRIPT_ID}`, `update:${GM_RUNTIME_MAIN_SCRIPT_ID}`],
  );
  assert.deepEqual(chrome_.spec(GM_RUNTIME_MAIN_SCRIPT_ID).matches.sort(), ['https://a.example/*', 'https://b.example/*']);
  assert.deepEqual(chrome_.spec(BRIDGE_SCRIPT_ID).matches.sort(), ['https://a.example/*', 'https://b.example/*']);

  // An edit that doesn't move the union re-offers neither.
  chrome_.reset();
  await syncRegistrations({ scriptIds: ['b'], collectionIds: [] });
  assert.deepEqual(chrome_.calls, ['update:b']);

  // The last MAIN-world script leaving takes both own specs with it.
  chrome_.reset();
  localStore.set('script:a', { ...localStore.get('script:a'), enabled: false });
  localStore.set('script:b', { ...localStore.get('script:b'), enabled: false });
  await syncRegistrations({ scriptIds: ['a', 'b'], collectionIds: [] });
  assert.deepEqual(chrome_.ids(), []);
});

test('syncRegistrations: a refused own spec is rebuilt from what Chrome accepted, and never filed as a script', async (t) => {
  t.after(resetUserScriptStubs);
  sessionStore.clear();
  localStore.clear();
  forgetRegistrationState();
  seedStore('a', { matches: ['https://a.example/*'], grants: ['unsafeWindow', 'GM_setValue'] });
  seedStore('bad', { matches: ['https://bad.example/*'], grants: ['unsafeWindow', 'GM_setValue'] });
  const chrome_ = fakeRegistrationSet();
  // Chrome refuses any spec carrying bad.example — the script itself,
  // and the own specs whose union it is part of.
  const inner = userScripts.register;
  userScripts.register = async (batch) => {
    for (const s of batch) {
      if ((s.matches ?? []).includes('https://bad.example/*')) throw new Error(`bad pattern in ${s.id}`);
    }
    return inner(batch);
  };
  await syncRegistrations();

  // Retried on the accepted union, and in place.
  assert.deepEqual(chrome_.ids(), ['a', BRIDGE_SCRIPT_ID, GM_RUNTIME_MAIN_SCRIPT_ID].sort());
  assert.deepEqual(chrome_.spec(GM_RUNTIME_MAIN_SCRIPT_ID).matches, ['https://a.example/*']);
  assert.deepEqual(chrome_.spec(BRIDGE_SCRIPT_ID).matches, ['https://a.example/*']);
  // Only the script is REJECTED; our own ids are not scripts.
  const rejections = sessionStore.get('injector-rejections') ?? {};
  assert.deepEqual(Object.keys(rejections), ['bad']);
});

test('syncRegistrations: a scoped sync unregisters only what left the set', async (t) => {
  t.after(resetUserScriptStubs);
  sessionStore.clear();
  localStore.clear();
  forgetRegistrationState();
  seedStore('a');
  seedStore('b');
  const chrome_ = fakeRegistrationSet();
  await syncRegistrations();
  chrome_.reset();

  // `b` is disabled — it IS going away, which is the one case an
  // unregister is right for.
  localStore.set('script:b', { ...localStore.get('script:b'), enabled: false });
  await syncRegistrations({ scriptIds: ['b'], collectionIds: [] });

  assert.deepEqual(chrome_.calls, ['unregister:b']);
  assert.deepEqual(chrome_.ids(), ['a', BRIDGE_SCRIPT_ID].sort());
});

test('syncRegistrations: a collection toggle moves every script under it', async (t) => {
  t.after(resetUserScriptStubs);
  sessionStore.clear();
  localStore.clear();
  forgetRegistrationState();
  seedStore('a');
  seedStore('b');
  const chrome_ = fakeRegistrationSet();
  await syncRegistrations();
  chrome_.reset();

  // The scripts' own rows didn't move; the collection's did.
  localStore.set('collection:src-1', { ...localStore.get('collection:src-1'), enabled: false });
  await syncRegistrations({ scriptIds: [], collectionIds: ['src-1'] });
  // No MAIN-world script is left, so the bridge goes with them.
  assert.deepEqual(
    chrome_.calls.sort(),
    ['unregister:a', 'unregister:b', `unregister:${BRIDGE_SCRIPT_ID}`].sort(),
  );
  assert.deepEqual(chrome_.ids(), []);

  chrome_.reset();
  localStore.set('collection:src-1', { ...localStore.get('collection:src-1'), enabled: true });
  await syncRegistrations({ scriptIds: [], collectionIds: ['src-1'] });
  assert.deepEqual(chrome_.ids(), ['a', 'b', BRIDGE_SCRIPT_ID].sort(), 'and back again');
});

test('syncRegistrations: a scoped sync leaves another script\'s REJECTED alone', async (t) => {
  // The rejection map describes the current registration set, and a
  // full sync rewrites it wholesale. A scoped sync must not: clearing
  // an entry it never re-offered would drop a REJECTED badge Chrome is
  // still earning, and rewriting the map from its own slice would
  // resurrect ones an earlier sync cleared.
  t.after(resetUserScriptStubs);
  sessionStore.clear();
  localStore.clear();
  forgetRegistrationState();
  seedStore('a');
  seedStore('b');
  const chrome_ = fakeRegistrationSet();
  const register = userScripts.register;
  // Chrome refuses `a` forever; `b` is fine.
  userScripts.register = async (batch) => {
    if (batch.some((s) => s.id === 'a')) throw new Error('bad spec: a');
    return register(batch);
  };
  await syncRegistrations();
  assert.deepEqual(Object.keys(await readRejections()), ['a']);

  chrome_.reset();
  await syncRegistrations({ scriptIds: ['b'], collectionIds: [] });
  assert.deepEqual(
    Object.keys(await readRejections()), ['a'],
    'a script this sync never looked at keeps its REJECTED',
  );

  // And a script that leaves the set while still rejected loses it,
  // because a scoped sync owns exactly the ids it considered.
  localStore.delete('script:a');
  await syncRegistrations({ scriptIds: ['a'], collectionIds: [] });
  assert.deepEqual(await readRejections(), {});
});

test('syncRegistrations: a scoped sync rebuilds scripts a new dupe renamed', async (t) => {
  // Log labels are dedup-aware across the whole library, so a script
  // ARRIVING renumbers the group it joins: a lone `dupe.user.js`
  // becomes `dupe.user.js#1`. The label is baked into the registered
  // `//# sourceURL=` directives, so the script whose row never moved
  // still has to be re-registered — a full wipe used to do that by
  // accident.
  t.after(resetUserScriptStubs);
  sessionStore.clear();
  localStore.clear();
  forgetRegistrationState();
  seedStore('a');
  localStore.set('script:a', { ...localStore.get('script:a'), relativePath: 'dupe.user.js' });
  const chrome_ = fakeRegistrationSet();
  await syncRegistrations();
  chrome_.reset();

  seedStore('b');
  localStore.set('script:b', { ...localStore.get('script:b'), relativePath: 'dupe.user.js' });
  await syncRegistrations({ scriptIds: ['b'], collectionIds: [] });

  assert.deepEqual(
    chrome_.calls.sort(), ['register:b', 'update:a'],
    'the script that was renumbered is re-registered too',
  );
});

test('syncRegistrations: adding an @exclude really adds it', async (t) => {
  // `chrome.userScripts.update` ignores `excludeGlobs` outright — it
  // cannot add one to a registration that has none (verified against
  // Chrome; see tests/e2e/exclude-globs.spec.ts). A plain `update`
  // would leave the script still injecting on the page its header now
  // excludes, with the badge reporting UNEXPECTED and no way to act on
  // it.
  t.after(resetUserScriptStubs);
  sessionStore.clear();
  localStore.clear();
  forgetRegistrationState();
  seedStore('a');
  localStore.set('script:a', {
    ...localStore.get('script:a'),
    matching: { matches: ['https://e/*'], includes: [], excludes: [] },
  });
  const chrome_ = fakeRegistrationSet();
  await syncRegistrations();
  assert.ok(!chrome_.spec('a').excludeGlobs?.length);
  chrome_.reset();

  // The user adds an `@exclude` line.
  localStore.set('script:a', {
    ...localStore.get('script:a'),
    matching: { matches: ['https://e/*'], includes: [], excludes: ['https://e/no/*'] },
  });
  await syncRegistrations({ scriptIds: ['a'], collectionIds: [] });

  assert.deepEqual(
    chrome_.spec('a').excludeGlobs, ['https://e/no/*'],
    'the exclusion the header now declares must be on the registration',
  );
  assert.deepEqual(chrome_.calls, ['unregister:a', 'register:a']);
});

test('syncRegistrations: dropping the last @exclude really drops it', async (t) => {
  // `chrome.userScripts.update` MERGES — a pattern field the new spec
  // omits keeps its old value, and an explicit `[]` counts as omitted
  // (both verified against Chrome). `buildRegistrationSpec` emits these
  // keys only when non-empty, so a plain `update` would leave a user
  // who deleted their last `@exclude` with an exclusion their header no
  // longer declares: the script keeps not running on that site, our own
  // matcher disagrees, and nothing in the UI explains it.
  t.after(resetUserScriptStubs);
  sessionStore.clear();
  localStore.clear();
  forgetRegistrationState();
  seedStore('a');
  localStore.set('script:a', {
    ...localStore.get('script:a'),
    matching: { matches: ['https://e/*'], includes: [], excludes: ['https://e/no/*'] },
  });
  const chrome_ = fakeRegistrationSet();
  await syncRegistrations();
  assert.deepEqual(chrome_.spec('a').excludeGlobs, ['https://e/no/*']);
  chrome_.reset();

  // The user deletes the `@exclude` line.
  localStore.set('script:a', {
    ...localStore.get('script:a'),
    matching: { matches: ['https://e/*'], includes: [], excludes: [] },
  });
  await syncRegistrations({ scriptIds: ['a'], collectionIds: [] });

  assert.ok(
    !chrome_.spec('a').excludeGlobs?.length,
    'the exclusion the header no longer declares must be gone from the registration',
  );
  // The one place the closed window reopens, and only for the script
  // being re-scoped: there is no way to clear the field through update.
  assert.deepEqual(chrome_.calls, ['unregister:a', 'register:a']);
});

test('syncRegistrations: a registration another context placed can still be dropped', async (t) => {
  // `state.registered` is this context's belief, and the collections
  // page and the viewer place registrations in theirs. A removal that
  // consulted the belief would leave a script the page-side retry
  // placed injecting after the user disabled it — and unlike a wrong
  // belief about presence, that one never self-corrects, because
  // removal has no second call to disagree with it.
  t.after(resetUserScriptStubs);
  sessionStore.clear();
  localStore.clear();
  forgetRegistrationState();
  seedStore('a');
  seedStore('b');
  const chrome_ = fakeRegistrationSet();
  await syncRegistrations();

  // Simulate the other context: drop `b` from OUR record while leaving
  // it registered, exactly as a page-side `retryRejectedRegistrations`
  // that the worker never heard about would.
  _forgetRegistrationForTests('b');
  chrome_.reset();

  localStore.set('script:b', { ...localStore.get('script:b'), enabled: false });
  await syncRegistrations({ scriptIds: ['b'], collectionIds: [] });

  assert.deepEqual(chrome_.calls, ['unregister:b']);
  assert.deepEqual(chrome_.ids(), ['a', BRIDGE_SCRIPT_ID].sort());
});

test('syncRegistrations: a refused update does not report a duplicate id', async (t) => {
  // For an id Chrome really holds, `register` is guaranteed to answer
  // "Duplicate script ID" — so using it as the second opinion after a
  // failed `update` would turn every update failure into that message,
  // and file it against the script as Chrome's reason. Ask Chrome
  // whether the id exists instead.
  t.after(resetUserScriptStubs);
  sessionStore.clear();
  localStore.clear();
  forgetRegistrationState();
  seedStore('a');
  const chrome_ = fakeRegistrationSet();
  await syncRegistrations();
  chrome_.reset();

  userScripts.update = async () => { throw new Error('bad spec: a'); };
  localStore.set('script:a', { ...localStore.get('script:a'), bodyText: 'edited' });
  await syncRegistrations({ scriptIds: ['a'], collectionIds: [] });

  assert.deepEqual(
    Object.values(await readRejections()), ['bad spec: a'],
    'the reported reason is the real refusal, not our own sequencing',
  );
  // And the stale registration goes, because REJECTED says the script
  // will not run.
  assert.ok(!chrome_.ids().includes('a'));
});

test('syncRegistrations: a scoped sync with no record of the set reconciles fully', async (t) => {
  // The service worker is evicted freely and rows change while it is
  // dead, so a fresh worker cannot diff against a record it doesn't
  // have. Chrome's own list is the only truth available.
  t.after(resetUserScriptStubs);
  sessionStore.clear();
  localStore.clear();
  forgetRegistrationState();
  seedStore('a');
  // What a previous worker left behind: `a`, plus one for a script the
  // store no longer has.
  const chrome_ = fakeRegistrationSet(['a', 'gone']);
  const reads = countFullReads();
  t.after(reads.restore);

  await syncRegistrations({ scriptIds: ['a'], collectionIds: [] });

  assert.equal(reads.full, 1, 'with nothing to diff against, read everything');
  assert.deepEqual(chrome_.ids(), ['a', BRIDGE_SCRIPT_ID].sort(), 'the stray is dropped');
  assert.deepEqual(
    chrome_.calls, [`register:${BRIDGE_SCRIPT_ID}`, 'update:a', 'unregister:gone'],
    'our own registration goes first, a staying script is updated in place, removals last',
  );
});

test('syncRegistrations: a failed sync gives up its record rather than half-diffing', async (t) => {
  t.after(resetUserScriptStubs);
  sessionStore.clear();
  localStore.clear();
  forgetRegistrationState();
  seedStore('a');
  const chrome_ = fakeRegistrationSet();
  await syncRegistrations();

  // A storage failure mid-sync. What must NOT happen is the next sync
  // trusting a record this one may have half-applied.
  const inner = chrome.storage.local.get;
  chrome.storage.local.get = async () => { throw new Error('storage is unavailable'); };
  await syncRegistrations({ scriptIds: ['a'], collectionIds: [] });
  chrome.storage.local.get = inner;

  const reads = countFullReads();
  t.after(reads.restore);
  await syncRegistrations({ scriptIds: ['a'], collectionIds: [] });
  assert.equal(reads.full, 1, 'the next sync starts over from a full read');
  assert.deepEqual(chrome_.ids(), ['a', BRIDGE_SCRIPT_ID].sort());
});

test('registerWithFallback: an id Chrome already holds is replaced, not reported', async (t) => {
  t.after(resetUserScriptStubs);
  // The cross-context race the per-context lock cannot cover: the
  // collections page and the viewer run the retry in their own JS
  // context, so a page-side retry can place a script the SW sync
  // believes is unplaced. Chrome then answers the sync's batch with
  // "Duplicate script ID", and re-offering the spec unchanged badged a
  // running script REJECTED.
  sessionStore.clear();
  // `b` is already placed and `registerWithFallback` does not know it.
  const chrome_ = fakeRegistrationSet(['b']);

  const ok = await registerWithFallback([SPEC_A, SPEC_B]);
  assert.equal(ok, 2, 'both specs must end up registered');
  assert.deepEqual(await readRejections(), {}, 'our own ordering is not the script\'s fault');
  assert.deepEqual(chrome_.ids(), ['a', 'b']);
  // The recovery is an `update`, never an unregister: `b` is running,
  // and dropping it to place it again is the gap that made a page
  // loading right then run nothing. (`b`'s spec keeps a `matches`, so
  // nothing forces the replace path — see the pattern-drop test.)
  assert.ok(
    !chrome_.calls.some((c) => c.startsWith('unregister:')),
    'a live registration is never dropped to replace it',
  );
});

test('registerWithFallback: a spec Chrome genuinely refuses is offered once', async (t) => {
  // Register-first, replace-on-conflict. The obvious arrangement —
  // unregister before every per-spec attempt — would drop a script
  // that IS registered on the way to failing anyway, and re-offering
  // every refused spec blindly would double the traffic for every
  // REJECTED script on every sync.
  t.after(resetUserScriptStubs);
  sessionStore.clear();
  const offered = [];
  userScripts.register = async (batch) => {
    offered.push(batch.map((s) => s.id).join('+'));
    if (batch.some((s) => s.id === 'a')) throw new Error('bad spec: a');
  };

  await registerWithFallback([SPEC_A, SPEC_B]);
  await _flushScriptLogQueueForTests('a');
  assert.deepEqual(offered, ['a+b', 'a', 'b'], 'the batch, then one attempt per spec');
  assert.deepEqual(Object.keys(await readRejections()), ['a']);
});
