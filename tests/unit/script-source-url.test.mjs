// Tests for the canonical sourcemonkey:// URL builders that the
// injector emits as `//# sourceURL=` directives and the viewer
// matches stack-trace refs against. Compiled output lives at
// dist/script-source-url.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BRIDGE_SOURCE_URL,
  GM_RUNTIME_SOURCE_URL,
  PRELUDE_SOURCE_URL,
  buildConfigSourceUrl,
  buildRequireSourceUrl,
  buildSourceUrl,
} from '../../dist/script-source-url.js';

// ---------- per-script artifact URLs ----------

test('buildSourceUrl: places the main body under SourceMonkey/<folder>/<name>.user.js', () => {
  assert.equal(
    buildSourceUrl('hello.user.js'),
    'sourcemonkey://SourceMonkey/hello/hello.user.js',
  );
});

test('buildSourceUrl: a log label without .user.js still works', () => {
  // The fallback path in script-log-id (relative path missing the
  // conventional extension) yields a plain basename — the URL
  // builder still appends `.user.js` on the file portion so the
  // main entry looks like a userscript.
  assert.equal(
    buildSourceUrl('weird-name'),
    'sourcemonkey://SourceMonkey/weird-name/weird-name.user.js',
  );
});

test('buildSourceUrl: dedup `#N` suffix percent-encodes to %23N in the folder, drops from the file', () => {
  // The `#` is the URL fragment separator — leaving it bare would
  // split the path. `%23` keeps the folder intact; the file part
  // drops the disambiguator because each dupe lives in its own
  // folder anyway.
  assert.equal(
    buildSourceUrl('shared.user.js#2'),
    'sourcemonkey://SourceMonkey/shared%232/shared.user.js',
  );
});

test('label sanitization: a newline in the filename can\'t break out of the //# sourceURL= comment', () => {
  // The log label comes from the on-disk filename, which is
  // attacker-controlled for an untrusted bundle. A literal LF/CR (or
  // U+2028/U+2029) would terminate the single-line `//# sourceURL=`
  // comment the injector emits, turning whatever follows into live
  // code in the config blob. The builder must strip those before the
  // URL is spliced. We assert the emitted URL contains no line
  // terminator and the dangerous chars are replaced with `_`.
  const evil = 'x\n;globalThis.pwned=1//.user.js';
  for (const url of [buildSourceUrl(evil), buildConfigSourceUrl(evil)]) {
    assert.ok(!/[\n\r\u2028\u2029]/.test(url), `url must not contain a line terminator: ${JSON.stringify(url)}`);
  }
  // Concretely: the folder collapses the control char to `_`.
  assert.equal(
    buildConfigSourceUrl('a\rb.user.js'),
    'sourcemonkey://SourceMonkey/a_b/__config.js',
  );
});

test('buildConfigSourceUrl: per-script config blob URL', () => {
  assert.equal(
    buildConfigSourceUrl('hello.user.js'),
    'sourcemonkey://SourceMonkey/hello/__config.js',
  );
  assert.equal(
    buildConfigSourceUrl('hello.user.js#3'),
    'sourcemonkey://SourceMonkey/hello%233/__config.js',
  );
});

test('page-wide URLs live directly under SourceMonkey/', () => {
  // Bridge and GM runtime are page-wide singletons (one
  // chrome.userScripts registration each, when needed). The
  // prelude is inlined per-script but all N inclusions share the
  // same URL so devtools' Sources tree dedups them into one
  // visible entry at the SourceMonkey/ top level. See injector.ts's
  // URL layout comment.
  assert.equal(BRIDGE_SOURCE_URL, 'sourcemonkey://SourceMonkey/__bridge.js');
  assert.equal(GM_RUNTIME_SOURCE_URL, 'sourcemonkey://SourceMonkey/__gm-runtime.js');
  assert.equal(PRELUDE_SOURCE_URL, 'sourcemonkey://SourceMonkey/__prelude.js');
});

// ---------- @require URLs ----------

test('buildRequireSourceUrl: maps https URL to <folder>/<host>/<path>', () => {
  assert.equal(
    buildRequireSourceUrl('hello.user.js', 'https://cdn.example.com/jquery/3.7.1/jquery.min.js'),
    'sourcemonkey://SourceMonkey/hello/cdn.example.com/jquery/3.7.1/jquery.min.js',
  );
});

test('buildRequireSourceUrl: drops query string and fragment from the require URL', () => {
  // The cached bytes don't depend on `?updated=...` or `#frag`, so
  // we drop them — keeps the tree clean and avoids `#` confusing URL
  // parsers downstream.
  assert.equal(
    buildRequireSourceUrl(
      'hello.user.js',
      'https://greasemonkey.github.io/gm4-polyfill/gm4-polyfill.js?updated=20180103',
    ),
    'sourcemonkey://SourceMonkey/hello/greasemonkey.github.io/gm4-polyfill/gm4-polyfill.js',
  );
});

test('buildRequireSourceUrl: file:// URLs use synthetic host `file`', () => {
  assert.equal(
    buildRequireSourceUrl('hello.user.js', 'file:///home/user/scripts/lib.js'),
    'sourcemonkey://SourceMonkey/hello/file/home/user/scripts/lib.js',
  );
});

test('buildRequireSourceUrl: `..` segments collapse via URL normalization', () => {
  // `new URL()` already normalizes `a/../b` to `b` before our path
  // sanitizer sees it, so traversal can't slip through. We don't
  // depend on this for security (chrome.userScripts isn't a
  // filesystem) — just observing the behavior.
  assert.equal(
    buildRequireSourceUrl('hello.user.js', 'https://cdn/a/../b/c.js'),
    'sourcemonkey://SourceMonkey/hello/cdn/b/c.js',
  );
});

test('buildRequireSourceUrl: unparseable URL falls back to <folder>/require', () => {
  assert.equal(
    buildRequireSourceUrl('hello.user.js', 'not a url'),
    'sourcemonkey://SourceMonkey/hello/require',
  );
});

test('buildRequireSourceUrl: empty pathname falls back to <folder>/<host>/require', () => {
  // E.g. a require pointed at the root of a host. The cached bytes
  // need SOMEWHERE in the tree.
  assert.equal(
    buildRequireSourceUrl('hello.user.js', 'https://cdn.example.com/'),
    'sourcemonkey://SourceMonkey/hello/cdn.example.com/require',
  );
});

test('buildRequireSourceUrl: dedup folder via percent-encoded `#`', () => {
  // The require URL is built from the same logLabel as the script's
  // own URL, so the dedup encoding must flow through.
  assert.equal(
    buildRequireSourceUrl('shared.user.js#2', 'https://cdn/x.js'),
    'sourcemonkey://SourceMonkey/shared%232/cdn/x.js',
  );
});
