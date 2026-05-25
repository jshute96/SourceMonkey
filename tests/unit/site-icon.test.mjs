// Tests for src/site-icon.ts (compiled to dist/site-icon.js).
//
// Covers the icon-specific pure helpers: `@icon`-header URL
// extraction, icon-link parsing + scoring, and cache-freshness rules.
// `@match`-pattern → origin/linkUrl extraction lives in
// src/match-targets.ts and is tested separately. The network fetch
// pipeline is not unit-tested here — it depends on real HTTP.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  iconRefFromHeader,
  isCacheFresh,
  parseIconLinks,
  pickBestIconCandidate,
  maxDeclaredSize,
} from '../../dist/site-icon.js';

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
