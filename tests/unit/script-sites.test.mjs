import { test } from 'node:test';
import assert from 'node:assert/strict';

import { scriptSitePage, sitePageRow } from '../../dist/script-sites.js';

test('Greasy Fork code URL maps to the script page, slug kept', () => {
  assert.deepEqual(
    scriptSitePage('https://greasyfork.org/scripts/12345-my-script/code/My%20Script.user.js'),
    {
      siteName: 'Greasy Fork',
      url: 'https://greasyfork.org/scripts/12345-my-script',
      key: 'greasyfork.org:12345',
    },
  );
});

test('Greasy Fork update host maps to the bare-id page', () => {
  assert.deepEqual(
    scriptSitePage('https://update.greasyfork.org/scripts/12345/My%20Script.user.js'),
    {
      siteName: 'Greasy Fork',
      url: 'https://greasyfork.org/scripts/12345',
      key: 'greasyfork.org:12345',
    },
  );
});

test('every Greasy Fork spelling of one script shares a key', () => {
  const keys = [
    'https://greasyfork.org/scripts/12345-my-script/code/x.user.js',
    'https://update.greasyfork.org/scripts/12345/x.user.js',
    'https://www.greasyfork.org/scripts/12345-my-script',
    'https://greasyfork.org/en/scripts/12345-my-script',
    'https://greasyfork.org/zh-CN/scripts/12345',
  ].map((u) => scriptSitePage(u)?.key);
  assert.deepEqual(new Set(keys), new Set(['greasyfork.org:12345']));
});

test('Greasy Fork locale segments are preserved, including odd shapes', () => {
  const page = (u) => scriptSitePage(u)?.url;
  assert.equal(
    page('https://greasyfork.org/zh-CN/scripts/999-x/code/x.user.js'),
    'https://greasyfork.org/zh-CN/scripts/999-x',
  );
  assert.equal(
    page('https://greasyfork.org/en/scripts/999/code/x.user.js'),
    'https://greasyfork.org/en/scripts/999',
  );
  // Three-letter and numeric-region locales still yield a row rather
  // than failing the whole match.
  assert.equal(
    page('https://greasyfork.org/es-419/scripts/999-x/code/x.user.js'),
    'https://greasyfork.org/es-419/scripts/999-x',
  );
  assert.equal(
    page('https://greasyfork.org/ckb/scripts/999-x/code/x.user.js'),
    'https://greasyfork.org/ckb/scripts/999-x',
  );
});

test('a percent-encoded slug stays encoded in the page URL', () => {
  assert.equal(
    scriptSitePage('https://greasyfork.org/scripts/1-my%20script/code/x.user.js')?.url,
    'https://greasyfork.org/scripts/1-my%20script',
  );
});

test('Sleazy Fork uses the same rewrite as Greasy Fork', () => {
  assert.deepEqual(
    scriptSitePage('https://update.sleazyfork.org/scripts/42/thing.user.js'),
    {
      siteName: 'Sleazy Fork',
      url: 'https://sleazyfork.org/scripts/42',
      key: 'sleazyfork.org:42',
    },
  );
  assert.equal(
    scriptSitePage('https://sleazyfork.org/scripts/42-thing/code/thing.user.js')?.url,
    'https://sleazyfork.org/scripts/42-thing',
  );
});

test('OpenUserJS install, src, and page URLs agree', () => {
  const page = 'https://openuserjs.org/scripts/Marti/Cross-Domain_Storage';
  const key = 'openuserjs.org:Marti/Cross-Domain_Storage';
  assert.deepEqual(
    scriptSitePage('https://openuserjs.org/install/Marti/Cross-Domain_Storage.user.js'),
    { siteName: 'OpenUserJS', url: page, key },
  );
  assert.deepEqual(
    scriptSitePage('https://openuserjs.org/src/scripts/Marti/Cross-Domain_Storage.user.js'),
    { siteName: 'OpenUserJS', url: page, key },
  );
  assert.equal(scriptSitePage(`${page}/issues`)?.key, key);
});

test('gist raw and page URLs map to the gist page', () => {
  assert.deepEqual(
    scriptSitePage('https://gist.githubusercontent.com/someone/abc123def/raw/deadbeef/s.user.js'),
    {
      siteName: 'GitHub Gist',
      url: 'https://gist.github.com/someone/abc123def',
      key: 'gist.github.com:abc123def',
    },
  );
  // No sha segment, and the bare page form.
  assert.equal(
    scriptSitePage('https://gist.githubusercontent.com/someone/abc123def/raw/s.user.js')?.url,
    'https://gist.github.com/someone/abc123def',
  );
  assert.equal(
    scriptSitePage('https://gist.github.com/someone/ABC123DEF')?.key,
    'gist.github.com:abc123def',
  );
});

test('http input yields an https page URL', () => {
  assert.equal(
    scriptSitePage('http://greasyfork.org/scripts/1/x.user.js')?.url,
    'https://greasyfork.org/scripts/1',
  );
});

test('unknown hosts and non-script paths on known hosts yield null', () => {
  assert.equal(scriptSitePage('https://example.com/s.user.js'), null);
  assert.equal(scriptSitePage('https://greasyfork.org/users/1234'), null);
  assert.equal(scriptSitePage('https://greasyfork.org/scripts/not-a-number/code/x.user.js'), null);
  assert.equal(scriptSitePage('https://openuserjs.org/about'), null);
  assert.equal(scriptSitePage('https://gist.githubusercontent.com/someone/abc/other'), null);
  // Lookalike host, not the real one.
  assert.equal(scriptSitePage('https://greasyfork.org.example.com/scripts/1/x.user.js'), null);
});

test('non-http locations yield null', () => {
  assert.equal(scriptSitePage('file:///home/me/s.user.js'), null);
  assert.equal(scriptSitePage('/home/me/s.user.js'), null);
  assert.equal(scriptSitePage(''), null);
});

test('sitePageRow labels the row with the site name', () => {
  assert.deepEqual(
    sitePageRow('https://update.greasyfork.org/scripts/12345/x.user.js', undefined),
    { label: 'Greasy Fork page', url: 'https://greasyfork.org/scripts/12345' },
  );
  assert.equal(
    sitePageRow('https://openuserjs.org/install/Marti/Thing.user.js', undefined)?.label,
    'OpenUserJS page',
  );
  assert.equal(sitePageRow('file:///home/me/s.user.js', undefined), null);
});

test('sitePageRow suppresses a @homepage naming the same script', () => {
  const location = 'https://update.greasyfork.org/scripts/12345/x.user.js';
  // The spelling authors actually write: locale prefix and slug, none
  // of which the derived URL has.
  assert.equal(sitePageRow(location, 'https://greasyfork.org/en/scripts/12345-my-script'), null);
  assert.equal(sitePageRow(location, 'https://greasyfork.org/scripts/12345'), null);
  // A different script on the same site, or an unrelated page, is not
  // a duplicate.
  assert.ok(sitePageRow(location, 'https://greasyfork.org/en/scripts/999-other'));
  assert.ok(sitePageRow(location, 'https://example.com/mine'));
  assert.ok(sitePageRow(location, 'not a url'));
});

test('sitePageRow suppresses a location that already is the page', () => {
  assert.equal(sitePageRow('https://greasyfork.org/scripts/12345-my-script', undefined), null);
  assert.equal(sitePageRow('https://greasyfork.org/scripts/12345-my-script/', undefined), null);
  assert.equal(sitePageRow('https://gist.github.com/someone/abc123def', undefined), null);
});
