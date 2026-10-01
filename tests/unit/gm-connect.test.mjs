// Unit tests for the `@connect` URL gating module.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  parseConnectEntry,
  parseConnectRules,
  hostMatchesRule,
  extractSelfHosts,
  isUrlConnectAllowed,
} from '../../dist/gm-connect.js';

test('parseConnectEntry: lowercases + classifies wildcards / self', () => {
  assert.deepEqual(parseConnectEntry('*'), { kind: 'wildcard' });
  assert.deepEqual(parseConnectEntry('SELF'), { kind: 'self' });
  assert.deepEqual(parseConnectEntry('  *  '), { kind: 'wildcard' });
});

test('parseConnectEntry: bare host', () => {
  assert.deepEqual(parseConnectEntry('Example.COM'), { kind: 'host', host: 'example.com' });
});

test('parseConnectEntry: *.domain subdomain', () => {
  assert.deepEqual(parseConnectEntry('*.example.com'), { kind: 'subdomain', host: 'example.com' });
});

test('parseConnectEntry: scheme-prefixed URL normalizes to host', () => {
  // TM accepts `https://example.com` in @connect; we strip to host.
  assert.deepEqual(parseConnectEntry('https://example.com'), { kind: 'host', host: 'example.com' });
});

test('parseConnectEntry: empty / malformed → null', () => {
  assert.equal(parseConnectEntry(''), null);
  assert.equal(parseConnectEntry('  '), null);
  assert.equal(parseConnectEntry('*.'), null); // empty subdomain
});

test('parseConnectRules: parses every @connect from header, drops empties', () => {
  const header = {
    tags: [
      { tag: 'connect', value: 'example.com' },
      { tag: 'connect', value: '*' },
      { tag: 'connect', value: '' },
      { tag: 'connect', value: '*.api.example.com' },
      { tag: 'match', value: 'https://x/*' },  // not a @connect — skipped
    ],
  };
  const rules = parseConnectRules(header);
  assert.equal(rules.length, 3);
  assert.equal(rules[0].kind, 'host');
  assert.equal(rules[1].kind, 'wildcard');
  assert.equal(rules[2].kind, 'subdomain');
});

test('hostMatchesRule: wildcard matches anything', () => {
  assert.equal(hostMatchesRule('foo.com', { kind: 'wildcard' }, new Set()), true);
});

test('hostMatchesRule: self matches the script\'s own hosts only', () => {
  const selfHosts = new Set(['example.com']);
  assert.equal(hostMatchesRule('example.com', { kind: 'self' }, selfHosts), true);
  assert.equal(hostMatchesRule('other.com', { kind: 'self' }, selfHosts), false);
});

test('hostMatchesRule: a bare host matches the host AND its subdomains', () => {
  // Tampermonkey documents `@connect example.com` as covering
  // subdomains too.
  const rule = { kind: 'host', host: 'example.com' };
  assert.equal(hostMatchesRule('example.com', rule, new Set()), true);
  assert.equal(hostMatchesRule('api.example.com', rule, new Set()), true);
  assert.equal(hostMatchesRule('a.b.example.com', rule, new Set()), true);
  assert.equal(hostMatchesRule('API.Example.com', rule, new Set()), true);
  assert.equal(hostMatchesRule('other.com', rule, new Set()), false);
  // Whole labels only.
  assert.equal(hostMatchesRule('evilexample.com', rule, new Set()), false);
  assert.equal(hostMatchesRule('example.com.evil.net', rule, new Set()), false);
  // A subdomain rule doesn't cover its parent.
  const sub = { kind: 'host', host: 'api.example.com' };
  assert.equal(hostMatchesRule('example.com', sub, new Set()), false);
  assert.equal(hostMatchesRule('v2.api.example.com', sub, new Set()), true);
});

test('hostMatchesRule: a bare IP or single-label host matches only exactly', () => {
  const none = new Set();
  const ip = { kind: 'host', host: '127.0.0.1' };
  assert.equal(hostMatchesRule('127.0.0.1', ip, none), true);
  assert.equal(hostMatchesRule('1.127.0.0.1', ip, none), false);
  // A partial IP isn't a range.
  assert.equal(hostMatchesRule('127.0.0.1', { kind: 'host', host: '0.0.1' }, none), false);
  assert.equal(hostMatchesRule('[::1]', { kind: 'host', host: '[::1]' }, none), true);
  const local = { kind: 'host', host: 'localhost' };
  assert.equal(hostMatchesRule('localhost', local, none), true);
  assert.equal(hostMatchesRule('a.localhost', local, none), false);
  // A bare TLD isn't a wildcard.
  assert.equal(hostMatchesRule('example.com', { kind: 'host', host: 'com' }, none), false);
});

test('hostMatchesRule: subdomain matches the host AND any subdomain', () => {
  const rule = { kind: 'subdomain', host: 'example.com' };
  assert.equal(hostMatchesRule('example.com', rule, new Set()), true);
  assert.equal(hostMatchesRule('api.example.com', rule, new Set()), true);
  assert.equal(hostMatchesRule('foo.bar.example.com', rule, new Set()), true);
  // The host BEFORE the dot must actually be a subdomain — `notexample.com`
  // shouldn't match `*.example.com`.
  assert.equal(hostMatchesRule('notexample.com', rule, new Set()), false);
});

test('extractSelfHosts: pulls hostnames from @match and @include globs', () => {
  const header = {
    tags: [
      { tag: 'match', value: 'https://example.com/*' },
      { tag: 'match', value: 'https://*.foo.com/*' },
      { tag: 'include', value: '*://bar.com/path/*' },
      { tag: 'match', value: '<all_urls>' },  // skipped
      { tag: 'include', value: '/regex/' },   // skipped (regex literal)
    ],
  };
  const hosts = extractSelfHosts(header);
  // `*.foo.com` contributes `foo.com` as the self-host.
  assert.deepEqual([...hosts].sort(), ['bar.com', 'example.com', 'foo.com']);
});

test('isUrlConnectAllowed: no @connect → block', () => {
  const r = isUrlConnectAllowed('https://example.com/x', [], new Set());
  assert.equal(r.allowed, false);
  assert.match(r.reason, /@connect not declared/);
});

test('isUrlConnectAllowed: wildcard allows everything', () => {
  const r = isUrlConnectAllowed('https://anything.com/x', [{ kind: 'wildcard' }], new Set());
  assert.equal(r.allowed, true);
});

test('isUrlConnectAllowed: bare host matches it and its subdomains, others rejected', () => {
  const rules = [{ kind: 'host', host: 'example.com' }];
  assert.equal(isUrlConnectAllowed('https://example.com/x', rules, new Set()).allowed, true);
  assert.equal(isUrlConnectAllowed('https://api.example.com/x', rules, new Set()).allowed, true);
  assert.equal(isUrlConnectAllowed('https://evilexample.com/x', rules, new Set()).allowed, false);
  const r = isUrlConnectAllowed('https://other.com/x', rules, new Set());
  assert.equal(r.allowed, false);
  assert.match(r.reason, /not in @connect/);
});

test('isUrlConnectAllowed: invalid URL → block with reason', () => {
  const r = isUrlConnectAllowed('not-a-url', [{ kind: 'wildcard' }], new Set());
  assert.equal(r.allowed, false);
  assert.match(r.reason, /not a valid URL/);
});

test('isUrlConnectAllowed: self resolves against the script\'s self hosts', () => {
  const selfHosts = new Set(['example.com']);
  assert.equal(
    isUrlConnectAllowed('https://example.com/x', [{ kind: 'self' }], selfHosts).allowed,
    true,
  );
  assert.equal(
    isUrlConnectAllowed('https://other.com/x', [{ kind: 'self' }], selfHosts).allowed,
    false,
  );
});
