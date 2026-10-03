// Tests for src/extension/site-icon.ts (compiled to dist/extension/site-icon.js).
//
// Covers the icon-specific pure helpers: `@icon`-header URL
// extraction, icon-link parsing + scoring, and cache-freshness rules.
// `@match`-pattern → origin/linkUrl extraction lives in
// src/match-targets.ts and is tested separately. The network fetch
// pipeline is not unit-tested here — it depends on real HTTP.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  dataUrlToBlob,
  ensureIconForUrl,
  iconRefFromHeader,
  isCacheFresh,
  isIconCacheKey,
  isSameHostRedirect,
  parseCachedIconRow,
  parseIconLinks,
  pickBestIconCandidate,
  sitesTooltip,
  maxDeclaredSize,
  usableCacheHit,
} from '../../dist/extension/site-icon.js';

// ---------- iconRefFromHeader ----------
//
// The header parser only extracts the raw reference string now; the
// URL validation + relative-path resolution moved to file-loader and
// runs at render time. These tests cover the trimmed/non-empty
// contract; scheme + `..` rejection is tested in file-loader.test.mjs.

function header(...tags) {
  // Build a minimal ParsedHeader from a list of [tag, value] pairs.
  return { tags: tags.map(([tag, value]) => ({ tag, value })) };
}

test('iconRefFromHeader: returns @icon when present', () => {
  assert.equal(
    iconRefFromHeader(header(['icon', 'https://example.com/i.png'])),
    'https://example.com/i.png',
  );
});

test('iconRefFromHeader: accepts TM aliases', () => {
  assert.equal(
    iconRefFromHeader(header(['iconurl', 'https://example.com/i.png'])),
    'https://example.com/i.png',
  );
  assert.equal(
    iconRefFromHeader(header(['defaulticon', 'https://example.com/d.png'])),
    'https://example.com/d.png',
  );
  assert.equal(
    iconRefFromHeader(header(['icon64url', 'https://example.com/64.png'])),
    'https://example.com/64.png',
  );
  assert.equal(
    iconRefFromHeader(header(['icon64', 'https://example.com/64b.png'])),
    'https://example.com/64b.png',
  );
});

test('iconRefFromHeader: @icon wins over 64-variants', () => {
  // Smaller-resolution variant is preferred when both are declared.
  assert.equal(
    iconRefFromHeader(header(
      ['icon64', 'https://example.com/64.png'],
      ['icon', 'https://example.com/i.png'],
    )),
    'https://example.com/i.png',
  );
});

test('iconRefFromHeader: returns data: URLs verbatim', () => {
  const dataUrl = 'data:image/png;base64,iVBORw0KGgo=';
  assert.equal(iconRefFromHeader(header(['icon', dataUrl])), dataUrl);
});

test('iconRefFromHeader: returns relative refs verbatim', () => {
  // Resolution is the file-loader's job; the header reader hands the
  // raw string through unchanged so consumers can decide.
  assert.equal(iconRefFromHeader(header(['icon', 'icon.png'])), 'icon.png');
  assert.equal(iconRefFromHeader(header(['icon', 'sub/icon.png'])), 'sub/icon.png');
});

test('iconRefFromHeader: trims whitespace; rejects empty values', () => {
  assert.equal(iconRefFromHeader(header(['icon', '  https://example.com/i.png  '])),
    'https://example.com/i.png');
  assert.equal(iconRefFromHeader(header(['icon', ''])), null);
  assert.equal(iconRefFromHeader(header(['icon', '   '])), null);
});

test('iconRefFromHeader: null/empty header returns null', () => {
  assert.equal(iconRefFromHeader(null), null);
  assert.equal(iconRefFromHeader({ tags: [] }), null);
});

test('iconRefFromHeader: ignores localized @icon variants', () => {
  // A locale-suffixed entry should not count — the canonical
  // unlocalized form is the only one consulted.
  const h = { tags: [{ tag: 'icon', locale: 'de', value: 'https://example.com/de.png' }] };
  assert.equal(iconRefFromHeader(h), null);
});

// ---------- isCacheFresh ----------

test('isCacheFresh: successful entries are fresh within 7d', () => {
  const now = Date.now();
  const data = 'data:image/png;base64,XYZ';
  const fresh = { dataUrl: data, fetchedAt: now - 60 * 1000 };
  const sixDays = { dataUrl: data, fetchedAt: now - 6 * 24 * 60 * 60 * 1000 };
  const eightDays = { dataUrl: data, fetchedAt: now - 8 * 24 * 60 * 60 * 1000 };
  assert.equal(isCacheFresh(fresh, now), true);
  assert.equal(isCacheFresh(sixDays, now), true);
  assert.equal(isCacheFresh(eightDays, now), false);
});

test('isCacheFresh: null entries expire after 24h', () => {
  const now = Date.now();
  const recent = { dataUrl: null, fetchedAt: now - 60 * 1000 };
  const stale = { dataUrl: null, fetchedAt: now - 48 * 60 * 60 * 1000 };
  assert.equal(isCacheFresh(recent, now), true);
  assert.equal(isCacheFresh(stale, now), false);
});

// ---------- usableCacheHit ----------
//
// The read side of the cache. A row we would refuse to paint counts as
// a miss, so a row written by a build predating the empty-`data:`
// check is hidden immediately and overwritten by the refetch, instead
// of painting a broken <img> until its 7-day TTL runs out.

test('usableCacheHit: an empty data: URL in the cache reads as a miss', () => {
  const fresh = (dataUrl) => ({ dataUrl, fetchedAt: Date.now() });
  assert.equal(usableCacheHit(fresh('data:,')), null);
  assert.equal(usableCacheHit(fresh('data:image/png;base64,')), null);
  assert.equal(usableCacheHit(fresh('data:image/png;base64,   ')), null);
});

test('usableCacheHit: real icons and cached "no icon" still hit', () => {
  const icon = { dataUrl: 'data:image/png;base64,SGk=', fetchedAt: Date.now() };
  assert.equal(usableCacheHit(icon), icon);
  // A stored null is a real answer — "we looked, there is none" — and
  // must keep suppressing refetches for its (shorter) TTL.
  const none = { dataUrl: null, fetchedAt: Date.now() };
  assert.equal(usableCacheHit(none), none);
});

test('usableCacheHit: a row holding a non-data: URL is a miss', () => {
  // Nothing this extension writes stores anything but a data: URL, so
  // another shape means another build wrote the row — which is exactly
  // what this check distrusts. Painting an `https:` URL from an
  // extension page would fetch it remotely, most likely blocked.
  const row = { dataUrl: 'https://example.com/favicon.ico', fetchedAt: Date.now() };
  assert.equal(usableCacheHit(row), null);
});

test('usableCacheHit: missing and stale rows are misses', () => {
  assert.equal(usableCacheHit(undefined), null);
  const old = { dataUrl: 'data:image/png;base64,SGk=', fetchedAt: 0 };
  assert.equal(usableCacheHit(old), null);
});

test('usableCacheHit: rejects rows from an older discovery schema version', () => {
  const unversioned = { dataUrl: 'data:image/png;base64,SGk=', fetchedAt: Date.now() };
  const older = { dataUrl: 'data:image/png;base64,SGk=', fetchedAt: Date.now(), v: 1 };
  const current = { dataUrl: 'data:image/png;base64,SGk=', fetchedAt: Date.now(), v: 2 };
  assert.equal(usableCacheHit(unversioned, 2), null);
  assert.equal(usableCacheHit(older, 2), null);
  assert.equal(usableCacheHit(current, 2), current);
});

// ---------- isSameHostRedirect ----------

test('isSameHostRedirect: allows same-host, scheme, and www. redirects', () => {
  assert.equal(isSameHostRedirect('https://example.com/', 'https://example.com/home'), true);
  assert.equal(isSameHostRedirect('http://example.com/', 'https://example.com/'), true);
  assert.equal(isSameHostRedirect('https://example.com/', 'https://www.example.com/'), true);
  assert.equal(isSameHostRedirect('https://www.example.com/a', 'https://example.com/b'), true);
  assert.equal(isSameHostRedirect('http://localhost:3000/', 'http://localhost:3000/app'), true);
});

test('isSameHostRedirect: host-level, so a port change or a subdomain is another host', () => {
  assert.equal(isSameHostRedirect('http://localhost:3000/', 'http://localhost:8080/'), false);
  assert.equal(isSameHostRedirect('https://example.com/', 'https://app.example.com/'), false);
  // Registrable domain is not enough: this is the SSO case itself.
  assert.equal(
    isSameHostRedirect('https://app.corp.google.com/', 'https://login.corp.google.com/'),
    false,
  );
});

test('isSameHostRedirect: an unparsable URL on either side is a mismatch', () => {
  assert.equal(isSameHostRedirect('not a url', 'https://example.com/'), false);
  assert.equal(isSameHostRedirect('https://example.com/', ''), false);
});

test('isSameHostRedirect: rejects cross-host SSO and marketing redirects', () => {
  assert.equal(
    isSameHostRedirect('http://localhost:3000/', 'http://localhost:8080/login'),
    false,
  );
  assert.equal(
    isSameHostRedirect(
      'https://campus.corp.google.com/',
      'https://login.corp.google.com/request?authLevel=2000000',
    ),
    false,
  );
  assert.equal(
    isSameHostRedirect(
      'https://calendar.google.com/calendar/',
      'https://accounts.google.com/v3/signin/identifier',
    ),
    false,
  );
  assert.equal(
    isSameHostRedirect(
      'https://docs.google.com/presentation/',
      'https://workspace.google.com/products/slides/',
    ),
    false,
  );
});

// ---------- parseIconLinks ----------

test('parseIconLinks: collects rel="icon" tags', () => {
  const html = `
    <html><head>
      <link rel="icon" href="/favicon.ico">
      <link rel="icon" type="image/png" sizes="32x32" href="/i/32.png">
      <link rel="apple-touch-icon" sizes="180x180" href="/i/apple.png">
      <link rel="stylesheet" href="/main.css">
    </head><body></body></html>
  `;
  const cands = parseIconLinks(html);
  assert.equal(cands.length, 3);
  assert.equal(cands[0].href, '/favicon.ico');
  assert.equal(cands[1].sizes, '32x32');
  assert.equal(cands[1].type, 'image/png');
  assert.equal(cands[2].rel, 'apple-touch-icon');
});

test('parseIconLinks: tolerant of single quotes and bareword attrs', () => {
  const html = `<link rel='shortcut icon' href=/x.ico type=image/x-icon>`;
  const cands = parseIconLinks(html);
  assert.equal(cands.length, 1);
  assert.equal(cands[0].rel, 'shortcut icon');
  assert.equal(cands[0].href, '/x.ico');
  assert.equal(cands[0].type, 'image/x-icon');
});

test('parseIconLinks: only scans inside <head>', () => {
  const html = `
    <head><link rel="icon" href="/in-head.png"></head>
    <body><link rel="icon" href="/in-body.png"></body>
  `;
  const cands = parseIconLinks(html);
  assert.equal(cands.length, 1);
  assert.equal(cands[0].href, '/in-head.png');
});

test('parseIconLinks: skips non-icon rels', () => {
  const html = `<head>
    <link rel="stylesheet" href="/main.css">
    <link rel="manifest" href="/site.webmanifest">
    <link rel="preconnect" href="//cdn">
  </head>`;
  assert.deepEqual(parseIconLinks(html), []);
});

test('parseIconLinks: ignores tags without an href', () => {
  const html = `<head><link rel="icon" sizes="32x32"></head>`;
  assert.deepEqual(parseIconLinks(html), []);
});

// ---------- maxDeclaredSize ----------

test('maxDeclaredSize: parses single and multiple sizes', () => {
  assert.equal(maxDeclaredSize('32x32'), 32);
  assert.equal(maxDeclaredSize('16x16 32x32 64x64'), 64);
  assert.equal(maxDeclaredSize(null), null);
  assert.equal(maxDeclaredSize(''), null);
});

test('maxDeclaredSize: "any" reports Infinity', () => {
  assert.equal(maxDeclaredSize('any'), Infinity);
  assert.equal(maxDeclaredSize(' Any '), Infinity);
});

// ---------- pickBestIconCandidate ----------

test('pickBestIconCandidate: returns null on empty input', () => {
  assert.equal(pickBestIconCandidate([]), null);
});

test('pickBestIconCandidate: drops mask-icon entirely', () => {
  const only = [{ href: '/m.svg', rel: 'mask-icon', sizes: null, type: 'image/svg+xml' }];
  assert.equal(pickBestIconCandidate(only), null);
});

test('pickBestIconCandidate: prefers proper icon over apple-touch', () => {
  const cands = [
    { href: '/apple.png', rel: 'apple-touch-icon', sizes: '180x180', type: 'image/png' },
    { href: '/32.png',    rel: 'icon',             sizes: '32x32',   type: 'image/png' },
  ];
  assert.equal(pickBestIconCandidate(cands).href, '/32.png');
});

test('pickBestIconCandidate: prefers 32px PNG over a 16px ICO', () => {
  const cands = [
    { href: '/16.ico', rel: 'icon', sizes: '16x16', type: 'image/x-icon' },
    { href: '/32.png', rel: 'icon', sizes: '32x32', type: 'image/png' },
  ];
  assert.equal(pickBestIconCandidate(cands).href, '/32.png');
});

test('pickBestIconCandidate: SVG with sizes="any" wins on vector flexibility', () => {
  const cands = [
    { href: '/big.png', rel: 'icon', sizes: '256x256', type: 'image/png' },
    { href: '/i.svg',   rel: 'icon', sizes: 'any',     type: 'image/svg+xml' },
  ];
  assert.equal(pickBestIconCandidate(cands).href, '/i.svg');
});

test('pickBestIconCandidate: an empty data: href never wins', () => {
  // A page can declare `href="data:,"` to suppress favicon requests
  // and still offer a real icon elsewhere. `rel="icon"` outscores
  // `apple-touch-icon`, so without dropping the marker up front it
  // would take the pick and blank the row.
  const cands = [
    { href: 'data:,',     rel: 'icon',            sizes: null,      type: null },
    { href: '/apple.png', rel: 'apple-touch-icon', sizes: '180x180', type: 'image/png' },
  ];
  assert.equal(pickBestIconCandidate(cands).href, '/apple.png');
  // On its own it leaves nothing viable — the caller falls back to
  // /favicon.ico and then Google S2.
  assert.equal(pickBestIconCandidate([cands[0]]), null);
});

test('pickBestIconCandidate: falls back to apple-touch-icon when nothing else viable', () => {
  const cands = [
    { href: '/m.svg',     rel: 'mask-icon',         sizes: null,      type: 'image/svg+xml' },
    { href: '/apple.png', rel: 'apple-touch-icon',  sizes: '180x180', type: 'image/png' },
  ];
  assert.equal(pickBestIconCandidate(cands).href, '/apple.png');
});

// ---------- inline data: icons ----------

test('ensureIconForUrl: an empty data: URL is not an icon', async () => {
  // `data:,` is the standard "this site has no favicon, stop asking"
  // marker — example.com serves exactly that in its <link rel=icon>.
  // Treating it as an icon paints a blank broken <img> over the globe
  // placeholder. The data: branch returns before touching chrome.*, so
  // this is safe to exercise as a unit test.
  assert.equal(await ensureIconForUrl('data:,'), null);
  assert.equal(await ensureIconForUrl('data:image/png;base64,'), null);
  assert.equal(await ensureIconForUrl('data:image/png;base64,   '), null);
  // Malformed (no comma at all) is likewise not an icon.
  assert.equal(await ensureIconForUrl('data:image/png'), null);
});

test('ensureIconForUrl: a data: URL with a payload passes through', async () => {
  const url = 'data:image/png;base64,SGk=';
  assert.equal(await ensureIconForUrl(url), url);
});

// ---------- dataUrlToBlob ----------
// Backs the per-page blob: URL dedup that keeps the collections page from
// inlining a copy of every favicon's base64 into each row.

test('dataUrlToBlob: decodes a base64 data URL to the right bytes + MIME', async () => {
  // "Hi" → base64 "SGk=".
  const blob = dataUrlToBlob('data:image/png;base64,SGk=');
  assert.ok(blob, 'expected a Blob');
  assert.equal(blob.type, 'image/png');
  assert.equal(await blob.text(), 'Hi');
});

test('dataUrlToBlob: strips charset params from the MIME', async () => {
  const blob = dataUrlToBlob('data:image/svg+xml;charset=utf-8;base64,SGk=');
  assert.equal(blob.type, 'image/svg+xml');
});

test('dataUrlToBlob: handles a non-base64 (percent-encoded) payload', async () => {
  const blob = dataUrlToBlob('data:image/svg+xml,%3Csvg%3E%3C%2Fsvg%3E');
  assert.equal(blob.type, 'image/svg+xml');
  assert.equal(await blob.text(), '<svg></svg>');
});

test('dataUrlToBlob: returns null for a non-data URL', () => {
  assert.equal(dataUrlToBlob('https://example.com/x.png'), null);
  assert.equal(dataUrlToBlob('not a url'), null);
});

test('dataUrlToBlob: returns null (never throws) on malformed base64', () => {
  // `atob` throws on invalid base64; the function must catch it and
  // fall back to null so a corrupt cache entry can't break rendering.
  // '@@@' isn't valid base64.
  assert.equal(dataUrlToBlob('data:image/png;base64,@@@'), null);
});

test('dataUrlToBlob: returns null for a data: URL with no comma', () => {
  assert.equal(dataUrlToBlob('data:image/png;base64'), null);
});

// ---------- sitesTooltip ----------

test('sitesTooltip: one URL per line up to the cap, then a count', () => {
  assert.equal(sitesTooltip(['https://a/', 'https://b/']), 'https://a/\nhttps://b/');
  const many = Array.from({ length: 13 }, (_, i) => `https://s${i}.example/`);
  const lines = sitesTooltip(many).split('\n');
  assert.equal(lines.length, 11);
  assert.equal(lines[9], 'https://s9.example/');
  assert.equal(lines[10], '(and 3 more)');
  // Exactly at the cap: no count line.
  assert.equal(sitesTooltip(many.slice(0, 10)).split('\n').length, 10);
});

// ---------- Debug cache inspection helpers ----------

test('isIconCacheKey: matches only icon cache prefixes', () => {
  assert.equal(isIconCacheKey('siteIcon:https://example.com'), true);
  assert.equal(isIconCacheKey('pathIcon:https://example.com/a/'), true);
  assert.equal(isIconCacheKey('iconUrl:https://example.com/i.png'), true);
  assert.equal(isIconCacheKey('script:abc'), false);
  assert.equal(isIconCacheKey('collection:abc'), false);
});

test('parseCachedIconRow: extracts kind, target, expiry, and usability', () => {
  const now = 1_000_000_000_000;
  const originRow = parseCachedIconRow(
    'siteIcon:https://example.com',
    { dataUrl: 'data:image/png;base64,SGk=', fetchedAt: now - 1000, v: 2 },
    now,
  );
  assert.ok(originRow);
  assert.equal(originRow.kind, 'origin');
  assert.equal(originRow.target, 'https://example.com');
  assert.equal(originRow.isFresh, true);
  assert.equal(originRow.isUsable, true);
  assert.equal(originRow.mimeType, 'image/png');
  assert.equal(originRow.byteLength, 2);

  // Older schema version on a discovered icon is marked unusable.
  const staleSchema = parseCachedIconRow(
    'pathIcon:https://example.com/app/',
    { dataUrl: 'data:image/png;base64,SGk=', fetchedAt: now - 1000, v: 1 },
    now,
  );
  assert.ok(staleSchema);
  assert.equal(staleSchema.kind, 'path');
  assert.equal(staleSchema.isFresh, true);
  assert.equal(staleSchema.isUsable, false);
});

