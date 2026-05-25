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
  distillRequires,
  distillResources,
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
  assert.match(r.errorMessage, /blocked or invalid/);
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
  assert.match(r.errorMessage, /blocked or invalid/);
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
  assert.match(r.errorMessage, /data: URLs/);
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
  // Bytes 0xC3 0x28 is an invalid UTF-8 sequence (0xC3 starts a 2-byte
  // pair but 0x28 isn't a valid continuation). Strict decode must fail.
  const url = 'https://cdn.example.com/binary.js';
  const bad = new Uint8Array([0xC3, 0x28]).buffer;
  const r = await attachFiles({
    scriptFileUrl: SCRIPT_URL,
    header: header(['require', url]),
    priorRequires: new Map(),
    priorResources: new Map(),
    recheck: 'all',
    fetchCache: new Map([[url, Promise.resolve({ bytes: bad, contentType: 'text/javascript' })]]),
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
  assert.match(r.errorMessage, /@resource bad/);
  assert.match(r.errorMessage, /blocked or invalid/);
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
  assert.match(r.errorMessage, /@resource gone/);
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

test('attachFiles: @require rejects a non-text Content-Type from shared bytes', async () => {
  // Cache returns octet-stream bytes (e.g. a resource that an earlier
  // resource caller accepted). @require still rejects via its own
  // typed-side Content-Type check — the shared cache isn't biased by
  // the require's stricter rule, but the require still applies it.
  const url = 'https://example.com/shared.bin.js';
  const r = await attachFiles({
    scriptFileUrl: SCRIPT_URL,
    header: header(['require', url]),
    priorRequires: new Map(),
    priorResources: new Map(),
    recheck: 'all',
    fetchCache: new Map([[url, Promise.resolve(fakeFetched('// js source', 'application/octet-stream'))]]),
    now: 2000,
  });
  assert.match(r.errorMessage, /not JavaScript or text/);
});

test('attachFiles: @resource at same URL succeeds even when @require would reject the Content-Type', async () => {
  // The bug this prevents: previously the shared fetchCache stored
  // the result of the first caller's predicate. A @require rejecting
  // octet-stream would write a FileFailure that the resource caller
  // would see. Now the predicate moved off the shared cache, so the
  // resource succeeds.
  const url = 'https://example.com/shared.bin.js';
  const r = await attachFiles({
    scriptFileUrl: SCRIPT_URL,
    header: header(
      ['resource', `blob ${url}`],
      ['require', url],
    ),
    priorRequires: new Map(),
    priorResources: new Map(),
    recheck: 'all',
    fetchCache: new Map([[url, Promise.resolve(fakeFetched('// js source', 'application/octet-stream'))]]),
    now: 2000,
  });
  // @require still errors out the whole script (preserve-on-failure),
  // but the failure mentions the require, not the resource.
  assert.match(r.errorMessage, /@require/);
  assert.doesNotMatch(r.errorMessage, /@resource/);
});
