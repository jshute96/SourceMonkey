// Tests for src/injector.ts (compiled to dist/injector.js).
//
// Only the pure helpers are exercised here — the chrome.userScripts
// runtime sync (syncRegistrations) is glue I/O and is covered by the
// e2e smoke layer instead.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BRIDGE_SCRIPT_ID,
  buildBridgeSpec,
  buildRegistrationSpec,
  buildWrappedBody,
  collectActiveSpecs,
  mapRunAt,
  resolveWorld,
} from '../../dist/injector.js';
import { WRAPPER_BRIDGE, WRAPPER_MATCHER } from '../../dist/generated-wrappers.js';

// ---------- mapRunAt ----------

test('mapRunAt: explicit values map to the userScripts enum', () => {
  assert.equal(mapRunAt('document-start'), 'document_start');
  assert.equal(mapRunAt('document-end'), 'document_end');
  assert.equal(mapRunAt('document-idle'), 'document_idle');
});

test('mapRunAt: document-body collapses to document_start (no exact equivalent)', () => {
  assert.equal(mapRunAt('document-body'), 'document_start');
});

test('mapRunAt: missing / unknown values default to document_idle', () => {
  assert.equal(mapRunAt(undefined), 'document_idle');
  assert.equal(mapRunAt(''), 'document_idle');
  assert.equal(mapRunAt('context-menu'), 'document_idle');
  assert.equal(mapRunAt('whatever'), 'document_idle');
});

test('mapRunAt: case-insensitive', () => {
  assert.equal(mapRunAt('DOCUMENT-START'), 'document_start');
});

// ---------- buildWrappedBody ----------

test('buildWrappedBody: inlines body verbatim so syntax errors surface at register()', () => {
  const wrapped = buildWrappedBody({ id: 'x', name: 'X', body: 'var foo = 1;', loadedAt: 0 });
  assert.match(wrapped, /var foo = 1;/);
});

test('buildWrappedBody: includes the id and name as JS string literals', () => {
  const wrapped = buildWrappedBody({ id: 'abc"123', name: 'My "Script"', body: '', loadedAt: 0 });
  // JSON.stringify handles the escaping for both, so the inlined literal
  // contains the escaped form.
  assert.match(wrapped, /"abc\\"123"/);
  assert.match(wrapped, /"My \\"Script\\""/);
});

test('buildWrappedBody: wraps the body in a try/catch with sendMessage', () => {
  const wrapped = buildWrappedBody({ id: 'x', name: 'X', body: 'doThing();', loadedAt: 0 });
  assert.match(wrapped, /try {/);
  assert.match(wrapped, /catch \(__smErr\)/);
  assert.match(wrapped, /type: "sm:error"/);
  assert.match(wrapped, /type: "sm:start"/);
});

test('buildWrappedBody: swallows sendMessage promise rejections to avoid feedback loops', () => {
  // Without a `.catch(...)` a missing receiver would surface as an
  // Uncaught (in promise) error in the page console on every send.
  const wrapped = buildWrappedBody({ id: 'x', name: 'X', body: '', loadedAt: 0 });
  assert.match(wrapped, /\.catch\(function ?\(\) ?\{\}\)/);
});

test('buildWrappedBody: embeds loadedAt as a bare numeric literal in the sm:start payload', () => {
  // The SW uses this value to detect a wrapper running outdated content
  // (storage's current loadedAt > wrapper's loadedAt). JSON.stringify
  // on a number yields a bare numeric literal — confirm the quotes
  // around the "__SM_LOADED_AT__" placeholder were stripped.
  const wrapped = buildWrappedBody({ id: 'x', name: 'X', body: '', loadedAt: 1737051234567 });
  assert.match(wrapped, /__smLoadedAt = 1737051234567/);
  // And the sm:start payload references it (not the placeholder).
  assert.match(wrapped, /type: "sm:start"[^}]*loadedAt: __smLoadedAt/);
  assert.doesNotMatch(wrapped, /__SM_LOADED_AT__/);
});

test('buildWrappedBody: head is on a single physical line so body lines stay aligned', () => {
  // The body's line N must land at physical line N of the registered
  // script — otherwise stack traces report meaningless line numbers.
  // The build minifies wrapper-head.js to one line; we verify that
  // here by checking that everything up to the body shows up as line
  // 1 of the output.
  const wrapped = buildWrappedBody({ id: 'x', name: 'X', body: 'LINE1\nLINE2\nLINE3' });
  const lines = wrapped.split('\n');
  // line 1 = head + LINE1; line 2 = LINE2; line 3 = LINE3; line 4 = tail
  assert.match(lines[0], /LINE1$/);
  assert.equal(lines[1], 'LINE2');
  assert.equal(lines[2], 'LINE3');
});

test('buildWrappedBody: never inserts literal "$&" from matcher replace (no replace-backref leak)', () => {
  // The matcher contains `s.replace(..., "\\$&")` inside a regex
  // escape helper. If we used String.prototype.replace's two-arg form
  // with a string replacement, $& would expand to the matched text
  // (the placeholder), corrupting the matcher. Guard against
  // regression by checking the placeholder doesn't survive.
  const wrapped = buildWrappedBody({
    id: 'x', name: 'X', body: '',
    matching: { matches: ['https://a/*'], excludes: [], includes: ['/r/'] },
  });
  assert.doesNotMatch(wrapped, /__SM_MATCHER_BLOCK__/);
});

test('buildWrappedBody: appends a # sourceURL= directive with id and sanitized name', () => {
  // The sourceURL is what the wrapper's async-error listeners grep
  // stack frames for, and what devtools labels the script with.
  const wrapped = buildWrappedBody({
    id: 'abc-123',
    name: 'Foo / Bar (v2)',
    body: '',
  });
  // Unsafe chars in the name (space, slash, parens) are folded to `_`
  // so the resulting line is a well-formed sourceURL directive. The
  // marker terminates the wrapped script — match end-of-string to
  // confirm it's at the bottom where the engine expects it.
  const expected = 'sourcemonkey://abc-123/Foo___Bar__v2_.user.js';
  assert.ok(
    wrapped.includes('\n//# sourceURL=' + expected + '\n'),
    `expected sourceURL directive for ${expected} in wrapped output`,
  );
});

test('buildWrappedBody: installs window error + unhandledrejection listeners', () => {
  // Async failures from handlers the script installs (setTimeout,
  // addEventListener callbacks, promise chains) escape the body's
  // try/catch. We install window-level listeners and filter by the
  // sourceURL marker so we still get attributed reports without
  // false-positively catching unrelated page errors.
  const wrapped = buildWrappedBody({ id: 'x', name: 'X', body: '' });
  assert.match(wrapped, /addEventListener\("error"/);
  assert.match(wrapped, /addEventListener\("unhandledrejection"/);
  // The async-error reporter must dispatch via the existing sm:error
  // channel so the SW's badge logic handles it just like a sync throw.
  // The page console gets only an info-level attribution note — the
  // native browser logging already shows the error + stack.
  assert.match(wrapped, /caught async/);
});

test('buildWrappedBody: __smSend feature-detects chrome.runtime then falls back to postMessage', () => {
  // MAIN-world scripts can't reach chrome.runtime; they need to relay
  // through window.postMessage to a USER_SCRIPT-world bridge (see
  // buildBridgeSpec). Both transport branches must be present in the
  // emitted wrapper so the same compiled body works in either world.
  const wrapped = buildWrappedBody({ id: 'x', name: 'X', body: '' });
  assert.match(wrapped, /chrome\.runtime\.sendMessage/);
  assert.match(wrapped, /window\.postMessage/);
  assert.match(wrapped, /"sourcemonkey-bridge"/);
});

test('buildWrappedBody: async-error listeners filter by the per-script sourceURL', () => {
  // Without filtering, a MAIN-world script's listener would attribute
  // every page error (and every other userscript's error) to itself.
  // Filtering by the unique sourceURL string is what keeps attribution
  // honest. Verify the wrapped output references __smSourceUrl from
  // both the filename check and the stack check paths.
  const wrapped = buildWrappedBody({ id: 'abc', name: 'X', body: '' });
  assert.match(wrapped, /indexOf\(__smSourceUrl\)/);
  const sourceUrl = 'sourcemonkey://abc/X.user.js';
  assert.ok(wrapped.includes(JSON.stringify(sourceUrl)));
});

// ---------- buildRegistrationSpec ----------

// Minimal valid script the helpers can chew on.
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

test('buildRegistrationSpec: passes @match values through as matches', () => {
  const spec = buildRegistrationSpec(makeScript());
  assert.deepEqual(spec.matches, ['https://example.com/*']);
});

test('buildRegistrationSpec: @include glob → includeGlobs; /regex/ form goes to wrapper', () => {
  const spec = buildRegistrationSpec(makeScript({
    matching: {
      matches: [],
      excludes: [],
      includes: ['*://example.com/*', '/^https:\\/\\/foo\\..*$/'],
    },
  }));
  assert.deepEqual(spec.includeGlobs, ['*://example.com/*']);
  // Wrapper carries the full matching object so it can filter at runtime.
  assert.match(spec.js[0].code, /__smMatchScript/);
});

test('buildRegistrationSpec: @exclude glob → excludeGlobs; /regex/ form goes to wrapper', () => {
  const spec = buildRegistrationSpec(makeScript({
    matching: {
      matches: ['https://example.com/*'],
      excludes: ['*/admin/*', '/danger/'],
      includes: [],
    },
  }));
  assert.deepEqual(spec.excludeGlobs, ['*/admin/*']);
  assert.match(spec.js[0].code, /__smMatchScript/);
});

test('buildRegistrationSpec: regex-only @include registers <all_urls> and defers to the wrapper', () => {
  const spec = buildRegistrationSpec(makeScript({
    matching: { matches: [], excludes: [], includes: ['/^https:\\/\\/foo\\..*$/'] },
  }));
  assert.deepEqual(spec.matches, ['<all_urls>']);
  assert.equal(spec.includeGlobs, undefined);
  assert.match(spec.js[0].code, /__smMatchScript/);
});

test('buildRegistrationSpec: pure @match script omits the wrapper-side matcher', () => {
  const spec = buildRegistrationSpec(makeScript());
  assert.doesNotMatch(spec.js[0].code, /__smMatchScript/);
});

test('buildRegistrationSpec: pulls runAt from @run-at on the parsed header', () => {
  const spec = buildRegistrationSpec(makeScript({
    header: {
      tags: [
        { tag: 'name', value: 'X' },
        { tag: 'run-at', value: 'document-start' },
      ],
    },
  }));
  assert.equal(spec.runAt, 'document_start');
});

test('buildRegistrationSpec: defaults runAt to document_idle when @run-at is absent', () => {
  const spec = buildRegistrationSpec(makeScript());
  assert.equal(spec.runAt, 'document_idle');
});

test('buildRegistrationSpec: header without @grant defaults to MAIN world (TM-compatible @grant none)', () => {
  // Default makeScript() has no @grant — treat like @grant none so the
  // body can see the page's window globals (jQuery, OpenLayers, etc.).
  const spec = buildRegistrationSpec(makeScript());
  assert.equal(spec.world, 'MAIN');
});

test('buildRegistrationSpec: @grant none → MAIN world', () => {
  const spec = buildRegistrationSpec(makeScript({
    header: { tags: [{ tag: 'name', value: 'X' }, { tag: 'grant', value: 'none' }] },
  }));
  assert.equal(spec.world, 'MAIN');
});

test('buildRegistrationSpec: any real @grant → USER_SCRIPT world', () => {
  const spec = buildRegistrationSpec(makeScript({
    header: { tags: [{ tag: 'name', value: 'X' }, { tag: 'grant', value: 'GM_setValue' }] },
  }));
  assert.equal(spec.world, 'USER_SCRIPT');
});

test('buildRegistrationSpec: @inject-into page wins over @grant', () => {
  const spec = buildRegistrationSpec(makeScript({
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

test('buildRegistrationSpec: @inject-into content wins over @grant none', () => {
  const spec = buildRegistrationSpec(makeScript({
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

test('buildRegistrationSpec: wraps the body — registered code contains the wrapper', () => {
  const spec = buildRegistrationSpec(makeScript({ bodyText: 'doStuff();' }));
  assert.equal(spec.js.length, 1);
  assert.match(spec.js[0].code, /doStuff\(\);/);
  assert.match(spec.js[0].code, /sm:start/);
});

// ---------- inline matcher (snippet inside the wrapper) ----------

// The wrapper's __smMatchScript must agree with urlMatchesScript()
// from url-match.ts for the cases that involve regex patterns —
// otherwise badge counts and actual injection drift apart.
//
// The matcher source lives in src/wrapper-matcher.js, gets minified
// to a single line by the build, and ends with a top-level `return`
// (it's meant to bail out of the wrapper's IIFE). We eval it inside a
// throwaway function that swallows the return and instead hands back
// the matcher fn for assertions.

function loadMatchScript() {
  // The matcher source ends with `var __smMatching = ...; if
  // (!__smMatchScript(location.href, __smMatching)) return;` — that's
  // the runtime bail-out, not part of the algorithm. Lop it off and
  // eval just the helpers so we can call __smMatchScript directly.
  const helpers = WRAPPER_MATCHER.split('var __smMatching')[0];
  // eslint-disable-next-line no-new-func
  return new Function(helpers + ' return __smMatchScript;')();
}

test('inline matcher: @match passes', () => {
  const match = loadMatchScript();
  assert.equal(match('https://example.com/x', { matches: ['https://example.com/*'], excludes: [], includes: [] }), true);
});

test('inline matcher: /regex/ @include matches when glob would not', () => {
  const match = loadMatchScript();
  const m = { matches: [], excludes: [], includes: ['/^https:\\/\\/foo\\.example\\.com\\/.*$/'] };
  assert.equal(match('https://foo.example.com/page', m), true);
  assert.equal(match('https://bar.example.com/page', m), false);
});

test('inline matcher: /regex/ @exclude beats a @match', () => {
  const match = loadMatchScript();
  const m = { matches: ['https://example.com/*'], excludes: ['/\\/admin\\//'], includes: [] };
  assert.equal(match('https://example.com/admin/x', m), false);
  assert.equal(match('https://example.com/public/x', m), true);
});

test('inline matcher: <all_urls> matches http/https/file/ftp only', () => {
  const match = loadMatchScript();
  const m = { matches: ['<all_urls>'], excludes: [], includes: [] };
  assert.equal(match('https://example.com/', m), true);
  assert.equal(match('chrome://settings', m), false);
});

// ---------- buildBridgeSpec ----------

test('buildBridgeSpec: returns null when no MAIN-world script is active', () => {
  // USER_SCRIPT-world scripts call chrome.runtime.sendMessage directly,
  // so the bridge would just be dead weight. Skip the registration.
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
  // document_start so the bridge listener is installed before any
  // MAIN-world wrapper's postMessage event can dispatch.
  assert.equal(bridge.runAt, 'document_start');
  // The bridge's code must reference the marker that __smSend uses; if
  // either side renames the marker without updating the other, all
  // MAIN-world telemetry silently disappears.
  assert.match(bridge.js[0].code, /sourcemonkey-bridge/);
});

// ---------- wrapper-bridge: filter behavior ----------

// Eval the bridge source inside a fake DOM harness. The bridge is an
// IIFE that closes over global `window` + `chrome`; passing those as
// parameters to a wrapping Function constructor lets us drive synthetic
// `message` events through it and observe what reaches the SW.
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
  // The page's own postMessage to *another* window (e.g. an iframe)
  // bubbles a "message" event whose source is that other window. We
  // only want events that originated in our window — anything else
  // could be cross-frame relay we shouldn't act on.
  const { sent, dispatch, goodEvent } = setupBridgeHarness();
  dispatch(goodEvent({ source: { not: 'our window' } }));
  assert.equal(sent.length, 0);
});

test('wrapper-bridge: ignores messages without the SourceMonkey marker', () => {
  // Any other page-issued postMessage on this window will reach our
  // listener; the marker is what distinguishes ours from theirs.
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
  // Even with the right marker, an unrecognised type must not be
  // relayed — otherwise the bridge would let arbitrary page-supplied
  // messages reach chrome.runtime.sendMessage and be dispatched to
  // every onMessage listener in the SW.
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
  // Defensive: the bridge runs in USER_SCRIPT world where chrome.runtime
  // is normally present, but if the API surface ever shifts we'd rather
  // skip listener install than throw during page load.
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

test('collectActiveSpecs: error scripts never run; missing scripts run only when explicitly enabled', () => {
  const sources = new Map([['source-1', makeSource()]]);
  const specs = collectActiveSpecs([
    // Error rows are never injected (header may be unparsed / failed validation).
    makeScript({ id: 's1', status: 'error', errorMessage: 'x' }),
    // Missing with enabled=false is the default state right after a file vanishes.
    makeScript({ id: 's2', status: 'missing', enabled: false }),
    // Missing with enabled=true means the user re-enabled it; run from cached body.
    makeScript({ id: 's3', status: 'missing', enabled: true }),
    makeScript({ id: 's4' }),
  ], sources);
  assert.deepEqual(specs.map((s) => s.id).sort(), ['s3', 's4']);
});

test('collectActiveSpecs: skips disabled scripts', () => {
  const sources = new Map([['source-1', makeSource()]]);
  const specs = collectActiveSpecs([
    makeScript({ id: 's1', enabled: false }),
    makeScript({ id: 's2' }),
  ], sources);
  assert.deepEqual(specs.map((s) => s.id), ['s2']);
});

test('collectActiveSpecs: skips every script under a disabled source', () => {
  const sources = new Map([['source-1', makeSource({ enabled: false })]]);
  const specs = collectActiveSpecs([
    makeScript({ id: 's1' }),
    makeScript({ id: 's2' }),
  ], sources);
  assert.deepEqual(specs.map((s) => s.id), []);
});

test('collectActiveSpecs: skips scripts whose source is missing entirely', () => {
  const sources = new Map(); // no entries
  const specs = collectActiveSpecs([makeScript()], sources);
  assert.deepEqual(specs, []);
});

test('collectActiveSpecs: treats undefined `enabled` as true (back-compat)', () => {
  const script = makeScript();
  delete script.enabled;
  const source = makeSource();
  delete source.enabled;
  const specs = collectActiveSpecs([script], new Map([['source-1', source]]));
  assert.equal(specs.length, 1);
});
