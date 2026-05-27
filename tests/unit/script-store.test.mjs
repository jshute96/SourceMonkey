// Tests for the pure helpers in src/script-store.ts. The storage I/O
// layer (chrome.storage.local) is not exercised here — those functions
// are thin wrappers around the helpers tested below.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  distillMatching,
  extractStartupLogs,
  validateHeader,
  buildScriptFromText,
  applyFetchError,
  applyMissing,
  buildInitialErrorEntry,
  fetchOrSkipInParallel,
  hashSource,
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

test('validateHeader complains about a missing @name', async () => {
  assert.equal(validateHeader(parseHeader(MISSING_NAME)), 'missing @name');
});

test('validateHeader complains about no matching patterns', async () => {
  assert.equal(
    validateHeader(parseHeader(NO_MATCH)),
    'missing @match or @include',
  );
});

test('validateHeader complains about a null header', async () => {
  assert.equal(validateHeader(null), 'no metadata block');
});

// ---------- extractStartupLogs ----------

test('extractStartupLogs returns [] for a null header', () => {
  assert.deepEqual(extractStartupLogs(null), []);
});

test('extractStartupLogs returns [] when every @grant is in the catalog', () => {
  const header = parseHeader(`// ==UserScript==
// @name X
// @match https://e/*
// @grant GM_setValue
// @grant GM_getValue
// ==/UserScript==
`);
  assert.deepEqual(extractStartupLogs(header), []);
});

test('extractStartupLogs returns [] when there are no @grant lines at all', () => {
  // No @grant ≠ unknown @grant. The path that resolves grants only
  // fires when at least one @grant line was declared, so a script
  // without any grants is silent.
  const header = parseHeader(VALID_SCRIPT);
  assert.deepEqual(extractStartupLogs(header), []);
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
  assert.deepEqual(extractStartupLogs(header), [
    { level: 'warn', message: 'unknown @grant entries dropped: GM_webRequest, GM_audio' },
  ]);
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
  assert.deepEqual(extractStartupLogs(header), [
    { level: 'warn', message: 'unknown @grant entries dropped: GM_typo' },
  ]);
});

// ---------- buildScriptFromText ----------

const COMMON = {
  id: 'sc-1',
  sourceId: 'src-1',
  relativePath: 'a.user.js',
  fileUrl: 'file:///dir/a.user.js',
  now: 1700000000000,
};

test('buildScriptFromText produces an OK entry for a valid script', async () => {
  const entry = await buildScriptFromText({ ...COMMON, source: VALID_SCRIPT });
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
  const entry = await buildScriptFromText({ ...COMMON, source: src });
  assert.equal(entry.status, 'ok');
  assert.deepEqual(entry.startupLogs, [
    { level: 'warn', message: 'unknown @grant entries dropped: GM_typoName' },
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
  const entry = await buildScriptFromText({ ...COMMON, source: src });
  assert.equal(entry.status, 'error');
  assert.equal(entry.startupLogs, undefined);
});

test('buildScriptFromText reports a missing metadata block', async () => {
  const entry = await buildScriptFromText({ ...COMMON, source: NO_BLOCK });
  assert.equal(entry.status, 'error');
  assert.equal(entry.errorMessage, 'no metadata block');
  assert.equal(entry.headerText, '');
  assert.equal(entry.bodyText, NO_BLOCK);
  assert.equal(entry.header, null);
});

test('buildScriptFromText reports an unterminated metadata block', async () => {
  const broken = '// ==UserScript==\n// @name Foo\nconsole.log("oops");\n';
  const entry = await buildScriptFromText({ ...COMMON, source: broken });
  assert.equal(entry.status, 'error');
  assert.equal(entry.errorMessage, 'unterminated metadata block');
});

test('buildScriptFromText reports a missing required field', async () => {
  const entry = await buildScriptFromText({ ...COMMON, source: MISSING_NAME });
  assert.equal(entry.status, 'error');
  assert.equal(entry.errorMessage, 'missing @name');
  // Even on validation failure we still record what was parsed so the
  // viewer can show the partial header.
  assert.ok(entry.header);
  assert.deepEqual(entry.matching.matches, ['https://example.com/*']);
});

// ---------- applyFetchError / applyMissing / buildInitialErrorEntry ----------

test('applyFetchError preserves content and flips status', async () => {
  const ok = await buildScriptFromText({ ...COMMON, source: VALID_SCRIPT });
  const errored = applyFetchError(ok, 'permission denied');
  assert.equal(errored.status, 'error');
  assert.equal(errored.errorMessage, 'permission denied');
  assert.equal(errored.headerText, ok.headerText);
  assert.equal(errored.bodyText, ok.bodyText);
  assert.equal(errored.size, ok.size);
  assert.equal(errored.loadedAt, ok.loadedAt);
});

test('applyMissing preserves size + content, clears errorMessage', async () => {
  // The file is gone but we still hold its last-read bytes — keep the
  // cached size so the Size column reflects the preserved content,
  // distinct from genuine "unknown size" rows.
  const ok = await buildScriptFromText({ ...COMMON, source: VALID_SCRIPT });
  const errored = applyFetchError(ok, 'read failed');
  const missing = applyMissing(errored);
  assert.equal(missing.status, 'missing');
  assert.equal(missing.size, ok.size);
  assert.equal(missing.errorMessage, undefined);
  assert.equal(missing.headerText, ok.headerText);
  assert.equal(missing.bodyText, ok.bodyText);
});

test('applyMissing disables the script so a vanished file stops running', async () => {
  // The directory-level Refresh promotes vanished files to missing;
  // we want them silently stopped, not still injected from cached
  // content. The user has to manually re-enable if the file returns.
  const ok = await buildScriptFromText({ ...COMMON, source: VALID_SCRIPT });
  assert.equal(ok.enabled, true);
  assert.equal(applyMissing(ok).enabled, false);
});

test('applyMissing preserves enabled when the row has already left the ok state', async () => {
  // Regression guard: rebuildSource calls applyMissing on every refresh
  // for files the scan still doesn't see, not just on the first
  // ok→missing transition. If the user re-enabled a missing row to run
  // from its cached body, the next refresh must not silently clobber
  // that choice. The enabled flag only flips on the ok→missing edge.
  //
  // Two non-ok prior states need preservation:
  //   - missing → missing (a plain directory refresh while the file
  //     is still gone)
  //   - error → missing (an opportunistic per-script refetch flipped
  //     the row to error first — applyFetchError preserves enabled —
  //     and then the directory-level refresh promotes it to missing)
  const ok = await buildScriptFromText({ ...COMMON, source: VALID_SCRIPT });

  // missing → missing preserves enabled
  const justMissing = applyMissing(ok);
  assert.equal(justMissing.enabled, false);
  const reEnabledMissing = { ...justMissing, enabled: true };
  const afterRefresh = applyMissing(reEnabledMissing);
  assert.equal(afterRefresh.status, 'missing');
  assert.equal(afterRefresh.enabled, true);

  // error → missing preserves enabled
  const reEnabledErrored = { ...ok, enabled: true, status: /** @type {'error'} */ ('error'), errorMessage: 'gone' };
  const fromError = applyMissing(reEnabledErrored);
  assert.equal(fromError.status, 'missing');
  assert.equal(fromError.enabled, true);
  assert.equal(fromError.errorMessage, undefined);
});

test('buildInitialErrorEntry leaves content empty', async () => {
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

test('rebuildSource assigns new IDs to brand-new scripts', async () => {
  const result = await rebuildSource({
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

test('rebuildSource reuses IDs for known relativePaths', async () => {
  const existing = [
    await buildScriptFromText({
      id: 'pre-existing-id',
      sourceId: 'src-1',
      relativePath: 'a.user.js',
      fileUrl: 'file:///dir/a.user.js',
      source: VALID_SCRIPT,
      now: 50,
    }),
  ];
  const result = await rebuildSource({
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

test('rebuildSource flags vanished scripts as missing and keeps their content', async () => {
  const existing = [
    await buildScriptFromText({
      id: 'a-id',
      sourceId: 'src-1',
      relativePath: 'a.user.js',
      fileUrl: 'file:///dir/a.user.js',
      source: VALID_SCRIPT,
      now: 50,
    }),
    await buildScriptFromText({
      id: 'b-id',
      sourceId: 'src-1',
      relativePath: 'b.user.js',
      fileUrl: 'file:///dir/b.user.js',
      source: VALID_SCRIPT,
      now: 50,
    }),
  ];
  const result = await rebuildSource({
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
  // Missing entry keeps the prior body + size so the viewer still
  // works and the Size column reflects the cached content.
  assert.equal(result[1].size, existing[1].size);
  assert.equal(result[1].bodyText, existing[1].bodyText);
});

test('rebuildSource drops vanished entries entirely for a manifest source', async () => {
  // A manifest is the user's source of truth: if they remove an entry,
  // they're explicitly removing the script. No reason to keep a
  // tombstone row around as 'missing' the way we do for a local
  // directory (where the file might come back).
  const existing = [
    await buildScriptFromText({
      id: 'a-id',
      sourceId: 'src-1',
      relativePath: 'a.user.js',
      fileUrl: 'https://example.com/scripts/a.user.js',
      source: VALID_SCRIPT,
      now: 50,
    }),
    await buildScriptFromText({
      id: 'b-id',
      sourceId: 'src-1',
      relativePath: 'b.user.js',
      fileUrl: 'https://example.com/scripts/b.user.js',
      source: VALID_SCRIPT,
      now: 50,
    }),
  ];
  const result = await rebuildSource({
    sourceId: 'src-1',
    sourcePath: 'https://example.com/scripts/script_manifest.json',
    existing,
    scan: [{ relativePath: 'a.user.js' }],
    fetchResults: new Map([
      ['a.user.js', { ok: true, source: VALID_SCRIPT }],
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

test('rebuildSource drops vanished entries for a local manifest source too', async () => {
  // Same rule applies to file:// / raw-path manifests — the source
  // kind, not the scheme, decides the vanished-entry policy.
  const existing = [
    await buildScriptFromText({
      id: 'b-id',
      sourceId: 'src-1',
      relativePath: 'gone.user.js',
      fileUrl: 'file:///dir/gone.user.js',
      source: VALID_SCRIPT,
      now: 50,
    }),
  ];
  const result = await rebuildSource({
    sourceId: 'src-1',
    sourcePath: '/home/me/scripts/script_manifest.json',
    existing,
    scan: [],
    fetchResults: new Map(),
    now: 100,
    newId: fakeIdSequence(),
  });
  assert.equal(result.length, 0);
});

test('rebuildSource preserves prior content when a fetch fails on a known script', async () => {
  const existing = [
    await buildScriptFromText({
      id: 'a-id',
      sourceId: 'src-1',
      relativePath: 'a.user.js',
      fileUrl: 'file:///dir/a.user.js',
      source: VALID_SCRIPT,
      now: 50,
    }),
  ];
  const result = await rebuildSource({
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

test('rebuildSource preserves the prior `enabled` flag across a successful refresh', async () => {
  const existing = [
    {
      ...await buildScriptFromText({
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
  const result = await rebuildSource({
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

test('buildScriptFromText defaults `enabled` to true on a brand-new entry', async () => {
  const entry = await buildScriptFromText({ ...COMMON, source: VALID_SCRIPT });
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
  const a = await buildScriptFromText({ ...COMMON, source: VALID_SCRIPT });
  const b = await buildScriptFromText({ ...COMMON, source: VALID_SCRIPT });
  assert.equal(a.contentHash, b.contentHash);
  assert.equal(a.contentHash, await hashSource(VALID_SCRIPT));
});

test('buildScriptFromText preserves prior loadedAt when the fetched bytes are identical', async () => {
  // The universal post-fetch leg of change detection: even when a
  // refresh did fetch the body (because the per-scheme cheap skips —
  // size+mtime, HTTP 304 — couldn't fire), if the bytes are the same
  // as last time we don't bump loadedAt, so the options page's row
  // highlight stays accurate.
  const prior = await buildScriptFromText({ ...COMMON, source: VALID_SCRIPT, now: 50 });
  const next = await buildScriptFromText({ ...COMMON, source: VALID_SCRIPT, now: 999, prior });
  assert.equal(next.loadedAt, 50);
  assert.equal(next.contentHash, prior.contentHash);
});

test('buildScriptFromText bumps loadedAt when the fetched bytes differ from prior', async () => {
  const prior = await buildScriptFromText({ ...COMMON, source: VALID_SCRIPT, now: 50 });
  const modified = VALID_SCRIPT.replace("console.log('hi');", "console.log('hello');");
  const next = await buildScriptFromText({ ...COMMON, source: modified, now: 999, prior });
  assert.equal(next.loadedAt, 999);
  assert.notEqual(next.contentHash, prior.contentHash);
});

test('rebuildSource: identical bytes after a forced refetch preserve loadedAt (manifest / no-validator case)', async () => {
  // The bug this guards against: manifest sources (and HTTP servers
  // without ETag / Last-Modified) always re-fetch every refresh.
  // Without the content-hash compare every row would flip its
  // loadedAt and flash in the options page. With it, only rows whose
  // bytes actually changed are flagged.
  const prior = await buildScriptFromText({
    id: 'a-id',
    sourceId: 'src-1',
    relativePath: 'a.user.js',
    fileUrl: 'https://example.com/scripts/a.user.js',
    source: VALID_SCRIPT,
    now: 50,
  });
  const result = await rebuildSource({
    sourceId: 'src-1',
    sourcePath: 'https://example.com/scripts/script_manifest.json',
    existing: [prior],
    scan: [{ relativePath: 'a.user.js' }],
    fetchResults: new Map([
      // Server didn't 304 — we got a fresh 200 with the same bytes.
      ['a.user.js', { ok: true, source: VALID_SCRIPT }],
    ]),
    now: 999,
    newId: fakeIdSequence(),
  });
  assert.equal(result[0].loadedAt, prior.loadedAt);
  assert.equal(result[0].contentHash, prior.contentHash);
});

test('rebuildSource: unchanged marker preserves the prior entry and records fsMtime', async () => {
  const prior = await buildScriptFromText({
    id: 'a-id',
    sourceId: 'src-1',
    relativePath: 'a.user.js',
    fileUrl: 'file:///dir/a.user.js',
    source: VALID_SCRIPT,
    now: 50,
  });
  const result = await rebuildSource({
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

test('rebuildSource: successful fetch stores fsMtime from the scan', async () => {
  const result = await rebuildSource({
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

test('rebuildSource: missing path also disables the entry', async () => {
  // Mirrors applyMissing's behavior end-to-end via rebuildSource.
  const existing = [
    await buildScriptFromText({
      id: 'a-id', sourceId: 'src-1', relativePath: 'a.user.js',
      fileUrl: 'file:///dir/a.user.js', source: VALID_SCRIPT, now: 50,
    }),
  ];
  const result = await rebuildSource({
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

test('rebuildSource builds the right fileUrl for a single-file source', async () => {
  // Single-file sources store the *file* path in sourcePath; the scan
  // entry's relativePath is the basename. scriptFileUrl must not
  // double the filename — it should return the source path's URL.
  const result = await rebuildSource({
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

test('rebuildSource persists httpEtag / httpLastModified from a successful HTTP fetch', async () => {
  // The next refresh will read these back off the prior row and send
  // them as If-None-Match / If-Modified-Since so the server can answer
  // 304. Without this round-trip, every refresh of an HTTP source
  // would redownload the body.
  const result = await rebuildSource({
    sourceId: 'src-1',
    sourcePath: 'https://example.com/scripts/script_manifest.json',
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

test('rebuildSource: HTTP unchanged preserves the prior entry and its validators', async () => {
  // The HTTP path lands here when the server returned 304 to our
  // conditional GET. fsMtime stays unused (HTTP doesn't use it); the
  // etag/lastModified should not get cleared.
  const prior = {
    ...await buildScriptFromText({
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
  const result = await rebuildSource({
    sourceId: 'src-1',
    sourcePath: 'https://example.com/scripts/script_manifest.json',
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

test('rebuildSource creates an initial error entry when a new file fails to fetch', async () => {
  const result = await rebuildSource({
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
  // Manifest source at https://x/script_manifest.json with two entries:
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
        id: 'h-id', sourceId: 'src-1', relativePath: 'foo.user.js',
        fileUrl: 'https://x/foo.user.js', source: VALID_SCRIPT, now: 1,
      }),
      httpEtag: 'W/"abc"',
    };
    const results = await fetchOrSkipInParallel(
      'https://x/script_manifest.json',  // manifest source
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

test('applyMissing keeps HTTP validators dormant for later recovery', async () => {
  // Documented behavior: a vanished script row preserves httpEtag /
  // httpLastModified even though they're unused while status is
  // 'missing'. If the entry later reappears, buildScriptFromText
  // overwrites the validators from the fresh response.
  const prior = {
    ...await buildScriptFromText({
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
