// Tests for src/github-source.ts (compiled to dist/github-source.js):
// GitHub URL parsing, default-branch resolution, raw-URL normalization,
// and the Contents-API recursive directory scanner. The directories.ts
// dispatch (scriptFileUrl / scriptAbsolutePath / scanForUserScripts
// going through these helpers) is covered by directories.test.mjs.
//
// `withFetch` stubs globalThis.fetch so the API-using helpers
// (normalizeGithubInput, scanGithubDir) can be exercised without
// reaching the network. Identical pattern to the fetchHttpText tests
// in directories.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isGithubDirSource,
  normalizeGithubInput,
  parseGithubUrl,
  scanGithubDir,
} from '../../dist/github-source.js';

async function withFetch(impl, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

// ---------- parseGithubUrl ----------

test('parseGithubUrl extracts owner/repo/kind/ref/path for blob and tree URLs', () => {
  assert.deepEqual(
    parseGithubUrl('https://github.com/foo/bar/blob/main/dir/script.user.js'),
    { owner: 'foo', repo: 'bar', kind: 'blob', ref: 'main', path: 'dir/script.user.js' },
  );
  assert.deepEqual(
    parseGithubUrl('https://github.com/foo/bar/tree/main/dir'),
    { owner: 'foo', repo: 'bar', kind: 'tree', ref: 'main', path: 'dir' },
  );
  // /tree/<ref> with no path → repo-root-at-ref directory.
  assert.deepEqual(
    parseGithubUrl('https://github.com/foo/bar/tree/main'),
    { owner: 'foo', repo: 'bar', kind: 'tree', ref: 'main', path: '' },
  );
  // Trailing `.git` on the repo (rare in browser URLs but harmless to tolerate).
  assert.equal(parseGithubUrl('https://github.com/foo/bar.git/tree/main/dir').repo, 'bar');
  // Trailing slash on the path is stripped so downstream URL joins don't double up.
  assert.equal(
    parseGithubUrl('https://github.com/foo/bar/tree/main/dir/').path,
    'dir',
  );
  // Query and fragment after the path are tolerated and ignored.
  assert.equal(
    parseGithubUrl('https://github.com/foo/bar/blob/main/a.user.js?foo=1#L10').path,
    'a.user.js',
  );
});

test('parseGithubUrl returns null for non-github URLs and bare repo URLs', () => {
  assert.equal(parseGithubUrl('https://example.com/foo/bar'), null);
  assert.equal(parseGithubUrl('https://raw.githubusercontent.com/foo/bar/main/a.user.js'), null);
  // Bare repo URL (no /blob|tree/...) — handled by normalizeGithubInput, not the file-URL parser.
  assert.equal(parseGithubUrl('https://github.com/foo/bar'), null);
  assert.equal(parseGithubUrl('not a url'), null);
});

// ---------- isGithubDirSource ----------

test('isGithubDirSource recognises directory URLs and rejects file URLs', () => {
  // Canonical: /tree/<ref>/<dir>
  assert.equal(isGithubDirSource('https://github.com/foo/bar/tree/main/dir'), true);
  // Repo-root-at-ref.
  assert.equal(isGithubDirSource('https://github.com/foo/bar/tree/main'), true);
  // Tolerated: a /blob/<ref>/<dir> URL (user editing a blob URL by hand).
  assert.equal(isGithubDirSource('https://github.com/foo/bar/blob/main/dir'), true);
  // File URLs are NOT directory sources — normalizeGithubInput rewrites
  // these to raw before they reach the source-kind dispatch.
  assert.equal(isGithubDirSource('https://github.com/foo/bar/blob/main/a.user.js'), false);
  assert.equal(isGithubDirSource('https://github.com/foo/bar/blob/main/script_manifest.json'), false);
  // Non-github URLs always classify as non-dir.
  assert.equal(isGithubDirSource('https://example.com/dir'), false);
  assert.equal(isGithubDirSource('/home/me/scripts'), false);
});

// ---------- normalizeGithubInput ----------

test('normalizeGithubInput rewrites github blob URLs of .user.js / .json to raw', async () => {
  assert.equal(
    await normalizeGithubInput('https://github.com/foo/bar/blob/main/dir/script.user.js'),
    'https://raw.githubusercontent.com/foo/bar/main/dir/script.user.js',
  );
  // Manifest files get the same treatment — the user shouldn't have to
  // hand-edit the URL to point at raw.githubusercontent.com.
  assert.equal(
    await normalizeGithubInput('https://github.com/foo/bar/blob/main/script_manifest.json'),
    'https://raw.githubusercontent.com/foo/bar/main/script_manifest.json',
  );
  // tree URLs work too (a user might paste a /tree/ URL of a file).
  assert.equal(
    await normalizeGithubInput('https://github.com/foo/bar/tree/main/a.user.js'),
    'https://raw.githubusercontent.com/foo/bar/main/a.user.js',
  );
});

test('normalizeGithubInput leaves directory URLs and non-github inputs alone', async () => {
  // Directory URLs are kept as-is; the github-dir scanner consumes them.
  assert.equal(
    await normalizeGithubInput('https://github.com/foo/bar/tree/main/dir'),
    'https://github.com/foo/bar/tree/main/dir',
  );
  // Already-raw URLs pass through.
  assert.equal(
    await normalizeGithubInput('https://raw.githubusercontent.com/foo/bar/main/a.user.js'),
    'https://raw.githubusercontent.com/foo/bar/main/a.user.js',
  );
  // Non-github inputs pass through (no API call made).
  assert.equal(
    await normalizeGithubInput('https://example.com/a.user.js'),
    'https://example.com/a.user.js',
  );
  assert.equal(await normalizeGithubInput('/home/me/scripts'), '/home/me/scripts');
});

test('normalizeGithubInput resolves a bare repo URL to /tree/<default-branch>', async () => {
  // A bare `https://github.com/<o>/<r>` URL is the form the user gets
  // from the repo's landing page. We resolve the default branch via the
  // repo metadata endpoint and bake it into the stored source path so
  // the rest of the pipeline (which assumes an explicit ref) works.
  let captured = null;
  const fakeFetch = async (url) => {
    captured = url;
    return {
      ok: true,
      status: 200,
      json: async () => ({ default_branch: 'main' }),
    };
  };
  const result = await withFetch(fakeFetch, () =>
    normalizeGithubInput('https://github.com/foo/bar'),
  );
  assert.equal(result, 'https://github.com/foo/bar/tree/main');
  assert.equal(captured, 'https://api.github.com/repos/foo/bar');
});

test('normalizeGithubInput strips a trailing slash and .git on bare repo URLs', async () => {
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ default_branch: 'master' }),
  });
  assert.equal(
    await withFetch(fakeFetch, () =>
      normalizeGithubInput('https://github.com/foo/bar/'),
    ),
    'https://github.com/foo/bar/tree/master',
  );
  assert.equal(
    await withFetch(fakeFetch, () =>
      normalizeGithubInput('https://github.com/foo/bar.git'),
    ),
    'https://github.com/foo/bar/tree/master',
  );
});

test('normalizeGithubInput surfaces a clear error when the repo metadata fetch fails', async () => {
  // 404 (private repo / typo) and 403 (rate limit) both surface here.
  const fakeFetch = async () => ({
    ok: false,
    status: 404,
    json: async () => ({}),
  });
  await assert.rejects(
    withFetch(fakeFetch, () =>
      normalizeGithubInput('https://github.com/foo/bar'),
    ),
    /HTTP 404/,
  );
});

test('normalizeGithubInput appends a private-repo hint on 404', async () => {
  // The hint is the difference between "scary opaque 404" and "ah, this
  // repo is private / I have a typo" — worth pinning in a test.
  const fakeFetch = async () => ({
    ok: false,
    status: 404,
    json: async () => ({}),
  });
  await assert.rejects(
    withFetch(fakeFetch, () =>
      normalizeGithubInput('https://github.com/foo/bar'),
    ),
    /repo is private/,
  );
});

test('normalizeGithubInput rejects a bare repo with no default_branch in the metadata', async () => {
  // Defensive: GitHub always returns default_branch, but if a future
  // response shape drops the field we want a clean error, not an
  // undefined ref baked into the stored URL.
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({}),
  });
  await assert.rejects(
    withFetch(fakeFetch, () =>
      normalizeGithubInput('https://github.com/foo/bar'),
    ),
    /missing default_branch/,
  );
});

// ---------- scanGithubDir ----------

test('scanGithubDir walks dirs via the Contents API and returns .user.js entries', async () => {
  // Stub fetch and record every API URL the scanner asks for. Returns a
  // fake listing where the root contains one .user.js file plus a
  // subdirectory, and the subdir contains another .user.js — both are
  // expected in the flat result, sorted by relativePath.
  const calls = [];
  const fakeFetch = async (url) => {
    calls.push(url);
    if (url.startsWith('https://api.github.com/repos/foo/bar/contents/dir?')) {
      return {
        ok: true,
        status: 200,
        json: async () => [
          { type: 'file', name: 'top.user.js', path: 'dir/top.user.js', size: 100 },
          { type: 'file', name: 'README.md', path: 'dir/README.md', size: 50 },
          { type: 'dir', name: 'sub', path: 'dir/sub' },
        ],
      };
    }
    if (url.startsWith('https://api.github.com/repos/foo/bar/contents/dir/sub?')) {
      return {
        ok: true,
        status: 200,
        json: async () => [
          { type: 'file', name: 'inner.user.js', path: 'dir/sub/inner.user.js', size: 200 },
        ],
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const result = await withFetch(fakeFetch, () =>
    scanGithubDir('https://github.com/foo/bar/tree/main/dir'),
  );
  assert.deepEqual(result, [
    { name: 'inner.user.js', relativePath: 'sub/inner.user.js', size: 200 },
    { name: 'top.user.js', relativePath: 'top.user.js', size: 100 },
  ]);
  // Both directories were walked, in order (root then subdir).
  assert.equal(calls.length, 2);
  assert.ok(calls[0].includes('/contents/dir?ref=main'));
  assert.ok(calls[1].includes('/contents/dir/sub?ref=main'));
});

test('scanGithubDir surfaces a clear error when the API returns a non-array', async () => {
  // The Contents API returns an object (not an array) when the URL
  // points at a single file. The scanner should reject with a message
  // naming the API URL so the user sees what failed.
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ type: 'file', name: 'x' }),
  });
  await assert.rejects(
    withFetch(fakeFetch, () =>
      scanGithubDir('https://github.com/foo/bar/tree/main/dir'),
    ),
    /did not return a directory listing/,
  );
});

test('scanGithubDir surfaces HTTP errors from the Contents API with a rate-limit hint on 403', async () => {
  // Rate limit / not found / private repo all hit this branch.
  const fakeFetch = async () => ({
    ok: false,
    status: 403,
    json: async () => ({ message: 'rate limit' }),
  });
  await assert.rejects(
    withFetch(fakeFetch, () =>
      scanGithubDir('https://github.com/foo/bar/tree/main/dir'),
    ),
    /HTTP 403.*rate limit/,
  );
});
