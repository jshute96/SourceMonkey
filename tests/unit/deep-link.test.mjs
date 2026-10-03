// Tests for src/extension/deep-link.ts (compiled to dist/extension/deep-link.js).
//
// Covers the pure buildDeepLinkTarget mapping: which URLs become
// chrome-extension:// rewrites, how passthrough params are
// preserved, and which inputs short-circuit to null.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const EXT_ID = 'mock-ext-id';

globalThis.chrome = {
  runtime: {
    getURL: (path) => `chrome-extension://${EXT_ID}/${path.replace(/^\//, '')}`,
  },
};

const { buildDeepLinkTarget } = await import('../../dist/extension/deep-link.js');

const PREFIX = 'https://github.com/jshute96/SourceMonkey/blob/main/docs/redirect-page.md';
const EXT = `chrome-extension://${EXT_ID}`;

test('collections.html with no extra params', () => {
  assert.equal(
    buildDeepLinkTarget(`${PREFIX}?page=collections.html`),
    `${EXT}/collections.html`,
  );
});

test('collections.html forwards refresh flag', () => {
  assert.equal(
    buildDeepLinkTarget(`${PREFIX}?page=collections.html&refresh`),
    `${EXT}/collections.html?refresh=`,
  );
});

test('collections.html forwards add value', () => {
  const src = 'https://example.com/foo.user.js';
  assert.equal(
    buildDeepLinkTarget(`${PREFIX}?page=collections.html&add=${encodeURIComponent(src)}`),
    `${EXT}/collections.html?add=${encodeURIComponent(src)}`,
  );
});

test('options.html with no extra params', () => {
  assert.equal(
    buildDeepLinkTarget(`${PREFIX}?page=options.html`),
    `${EXT}/options.html`,
  );
});

test('userscript.html forwards script id', () => {
  assert.equal(
    buildDeepLinkTarget(`${PREFIX}?page=userscript.html&script=abc123`),
    `${EXT}/userscript.html?script=abc123`,
  );
});

// Debug pages are for developers typing the URL, not for public links.
test('debug/icons.html is not an allowed deep-link page', () => {
  assert.equal(buildDeepLinkTarget(`${PREFIX}?page=debug/icons.html`), null);
});

test('page param is stripped from passthrough query', () => {
  const out = buildDeepLinkTarget(`${PREFIX}?page=collections.html&a=1&b=2`);
  assert.ok(out);
  assert.ok(!out.includes('page='));
  assert.ok(out.includes('a=1'));
  assert.ok(out.includes('b=2'));
});

test('disallowed page returns null', () => {
  assert.equal(
    buildDeepLinkTarget(`${PREFIX}?page=evil.html`),
    null,
  );
});

test('missing page returns null', () => {
  assert.equal(buildDeepLinkTarget(`${PREFIX}?foo=bar`), null);
  assert.equal(buildDeepLinkTarget(PREFIX), null);
});

test('non-matching URL returns null', () => {
  assert.equal(
    buildDeepLinkTarget('https://github.com/jshute96/SourceMonkey/blob/main/README.md?page=collections.html'),
    null,
  );
  assert.equal(
    buildDeepLinkTarget('https://example.com/redirect-page.md?page=collections.html'),
    null,
  );
});

test('garbage URL returns null', () => {
  assert.equal(buildDeepLinkTarget('not a url'), null);
  assert.equal(buildDeepLinkTarget(''), null);
});

test('hash fragment does not block the match and is not forwarded', () => {
  // The hash on the collection URL addresses the markdown's section, not
  // the extension page; intentionally dropped on the rewrite.
  assert.equal(
    buildDeepLinkTarget(`${PREFIX}?page=collections.html#section`),
    `${EXT}/collections.html`,
  );
});

test('the captured marker never rides in from the web', () => {
  // `captured=1` tells the viewer the install capture opened it, which
  // lets the page navigate the tab away on its own. This redirect is
  // the only way a web page can put a param onto an extension page, so
  // that one claim does not carry — everything else still does.
  const target = buildDeepLinkTarget(
    `${PREFIX}?page=userscript.html&preview=https%3A%2F%2Fx.test%2Fa.user.js&captured=1`,
  );
  const params = new URL(target).searchParams;
  assert.equal(params.get('captured'), null);
  assert.equal(params.get('preview'), 'https://x.test/a.user.js');
});

test('userinfo on the URL rejects the match', () => {
  assert.equal(
    buildDeepLinkTarget(`https://user:pass@github.com/jshute96/SourceMonkey/blob/main/docs/redirect-page.md?page=collections.html`),
    null,
  );
});
