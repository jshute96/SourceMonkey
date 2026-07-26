// Tests for src/install-capture.ts (compiled to dist/install-capture.js).
//
// Covers the pure pieces of the `.user.js` capture: which URLs it acts
// on, the install-page URL it builds, the Chrome-version gate on the
// download workaround, and the one-shot bypass round-trip.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const EXT_ID = 'mock-ext-id';

// chrome.storage.session stand-in. The bypass helpers are the only
// consumers; a plain Map matches the get/set/remove subset they use.
const sessionStore = new Map();

globalThis.chrome = {
  runtime: {
    getURL: (path) => `chrome-extension://${EXT_ID}/${path.replace(/^\//, '')}`,
  },
  storage: {
    session: {
      get: async (key) =>
        sessionStore.has(key) ? { [key]: sessionStore.get(key) } : {},
      set: async (obj) => {
        for (const [k, v] of Object.entries(obj)) sessionStore.set(k, v);
      },
      remove: async (key) => {
        sessionStore.delete(key);
      },
    },
  },
};

const {
  buildInstallPageUrl,
  consumeInstallBypass,
  isUserJsUrl,
  markInstallBypass,
  needsDownloadWorkaround,
  parseChromeMajor,
} = await import('../../dist/install-capture.js');

test('captures http(s) URLs whose path ends in .user.js', () => {
  assert.equal(isUserJsUrl('https://example.com/foo.user.js'), true);
  assert.equal(isUserJsUrl('http://example.com/foo.user.js'), true);
  assert.equal(isUserJsUrl('https://update.greasyfork.org/scripts/1/Name.user.js'), true);
  assert.equal(isUserJsUrl('https://raw.githubusercontent.com/o/r/main/a/b.user.js'), true);
});

test('query strings and fragments do not defeat the suffix check', () => {
  assert.equal(isUserJsUrl('https://example.com/foo.user.js?v=3'), true);
  assert.equal(isUserJsUrl('https://example.com/foo.user.js#top'), true);
  assert.equal(isUserJsUrl('https://example.com/foo.user.js?a=1#top'), true);
});

test('suffix matching is case-sensitive', () => {
  // The `webNavigation` pre-filter and `isSingleFileInput` (which
  // decides single-script vs directory at install time) are both
  // case-sensitive, so this has to be too — a URL that captured but
  // then registered as a directory source would be silent corruption.
  assert.equal(isUserJsUrl('https://example.com/Foo.User.JS'), false);
  assert.equal(isUserJsUrl('https://example.com/foo.USER.JS'), false);
});

test('non-.user.js URLs are left alone', () => {
  assert.equal(isUserJsUrl('https://example.com/foo.js'), false);
  assert.equal(isUserJsUrl('https://example.com/foo.user.js.html'), false);
  assert.equal(isUserJsUrl('https://example.com/'), false);
  // The suffix has to be on the path, not somewhere in the query —
  // otherwise a page linking to a script would capture itself.
  assert.equal(isUserJsUrl('https://example.com/page?src=foo.user.js'), false);
  assert.equal(isUserJsUrl('https://greasyfork.org/scripts/1-name'), false);
});

test('non-http(s) schemes are never captured', () => {
  // file:// scripts go through the sources page; capturing them would
  // hijack a local file the user opened to read.
  assert.equal(isUserJsUrl('file:///home/me/foo.user.js'), false);
  assert.equal(isUserJsUrl(`chrome-extension://${EXT_ID}/foo.user.js`), false);
  assert.equal(isUserJsUrl('ftp://example.com/foo.user.js'), false);
});

test('garbage input returns false rather than throwing', () => {
  assert.equal(isUserJsUrl('not a url'), false);
  assert.equal(isUserJsUrl(''), false);
  assert.equal(isUserJsUrl('/foo.user.js'), false);
});

test('install page URL carries the script URL encoded', () => {
  const src = 'https://example.com/a b.user.js?v=1&x=2';
  const out = buildInstallPageUrl(src);
  assert.ok(out.startsWith(`chrome-extension://${EXT_ID}/install.html?`));
  assert.equal(new URL(out).searchParams.get('url'), src);
});

test('parseChromeMajor reads the major version', () => {
  assert.equal(
    parseChromeMajor('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36'),
    150,
  );
  assert.equal(parseChromeMajor('… Chromium/152.0.7000.0 …'), 152);
  assert.equal(parseChromeMajor('Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0'), null);
});

test('download workaround applies below Chrome 152 only', () => {
  // Chrome 152 removed the `.user.js` download special case, which the
  // Content-Type rewrite exists to defuse. Applying it after that
  // would turn a clean source view into garbled HTML.
  assert.equal(needsDownloadWorkaround('… Chrome/150.0.0.0 …'), true);
  assert.equal(needsDownloadWorkaround('… Chrome/151.0.0.0 …'), true);
  assert.equal(needsDownloadWorkaround('… Chrome/152.0.0.0 …'), false);
  assert.equal(needsDownloadWorkaround('… Chrome/160.0.0.0 …'), false);
  // Unrecognisable UA: assume the workaround is needed, matching the
  // conservative choice other managers make.
  assert.equal(needsDownloadWorkaround('something else entirely'), true);
});

test('bypass is one-shot', async () => {
  const url = 'https://example.com/foo.user.js';
  assert.equal(await consumeInstallBypass(url), false);
  await markInstallBypass(url);
  assert.equal(await consumeInstallBypass(url), true);
  // Second read finds nothing — a later visit to the same URL is
  // captured normally again.
  assert.equal(await consumeInstallBypass(url), false);
});

test('bypass is keyed per URL', async () => {
  await markInstallBypass('https://example.com/a.user.js');
  assert.equal(await consumeInstallBypass('https://example.com/b.user.js'), false);
  assert.equal(await consumeInstallBypass('https://example.com/a.user.js'), true);
});

test('expired bypass does not suppress capture', async () => {
  const url = 'https://example.com/stale.user.js';
  sessionStore.set(`installBypass:${url}`, Date.now() - 1);
  assert.equal(await consumeInstallBypass(url), false);
  // …and it's cleared, not left to accumulate.
  assert.equal(sessionStore.has(`installBypass:${url}`), false);
});
