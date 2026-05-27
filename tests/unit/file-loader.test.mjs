// Tests for src/file-loader.ts (compiled to dist/file-loader.js).
//
// Covers `resolveScriptResource` — scheme acceptance + the relative-
// path-against-script-parent rule (including the `..` rejection that
// keeps a header reference from escaping the script's directory).
// The byte-fetch helpers are not unit-tested here: they depend on
// real http(s)/file:// I/O and are covered indirectly by the icon
// pipeline's e2e suite.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isJsResourceUrl, resolveScriptResource } from '../../dist/file-loader.js';

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
  // inline it into the sources-page DOM. Relative paths against a
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
