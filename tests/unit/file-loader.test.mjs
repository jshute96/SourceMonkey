// Tests for src/file-loader.ts (compiled to dist/file-loader.js).
//
// Covers `resolveScriptResource` — scheme acceptance + the relative-
// path-against-script-parent rule (including the `..` rejection that
// keeps a header reference from escaping the script's directory) — and
// the `*Detailed` variants that say WHICH rule rejected a ref or why a
// fetch produced no bytes. Those reasons exist so the messages built on
// them can state a fact instead of listing possibilities, so they are
// pinned here rather than only through the wording.
//
// The http fetch is exercised against a stubbed `globalThis.fetch`;
// the file:// legs still depend on real I/O and are covered indirectly
// by the icon pipeline's e2e suite.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  fetchResourceBytes,
  isJsResourceUrl,
  resolveScriptResource,
  resolveScriptResourceDetailed,
} from '../../dist/file-loader.js';

// ---------- absolute URLs ----------

test('resolveScriptResource: http(s):// passes through verbatim', () => {
  assert.deepEqual(
    resolveScriptResource('https://example.com/i.png', 'file:///s/foo.user.js'),
    { kind: 'http', url: 'https://example.com/i.png' },
  );
  assert.deepEqual(
    resolveScriptResource('http://example.com/i.png', 'file:///s/foo.user.js'),
    { kind: 'http', url: 'http://example.com/i.png' },
  );
});

test('resolveScriptResource: absolute file:// references are rejected', () => {
  // The extension holds `file:///*` host permission; allowing a script
  // to point an `@icon` at an arbitrary host file would let a
  // malicious HTTP-sourced script read /etc/passwd (or anywhere) and
  // inline it into the collections-page DOM. Relative paths against a
  // file:// script can still produce a file:// result, but those are
  // confined to the script's parent dir by the containment check.
  assert.equal(
    resolveScriptResource('file:///abs/path/i.png', 'http://example.com/s/foo.user.js'),
    null,
  );
  assert.equal(
    resolveScriptResource('file:///etc/passwd', 'file:///home/me/scripts/foo.user.js'),
    null,
  );
});

test('resolveScriptResource: data: URLs come back as kind=data', () => {
  const dataUrl = 'data:image/png;base64,iVBORw0KGgo=';
  assert.deepEqual(
    resolveScriptResource(dataUrl, 'file:///s/foo.user.js'),
    { kind: 'data', url: dataUrl },
  );
});

test('resolveScriptResource: disallowed schemes return null', () => {
  assert.equal(
    resolveScriptResource('ftp://example.com/i.png', 'file:///s/foo.user.js'),
    null,
  );
  assert.equal(
    resolveScriptResource('javascript:alert(1)', 'file:///s/foo.user.js'),
    null,
  );
  assert.equal(
    resolveScriptResource('chrome-extension://abc/i.png', 'file:///s/foo.user.js'),
    null,
  );
});

// ---------- relative paths against a file:// script ----------

test('resolveScriptResource: bare filename resolves against script parent (file://)', () => {
  assert.deepEqual(
    resolveScriptResource('icon.png', 'file:///home/me/scripts/foo.user.js'),
    { kind: 'file', url: 'file:///home/me/scripts/icon.png' },
  );
});

test('resolveScriptResource: subdir relative path resolves against script parent', () => {
  assert.deepEqual(
    resolveScriptResource('img/icon.png', 'file:///home/me/scripts/foo.user.js'),
    { kind: 'file', url: 'file:///home/me/scripts/img/icon.png' },
  );
});

test('resolveScriptResource: ./prefix is allowed', () => {
  assert.deepEqual(
    resolveScriptResource('./icon.png', 'file:///home/me/scripts/foo.user.js'),
    { kind: 'file', url: 'file:///home/me/scripts/icon.png' },
  );
});

// ---------- relative paths against an http(s) script ----------

test('resolveScriptResource: bare filename resolves against http script parent', () => {
  assert.deepEqual(
    resolveScriptResource('icon.png', 'https://example.com/scripts/foo.user.js'),
    { kind: 'http', url: 'https://example.com/scripts/icon.png' },
  );
});

test('resolveScriptResource: subdir relative path resolves against http script parent', () => {
  assert.deepEqual(
    resolveScriptResource('img/icon.png', 'https://example.com/scripts/foo.user.js'),
    { kind: 'http', url: 'https://example.com/scripts/img/icon.png' },
  );
});

// ---------- restrictions on relative paths ----------

test('resolveScriptResource: rejects `..` segments', () => {
  assert.equal(
    resolveScriptResource('../icon.png', 'file:///home/me/scripts/foo.user.js'),
    null,
  );
  // `a/..` net-resolves back to the parent dir, then `../icon.png`
  // escapes — caught by the containment check on the resolved URL.
  assert.equal(
    resolveScriptResource('img/../../icon.png', 'file:///home/me/scripts/foo.user.js'),
    null,
  );
});

test('resolveScriptResource: rejects percent-encoded `..` (containment-based)', () => {
  // `%2e%2e` is normalized into a `..` directory-up move by the URL
  // parser; a textual segment filter would miss this. The post-
  // resolution containment compare catches it.
  assert.equal(
    resolveScriptResource('%2e%2e/icon.png', 'file:///home/me/scripts/foo.user.js'),
    null,
  );
  assert.equal(
    resolveScriptResource('%2e%2e/icon.png', 'https://example.com/scripts/foo.user.js'),
    null,
  );
  // Mixed case + nested: `a/%2E%2e` normalizes to `a/..` which net-
  // resolves back into the parent dir — still confined, so allowed.
  assert.deepEqual(
    resolveScriptResource('a/%2E%2e/icon.png', 'https://example.com/scripts/foo.user.js'),
    { kind: 'http', url: 'https://example.com/scripts/icon.png' },
  );
  assert.equal(
    resolveScriptResource('%2e./icon.png', 'file:///home/me/scripts/foo.user.js'),
    null,
  );
});

test('resolveScriptResource: a/.. that lands inside the parent is allowed', () => {
  // No escape: the net result is still under the script's dir.
  assert.deepEqual(
    resolveScriptResource('a/../icon.png', 'file:///home/me/scripts/foo.user.js'),
    { kind: 'file', url: 'file:///home/me/scripts/icon.png' },
  );
});

test('resolveScriptResource: backslash escape is rejected (WHATWG canonicalizes `\\` to `/` for file/http URLs)', () => {
  assert.equal(
    resolveScriptResource('..\\secret', 'file:///home/me/scripts/foo.user.js'),
    null,
  );
  assert.equal(
    resolveScriptResource('a\\..\\..\\secret', 'file:///home/me/scripts/foo.user.js'),
    null,
  );
});

test('resolveScriptResource: deeply-nested encoded escape is rejected', () => {
  assert.equal(
    resolveScriptResource(
      'subdir/%2e%2e/%2e%2e/etc/passwd',
      'file:///home/me/scripts/foo.user.js',
    ),
    null,
  );
});

test('resolveScriptResource: rejects host-absolute paths', () => {
  // Leading `/` would resolve to the host root for http and to the
  // filesystem root for file:// — both escape the script's parent.
  assert.equal(
    resolveScriptResource('/icon.png', 'https://example.com/scripts/foo.user.js'),
    null,
  );
  assert.equal(
    resolveScriptResource('/etc/passwd', 'file:///home/me/scripts/foo.user.js'),
    null,
  );
});

test('resolveScriptResource: empty / whitespace refs return null', () => {
  assert.equal(resolveScriptResource('', 'file:///s/foo.user.js'), null);
  assert.equal(resolveScriptResource('   ', 'file:///s/foo.user.js'), null);
});

test('resolveScriptResource: trims surrounding whitespace', () => {
  assert.deepEqual(
    resolveScriptResource('  icon.png  ', 'file:///home/me/scripts/foo.user.js'),
    { kind: 'file', url: 'file:///home/me/scripts/icon.png' },
  );
});

test('resolveScriptResource: scheme-bearing but malformed URLs return null', () => {
  assert.equal(
    resolveScriptResource('http://', 'file:///s/foo.user.js'),
    null,
  );
});

// ---------- isJsResourceUrl ----------

test('isJsResourceUrl: accepts a plain .js URL', () => {
  assert.equal(isJsResourceUrl('https://cdn.example.com/lib.js'), true);
});

test('isJsResourceUrl: ignores query / fragment', () => {
  assert.equal(isJsResourceUrl('https://cdn.example.com/lib.js?v=3'), true);
  assert.equal(isJsResourceUrl('https://cdn.example.com/lib.js#sha256=abc'), true);
});

test('isJsResourceUrl: accepts uppercase / mixed-case .JS', () => {
  // Some Windows-origin and CDN-hosted libraries use a capital
  // extension; TM/VM accept them, so we should too.
  assert.equal(isJsResourceUrl('https://cdn.example.com/Lib.JS'), true);
  assert.equal(isJsResourceUrl('file:///home/me/scripts/LIB.Js'), true);
});

test('isJsResourceUrl: rejects non-.js suffixes', () => {
  assert.equal(isJsResourceUrl('https://cdn.example.com/lib.json'), false);
  assert.equal(isJsResourceUrl('https://cdn.example.com/lib.js.txt'), false);
  assert.equal(isJsResourceUrl('https://cdn.example.com/'), false);
});

test('isJsResourceUrl: rejects trailing-slash on a .js path', () => {
  // `lib.js/` is a directory, not a script.
  assert.equal(isJsResourceUrl('https://cdn.example.com/lib.js/'), false);
});

test('isJsResourceUrl: malformed URL returns false', () => {
  assert.equal(isJsResourceUrl('not a url'), false);
  assert.equal(isJsResourceUrl(''), false);
});


// ---------- resolveScriptResourceDetailed: which rule rejected it ----------

const SCRIPT_URL_FILE = 'file:///home/me/scripts/foo.user.js';

test('resolveScriptResourceDetailed: an escaping relative path and a bad scheme are different failures', () => {
  const escaping = resolveScriptResourceDetailed('../secret.js', SCRIPT_URL_FILE);
  assert.deepEqual(escaping, { failed: true, reason: 'outside-script-folder' });

  const scheme = resolveScriptResourceDetailed('ftp://example.com/i.png', SCRIPT_URL_FILE);
  assert.equal(scheme.reason, 'unsupported-scheme');
  // The scheme travels with the reason so the message can name what
  // the author actually wrote.
  assert.equal(scheme.scheme, 'ftp:');
});

test('resolveScriptResourceDetailed: absolute file:// is a scheme rejection, not a containment one', () => {
  // It is refused on purpose (see the module header) — but the reason
  // has to be honest about which rule did it.
  const r = resolveScriptResourceDetailed('file:///etc/passwd', 'https://example.com/s/foo.user.js');
  assert.equal(r.reason, 'unsupported-scheme');
  assert.equal(r.scheme, 'file:');
});

test('resolveScriptResourceDetailed: empty and malformed refs are distinguished', () => {
  assert.equal(resolveScriptResourceDetailed('   ', SCRIPT_URL_FILE).reason, 'empty');
  assert.equal(resolveScriptResourceDetailed('http://', SCRIPT_URL_FILE).reason, 'malformed-url');
});

test('resolveScriptResourceDetailed: success returns the resource, with no failed flag', () => {
  const r = resolveScriptResourceDetailed('./icon.png', SCRIPT_URL_FILE);
  assert.deepEqual(r, { kind: 'file', url: 'file:///home/me/scripts/icon.png' });
  assert.equal('failed' in r, false);
});

test('resolveScriptResource: the yes/no wrapper agrees with the detailed form', () => {
  // One implementation behind both — the wrapper must not drift into a
  // second copy of the rules.
  for (const ref of ['../secret.js', 'ftp://x/i.png', '', 'http://', './icon.png', 'https://e.com/a.js']) {
    const detailed = resolveScriptResourceDetailed(ref, SCRIPT_URL_FILE);
    const plain = resolveScriptResource(ref, SCRIPT_URL_FILE);
    assert.deepEqual(plain, 'failed' in detailed ? null : detailed, `mismatch for ${ref}`);
  }
});

// ---------- fetchResourceBytes: which failure it was ----------

async function withStubbedFetch(impl, run) {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await run();
  } finally {
    globalThis.fetch = real;
  }
}

const okResponse = (body, headers = {}) => new Response(body, { status: 200, headers });

test('fetchResourceBytes: a non-ok status reports the status', async () => {
  const res = await withStubbedFetch(
    async () => new Response(null, { status: 404 }),
    () => fetchResourceBytes('https://example.com/a.js', { maxBytes: 1000 }),
  );
  assert.deepEqual(res, { failed: true, reason: 'http-error', status: 404 });
});

test('fetchResourceBytes: an empty body is empty, not oversize or missing', async () => {
  const res = await withStubbedFetch(
    async () => okResponse(new ArrayBuffer(0)),
    () => fetchResourceBytes('https://example.com/a.js', { maxBytes: 1000 }),
  );
  assert.deepEqual(res, { failed: true, reason: 'empty' });
});

test('fetchResourceBytes: over the cap is oversize, by body and by Content-Length', async () => {
  const big = new Uint8Array(50).buffer;
  const byBody = await withStubbedFetch(
    async () => okResponse(big),
    () => fetchResourceBytes('https://example.com/a.js', { maxBytes: 10 }),
  );
  assert.deepEqual(byBody, { failed: true, reason: 'oversize' });

  // The Content-Length shortcut refuses before buffering, and has to
  // report the same reason as the post-buffer check.
  const byHeader = await withStubbedFetch(
    async () => okResponse(big, { 'content-length': '50' }),
    () => fetchResourceBytes('https://example.com/a.js', { maxBytes: 10 }),
  );
  assert.deepEqual(byHeader, { failed: true, reason: 'oversize' });
});

test('fetchResourceBytes: a throwing fetch is no-response', async () => {
  const res = await withStubbedFetch(
    async () => { throw new TypeError('network down'); },
    () => fetchResourceBytes('https://example.com/a.js', { maxBytes: 1000 }),
  );
  assert.deepEqual(res, { failed: true, reason: 'no-response' });
});

test('fetchResourceBytes: our own timeout is reported as a timeout, not a network failure', async () => {
  // The abort comes from the fetcher's own timer, so `signal.aborted`
  // identifies it exactly — the two must not collapse into one reason.
  const res = await withStubbedFetch(
    (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }),
    () => fetchResourceBytes('https://example.com/a.js', { maxBytes: 1000, timeoutMs: 10 }),
  );
  assert.deepEqual(res, { failed: true, reason: 'timeout' });
});

test('fetchResourceBytes: a rejected content type is its own reason', async () => {
  const res = await withStubbedFetch(
    async () => okResponse(new Uint8Array([1, 2, 3]).buffer, { 'content-type': 'text/html' }),
    () => fetchResourceBytes('https://example.com/a.png', {
      maxBytes: 1000,
      acceptContentType: (ct) => ct.startsWith('image/'),
    }),
  );
  assert.deepEqual(res, { failed: true, reason: 'wrong-content-type' });
});

test('fetchResourceBytes: a file:// failure never claims an HTTP status', async () => {
  // Node has no XMLHttpRequest, so this takes the same `fetch` leg the
  // service worker does. A `file:` URL has no HTTP layer, so a
  // synthesised non-ok status must not surface as `HTTP <n>` — that is
  // what made this leg disagree with the page-context XHR leg about a
  // missing local dependency.
  const res = await withStubbedFetch(
    async () => new Response(null, { status: 404 }),
    () => fetchResourceBytes('file:///home/me/scripts/gone.js', { maxBytes: 1000 }),
  );
  assert.deepEqual(res, { failed: true, reason: 'unreadable-file' });
});

test('fetchResourceBytes: a scheme we do not fetch says so', async () => {
  const res = await fetchResourceBytes('ftp://example.com/a.js', { maxBytes: 1000 });
  assert.deepEqual(res, { failed: true, reason: 'unsupported-scheme' });
});

