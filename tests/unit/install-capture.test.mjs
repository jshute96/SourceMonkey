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
  buildPreviewPageUrl,
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

test('captures file:// URLs whose path ends in .user.js', () => {
  // Opening a local script in a tab offers the same install prompt a
  // downloaded one does; without this it dead-ends in a browser
  // download on Chrome ≤ 151.
  assert.equal(isUserJsUrl('file:///home/me/foo.user.js'), true);
  assert.equal(isUserJsUrl('file:///home/me/my%20scripts/foo.user.js'), true);
  assert.equal(isUserJsUrl('file:///C:/Users/me/foo.user.js'), true);
  // Same path-anchored, case-sensitive rules as the http(s) side.
  assert.equal(isUserJsUrl('file:///home/me/notes.md'), false);
  assert.equal(isUserJsUrl('file:///home/me/FOO.USER.JS'), false);
  assert.equal(isUserJsUrl('file:///home/me/scripts/'), false);
});

test('suffix matching is case-sensitive', () => {
  // The `webNavigation` pre-filter and `isSingleFileInput` (which
  // decides single-script vs directory at install time) are both
  // case-sensitive, so this has to be too — a URL that captured but
  // then registered as a directory collection would be silent corruption.
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

test('forge page views are not captured', () => {
  // These serve an HTML file browser, not the script bytes: the user
  // opened them to read, and Chrome renders them fine unaided.
  assert.equal(isUserJsUrl('https://github.com/o/r/blob/main/a/b.user.js'), false);
  assert.equal(isUserJsUrl('https://www.github.com/o/r/blob/main/b.user.js'), false);
  assert.equal(isUserJsUrl('https://github.com/o/r/blob/main/b.user.js?plain=1#L3'), false);
  assert.equal(isUserJsUrl('https://gitlab.com/grp/sub/r/-/blob/main/b.user.js'), false);
  assert.equal(isUserJsUrl('https://bitbucket.org/w/r/src/main/b.user.js'), false);
  assert.equal(isUserJsUrl('https://codeberg.org/o/r/src/branch/main/b.user.js'), false);
});

test('the raw counterpart of each forge page view is still captured', () => {
  assert.equal(isUserJsUrl('https://raw.githubusercontent.com/o/r/main/b.user.js'), true);
  assert.equal(isUserJsUrl('https://github.com/o/r/raw/main/b.user.js'), true);
  assert.equal(isUserJsUrl('https://gitlab.com/grp/r/-/raw/main/b.user.js'), true);
  assert.equal(isUserJsUrl('https://bitbucket.org/w/r/raw/main/b.user.js'), true);
  assert.equal(isUserJsUrl('https://codeberg.org/o/r/raw/branch/main/b.user.js'), true);
  // The exclusion is host-scoped: a lookalike path elsewhere still captures.
  assert.equal(isUserJsUrl('https://example.com/o/r/blob/main/b.user.js'), true);
});

test('GitHub\'s ?raw=true switch keeps a blob URL captured', () => {
  // It 302s to raw.githubusercontent.com, and `onBeforeNavigate` does
  // not fire again for a server redirect — skipping it would lose the
  // capture outright rather than defer it.
  assert.equal(isUserJsUrl('https://github.com/o/r/blob/main/b.user.js?raw=true'), true);
  assert.equal(isUserJsUrl('https://github.com/o/r/blob/main/b.user.js?raw=1'), true);
  // Not the same switch: `?plain=1` is still the HTML view.
  assert.equal(isUserJsUrl('https://github.com/o/r/blob/main/b.user.js?plain=1'), false);
});

test('schemes outside http(s) / file are never captured', () => {
  // Not shapes `addCollection` can register, so a preview would have
  // nothing to offer.
  assert.equal(isUserJsUrl(`chrome-extension://${EXT_ID}/foo.user.js`), false);
  assert.equal(isUserJsUrl('ftp://example.com/foo.user.js'), false);
  assert.equal(isUserJsUrl('data:text/javascript,//foo.user.js'), false);
  assert.equal(isUserJsUrl('blob:https://example.com/foo.user.js'), false);
});

test('garbage input returns false rather than throwing', () => {
  assert.equal(isUserJsUrl('not a url'), false);
  assert.equal(isUserJsUrl(''), false);
  assert.equal(isUserJsUrl('/foo.user.js'), false);
});

test('preview page URL carries the script URL encoded, marked as captured', () => {
  const src = 'https://example.com/a b.user.js?v=1&x=2';
  const out = buildPreviewPageUrl(src);
  assert.ok(out.startsWith(`chrome-extension://${EXT_ID}/userscript.html?`));
  assert.equal(new URL(out).searchParams.get('preview'), src);
  // The viewer only lets a CAPTURED preview navigate away on its own
  // when the location turns out to be a web page.
  assert.equal(new URL(out).searchParams.get('captured'), '1');
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
