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

test('parseConnectEntry: exact host', () => {
  assert.deepEqual(parseConnectEntry('Example.COM'), { kind: 'exact', host: 'example.com' });
});

test('parseConnectEntry: *.domain subdomain', () => {
  assert.deepEqual(parseConnectEntry('*.example.com'), { kind: 'subdomain', host: 'example.com' });
});

test('parseConnectEntry: scheme-prefixed URL normalizes to host', () => {
  // TM accepts `https://example.com` in @connect; we strip to host.
  assert.deepEqual(parseConnectEntry('https://example.com'), { kind: 'exact', host: 'example.com' });
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
  assert.equal(rules[0].kind, 'exact');
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

test('hostMatchesRule: exact only matches the named host', () => {
  const rule = { kind: 'exact', host: 'example.com' };
  assert.equal(hostMatchesRule('example.com', rule, new Set()), true);
  assert.equal(hostMatchesRule('api.example.com', rule, new Set()), false);
  assert.equal(hostMatchesRule('other.com', rule, new Set()), false);
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

test('isUrlConnectAllowed: exact host matches, others rejected', () => {
  const rules = [{ kind: 'exact', host: 'example.com' }];
  assert.equal(isUrlConnectAllowed('https://example.com/x', rules, new Set()).allowed, true);
  const r = isUrlConnectAllowed('https://other.com/x', rules, new Set());
  assert.equal(r.allowed, false);
  assert.match(r.reason, /not in @connect/);
});

test('isUrlConnectAllowed: invalid URL → block with reason', () => {
  const r = isUrlConnectAllowed('not-a-url', [{ kind: 'wildcard' }], new Set());
  assert.equal(r.allowed, false);
  assert.match(r.reason, /invalid URL/);
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
