// Unit tests for GM_xmlhttpRequest header-surgery classification and
// rule building. The DNR calls themselves need a browser; what's
// testable here is which headers get diverted and what rule they
// compile to.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

// The rule builder pins its condition to this extension's own id.
// Nothing else here needs `chrome`, and the id is read at call time,
// so a stub is enough to exercise the real rule shape.
globalThis.chrome = { runtime: { id: 'test-extension-id' } };

import {
  isForbiddenHeader,
  splitHeaders,
  buildHeaderRule,
  taggedRequestUrl,
} from '../../dist/gm-xhr-headers.js';

// The URL tag a rule matches on: `#sm-xhr-<rule id>`. Ids climb, so
// tests assert the shape rather than a particular number.
const TAG_RE = /#sm-xhr-\d+$/;

test('isForbiddenHeader: named forbidden headers', () => {
  for (const name of ['Origin', 'referer', 'HOST', 'User-Agent', 'Cookie', 'Connection']) {
    assert.equal(isForbiddenHeader(name), true, name);
  }
});

test('isForbiddenHeader: prefix rules cover the whole Sec-/Proxy- space', () => {
  // The reason the feature exists: Sec-Fetch-* is forbidden by prefix,
  // so it never appears on a by-name list.
  assert.equal(isForbiddenHeader('Sec-Fetch-Site'), true);
  assert.equal(isForbiddenHeader('sec-fetch-mode'), true);
  assert.equal(isForbiddenHeader('Sec-Anything-At-All'), true);
  assert.equal(isForbiddenHeader('Proxy-Authorization'), true);
});

test('isForbiddenHeader: ordinary headers are not forbidden', () => {
  for (const name of ['Content-Type', 'Authorization', 'X-Custom', 'Accept', 'secret']) {
    assert.equal(isForbiddenHeader(name), false, name);
  }
});

test('splitHeaders: routes each header to the path that can carry it', () => {
  const { passthrough, surgical } = splitHeaders({
    'X-App-Ver': '4.5',
    'Sec-Fetch-Site': 'same-origin',
    Referer: 'https://example.com/',
    'Content-Type': 'application/json',
  });
  assert.deepEqual(passthrough, {
    'X-App-Ver': '4.5',
    'Content-Type': 'application/json',
  });
  // Lowercased — DNR matches case-insensitively and echoes lowercase.
  assert.deepEqual(surgical, {
    'sec-fetch-site': 'same-origin',
    referer: 'https://example.com/',
  });
});

test('splitHeaders: no headers at all', () => {
  assert.deepEqual(splitHeaders(undefined), { passthrough: {}, surgical: {} });
});

test('buildHeaderRule: sets the overrides, and removes our Origin where there is one', () => {
  const spec = buildHeaderRule('https://example.com/api', { 'sec-fetch-site': 'same-origin' }, 'POST');
  assert.ok(spec);
  assert.deepEqual(spec.rule.action.requestHeaders, [
    { header: 'sec-fetch-site', value: 'same-origin', operation: 'set' },
    { header: 'origin', operation: 'remove' },
  ]);
});

test('buildHeaderRule: GET carries no Origin, so none is removed', () => {
  // Measured behavior: a service-worker fetch stamps Origin on POST and
  // not on GET. Removing it on GET would cost a rule per request to
  // strip a header that was never there.
  const spec = buildHeaderRule('https://example.com/api', { 'sec-fetch-site': 'same-origin' }, 'GET');
  assert.deepEqual(spec.rule.action.requestHeaders, [
    { header: 'sec-fetch-site', value: 'same-origin', operation: 'set' },
  ]);
});

test('buildHeaderRule: a plain GET needs no rule at all', () => {
  assert.equal(buildHeaderRule('https://example.com/api', {}, 'GET'), null);
});

test('buildHeaderRule: a plain POST still needs one, to drop our Origin', () => {
  const spec = buildHeaderRule('https://example.com/api', {}, 'POST');
  assert.deepEqual(spec.rule.action.requestHeaders, [
    { header: 'origin', operation: 'remove' },
  ]);
});

test('buildHeaderRule: a caller-supplied Origin wins over the default removal', () => {
  const spec = buildHeaderRule('https://example.com/api', { origin: 'https://example.com' }, 'POST');
  assert.deepEqual(spec.rule.action.requestHeaders, [
    { header: 'origin', value: 'https://example.com', operation: 'set' },
  ]);
});

test('buildHeaderRule: targets exactly this URL, and only tab-less requests', () => {
  const spec = buildHeaderRule('https://example.com/api?x=1', { referer: 'https://a.test/' });
  assert.equal(spec.rule.condition.urlFilter, `|${spec.target}|`);
  // An ordinary URL keeps the cheaper anchored urlFilter, not a regex.
  assert.equal(spec.rule.condition.regexFilter, undefined);
  assert.match(spec.target, /^https:\/\/example\.com\/api\?x=1#sm-xhr-\d+$/);
  // -1 is "no tab", which no page load is; the initiator pins it to
  // requests this extension started. Both are defence in depth behind
  // the URL tag, which already picks out one request.
  assert.deepEqual(spec.rule.condition.tabIds, [-1]);
  assert.deepEqual(spec.rule.condition.initiatorDomains, ['test-extension-id']);
  assert.deepEqual(spec.rule.condition.resourceTypes, ['xmlhttprequest']);
});

test('buildHeaderRule: a URL with urlFilter metacharacters uses an exact regex instead', () => {
  // `*` and `^` are urlFilter pattern syntax, so passing such a URL
  // through raw would widen the rule to other URLs and apply one
  // request's headers to another's.
  const url = 'https://example.com/search?q=a*b^c';
  const spec = buildHeaderRule(url, { referer: 'https://a.test/' });
  assert.equal(spec.rule.condition.urlFilter, undefined);
  const re = new RegExp(spec.rule.condition.regexFilter);
  assert.equal(re.test(spec.target), true);
  assert.equal(re.test('https://example.com/search?q=aXXbYc'), false);
  assert.equal(re.test(`${spec.target}&extra=1`), false);
  // The tag is inside the pattern, so the regex path discriminates too.
  assert.match(spec.target, TAG_RE);
  assert.equal(re.test(url), false);
});

test('buildHeaderRule: two requests to one URL get different tags', () => {
  // The whole point of the tag: a live rule must not rewrite an
  // overlapping request to the same URL, which is where one script's
  // hand-built Cookie would otherwise ride out on another's request.
  const a = buildHeaderRule('https://example.com/same', { referer: 'https://a.test/' });
  const b = buildHeaderRule('https://example.com/same', { referer: 'https://b.test/' });
  assert.notEqual(a.id, b.id);
  assert.notEqual(a.target, b.target);
  assert.equal(a.rule.id, a.id);
});

// DNR matches the URL the browser requests, not the string the script
// wrote. A rule keyed on the raw string silently fails to apply — and a
// Cookie override that doesn't apply sends the user's real session.
test('taggedRequestUrl: matches what fetch will put on the wire', () => {
  assert.equal(taggedRequestUrl('https://example.com', 7), 'https://example.com/#sm-xhr-7');
  assert.equal(taggedRequestUrl('HTTPS://Example.COM/a', 7), 'https://example.com/a#sm-xhr-7');
  assert.equal(taggedRequestUrl('https://example.com:443/a', 7), 'https://example.com/a#sm-xhr-7');
  assert.equal(
    taggedRequestUrl('https://example.com/a?q=a b', 7),
    'https://example.com/a?q=a%20b#sm-xhr-7',
  );
  // Punycode + percent-encoding, which DNR would also reject raw.
  assert.equal(taggedRequestUrl('https://exämple.com/ü', 7), 'https://xn--exmple-cua.com/%C3%BC#sm-xhr-7');
});

test('taggedRequestUrl: the script\'s own fragment is replaced', () => {
  // Safe because a fragment is never transmitted and `Response.url`
  // strips it, so nothing the script can observe depended on it.
  assert.equal(taggedRequestUrl('https://example.com/a#frag', 7), 'https://example.com/a#sm-xhr-7');
});

test('taggedRequestUrl: an unparseable URL is handed back unchanged', () => {
  // fetch is about to reject it, so there is nothing to match anyway.
  assert.equal(taggedRequestUrl('not a url', 7), 'not a url');
});

test('buildHeaderRule: hands back the URL to fetch', () => {
  // `runXhr` fetches `spec.target`, so the string the request uses and
  // the string the rule matches on are the same one rather than two
  // computations that have to agree.
  const spec = buildHeaderRule('https://example.com/a?q=a b', { referer: 'https://a.test/' });
  assert.equal(spec.target, taggedRequestUrl('https://example.com/a?q=a b', spec.id));
  assert.equal(spec.rule.condition.urlFilter, `|${spec.target}|`);
});
