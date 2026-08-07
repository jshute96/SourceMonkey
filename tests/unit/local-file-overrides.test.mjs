// Unit tests for src/local-file-overrides.ts (compiled to dist/local-file-overrides.js)
// plus the `localRoots` leg of `attachFiles` in src/external-files.ts.
//
// Two halves:
//   - the pure candidate/root rules, which is where the safety
//     properties live (no climbing above a root, no inference for a
//     non-local host script);
//   - the orchestrator wiring, exercised the same way the rest of
//     external-files.test.mjs does it — by pre-seeding the shared fetch
//     cache with the URLs the resolver would produce, so a "file that
//     exists on disk" is a seeded cache hit and one that doesn't is a
//     seeded failure.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  localFileCandidates,
  localSearchRoots,
  sourceSupportsLocalFiles,
} from '../../dist/local-file-overrides.js';
import { attachFiles } from '../../dist/external-files.js';
import { localFileLogMessages, sourceUsesLocalFiles } from '../../dist/script-store.js';

const SCRIPT_URL = 'file:///home/me/scripts/foo.user.js';
const SCRIPT_DIR = 'file:///home/me/scripts/';

function header(...tags) {
  return { tags: tags.map(([tag, value]) => ({ tag, value })) };
}

function fakeFetched(text, contentType = 'application/javascript') {
  return { bytes: new TextEncoder().encode(text).buffer, contentType };
}

function fakeFailure(errorMessage = 'The file may not exist, or may not be readable') {
  return { failed: true, errorMessage };
}

// ---------- localSearchRoots ----------

test('localSearchRoots: a local script gets its own folder', () => {
  assert.deepEqual(localSearchRoots(SCRIPT_URL, true), [SCRIPT_DIR]);
});

test('localSearchRoots: disabled means no roots at all', () => {
  assert.deepEqual(localSearchRoots(SCRIPT_URL, false), []);
});

// The load-bearing safety rule: inference is for locally-loaded scripts
// only, so an http(s)-hosted script can never reach the filesystem.
test('localSearchRoots: an http-loaded script never gets roots', () => {
  assert.deepEqual(localSearchRoots('https://example.com/foo.user.js', true), []);
  assert.deepEqual(localSearchRoots('', true), []);
});

// ---------- localFileCandidates ----------

test('localFileCandidates: no roots means no candidates and no probing', () => {
  assert.deepEqual(localFileCandidates('https://cdn.example.com/lib/util.js', []), []);
});

test('localFileCandidates: path suffixes, longest first', () => {
  assert.deepEqual(
    localFileCandidates('https://cdn.example.com/a/b/util.js', [SCRIPT_DIR]),
    [
      `${SCRIPT_DIR}a/b/util.js`,
      `${SCRIPT_DIR}b/util.js`,
      `${SCRIPT_DIR}util.js`,
    ],
  );
});

test('localFileCandidates: a root without a trailing slash still joins correctly', () => {
  assert.deepEqual(
    localFileCandidates('https://cdn.example.com/util.js', ['file:///home/me/lib']),
    ['file:///home/me/lib/util.js'],
  );
});

test('localFileCandidates: roots are searched in order, each longest-suffix first', () => {
  assert.deepEqual(
    localFileCandidates('https://cdn.example.com/lib/util.js', [SCRIPT_DIR, 'file:///opt/js/']),
    [
      `${SCRIPT_DIR}lib/util.js`,
      `${SCRIPT_DIR}util.js`,
      'file:///opt/js/lib/util.js',
      'file:///opt/js/util.js',
    ],
  );
});

// A ref that already resolves to the file we'd offer is the ordinary
// relative-path case, not an override — offering it would double the
// fetch and mislabel the entry.
test('localFileCandidates: a declared URL is never offered as its own stand-in', () => {
  assert.deepEqual(
    localFileCandidates(`${SCRIPT_DIR}util.js`, [SCRIPT_DIR]),
    [],
  );
});

// The traversal property. The URL parser normalizes `..` and `%2e%2e`
// away before we ever split on `/`, so those can't produce a climbing
// candidate. An ENCODED separator is the case the parser does NOT
// normalize — `/a/..%2f../secret.js` survives as one segment `..%2f..`
// and would pass the prefix re-check while still decoding to a real
// `../..` at the filesystem layer — so it's rejected explicitly.
test('localFileCandidates: cannot climb above the root', () => {
  for (const declared of [
    'https://cdn.example.com/../../../etc/passwd.js',
    'https://cdn.example.com/%2e%2e/%2e%2e/etc/passwd.js',
    'https://cdn.example.com/a/../../../passwd.js',
    'https://cdn.example.com/a/..%2f../secret.js',
    'https://cdn.example.com/a/..%2F..%2F../secret.js',
    'https://cdn.example.com/a/..%5c../secret.js',
  ]) {
    for (const candidate of localFileCandidates(declared, [SCRIPT_DIR])) {
      assert.ok(
        candidate.startsWith(SCRIPT_DIR),
        `${candidate} escaped ${SCRIPT_DIR} (from ${declared})`,
      );
    }
  }
});

// Stronger than the containment loop above: an encoded separator makes
// the whole URL ineligible, so there is no candidate to check at all.
test('localFileCandidates: an encoded separator yields no candidates', () => {
  assert.deepEqual(
    localFileCandidates('https://cdn.example.com/a/..%2f../secret.js', [SCRIPT_DIR]),
    [],
  );
  assert.deepEqual(
    localFileCandidates('https://cdn.example.com/lib%2Futil.js', [SCRIPT_DIR]),
    [],
  );
});

test('localFileCandidates: a URL with no path segments yields nothing', () => {
  assert.deepEqual(localFileCandidates('https://cdn.example.com/', [SCRIPT_DIR]), []);
  assert.deepEqual(localFileCandidates('not a url', [SCRIPT_DIR]), []);
});

// ---------- sourceSupportsLocalFiles ----------

test('sourceSupportsLocalFiles: local paths yes, http sources no', () => {
  assert.equal(sourceSupportsLocalFiles('/home/me/scripts'), true);
  assert.equal(sourceSupportsLocalFiles('file:///home/me/scripts'), true);
  assert.equal(sourceSupportsLocalFiles('container:file'), true);
  assert.equal(sourceSupportsLocalFiles('https://example.com/script_manifest.json'), false);
  assert.equal(sourceSupportsLocalFiles('container:http'), false);
  assert.equal(sourceSupportsLocalFiles('container:github'), false);
});

// ---------- attachFiles with localRoots ----------

test('attachFiles: a same-folder file stands in for an absolute @require URL', async () => {
  const cache = new Map();
  cache.set(`${SCRIPT_DIR}util.js`, Promise.resolve(fakeFetched('local body')));
  cache.set('https://cdn.example.com/util.js', Promise.resolve(fakeFetched('remote body')));
  const r = await attachFiles({
    scriptFileUrl: SCRIPT_URL,
    header: header(['require', 'https://cdn.example.com/util.js']),
    priorRequires: new Map(),
    priorResources: new Map(),
    recheck: 'all',
    fetchCache: cache,
    now: 1,
    localRoots: [SCRIPT_DIR],
  });
  assert.equal(r.errorMessage, undefined);
  assert.equal(r.requires[0].source, 'local body');
  // The declared URL stays the identity of the entry; the stand-in is
  // recorded beside it.
  assert.equal(r.requires[0].url, 'https://cdn.example.com/util.js');
  assert.equal(r.requires[0].localUrl, `${SCRIPT_DIR}util.js`);
});

test('attachFiles: no local file means the declared URL is fetched and no localUrl is set', async () => {
  const cache = new Map();
  cache.set(`${SCRIPT_DIR}util.js`, Promise.resolve(fakeFailure()));
  cache.set('https://cdn.example.com/util.js', Promise.resolve(fakeFetched('remote body')));
  const r = await attachFiles({
    scriptFileUrl: SCRIPT_URL,
    header: header(['require', 'https://cdn.example.com/util.js']),
    priorRequires: new Map(),
    priorResources: new Map(),
    recheck: 'all',
    fetchCache: cache,
    now: 1,
    localRoots: [SCRIPT_DIR],
  });
  assert.equal(r.requires[0].source, 'remote body');
  assert.ok(!('localUrl' in r.requires[0]));
});

// The deeper suffix wins, so a deliberate `lib/` layout beats an
// incidental basename collision loose in the same root.
test('attachFiles: the longest matching suffix wins', async () => {
  const cache = new Map();
  cache.set(`${SCRIPT_DIR}lib/util.js`, Promise.resolve(fakeFetched('deep')));
  cache.set(`${SCRIPT_DIR}util.js`, Promise.resolve(fakeFetched('shallow')));
  const r = await attachFiles({
    scriptFileUrl: SCRIPT_URL,
    header: header(['require', 'https://cdn.example.com/lib/util.js']),
    priorRequires: new Map(),
    priorResources: new Map(),
    recheck: 'all',
    fetchCache: cache,
    now: 1,
    localRoots: [SCRIPT_DIR],
  });
  assert.equal(r.requires[0].source, 'deep');
});

// The dev-loop property: an overridden file is re-read on EVERY pass,
// including opportunistic ones, or an edit on disk wouldn't surface
// until the user clicked Refresh.
test('attachFiles: recheck=preserve still re-reads a local stand-in', async () => {
  const prior = {
    ref: 'https://cdn.example.com/util.js',
    url: 'https://cdn.example.com/util.js',
    localUrl: `${SCRIPT_DIR}util.js`,
    source: 'old local body',
    size: 14,
    contentHash: 'stale',
    loadedAt: 1,
  };
  const cache = new Map();
  cache.set(`${SCRIPT_DIR}util.js`, Promise.resolve(fakeFetched('edited local body')));
  const r = await attachFiles({
    scriptFileUrl: SCRIPT_URL,
    header: header(['require', 'https://cdn.example.com/util.js']),
    priorRequires: new Map([[prior.url, prior]]),
    priorResources: new Map(),
    recheck: 'preserve',
    fetchCache: cache,
    now: 2,
    localRoots: [SCRIPT_DIR],
  });
  assert.equal(r.requires[0].source, 'edited local body');
});

// …while a REMOTE dependency keeps the cached-and-left-alone treatment,
// which is what keeps per-navigation cost bounded. The declared URL is
// deliberately absent from the cache: reaching for it would throw here.
test('attachFiles: recheck=preserve keeps a remote prior when no stand-in exists', async () => {
  const prior = {
    ref: 'https://cdn.example.com/util.js',
    url: 'https://cdn.example.com/util.js',
    source: 'cached remote body',
    size: 18,
    contentHash: 'abc',
    loadedAt: 1,
  };
  const cache = new Map();
  cache.set(`${SCRIPT_DIR}util.js`, Promise.resolve(fakeFailure()));
  const r = await attachFiles({
    scriptFileUrl: SCRIPT_URL,
    header: header(['require', 'https://cdn.example.com/util.js']),
    priorRequires: new Map([[prior.url, prior]]),
    priorResources: new Map(),
    recheck: 'preserve',
    fetchCache: cache,
    now: 2,
    localRoots: [SCRIPT_DIR],
  });
  assert.equal(r.requires[0].source, 'cached remote body');
  assert.equal(r.requires[0].loadedAt, 1);
});

test('attachFiles: @resource takes stand-ins under the same rule', async () => {
  const cache = new Map();
  cache.set(`${SCRIPT_DIR}style.css`, Promise.resolve(fakeFetched('body{}', 'text/css')));
  const r = await attachFiles({
    scriptFileUrl: SCRIPT_URL,
    header: header(['resource', 'css https://cdn.example.com/style.css']),
    priorRequires: new Map(),
    priorResources: new Map(),
    recheck: 'all',
    fetchCache: cache,
    now: 1,
    localRoots: [SCRIPT_DIR],
  });
  assert.equal(r.errorMessage, undefined);
  assert.equal(r.resources[0].localUrl, `${SCRIPT_DIR}style.css`);
});

// The `.js` gate runs on the DECLARED URL, before any stand-in is
// considered, so a local file can't sneak past it.
test('attachFiles: a non-.js @require is rejected before any stand-in is tried', async () => {
  const cache = new Map();
  cache.set(`${SCRIPT_DIR}lib.json`, Promise.resolve(fakeFetched('{}')));
  const r = await attachFiles({
    scriptFileUrl: SCRIPT_URL,
    header: header(['require', 'https://cdn.example.com/lib.json']),
    priorRequires: new Map(),
    priorResources: new Map(),
    recheck: 'all',
    fetchCache: cache,
    now: 1,
    localRoots: [SCRIPT_DIR],
  });
  assert.match(r.errorMessage ?? '', /must end in \.js/);
});

// Without roots the pipeline behaves exactly as it did before this
// feature existed — the seeded local file is never even looked at.
test('attachFiles: no localRoots means no substitution', async () => {
  const cache = new Map();
  cache.set(`${SCRIPT_DIR}util.js`, Promise.resolve(fakeFetched('local body')));
  cache.set('https://cdn.example.com/util.js', Promise.resolve(fakeFetched('remote body')));
  const r = await attachFiles({
    scriptFileUrl: SCRIPT_URL,
    header: header(['require', 'https://cdn.example.com/util.js']),
    priorRequires: new Map(),
    priorResources: new Map(),
    recheck: 'all',
    fetchCache: cache,
    now: 1,
  });
  assert.equal(r.requires[0].source, 'remote body');
});

// ---------- sourceUsesLocalFiles ----------

// Only an explicit `false` disables it, so rows persisted before the
// field existed read as enabled.
test('sourceUsesLocalFiles: absent means enabled', () => {
  assert.equal(sourceUsesLocalFiles({}), true);
  assert.equal(sourceUsesLocalFiles({ localFiles: undefined }), true);
  assert.equal(sourceUsesLocalFiles({ localFiles: true }), true);
  assert.equal(sourceUsesLocalFiles({ localFiles: false }), false);
});

// ---------- localFileLogMessages ----------
//
// Substitution must never be silent, but it must also not be noisy —
// the same stand-in re-read unchanged on dozens of opportunistic
// refreshes has to say nothing.

const req = (over = {}) => ({
  ref: 'https://cdn.example.com/util.js',
  url: 'https://cdn.example.com/util.js',
  source: 'x',
  size: 1,
  contentHash: 'h1',
  loadedAt: 1,
  ...over,
});
const res = (over = {}) => ({
  name: 'data',
  ref: 'https://cdn.example.com/util.js',
  url: 'https://cdn.example.com/util.js',
  bytesBase64: '',
  size: 1,
  contentType: '',
  contentHash: 'h1',
  loadedAt: 1,
  ...over,
});

test('localFileLogMessages: a new stand-in is announced', () => {
  const next = { requires: [req({ localUrl: 'file:///s/util.js' })] };
  assert.deepEqual(localFileLogMessages(undefined, next), [
    '@require https://cdn.example.com/util.js is loading from file:///s/util.js',
  ]);
});

test('localFileLogMessages: an unchanged stand-in is silent', () => {
  const entry = req({ localUrl: 'file:///s/util.js' });
  assert.deepEqual(localFileLogMessages({ requires: [entry] }, { requires: [entry] }), []);
});

test('localFileLogMessages: an edited stand-in is announced again', () => {
  const before = req({ localUrl: 'file:///s/util.js' });
  const after = req({ localUrl: 'file:///s/util.js', contentHash: 'h2' });
  assert.equal(localFileLogMessages({ requires: [before] }, { requires: [after] }).length, 1);
});

test('localFileLogMessages: losing the stand-in is announced', () => {
  const before = req({ localUrl: 'file:///s/util.js' });
  assert.deepEqual(localFileLogMessages({ requires: [before] }, { requires: [req()] }), [
    '@require https://cdn.example.com/util.js is no longer loading from a local file',
  ]);
});

// A `@require` and a `@resource` may point at the same URL — they share
// one fetch by design. Keyed by URL alone, the require's prior lookup
// would return the resource's record on a last-write-wins basis.
test('localFileLogMessages: a require and a resource at one URL do not collide', () => {
  const prior = {
    requires: [req()],                                   // no stand-in
    resources: [res({ localUrl: 'file:///s/util.js' })], // stand-in
  };
  const next = {
    requires: [req()],
    resources: [res({ localUrl: 'file:///s/util.js' })],
  };
  // Nothing moved for either kind, so nothing is said. Under a shared
  // map the require would read the resource's record and report a
  // stand-in it never had.
  assert.deepEqual(localFileLogMessages(prior, next), []);
});

// Two `@resource` names may share one URL (deliberately — each name
// gets its own entry). Both entries would otherwise emit the same line.
test('localFileLogMessages: duplicate-URL resources emit one line', () => {
  const next = {
    resources: [
      res({ name: 'a', localUrl: 'file:///s/util.js' }),
      res({ name: 'b', localUrl: 'file:///s/util.js' }),
    ],
  };
  assert.deepEqual(localFileLogMessages(undefined, next), [
    '@resource https://cdn.example.com/util.js is loading from file:///s/util.js',
  ]);
});

// Display transforms apply here too: the hash tail is dropped and
// percent-escapes decoded.
test('localFileLogMessages: the ref is SRI-stripped and unescaped', () => {
  const next = {
    requires: [req({
      ref: 'https://cdn.example.com/my%20lib/util.js#md5=c45f9b0d19ba69bb2d44918746c4d7ae',
      url: 'https://cdn.example.com/my%20lib/util.js',
      localUrl: 'file:///s/my%20lib/util.js',
    })],
  };
  assert.deepEqual(localFileLogMessages(undefined, next), [
    '@require https://cdn.example.com/my lib/util.js is loading from file:///s/my lib/util.js',
  ]);
});
