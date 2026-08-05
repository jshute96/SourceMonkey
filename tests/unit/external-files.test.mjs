// Unit tests for src/external-files.ts (compiled to dist/external-files.js).
//
// Covers `distillRequires`, `distillResources`, and the `attachFiles`
// orchestrator's resolution/dedup/error paths. Real network I/O is
// replaced by pre-seeding the cross-script fetch cache with a
// `{bytes, contentType}` (or failure) entry keyed by the canonical
// URL the resolver would produce — the orchestrator reads from the
// cache before invoking its own fetch path.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  attachFiles,
  describeFetchFailure,
  describeResolveFailure,
  distillRequires,
  distillResources,
  isFetchFailureMessage,
} from '../../dist/external-files.js';

const SCRIPT_URL = 'file:///home/me/scripts/foo.user.js';

function header(...tags) {
  return { tags: tags.map(([tag, value]) => ({ tag, value })) };
}

function bytesOf(text) {
  return new TextEncoder().encode(text).buffer;
}

function fakeFetched(text, contentType = 'application/javascript') {
  return { bytes: bytesOf(text), contentType };
}

// 0xC3 0x28 is an invalid UTF-8 sequence (0xC3 opens a 2-byte pair but
// 0x28 isn't a valid continuation). Shared by the strict-decode tests
// so they stay aligned when the fixture shape changes.
function fakeFetchedBinary(contentType = 'application/javascript') {
  return { bytes: new Uint8Array([0xC3, 0x28]).buffer, contentType };
}

function fakeFailure(errorMessage = 'fetch failed') {
  return { failed: true, errorMessage };
}

// ---------- distillRequires ----------

test('distillRequires: empty header returns empty', () => {
  assert.deepEqual(distillRequires(null), []);
  assert.deepEqual(distillRequires({ tags: [] }), []);
});

test('distillRequires: returns refs in declaration order', () => {
  const h = header(
    ['require', 'https://example.com/a.js'],
    ['require', 'https://example.com/b.js'],
    ['require', 'https://example.com/c.js'],
  );
  assert.deepEqual(distillRequires(h), [
    'https://example.com/a.js',
    'https://example.com/b.js',
    'https://example.com/c.js',
  ]);
});

test('distillRequires: dedupes within a header', () => {
  const h = header(
    ['require', 'https://example.com/a.js'],
    ['require', 'https://example.com/a.js'],
    ['require', 'https://example.com/b.js'],
  );
  assert.deepEqual(distillRequires(h), [
    'https://example.com/a.js',
    'https://example.com/b.js',
  ]);
});

test('distillRequires: trims whitespace, drops empties', () => {
  const h = header(
    ['require', '  https://example.com/a.js  '],
    ['require', ''],
    ['require', '   '],
  );
  assert.deepEqual(distillRequires(h), ['https://example.com/a.js']);
});

test('distillRequires: ignores localized @require:de variants', () => {
  const h = { tags: [
    { tag: 'require', locale: 'de', value: 'https://example.com/de.js' },
  ] };
  assert.deepEqual(distillRequires(h), []);
});

// ---------- distillResources ----------

test('distillResources: empty header returns empty', () => {
  assert.deepEqual(distillResources(null), []);
  assert.deepEqual(distillResources({ tags: [] }), []);
});

test('distillResources: parses `<name> <url>` pairs in order', () => {
  const h = header(
    ['resource', 'myCss https://example.com/style.css'],
    ['resource', 'logo https://example.com/logo.png'],
  );
  assert.deepEqual(distillResources(h), [
    { name: 'myCss', ref: 'https://example.com/style.css' },
    { name: 'logo', ref: 'https://example.com/logo.png' },
  ]);
});

test('distillResources: drops lines with no URL token', () => {
  const h = header(
    ['resource', 'lonelyName'],
    ['resource', 'good https://example.com/x.css'],
  );
  assert.deepEqual(distillResources(h), [
    { name: 'good', ref: 'https://example.com/x.css' },
  ]);
});

test('distillResources: dedupes by name (first wins)', () => {
  const h = header(
    ['resource', 'dup https://example.com/a.css'],
    ['resource', 'dup https://example.com/b.css'],
  );
  assert.deepEqual(distillResources(h), [
    { name: 'dup', ref: 'https://example.com/a.css' },
  ]);
});

// ---------- attachFiles: shared ----------

test('attachFiles: no @require or @resource → empty lists', async () => {
  const r = await attachFiles({
    scriptFileUrl: SCRIPT_URL,
    header: header(['name', 'X']),
    priorRequires: new Map(),
    priorResources: new Map(),
    recheck: 'all',
    fetchCache: new Map(),
    now: 2000,
  });
  assert.deepEqual(r, { requires: [], resources: [] });
});

// ---------- attachFiles: @require paths ----------

test('attachFiles: serves cache hits for @require', async () => {
  const url = 'https://cdn.example.com/jquery.js';
  const fetchCache = new Map([[url, Promise.resolve(fakeFetched('window.$ = {};'))]]);
  const r = await attachFiles({
    scriptFileUrl: SCRIPT_URL,
    header: header(['require', url]),
    priorRequires: new Map(),
    priorResources: new Map(),
    recheck: 'all',
    fetchCache,
    now: 2000,
  });
  assert.equal(r.errorMessage, undefined);
  assert.equal(r.requires.length, 1);
  assert.equal(r.requires[0].url, url);
  assert.equal(r.requires[0].source, 'window.$ = {};');
});

test('attachFiles: recheck=preserve reuses prior @require entries without fetching', async () => {
  const url = 'https://cdn.example.com/lib.js';
  const priorEntry = {
    ref: url,
    url,
    source: 'old source',
    size: 10,
    contentHash: 'abc',
    loadedAt: 9999,
    contentType: 'application/javascript',
  };
  const r = await attachFiles({
    scriptFileUrl: SCRIPT_URL,
    header: header(['require', url]),
    priorRequires: new Map([[url, priorEntry]]),
    priorResources: new Map(),
    recheck: 'preserve',
    fetchCache: new Map(),
    now: 9999,
  });
  assert.equal(r.errorMessage, undefined);
  assert.equal(r.requires[0].source, 'old source');
});

test('attachFiles: rejects @require non-.js suffix', async () => {
  const r = await attachFiles({
    scriptFileUrl: SCRIPT_URL,
    header: header(['require', 'https://cdn.example.com/lib.json']),
    priorRequires: new Map(),
    priorResources: new Map(),
    recheck: 'all',
    fetchCache: new Map(),
    now: 2000,
  });
  assert.match(r.errorMessage, /must end in \.js/);
  assert.deepEqual(r.requires, []);
});

test('attachFiles: rejects @require traversal-bearing ref', async () => {
  const r = await attachFiles({
    scriptFileUrl: SCRIPT_URL,
    header: header(['require', '../secret.js']),
    priorRequires: new Map(),
    priorResources: new Map(),
    recheck: 'all',
    fetchCache: new Map(),
    now: 2000,
  });
  // The two rejections below are different mistakes with different
  // fixes, so they must not share a message.
  assert.match(r.errorMessage, /points outside the script's own folder/);
});

test('attachFiles: rejects @require absolute file:// ref', async () => {
  const r = await attachFiles({
    scriptFileUrl: 'https://example.com/scripts/foo.user.js',
    header: header(['require', 'file:///etc/passwd.js']),
    priorRequires: new Map(),
    priorResources: new Map(),
    recheck: 'all',
    fetchCache: new Map(),
    now: 2000,
  });
  assert.match(r.errorMessage, /That URL scheme \(file:\) is not supported/);
});

test('attachFiles: rejects @require data: ref', async () => {
  const r = await attachFiles({
    scriptFileUrl: SCRIPT_URL,
    header: header(['require', 'data:text/javascript,alert(1)']),
    priorRequires: new Map(),
    priorResources: new Map(),
    recheck: 'all',
    fetchCache: new Map(),
    now: 2000,
  });
  assert.match(r.errorMessage, /URLs with the data: scheme are not supported/);
});

test('attachFiles: @require relative resolves against script URL', async () => {
  const resolvedUrl = 'file:///home/me/scripts/lib/util.js';
  const r = await attachFiles({
    scriptFileUrl: SCRIPT_URL,
    header: header(['require', 'lib/util.js']),
    priorRequires: new Map(),
    priorResources: new Map(),
    recheck: 'all',
    fetchCache: new Map([[resolvedUrl, Promise.resolve(fakeFetched('// util'))]]),
    now: 2000,
  });
  assert.equal(r.errorMessage, undefined);
  assert.equal(r.requires[0].url, resolvedUrl);
});

test('attachFiles: @require fetch failure surfaces ref + error', async () => {
  const url = 'https://cdn.example.com/broken.js';
  const r = await attachFiles({
    scriptFileUrl: SCRIPT_URL,
    header: header(['require', url]),
    priorRequires: new Map(),
    priorResources: new Map(),
    recheck: 'all',
    fetchCache: new Map([[url, Promise.resolve(fakeFailure('not found'))]]),
    now: 2000,
  });
  assert.match(r.errorMessage, /broken\.js/);
  assert.match(r.errorMessage, /not found/);
});

test('attachFiles: @require dedupes by canonical URL across refs', async () => {
  const canonical = 'file:///home/me/scripts/lib.js';
  const r = await attachFiles({
    scriptFileUrl: SCRIPT_URL,
    header: header(
      ['require', 'lib.js'],
      ['require', './lib.js'],
    ),
    priorRequires: new Map(),
    priorResources: new Map(),
    recheck: 'all',
    fetchCache: new Map([[canonical, Promise.resolve(fakeFetched('// lib'))]]),
    now: 2000,
  });
  assert.equal(r.errorMessage, undefined);
  assert.equal(r.requires.length, 1);
});

test('attachFiles: @require case-mixed .JS suffix accepted', async () => {
  const url = 'https://cdn.example.com/Lib.JS';
  const r = await attachFiles({
    scriptFileUrl: SCRIPT_URL,
    header: header(['require', url]),
    priorRequires: new Map(),
    priorResources: new Map(),
    recheck: 'all',
    fetchCache: new Map([[url, Promise.resolve(fakeFetched('// caps'))]]),
    now: 2000,
  });
  assert.equal(r.errorMessage, undefined);
  assert.equal(r.requires[0].source, '// caps');
});

test('attachFiles: @require rejects non-UTF-8 binary response', async () => {
  // Strict decode must fail even when the server claimed a JS type.
  const url = 'https://cdn.example.com/binary.js';
  const r = await attachFiles({
    scriptFileUrl: SCRIPT_URL,
    header: header(['require', url]),
    priorRequires: new Map(),
    priorResources: new Map(),
    recheck: 'all',
    fetchCache: new Map([[url, Promise.resolve(fakeFetchedBinary('text/javascript'))]]),
    now: 2000,
  });
  assert.match(r.errorMessage, /not valid UTF-8/);
});

// ---------- attachFiles: @resource paths ----------

test('attachFiles: @resource serves cache hit + carries contentType', async () => {
  const url = 'https://example.com/style.css';
  const r = await attachFiles({
    scriptFileUrl: SCRIPT_URL,
    header: header(['resource', `myCss ${url}`]),
    priorRequires: new Map(),
    priorResources: new Map(),
    recheck: 'all',
    fetchCache: new Map([[url, Promise.resolve(fakeFetched('body{}', 'text/css'))]]),
    now: 2000,
  });
  assert.equal(r.errorMessage, undefined);
  assert.equal(r.resources.length, 1);
  assert.equal(r.resources[0].name, 'myCss');
  assert.equal(r.resources[0].url, url);
  assert.equal(r.resources[0].contentType, 'text/css');
  // bytesBase64 of "body{}" UTF-8 bytes: 0x62 0x6F 0x64 0x79 0x7B 0x7D = "Ym9keXt9"
  assert.equal(r.resources[0].bytesBase64, 'Ym9keXt9');
});

test('attachFiles: @resource accepts non-.js URLs (images, HTML, anything)', async () => {
  const url = 'https://example.com/logo.png';
  const r = await attachFiles({
    scriptFileUrl: SCRIPT_URL,
    header: header(['resource', `logo ${url}`]),
    priorRequires: new Map(),
    priorResources: new Map(),
    recheck: 'all',
    fetchCache: new Map([[url, Promise.resolve(fakeFetched('PNGDATA', 'image/png'))]]),
    now: 2000,
  });
  assert.equal(r.errorMessage, undefined);
  assert.equal(r.resources[0].name, 'logo');
});

test('attachFiles: @resource rejects traversal-bearing ref', async () => {
  const r = await attachFiles({
    scriptFileUrl: SCRIPT_URL,
    header: header(['resource', 'bad ../secret.css']),
    priorRequires: new Map(),
    priorResources: new Map(),
    recheck: 'all',
    fetchCache: new Map(),
    now: 2000,
  });
  assert.match(r.errorMessage, /@resource bad \(\.\.\/secret\.css\)/);
  assert.match(r.errorMessage, /points outside the script's own folder/);
});

test('attachFiles: @resource fetch failure surfaces name + error', async () => {
  const url = 'https://example.com/missing.css';
  const r = await attachFiles({
    scriptFileUrl: SCRIPT_URL,
    header: header(['resource', `gone ${url}`]),
    priorRequires: new Map(),
    priorResources: new Map(),
    recheck: 'all',
    fetchCache: new Map([[url, Promise.resolve(fakeFailure('404'))]]),
    now: 2000,
  });
  // The name AND the ref: a resource name alone doesn't say what
  // failed to load.
  assert.match(r.errorMessage, /@resource gone \(https:\/\/example\.com\/missing\.css\)/);
  assert.match(r.errorMessage, /404/);
});

test('attachFiles: preserve mode reuses kept entries, fetches added refs, drops removed refs', async () => {
  // Prior state has two requires: A (kept) and B (removed).
  // New header keeps A, adds C, drops B.
  const aUrl = 'https://example.com/A.js';
  const bUrl = 'https://example.com/B.js';
  const cUrl = 'https://example.com/C.js';
  const priorA = {
    ref: aUrl, url: aUrl, source: '// A', size: 4,
    contentHash: 'hashA', loadedAt: 1000, contentType: 'application/javascript',
  };
  const priorB = {
    ref: bUrl, url: bUrl, source: '// B', size: 4,
    contentHash: 'hashB', loadedAt: 1000, contentType: 'application/javascript',
  };
  // The cache only has an entry for C — proves A reuses without
  // fetching, and B is never looked at.
  const fetchCache = new Map([[cUrl, Promise.resolve(fakeFetched('// C'))]]);
  const r = await attachFiles({
    scriptFileUrl: SCRIPT_URL,
    header: header(['require', aUrl], ['require', cUrl]),
    priorRequires: new Map([[aUrl, priorA], [bUrl, priorB]]),
    priorResources: new Map(),
    recheck: 'preserve',
    fetchCache,
    now: 2000,
  });
  assert.equal(r.errorMessage, undefined);
  assert.equal(r.requires.length, 2);
  assert.equal(r.requires[0].url, aUrl);
  assert.equal(r.requires[0].source, '// A');
  assert.equal(r.requires[0].loadedAt, 1000); // reused
  assert.equal(r.requires[1].url, cUrl);
  assert.equal(r.requires[1].source, '// C');
});

test('attachFiles: @resource recheck=preserve reuses prior entry', async () => {
  const url = 'https://example.com/x.css';
  const priorEntry = {
    ref: url,
    url,
    name: 'x',
    bytesBase64: 'b2xkY3Nz',
    size: 6,
    contentHash: 'abc',
    contentType: 'text/css',
    loadedAt: 9999,
  };
  const r = await attachFiles({
    scriptFileUrl: SCRIPT_URL,
    header: header(['resource', `x ${url}`]),
    priorRequires: new Map(),
    priorResources: new Map([[url, priorEntry]]),
    recheck: 'preserve',
    fetchCache: new Map(),
    now: 2000,
  });
  assert.equal(r.errorMessage, undefined);
  assert.equal(r.resources[0].bytesBase64, 'b2xkY3Nz');
});

// ---------- attachFiles: cross-kind fetch dedup ----------

test('attachFiles: @require and @resource at the same URL share the fetch cache', async () => {
  const url = 'https://example.com/shared.js';
  // One entry in the cache covers both kinds.
  const r = await attachFiles({
    scriptFileUrl: SCRIPT_URL,
    header: header(
      ['require', url],
      ['resource', `helper ${url}`],
    ),
    priorRequires: new Map(),
    priorResources: new Map(),
    recheck: 'all',
    fetchCache: new Map([[url, Promise.resolve(fakeFetched('// shared'))]]),
    now: 2000,
  });
  assert.equal(r.errorMessage, undefined);
  assert.equal(r.requires.length, 1);
  assert.equal(r.requires[0].source, '// shared');
  assert.equal(r.resources.length, 1);
  assert.equal(r.resources[0].name, 'helper');
});

test('attachFiles: @require accepts application/octet-stream', async () => {
  // The generic type is what GitHub serves for *every* release asset,
  // and release URLs are a normal place to pin a library — rejecting it
  // broke real scripts. Binary is caught by the strict UTF-8 decode
  // (see the non-UTF-8 test above), not by the Content-Type gate.
  const url = 'https://github.com/o/r/releases/download/v1/lib.min.js';
  const r = await attachFiles({
    scriptFileUrl: SCRIPT_URL,
    header: header(['require', url]),
    priorRequires: new Map(),
    priorResources: new Map(),
    recheck: 'all',
    fetchCache: new Map([[url, Promise.resolve(fakeFetched('// js source', 'application/octet-stream'))]]),
    now: 2000,
  });
  assert.equal(r.errorMessage, undefined);
  assert.equal(r.requires[0].source, '// js source');
});

test('attachFiles: @require rejects octet-stream that is actually binary', async () => {
  // The pair to the test above: the generic Content-Type buys no
  // trust, it just stops being the thing that decides. Same invalid
  // UTF-8 sequence, now with nothing in the type to object to.
  const url = 'https://github.com/o/r/releases/download/v1/lib.min.js';
  const r = await attachFiles({
    scriptFileUrl: SCRIPT_URL,
    header: header(['require', url]),
    priorRequires: new Map(),
    priorResources: new Map(),
    recheck: 'all',
    fetchCache: new Map([[url, Promise.resolve(fakeFetchedBinary('application/octet-stream'))]]),
    now: 2000,
  });
  assert.match(r.errorMessage, /not valid UTF-8/);
});

test('attachFiles: @require accepts text/plain and rejects xhtml', async () => {
  // Pins the denylist shape against an accidental re-tightening: the
  // gate rejects the markup family and nothing else.
  const check = async (contentType) => {
    const url = 'https://cdn.example.com/lib.js';
    const r = await attachFiles({
      scriptFileUrl: SCRIPT_URL,
      header: header(['require', url]),
      priorRequires: new Map(),
      priorResources: new Map(),
      recheck: 'all',
      fetchCache: new Map([[url, Promise.resolve(fakeFetched('// js source', contentType))]]),
      now: 2000,
    });
    return r.errorMessage;
  };
  assert.equal(await check('text/plain; charset=utf-8'), undefined);
  assert.equal(await check('application/json'), undefined);
  // XHTML is markup under a non-`text/html` spelling — same soft-failure
  // signature, so the gate has a second clause for it.
  assert.match(await check('application/xhtml+xml'), /returned an HTML page/);
  assert.match(await check('text/html-sandboxed'), /returned an HTML page/);
});

test('attachFiles: @require rejects a text/html Content-Type (soft-failure login page)', async () => {
  // A @require is always JavaScript, never HTML. An HTML response at 200
  // is the classic soft failure — a login / error page served in place
  // of the real library. Rejecting it turns the soft failure into a
  // clean fetch error, which the refresh pipeline then treats as a
  // refresh failure (keep the prior good copy) rather than swapping the
  // working dependency for a page of markup. It's the only type the
  // gate rejects — everything else, `text/plain` and generic binary
  // types included, is left to the UTF-8 decode.
  const url = 'https://example.com/lib.js';
  const r = await attachFiles({
    scriptFileUrl: SCRIPT_URL,
    header: header(['require', url]),
    priorRequires: new Map(),
    priorResources: new Map(),
    recheck: 'all',
    fetchCache: new Map([[url, Promise.resolve(
      fakeFetched('<!doctype html><title>Log in</title>', 'text/html; charset=utf-8'),
    )]]),
    now: 2000,
  });
  assert.match(r.errorMessage, /returned an HTML page/);
});

test('attachFiles: @resource at same URL succeeds even when @require would reject the Content-Type', async () => {
  // The bug this prevents: previously the shared fetchCache stored
  // the result of the first caller's predicate. A @require rejecting
  // the type would write a FileFailure that the resource caller would
  // see. Now the predicate moved off the shared cache, so the resource
  // succeeds — an HTML @resource is a legitimate GM_getResourceText.
  const url = 'https://example.com/shared.js';
  const r = await attachFiles({
    scriptFileUrl: SCRIPT_URL,
    header: header(
      ['resource', `blob ${url}`],
      ['require', url],
    ),
    priorRequires: new Map(),
    priorResources: new Map(),
    recheck: 'all',
    fetchCache: new Map([[url, Promise.resolve(fakeFetched('<!doctype html>', 'text/html'))]]),
    now: 2000,
  });
  // @require still errors out the whole script (preserve-on-failure),
  // but the failure mentions the require, not the resource.
  assert.match(r.errorMessage, /@require/);
  assert.doesNotMatch(r.errorMessage, /@resource/);

  // The assertions above can't prove the resource itself survived: the
  // require loop runs first and returns on its first error, so
  // loadResource was never reached. Re-run the same seeded cache with
  // only the @resource to show the entry loads — an HTML @resource is
  // a legitimate GM_getResourceText payload.
  const r2 = await attachFiles({
    scriptFileUrl: SCRIPT_URL,
    header: header(['resource', `blob ${url}`]),
    priorRequires: new Map(),
    priorResources: new Map(),
    recheck: 'all',
    fetchCache: new Map([[url, Promise.resolve(fakeFetched('<!doctype html>', 'text/html'))]]),
    now: 2000,
  });
  assert.equal(r2.errorMessage, undefined);
  assert.equal(r2.resources[0].contentType, 'text/html');
});


// ---------- describeFetchFailure / describeResolveFailure ----------
//
// These are the only place a structured reason becomes words. Every
// one of them is appended to a subject (`@require ./lib.js: `), so
// each has to read as a predicate of the dependency.

test('describeFetchFailure: each reason produces a distinct, specific message', () => {
  const seen = new Set();
  for (const failure of [
    { failed: true, reason: 'unsupported-scheme' },
    { failed: true, reason: 'no-response' },
    { failed: true, reason: 'timeout' },
    { failed: true, reason: 'unreadable-file' },
    { failed: true, reason: 'http-error', status: 404 },
    { failed: true, reason: 'wrong-content-type' },
    { failed: true, reason: 'empty' },
    { failed: true, reason: 'oversize' },
  ]) {
    const text = describeFetchFailure(failure);
    assert.ok(typeof text === 'string' && text.length > 0, `${failure.reason} produced nothing`);
    assert.equal(seen.has(text), false, `${failure.reason} duplicates another message`);
    seen.add(text);
    // The message this replaced listed three possibilities at once.
    // `unreadable-file` is the only one still allowed to name more than
    // one cause — see the test below for why.
    if (failure.reason !== 'unreadable-file') {
      assert.doesNotMatch(text, / or /, `${failure.reason} hedges between causes`);
    }
  }
});

test('describeFetchFailure: a timeout is not folded in with a network failure', () => {
  // Our own abort is identifiable (`controller.signal.aborted`), so
  // these must not share a message.
  const timeout = describeFetchFailure({ failed: true, reason: 'timeout' });
  const network = describeFetchFailure({ failed: true, reason: 'no-response' });
  assert.match(timeout, /timed out/);
  assert.doesNotMatch(network, /timed out/);
});

test('describeFetchFailure: a missing local file is not reported as a network problem', () => {
  const text = describeFetchFailure({ failed: true, reason: 'unreadable-file' });
  assert.match(text, /may not exist/);
  assert.doesNotMatch(text, /network/);
  // The one legitimate hedge: a file:// read has no HTTP layer, so
  // "absent" and "unreadable" arrive identically.
  assert.match(text, /may not be readable/);
});

test('describeFetchFailure: an HTTP failure states the status', () => {
  assert.match(describeFetchFailure({ failed: true, reason: 'http-error', status: 403 }), /HTTP 403/);
  assert.match(describeFetchFailure({ failed: true, reason: 'http-error', status: 500 }), /HTTP 500/);
});

test('describeFetchFailure: size and emptiness name the file as their subject', () => {
  assert.equal(describeFetchFailure({ failed: true, reason: 'empty' }), 'The file is empty');
  assert.match(describeFetchFailure({ failed: true, reason: 'oversize' }), /^The file is larger than the /);
});

// `scripts/validate-userscripts.mjs` asks this instead of matching the
// wording, because it used to match the wording and went stale silently
// when these messages were recased. If a reason ever stops being
// recognized, the validator quietly mislabels that whole bucket rather
// than failing — so the coverage has to be pinned here.
test('isFetchFailureMessage: recognizes every message describeFetchFailure can produce', () => {
  const reasons = [
    'unsupported-scheme', 'no-response', 'timeout', 'unreadable-file',
    'wrong-content-type', 'empty', 'oversize',
  ];
  for (const reason of reasons) {
    const text = describeFetchFailure({ failed: true, reason });
    assert.ok(isFetchFailureMessage(text), `unrecognized: ${reason} -> ${text}`);
  }
  // The templated one, whose text isn't fixed at module load.
  for (const status of [404, 500]) {
    const text = describeFetchFailure({ failed: true, reason: 'http-error', status });
    assert.ok(isFetchFailureMessage(text), `unrecognized: http-error ${status}`);
  }
});

test('isFetchFailureMessage: rejects messages from the resolve half and from elsewhere', () => {
  // A resolve failure is a different bucket in the validator's survey;
  // admitting one here would let the offline mirror's wording override
  // a message about the ref itself, which the mirror knows nothing about.
  assert.equal(
    isFetchFailureMessage(describeResolveFailure({ failed: true, reason: 'malformed-url' })),
    false,
  );
  assert.equal(isFetchFailureMessage('No @name in the metadata block'), false);
  assert.equal(isFetchFailureMessage(''), false);
});

test('describeResolveFailure: the two mistakes that used to share a message now differ', () => {
  const outside = describeResolveFailure({ failed: true, reason: 'outside-script-folder' });
  const scheme = describeResolveFailure({ failed: true, reason: 'unsupported-scheme', scheme: 'ftp:' });
  assert.notEqual(outside, scheme);
  assert.match(outside, /outside the script's own folder/);
  // Names the scheme the author wrote rather than restating the rule.
  assert.match(scheme, /^That URL scheme \(ftp:\) is not supported/);
});

// ---------- the whole path, message included ----------

test('attachFiles: an http dependency that 404s reports the status, through the real fetch path', async () => {
  // Not a seeded cache entry: this drives `fetchResourceBytes` itself,
  // so it pins the one thing the two halves of this feature exist for —
  // that a known cause survives all the way into the sentence a user
  // reads.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 404 });
  try {
    const r = await attachFiles({
      scriptFileUrl: 'https://example.com/scripts/foo.user.js',
      header: header(['require', 'https://example.com/lib.js']),
      priorRequires: new Map(),
      priorResources: new Map(),
      recheck: 'all',
      fetchCache: new Map(),
      now: 2000,
    });
    assert.equal(
      r.errorMessage,
      '@require https://example.com/lib.js: The server returned HTTP 404',
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('attachFiles: an oversize dependency names the limit, not a generic failure', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(new Uint8Array(2 * 1024 * 1024).buffer, {
    status: 200,
    headers: { 'content-type': 'application/javascript' },
  });
  try {
    const r = await attachFiles({
      scriptFileUrl: 'https://example.com/scripts/foo.user.js',
      header: header(['require', 'https://example.com/big.js']),
      priorRequires: new Map(),
      priorResources: new Map(),
      recheck: 'all',
      fetchCache: new Map(),
      now: 2000,
    });
    assert.match(r.errorMessage, /^@require https:\/\/example\.com\/big\.js: The file is larger than the /);
  } finally {
    globalThis.fetch = realFetch;
  }
});
