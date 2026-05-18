// Tests for src/url-match.ts (compiled to dist/url-match.js).
//
// Covers @match (Chrome match-pattern grammar), @include / @exclude
// (glob + /regex/ form), and the combined urlMatchesScript() entry
// point including the "excludes win" rule.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  matchPattern,
  includePattern,
  urlMatchesScript,
} from '../../dist/url-match.js';

// ---------- matchPattern ----------

test('matchPattern: exact host + wildcard path matches', () => {
  assert.equal(matchPattern('https://example.com/*', 'https://example.com/'), true);
  assert.equal(matchPattern('https://example.com/*', 'https://example.com/path/here?q=1'), true);
});

test('matchPattern: scheme mismatch fails', () => {
  assert.equal(matchPattern('https://example.com/*', 'http://example.com/'), false);
});

test('matchPattern: scheme wildcard `*` covers http and https only', () => {
  assert.equal(matchPattern('*://example.com/*', 'http://example.com/'), true);
  assert.equal(matchPattern('*://example.com/*', 'https://example.com/'), true);
  assert.equal(matchPattern('*://example.com/*', 'ftp://example.com/'), false);
  assert.equal(matchPattern('*://example.com/*', 'file:///etc/passwd'), false);
});

test('matchPattern: subdomain wildcard matches base and any subdomain', () => {
  assert.equal(matchPattern('https://*.example.com/*', 'https://example.com/'), true);
  assert.equal(matchPattern('https://*.example.com/*', 'https://www.example.com/x'), true);
  assert.equal(matchPattern('https://*.example.com/*', 'https://a.b.example.com/x'), true);
  assert.equal(matchPattern('https://*.example.com/*', 'https://notexample.com/'), false);
  assert.equal(matchPattern('https://*.example.com/*', 'https://example.org/'), false);
});

test('matchPattern: host wildcard `*` matches any host', () => {
  assert.equal(matchPattern('https://*/*', 'https://example.com/'), true);
  assert.equal(matchPattern('https://*/*', 'https://anything.else/path'), true);
});

test('matchPattern: path glob can target query and fragment', () => {
  assert.equal(matchPattern('https://example.com/path*', 'https://example.com/path/here?q=1'), true);
  assert.equal(matchPattern('https://example.com/*?id=*', 'https://example.com/x?id=42'), true);
  assert.equal(matchPattern('https://example.com/foo', 'https://example.com/foo'), true);
  assert.equal(matchPattern('https://example.com/foo', 'https://example.com/foo/bar'), false);
});

test('matchPattern: <all_urls> matches http/https/file/ftp', () => {
  assert.equal(matchPattern('<all_urls>', 'https://example.com/'), true);
  assert.equal(matchPattern('<all_urls>', 'http://example.com/'), true);
  assert.equal(matchPattern('<all_urls>', 'file:///etc/passwd'), true);
  assert.equal(matchPattern('<all_urls>', 'ftp://example.com/'), true);
  assert.equal(matchPattern('<all_urls>', 'chrome://extensions/'), false);
});

test('matchPattern: host comparison is case-insensitive', () => {
  assert.equal(matchPattern('https://EXAMPLE.com/*', 'https://example.com/'), true);
  assert.equal(matchPattern('https://*.EXAMPLE.com/*', 'https://WWW.example.com/x'), true);
});

test('matchPattern: file:// patterns work', () => {
  assert.equal(matchPattern('file:///*', 'file:///etc/passwd'), true);
  assert.equal(matchPattern('file:///etc/*', 'file:///etc/passwd'), true);
  assert.equal(matchPattern('file:///etc/*', 'file:///var/log'), false);
});

test('matchPattern: malformed pattern returns false', () => {
  assert.equal(matchPattern('not a url pattern', 'https://example.com/'), false);
  assert.equal(matchPattern('https://example.com', 'https://example.com/'), false); // missing /path
});

test('matchPattern: malformed URL returns false', () => {
  assert.equal(matchPattern('https://*/*', 'not-a-url'), false);
});

// ---------- includePattern ----------

test('includePattern: glob with `*` matches across slashes', () => {
  assert.equal(includePattern('https://example.com/*', 'https://example.com/anything'), true);
  assert.equal(includePattern('*://example.*/foo*', 'https://example.org/foobar'), true);
  assert.equal(includePattern('*example*', 'https://something.example.org/'), true);
});

test('includePattern: glob anchors to whole URL', () => {
  assert.equal(includePattern('https://example.com/', 'https://example.com/extra'), false);
});

test('includePattern: /regex/ form is honored', () => {
  assert.equal(includePattern('/^https:\\/\\/example\\.com\\/.*$/', 'https://example.com/x'), true);
  assert.equal(includePattern('/example\\.com/', 'https://example.com/x'), true);
  assert.equal(includePattern('/example\\.com/', 'https://other.org/x'), false);
});

test('includePattern: invalid regex returns false without throwing', () => {
  assert.equal(includePattern('/[unclosed/', 'https://example.com/'), false);
});

// ---------- urlMatchesScript ----------

const NONE = { matches: [], includes: [], excludes: [] };

test('urlMatchesScript: returns false when no patterns are listed', () => {
  assert.equal(urlMatchesScript('https://example.com/', NONE), false);
});

test('urlMatchesScript: any @match hit returns true', () => {
  const m = {
    matches: ['https://example.org/*', 'https://example.com/*'],
    includes: [],
    excludes: [],
  };
  assert.equal(urlMatchesScript('https://example.com/path', m), true);
  assert.equal(urlMatchesScript('https://other.example/', m), false);
});

test('urlMatchesScript: any @include hit returns true', () => {
  const m = { matches: [], includes: ['*example*'], excludes: [] };
  assert.equal(urlMatchesScript('https://example.com/', m), true);
  assert.equal(urlMatchesScript('https://other.org/', m), false);
});

test('urlMatchesScript: @exclude wins over @match', () => {
  const m = {
    matches: ['https://example.com/*'],
    includes: [],
    excludes: ['https://example.com/admin/*'],
  };
  assert.equal(urlMatchesScript('https://example.com/page', m), true);
  assert.equal(urlMatchesScript('https://example.com/admin/users', m), false);
});

test('urlMatchesScript: @exclude wins over @include', () => {
  const m = {
    matches: [],
    includes: ['*example.com*'],
    excludes: ['*admin*'],
  };
  assert.equal(urlMatchesScript('https://example.com/page', m), true);
  assert.equal(urlMatchesScript('https://example.com/admin/users', m), false);
});

// Port handling. Chrome's docs say match patterns don't allow ports,
// but Chrome's matcher accepts them and matches the corresponding port.
// We follow Chrome here so OUR matcher (which drives the badge) stays
// in step with what Chrome actually injects — otherwise localhost
// development with ports paints every tab UNEXPECTED.
test('matchPattern: port in pattern matches matching port', () => {
  assert.equal(matchPattern('http://127.0.0.1:8080/*', 'http://127.0.0.1:8080/x'), true);
  assert.equal(matchPattern('http://127.0.0.1:8080/*', 'http://127.0.0.1:9090/x'), false);
});

test('matchPattern: port-less pattern matches any port', () => {
  assert.equal(matchPattern('http://127.0.0.1/*', 'http://127.0.0.1:8080/x'), true);
  assert.equal(matchPattern('http://127.0.0.1/*', 'http://127.0.0.1/x'), true);
});

test('matchPattern: port pinning works with subdomain wildcard', () => {
  assert.equal(matchPattern('https://*.example.com:8443/*', 'https://api.example.com:8443/x'), true);
  assert.equal(matchPattern('https://*.example.com:8443/*', 'https://api.example.com/x'), false);
});

test('urlMatchesScript: regex-form exclude is honored', () => {
  const m = {
    matches: ['https://example.com/*'],
    includes: [],
    excludes: ['/\\/admin\\//'],
  };
  assert.equal(urlMatchesScript('https://example.com/admin/users', m), false);
  assert.equal(urlMatchesScript('https://example.com/public', m), true);
});
