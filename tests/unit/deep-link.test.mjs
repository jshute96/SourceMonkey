// Tests for src/deep-link.ts (compiled to dist/deep-link.js).
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

const { buildDeepLinkTarget } = await import('../../dist/deep-link.js');

const PREFIX = 'https://github.com/jshute96/SourceMonkey/blob/main/docs/redirect-page.md';
const EXT = `chrome-extension://${EXT_ID}`;

test('sources.html with no extra params', () => {
  assert.equal(
    buildDeepLinkTarget(`${PREFIX}?page=sources.html`),
    `${EXT}/sources.html`,
  );
});

test('sources.html forwards refresh flag', () => {
  assert.equal(
    buildDeepLinkTarget(`${PREFIX}?page=sources.html&refresh`),
    `${EXT}/sources.html?refresh=`,
  );
});

test('sources.html forwards add_source value', () => {
  const src = 'https://example.com/foo.user.js';
  assert.equal(
    buildDeepLinkTarget(`${PREFIX}?page=sources.html&add_source=${encodeURIComponent(src)}`),
    `${EXT}/sources.html?add_source=${encodeURIComponent(src)}`,
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

test('page param is stripped from passthrough query', () => {
  const out = buildDeepLinkTarget(`${PREFIX}?page=sources.html&a=1&b=2`);
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
    buildDeepLinkTarget('https://github.com/jshute96/SourceMonkey/blob/main/README.md?page=sources.html'),
    null,
  );
  assert.equal(
    buildDeepLinkTarget('https://example.com/redirect-page.md?page=sources.html'),
    null,
  );
});

test('garbage URL returns null', () => {
  assert.equal(buildDeepLinkTarget('not a url'), null);
  assert.equal(buildDeepLinkTarget(''), null);
});

test('hash fragment does not block the match and is not forwarded', () => {
  // The hash on the source URL addresses the markdown's section, not
  // the extension page; intentionally dropped on the rewrite.
  assert.equal(
    buildDeepLinkTarget(`${PREFIX}?page=sources.html#section`),
    `${EXT}/sources.html`,
  );
});

test('userinfo on the URL rejects the match', () => {
  assert.equal(
    buildDeepLinkTarget(`https://user:pass@github.com/jshute96/SourceMonkey/blob/main/docs/redirect-page.md?page=sources.html`),
    null,
  );
});
