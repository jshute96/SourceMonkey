// Tests for the pure helpers in src/script-store.ts. The storage I/O
// layer (chrome.storage.local) is not exercised here — those functions
// are thin wrappers around the helpers tested below.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  distillMatching,
  validateHeader,
  buildScriptFromText,
  applyFetchError,
  applyMissing,
  buildInitialErrorEntry,
  fetchOrSkipInParallel,
  rebuildSource,
} from '../../dist/script-store.js';
import { parseHeader } from '../../dist/userscript-header.js';

const VALID_SCRIPT = `// ==UserScript==
// @name        Hello
// @match       https://example.com/*
// @match       https://example.org/*
// @exclude     https://example.com/admin/*
// @grant       none
// ==/UserScript==
console.log('hi');
`;

const MISSING_NAME = `// ==UserScript==
// @match       https://example.com/*
// ==/UserScript==
console.log('no name');
`;

const NO_BLOCK = "console.log('no metadata block at all');\n";

const NO_MATCH = `// ==UserScript==
// @name        Just A Name
// ==/UserScript==
`;

// ---------- distillMatching ----------

test('distillMatching returns empty lists for a null header', () => {
  assert.deepEqual(distillMatching(null), {
    matches: [],
    excludes: [],
    includes: [],
  });
});

test('distillMatching pulls every @match / @exclude / @include', () => {
  const header = parseHeader(`// ==UserScript==
// @match    https://a.com/*
// @match    https://b.com/*
// @include  https://c.com/*
// @exclude  https://a.com/admin/*
// ==/UserScript==
`);
  assert.deepEqual(distillMatching(header), {
    matches: ['https://a.com/*', 'https://b.com/*'],
    excludes: ['https://a.com/admin/*'],
    includes: ['https://c.com/*'],
  });
});

// ---------- validateHeader ----------

test('validateHeader is OK for @name + @match', () => {
  assert.equal(validateHeader(parseHeader(VALID_SCRIPT)), null);
});

test('validateHeader is OK for @name + @include', () => {
  const header = parseHeader(`// ==UserScript==
// @name      Foo
// @include   https://example.com/*
// ==/UserScript==
`);
  assert.equal(validateHeader(header), null);
});

test('validateHeader complains about a missing @name', () => {
  assert.equal(validateHeader(parseHeader(MISSING_NAME)), 'missing @name');
});

test('validateHeader complains about no matching patterns', () => {
  assert.equal(
    validateHeader(parseHeader(NO_MATCH)),
    'missing @match or @include',
  );
});

test('validateHeader complains about a null header', () => {
  assert.equal(validateHeader(null), 'no metadata block');
});

// ---------- buildScriptFromText ----------

const COMMON = {
  id: 'sc-1',
  sourceId: 'src-1',
  relativePath: 'a.user.js',
  fileUrl: 'file:///dir/a.user.js',
  now: 1700000000000,
};

test('buildScriptFromText produces an OK entry for a valid script', () => {
  const entry = buildScriptFromText({ ...COMMON, source: VALID_SCRIPT });
  assert.equal(entry.status, 'ok');
  assert.equal(entry.errorMessage, undefined);
  assert.equal(entry.id, COMMON.id);
  assert.equal(entry.sourceId, COMMON.sourceId);
  assert.equal(entry.relativePath, COMMON.relativePath);
  assert.equal(entry.fileUrl, COMMON.fileUrl);
  assert.equal(entry.size, new TextEncoder().encode(VALID_SCRIPT).length);
  assert.equal(entry.loadedAt, COMMON.now);
  assert.match(entry.headerText, /==UserScript==/);
  assert.match(entry.headerText, /==\/UserScript==/);
  assert.equal(entry.bodyText, "console.log('hi');\n");
  assert.ok(entry.header);
  assert.deepEqual(entry.matching, {
    matches: ['https://example.com/*', 'https://example.org/*'],
    excludes: ['https://example.com/admin/*'],
    includes: [],
  });
});

test('buildScriptFromText reports a missing metadata block', () => {
  const entry = buildScriptFromText({ ...COMMON, source: NO_BLOCK });
  assert.equal(entry.status, 'error');
  assert.equal(entry.errorMessage, 'no metadata block');
  assert.equal(entry.headerText, '');
  assert.equal(entry.bodyText, NO_BLOCK);
  assert.equal(entry.header, null);
});

test('buildScriptFromText reports an unterminated metadata block', () => {
  const broken = '// ==UserScript==\n// @name Foo\nconsole.log("oops");\n';
  const entry = buildScriptFromText({ ...COMMON, source: broken });
  assert.equal(entry.status, 'error');
  assert.equal(entry.errorMessage, 'unterminated metadata block');
});

test('buildScriptFromText reports a missing required field', () => {
  const entry = buildScriptFromText({ ...COMMON, source: MISSING_NAME });
  assert.equal(entry.status, 'error');
  assert.equal(entry.errorMessage, 'missing @name');
  // Even on validation failure we still record what was parsed so the
  // viewer can show the partial header.
  assert.ok(entry.header);
  assert.deepEqual(entry.matching.matches, ['https://example.com/*']);
});

// ---------- applyFetchError / applyMissing / buildInitialErrorEntry ----------

test('applyFetchError preserves content and flips status', () => {
  const ok = buildScriptFromText({ ...COMMON, source: VALID_SCRIPT });
  const errored = applyFetchError(ok, 'permission denied');
  assert.equal(errored.status, 'error');
  assert.equal(errored.errorMessage, 'permission denied');
  assert.equal(errored.headerText, ok.headerText);
  assert.equal(errored.bodyText, ok.bodyText);
  assert.equal(errored.size, ok.size);
  assert.equal(errored.loadedAt, ok.loadedAt);
});

test('applyMissing nulls size, clears errorMessage, and preserves content', () => {
  const ok = buildScriptFromText({ ...COMMON, source: VALID_SCRIPT });
  const errored = applyFetchError(ok, 'read failed');
  const missing = applyMissing(errored);
  assert.equal(missing.status, 'missing');
  assert.equal(missing.size, null);
  assert.equal(missing.errorMessage, undefined);
  assert.equal(missing.headerText, ok.headerText);
  assert.equal(missing.bodyText, ok.bodyText);
});

test('applyMissing disables the script so a vanished file stops running', () => {
  // The directory-level Refresh promotes vanished files to missing;
  // we want them silently stopped, not still injected from cached
  // content. The user has to manually re-enable if the file returns.
  const ok = buildScriptFromText({ ...COMMON, source: VALID_SCRIPT });
  assert.equal(ok.enabled, true);
  assert.equal(applyMissing(ok).enabled, false);
});

test('buildInitialErrorEntry leaves content empty', () => {
  const entry = buildInitialErrorEntry({
    id: 'sc-2',
    sourceId: 'src-1',
    relativePath: 'b.user.js',
    fileUrl: 'file:///dir/b.user.js',
    errorMessage: 'read failed',
    now: 42,
  });
  assert.equal(entry.status, 'error');
  assert.equal(entry.errorMessage, 'read failed');
  assert.equal(entry.size, null);
  assert.equal(entry.headerText, '');
  assert.equal(entry.bodyText, '');
  assert.equal(entry.header, null);
  assert.deepEqual(entry.matching, { matches: [], excludes: [], includes: [] });
});

// ---------- rebuildSource ----------

function fakeIdSequence() {
  let n = 0;
  return () => `id-${++n}`;
}

test('rebuildSource assigns new IDs to brand-new scripts', () => {
  const result = rebuildSource({
    sourceId: 'src-1',
    sourcePath: '/dir',
    existing: [],
    scan: [{ relativePath: 'a.user.js' }, { relativePath: 'b.user.js' }],
    fetchResults: new Map([
      ['a.user.js', { ok: true, source: VALID_SCRIPT }],
      ['b.user.js', { ok: true, source: VALID_SCRIPT }],
    ]),
    now: 100,
    newId: fakeIdSequence(),
  });
  assert.equal(result.length, 2);
  assert.deepEqual(result.map((s) => s.id), ['id-1', 'id-2']);
  assert.deepEqual(result.map((s) => s.relativePath), ['a.user.js', 'b.user.js']);
  for (const s of result) assert.equal(s.status, 'ok');
});

test('rebuildSource reuses IDs for known relativePaths', () => {
  const existing = [
    buildScriptFromText({
      id: 'pre-existing-id',
      sourceId: 'src-1',
      relativePath: 'a.user.js',
      fileUrl: 'file:///dir/a.user.js',
      source: VALID_SCRIPT,
      now: 50,
    }),
  ];
  const result = rebuildSource({
    sourceId: 'src-1',
    sourcePath: '/dir',
    existing,
    scan: [{ relativePath: 'a.user.js' }, { relativePath: 'b.user.js' }],
    fetchResults: new Map([
      ['a.user.js', { ok: true, source: VALID_SCRIPT }],
      ['b.user.js', { ok: true, source: VALID_SCRIPT }],
    ]),
    now: 100,
    newId: fakeIdSequence(),
  });
  assert.equal(result[0].id, 'pre-existing-id');
  assert.equal(result[1].id, 'id-1');
});

test('rebuildSource flags vanished scripts as missing and keeps their content', () => {
  const existing = [
    buildScriptFromText({
      id: 'a-id',
      sourceId: 'src-1',
      relativePath: 'a.user.js',
      fileUrl: 'file:///dir/a.user.js',
      source: VALID_SCRIPT,
      now: 50,
    }),
    buildScriptFromText({
      id: 'b-id',
      sourceId: 'src-1',
      relativePath: 'b.user.js',
      fileUrl: 'file:///dir/b.user.js',
      source: VALID_SCRIPT,
      now: 50,
    }),
  ];
  const result = rebuildSource({
    sourceId: 'src-1',
    sourcePath: '/dir',
    existing,
    scan: [{ relativePath: 'a.user.js' }],
    fetchResults: new Map([
      ['a.user.js', { ok: true, source: VALID_SCRIPT }],
    ]),
    now: 100,
    newId: fakeIdSequence(),
  });
  assert.equal(result.length, 2);
  // Scan-order entries come first, then missing entries trailing.
  assert.equal(result[0].relativePath, 'a.user.js');
  assert.equal(result[0].status, 'ok');
  assert.equal(result[1].relativePath, 'b.user.js');
  assert.equal(result[1].status, 'missing');
  assert.equal(result[1].size, null);
  // Missing entry keeps the prior body so the viewer still works.
  assert.equal(result[1].bodyText, existing[1].bodyText);
});

test('rebuildSource preserves prior content when a fetch fails on a known script', () => {
  const existing = [
    buildScriptFromText({
      id: 'a-id',
      sourceId: 'src-1',
      relativePath: 'a.user.js',
      fileUrl: 'file:///dir/a.user.js',
      source: VALID_SCRIPT,
      now: 50,
    }),
  ];
  const result = rebuildSource({
    sourceId: 'src-1',
    sourcePath: '/dir',
    existing,
    scan: [{ relativePath: 'a.user.js' }],
    fetchResults: new Map([
      ['a.user.js', { ok: false, errorMessage: 'EACCES' }],
    ]),
    now: 100,
    newId: fakeIdSequence(),
  });
  assert.equal(result[0].status, 'error');
  assert.equal(result[0].errorMessage, 'EACCES');
  assert.equal(result[0].bodyText, existing[0].bodyText);
  assert.equal(result[0].loadedAt, existing[0].loadedAt); // unchanged
});

test('rebuildSource preserves the prior `enabled` flag across a successful refresh', () => {
  const existing = [
    {
      ...buildScriptFromText({
        id: 'a-id',
        sourceId: 'src-1',
        relativePath: 'a.user.js',
        fileUrl: 'file:///dir/a.user.js',
        source: VALID_SCRIPT,
        now: 50,
      }),
      enabled: false, // user disabled this script some time ago
    },
  ];
  const result = rebuildSource({
    sourceId: 'src-1',
    sourcePath: '/dir',
    existing,
    scan: [{ relativePath: 'a.user.js' }],
    fetchResults: new Map([
      ['a.user.js', { ok: true, source: VALID_SCRIPT }],
    ]),
    now: 100,
    newId: fakeIdSequence(),
  });
  assert.equal(result[0].enabled, false);
});

test('buildScriptFromText defaults `enabled` to true on a brand-new entry', () => {
  const entry = buildScriptFromText({ ...COMMON, source: VALID_SCRIPT });
  assert.equal(entry.enabled, true);
});

test('rebuildSource: unchanged marker preserves the prior entry and records fsMtime', () => {
  const prior = buildScriptFromText({
    id: 'a-id',
    sourceId: 'src-1',
    relativePath: 'a.user.js',
    fileUrl: 'file:///dir/a.user.js',
    source: VALID_SCRIPT,
    now: 50,
  });
  const result = rebuildSource({
    sourceId: 'src-1',
    sourcePath: '/dir',
    existing: [prior],
    scan: [{ relativePath: 'a.user.js', size: prior.size, mtime: 1700 }],
    fetchResults: new Map([
      ['a.user.js', { unchanged: true }],
    ]),
    now: 999,
    newId: fakeIdSequence(),
  });
  assert.equal(result.length, 1);
  // Content + status preserved verbatim — no re-parse, no loadedAt bump.
  assert.equal(result[0].status, 'ok');
  assert.equal(result[0].loadedAt, prior.loadedAt);
  assert.equal(result[0].bodyText, prior.bodyText);
  // fsMtime captured from the listing for the next refresh's skip check.
  assert.equal(result[0].fsMtime, 1700);
});

test('rebuildSource: successful fetch stores fsMtime from the scan', () => {
  const result = rebuildSource({
    sourceId: 'src-1',
    sourcePath: '/dir',
    existing: [],
    scan: [{ relativePath: 'a.user.js', size: 100, mtime: 4200 }],
    fetchResults: new Map([
      ['a.user.js', { ok: true, source: VALID_SCRIPT }],
    ]),
    now: 100,
    newId: fakeIdSequence(),
  });
  assert.equal(result[0].fsMtime, 4200);
});

test('rebuildSource: missing path also disables the entry', () => {
  // Mirrors applyMissing's behavior end-to-end via rebuildSource.
  const existing = [
    buildScriptFromText({
      id: 'a-id', sourceId: 'src-1', relativePath: 'a.user.js',
      fileUrl: 'file:///dir/a.user.js', source: VALID_SCRIPT, now: 50,
    }),
  ];
  const result = rebuildSource({
    sourceId: 'src-1', sourcePath: '/dir',
    existing,
    scan: [],
    fetchResults: new Map(),
    now: 100,
    newId: fakeIdSequence(),
  });
  assert.equal(result[0].status, 'missing');
  assert.equal(result[0].enabled, false);
});

test('rebuildSource builds the right fileUrl for a single-file source', () => {
  // Single-file sources store the *file* path in sourcePath; the scan
  // entry's relativePath is the basename. scriptFileUrl must not
  // double the filename — it should return the source path's URL.
  const result = rebuildSource({
    sourceId: 'src-1',
    sourcePath: '/home/me/foo bar.user.js',
    existing: [],
    scan: [{ relativePath: 'foo bar.user.js' }],
    fetchResults: new Map([
      ['foo bar.user.js', { ok: true, source: VALID_SCRIPT }],
    ]),
    now: 100,
    newId: fakeIdSequence(),
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].fileUrl, 'file:///home/me/foo%20bar.user.js');
  assert.equal(result[0].relativePath, 'foo bar.user.js');
});

test('rebuildSource persists httpEtag / httpLastModified from a successful HTTP fetch', () => {
  // The next refresh will read these back off the prior row and send
  // them as If-None-Match / If-Modified-Since so the server can answer
  // 304. Without this round-trip, every refresh of an HTTP source
  // would redownload the body.
  const result = rebuildSource({
    sourceId: 'src-1',
    sourcePath: 'https://example.com/scripts/manifest.json',
    existing: [],
    scan: [{ relativePath: 'a.user.js' }],
    fetchResults: new Map([
      ['a.user.js', {
        ok: true,
        source: VALID_SCRIPT,
        httpEtag: 'W/"abc"',
        httpLastModified: 'Wed, 21 Oct 2025 07:28:00 GMT',
      }],
    ]),
    now: 100,
    newId: fakeIdSequence(),
  });
  assert.equal(result[0].httpEtag, 'W/"abc"');
  assert.equal(result[0].httpLastModified, 'Wed, 21 Oct 2025 07:28:00 GMT');
});

test('rebuildSource: HTTP unchanged preserves the prior entry and its validators', () => {
  // The HTTP path lands here when the server returned 304 to our
  // conditional GET. fsMtime stays unused (HTTP doesn't use it); the
  // etag/lastModified should not get cleared.
  const prior = {
    ...buildScriptFromText({
      id: 'a-id',
      sourceId: 'src-1',
      relativePath: 'a.user.js',
      fileUrl: 'https://example.com/scripts/a.user.js',
      source: VALID_SCRIPT,
      now: 50,
    }),
    httpEtag: 'W/"abc"',
    httpLastModified: 'Wed, 21 Oct 2025 07:28:00 GMT',
  };
  const result = rebuildSource({
    sourceId: 'src-1',
    sourcePath: 'https://example.com/scripts/manifest.json',
    existing: [prior],
    scan: [{ relativePath: 'a.user.js' }],
    fetchResults: new Map([
      ['a.user.js', { unchanged: true }],
    ]),
    now: 999,
    newId: fakeIdSequence(),
  });
  assert.equal(result[0].httpEtag, 'W/"abc"');
  assert.equal(result[0].httpLastModified, 'Wed, 21 Oct 2025 07:28:00 GMT');
  assert.equal(result[0].loadedAt, prior.loadedAt);
});

test('rebuildSource creates an initial error entry when a new file fails to fetch', () => {
  const result = rebuildSource({
    sourceId: 'src-1',
    sourcePath: '/dir',
    existing: [],
    scan: [{ relativePath: 'new.user.js' }],
    fetchResults: new Map([
      ['new.user.js', { ok: false, errorMessage: 'network' }],
    ]),
    now: 100,
    newId: fakeIdSequence(),
  });
  assert.equal(result[0].status, 'error');
  assert.equal(result[0].errorMessage, 'network');
  assert.equal(result[0].size, null);
  assert.equal(result[0].headerText, '');
  assert.equal(result[0].bodyText, '');
});

// ---------- fetchOrSkipInParallel: per-entry scheme dispatch ----------
//
// The core symmetry claim of the refactor: a manifest source can list
// entries that resolve to http(s):// AND file:// URLs, and each entry
// picks its fetch/skip strategy based on the RESOLVED URL's scheme —
// not the source's. The test below wires up a manifest with one of
// each and inspects what fetch sees.

function fakeResponse({ status, headers = {}, body = '' }) {
  const lowerHeaders = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    ok: status >= 200 && status < 300,
    type: 'basic',
    headers: { get: (k) => lowerHeaders.get(k.toLowerCase()) ?? null },
    text: async () => body,
  };
}

test('fetchOrSkipInParallel: mixed-scheme manifest dispatches per resolved entry URL', async () => {
  // Manifest source at https://x/m.json with two entries:
  //   - "foo.user.js"            → resolves to https://x/foo.user.js (HTTP)
  //   - "file:///etc/bar.user.js" → resolves to file:///etc/bar.user.js
  // The HTTP entry has a prior etag → fetch must include If-None-Match.
  // The file entry has no etag → fetch must NOT include conditional headers
  // (and must not get cache: no-store applied, which fetchHttpText sets).
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, init });
    if (url.startsWith('https://')) {
      // Simulate 304 to exercise the unchanged path.
      return fakeResponse({ status: 304 });
    }
    // file:// fetch returns body.
    return fakeResponse({ status: 200, body: 'console.log("local");' });
  };
  try {
    const priorHttp = {
      ...buildScriptFromText({
        id: 'h-id', sourceId: 'src-1', relativePath: 'foo.user.js',
        fileUrl: 'https://x/foo.user.js', source: VALID_SCRIPT, now: 1,
      }),
      httpEtag: 'W/"abc"',
    };
    const results = await fetchOrSkipInParallel(
      'https://x/m.json',  // manifest source
      [
        { relativePath: 'foo.user.js' },
        { relativePath: 'file:///etc/bar.user.js' },
      ],
      [priorHttp],
    );
    // HTTP entry → 304 → unchanged.
    const httpResult = results.get('foo.user.js');
    assert.ok(httpResult && 'unchanged' in httpResult,
      `expected unchanged for HTTP entry, got ${JSON.stringify(httpResult)}`);
    // file:// entry → fresh fetch with body.
    const fileResult = results.get('file:///etc/bar.user.js');
    assert.ok(fileResult && 'ok' in fileResult && fileResult.ok,
      `expected ok for file entry, got ${JSON.stringify(fileResult)}`);
    assert.equal(fileResult.source, 'console.log("local");');
    // Inspect the calls: HTTP one must carry If-None-Match; file one must not.
    const httpCall = calls.find((c) => String(c.url).startsWith('https://'));
    const fileCall = calls.find((c) => String(c.url).startsWith('file://'));
    assert.ok(httpCall, 'expected an HTTP fetch');
    assert.ok(fileCall, 'expected a file:// fetch');
    assert.equal(httpCall.init.headers?.['If-None-Match'], 'W/"abc"',
      'HTTP entry should replay prior ETag as If-None-Match');
    assert.equal(httpCall.init.cache, 'no-store',
      'HTTP fetch should use cache: no-store');
    // file:// path goes through fetchFileUrlText, which doesn't set
    // headers or cache options of its own.
    assert.equal(fileCall.init.headers, undefined);
    assert.equal(fileCall.init.cache, undefined);
  } finally {
    globalThis.fetch = original;
  }
});

test('applyMissing keeps HTTP validators dormant for later recovery', () => {
  // Documented behavior: a vanished script row preserves httpEtag /
  // httpLastModified even though they're unused while status is
  // 'missing'. If the entry later reappears, buildScriptFromText
  // overwrites the validators from the fresh response.
  const prior = {
    ...buildScriptFromText({
      id: 'h-id', sourceId: 'src-1', relativePath: 'a.user.js',
      fileUrl: 'https://x/a.user.js', source: VALID_SCRIPT, now: 1,
    }),
    httpEtag: 'W/"abc"',
    httpLastModified: 'Wed, 21 Oct 2025 07:28:00 GMT',
  };
  const missing = applyMissing(prior);
  assert.equal(missing.status, 'missing');
  assert.equal(missing.httpEtag, 'W/"abc"');
  assert.equal(missing.httpLastModified, 'Wed, 21 Oct 2025 07:28:00 GMT');
});
