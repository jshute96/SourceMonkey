// Tests for src/github-auth.ts (compiled to dist/github-auth.js):
// host-gated Authorization header attachment.
//
// `_setGithubAuthTokenForTests` lets us flip the cached token without
// touching `chrome.storage.local` — keeps the tests pure and avoids
// pulling in a chrome shim.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  _setGithubAuthTokenForTests,
  githubAuthHeaders,
  githubTokenLogSuffix,
  isGithubAuthInUseForSource,
  isGithubAuthUrl,
} from '../../dist/github-auth.js';

test('isGithubAuthUrl recognises the two GitHub hosts the extension fetches from', () => {
  // api.github.com — repo metadata + Contents API.
  assert.equal(isGithubAuthUrl('https://api.github.com/repos/foo/bar'), true);
  // raw.githubusercontent.com — what blob URLs are rewritten to.
  assert.equal(isGithubAuthUrl('https://raw.githubusercontent.com/foo/bar/main/x.user.js'), true);
});

test('isGithubAuthUrl rejects every github.com route', () => {
  // github.com proper is intentionally excluded from the host gate.
  // The /raw/ route 302s to raw.githubusercontent.com and the Fetch
  // spec strips Authorization on cross-origin redirects, so auth
  // wouldn't survive anyway. Other github.com routes serve HTML and
  // the extension never fetches them directly.
  assert.equal(isGithubAuthUrl('https://github.com/foo/bar/raw/refs/heads/main/x.user.js'), false);
  assert.equal(isGithubAuthUrl('https://github.com/foo/bar/raw/main/x.user.js'), false);
  assert.equal(isGithubAuthUrl('https://github.com/foo/bar/blob/main/x.user.js'), false);
  assert.equal(isGithubAuthUrl('https://github.com/foo/bar/tree/main/dir'), false);
  assert.equal(isGithubAuthUrl('https://github.com/foo/bar'), false);
});

test('isGithubAuthUrl rejects non-GitHub hosts and bad inputs', () => {
  assert.equal(isGithubAuthUrl('https://example.com/foo'), false);
  assert.equal(isGithubAuthUrl('https://api.github.com.evil.com/foo'), false);
  assert.equal(isGithubAuthUrl('https://evil.com/api.github.com/foo'), false);
  assert.equal(isGithubAuthUrl('not a url'), false);
  assert.equal(isGithubAuthUrl('file:///home/me/foo.user.js'), false);
});

test('githubAuthHeaders returns Bearer + API-version headers for GitHub URLs when a token is set', () => {
  _setGithubAuthTokenForTests('ghp_testtoken');
  try {
    const h = githubAuthHeaders('https://api.github.com/repos/foo/bar');
    assert.equal(h.Authorization, 'Bearer ghp_testtoken');
    assert.equal(h['X-GitHub-Api-Version'], '2022-11-28');
  } finally {
    _setGithubAuthTokenForTests('');
  }
});

test('githubAuthHeaders returns an empty object when no token is set', () => {
  _setGithubAuthTokenForTests('');
  // Even for an authed-eligible host, no token means no header — the
  // unauthenticated path must remain reachable.
  assert.deepEqual(
    githubAuthHeaders('https://api.github.com/repos/foo/bar'),
    {},
  );
});

test('githubTokenLogSuffix annotates GitHub source URLs only when a token is set', () => {
  // No token → suffix is empty regardless of URL.
  _setGithubAuthTokenForTests('');
  assert.equal(githubTokenLogSuffix('https://github.com/foo/bar/tree/main'), '');
  assert.equal(githubTokenLogSuffix('https://raw.githubusercontent.com/foo/bar/main/x.user.js'), '');
  _setGithubAuthTokenForTests('ghp_x');
  try {
    // github-dir source path — the stored URL is a github.com page URL,
    // even though the actual fetches go to api.github.com / raw.
    // The suffix should still fire so the log makes it obvious the
    // refresh is using auth.
    assert.equal(
      githubTokenLogSuffix('https://github.com/foo/bar/tree/main/dir'),
      ' (with GitHub token)',
    );
    // Raw single-file or manifest source path (post-normalize form).
    assert.equal(
      githubTokenLogSuffix('https://raw.githubusercontent.com/foo/bar/main/x.user.js'),
      ' (with GitHub token)',
    );
    // Non-GitHub URLs never get the suffix even when a token is set.
    assert.equal(githubTokenLogSuffix('https://example.com/x.user.js'), '');
    assert.equal(githubTokenLogSuffix('/home/me/scripts'), '');
  } finally {
    _setGithubAuthTokenForTests('');
  }
});

test('isGithubAuthInUseForSource recognises github.com source paths even when the fetch goes via api/raw', () => {
  _setGithubAuthTokenForTests('ghp_x');
  try {
    // The github-dir source's stored URL is a github.com page URL —
    // not authed for direct fetch (we don't fetch HTML pages), but the
    // refresh underneath uses authed api.github.com + raw calls. The
    // for-source predicate has to recognise the page URL too.
    assert.equal(
      isGithubAuthInUseForSource('https://github.com/foo/bar/tree/main/dir'),
      true,
    );
    assert.equal(
      isGithubAuthInUseForSource('https://github.com/foo/bar'),
      true,
    );
  } finally {
    _setGithubAuthTokenForTests('');
  }
});

test('githubAuthHeaders never leaks the token to a non-GitHub host', () => {
  // Pinning this is the whole point of the host gate — a leaked PAT
  // can read user repos. If this assertion ever flips, treat it as a
  // security regression.
  _setGithubAuthTokenForTests('ghp_secret');
  try {
    assert.deepEqual(githubAuthHeaders('https://example.com/foo'), {});
    assert.deepEqual(githubAuthHeaders('https://github.com/foo/bar/blob/main/x.user.js'), {});
    assert.deepEqual(githubAuthHeaders('https://api.github.com.evil.com/repos/foo/bar'), {});
    assert.deepEqual(githubAuthHeaders('file:///home/me/foo.user.js'), {});
  } finally {
    _setGithubAuthTokenForTests('');
  }
});
