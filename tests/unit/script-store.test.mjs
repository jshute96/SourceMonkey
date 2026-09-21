// Tests for the pure helpers in src/script-store.ts. The storage I/O
// layer (chrome.storage.local) is not exercised here — those functions
// are thin wrappers around the helpers tested below.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  IMPLICIT_UNSAFE_WINDOW_INFO,
  backfillUsesUnsafeWindow,
  distillMatching,
  extractStartupLogs,
  validateHeader,
  buildScriptFromText,
  applyFetchError,
  buildInitialInvalidEntry,
  fetchOrSkipInParallel,
  hashSource,
  loadStateLogEntry,
  rebuildCollection,
  sameStoredValue,
  NO_MATCH_OR_INCLUDE,
  NO_NAME,
} from '../../dist/script-store.js';
import {
  parseHeader,
  NO_METADATA_BLOCK,
  UNTERMINATED_METADATA_BLOCK,
} from '../../dist/userscript-header.js';

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

test('distillMatching returns empty lists for a null header', async () => {
  assert.deepEqual(distillMatching(null), {
    matches: [],
    excludes: [],
    includes: [],
  });
});

test('distillMatching pulls every @match / @exclude / @include', async () => {
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

test('validateHeader is OK for @name + @match', async () => {
  assert.equal(validateHeader(parseHeader(VALID_SCRIPT)), null);
});

test('validateHeader is OK for @name + @include', async () => {
  const header = parseHeader(`// ==UserScript==
// @name      Foo
// @include   https://example.com/*
// ==/UserScript==
`);
  assert.equal(validateHeader(header), null);
});

// Each of these is about a tag that ISN'T in the block, so none has a
// line of its own — they all point at the `// ==UserScript==` marker,
// which is the block the missing tag belongs in.
test('validateHeader complains about a missing @name', async () => {
  assert.deepEqual(validateHeader(parseHeader(MISSING_NAME)), {
    message: NO_NAME,
    line: 1,
  });
});

test('validateHeader complains about no matching patterns', async () => {
  assert.deepEqual(validateHeader(parseHeader(NO_MATCH)), {
    message: NO_MATCH_OR_INCLUDE,
    line: 1,
  });
});

test('validateHeader complains about a null header', async () => {
  // No block at all: the whole file is the answer, so no line.
  assert.deepEqual(validateHeader(null), { message: NO_METADATA_BLOCK });
});

// A `@match` Chrome's grammar refuses is dropped, not run — so a script
// with nothing else to match on is in the same position as one that
// declared no pattern at all. Unlike the failures above, the offending
// text IS in the file, so this one points at its own line.
test('validateHeader rejects a script whose every @match is unusable', async () => {
  const problem = validateHeader(parseHeader(`// ==UserScript==
// @name  X
// @match https://example.com
// @match https://other.example
// ==/UserScript==
`));
  assert.match(problem.message, /@match https:\/\/example\.com has no path/);
  assert.match(problem.message, /never run on any page/);
  assert.equal(problem.line, 3);
});

test('validateHeader accepts a script with one good @match beside a bad one', async () => {
  // The bad pattern is a warning (see extractStartupLogs); the script
  // still runs everywhere the good one says.
  assert.equal(validateHeader(parseHeader(`// ==UserScript==
// @name  X
// @match https://example.com
// @match https://example.com/*
// ==/UserScript==
`)), null);
});

test('validateHeader accepts unusable @match when an @include can still match', async () => {
  assert.equal(validateHeader(parseHeader(`// ==UserScript==
// @name    X
// @match   https://example.com
// @include https://example.com/*
// ==/UserScript==
`)), null);
});

// ---------- extractStartupLogs ----------

test('extractStartupLogs returns [] for a null header', () => {
  assert.deepEqual(extractStartupLogs(null, 'x.user.js'), []);
});

test('extractStartupLogs returns [] when every @grant is in the catalog', () => {
  const header = parseHeader(`// ==UserScript==
// @name X
// @match https://e/*
// @grant GM_setValue
// @grant GM_getValue
// ==/UserScript==
`);
  assert.deepEqual(extractStartupLogs(header, 'x.user.js'), []);
});

test('extractStartupLogs returns [] when there are no @grant lines at all', () => {
  // No @grant ≠ unknown @grant. The path that resolves grants only
  // fires when at least one @grant line was declared, so a script
  // without any grants is silent.
  const header = parseHeader(VALID_SCRIPT);
  assert.deepEqual(extractStartupLogs(header, 'x.user.js'), []);
});

test('extractStartupLogs emits a warn entry naming each unknown @grant in declaration order', () => {
  const header = parseHeader(`// ==UserScript==
// @name X
// @match https://e/*
// @grant GM_setValue
// @grant GM_webRequest
// @grant GM_audio
// ==/UserScript==
`);
  // Located at the FIRST unknown grant's line (@grant GM_webRequest on
  // line 5), not at the first @grant line — that one is fine.
  assert.deepEqual(extractStartupLogs(header, 'x.user.js'), [
    {
      level: 'warn',
      message: 'Ignoring @grant GM_webRequest, GM_audio — unsupported APIs',
      location: { file: 'x.user.js', line: 5 },
    },
  ]);
});

test('extractStartupLogs names the near miss when a @grant is only mis-cased', () => {
  // Matching stays byte-exact (TM/VM both do), so `GM_xmlHttpRequest`
  // is still dropped — but the warning says what the author meant.
  const header = parseHeader(`// ==UserScript==
// @name X
// @match https://e/*
// @grant GM_xmlHttpRequest
// @grant GM_audio
// ==/UserScript==
`);
  assert.deepEqual(extractStartupLogs(header, 'x.user.js'), [
    {
      level: 'warn',
      message:
        'Ignoring @grant GM_xmlHttpRequest (did you mean GM_xmlhttpRequest?), GM_audio — unsupported APIs',
      location: { file: 'x.user.js', line: 4 },
    },
  ]);
});

test('extractStartupLogs is silent for the rewrite-form GM. spellings', () => {
  // `GM.xmlhttpRequest` / `GM.getResourceURL` are accepted names, not
  // near misses — nothing to warn about.
  const header = parseHeader(`// ==UserScript==
// @name X
// @match https://e/*
// @grant GM.xmlhttpRequest
// @grant GM.getResourceURL
// ==/UserScript==
`);
  assert.deepEqual(extractStartupLogs(header), []);
});

test('extractStartupLogs surfaces unknown names even when @grant none also appears', () => {
  // `@grant none` plus a typo is a useful case to flag — the script
  // author probably meant to grant the typo'd API, and @grant none is
  // either stale or a copy-paste mistake.
  const header = parseHeader(`// ==UserScript==
// @name X
// @match https://e/*
// @grant none
// @grant GM_typo
// ==/UserScript==
`);
  assert.deepEqual(extractStartupLogs(header, 'x.user.js'), [
    {
      level: 'warn',
      message: 'Ignoring @grant GM_typo — unsupported APIs',
      location: { file: 'x.user.js', line: 5 },
    },
  ]);
});

test('extractStartupLogs warns once per unusable @match, each on its own line', () => {
  // One row per bad pattern rather than one naming them all: each has a
  // different reason and a different line, and a single row could only
  // point at one of them.
  const header = parseHeader(`// ==UserScript==
// @name X
// @match https://good.example/*
// @match https://bare.example
// @match httpx://other.example/*
// ==/UserScript==
`);
  assert.deepEqual(extractStartupLogs(header, 'x.user.js'), [
    {
      level: 'warn',
      message: 'Ignoring @match https://bare.example — it has no path; '
        + 'add a trailing "/*" to match all pages on that host',
      location: { file: 'x.user.js', line: 4 },
    },
    {
      level: 'warn',
      message: 'Ignoring @match httpx://other.example/* — it names the unsupported '
        + 'scheme "httpx"; use one of *, http, https, file, ftp ("*" covers http and https)',
      location: { file: 'x.user.js', line: 5 },
    },
  ]);
});

// ---------- buildScriptFromText ----------

const COMMON = {
  id: 'sc-1',
  collectionId: 'src-1',
  relativePath: 'a.user.js',
  fileUrl: 'file:///dir/a.user.js',
  now: 1700000000000,
};

test('buildScriptFromText produces an OK entry for a valid script', async () => {
  const entry = await buildScriptFromText({ ...COMMON, text: VALID_SCRIPT });
  assert.equal(entry.status, 'ok');
  assert.equal(entry.errorMessage, undefined);
  assert.equal(entry.id, COMMON.id);
  assert.equal(entry.collectionId, COMMON.collectionId);
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
  // No unknown @grant entries — startupLogs should be absent so the
  // persisted row stays minimal.
  assert.equal(entry.startupLogs, undefined);
});

test('buildScriptFromText attaches startupLogs when the header has unknown @grant names', async () => {
  const src = `// ==UserScript==
// @name X
// @match https://e/*
// @grant GM_setValue
// @grant GM_typoName
// ==/UserScript==
console.log('hi');
`;
  const entry = await buildScriptFromText({ ...COMMON, text: src });
  assert.equal(entry.status, 'ok');
  assert.deepEqual(entry.startupLogs, [
    {
      level: 'warn',
      message: 'Ignoring @grant GM_typoName — unsupported APIs',
      location: { file: 'a.user.js', line: 5 },
    },
  ]);
});

test('buildScriptFromText omits startupLogs on error rows even if the header would have flagged unknown grants', async () => {
  // Errors don't run, so persisting the diagnostics would be dead
  // bytes. Confirm we don't attach them when status !== 'ok'.
  const src = `// ==UserScript==
// @grant GM_typoName
// ==/UserScript==
body
`;
  const entry = await buildScriptFromText({ ...COMMON, text: src });
  assert.equal(entry.status, 'invalid');
  assert.equal(entry.startupLogs, undefined);
});

test('buildScriptFromText reports a missing metadata block', async () => {
  const entry = await buildScriptFromText({ ...COMMON, text: NO_BLOCK });
  assert.equal(entry.status, 'invalid');
  assert.equal(entry.errorMessage, NO_METADATA_BLOCK);
  assert.equal(entry.headerText, '');
  assert.equal(entry.bodyText, NO_BLOCK);
  assert.equal(entry.header, null);
});

test('buildScriptFromText reports an unterminated metadata block', async () => {
  const broken = '// ==UserScript==\n// @name Foo\nconsole.log("oops");\n';
  const entry = await buildScriptFromText({ ...COMMON, text: broken });
  assert.equal(entry.status, 'invalid');
  assert.equal(entry.errorMessage, UNTERMINATED_METADATA_BLOCK);
});

test('buildScriptFromText reports a missing required field', async () => {
  const entry = await buildScriptFromText({ ...COMMON, text: MISSING_NAME });
  assert.equal(entry.status, 'invalid');
  assert.equal(entry.errorMessage, NO_NAME);
  // Even on validation failure we still record what was parsed so the
  // viewer can show the partial header.
  assert.ok(entry.header);
  assert.deepEqual(entry.matching.matches, ['https://example.com/*']);
});

// ---------- applyFetchError / buildInitialInvalidEntry ----------
//
// `applyFetchError` is named for the trigger (a hard fetch failure). A
// prior `ok` row keeps running (`status: 'ok'` + `refreshError`) so a
// transient logout / network blip never silently disables a working
// script; a prior non-ok row flips to `'invalid'`.

test('applyFetchError keeps a prior-ok row running with refreshError', async () => {
  const ok = await buildScriptFromText({ ...COMMON, text: VALID_SCRIPT });
  const errored = applyFetchError(ok, 'permission denied');
  // Still OK and injectable — we have a last-known-good copy.
  assert.equal(errored.status, 'ok');
  assert.equal(errored.refreshError, 'permission denied');
  assert.equal(errored.errorMessage, undefined);
  assert.equal(errored.headerText, ok.headerText);
  assert.equal(errored.bodyText, ok.bodyText);
  assert.equal(errored.size, ok.size);
  assert.equal(errored.loadedAt, ok.loadedAt);
});

test('applyFetchError flips a prior non-ok row to invalid', async () => {
  // No good copy to protect (the row was already invalid) → the fetch
  // failure is recorded as invalid with the message, as before.
  const ok = await buildScriptFromText({ ...COMMON, text: VALID_SCRIPT });
  const alreadyInvalid = { ...ok, status: 'invalid', errorMessage: 'prior' };
  const errored = applyFetchError(alreadyInvalid, 'EACCES');
  assert.equal(errored.status, 'invalid');
  assert.equal(errored.errorMessage, 'EACCES');
  assert.equal(errored.refreshError, undefined);
});

test('buildInitialInvalidEntry leaves content empty', async () => {
  const entry = buildInitialInvalidEntry({
    id: 'sc-2',
    collectionId: 'src-1',
    relativePath: 'b.user.js',
    fileUrl: 'file:///dir/b.user.js',
    errorMessage: 'read failed',
    now: 42,
  });
  assert.equal(entry.status, 'invalid');
  assert.equal(entry.errorMessage, 'read failed');
  assert.equal(entry.size, null);
  assert.equal(entry.headerText, '');
  assert.equal(entry.bodyText, '');
  assert.equal(entry.header, null);
  assert.deepEqual(entry.matching, { matches: [], excludes: [], includes: [] });
});

// ---------- rebuildCollection ----------

function fakeIdSequence() {
  let n = 0;
  return () => `id-${++n}`;
}

test('rebuildCollection assigns new IDs to brand-new scripts', async () => {
  const result = await rebuildCollection({
    collectionId: 'src-1',
    collectionPath: '/dir',
    existing: [],
    scan: [{ relativePath: 'a.user.js' }, { relativePath: 'b.user.js' }],
    fetchResults: new Map([
      ['a.user.js', { ok: true, text: VALID_SCRIPT }],
      ['b.user.js', { ok: true, text: VALID_SCRIPT }],
    ]),
    now: 100,
    newId: fakeIdSequence(),
  });
  assert.equal(result.length, 2);
  assert.deepEqual(result.map((s) => s.id), ['id-1', 'id-2']);
  assert.deepEqual(result.map((s) => s.relativePath), ['a.user.js', 'b.user.js']);
  for (const s of result) assert.equal(s.status, 'ok');
});

test('rebuildCollection reuses IDs for known relativePaths', async () => {
  const existing = [
    await buildScriptFromText({
      id: 'pre-existing-id',
      collectionId: 'src-1',
      relativePath: 'a.user.js',
      fileUrl: 'file:///dir/a.user.js',
      text: VALID_SCRIPT,
      now: 50,
    }),
  ];
  const result = await rebuildCollection({
    collectionId: 'src-1',
    collectionPath: '/dir',
    existing,
    scan: [{ relativePath: 'a.user.js' }, { relativePath: 'b.user.js' }],
    fetchResults: new Map([
      ['a.user.js', { ok: true, text: VALID_SCRIPT }],
      ['b.user.js', { ok: true, text: VALID_SCRIPT }],
    ]),
    now: 100,
    newId: fakeIdSequence(),
  });
  assert.equal(result[0].id, 'pre-existing-id');
  assert.equal(result[1].id, 'id-1');
});

test('rebuildCollection drops a vanished script when the scan still sees others', async () => {
  // A successful scan that lists something is the directory telling us
  // what it holds now, so a renamed or deleted file leaves rather than
  // lingering as a `missing` row the user has to trash by hand.
  const existing = [
    await buildScriptFromText({
      id: 'a-id',
      collectionId: 'src-1',
      relativePath: 'a.user.js',
      fileUrl: 'file:///dir/a.user.js',
      text: VALID_SCRIPT,
      now: 50,
    }),
    await buildScriptFromText({
      id: 'b-id',
      collectionId: 'src-1',
      relativePath: 'b.user.js',
      fileUrl: 'file:///dir/b.user.js',
      text: VALID_SCRIPT,
      now: 50,
    }),
  ];
  const result = await rebuildCollection({
    collectionId: 'src-1',
    collectionPath: '/dir',
    existing,
    scan: [{ relativePath: 'a.user.js' }],
    fetchResults: new Map([
      ['a.user.js', { ok: true, text: VALID_SCRIPT }],
    ]),
    now: 100,
    newId: fakeIdSequence(),
  });
  assert.deepEqual(result.map((s) => s.relativePath), ['a.user.js']);
  assert.equal(result[0].status, 'ok');
});

test('rebuildCollection drops every script when the scan came back empty', async () => {
  // A scan that succeeded and found nothing is the directory saying it
  // holds nothing — the same as an empty manifest. The case this must
  // not be confused with, a listing that could not be read, never
  // reaches rebuildCollection: the listing reader refuses a page that
  // isn't a directory listing, and refreshCollection turns that into a
  // scanError that leaves every row alone.
  const existing = [
    await buildScriptFromText({
      id: 'a-id',
      collectionId: 'src-1',
      relativePath: 'a.user.js',
      fileUrl: 'file:///dir/a.user.js',
      text: VALID_SCRIPT,
      now: 50,
    }),
    await buildScriptFromText({
      id: 'b-id',
      collectionId: 'src-1',
      relativePath: 'b.user.js',
      fileUrl: 'file:///dir/b.user.js',
      text: VALID_SCRIPT,
      now: 50,
    }),
  ];
  const result = await rebuildCollection({
    collectionId: 'src-1',
    collectionPath: '/dir',
    existing,
    scan: [],
    fetchResults: new Map(),
    now: 100,
    newId: fakeIdSequence(),
  });
  assert.deepEqual(result, []);
});

test('rebuildCollection drops vanished entries entirely for a manifest collection', async () => {
  // A manifest is the user's source of truth: if they remove an entry,
  // they're explicitly removing the script — the same rule as a
  // directory listing, which is the directory's own source of truth.
  const existing = [
    await buildScriptFromText({
      id: 'a-id',
      collectionId: 'src-1',
      relativePath: 'a.user.js',
      fileUrl: 'https://example.com/scripts/a.user.js',
      text: VALID_SCRIPT,
      now: 50,
    }),
    await buildScriptFromText({
      id: 'b-id',
      collectionId: 'src-1',
      relativePath: 'b.user.js',
      fileUrl: 'https://example.com/scripts/b.user.js',
      text: VALID_SCRIPT,
      now: 50,
    }),
  ];
  const result = await rebuildCollection({
    collectionId: 'src-1',
    collectionPath: 'https://example.com/scripts/script_manifest.json',
    existing,
    scan: [{ relativePath: 'a.user.js' }],
    fetchResults: new Map([
      ['a.user.js', { ok: true, text: VALID_SCRIPT }],
    ]),
    now: 100,
    newId: fakeIdSequence(),
  });
  // Only the still-listed entry survives; b.user.js is gone (no
  // trailing 'missing' row).
  assert.equal(result.length, 1);
  assert.equal(result[0].relativePath, 'a.user.js');
  assert.equal(result[0].status, 'ok');
});

test('rebuildCollection drops vanished entries for a local manifest collection too', async () => {
  // Same rule applies to file:// / raw-path manifests — the manifest
  // kind, not the scheme, decides the vanished-entry policy. The empty
  // scan here is the case a directory collection exempts.
  const existing = [
    await buildScriptFromText({
      id: 'b-id',
      collectionId: 'src-1',
      relativePath: 'gone.user.js',
      fileUrl: 'file:///dir/gone.user.js',
      text: VALID_SCRIPT,
      now: 50,
    }),
  ];
  const result = await rebuildCollection({
    collectionId: 'src-1',
    collectionPath: '/home/me/scripts/script_manifest.json',
    existing,
    scan: [],
    fetchResults: new Map(),
    now: 100,
    newId: fakeIdSequence(),
  });
  assert.equal(result.length, 0);
});

test('rebuildCollection keeps a known script running when its fetch fails (refresh-failed)', async () => {
  const existing = [
    await buildScriptFromText({
      id: 'a-id',
      collectionId: 'src-1',
      relativePath: 'a.user.js',
      fileUrl: 'file:///dir/a.user.js',
      text: VALID_SCRIPT,
      now: 50,
    }),
  ];
  const result = await rebuildCollection({
    collectionId: 'src-1',
    collectionPath: '/dir',
    existing,
    scan: [{ relativePath: 'a.user.js' }],
    fetchResults: new Map([
      ['a.user.js', { ok: false, errorMessage: 'EACCES' }],
    ]),
    now: 100,
    newId: fakeIdSequence(),
  });
  // Hard fetch failure against a prior-ok row: keep the cached good copy
  // running (still `ok`, still injectable) and annotate the failure.
  assert.equal(result[0].status, 'ok');
  assert.equal(result[0].refreshError, 'EACCES');
  assert.equal(result[0].errorMessage, undefined);
  assert.equal(result[0].bodyText, existing[0].bodyText);
  assert.equal(result[0].loadedAt, existing[0].loadedAt); // unchanged
});

test('rebuildCollection: http 200 that parses invalid keeps the prior good copy (soft failure)', async () => {
  // The fetch "succeeds" (200) but the body isn't the script — real
  // JavaScript with no metadata block, say, which nothing about the
  // response gives away. We must NOT clobber the working copy: keep it
  // running and flag refreshError.
  //
  // A body that is outright markup (the classic login page) never gets
  // this far — `fetchHttpText` rejects it, so it arrives as a fetch
  // failure instead. See markup-response.ts.
  const existing = [
    await buildScriptFromText({
      id: 'h-id',
      collectionId: 'src-http',
      relativePath: 'h.user.js',
      fileUrl: 'https://example.com/h.user.js',
      text: VALID_SCRIPT,
      now: 50,
    }),
  ];
  const result = await rebuildCollection({
    collectionId: 'src-http',
    collectionPath: 'https://example.com/script_manifest.json',
    existing,
    scan: [{ relativePath: 'h.user.js' }],
    fetchResults: new Map([
      ['h.user.js', { ok: true, text: 'alert("no metadata block here");' }],
    ]),
    now: 100,
    newId: fakeIdSequence(),
  });
  assert.equal(result[0].status, 'ok');
  assert.match(result[0].refreshError, /not a valid userscript/);
  assert.equal(result[0].bodyText, existing[0].bodyText);
  assert.equal(result[0].loadedAt, existing[0].loadedAt); // prior preserved
});

test('rebuildCollection: file:// that parses invalid is treated as a real edit (INVALID)', async () => {
  // A local read returns the file's real bytes — an invalid parse there
  // is a genuine edit the user wants flagged immediately, NOT a soft
  // failure. So the soft-failure preservation is http-only.
  const existing = [
    await buildScriptFromText({
      id: 'f-id',
      collectionId: 'src-file',
      relativePath: 'f.user.js',
      fileUrl: 'file:///dir/f.user.js',
      text: VALID_SCRIPT,
      now: 50,
    }),
  ];
  const result = await rebuildCollection({
    collectionId: 'src-file',
    collectionPath: '/dir',
    existing,
    scan: [{ relativePath: 'f.user.js' }],
    fetchResults: new Map([
      ['f.user.js', { ok: true, text: 'broken, no metadata block' }],
    ]),
    now: 100,
    newId: fakeIdSequence(),
  });
  assert.equal(result[0].status, 'invalid');
  assert.equal(result[0].refreshError, undefined);
});

test('rebuildCollection preserves the prior `enabled` flag across a successful refresh', async () => {
  const existing = [
    {
      ...await buildScriptFromText({
        id: 'a-id',
        collectionId: 'src-1',
        relativePath: 'a.user.js',
        fileUrl: 'file:///dir/a.user.js',
        text: VALID_SCRIPT,
        now: 50,
      }),
      enabled: false, // user disabled this script some time ago
    },
  ];
  const result = await rebuildCollection({
    collectionId: 'src-1',
    collectionPath: '/dir',
    existing,
    scan: [{ relativePath: 'a.user.js' }],
    fetchResults: new Map([
      ['a.user.js', { ok: true, text: VALID_SCRIPT }],
    ]),
    now: 100,
    newId: fakeIdSequence(),
  });
  assert.equal(result[0].enabled, false);
});

test('buildScriptFromText defaults `enabled` to true on a brand-new entry', async () => {
  const entry = await buildScriptFromText({ ...COMMON, text: VALID_SCRIPT });
  assert.equal(entry.enabled, true);
});

// ---------- contentHash (universal change-detection token) ----------

test('hashSource returns the same token for identical text and different tokens for different text', async () => {
  // Documents the only two properties the rest of the system relies
  // on: deterministic for the same input, and "almost always"
  // different for different inputs.
  assert.equal(await hashSource(VALID_SCRIPT), await hashSource(VALID_SCRIPT));
  assert.notEqual(await hashSource(VALID_SCRIPT), await hashSource(VALID_SCRIPT + ' '));
  assert.notEqual(await hashSource(''), await hashSource(' '));
});

test('buildScriptFromText sets contentHash on every loaded entry', async () => {
  const a = await buildScriptFromText({ ...COMMON, text: VALID_SCRIPT });
  const b = await buildScriptFromText({ ...COMMON, text: VALID_SCRIPT });
  assert.equal(a.contentHash, b.contentHash);
  assert.equal(a.contentHash, await hashSource(VALID_SCRIPT));
});

test('buildScriptFromText preserves prior loadedAt when the fetched bytes are identical', async () => {
  // The universal post-fetch leg of change detection: even when a
  // refresh did fetch the body (because the per-scheme cheap skips —
  // size+mtime, HTTP 304 — couldn't fire), if the bytes are the same
  // as last time we don't bump loadedAt, so the collections page's row
  // highlight stays accurate.
  const prior = await buildScriptFromText({ ...COMMON, text: VALID_SCRIPT, now: 50 });
  const next = await buildScriptFromText({ ...COMMON, text: VALID_SCRIPT, now: 999, prior });
  assert.equal(next.loadedAt, 50);
  assert.equal(next.contentHash, prior.contentHash);
});

test('buildScriptFromText bumps loadedAt when the fetched bytes differ from prior', async () => {
  const prior = await buildScriptFromText({ ...COMMON, text: VALID_SCRIPT, now: 50 });
  const modified = VALID_SCRIPT.replace("console.log('hi');", "console.log('hello');");
  const next = await buildScriptFromText({ ...COMMON, text: modified, now: 999, prior });
  assert.equal(next.loadedAt, 999);
  assert.notEqual(next.contentHash, prior.contentHash);
});

test('rebuildCollection: identical bytes after a forced refetch preserve loadedAt (manifest / no-validator case)', async () => {
  // The bug this guards against: manifest collections (and HTTP servers
  // without ETag / Last-Modified) always re-fetch every refresh.
  // Without the content-hash compare every row would flip its
  // loadedAt and flash in the collections page. With it, only rows whose
  // bytes actually changed are flagged.
  const prior = await buildScriptFromText({
    id: 'a-id',
    collectionId: 'src-1',
    relativePath: 'a.user.js',
    fileUrl: 'https://example.com/scripts/a.user.js',
    text: VALID_SCRIPT,
    now: 50,
  });
  const result = await rebuildCollection({
    collectionId: 'src-1',
    collectionPath: 'https://example.com/scripts/script_manifest.json',
    existing: [prior],
    scan: [{ relativePath: 'a.user.js' }],
    fetchResults: new Map([
      // Server didn't 304 — we got a fresh 200 with the same bytes.
      ['a.user.js', { ok: true, text: VALID_SCRIPT }],
    ]),
    now: 999,
    newId: fakeIdSequence(),
  });
  assert.equal(result[0].loadedAt, prior.loadedAt);
  assert.equal(result[0].contentHash, prior.contentHash);
});

test('rebuildCollection: unchanged marker preserves the prior entry and records fsMtime', async () => {
  const prior = await buildScriptFromText({
    id: 'a-id',
    collectionId: 'src-1',
    relativePath: 'a.user.js',
    fileUrl: 'file:///dir/a.user.js',
    text: VALID_SCRIPT,
    now: 50,
  });
  const result = await rebuildCollection({
    collectionId: 'src-1',
    collectionPath: '/dir',
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

test('rebuildCollection: successful fetch stores fsMtime from the scan', async () => {
  const result = await rebuildCollection({
    collectionId: 'src-1',
    collectionPath: '/dir',
    existing: [],
    scan: [{ relativePath: 'a.user.js', size: 100, mtime: 4200 }],
    fetchResults: new Map([
      ['a.user.js', { ok: true, text: VALID_SCRIPT }],
    ]),
    now: 100,
    newId: fakeIdSequence(),
  });
  assert.equal(result[0].fsMtime, 4200);
});

test('rebuildCollection builds the right fileUrl for a container file script', async () => {
  // Container scripts store the full URL/path as `relativePath`.
  // scriptFileUrl must coerce raw fs paths into file:// URLs so the
  // downstream fetcher sees a uniform form.
  const result = await rebuildCollection({
    collectionId: 'src-1',
    collectionPath: 'container:file',
    existing: [],
    scan: [{ relativePath: '/home/me/foo bar.user.js' }],
    fetchResults: new Map([
      ['/home/me/foo bar.user.js', { ok: true, text: VALID_SCRIPT }],
    ]),
    now: 100,
    newId: fakeIdSequence(),
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].fileUrl, 'file:///home/me/foo%20bar.user.js');
  assert.equal(result[0].relativePath, '/home/me/foo bar.user.js');
});

test('rebuildCollection persists httpEtag / httpLastModified from a successful HTTP fetch', async () => {
  // The next refresh will read these back off the prior row and send
  // them as If-None-Match / If-Modified-Since so the server can answer
  // 304. Without this round-trip, every refresh of an HTTP collection
  // would redownload the body.
  const result = await rebuildCollection({
    collectionId: 'src-1',
    collectionPath: 'https://example.com/scripts/script_manifest.json',
    existing: [],
    scan: [{ relativePath: 'a.user.js' }],
    fetchResults: new Map([
      ['a.user.js', {
        ok: true,
        text: VALID_SCRIPT,
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

test('rebuildCollection: HTTP unchanged preserves the prior entry and its validators', async () => {
  // The HTTP path lands here when the server returned 304 to our
  // conditional GET. fsMtime stays unused (HTTP doesn't use it); the
  // etag/lastModified should not get cleared.
  const prior = {
    ...await buildScriptFromText({
      id: 'a-id',
      collectionId: 'src-1',
      relativePath: 'a.user.js',
      fileUrl: 'https://example.com/scripts/a.user.js',
      text: VALID_SCRIPT,
      now: 50,
    }),
    httpEtag: 'W/"abc"',
    httpLastModified: 'Wed, 21 Oct 2025 07:28:00 GMT',
  };
  const result = await rebuildCollection({
    collectionId: 'src-1',
    collectionPath: 'https://example.com/scripts/script_manifest.json',
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

test('rebuildCollection creates an initial error entry when a new file fails to fetch', async () => {
  const result = await rebuildCollection({
    collectionId: 'src-1',
    collectionPath: '/dir',
    existing: [],
    scan: [{ relativePath: 'new.user.js' }],
    fetchResults: new Map([
      ['new.user.js', { ok: false, errorMessage: 'network' }],
    ]),
    now: 100,
    newId: fakeIdSequence(),
  });
  assert.equal(result[0].status, 'invalid');
  assert.equal(result[0].errorMessage, 'network');
  assert.equal(result[0].size, null);
  assert.equal(result[0].headerText, '');
  assert.equal(result[0].bodyText, '');
});

// ---------- fetchOrSkipInParallel: per-entry scheme dispatch ----------
//
// The core symmetry claim of the refactor: a manifest collection can list
// entries that resolve to http(s):// AND file:// URLs, and each entry
// picks its fetch/skip strategy based on the RESOLVED URL's scheme —
// not the collection's. The test below wires up a manifest with one of
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
  // Manifest collection at https://x/script_manifest.json with two entries:
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
      ...await buildScriptFromText({
        id: 'h-id', collectionId: 'src-1', relativePath: 'foo.user.js',
        fileUrl: 'https://x/foo.user.js', text: VALID_SCRIPT, now: 1,
      }),
      httpEtag: 'W/"abc"',
    };
    const results = await fetchOrSkipInParallel(
      'https://x/script_manifest.json',  // manifest collection
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
    assert.equal(fileResult.text, 'console.log("local");');
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

// ---------- loadStateLogEntry ----------
//
// The one place that decides how a failed load is phrased and at what
// level in the per-script Log. Every surface that can report one (the
// add path, the refresh outcome path, the boot replay) goes through
// this, and the repeat-suppression in those callers compares the
// resulting messages — so identical state MUST produce identical text.

test('loadStateLogEntry returns null for a healthy row', async () => {
  const ok = await buildScriptFromText({
    id: 'a', collectionId: 's', relativePath: 'a.user.js',
    fileUrl: 'file:///a.user.js', text: VALID_SCRIPT, now: 1,
  });
  assert.equal(loadStateLogEntry(ok), null);
});

test('loadStateLogEntry reports an invalid row as an error carrying errorMessage', async () => {
  const bad = await buildScriptFromText({
    id: 'a', collectionId: 's', relativePath: 'a.user.js',
    fileUrl: 'file:///a.user.js', text: MISSING_NAME, now: 1,
  });
  assert.equal(bad.status, 'invalid');
  // The location rides as its own field rather than being baked into
  // the text, so the Log tab can render it as a link.
  assert.deepEqual(loadStateLogEntry(bad), {
    level: 'error',
    state: 'invalid',
    message: NO_NAME,
    location: { file: 'a.user.js', line: 1 },
  });
});

test('loadStateLogEntry falls back to a generic message when an invalid row has none', () => {
  assert.deepEqual(
    loadStateLogEntry({ status: 'invalid' }),
    { level: 'error', state: 'invalid', message: 'Unknown error' },
  );
});

test('loadStateLogEntry reports a refreshError as a warning: the script still runs', async () => {
  // status stays 'ok' — the cached copy is still injected — so this is
  // a warning, not an error. The `state` is what the badge shows, and
  // is also what keeps the entry off the `loglevel:` sentinel.
  const ok = await buildScriptFromText({
    id: 'a', collectionId: 's', relativePath: 'a.user.js',
    fileUrl: 'file:///a.user.js', text: VALID_SCRIPT, now: 1,
  });
  const stale = applyFetchError(ok, 'HTTP 404');
  assert.equal(stale.status, 'ok');
  assert.deepEqual(
    loadStateLogEntry(stale),
    { level: 'warning', state: 'refresh-failed', message: 'Refresh failed: HTTP 404' },
  );
});

test('loadStateLogEntry ranks a broken load above a stale refresh', () => {
  // Defensive: if a row ever carried both, "can't run" is the more
  // actionable fact and has to be the one reported.
  assert.deepEqual(
    loadStateLogEntry({
      status: 'invalid', errorMessage: 'no metadata block', refreshError: 'HTTP 404',
    }),
    { level: 'error', state: 'invalid', message: 'no metadata block' },
  );
});

// ---------- sameStoredValue ----------
//
// The predicate behind the "don't rewrite unchanged rows" skip in
// refreshCollection / refreshScript. Its failure modes are asymmetric:
// a false negative costs a redundant write (what we're removing), while
// a false positive silently drops a real change on the floor. The tests
// below lean on the second.

test('sameStoredValue ignores key order', () => {
  // The case that rules out JSON.stringify: a rebuilt row's key order
  // comes from the spread-and-delete that built it, a stored row's from
  // its last serialization, and they routinely differ.
  assert.equal(
    sameStoredValue({ a: 1, b: 2 }, { b: 2, a: 1 }),
    true,
  );
});

test('sameStoredValue treats an undefined-valued key as absent', () => {
  // A storage round-trip drops these, so a freshly built row carrying
  // one must still compare equal to the stored row that lost it.
  assert.equal(sameStoredValue({ a: 1, b: undefined }, { a: 1 }), true);
  assert.equal(sameStoredValue({ a: 1 }, { a: 1, b: undefined }), true);
});

test('sameStoredValue sees a key added or removed', () => {
  // `delete next.refreshError` on the unchanged path is exactly this
  // shape — the row is otherwise identical and still has to be written.
  assert.equal(sameStoredValue({ a: 1, refreshError: 'x' }, { a: 1 }), false);
  assert.equal(sameStoredValue({ a: 1 }, { a: 1, refreshError: 'x' }), false);
});

test('sameStoredValue compares nested objects and arrays by value', () => {
  const row = { requires: [{ url: 'u', contentHash: 'h' }] };
  assert.equal(
    sameStoredValue(row, { requires: [{ url: 'u', contentHash: 'h' }] }),
    true,
  );
  assert.equal(
    sameStoredValue(row, { requires: [{ url: 'u', contentHash: 'CHANGED' }] }),
    false,
  );
  // Length differences, in both directions.
  assert.equal(sameStoredValue(row, { requires: [] }), false);
  assert.equal(
    sameStoredValue(row, { requires: [{ url: 'u', contentHash: 'h' }, { url: 'v' }] }),
    false,
  );
});

test('sameStoredValue does not confuse an array with an object', () => {
  assert.equal(sameStoredValue([], {}), false);
  assert.equal(sameStoredValue({ 0: 'a' }, ['a']), false);
});

test('sameStoredValue handles null and a missing stored row', () => {
  // `undefined` is what `curByKey[...]` yields for a script row that
  // isn't in storage yet — a brand-new row, which must always write.
  assert.equal(sameStoredValue({ a: 1 }, undefined), false);
  assert.equal(sameStoredValue(null, {}), false);
  assert.equal(sameStoredValue(null, null), true);
});

test('sameStoredValue distinguishes values a loose compare would merge', () => {
  assert.equal(sameStoredValue(0, false), false);
  assert.equal(sameStoredValue('1', 1), false);
  assert.equal(sameStoredValue(1, 1), true);
});

test('sameStoredValue sees a real content change on a full row', async () => {
  // End-to-end on the shape this actually guards: two builds of the
  // same file compare equal, a changed body does not.
  const base = {
    id: 'a', collectionId: 's', relativePath: 'a.user.js',
    fileUrl: 'file:///a.user.js', now: 1,
  };
  const first = await buildScriptFromText({ ...base, text: VALID_SCRIPT });
  const again = await buildScriptFromText({ ...base, text: VALID_SCRIPT, prior: first });
  assert.equal(sameStoredValue(first, again), true);

  const edited = await buildScriptFromText({
    ...base, text: VALID_SCRIPT + '\nconsole.log("more");\n', prior: first,
  });
  assert.equal(sameStoredValue(first, edited), false);
});

// ---------- backfillUsesUnsafeWindow ----------
//
// The one storage-touching function tested here, because what it exists
// for can't be seen from the pure helpers: a row is only rebuilt when a
// fetch happens, so a script installed before `usesUnsafeWindow` existed
// would keep failing on the name indefinitely.

const USES_UNSAFE_WINDOW = `// ==UserScript==
// @name        Implicit
// @match       https://example.com/*
// @grant       GM_setValue
// ==/UserScript==
unsafeWindow.__PAGE_APP__.go();
`;

function legacyRow(over = {}) {
  // A row as it would have been stored before the field existed: no
  // `usesUnsafeWindow`, whatever `startupLogs` its header alone produced.
  const text = over.text ?? USES_UNSAFE_WINDOW;
  const body = text.slice(text.indexOf('==/UserScript==') + '==/UserScript=='.length);
  const row = {
    id: over.id ?? 'script-1',
    collectionId: 'c',
    relativePath: 'a.user.js',
    fileUrl: 'file:///a.user.js',
    status: 'ok',
    size: text.length,
    headerText: '',
    bodyText: body,
    header: parseHeader(text),
    matching: { matches: ['https://example.com/*'], excludes: [], includes: [] },
    loadedAt: 0,
    enabled: true,
  };
  delete over.text;
  return { ...row, ...over };
}

function stubStorage(rows) {
  const store = Object.fromEntries(rows.map((r) => [`script:${r.id}`, r]));
  globalThis.chrome = {
    storage: {
      local: {
        get: async (key) => (key === null ? { ...store } : {}),
        set: async (obj) => { Object.assign(store, obj); },
      },
    },
  };
  return store;
}

test('backfillUsesUnsafeWindow flips a pre-field row and gives it the startup log', async () => {
  const store = stubStorage([legacyRow()]);
  assert.equal(await backfillUsesUnsafeWindow(), 1);
  const row = store['script:script-1'];
  assert.equal(row.usesUnsafeWindow, true);
  // Re-derived, so the row says what the injector will now do with it.
  assert.deepEqual(row.startupLogs.map((l) => [l.level, l.message]), [
    ['info', IMPLICIT_UNSAFE_WINDOW_INFO],
  ]);
});

test('backfillUsesUnsafeWindow leaves rows it has nothing to add to', async () => {
  const store = stubStorage([
    // Already carries the flag.
    legacyRow({ id: 'has-flag', usesUnsafeWindow: true }),
    // Never runs, so it never reaches the injector.
    legacyRow({ id: 'broken', status: 'invalid', errorMessage: 'The file is empty' }),
    // Doesn't name unsafeWindow at all.
    legacyRow({ id: 'plain', text: VALID_SCRIPT }),
  ]);
  assert.equal(await backfillUsesUnsafeWindow(), 0);
  assert.equal(store['script:broken'].usesUnsafeWindow, undefined);
  assert.equal(store['script:plain'].usesUnsafeWindow, undefined);
});

test('backfillUsesUnsafeWindow is idempotent', async () => {
  const store = stubStorage([legacyRow()]);
  assert.equal(await backfillUsesUnsafeWindow(), 1);
  assert.equal(await backfillUsesUnsafeWindow(), 0);
  assert.equal(store['script:script-1'].usesUnsafeWindow, true);
});
