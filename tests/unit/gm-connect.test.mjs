// Unit tests for the `@connect` URL gating module.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  parseConnectEntry,
  parseConnectRules,
  hostMatchesRule,
  extractSelfHosts,
  decideConnect,
  connectBlockedMessage,
  connectDenialClause,
  policyFailureVerdict,
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

// --- decideConnect: rule matching ---

const noSelf = { rules: [], selfHosts: new Set() };

test('decideConnect: wildcard allows everything', () => {
  const r = decideConnect('https://anything.com/x', { ...noSelf, rules: [{ kind: 'wildcard' }] });
  assert.equal(r.allowed, true);
  assert.equal(r.via, 'rule');
});

test('decideConnect: exact host matches, others rejected', () => {
  const rules = [{ kind: 'exact', host: 'example.com' }];
  assert.equal(decideConnect('https://example.com/x', { ...noSelf, rules }).allowed, true);
  const r = decideConnect('https://other.com/x', { ...noSelf, rules });
  assert.equal(r.allowed, false);
  assert.equal(r.undeclared, false);
  assert.match(r.reason, /not in @connect/);
});

test('decideConnect: invalid URL → block with reason', () => {
  const r = decideConnect('not-a-url', { ...noSelf, rules: [{ kind: 'wildcard' }] });
  assert.equal(r.allowed, false);
  assert.equal(r.denied, false);
  assert.equal(r.undeclared, false);
  assert.match(r.reason, /not a valid URL/);
});

test('decideConnect: self resolves against the script\'s @match hosts', () => {
  const ctx = { rules: [{ kind: 'self' }], selfHosts: new Set(['example.com']) };
  assert.equal(decideConnect('https://example.com/x', ctx).allowed, true);
  assert.equal(decideConnect('https://other.com/x', ctx).allowed, false);
});

test('decideConnect: self also covers the requesting page\'s host', () => {
  // TM's `self` is "the domain of the page the script runs on". A
  // script @match-ed at <all_urls> contributes no self hosts, so
  // without the page host the token would match nothing.
  const ctx = { rules: [{ kind: 'self' }], selfHosts: new Set(), pageOrigin: 'https://page.example' };
  // Different port than the page → not same-origin, but still the
  // same host, which is what `self` is about.
  assert.equal(decideConnect('https://page.example:8443/x', ctx).allowed, true);
  assert.equal(decideConnect('https://other.example/x', ctx).allowed, false);
});

// --- decideConnect: the same-origin allowance ---

test('decideConnect: same-origin is allowed with no @connect at all', () => {
  const r = decideConnect('https://page.example/api', { ...noSelf, pageOrigin: 'https://page.example' });
  assert.equal(r.allowed, true);
  assert.equal(r.via, 'same-origin');
});

test('decideConnect: same-origin is allowed even when @connect names other hosts', () => {
  // TM 4 made `self` implicit (Tampermonkey/tampermonkey#283); a
  // declared @connect must not cost a script the origin it runs on.
  const r = decideConnect('https://page.example/api', {
    rules: [{ kind: 'exact', host: 'api.other.example' }],
    selfHosts: new Set(),
    pageOrigin: 'https://page.example',
  });
  assert.equal(r.allowed, true);
  assert.equal(r.via, 'same-origin');
});

test('decideConnect: same-origin means the whole origin, not just the host', () => {
  // A different port or scheme IS cross-origin to the page — the page
  // itself couldn't fetch it without CORS — so it needs a rule.
  const ctx = { ...noSelf, pageOrigin: 'https://page.example' };
  assert.equal(decideConnect('https://page.example:8443/x', ctx).allowed, false);
  assert.equal(decideConnect('http://page.example/x', ctx).allowed, false);
});

test('decideConnect: the same-origin allowance is http(s) only', () => {
  // Chrome serializes a local page's origin as a bare `file://`,
  // shared by every file on disk — so origin equality there would
  // hand one no-@connect script the whole filesystem.
  const r = decideConnect('file:///etc/passwd', { ...noSelf, pageOrigin: 'file://' });
  assert.equal(r.allowed, false);
  assert.equal(r.undeclared, true);
  // And the advice has to stay fillable: there's no host to name, so
  // don't tell the author to add `// @connect ` with nothing after it.
  assert.doesNotMatch(r.reason, /@connect "?\s*$/);
  assert.match(r.reason, /file URL has no host/);
});

test('decideConnect: a host-less URL that misses declared rules says so', () => {
  const r = decideConnect('data:text/plain,hi', {
    rules: [{ kind: 'exact', host: 'api.example' }],
    selfHosts: new Set(),
  });
  assert.equal(r.allowed, false);
  assert.match(r.reason, /data URL has no host/);
});

test('decideConnect: @connect * covers a host-less URL', () => {
  // The wildcard is the only rule that can, which is what the
  // host-less reasons point at.
  const r = decideConnect('file:///tmp/x', { rules: [{ kind: 'wildcard' }], selfHosts: new Set() });
  assert.equal(r.allowed, true);
});

test('decideConnect: an opaque or unknown page origin gets no allowance', () => {
  // file:// pages and sandboxed frames report the origin as 'null'.
  assert.equal(decideConnect('https://a.example/x', { ...noSelf, pageOrigin: 'null' }).allowed, false);
  assert.equal(decideConnect('https://a.example/x', { ...noSelf, pageOrigin: '' }).allowed, false);
  assert.equal(decideConnect('https://a.example/x', noSelf).allowed, false);
});

// --- decideConnect: the no-@connect default ---

test('decideConnect: no @connect → cross-origin blocked, reason names the fix', () => {
  const r = decideConnect('https://api.example/x', { ...noSelf, pageOrigin: 'https://page.example' });
  assert.equal(r.allowed, false);
  assert.equal(r.undeclared, true);
  assert.match(r.reason, /@connect api\.example/);
});

test('connectBlockedMessage: one shape for every denied hop', () => {
  assert.equal(
    connectBlockedMessage('host evil.example not in @connect allowlist'),
    "[SourceMonkey] GM_xmlhttpRequest: blocked by this script's @connect rules: "
      + 'host evil.example not in @connect allowlist',
  );
});

// A script that wrote no @connect lines has no rules to be blocked
// by, so the message must not name any — see docs/diagnostics.md
// "Blame the right thing".
test('connectBlockedMessage: an undeclared script is not told its rules refused', () => {
  assert.equal(
    connectBlockedMessage('add "// @connect api.example" to the script header', true),
    '[SourceMonkey] GM_xmlhttpRequest: blocked because this script declares no @connect: '
      + 'add "// @connect api.example" to the script header',
  );
});

test('connectDenialClause: the two halves of the blame split', () => {
  assert.match(connectDenialClause('why', false), /^blocked by this script's @connect rules: /);
  assert.match(connectDenialClause('why', true), /^blocked because this script declares no @connect: /);
});

test('policyFailureVerdict: a failure to read the rules never blames them', () => {
  const v = policyFailureVerdict('could not read the header');
  assert.equal(v.allowed, false);
  assert.equal(v.denied, false);
  assert.equal(v.undeclared, false);
  assert.equal(v.reason, 'could not read the header');
});
