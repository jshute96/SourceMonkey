// Tests for src/site-icon.ts (compiled to dist/site-icon.js).
//
// Covers the pure helpers: origin/probe-URL extraction, icon-link
// parsing + scoring, and cache-freshness rules. The network fetch
// pipeline is not unit-tested here — it depends on real HTTP.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  originFromMatchPattern,
  representativeOrigin,
  representativeMatch,
  linkPathFromMatchPath,
  isCacheFresh,
  parseIconLinks,
  pickBestIconCandidate,
  maxDeclaredSize,
} from '../../dist/site-icon.js';

// ---------- originFromMatchPattern ----------

test('originFromMatchPattern: exact host with explicit scheme', () => {
  assert.equal(
    originFromMatchPattern('https://example.com/*'),
    'https://example.com',
  );
  assert.equal(
    originFromMatchPattern('http://example.com/*'),
    'http://example.com',
  );
});

test('originFromMatchPattern: scheme wildcard becomes https', () => {
  assert.equal(
    originFromMatchPattern('*://example.com/*'),
    'https://example.com',
  );
});

test('originFromMatchPattern: subdomain wildcard collapses to base host', () => {
  assert.equal(
    originFromMatchPattern('https://*.example.com/*'),
    'https://example.com',
  );
  assert.equal(
    originFromMatchPattern('*://*.example.co.uk/*'),
    'https://example.co.uk',
  );
});

test('originFromMatchPattern: strips trailing :port', () => {
  assert.equal(
    originFromMatchPattern('http://localhost:8080/*'),
    'http://localhost',
  );
});

test('originFromMatchPattern: host of `*` is too broad', () => {
  assert.equal(originFromMatchPattern('*://*/*'), null);
  assert.equal(originFromMatchPattern('https://*/*'), null);
});

test('originFromMatchPattern: TLD wildcard rejected', () => {
  assert.equal(originFromMatchPattern('https://example.*/*'), null);
});

test('originFromMatchPattern: non-http schemes rejected', () => {
  assert.equal(originFromMatchPattern('file:///home/user/*'), null);
  assert.equal(originFromMatchPattern('ftp://example.com/*'), null);
});

test('originFromMatchPattern: <all_urls> has no representative site', () => {
  assert.equal(originFromMatchPattern('<all_urls>'), null);
});

test('originFromMatchPattern: malformed patterns return null', () => {
  assert.equal(originFromMatchPattern(''), null);
  assert.equal(originFromMatchPattern('not a pattern'), null);
  assert.equal(originFromMatchPattern('://example.com/*'), null);
});

test('originFromMatchPattern: lowercases the host', () => {
  assert.equal(
    originFromMatchPattern('HTTPS://Example.COM/*'),
    'https://example.com',
  );
});

// ---------- representativeOrigin ----------

test('representativeOrigin: returns first usable @match', () => {
  assert.equal(
    representativeOrigin({
      matches: ['file:///x/*', '*://example.com/*'],
    }),
    'https://example.com',
  );
});

test('representativeOrigin: null when no matches yield an origin', () => {
  assert.equal(
    representativeOrigin({
      matches: ['<all_urls>', 'file:///x/*'],
    }),
    null,
  );
  assert.equal(representativeOrigin({ matches: [] }), null);
});

// ---------- representativeMatch (probe + link URLs) ----------

test('representativeMatch: probe URL keeps the literal path prefix', () => {
  assert.deepEqual(
    representativeMatch({ matches: ['https://connect.garmin.com/app/*'] }),
    {
      origin: 'https://connect.garmin.com',
      probeUrl: 'https://connect.garmin.com/app/',
      linkUrl: 'https://connect.garmin.com/app/',
    },
  );
  assert.deepEqual(
    representativeMatch({ matches: ['https://example.com/posts/*/edit'] }),
    {
      origin: 'https://example.com',
      probeUrl: 'https://example.com/posts/',
      linkUrl: 'https://example.com/posts/',
    },
  );
});

test('representativeMatch: all-glob path collapses to /', () => {
  assert.deepEqual(
    representativeMatch({ matches: ['https://example.com/*'] }),
    {
      origin: 'https://example.com',
      probeUrl: 'https://example.com/',
      linkUrl: 'https://example.com/',
    },
  );
});

test('representativeMatch: subdomain-wildcard pattern keeps the path', () => {
  // probeUrl uses the literal-prefix cut (mid-segment), while linkUrl
  // backs off to the last complete segment so the click-through lands
  // on a valid directory.
  assert.deepEqual(
    representativeMatch({ matches: ['*://*.example.com/foo/bar*'] }),
    {
      origin: 'https://example.com',
      probeUrl: 'https://example.com/foo/bar',
      linkUrl: 'https://example.com/foo/',
    },
  );
});

test('representativeMatch: null for patterns without a usable origin', () => {
  assert.equal(representativeMatch({ matches: ['<all_urls>'] }), null);
  assert.equal(representativeMatch({ matches: ['file:///x/*'] }), null);
  assert.equal(representativeMatch({ matches: [] }), null);
});

// ---------- linkPathFromMatchPath ----------

test('linkPathFromMatchPath: full-glob path is just /', () => {
  assert.equal(linkPathFromMatchPath('/*'), '/');
});

test('linkPathFromMatchPath: keeps complete segments up to the first wildcard', () => {
  assert.equal(linkPathFromMatchPath('/app/*'), '/app/');
  assert.equal(linkPathFromMatchPath('/posts/*/edit'), '/posts/');
  assert.equal(linkPathFromMatchPath('/a/b/c/*'), '/a/b/c/');
});

test('linkPathFromMatchPath: trims partial wildcard segments', () => {
  // `bar*` is partial: link target backs off to the parent directory.
  assert.equal(linkPathFromMatchPath('/foo/bar*'), '/foo/');
  assert.equal(linkPathFromMatchPath('/foo/bar*/baz'), '/foo/');
});

test('linkPathFromMatchPath: pure-literal paths pass through unchanged', () => {
  assert.equal(linkPathFromMatchPath('/'), '/');
  assert.equal(linkPathFromMatchPath('/foo'), '/foo');
  assert.equal(linkPathFromMatchPath('/foo/bar'), '/foo/bar');
  assert.equal(linkPathFromMatchPath('/foo/bar/'), '/foo/bar/');
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

test('pickBestIconCandidate: falls back to apple-touch-icon when nothing else viable', () => {
  const cands = [
    { href: '/m.svg',     rel: 'mask-icon',         sizes: null,      type: 'image/svg+xml' },
    { href: '/apple.png', rel: 'apple-touch-icon',  sizes: '180x180', type: 'image/png' },
  ];
  assert.equal(pickBestIconCandidate(cands).href, '/apple.png');
});
