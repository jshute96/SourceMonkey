// Tests for src/extension/github-provider.ts (compiled to dist/extension/github-provider.js):
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

import { githubRawToBlobUrl } from '../../dist/github-urls.js';
import {
  isGithubDirCollection,
  normalizeGithubInput,
  parseGithubUrl,
  scanGithubDir,
} from '../../dist/extension/github-provider.js';
import { _setGithubAuthTokenForTests } from '../../dist/github-auth.js';

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

// ---------- isGithubDirCollection ----------

test('isGithubDirCollection recognises directory URLs and rejects file URLs', () => {
  // Canonical: /tree/<ref>/<dir>
  assert.equal(isGithubDirCollection('https://github.com/foo/bar/tree/main/dir'), true);
  // Repo-root-at-ref.
  assert.equal(isGithubDirCollection('https://github.com/foo/bar/tree/main'), true);
  // Tolerated: a /blob/<ref>/<dir> URL (user editing a blob URL by hand).
  assert.equal(isGithubDirCollection('https://github.com/foo/bar/blob/main/dir'), true);
  // File URLs are NOT directory collections — normalizeGithubInput rewrites
  // these to raw before they reach the collection-kind dispatch.
  assert.equal(isGithubDirCollection('https://github.com/foo/bar/blob/main/a.user.js'), false);
  assert.equal(isGithubDirCollection('https://github.com/foo/bar/blob/main/script_manifest.json'), false);
  // An arbitrary `.json` file is NOT a recognised manifest filename, so
  // it's treated as a directory (a later scan attempt will surface the
  // mismatch). The fixed manifest filename is the only one we honor.
  assert.equal(isGithubDirCollection('https://github.com/foo/bar/blob/main/other.json'), true);
  // Non-github URLs always classify as non-dir.
  assert.equal(isGithubDirCollection('https://example.com/dir'), false);
  assert.equal(isGithubDirCollection('/home/me/scripts'), false);
});

// ---------- normalizeGithubInput ----------

test('normalizeGithubInput rewrites github blob URLs of .user.js / script_manifest.json to raw', async () => {
  assert.equal(
    await normalizeGithubInput('https://github.com/foo/bar/blob/main/dir/script.user.js'),
    'https://raw.githubusercontent.com/foo/bar/main/dir/script.user.js',
  );
  // Manifest files get the same treatment — the user shouldn't have to
  // hand-edit the URL to point at raw.githubusercontent.com. Only the
  // fixed `script_manifest.json` basename is recognised; arbitrary
  // .json files are left alone.
  assert.equal(
    await normalizeGithubInput('https://github.com/foo/bar/blob/main/script_manifest.json'),
    'https://raw.githubusercontent.com/foo/bar/main/script_manifest.json',
  );
  assert.equal(
    await normalizeGithubInput('https://github.com/foo/bar/blob/main/dir/script_manifest.json'),
    'https://raw.githubusercontent.com/foo/bar/main/dir/script_manifest.json',
  );
  // tree URLs work too (a user might paste a /tree/ URL of a file).
  assert.equal(
    await normalizeGithubInput('https://github.com/foo/bar/tree/main/a.user.js'),
    'https://raw.githubusercontent.com/foo/bar/main/a.user.js',
  );
  // A blob URL of an arbitrary .json file is NOT rewritten — it's not
  // a recognised file shape, so it falls through and downstream
  // classification treats it as a github directory collection.
  assert.equal(
    await normalizeGithubInput('https://github.com/foo/bar/blob/main/other.json'),
    'https://github.com/foo/bar/blob/main/other.json',
  );
  // A filename that *suffix-matches* `script_manifest.json` but isn't
  // preceded by a `/` (so the basename is something else) is not a
  // manifest. Pins the `'/' + MANIFEST_FILENAME` guard in
  // isGithubFilePath against an accidental bare endsWith.
  assert.equal(
    await normalizeGithubInput('https://github.com/foo/bar/blob/main/nope_script_manifest.json'),
    'https://github.com/foo/bar/blob/main/nope_script_manifest.json',
  );
  assert.equal(
    isGithubDirCollection('https://github.com/foo/bar/blob/main/nope_script_manifest.json'),
    true,
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
  // repo metadata endpoint and bake it into the stored collection path so
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
    // No token configured → hint points at the Options page so the
    // user has a concrete next step rather than a dead end.
    /set a GitHub token on the Options page/,
  );
});

test('normalizeGithubInput hint differs when a token is already configured', async () => {
  // With a token set, "private repo" or "rate limit" advice would be
  // wrong/stale — the user already has auth, so the failure is about
  // the token's access scope. Verify the copy adapts on each status.
  _setGithubAuthTokenForTests('ghp_x');
  try {
    const make = (status) => async () => ({ ok: false, status, json: async () => ({}) });

    // 404 with token: "token can't see this repo"
    await assert.rejects(
      withFetch(make(404), () => normalizeGithubInput('https://github.com/foo/bar')),
      /your token can't see this repo/,
    );

    // 403 with token: scope / rate-limit (5000/hr)
    await assert.rejects(
      withFetch(make(403), () => normalizeGithubInput('https://github.com/foo/bar')),
      /5000\/hour/,
    );

    // 401: token rejected
    await assert.rejects(
      withFetch(make(401), () => normalizeGithubInput('https://github.com/foo/bar')),
      /token rejected/,
    );

    // 429: rate-limit explicit. Hint should mirror 403's "rate limit" guidance.
    await assert.rejects(
      withFetch(make(429), () => normalizeGithubInput('https://github.com/foo/bar')),
      /rate limit/,
    );
  } finally {
    _setGithubAuthTokenForTests('');
  }
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
    /did not report the repo's default branch/,
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
    /not a folder in the repo/,
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

// ---------- githubRawToBlobUrl ----------

test('githubRawToBlobUrl converts a raw URL to its github.com blob URL', () => {
  assert.equal(
    githubRawToBlobUrl('https://raw.githubusercontent.com/owner/repo/main/foo.user.js'),
    'https://github.com/owner/repo/blob/main/foo.user.js',
  );
});

test('githubRawToBlobUrl handles the new-style /refs/heads/<branch>/ shape', () => {
  assert.equal(
    githubRawToBlobUrl('https://raw.githubusercontent.com/owner/repo/refs/heads/main/sub/foo.user.js'),
    'https://github.com/owner/repo/blob/main/sub/foo.user.js',
  );
});

test('githubRawToBlobUrl handles refs/tags/<tag>/ shape', () => {
  // GitHub's blob route accepts tag refs the same way it accepts
  // branch refs, so the conversion is symmetric.
  assert.equal(
    githubRawToBlobUrl('https://raw.githubusercontent.com/owner/repo/refs/tags/v1.2.3/foo.user.js'),
    'https://github.com/owner/repo/blob/v1.2.3/foo.user.js',
  );
});

test('githubRawToBlobUrl handles the github.com/<o>/<r>/raw/ shape', () => {
  // The "Raw" button on github.com produces this form. It 302s to
  // raw.githubusercontent.com, but we may store / resolve URLs in
  // this shape (notably for github-manifest collections whose stored
  // path is `github.com/.../raw/refs/heads/main/script_manifest.json`).
  assert.equal(
    githubRawToBlobUrl('https://github.com/owner/repo/raw/refs/heads/main/foo.user.js'),
    'https://github.com/owner/repo/blob/main/foo.user.js',
  );
  // Manifest collection itself.
  assert.equal(
    githubRawToBlobUrl('https://github.com/owner/repo/raw/refs/heads/main/script_manifest.json'),
    'https://github.com/owner/repo/blob/main/script_manifest.json',
  );
  // Legacy /raw/<ref>/ shape (no /refs/heads/).
  assert.equal(
    githubRawToBlobUrl('https://github.com/owner/repo/raw/main/foo.user.js'),
    'https://github.com/owner/repo/blob/main/foo.user.js',
  );
});

test('githubRawToBlobUrl strips a trailing query string', () => {
  // The github.com page doesn't carry the raw URL's `?token=…`, so we
  // drop it. Hash too — fragments are not meaningful on a blob page.
  assert.equal(
    githubRawToBlobUrl('https://raw.githubusercontent.com/o/r/main/foo.user.js?token=abc'),
    'https://github.com/o/r/blob/main/foo.user.js',
  );
});

test('githubRawToBlobUrl returns null for non-raw URLs', () => {
  assert.equal(githubRawToBlobUrl('https://github.com/owner/repo/blob/main/foo.user.js'), null);
  assert.equal(githubRawToBlobUrl('https://example.com/foo.user.js'), null);
  assert.equal(githubRawToBlobUrl('file:///home/me/foo.user.js'), null);
});
