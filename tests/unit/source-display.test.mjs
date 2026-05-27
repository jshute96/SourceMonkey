// Tests for src/source-display.ts (compiled to dist/source-display.js).
//
// Pure display helpers: source-type classification, manifest detection,
// short-name inference, and the bubble label key.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  effectiveDisplayName,
  inferDisplayName,
  inferSourceType,
  sourceBubbleKey,
  sourceClickUrl,
  sourceHasManifest,
} from '../../dist/source-display.js';

// ---------- inferSourceType ----------

test('inferSourceType: file scheme + raw POSIX paths', () => {
  assert.equal(inferSourceType('/home/me/scripts/foo.user.js'), 'file');
  assert.equal(inferSourceType('file:///home/me/scripts/foo.user.js'), 'file');
  assert.equal(inferSourceType('file:///home/me/scripts/'), 'file');
});

test('inferSourceType: github.com + raw.githubusercontent.com classify as github', () => {
  assert.equal(
    inferSourceType('https://github.com/Mottie/GitHub-userscripts/tree/master'),
    'github',
  );
  assert.equal(
    inferSourceType('https://github.com/Mottie/GitHub-userscripts/blob/master/foo.user.js'),
    'github',
  );
  assert.equal(
    inferSourceType('https://raw.githubusercontent.com/owner/repo/main/x.user.js'),
    'github',
  );
});

test('inferSourceType: non-github http URLs classify as http', () => {
  assert.equal(inferSourceType('https://example.com/foo.user.js'), 'http');
  assert.equal(inferSourceType('http://example.com/script_manifest.json'), 'http');
});

// ---------- sourceHasManifest ----------

test('sourceHasManifest: true only for paths whose basename is script_manifest.json', () => {
  assert.equal(sourceHasManifest('/scripts/script_manifest.json'), true);
  assert.equal(sourceHasManifest('https://example.com/path/script_manifest.json'), true);
  assert.equal(sourceHasManifest('https://example.com/path/script_manifest.json?token=abc'), true);
  assert.equal(sourceHasManifest('/scripts/foo.user.js'), false);
  assert.equal(sourceHasManifest('https://github.com/owner/repo/tree/master'), false);
});

// ---------- sourceBubbleKey ----------

test('sourceBubbleKey: appends -manifest only for manifest sources', () => {
  assert.equal(sourceBubbleKey('/scripts/foo.user.js'), 'file');
  assert.equal(sourceBubbleKey('/scripts/script_manifest.json'), 'file-manifest');
  assert.equal(sourceBubbleKey('https://example.com/foo.user.js'), 'http');
  assert.equal(
    sourceBubbleKey('https://example.com/manifest-dir/script_manifest.json'),
    'http-manifest',
  );
  assert.equal(
    sourceBubbleKey('https://github.com/Mottie/GitHub-userscripts/tree/master'),
    'github',
  );
  assert.equal(
    sourceBubbleKey('https://raw.githubusercontent.com/o/r/main/script_manifest.json'),
    'github-manifest',
  );
});

// ---------- inferDisplayName ----------

test('inferDisplayName: github tree URL collapses to owner/repo', () => {
  // The user-supplied example: prefix + `/tree/<ref>` suffix both drop.
  assert.equal(
    inferDisplayName('https://github.com/Mottie/GitHub-userscripts/tree/master'),
    'Mottie/GitHub-userscripts',
  );
});

test('inferDisplayName: github tree URL with sub-path keeps the path', () => {
  assert.equal(
    inferDisplayName('https://github.com/owner/repo/tree/main/sub/dir'),
    'owner/repo/sub/dir',
  );
});

test('inferDisplayName: raw.githubusercontent.com strips the host', () => {
  assert.equal(
    inferDisplayName('https://raw.githubusercontent.com/Mottie/GitHub-userscripts/master/github-code-folding.user.js'),
    'Mottie/GitHub-userscripts/master/github-code-folding.user.js',
  );
});

test('inferDisplayName: github /raw/refs/heads/<branch>/... collapses to owner/repo/branch/path', () => {
  assert.equal(
    inferDisplayName('https://github.com/jshute96/userscripts/raw/refs/heads/main/sites/example.com/updated-script.user.js'),
    'jshute96/userscripts/main/sites/example.com/updated-script.user.js',
  );
});

test('inferDisplayName: github /blob/<ref>/<path> drops the literal "blob" segment', () => {
  assert.equal(
    inferDisplayName('https://github.com/owner/repo/blob/main/foo.user.js'),
    'owner/repo/main/foo.user.js',
  );
});

test('inferDisplayName: github tree URL with a literal "blob" directory under it is not re-consumed', () => {
  // Guards against a chain-rewrite hazard: tree rule rewrites
  // `owner/repo/tree/main/blob/foo` to `owner/repo/blob/foo`; if the
  // blob rule then re-ran, the literal `blob/` dir would be eaten and
  // we'd silently lose a path segment. Single-pass match avoids that.
  assert.equal(
    inferDisplayName('https://github.com/owner/repo/tree/main/blob/foo'),
    'owner/repo/blob/foo',
  );
});

test('inferDisplayName: strips a URL fragment before further trimming', () => {
  assert.equal(
    inferDisplayName('https://example.com/foo.user.js#install'),
    'example.com/foo.user.js',
  );
});

test('inferDisplayName: strips query string before further trimming', () => {
  assert.equal(
    inferDisplayName('https://example.com/path/script_manifest.json?token=abc&v=2'),
    'example.com/path',
  );
});

test('inferDisplayName: strips a trailing manifest filename', () => {
  assert.equal(
    inferDisplayName('https://example.com/dir/script_manifest.json'),
    'example.com/dir',
  );
  assert.equal(
    inferDisplayName('/local/dir/script_manifest.json'),
    '/local/dir',
  );
});

test('inferDisplayName: strips file:// protocol and trailing slash', () => {
  assert.equal(inferDisplayName('file:///home/me/scripts/'), '/home/me/scripts');
  assert.equal(inferDisplayName('file:///home/me/foo.user.js'), '/home/me/foo.user.js');
});

test('inferDisplayName: raw filesystem path passes through unchanged', () => {
  assert.equal(
    inferDisplayName('/home/me/scripts/foo.user.js'),
    '/home/me/scripts/foo.user.js',
  );
});

test('inferDisplayName: plain http URL just loses its scheme', () => {
  assert.equal(inferDisplayName('https://example.com/foo.user.js'), 'example.com/foo.user.js');
});

test('inferDisplayName: decodes percent-encoded characters (e.g. %20 → space)', () => {
  // GreasyFork URLs commonly include %20 in the script title segment.
  assert.equal(
    inferDisplayName('https://update.greasyfork.org/scripts/36834/OnePelotoncom%20Cycle%20Infinite%20Scroll.user.js'),
    'update.greasyfork.org/scripts/36834/OnePelotoncom Cycle Infinite Scroll.user.js',
  );
});

test('inferDisplayName: tolerates a malformed percent sequence', () => {
  // A bare `%` not followed by two hex digits would throw URIError if
  // we let decodeURIComponent run unchecked. The helper falls back to
  // the percent-encoded form so the name is still readable.
  assert.equal(inferDisplayName('https://example.com/100%-off.user.js'), 'example.com/100%-off.user.js');
});

// ---------- effectiveDisplayName ----------

test('effectiveDisplayName: prefers stored displayName when non-empty', () => {
  const source = {
    id: 'x', path: 'https://example.com/foo.user.js',
    lastRefreshedAt: 0, scriptIds: [], enabled: true,
    displayName: 'My Favourite Script',
  };
  assert.equal(effectiveDisplayName(source), 'My Favourite Script');
});

test('effectiveDisplayName: falls back to inferred name when stored is empty', () => {
  const source = {
    id: 'x', path: 'https://example.com/foo.user.js',
    lastRefreshedAt: 0, scriptIds: [], enabled: true,
  };
  assert.equal(effectiveDisplayName(source), 'example.com/foo.user.js');
});

test('effectiveDisplayName: falls back to raw path when the inferred form would be empty', () => {
  // Bare manifest filename in the path: stripping the manifest suffix
  // leaves the empty string. The raw path is the safest last-resort
  // label for the UI.
  const source = {
    id: 'x', path: 'script_manifest.json',
    lastRefreshedAt: 0, scriptIds: [], enabled: true,
  };
  assert.equal(effectiveDisplayName(source), 'script_manifest.json');
});

// ---------- sourceClickUrl ----------

test('sourceClickUrl: http(s) and file:// URLs pass through; raw paths become file:// URLs', () => {
  assert.equal(sourceClickUrl('https://example.com/foo.user.js'), 'https://example.com/foo.user.js');
  assert.equal(sourceClickUrl('file:///home/me/foo.user.js'), 'file:///home/me/foo.user.js');
  assert.equal(sourceClickUrl('/home/me/foo.user.js'), 'file:///home/me/foo.user.js');
});

test('sourceClickUrl: github raw URLs convert to their github.com page URL', () => {
  // The stored path is the raw URL (post `normalizeGithubInput`), but
  // the bubble exists for humans to click — link them to the github
  // page, not the raw bytes. Both raw hosts (raw.githubusercontent.com
  // and the github.com/<o>/<r>/raw/ form) convert.
  assert.equal(
    sourceClickUrl('https://raw.githubusercontent.com/owner/repo/main/foo.user.js'),
    'https://github.com/owner/repo/blob/main/foo.user.js',
  );
  assert.equal(
    sourceClickUrl('https://github.com/owner/repo/raw/refs/heads/main/script_manifest.json'),
    'https://github.com/owner/repo/blob/main/script_manifest.json',
  );
  // /tree/<ref> URLs are already github.com pages; pass through.
  assert.equal(
    sourceClickUrl('https://github.com/owner/repo/tree/main'),
    'https://github.com/owner/repo/tree/main',
  );
});
