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
  canonicalSourceInput,
  fetchHttpText,
  parseListing,
  parseManifest,
  pathToFileUrl,
  joinPath,
  resolveManifestEntryUrl,
  scriptFileUrl,
  scriptAbsolutePath,
  isHttpUrl,
  isFileUrl,
  isSingleFileInput,
  isContainerSource,
  containerKind,
  containerPath,
  containerKindForSingleFileInput,
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

test('isSingleFileInput matches *.user.js across all schemes', () => {
  // Single-file inputs no longer become top-level sources — they get
  // folded into the matching container source. This predicate is the
  // gate that routes addSource to the container path.
  assert.equal(isSingleFileInput('/home/me/foo.user.js'), true);
  assert.equal(isSingleFileInput('file:///home/me/foo.user.js'), true);
  assert.equal(isSingleFileInput('file:///home/me/my%20scripts/foo.user.js'), true);
  assert.equal(isSingleFileInput('https://x/foo.user.js'), true);
  assert.equal(isSingleFileInput('https://x/foo.user.js?v=2'), true);
  assert.equal(isSingleFileInput('http://x/foo.user.js#frag'), true);
  // Non-matches
  assert.equal(isSingleFileInput('/home/me/scripts'), false);
  assert.equal(isSingleFileInput('/home/me/notes.txt'), false);
  assert.equal(isSingleFileInput('https://x/script_manifest.json'), false);
  assert.equal(isSingleFileInput('file:///home/me/scripts'), false);
});

test('container helpers classify the three container kinds', () => {
  assert.equal(containerPath('file'), 'container:file');
  assert.equal(containerPath('http'), 'container:http');
  assert.equal(containerPath('github'), 'container:github');
  assert.equal(isContainerSource('container:file'), true);
  assert.equal(isContainerSource('container:http'), true);
  assert.equal(isContainerSource('container:github'), true);
  assert.equal(isContainerSource('/home/me/scripts'), false);
  assert.equal(isContainerSource('https://x/foo.user.js'), false);
  assert.equal(containerKind('container:file'), 'file');
  assert.equal(containerKind('container:github'), 'github');
  assert.equal(containerKind('/home/me/scripts'), null);
});

test('containerKindForSingleFileInput routes single-file inputs by host', () => {
  // GitHub URLs (both human and raw forms) → github container.
  assert.equal(
    containerKindForSingleFileInput('https://github.com/o/r/blob/main/foo.user.js'),
    'github',
  );
  assert.equal(
    containerKindForSingleFileInput('https://raw.githubusercontent.com/o/r/main/foo.user.js'),
    'github',
  );
  // Any other http(s) → http container.
  assert.equal(
    containerKindForSingleFileInput('https://example.com/foo.user.js'),
    'http',
  );
  // file:// URLs and raw fs paths → file container.
  assert.equal(
    containerKindForSingleFileInput('file:///home/me/foo.user.js'),
    'file',
  );
  assert.equal(
    containerKindForSingleFileInput('/home/me/foo.user.js'),
    'file',
  );
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

test('canonicalSourceInput gives one spelling per local file', () => {
  // The whole point: a captured `file://` navigation and a path typed
  // into the sources page have to produce the same stored value, or
  // one file on disk gets two installed rows.
  assert.equal(canonicalSourceInput('file:///home/me/foo.user.js'), '/home/me/foo.user.js');
  assert.equal(canonicalSourceInput('/home/me/foo.user.js'), '/home/me/foo.user.js');
  assert.equal(
    canonicalSourceInput('file:///home/me/my%20scripts/foo.user.js'),
    '/home/me/my scripts/foo.user.js',
  );
  // Idempotent — `addSource` canonicalizes on write and readers
  // canonicalize stored values again on compare.
  assert.equal(
    canonicalSourceInput(canonicalSourceInput('file:///home/me/foo.user.js')),
    '/home/me/foo.user.js',
  );
  // Round-trips back to the same URL, so the fetch still hits the file
  // the user pointed at.
  assert.equal(
    pathToFileUrl(canonicalSourceInput('file:///home/me/a%23b.user.js')),
    'file:///home/me/a%23b.user.js',
  );
  // http(s) has only one spelling; nothing to collapse.
  assert.equal(
    canonicalSourceInput('https://example.com/foo.user.js'),
    'https://example.com/foo.user.js',
  );
});

test('canonicalSourceInput leaves non-POSIX file URLs alone', () => {
  // Collapsing these would corrupt them: the drive letter becomes a
  // path segment (and gets its colon percent-encoded on the way back),
  // and a UNC host is dropped entirely — pointing at a different file.
  // Keeping the URL form means they behave exactly as they did before
  // canonicalization existed.
  assert.equal(canonicalSourceInput('file:///C:/Users/me/foo.user.js'), 'file:///C:/Users/me/foo.user.js');
  assert.equal(canonicalSourceInput('file://server/share/foo.user.js'), 'file://server/share/foo.user.js');
});

test('scriptFileUrl resolves container scripts to their URL/path form', () => {
  // Container scripts carry the full URL/path the user added as their
  // relativePath. scriptFileUrl returns the URL form so the fetcher
  // can hit it directly.
  assert.equal(
    scriptFileUrl('container:http', 'https://example.com/foo.user.js'),
    'https://example.com/foo.user.js',
  );
  assert.equal(
    scriptFileUrl('container:file', 'file:///home/me/foo.user.js'),
    'file:///home/me/foo.user.js',
  );
  // Raw fs paths get URL-encoded.
  assert.equal(
    scriptFileUrl('container:file', '/home/me/my scripts/foo bar.user.js'),
    'file:///home/me/my%20scripts/foo%20bar.user.js',
  );
});

test('scriptAbsolutePath returns the bare fs path for file:// local directory sources', () => {
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

test('scriptAbsolutePath returns the resolved fs path for a container file script', () => {
  // Container scripts are added one at a time via the sources page;
  // scriptAbsolutePath returns the bare on-disk path so the viewer's
  // Location row is readable.
  assert.equal(
    scriptAbsolutePath('container:file', '/home/me/foo.user.js'),
    '/home/me/foo.user.js',
  );
  assert.equal(
    scriptAbsolutePath('container:file', 'file:///home/me/foo.user.js'),
    '/home/me/foo.user.js',
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


test('isManifestSource matches the script_manifest.json basename regardless of scheme or query', () => {
  // Manifest support is scheme-agnostic AND filename-specific: a path
  // counts as a manifest iff its pathname basename is exactly
  // `script_manifest.json`. Arbitrary `.json` files are NOT manifests.
  assert.equal(isManifestSource('https://x/script_manifest.json'), true);
  assert.equal(isManifestSource('http://x/script_manifest.json'), true);
  assert.equal(isManifestSource('https://x/sub/script_manifest.json?branch=main'), true);
  assert.equal(isManifestSource('file:///home/me/script_manifest.json'), true);
  assert.equal(isManifestSource('/home/me/script_manifest.json'), true);
  // Arbitrary .json files (including the legacy `manifest.json` name)
  // are NOT manifests — only the exact `script_manifest.json` basename
  // counts.
  assert.equal(isManifestSource('https://x/manifest.json'), false);
  assert.equal(isManifestSource('/home/me/manifest.json'), false);
  assert.equal(isManifestSource('/home/me/list.json'), false);
  // A file whose name *contains* script_manifest.json as a suffix but
  // isn't actually that file (no `/` before it) doesn't count either.
  assert.equal(isManifestSource('https://x/nope_script_manifest.json'), false);
  assert.equal(isManifestSource('https://x/foo.user.js'), false);
  assert.equal(isManifestSource('/home/me/scripts'), false);
});

test('isFileUrl recognises file:// URLs', () => {
  assert.equal(isFileUrl('file:///home/me/script_manifest.json'), true);
  assert.equal(isFileUrl('FILE:///etc/passwd'), true);
  assert.equal(isFileUrl('https://x/foo.json'), false);
  assert.equal(isFileUrl('/local/foo.json'), false);
});

test('sourceCanonicalUrl normalises raw paths to file:// URLs and passes URLs through', () => {
  // Used as the base for new URL(entry, base) when resolving manifest
  // entries, so a local manifest's relative paths resolve correctly.
  assert.equal(
    sourceCanonicalUrl('/home/me/scripts/script_manifest.json'),
    'file:///home/me/scripts/script_manifest.json',
  );
  assert.equal(
    sourceCanonicalUrl('file:///already/url.json'),
    'file:///already/url.json',
  );
  assert.equal(
    sourceCanonicalUrl('https://example.com/script_manifest.json'),
    'https://example.com/script_manifest.json',
  );
});

// ---------- HTTP URL builders ----------

test('scriptFileUrl returns the URL verbatim for an HTTP container script', () => {
  // Container HTTP scripts store the absolute URL in `relativePath`,
  // so scriptFileUrl just returns it.
  assert.equal(
    scriptFileUrl('container:http', 'https://example.com/dir/foo.user.js'),
    'https://example.com/dir/foo.user.js',
  );
});

test('scriptFileUrl resolves manifest entries relative to the manifest URL', () => {
  // A bare filename inside a manifest resolves against the manifest's
  // *parent* path — same semantics as RFC 3986 relative resolution.
  assert.equal(
    scriptFileUrl('https://example.com/scripts/script_manifest.json', 'foo.user.js'),
    'https://example.com/scripts/foo.user.js',
  );
  // Absolute URLs in the manifest pass through unchanged.
  assert.equal(
    scriptFileUrl(
      'https://example.com/scripts/script_manifest.json',
      'https://other.example.com/bar.user.js',
    ),
    'https://other.example.com/bar.user.js',
  );
  // Subdirectory entries resolve relative to the manifest too.
  assert.equal(
    scriptFileUrl('https://example.com/scripts/script_manifest.json', 'sub/baz.user.js'),
    'https://example.com/scripts/sub/baz.user.js',
  );
});

test('scriptAbsolutePath returns the resolved URL for HTTP container + manifest sources', () => {
  // The viewer's Location row reads this for both flavours.
  assert.equal(
    scriptAbsolutePath('container:http', 'https://example.com/foo.user.js'),
    'https://example.com/foo.user.js',
  );
  assert.equal(
    scriptAbsolutePath('https://example.com/scripts/script_manifest.json', 'foo.user.js'),
    'https://example.com/scripts/foo.user.js',
  );
});

test('scriptFileUrl resolves entries against a local manifest path', () => {
  // The whole point of accepting local manifests: the same JSON file
  // works when added locally and when later served over HTTP.
  // Relative entries resolve against the manifest's parent dir.
  assert.equal(
    scriptFileUrl('/home/me/scripts/script_manifest.json', 'foo.user.js'),
    'file:///home/me/scripts/foo.user.js',
  );
  // Subdirectory entries.
  assert.equal(
    scriptFileUrl('/home/me/scripts/script_manifest.json', 'sub/bar.user.js'),
    'file:///home/me/scripts/sub/bar.user.js',
  );
  // Absolute HTTP entries inside a local manifest are honoured —
  // useful for "host most scripts locally, pull one off the web".
  assert.equal(
    scriptFileUrl(
      '/home/me/scripts/script_manifest.json',
      'https://elsewhere.example.com/baz.user.js',
    ),
    'https://elsewhere.example.com/baz.user.js',
  );
});

test('scriptFileUrl propagates a manifest URL query string onto relative entries', () => {
  // GitHub raw-URL tokens (and similar auth-bearing query strings) need
  // to ride along to every same-origin script the manifest names. RFC
  // 3986 resolution drops the base's query when the reference brings a
  // path, so without explicit propagation each script would 404 on auth.
  assert.equal(
    scriptFileUrl(
      'https://raw.githubusercontent.com/u/repo/branch/script_manifest.json?token=ABC',
      'foo.user.js',
    ),
    'https://raw.githubusercontent.com/u/repo/branch/foo.user.js?token=ABC',
  );
  // Sub-path entries get the same treatment.
  assert.equal(
    scriptFileUrl(
      'https://x.example.com/dir/script_manifest.json?token=ABC',
      'sub/bar.user.js',
    ),
    'https://x.example.com/dir/sub/bar.user.js?token=ABC',
  );
  // Absolute same-origin entries also inherit (one token applies to
  // every file the manifest names on its own origin).
  assert.equal(
    scriptFileUrl(
      'https://x.example.com/dir/script_manifest.json?token=ABC',
      'https://x.example.com/elsewhere/baz.user.js',
    ),
    'https://x.example.com/elsewhere/baz.user.js?token=ABC',
  );
  // Cross-origin entries are left alone — the manifest's token is
  // scoped to its own origin and shouldn't leak to third parties.
  assert.equal(
    scriptFileUrl(
      'https://x.example.com/dir/script_manifest.json?token=ABC',
      'https://other.example.com/qux.user.js',
    ),
    'https://other.example.com/qux.user.js',
  );
  // An entry that brings its own query string keeps it; no merge.
  assert.equal(
    scriptFileUrl(
      'https://x.example.com/dir/script_manifest.json?token=ABC',
      'foo.user.js?v=2',
    ),
    'https://x.example.com/dir/foo.user.js?v=2',
  );
});

test('resolveManifestEntryUrl propagates query only for same-origin no-query entries', () => {
  // Direct unit test of the helper so the propagation rule is pinned
  // down without going through scriptFileUrl's source-kind dispatch.
  const base = 'https://x.example.com/dir/script_manifest.json?t=1';
  assert.equal(resolveManifestEntryUrl('foo.user.js', base).href,
    'https://x.example.com/dir/foo.user.js?t=1');
  assert.equal(resolveManifestEntryUrl('foo.user.js?v=2', base).href,
    'https://x.example.com/dir/foo.user.js?v=2');
  assert.equal(resolveManifestEntryUrl('https://other/x.user.js', base).href,
    'https://other/x.user.js');
  // No-query manifest → nothing to propagate.
  assert.equal(
    resolveManifestEntryUrl('foo.user.js', 'https://x/dir/script_manifest.json').href,
    'https://x/dir/foo.user.js',
  );
});

test('scriptFileUrl resolves entries against a file:// manifest URL', () => {
  // file:// input form should behave identically to a bare path.
  assert.equal(
    scriptFileUrl('file:///home/me/scripts/script_manifest.json', 'foo.user.js'),
    'file:///home/me/scripts/foo.user.js',
  );
});

test('scriptAbsolutePath shows the resolved fs path for local manifest entries', () => {
  // For consistency with other local sources, the viewer's Location
  // row shows the bare on-disk path — not the file:// URL form. This
  // is the same display rule that local directories and local
  // single-file sources use.
  assert.equal(
    scriptAbsolutePath('/home/me/scripts/script_manifest.json', 'foo.user.js'),
    '/home/me/scripts/foo.user.js',
  );
  // file:// manifest input form gives the same result.
  assert.equal(
    scriptAbsolutePath('file:///home/me/scripts/script_manifest.json', 'foo.user.js'),
    '/home/me/scripts/foo.user.js',
  );
  // An HTTPS entry inside a local manifest still surfaces as the URL,
  // because that's where it actually lives.
  assert.equal(
    scriptAbsolutePath(
      '/home/me/scripts/script_manifest.json',
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

async function withFetch(impl, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await fn();
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

test('fetchHttpText: a thrown fetch surfaces with the underlying message', async () => {
  const fakeFetch = async () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(
    withFetch(fakeFetch, () => fetchHttpText('https://x/foo.user.js')),
    /error fetching .*: Failed to fetch/,
  );
});

// ---------- GitHub-dir dispatch ----------
//
// scriptFileUrl / scriptAbsolutePath delegate to github-source.ts for
// github-dir sources. The github helpers themselves are covered in
// tests/unit/github-source.test.mjs; the tests here lock down that
// directories.ts's source-kind dispatch routes through them correctly.

test('scriptFileUrl resolves github-dir entries to raw.githubusercontent.com URLs', () => {
  // Same shape as a manifest entry: the source URL is the dir's
  // github.com URL, the relativePath is the path relative to that dir,
  // and the fetch URL is the raw URL.
  assert.equal(
    scriptFileUrl('https://github.com/foo/bar/tree/main/dir', 'sub/script.user.js'),
    'https://raw.githubusercontent.com/foo/bar/main/dir/sub/script.user.js',
  );
  // Bare basename relative to a tree URL.
  assert.equal(
    scriptFileUrl('https://github.com/foo/bar/tree/main/dir', 'script.user.js'),
    'https://raw.githubusercontent.com/foo/bar/main/dir/script.user.js',
  );
  // /blob/<ref>/<dir> form is treated the same (user typo tolerance).
  assert.equal(
    scriptFileUrl('https://github.com/foo/bar/blob/main/dir', 'script.user.js'),
    'https://raw.githubusercontent.com/foo/bar/main/dir/script.user.js',
  );
});

test('scriptAbsolutePath returns the github.com blob URL for a github-dir entry', () => {
  // The viewer's Location row links to where the user can browse the
  // file on github.com, NOT the raw URL.
  assert.equal(
    scriptAbsolutePath('https://github.com/foo/bar/tree/main/dir', 'sub/script.user.js'),
    'https://github.com/foo/bar/blob/main/dir/sub/script.user.js',
  );
});

