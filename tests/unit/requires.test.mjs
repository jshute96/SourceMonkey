// Unit tests for src/requires.ts (compiled to dist/requires.js).
//
// Covers the pure-ish slice — `distillRequires` extraction + the
// `attachRequires` orchestrator's resolution/dedup/error paths. Real
// fetch I/O is replaced with a stub via the cross-script fetch cache
// (the orchestrator reads from the cache by canonical URL before
// invoking its own fetch path, so pre-seeding the cache covers both
// the cache-hit path AND insulates the test from network access).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { attachRequires, distillRequires } from '../../dist/requires.js';

const SCRIPT_URL = 'file:///home/me/scripts/foo.user.js';

function header(...tags) {
  return { tags: tags.map(([tag, value]) => ({ tag, value })) };
}

// Build a "resolved" stub StoredRequire to seed the fetch cache with.
// Real fetches in attachRequires would produce the same shape; pre-
// seeding lets unit tests assert orchestrator behavior without I/O.
function fakeRequire(url, source) {
  return {
    ref: url,
    url,
    source,
    size: source.length,
    contentHash: 'fakehash:' + source,
    loadedAt: 1000,
  };
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

// ---------- attachRequires ----------

test('attachRequires: no @require → empty list', async () => {
  const r = await attachRequires({
    scriptFileUrl: SCRIPT_URL,
    header: header(['name', 'X']),
    prior: new Map(),
    recheck: 'all',
    fetchCache: new Map(),
    now: 2000,
  });
  assert.deepEqual(r, { requires: [] });
});

test('attachRequires: serves cache hits (cross-script dedup)', async () => {
  // Pre-seed the cache as a successful prior fetch. The orchestrator
  // should read the cache by canonical URL and never invoke its own
  // fetch path for this URL.
  const url = 'https://cdn.example.com/jquery.js';
  const stub = fakeRequire(url, 'window.$ = {};');
  const fetchCache = new Map([[url, Promise.resolve(stub)]]);
  const r = await attachRequires({
    scriptFileUrl: SCRIPT_URL,
    header: header(['require', url]),
    prior: new Map(),
    recheck: 'all',
    fetchCache,
    now: 2000,
  });
  assert.equal(r.errorMessage, undefined);
  assert.equal(r.requires.length, 1);
  assert.equal(r.requires[0].url, url);
  assert.equal(r.requires[0].source, 'window.$ = {};');
});

test('attachRequires: recheck=preserve reuses prior entries without fetching', async () => {
  // No fetchCache entry — if the orchestrator tried to fetch we'd hit
  // the network (or a failure). The fact that the test passes proves
  // it short-circuited on the prior map.
  const url = 'https://cdn.example.com/lib.js';
  const prior = fakeRequire(url, 'old source');
  const r = await attachRequires({
    scriptFileUrl: SCRIPT_URL,
    header: header(['require', url]),
    prior: new Map([[url, prior]]),
    recheck: 'preserve',
    fetchCache: new Map(),
    now: 9999,
  });
  assert.equal(r.errorMessage, undefined);
  assert.equal(r.requires.length, 1);
  assert.equal(r.requires[0].source, 'old source');
});

test('attachRequires: rejects non-.js suffix', async () => {
  const r = await attachRequires({
    scriptFileUrl: SCRIPT_URL,
    header: header(['require', 'https://cdn.example.com/lib.json']),
    prior: new Map(),
    recheck: 'all',
    fetchCache: new Map(),
    now: 2000,
  });
  assert.match(r.errorMessage, /must end in \.js/);
  assert.deepEqual(r.requires, []);
});

test('attachRequires: accepts .js with query string', async () => {
  const url = 'https://cdn.example.com/lib.js?v=3';
  const stub = fakeRequire(url, '// lib');
  const r = await attachRequires({
    scriptFileUrl: SCRIPT_URL,
    header: header(['require', url]),
    prior: new Map(),
    recheck: 'all',
    fetchCache: new Map([[url, Promise.resolve(stub)]]),
    now: 2000,
  });
  assert.equal(r.errorMessage, undefined);
  assert.equal(r.requires[0].url, url);
});

test('attachRequires: rejects traversal-bearing ref', async () => {
  const r = await attachRequires({
    scriptFileUrl: SCRIPT_URL,
    header: header(['require', '../secret.js']),
    prior: new Map(),
    recheck: 'all',
    fetchCache: new Map(),
    now: 2000,
  });
  assert.match(r.errorMessage, /blocked or invalid/);
});

test('attachRequires: rejects absolute file:// ref', async () => {
  const r = await attachRequires({
    scriptFileUrl: 'https://example.com/scripts/foo.user.js',
    header: header(['require', 'file:///etc/passwd.js']),
    prior: new Map(),
    recheck: 'all',
    fetchCache: new Map(),
    now: 2000,
  });
  assert.match(r.errorMessage, /blocked or invalid/);
});

test('attachRequires: rejects data: ref', async () => {
  const r = await attachRequires({
    scriptFileUrl: SCRIPT_URL,
    header: header(['require', 'data:text/javascript,alert(1)']),
    prior: new Map(),
    recheck: 'all',
    fetchCache: new Map(),
    now: 2000,
  });
  assert.match(r.errorMessage, /data: URLs/);
});

test('attachRequires: relative path resolves against script URL', async () => {
  // The orchestrator goes through file-loader's resolver. We don't
  // actually fetch here — pre-seed the cache at the resolved canonical
  // URL so the dedup short-circuit fires.
  const resolvedUrl = 'file:///home/me/scripts/lib/util.js';
  const stub = fakeRequire(resolvedUrl, '// util');
  const r = await attachRequires({
    scriptFileUrl: SCRIPT_URL,
    header: header(['require', 'lib/util.js']),
    prior: new Map(),
    recheck: 'all',
    fetchCache: new Map([[resolvedUrl, Promise.resolve(stub)]]),
    now: 2000,
  });
  assert.equal(r.errorMessage, undefined);
  assert.equal(r.requires[0].url, resolvedUrl);
});

test('attachRequires: cache failure flows through as script errorMessage', async () => {
  const url = 'https://cdn.example.com/broken.js';
  const fetchCache = new Map([[url, Promise.resolve({
    failed: true,
    ref: url,
    url,
    errorMessage: 'fetch failed',
  })]]);
  const r = await attachRequires({
    scriptFileUrl: SCRIPT_URL,
    header: header(['require', url]),
    prior: new Map(),
    recheck: 'all',
    fetchCache,
    now: 2000,
  });
  assert.match(r.errorMessage, /broken\.js/);
  assert.match(r.errorMessage, /fetch failed/);
});

test('attachRequires: dedupes by canonical URL across refs in one script', async () => {
  // Two different refs that resolve to the same canonical URL.
  const canonical = 'file:///home/me/scripts/lib.js';
  const stub = fakeRequire(canonical, '// lib');
  const r = await attachRequires({
    scriptFileUrl: SCRIPT_URL,
    header: header(
      ['require', 'lib.js'],
      ['require', './lib.js'],
    ),
    prior: new Map(),
    recheck: 'all',
    fetchCache: new Map([[canonical, Promise.resolve(stub)]]),
    now: 2000,
  });
  assert.equal(r.errorMessage, undefined);
  assert.equal(r.requires.length, 1);
});

test('attachRequires: case-mixed .JS suffix is accepted (forwarded to fetch)', async () => {
  const url = 'https://cdn.example.com/Lib.JS';
  const stub = fakeRequire(url, '// caps');
  const r = await attachRequires({
    scriptFileUrl: SCRIPT_URL,
    header: header(['require', url]),
    prior: new Map(),
    recheck: 'all',
    fetchCache: new Map([[url, Promise.resolve(stub)]]),
    now: 2000,
  });
  assert.equal(r.errorMessage, undefined);
  assert.equal(r.requires[0].source, '// caps');
});

test('attachRequires: recheck=preserve fetches newly-added refs but reuses cached ones', async () => {
  // Opportunistic path with a mixed list: one ref the prior already
  // has (reuse verbatim, no fetch attempted) and one new ref (must
  // fetch). Pre-seed the cache for the new URL only — if the
  // orchestrator tried to fetch the cached URL we'd hit network.
  const cachedUrl = 'https://cdn.example.com/cached.js';
  const newUrl = 'https://cdn.example.com/fresh.js';
  const cachedPrior = fakeRequire(cachedUrl, '// cached');
  const newStub = fakeRequire(newUrl, '// fresh');
  const r = await attachRequires({
    scriptFileUrl: SCRIPT_URL,
    header: header(
      ['require', cachedUrl],
      ['require', newUrl],
    ),
    prior: new Map([[cachedUrl, cachedPrior]]),
    recheck: 'preserve',
    fetchCache: new Map([[newUrl, Promise.resolve(newStub)]]),
    now: 2000,
  });
  assert.equal(r.errorMessage, undefined);
  assert.equal(r.requires.length, 2);
  assert.equal(r.requires[0].source, '// cached');
  assert.equal(r.requires[1].source, '// fresh');
});

test('attachRequires: failure message names this script\'s ref, not the cache\'s stored ref', async () => {
  // The fetch cache stores a failure recorded by some other script
  // (with that script's ref). When this script hits the same canonical
  // URL, the error returned must mention THIS script's ref so users
  // can find the offending line in their own header.
  const url = 'https://cdn.example.com/broken.js';
  const failure = { failed: true, ref: 'OTHER_SCRIPTS_REF', url, errorMessage: 'fetch failed' };
  const r = await attachRequires({
    scriptFileUrl: SCRIPT_URL,
    header: header(['require', url]),
    prior: new Map(),
    recheck: 'all',
    fetchCache: new Map([[url, Promise.resolve(failure)]]),
    now: 2000,
  });
  assert.match(r.errorMessage, /broken\.js/);
  assert.doesNotMatch(r.errorMessage, /OTHER_SCRIPTS_REF/);
});
