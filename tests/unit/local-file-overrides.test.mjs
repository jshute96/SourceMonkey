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
  _setLocalRootsForTests,
  localFileCandidates,
  localSearchRoots,
  parseLocalRootLines,
  rootsFromText,
  sourceSupportsLocalFiles,
  textFromRoots,
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

// ---------- Configured roots ----------

// Each of these sets the module-level setting, so restore it after.
// Takes the paths a user would type; the stored form is the parsed
// array, so route them through the same parse the options page runs.
function withRoots(paths, fn) {
  try {
    // `?? []` so a case that deliberately passes a REJECTED root
    // lands as "no configured roots", which is the real behavior.
    _setLocalRootsForTests(rootsFromText(paths.join('\n')) ?? []);
    fn();
  } finally {
    _setLocalRootsForTests([]);
  }
}

test('localSearchRoots: configured roots follow the script\'s own folder', () => {
  withRoots(['/home/me/dev/lib', '/opt/shared'], () => {
    assert.deepEqual(localSearchRoots(SCRIPT_URL, true), [
      SCRIPT_DIR,
      'file:///home/me/dev/lib/',
      'file:///opt/shared/',
    ]);
  });
});

// The own-folder root is the one that must win, so listing it globally
// too should not produce a duplicate (and a duplicated probe).
test('localSearchRoots: a configured root equal to the script folder is not repeated', () => {
  withRoots(['/home/me/scripts'], () => {
    assert.deepEqual(localSearchRoots(SCRIPT_URL, true), [SCRIPT_DIR]);
  });
});

// The gate covers configured roots too: an http(s)-hosted script gets
// nothing, however many roots are set.
test('localSearchRoots: configured roots do not apply to an http-loaded script', () => {
  withRoots(['/home/me/dev/lib'], () => {
    assert.deepEqual(localSearchRoots('https://example.com/foo.user.js', true), []);
  });
});

test('localSearchRoots: the per-source opt-out also disables configured roots', () => {
  withRoots(['/home/me/dev/lib'], () => {
    assert.deepEqual(localSearchRoots(SCRIPT_URL, false), []);
  });
});

test('parseLocalRootLines: blank lines are dropped, order is kept', () => {
  const got = parseLocalRootLines('/a\n\n  \n/b\n');
  assert.deepEqual(got.map((r) => r.url), ['file:///a/', 'file:///b/']);
  // Line numbers stay 1-based against the ORIGINAL text, so an error
  // points at the line the user is looking at.
  assert.deepEqual(got.map((r) => r.lineNumber), [1, 4]);
});

test('parseLocalRootLines: accepts file:// URLs and percent-encodes typed paths', () => {
  assert.equal(parseLocalRootLines('file:///a/b/').at(0).url, 'file:///a/b/');
  assert.equal(parseLocalRootLines('file:///a/b').at(0).url, 'file:///a/b/');
  assert.equal(parseLocalRootLines('/my dev/lib').at(0).url, 'file:///my%20dev/lib/');
});

// `..` a user typed is resolved at parse time, so the stored root is
// the directory it actually names — candidates are matched against the
// resolved form.
test('parseLocalRootLines: resolves . and .. in a typed root', () => {
  assert.equal(parseLocalRootLines('/home/me/dev/../lib').at(0).url, 'file:///home/me/lib/');
});

test('parseLocalRootLines: rejects relative paths and http URLs', () => {
  for (const bad of ['dev/lib', '~/dev', 'https://example.com/lib', 'C:\\lib']) {
    const entry = parseLocalRootLines(bad).at(0);
    assert.equal(entry.url, undefined, bad);
    assert.match(entry.error, /^A local file root must be an absolute path/, bad);
  }
});

// The root is the floor every containment check measures against, so it
// has to be at least as clean as the candidates built on top of it.
test('parseLocalRootLines: rejects roots that would not name a real directory', () => {
  const bad = [
    // A fragment or query is stripped before the filesystem sees it, so
    // every candidate under such a root would read the SAME file — and
    // the directory probe would accept a plain file.
    'file:///a/b#frag',
    'file:///a/b?q=1',
    // An encoded separator survives the URL parser but may not survive
    // the conversion to a path, putting the real floor above the stated
    // one. Only reachable via the file:// form — see the next test.
    'file:///a/..%2f..%2fetc',
    'file:///a/..%5c..%5cetc',
    // A host is not a local absolute path.
    'file://host/share',
  ];
  for (const root of bad) {
    assert.equal(parseLocalRootLines(root).at(0).url, undefined, root);
  }
  assert.equal(rootsFromText(bad.join('\n')), null);
});

// A typed PATH can't smuggle an encoded separator: `pathToFileUrl`
// percent-encodes each segment, so a literal `%2f` becomes `%252f` and
// names a directory actually called `..%2f..`. Documented because it is
// why the guard above only ever fires on the file:// form.
test('parseLocalRootLines: a typed path containing %2f is escaped, not rejected', () => {
  assert.equal(
    parseLocalRootLines('/a/..%2f..%2fetc').at(0).url,
    'file:///a/..%252f..%252fetc/',
  );
});

// The same rejection has to hold once the root reaches the resolver:
// nothing may be generated under a root that never parsed.
test('localSearchRoots: a rejected root never reaches the search list', () => {
  withRoots(['file:///a/b#frag'], () => {
    assert.deepEqual(localSearchRoots(SCRIPT_URL, true), [SCRIPT_DIR]);
  });
});

// The stored setting is the PARSED array, so text that doesn't fully
// parse must not produce one — null is what disables the Save button.
test('rootsFromText: all-or-nothing, so a bad line blocks the save', () => {
  assert.deepEqual(rootsFromText('/a\n/b'), ['file:///a/', 'file:///b/']);
  assert.equal(rootsFromText('/a\nnot-a-path\n/b'), null);
  assert.deepEqual(rootsFromText(''), []);
});

// Round-trip: what the box shows after a save re-parses to the same
// array, so re-saving an untouched box is a no-op.
test('textFromRoots: round-trips through rootsFromText', () => {
  const roots = rootsFromText('/home/me/dev\n/my dev/lib');
  assert.deepEqual(rootsFromText(textFromRoots(roots)), roots);
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
