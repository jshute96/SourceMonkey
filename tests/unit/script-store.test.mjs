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
