// Tests for the directory-listing parser and path/URL helpers in
// src/directories.ts (compiled to dist/directories.js).
//
// parseListing is the part most likely to silently rot: Chrome's
// directory-listing HTML is an undocumented format, so the sample
// HTML below mirrors the addRow(...) shape we've observed and
// regression-guards the regex against accidental tightening.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  fetchHttpText,
  parseListing,
  parseManifest,
  pathToFileUrl,
  joinPath,
  scriptFileUrl,
  scriptAbsolutePath,
  isHttpUrl,
  isFileUrl,
  isSingleFileSource,
  isManifestSource,
  sourceCanonicalUrl,
  sourceFsPath,
  parentDir,
  baseName,
} from '../../dist/directories.js';

test('parseListing extracts files and directories, skipping ..', () => {
  const html = `
    <script>start("/home/me/scripts/");</script>
    <script>addRow("..", ".", 1, 0, "", 0, "");</script>
    <script>addRow("foo.user.js", "foo.user.js", 0, 1234, "1 KB", 5678, "date");</script>
    <script>addRow("sub", "sub/", 1, 0, "", 0, "");</script>
    <script>addRow("readme.md", "readme.md", 0, 9, "9 B", 1, "date");</script>
  `;
  const entries = parseListing(html);
  assert.deepEqual(entries, [
    { name: 'foo.user.js', isDir: false, size: 1234, mtime: 5678 },
    { name: 'sub', isDir: true, size: 0, mtime: 0 },
    { name: 'readme.md', isDir: false, size: 9, mtime: 1 },
  ]);
});

test('parseListing tolerates rows without size/mtime', () => {
  // Some older Chrome builds emitted shorter addRow calls. The refresh
  // pipeline copes with missing size/mtime by falling back to always-
  // refetch, so the parser must just leave the fields undefined.
  const html = `
    <script>addRow("a.user.js", "a.user.js", 0);</script>
    <script>addRow("b.user.js", "b.user.js", 0, 100);</script>
  `;
  assert.deepEqual(parseListing(html), [
    { name: 'a.user.js', isDir: false },
    { name: 'b.user.js', isDir: false, size: 100 },
  ]);
});

test('parseListing accepts true/false for the isdir argument', () => {
  const html = `
    <script>addRow("a.user.js", "a.user.js", false, 1, "1", 1, "d");</script>
    <script>addRow("dir", "dir/", true, 0, "", 0, "");</script>
  `;
  assert.deepEqual(parseListing(html), [
    { name: 'a.user.js', isDir: false, size: 1, mtime: 1 },
    { name: 'dir', isDir: true, size: 0, mtime: 0 },
  ]);
});

test('parseListing decodes escaped names', () => {
  const html = `<script>addRow("with \\"quote\\".user.js", "x", 0, 1, "1", 1, "d");</script>`;
  assert.deepEqual(parseListing(html), [
    { name: 'with "quote".user.js', isDir: false, size: 1, mtime: 1 },
  ]);
});

test('parseListing returns [] on unrelated HTML', () => {
  assert.deepEqual(parseListing('<html><body>nothing here</body></html>'), []);
});

test('pathToFileUrl percent-encodes segments and strips trailing slash', () => {
  assert.equal(pathToFileUrl('/home/me/my scripts/'), 'file:///home/me/my%20scripts');
  assert.equal(pathToFileUrl('/a/b'), 'file:///a/b');
});

test('joinPath strips trailing slashes on the base', () => {
  assert.equal(joinPath('/a/b/', 'c'), '/a/b/c');
  assert.equal(joinPath('/a/b', 'c/d'), '/a/b/c/d');
});

test('scriptFileUrl joins dir + relative and encodes the result', () => {
  assert.equal(
    scriptFileUrl('/home/me/scripts', 'sub/foo bar.user.js'),
    'file:///home/me/scripts/sub/foo%20bar.user.js',
  );
});

test('isSingleFileSource matches *.user.js across all schemes', () => {
  // Scheme-agnostic companion to isManifestSource. Local paths,
  // file:// URLs, and http(s) URLs all classify the same — callers
  // that genuinely care about scheme combine with isHttpUrl.
  assert.equal(isSingleFileSource('/home/me/foo.user.js'), true);
  assert.equal(isSingleFileSource('file:///home/me/foo.user.js'), true);
  assert.equal(isSingleFileSource('file:///home/me/my%20scripts/foo.user.js'), true);
  assert.equal(isSingleFileSource('https://x/foo.user.js'), true);
  assert.equal(isSingleFileSource('https://x/foo.user.js?v=2'), true);
  assert.equal(isSingleFileSource('http://x/foo.user.js#frag'), true);
  // Non-matches
  assert.equal(isSingleFileSource('/home/me/scripts'), false);
  assert.equal(isSingleFileSource('/home/me/notes.txt'), false);
  assert.equal(isSingleFileSource('https://x/manifest.json'), false);
  assert.equal(isSingleFileSource('file:///home/me/scripts'), false);
});

test('sourceFsPath strips file:// and percent-decodes the path', () => {
  assert.equal(sourceFsPath('/home/me/foo.user.js'), '/home/me/foo.user.js');
  assert.equal(sourceFsPath('file:///home/me/foo.user.js'), '/home/me/foo.user.js');
  assert.equal(
    sourceFsPath('file:///home/me/my%20scripts/foo.user.js'),
    '/home/me/my scripts/foo.user.js',
  );
  // HTTP URLs are not local; they pass through untouched so callers
  // that mistakenly hand one in get a non-fatal but obviously-wrong
  // value (the URL string) rather than a silent decode.
  assert.equal(sourceFsPath('https://x/foo.user.js'), 'https://x/foo.user.js');
});

test('scriptFileUrl round-trips a file:// single-file source through pathToFileUrl', () => {
  // The user's original bug report: adding a file:// .user.js source
  // was failing because parentDir/pathToFileUrl mangled the URL form.
  // After the fix, scriptFileUrl converts to a raw path internally
  // and emits the proper file:// URL.
  assert.equal(
    scriptFileUrl('file:///home/me/foo.user.js', 'foo.user.js'),
    'file:///home/me/foo.user.js',
  );
  // Percent-encoded names round-trip via decode-then-re-encode.
  assert.equal(
    scriptFileUrl('file:///home/me/my%20scripts/foo%20bar.user.js', 'foo bar.user.js'),
    'file:///home/me/my%20scripts/foo%20bar.user.js',
  );
});

test('scriptAbsolutePath returns the bare fs path for file:// local sources', () => {
  // Display in the viewer's Location row: a percent-encoded URL is
  // harder to read than the on-disk path, so we show the path.
  assert.equal(
    scriptAbsolutePath('file:///home/me/foo.user.js', 'foo.user.js'),
    '/home/me/foo.user.js',
  );
  assert.equal(
    scriptAbsolutePath('file:///home/me/scripts', 'sub/foo.user.js'),
    '/home/me/scripts/sub/foo.user.js',
  );
});

test('parentDir and baseName split an absolute path', () => {
  assert.equal(parentDir('/home/me/foo.user.js'), '/home/me');
  assert.equal(baseName('/home/me/foo.user.js'), 'foo.user.js');
  // Top-level path keeps `/` as parent.
  assert.equal(parentDir('/foo.user.js'), '/');
  assert.equal(baseName('/foo.user.js'), 'foo.user.js');
});

test('scriptFileUrl uses the source path verbatim for a single-file source', () => {
  // relativePath equals the basename, so the directory-style join
  // would double the filename — the single-file branch returns the
  // source path's URL directly.
  assert.equal(
    scriptFileUrl('/home/me/foo bar.user.js', 'foo bar.user.js'),
    'file:///home/me/foo%20bar.user.js',
  );
});

test('scriptAbsolutePath returns the source path for a single-file source', () => {
  // Shared by scriptFileUrl and the viewer's Location row so both
  // representations of the file's location stay in lock-step.
  assert.equal(
    scriptAbsolutePath('/home/me/foo.user.js', 'foo.user.js'),
    '/home/me/foo.user.js',
  );
  assert.equal(
    scriptAbsolutePath('/home/me/scripts', 'sub/foo.user.js'),
    '/home/me/scripts/sub/foo.user.js',
  );
});

// ---------- HTTP source detection ----------

test('isHttpUrl is true for http and https, false for file/path', () => {
  assert.equal(isHttpUrl('http://example.com/foo.user.js'), true);
  assert.equal(isHttpUrl('https://example.com/foo.user.js'), true);
  // Scheme detection is case-insensitive (the URL itself may not be).
  assert.equal(isHttpUrl('HTTPS://example.com/foo.user.js'), true);
  assert.equal(isHttpUrl('file:///tmp/foo.user.js'), false);
  assert.equal(isHttpUrl('/home/me/foo.user.js'), false);
  assert.equal(isHttpUrl(''), false);
});


test('isManifestSource matches .json URLs/paths regardless of scheme or query', () => {
  // Manifest support is scheme-agnostic: anything with a .json
  // pathname counts so the same manifest file can be tested locally
  // and then served over HTTP without changing the source kind.
  assert.equal(isManifestSource('https://x/manifest.json'), true);
  assert.equal(isManifestSource('http://x/manifest.json'), true);
  assert.equal(isManifestSource('https://x/sub/list.json?branch=main'), true);
  assert.equal(isManifestSource('file:///home/me/manifest.json'), true);
  assert.equal(isManifestSource('/home/me/manifest.json'), true);
  assert.equal(isManifestSource('https://x/foo.user.js'), false);
  assert.equal(isManifestSource('/home/me/scripts'), false);
});

test('isFileUrl recognises file:// URLs', () => {
  assert.equal(isFileUrl('file:///home/me/manifest.json'), true);
  assert.equal(isFileUrl('FILE:///etc/passwd'), true);
  assert.equal(isFileUrl('https://x/foo.json'), false);
  assert.equal(isFileUrl('/local/foo.json'), false);
});

test('sourceCanonicalUrl normalises raw paths to file:// URLs and passes URLs through', () => {
  // Used as the base for new URL(entry, base) when resolving manifest
  // entries, so a local manifest's relative paths resolve correctly.
  assert.equal(
    sourceCanonicalUrl('/home/me/scripts/manifest.json'),
    'file:///home/me/scripts/manifest.json',
  );
  assert.equal(
    sourceCanonicalUrl('file:///already/url.json'),
    'file:///already/url.json',
  );
  assert.equal(
    sourceCanonicalUrl('https://example.com/manifest.json'),
    'https://example.com/manifest.json',
  );
});

// ---------- HTTP URL builders ----------

test('scriptFileUrl returns the source URL verbatim for an HTTP single-file source', () => {
  // relativePath is just the basename for display; the actual URL to
  // fetch is the source URL itself.
  assert.equal(
    scriptFileUrl('https://example.com/dir/foo.user.js', 'foo.user.js'),
    'https://example.com/dir/foo.user.js',
  );
});

test('scriptFileUrl resolves manifest entries relative to the manifest URL', () => {
  // A bare filename inside a manifest resolves against the manifest's
  // *parent* path — same semantics as RFC 3986 relative resolution.
  assert.equal(
    scriptFileUrl('https://example.com/scripts/manifest.json', 'foo.user.js'),
    'https://example.com/scripts/foo.user.js',
  );
  // Absolute URLs in the manifest pass through unchanged.
  assert.equal(
    scriptFileUrl(
      'https://example.com/scripts/manifest.json',
      'https://other.example.com/bar.user.js',
    ),
    'https://other.example.com/bar.user.js',
  );
  // Subdirectory entries resolve relative to the manifest too.
  assert.equal(
    scriptFileUrl('https://example.com/scripts/manifest.json', 'sub/baz.user.js'),
    'https://example.com/scripts/sub/baz.user.js',
  );
});

test('scriptAbsolutePath returns the resolved URL for HTTP sources', () => {
  // The viewer's Location row reads this, so it must work for URLs too.
  assert.equal(
    scriptAbsolutePath('https://example.com/foo.user.js', 'foo.user.js'),
    'https://example.com/foo.user.js',
  );
  assert.equal(
    scriptAbsolutePath('https://example.com/scripts/manifest.json', 'foo.user.js'),
    'https://example.com/scripts/foo.user.js',
  );
});

test('scriptFileUrl resolves entries against a local manifest path', () => {
  // The whole point of accepting local manifests: the same JSON file
  // works when added locally and when later served over HTTP.
  // Relative entries resolve against the manifest's parent dir.
  assert.equal(
    scriptFileUrl('/home/me/scripts/manifest.json', 'foo.user.js'),
    'file:///home/me/scripts/foo.user.js',
  );
  // Subdirectory entries.
  assert.equal(
    scriptFileUrl('/home/me/scripts/manifest.json', 'sub/bar.user.js'),
    'file:///home/me/scripts/sub/bar.user.js',
  );
  // Absolute HTTP entries inside a local manifest are honoured —
  // useful for "host most scripts locally, pull one off the web".
  assert.equal(
    scriptFileUrl(
      '/home/me/scripts/manifest.json',
      'https://elsewhere.example.com/baz.user.js',
    ),
    'https://elsewhere.example.com/baz.user.js',
  );
});

test('scriptFileUrl resolves entries against a file:// manifest URL', () => {
  // file:// input form should behave identically to a bare path.
  assert.equal(
    scriptFileUrl('file:///home/me/scripts/manifest.json', 'foo.user.js'),
    'file:///home/me/scripts/foo.user.js',
  );
});

test('scriptAbsolutePath shows the resolved fs path for local manifest entries', () => {
  // For consistency with other local sources, the viewer's Location
  // row shows the bare on-disk path — not the file:// URL form. This
  // is the same display rule that local directories and local
  // single-file sources use.
  assert.equal(
    scriptAbsolutePath('/home/me/scripts/manifest.json', 'foo.user.js'),
    '/home/me/scripts/foo.user.js',
  );
  // file:// manifest input form gives the same result.
  assert.equal(
    scriptAbsolutePath('file:///home/me/scripts/manifest.json', 'foo.user.js'),
    '/home/me/scripts/foo.user.js',
  );
  // An HTTPS entry inside a local manifest still surfaces as the URL,
  // because that's where it actually lives.
  assert.equal(
    scriptAbsolutePath(
      '/home/me/scripts/manifest.json',
      'https://elsewhere.example.com/baz.user.js',
    ),
    'https://elsewhere.example.com/baz.user.js',
  );
});

// ---------- Manifest parser ----------

test('parseManifest accepts a bare JSON array of strings', () => {
  assert.deepEqual(
    parseManifest('["a.user.js", "b.user.js"]'),
    ['a.user.js', 'b.user.js'],
  );
});

test('parseManifest accepts a {scripts: [...]} object', () => {
  assert.deepEqual(
    parseManifest('{"scripts": ["a.user.js", "b.user.js"]}'),
    ['a.user.js', 'b.user.js'],
  );
});

test('parseManifest trims entries and skips empty strings', () => {
  assert.deepEqual(
    parseManifest('["  a.user.js  ", "", "b.user.js"]'),
    ['a.user.js', 'b.user.js'],
  );
});

test('parseManifest rejects non-JSON input with a helpful message', () => {
  assert.throws(
    () => parseManifest('not json'),
    /manifest is not valid JSON/,
  );
});

test('parseManifest rejects shapes other than array / {scripts: ...}', () => {
  assert.throws(
    () => parseManifest('{"items": []}'),
    /JSON array of URL strings/,
  );
});

test('parseManifest rejects non-string entries', () => {
  assert.throws(
    () => parseManifest('["a.user.js", 42]'),
    /entries must all be strings/,
  );
});

test('parseManifest accepts any string entry — scheme gating happens at scanManifest', () => {
  // parseManifest is just JSON-shape validation; the actual scheme
  // allowlist (http/https/file) is enforced later by scanManifest
  // after URL resolution, so weird-scheme strings here parse fine.
  // The two-stage split keeps parseManifest a pure JSON helper.
  assert.deepEqual(
    parseManifest('["foo.user.js", "data:text/javascript,evil"]'),
    ['foo.user.js', 'data:text/javascript,evil'],
  );
});

test('parseManifest returns [] for an empty list (both shapes)', () => {
  // Behaviorally: rebuildSource will tag every previously-known script
  // as missing on the next refresh, which is the right behavior — the
  // manifest is the source of truth.
  assert.deepEqual(parseManifest('[]'), []);
  assert.deepEqual(parseManifest('{"scripts": []}'), []);
});

// ---------- fetchHttpText ----------
//
// Stubs globalThis.fetch so we can exercise the conditional-GET
// branches without a real server. This is the most load-bearing new
// HTTP-side code (everything downstream trusts the result shape), so
// each branch gets a direct test.

function withFetch(impl, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return fn();
  } finally {
    globalThis.fetch = original;
  }
}

// Build a Response-shape good enough for fetchHttpText: status,
// headers.get(), and text(). The full Response constructor isn't
// needed and avoids a dependency on undici quirks.
function fakeResponse({ status, headers = {}, body = '' }) {
  const lowerHeaders = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k) => lowerHeaders.get(k.toLowerCase()) ?? null },
    text: async () => body,
  };
}

test('fetchHttpText: 200 with ETag + Last-Modified surfaces both validators', async () => {
  let captured = null;
  const fakeFetch = async (url, init) => {
    captured = { url, init };
    return fakeResponse({
      status: 200,
      headers: { ETag: 'W/"abc"', 'Last-Modified': 'Wed, 21 Oct 2025 07:28:00 GMT' },
      body: 'console.log("hi");',
    });
  };
  const result = await withFetch(fakeFetch, () => fetchHttpText('https://x/foo.user.js'));
  assert.equal(result.kind, 'ok');
  assert.equal(result.text, 'console.log("hi");');
  assert.equal(result.etag, 'W/"abc"');
  assert.equal(result.lastModified, 'Wed, 21 Oct 2025 07:28:00 GMT');
  // No prior validators → no conditional headers sent. cache: 'no-store'
  // is what keeps the browser cache from short-circuiting our own logic.
  assert.equal(captured.init.cache, 'no-store');
  assert.deepEqual(captured.init.headers, {});
});

test('fetchHttpText: 200 without validators returns text but no etag/lastModified', async () => {
  const fakeFetch = async () => fakeResponse({ status: 200, body: 'body' });
  const result = await withFetch(fakeFetch, () => fetchHttpText('https://x/foo.user.js'));
  assert.equal(result.kind, 'ok');
  assert.equal(result.text, 'body');
  assert.equal(result.etag, undefined);
  assert.equal(result.lastModified, undefined);
});

test('fetchHttpText: 304 → unchanged, and prior validators round-trip into request headers', async () => {
  let captured = null;
  const fakeFetch = async (url, init) => {
    captured = { url, init };
    return fakeResponse({ status: 304 });
  };
  const result = await withFetch(fakeFetch, () => fetchHttpText('https://x/foo.user.js', {
    etag: 'W/"abc"',
    lastModified: 'Wed, 21 Oct 2025 07:28:00 GMT',
  }));
  assert.equal(result.kind, 'unchanged');
  assert.equal(captured.init.headers['If-None-Match'], 'W/"abc"');
  assert.equal(captured.init.headers['If-Modified-Since'], 'Wed, 21 Oct 2025 07:28:00 GMT');
});

test('fetchHttpText: non-ok status throws with the HTTP code in the message', async () => {
  const fakeFetch = async () => fakeResponse({ status: 404 });
  await assert.rejects(
    withFetch(fakeFetch, () => fetchHttpText('https://x/missing.user.js')),
    /HTTP 404/,
  );
});

test('fetchHttpText: a thrown fetch surfaces as a network-error message', async () => {
  const fakeFetch = async () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(
    withFetch(fakeFetch, () => fetchHttpText('https://x/foo.user.js')),
    /network error fetching .*: Failed to fetch/,
  );
});
