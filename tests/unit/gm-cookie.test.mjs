// Unit tests for the SW-side `GM_cookie` handler (`runCookieCall`).
//
// chrome.cookies is stubbed with a small in-memory jar so every call is
// recorded and `get` sees what `set` stored.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

const calls = [];
let jar = [];

globalThis.chrome = {
  cookies: {
    // Filters by name, by path for a `url` query (the cookies sent to
    // it), and by domain or subdomain for a `domain` query.
    getAll: (q) => {
      calls.push({ fn: 'getAll', q });
      const path = q.url ? new URL(q.url).pathname : null;
      const domain = q.domain?.replace(/^\./, '');
      return Promise.resolve(jar.filter((c) => (q.name === undefined || c.name === q.name)
        && (path === null || path.startsWith(c.path))
        && (domain === undefined || c.domain.replace(/^\./, '').endsWith(domain))));
    },
    set: (d) => {
      calls.push({ fn: 'set', d });
      return Promise.resolve({ ...d, domain: 'example.com', path: '/', httpOnly: false, session: true, hostOnly: true, sameSite: 'unspecified' });
    },
    remove: (d) => {
      calls.push({ fn: 'remove', d });
      return Promise.resolve(d);
    },
  },
};

const { runCookieCall, HTTP_ONLY_HIDDEN } = await import('../../dist/extension/gm-cookie.js');

function cookie(name, extra = {}) {
  return {
    name, value: `v-${name}`, domain: 'example.com', path: '/', secure: false, httpOnly: false,
    sameSite: 'lax', session: true, hostOnly: true, storeId: '0', ...extra,
  };
}

// A script matching https://example.com/* only.
const ctx = {
  pageUrl: 'https://example.com/page',
  scriptMatches: (url) => url.startsWith('https://example.com/'),
};

function reset(cookies = []) {
  calls.length = 0;
  jar = cookies;
}

test('list defaults to the page URL and hides httpOnly cookies', async () => {
  reset([cookie('a'), cookie('secret', { httpOnly: true })]);
  const r = await runCookieCall('list', {}, ctx);
  assert.equal(r.ok, true);
  assert.deepEqual(r.cookies.map((c) => c.name), ['a']);
  assert.equal(calls[0].q.url, 'https://example.com/page');
  // storeId isn't passed on to the script, as in TM.
  assert.equal('storeId' in r.cookies[0], false);
});

test('list resolves a relative url against the page and passes the filters', async () => {
  reset();
  await runCookieCall('list', { url: '/other', name: 'a', path: '/' }, ctx);
  assert.deepEqual(calls[0].q, { url: 'https://example.com/other', name: 'a', path: '/' });
});

test('list refuses a URL the script does not match', async () => {
  reset();
  const r = await runCookieCall('list', { url: 'https://evil.example/' }, ctx);
  assert.equal(r.ok, false);
  assert.match(r.error, /@match and @include rules must cover the cookie URL https:\/\/evil\.example\//);
  assert.equal(calls.length, 0);
});

test('list by domain alone checks https://<domain>/ and sends no url', async () => {
  reset();
  const ok = await runCookieCall('list', { domain: '.example.com' }, ctx);
  assert.equal(ok.ok, true);
  assert.deepEqual(calls[0].q, { domain: '.example.com' });
  const refused = await runCookieCall('list', { domain: 'other.test' }, ctx);
  assert.equal(refused.ok, false);
  assert.match(refused.error, /https:\/\/other\.test\//);
});

test('a non-http URL is refused', async () => {
  reset();
  const r = await runCookieCall('list', {}, { ...ctx, pageUrl: 'file:///tmp/x.html' });
  assert.equal(r.ok, false);
  assert.match(r.error, /only be used on http and https URLs/);
});

test('set fills url and defaults secure from the scheme', async () => {
  reset();
  const r = await runCookieCall('set', { name: 'n', value: 1 }, ctx);
  assert.equal(r.ok, true);
  const set = calls.find((c) => c.fn === 'set').d;
  assert.deepEqual(set, { url: 'https://example.com/page', name: 'n', value: '1', secure: true });
});

test('set refuses httpOnly, and refuses replacing an httpOnly cookie', async () => {
  reset();
  assert.deepEqual(await runCookieCall('set', { name: 'n', httpOnly: true }, ctx), { ok: false, error: HTTP_ONLY_HIDDEN });
  reset([cookie('n', { httpOnly: true })]);
  assert.deepEqual(await runCookieCall('set', { name: 'n', value: 'x' }, ctx), { ok: false, error: HTTP_ONLY_HIDDEN });
  assert.equal(calls.some((c) => c.fn === 'set'), false);
});

test('set refuses a sameSite Chrome does not take', async () => {
  reset();
  const r = await runCookieCall('set', { name: 'n', sameSite: 'none' }, ctx);
  assert.equal(r.ok, false);
  assert.match(r.error, /sameSite must be one of no_restriction, lax, strict, unspecified, not none/);
});

test('an httpOnly cookie of the same name on another path blocks set and delete', async () => {
  // `get` would have found only the /page one, which isn't httpOnly.
  reset([cookie('sid', { path: '/page' }), cookie('sid', { httpOnly: true, path: '/' })]);
  assert.deepEqual(await runCookieCall('delete', { name: 'sid' }, ctx), { ok: false, error: HTTP_ONLY_HIDDEN });
  // A set aimed at another path finds it through the domain lookup.
  reset([cookie('sid', { httpOnly: true, path: '/admin' })]);
  assert.deepEqual(await runCookieCall('set', { name: 'sid', path: '/admin' }, ctx), { ok: false, error: HTTP_ONLY_HIDDEN });
  assert.equal(calls.some((c) => c.fn === 'set' || c.fn === 'remove'), false);
});

test('delete needs a name and leaves httpOnly cookies alone', async () => {
  reset();
  const noName = await runCookieCall('delete', {}, ctx);
  assert.equal(noName.ok, false);
  assert.match(noName.error, /The cookie to delete needs a name/);
  reset([cookie('n', { httpOnly: true })]);
  assert.deepEqual(await runCookieCall('delete', { name: 'n' }, ctx), { ok: false, error: HTTP_ONLY_HIDDEN });
  reset([cookie('n')]);
  assert.deepEqual(await runCookieCall('delete', { name: 'n' }, ctx), { ok: true });
  assert.deepEqual(calls.find((c) => c.fn === 'remove').d, { url: 'https://example.com/page', name: 'n' });
});

test('the store id is passed through for an incognito tab', async () => {
  reset();
  await runCookieCall('list', {}, { ...ctx, storeId: '1' });
  assert.equal(calls[0].q.storeId, '1');
});

test('an unknown action is refused', async () => {
  reset();
  const r = await runCookieCall('get', {}, ctx);
  assert.equal(r.ok, false);
  assert.match(r.error, /Unknown action get; use list, set or delete/);
});
