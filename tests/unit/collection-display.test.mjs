// Tests for src/collection-display.ts (compiled to dist/collection-display.js).
//
// Pure display helpers: collection-type classification, manifest detection,
// short-name inference, and the bubble label key.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  effectiveDisplayName,
  inferDisplayName,
  inferCollectionType,
  collectionBubbleKey,
  collectionClickUrl,
  collectionHasManifest,
  isSyntheticCollection,
  reservedNameOwner,
  mayUseReservedName,
} from '../../dist/collection-display.js';

// ---------- inferCollectionType ----------

test('inferCollectionType: file scheme + raw POSIX paths', () => {
  assert.equal(inferCollectionType('/home/me/scripts/foo.user.js'), 'file');
  assert.equal(inferCollectionType('file:///home/me/scripts/foo.user.js'), 'file');
  assert.equal(inferCollectionType('file:///home/me/scripts/'), 'file');
});

test('inferCollectionType: github.com + raw.githubusercontent.com classify as github', () => {
  assert.equal(
    inferCollectionType('https://github.com/Mottie/GitHub-userscripts/tree/master'),
    'github',
  );
  assert.equal(
    inferCollectionType('https://github.com/Mottie/GitHub-userscripts/blob/master/foo.user.js'),
    'github',
  );
  assert.equal(
    inferCollectionType('https://raw.githubusercontent.com/owner/repo/main/x.user.js'),
    'github',
  );
});

test('inferCollectionType: non-github http URLs classify as http', () => {
  assert.equal(inferCollectionType('https://example.com/foo.user.js'), 'http');
  assert.equal(inferCollectionType('http://example.com/script_manifest.json'), 'http');
});

// ---------- collectionHasManifest ----------

test('collectionHasManifest: true only for paths whose basename is script_manifest.json', () => {
  assert.equal(collectionHasManifest('/scripts/script_manifest.json'), true);
  assert.equal(collectionHasManifest('https://example.com/path/script_manifest.json'), true);
  assert.equal(collectionHasManifest('https://example.com/path/script_manifest.json?token=abc'), true);
  assert.equal(collectionHasManifest('/scripts/foo.user.js'), false);
  assert.equal(collectionHasManifest('https://github.com/owner/repo/tree/master'), false);
});

// ---------- collectionBubbleKey ----------

test('collectionBubbleKey: kind + scheme, and a bare `scripts` for containers', () => {
  assert.equal(collectionBubbleKey('/scripts'), 'file-dir');
  assert.equal(collectionBubbleKey('/scripts/script_manifest.json'), 'file-manifest');
  assert.equal(
    collectionBubbleKey('https://example.com/manifest-dir/script_manifest.json'),
    'http-manifest',
  );
  assert.equal(
    collectionBubbleKey('https://github.com/Mottie/GitHub-userscripts/tree/master'),
    'github-dir',
  );
  assert.equal(collectionBubbleKey('container:file'), 'scripts');
  assert.equal(collectionBubbleKey('container:http'), 'scripts');
  assert.equal(collectionBubbleKey('container:0d3d6b2e-1111-4222-8333-444455556666'), 'scripts');
  assert.equal(
    collectionBubbleKey('https://raw.githubusercontent.com/o/r/main/script_manifest.json'),
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
  const collection = {
    id: 'x', path: 'https://example.com/foo.user.js',
    lastRefreshedAt: 0, scriptIds: [], enabled: true,
    displayName: 'My Favourite Script',
  };
  assert.equal(effectiveDisplayName(collection), 'My Favourite Script');
});

test('effectiveDisplayName: falls back to inferred name when stored is empty', () => {
  const collection = {
    id: 'x', path: 'https://example.com/foo.user.js',
    lastRefreshedAt: 0, scriptIds: [], enabled: true,
  };
  assert.equal(effectiveDisplayName(collection), 'example.com/foo.user.js');
});

test('effectiveDisplayName: falls back to raw path when the inferred form would be empty', () => {
  // Bare manifest filename in the path: stripping the manifest suffix
  // leaves the empty string. The raw path is the safest last-resort
  // label for the UI.
  const collection = {
    id: 'x', path: 'script_manifest.json',
    lastRefreshedAt: 0, scriptIds: [], enabled: true,
  };
  assert.equal(effectiveDisplayName(collection), 'script_manifest.json');
});

// ---------- collectionClickUrl ----------

test('collectionClickUrl: http(s) and file:// URLs pass through; raw paths become file:// URLs', () => {
  assert.equal(collectionClickUrl('https://example.com/foo.user.js'), 'https://example.com/foo.user.js');
  assert.equal(collectionClickUrl('file:///home/me/foo.user.js'), 'file:///home/me/foo.user.js');
  assert.equal(collectionClickUrl('/home/me/foo.user.js'), 'file:///home/me/foo.user.js');
});

test('collectionClickUrl: github raw URLs convert to their github.com page URL', () => {
  // The stored path is the raw URL (post `normalizeGithubInput`), but
  // the bubble exists for humans to click — link them to the github
  // page, not the raw bytes. Both raw hosts (raw.githubusercontent.com
  // and the github.com/<o>/<r>/raw/ form) convert.
  assert.equal(
    collectionClickUrl('https://raw.githubusercontent.com/owner/repo/main/foo.user.js'),
    'https://github.com/owner/repo/blob/main/foo.user.js',
  );
  assert.equal(
    collectionClickUrl('https://github.com/owner/repo/raw/refs/heads/main/script_manifest.json'),
    'https://github.com/owner/repo/blob/main/script_manifest.json',
  );
  // /tree/<ref> URLs are already github.com pages; pass through.
  assert.equal(
    collectionClickUrl('https://github.com/owner/repo/tree/main'),
    'https://github.com/owner/repo/tree/main',
  );
});

// ---------- reserved names ----------

// The built-in defaults' names are reserved even before their rows
// exist, or a user collection could take one and the first install of
// that scheme would auto-create a second collection reading the same.
test('reservedNameOwner: the three built-in names, case- and space-insensitively', () => {
  assert.equal(reservedNameOwner('Scripts from local disk'), 'file');
  assert.equal(reservedNameOwner('  scripts from web  '), 'http');
  assert.equal(reservedNameOwner('SCRIPTS FROM GITHUB'), 'github');
  assert.equal(reservedNameOwner('Work'), null);
  assert.equal(reservedNameOwner(''), null);
});

test('mayUseReservedName: only the default that owns the name may carry it', () => {
  assert.equal(mayUseReservedName('Work', null), true);
  assert.equal(mayUseReservedName('Scripts from web', null), false);
  // The row that owns it keeps it — re-saving its own name is fine.
  assert.equal(mayUseReservedName('Scripts from web', 'container:http'), true);
  // Another collection may not take it.
  assert.equal(mayUseReservedName('Scripts from web', 'container:file'), false);
  assert.equal(mayUseReservedName('Scripts from web', 'container:uuid-1'), false);
});

// ---------- Import collections ----------

test('inferCollectionType: an import path is its own type, not a file path', () => {
  assert.equal(inferCollectionType('import:abc-123'), 'imported');
});

test('collectionBubbleKey: imported never carries the manifest suffix', () => {
  assert.equal(collectionBubbleKey('import:abc-123'), 'imported');
});

test('collectionClickUrl: an import collection has nothing to link to', () => {
  assert.equal(collectionClickUrl('import:abc-123'), null);
});

test('inferDisplayName: falls back to a readable name, never the raw path', () => {
  const name = inferDisplayName('import:abc-123');
  assert.doesNotMatch(name, /import:/);
  assert.equal(name, 'Imported scripts');
});

test('isSyntheticCollection: true for both pathless kinds, false for real locations', () => {
  assert.equal(isSyntheticCollection('import:abc-123'), true);
  assert.equal(isSyntheticCollection('container:file'), true);
  assert.equal(isSyntheticCollection('container:http'), true);
  assert.equal(isSyntheticCollection('/home/me/scripts'), false);
  assert.equal(isSyntheticCollection('https://example.com/script_manifest.json'), false);
});
