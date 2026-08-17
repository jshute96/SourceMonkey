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
  canonicalizeUrlForRule,
  acquireHeaderGate,
} from '../../dist/gm-xhr-headers.js';

// Let every grant scheduled so far land. Grants resolve promises, so a
// couple of microtask turns is all "so far" ever needs.
async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

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
  assert.equal(spec.rule.condition.urlFilter, '|https://example.com/api?x=1|');
  // -1 is "no tab", which no page load is; the initiator pins it to
  // requests this extension started, so a site's own service worker
  // hitting the same URL doesn't pick up the headers.
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
  assert.equal(re.test(url), true);
  assert.equal(re.test('https://example.com/search?q=aXXbYc'), false);
  assert.equal(re.test(`${url}&extra=1`), false);
});

test('buildHeaderRule: an ordinary URL keeps the cheaper anchored urlFilter', () => {
  const spec = buildHeaderRule('https://example.com/api?x=1', { referer: 'https://a.test/' });
  assert.equal(spec.rule.condition.regexFilter, undefined);
  assert.equal(spec.rule.condition.urlFilter, '|https://example.com/api?x=1|');
});

test('buildHeaderRule: ids are unique so concurrent requests do not collide', () => {
  const a = buildHeaderRule('https://example.com/a', { referer: 'https://a.test/' });
  const b = buildHeaderRule('https://example.com/b', { referer: 'https://b.test/' });
  assert.notEqual(a.id, b.id);
  assert.equal(a.rule.id, a.id);
});

// DNR matches the URL the browser requests, not the string the script
// wrote. A rule keyed on the raw string silently fails to apply — and a
// Cookie override that doesn't apply sends the user's real session.
test('canonicalizeUrlForRule: matches what fetch will put on the wire', () => {
  assert.equal(canonicalizeUrlForRule('https://example.com'), 'https://example.com/');
  assert.equal(canonicalizeUrlForRule('HTTPS://Example.COM/a'), 'https://example.com/a');
  assert.equal(canonicalizeUrlForRule('https://example.com:443/a'), 'https://example.com/a');
  assert.equal(canonicalizeUrlForRule('https://example.com/a?q=a b'), 'https://example.com/a?q=a%20b');
  // The fragment never leaves the browser, so a rule carrying one could
  // never match.
  assert.equal(canonicalizeUrlForRule('https://example.com/a#frag'), 'https://example.com/a');
  // Punycode + percent-encoding, which DNR would also reject raw.
  assert.equal(canonicalizeUrlForRule('https://exämple.com/ü'), 'https://xn--exmple-cua.com/%C3%BC');
});

test('canonicalizeUrlForRule: an unparseable URL is handed back unchanged', () => {
  // fetch is about to reject it, so there is nothing to match anyway.
  assert.equal(canonicalizeUrlForRule('not a url'), 'not a url');
});

test('buildHeaderRule: hands back the target it matched on', () => {
  // `runXhr` keys the same-URL gate on `spec.target`, so the string the
  // gate serializes on and the string the rule matches on are the same
  // object rather than two calls that have to agree.
  const spec = buildHeaderRule('https://example.com/a?q=a b', { referer: 'https://a.test/' });
  assert.equal(spec.target, 'https://example.com/a?q=a%20b');
  assert.equal(spec.rule.condition.urlFilter, `|${spec.target}|`);
});

test('buildHeaderRule: the condition uses the canonical URL', () => {
  const spec = buildHeaderRule('https://example.com/a?q=a b', { referer: 'https://a.test/' });
  assert.equal(spec.rule.condition.urlFilter, '|https://example.com/a?q=a%20b|');
});

// --- Same-URL gate. Exclusive = a request whose header rule is live;
// shared = a rule-less request that must not run under anyone's rule.

test('gate: rule-less requests to one URL run together', { timeout: 2000 }, async () => {
  const a = await acquireHeaderGate('https://example.com/gate1', false);
  const b = await acquireHeaderGate('https://example.com/gate1', false);
  // Both resolved without either releasing — no serialization between
  // plain requests.
  a();
  b();
});

test('gate: a rule holder excludes everyone until its rule is off', { timeout: 2000 }, async () => {
  const order = [];
  const release = await acquireHeaderGate('https://example.com/gate2', true);
  const laterExclusive = acquireHeaderGate('https://example.com/gate2', true)
    .then((r) => { order.push('exclusive'); return r; });
  const laterShared = acquireHeaderGate('https://example.com/gate2', false)
    .then((r) => { order.push('shared'); return r; });
  await settle();
  assert.deepEqual(order, [], 'nothing may run while a rule is live');
  release();
  // FIFO: the exclusive waiter queued first, so it alone goes next.
  await settle();
  assert.deepEqual(order, ['exclusive']);
  (await laterExclusive)();
  await settle();
  assert.deepEqual(order, ['exclusive', 'shared']);
  (await laterShared)();
});

test('gate: a rule waits for every in-flight rule-less request', { timeout: 2000 }, async () => {
  const a = await acquireHeaderGate('https://example.com/gate3', false);
  const b = await acquireHeaderGate('https://example.com/gate3', false);
  let granted = false;
  const pending = acquireHeaderGate('https://example.com/gate3', true)
    .then((r) => { granted = true; return r; });
  await settle();
  assert.equal(granted, false);
  a();
  await settle();
  assert.equal(granted, false, 'one shared holder still in flight');
  b();
  await settle();
  assert.equal(granted, true);
  (await pending)();
});

test('gate: a rule-less request queued behind a waiting rule cannot jump it', { timeout: 2000 }, async () => {
  // The hazard this guards: the rule is *about* to exist, and a plain
  // request slipping in front would be in flight when it lands.
  const order = [];
  const shared0 = await acquireHeaderGate('https://example.com/gate4', false);
  const pendingExclusive = acquireHeaderGate('https://example.com/gate4', true)
    .then((r) => { order.push('exclusive'); return r; });
  const pendingShared = acquireHeaderGate('https://example.com/gate4', false)
    .then((r) => { order.push('late shared'); return r; });
  await settle();
  assert.deepEqual(order, [], 'the late shared request must queue, not overlap shared0');
  shared0();
  await settle();
  assert.deepEqual(order, ['exclusive']);
  (await pendingExclusive)();
  await settle();
  assert.deepEqual(order, ['exclusive', 'late shared']);
  (await pendingShared)();
});

test('gate: different URLs do not contend', { timeout: 2000 }, async () => {
  const releaseX = await acquireHeaderGate('https://example.com/gate5', true);
  // Resolves immediately despite the live rule on /x.
  const releaseY = await acquireHeaderGate('https://example.com/y', true);
  releaseX();
  releaseY();
});

test('gate: releasing twice is a no-op', { timeout: 2000 }, async () => {
  const release = await acquireHeaderGate('https://example.com/gate6', false);
  release();
  release();
  // A double release that corrupted the holder count (-1 never gets
  // back to 0) would leave the next exclusive acquire queued forever —
  // race it against a timer so that shows up as a failure, not a hang.
  const winner = await Promise.race([
    acquireHeaderGate('https://example.com/gate6', true).then((r) => { r(); return 'acquired'; }),
    new Promise((resolve) => setTimeout(() => resolve('hung'), 200)),
  ]);
  assert.equal(winner, 'acquired');
});

test('gate: one release admits every shared waiter, not just the first', { timeout: 2000 }, async () => {
  // The pump loops on purpose: plain requests behind an override should
  // all resume together. Granting one per release would still pass the
  // exclusion tests while quietly serializing them.
  const release = await acquireHeaderGate('https://example.com/gate7', true);
  const granted = [];
  const a = acquireHeaderGate('https://example.com/gate7', false).then((r) => { granted.push('a'); return r; });
  const b = acquireHeaderGate('https://example.com/gate7', false).then((r) => { granted.push('b'); return r; });
  const c = acquireHeaderGate('https://example.com/gate7', false).then((r) => { granted.push('c'); return r; });
  await settle();
  assert.deepEqual(granted, []);
  release();
  await settle();
  assert.deepEqual(granted.sort(), ['a', 'b', 'c'], 'all three shared waiters resume on one release');
  (await a)();
  (await b)();
  (await c)();
});

test('gate: the key is the whole URL, so different paths never contend', { timeout: 2000 }, async () => {
  // Same host, different path — the gate must not degrade into a
  // per-host lock, which would serialize a site's whole API surface.
  const releaseA = await acquireHeaderGate('https://example.com/a', true);
  const releaseB = await acquireHeaderGate('https://example.com/b', true);
  releaseA();
  releaseB();
});

test('gate: an aborted waiter gives up its turn instead of queueing', { timeout: 2000 }, async () => {
  // Without this, a queued request's own `timeout` would be bounded by
  // whatever the holder ahead of it is waiting on.
  const release = await acquireHeaderGate('https://example.com/gate9', true);
  const controller = new AbortController();
  const pending = acquireHeaderGate('https://example.com/gate9', true, controller.signal);
  const behind = acquireHeaderGate('https://example.com/gate9', false);
  controller.abort();
  assert.equal(await pending, null, 'the aborted waiter resolves null rather than waiting');
  // And it is really out of the queue: the shared request behind it
  // goes as soon as the holder releases, not after a dead turn.
  release();
  const releaseBehind = await behind;
  assert.notEqual(releaseBehind, null);
  releaseBehind();
});

test('gate: acquiring with an already-aborted signal never takes the gate', { timeout: 2000 }, async () => {
  const controller = new AbortController();
  controller.abort();
  assert.equal(await acquireHeaderGate('https://example.com/gate10', true, controller.signal), null);
  // The gate was never held, so an ordinary acquire still works.
  const release = await acquireHeaderGate('https://example.com/gate10', true);
  release();
});
