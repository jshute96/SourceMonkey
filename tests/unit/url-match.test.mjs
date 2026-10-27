// Tests for src/url-match.ts (compiled to dist/url-match.js).
//
// Covers @match (Chrome match-pattern grammar), @include / @exclude
// (glob + /regex/ form), the combined urlMatchesScript() entry point
// including the "excludes win" rule, and the parse-time @match
// validation that keeps Chrome from refusing a whole registration.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  canonicalMatchPatterns,
  matchPattern,
  matchPatternProblem,
  ignoredMatchMessage,
  unusableMatchMessage,
  unusableMatchGroupKey,
  includePattern,
  urlMatchesScript,
  explainUrlMatch,
  hostEndsInTld,
  tldCoarseGlob,
  isPublicSuffix,
  pageMatcher,
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

test('matchPattern: the URL fragment is ignored, as Chrome ignores it', () => {
  assert.equal(matchPattern('https://example.com/foo', 'https://example.com/foo#part'), true);
  assert.equal(matchPattern('https://example.com/foo?q=1', 'https://example.com/foo?q=1#part'), true);
  // A `#` in the pattern names a fragment the URL is never matched on.
  assert.equal(matchPattern('https://example.com/foo#part', 'https://example.com/foo#part'), false);
});

test('matchPattern: path glob can target the query', () => {
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
});

test('matchPattern: no path reads as the root page', () => {
  assert.deepEqual(canonicalMatchPatterns('https://example.com'), ['https://example.com/']);
  assert.deepEqual(canonicalMatchPatterns('example.com'), ['*://example.com/']);
  assert.equal(matchPattern('https://example.com', 'https://example.com/'), true);
  assert.equal(matchPattern('https://example.com', 'https://example.com'), true);
  assert.equal(matchPattern('https://example.com', 'https://example.com/page'), false);
  assert.equal(matchPattern('https://example.com', 'https://example.com/?q=1'), false);
  assert.equal(matchPatternProblem('https://example.com'), null);
});

test('matchPattern: a `*` stuck to the front of a host reads as `*.`', () => {
  assert.deepEqual(canonicalMatchPatterns('*://*example.com/*'), ['*://*.example.com/*']);
  assert.deepEqual(canonicalMatchPatterns('*example.com/*'), ['*://*.example.com/*']);
  assert.equal(matchPattern('*://*example.com/*', 'https://example.com/'), true);
  assert.equal(matchPattern('*://*example.com/*', 'https://www.example.com/x'), true);
  assert.equal(matchPattern('*://*example.com/*', 'https://fooexample.com/'), false);
  assert.equal(matchPatternProblem('https://*example.com/*'), null);
  // A `:*` port's own `*` isn't a second one in the host.
  assert.deepEqual(canonicalMatchPatterns('https://*example.com:*/*'), ['https://*.example.com:*/*']);
  // Only a lone leading `*`: one elsewhere in the host is still flagged.
  assert.match(matchPatternProblem('https://*exam*.com/*')?.what ?? '', /"\*" inside its host/);
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

test('includePattern: a regex and a glob both ignore case', () => {
  // As Tampermonkey and Violentmonkey read them.
  assert.equal(includePattern('/EXAMPLE\\.com\\/Page/', 'https://example.com/page'), true);
  assert.equal(includePattern('*EXAMPLE.com/Page*', 'https://example.com/page'), true);
  assert.equal(includePattern('https://*.google.tld/Maps*', 'https://www.google.de/maps'), true);
  // A flag after the closing slash isn't one: the pattern is a glob,
  // and matches nothing, as in the other managers.
  assert.equal(includePattern('/example\\.com/i', 'https://example.com/'), false);
});

test('includePattern: invalid regex returns false without throwing', () => {
  assert.equal(includePattern('/[unclosed/', 'https://example.com/'), false);
});

// ---------- urlMatchesScript ----------

test('urlMatchesScript and explainUrlMatch give the same verdict', () => {
  // Two implementations of one rule: the fast one stops early, the
  // other lists every hit. Every mix of rule kinds, over URLs that hit
  // each, none, and several.
  const matchings = [
    { matches: ['https://a.test/*'], includes: [], excludes: [] },
    { matches: [], includes: ['*b.test*'], excludes: [] },
    { matches: ['https://a.test/*'], includes: ['/c\\.test/'], excludes: ['*/private/*'] },
    { matches: ['https://a.test/x#y'], includes: [], excludes: ['*#skip'] },
    { matches: [], includes: [], excludes: [] },
  ];
  const urls = ['https://a.test/', 'https://a.test/private/1', 'https://b.test/', 'https://c.test/private/', 'https://a.test/x#skip', 'https://d.test/'];
  for (const m of matchings) {
    for (const url of urls) {
      assert.equal(urlMatchesScript(url, m), explainUrlMatch(url, m).matches, `${JSON.stringify(m)} on ${url}`);
    }
  }
});

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

test('matchPattern: a `:*` port matches any port, as in Chrome', () => {
  assert.equal(matchPattern('*://localhost:*/*', 'http://localhost:3000/x'), true);
  assert.equal(matchPattern('http://localhost:*/*', 'http://localhost/x'), true);
  assert.equal(matchPattern('https://example.com:*/*', 'https://example.com:8443/'), true);
  assert.equal(matchPattern('*://localhost:*/*', 'http://otherhost:3000/x'), false);
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

// ---------- canonicalMatchPatterns ----------
//
// The lenient reading of the shapes Chrome's parser refuses. What it
// returns is what gets registered, so these are also the strings a
// registration is built from.

test('canonicalMatchPatterns: supplies an omitted scheme', () => {
  assert.deepEqual(canonicalMatchPatterns('*.example.com/*'), ['*://*.example.com/*']);
  assert.deepEqual(canonicalMatchPatterns('example.com/path/*'), ['*://example.com/path/*']);
});

test('canonicalMatchPatterns: leaves a broken scheme for the check to flag', () => {
  // `*//` would otherwise read as "any host, path beginning `//host/`".
  for (const p of ['//example.com/*', '://example.com/*', '*//example.com/*']) {
    assert.deepEqual(canonicalMatchPatterns(p), [p]);
    assert.match(matchPatternProblem(p)?.what ?? '', /doesn't start with a scheme and "\:\/\/"/);
    assert.equal(matchPattern(p, 'https://example.com/'), false);
    assert.equal(matchPattern(p, 'https://other.example//example.com/x'), false);
  }
});

test('canonicalMatchPatterns: expands a scheme glob over the supported schemes', () => {
  // `http*` names http and https — exactly what `*` already means, so
  // it comes back as `*` rather than as two patterns.
  assert.deepEqual(canonicalMatchPatterns('http*://example.com/*'), ['*://example.com/*']);
  assert.deepEqual(canonicalMatchPatterns('*s://example.com/*'), ['https://example.com/*']);
  assert.deepEqual(canonicalMatchPatterns('f*://example.com/*'), [
    'file://example.com/*',
    'ftp://example.com/*',
  ]);
  assert.deepEqual(canonicalMatchPatterns('HTTP*://example.com/*'), ['*://example.com/*']);
  // A glob naming three of them stays concrete rather than rounding up
  // to `*` — `*` would mean http + https, which is a different set.
  assert.deepEqual(canonicalMatchPatterns('*t*://example.com/*'), [
    'http://example.com/*',
    'https://example.com/*',
    'ftp://example.com/*',
  ]);
});

test('matchPattern: a scheme glob matches its own schemes and no others', () => {
  // The enumeration is exact, so nothing re-checks the scheme after the
  // rewrite. These pin that there is nothing left to re-check.
  assert.equal(matchPattern('http*://example.com/*', 'ftp://example.com/'), false);
  assert.equal(matchPattern('http*://example.com/*', 'file://example.com/'), false);
  assert.equal(matchPattern('*s://example.com/*', 'http://example.com/'), false);
  assert.equal(matchPattern('*t*://example.com/*', 'ftp://example.com/'), true);
  assert.equal(matchPattern('*t*://example.com/*', 'file://example.com/'), false);
});

test('canonicalMatchPatterns: spells `*` out beside a numeric port', () => {
  // Chrome's parser answers "Invalid port" to `*` next to a numeric
  // port, but takes the same port after a named scheme — so a
  // port-pinned pattern has to be written as the pair it means, or the
  // registration it lands in is refused whole.
  assert.deepEqual(canonicalMatchPatterns('*://localhost:3000/*'), [
    'http://localhost:3000/*',
    'https://localhost:3000/*',
  ]);
  assert.deepEqual(canonicalMatchPatterns('localhost:3000/*'), [
    'http://localhost:3000/*',
    'https://localhost:3000/*',
  ]);
  assert.deepEqual(canonicalMatchPatterns('http*://localhost:3000/*'), [
    'http://localhost:3000/*',
    'https://localhost:3000/*',
  ]);
  // A wildcard port is fine beside `*` — Chrome takes that one.
  assert.deepEqual(canonicalMatchPatterns('*://localhost:*/*'), ['*://localhost:*/*']);
  // A named scheme is left alone, port or no port.
  assert.deepEqual(canonicalMatchPatterns('http://localhost:3000/*'), ['http://localhost:3000/*']);
});

test('canonicalMatchPatterns: `*/path` is a host wildcard and a path', () => {
  assert.deepEqual(canonicalMatchPatterns('*/foo/*'), ['*://*/foo/*']);
});

test('matchPatternProblem: a scheme glob is a problem only when every form is', () => {
  // `f*` names file and ftp; an empty host is legal for file and not
  // for ftp. buildRegistrationSpec registers the file form, so warning
  // about the ftp one would describe a pattern that is running — and
  // would store a script INVALID for having no usable @match while one
  // of its forms was registered.
  assert.deepEqual(canonicalMatchPatterns('f*:///*'), ['file:///*', 'ftp:///*']);
  assert.equal(matchPatternProblem('f*:///*'), null);
  assert.equal(matchPattern('f*:///*', 'file:///home/me/notes.txt'), true);
  // Both forms bad — still reported, with the first form's reason.
  assert.match(matchPatternProblem('f*://www.*.com/*')?.what ?? '', /"\*" inside its host/);
});

test('canonicalMatchPatterns: leaves everything else verbatim', () => {
  for (const p of ['<all_urls>', 'https://example.com/*', '*://*/*', 'file:///*']) {
    assert.deepEqual(canonicalMatchPatterns(p), [p]);
  }
  // A glob naming no supported scheme is not widened — it stays wrong,
  // so matchPatternProblem can say which scheme it named.
  assert.deepEqual(canonicalMatchPatterns('chrome-*://x/*'), ['chrome-*://x/*']);
});

test('matchPattern: honors the lenient shapes', () => {
  // Scheme omitted: both http and https, base domain and subdomains.
  assert.equal(matchPattern('*.example.com/*', 'https://www.example.com/x'), true);
  assert.equal(matchPattern('*.example.com/*', 'http://example.com/'), true);
  assert.equal(matchPattern('*.example.com/*', 'https://example.org/'), false);
  assert.equal(matchPattern('example.com/p/*', 'http://example.com/p/1'), true);
  assert.equal(matchPattern('example.com/p/*', 'http://example.com/q'), false);
  // Scheme glob: the same set `*` covers, and nothing outside it.
  assert.equal(matchPattern('http*://example.com/*', 'http://example.com/'), true);
  assert.equal(matchPattern('http*://example.com/*', 'https://example.com/'), true);
  assert.equal(matchPattern('http*://example.com/*', 'ftp://example.com/'), false);
  assert.equal(matchPattern('*s://example.com/*', 'http://example.com/'), false);
  assert.equal(matchPattern('*s://example.com/*', 'https://example.com/'), true);
});

// ---------- matchPatternProblem ----------
//
// The parse-time stand-in for Chrome's match-pattern parser. Two things
// have to hold: it accepts everything a real script legitimately writes
// (a false positive would drop a pattern that works), and everything it
// rejects is something `matchPattern` could never have matched anyway
// (which is what makes dropping the pattern free).

const VALID_PATTERNS = [
  '<all_urls>',
  '*://*/*',
  'https://example.com/*',
  'http://example.com/path/*?q=1',
  'https://*.example.com/*',
  'https://*/*',
  'file:///*',
  'file://*/*',
  'ftp://example.com/*',
  'HTTPS://Example.COM/*',
  // Ports: Chrome's docs disallow them and its matcher accepts them, so
  // we must not flag them. A malformed one is left to Chrome — see the
  // narrower-than-Chrome note in url-match.ts.
  'http://127.0.0.1:8080/*',
  'https://*.example.com:8443/*',
  'https://example.com:*/*',
  // Shapes Chrome's parser refuses and canonicalMatchPatterns reads
  // leniently, so nothing downstream should flag them either.
  '*.example.com/*',
  'http*://example.com/*',
  '*s://example.com/*',
  // The host check is a reject-list of characters no hostname holds,
  // so a host Chrome canonicalizes rather than refuses still passes.
  'https://例え.jp/*',
  'https://foo_bar.example/*',
  'http://[::1]:8080/*',
];

test('matchPatternProblem: accepts every well-formed pattern', () => {
  for (const p of VALID_PATTERNS) {
    assert.equal(matchPatternProblem(p), null, `should accept ${p}`);
  }
});

test('matchPatternProblem: names the other malformed shapes', () => {
  assert.match(matchPatternProblem('httpx://example.com/*')?.what ?? '', /unsupported scheme "httpx"/);
  assert.match(matchPatternProblem('https:///*')?.what ?? '', /no host/);
  // Chrome takes the port off before judging the host, so this one is
  // "Host can not be empty" to it too — not a host named ":8080".
  assert.match(matchPatternProblem('https://:8080/*')?.what ?? '', /no host/);
  // A scheme glob that names no supported scheme stays unsupported —
  // the leniency in canonicalMatchPatterns only covers globs that do.
  assert.match(matchPatternProblem('chrome-*://example.com/*')?.what ?? '', /unsupported scheme "chrome-\*"/);
  // Judged after the lenient rewrite, so the problem is what is left
  // once the missing scheme is supplied — not the missing scheme.
  assert.match(matchPatternProblem('www.*.com/*')?.what ?? '', /"\*" inside its host/);
  // A regex pasted into an `@match` reads as a scheme-less pattern
  // whose "host" is regex syntax. It has to stay flagged: Chrome
  // refuses it, and a refusal takes the whole registration down, where
  // a flagged pattern is just dropped.
  const pastedRegex = matchPatternProblem('https?:\\/\\/weibo.com/p/*');
  assert.match(pastedRegex?.what ?? '', /invalid host "https\?:\\"/);
  assert.equal(pastedRegex?.pattern, 'https?:\\/\\/weibo.com/p/*');
  assert.match(matchPatternProblem('a%zz.example/*')?.what ?? '', /invalid host/);
  // A colon isn't on the list: it means a malformed port, which is the
  // part of the grammar left to Chrome (and which
  // tests/e2e/rejected-registration.spec.ts provokes REJECTED with).
  assert.equal(matchPatternProblem('https://host:notaport/*'), null);
  // Nor is it a problem in a bracketed IPv6 literal, which is all colons.
  assert.equal(matchPatternProblem('*://[::1]:3000/*'), null);
  assert.match(matchPatternProblem('https://www.*.com/*')?.what ?? '', /"\*" inside its host/);
  assert.match(matchPatternProblem('https://*.example.*/*')?.what ?? '', /"\*" inside its host/);
  // `file://` is the one scheme whose URLs have no host, so an empty
  // one there is correct rather than a problem.
  assert.equal(matchPatternProblem('file:///home/me/*'), null);
});

test('matchPatternProblem: everything it flags is unmatchable anyway', () => {
  // The invariant that lets buildRegistrationSpec drop these patterns
  // without changing which pages a script runs on.
  const flagged = [
    'www.*.com/*',
    '//example.com/*',
    '*//example.com/*',
    '://example.com/*',
    'httpx://example.com/*',
    'https:///*',
    'https://www.*.com/*',
    'https://*.example.*/*',
    'https://:8080/*',
    'https?:\\/\\/weibo.com/p/*',
    // A hash, which @match never sees, even the URL's own.
    'https://a.b.example.com/x#y',
    'https://example.com/#/settings*',
  ];
  const urls = [
    'https://example.com/',
    'http://www.example.com/page?q=1',
    'https://a.b.example.com/x#y',
    'file:///home/me/notes.txt',
    'ftp://example.com/pub/',
  ];
  for (const p of flagged) {
    assert.notEqual(matchPatternProblem(p), null, `should flag ${p}`);
    for (const url of urls) {
      assert.equal(matchPattern(p, url), false, `${p} must not match ${url}`);
    }
  }
});

test('matchPatternProblem: the two messages carry the pattern and the fix', () => {
  const problem = matchPatternProblem('https://www.*.com/*');
  const ignored = ignoredMatchMessage(problem);
  const unusable = unusableMatchMessage(problem);
  // No trailing period, subject included — these strings land in the Log
  // and in the message bar (docs/diagnostics.md, "Wording").
  for (const message of [ignored, unusable]) {
    assert.match(message, /@match https:\/\/www\.\*\.com\/\*/);
    assert.match(message, /first label, as in \*\.example\.com/);
    assert.equal(message, message.replace(/\.$/, ''));
  }
  // Capitalized, per the same rules — except where the message opens on
  // a tag name, which is not a word we get to recase.
  assert.match(ignored, /^Ignoring @match /);
  assert.match(unusable, /^@match /);
  assert.match(unusable, /never run on any page/);
});

test('matchPatternProblem: a "#" in the path is flagged, with @include as the fix', () => {
  const problem = matchPatternProblem('https://example.com/page#part');
  assert.equal(ignoredMatchMessage(problem),
    'Ignoring @match https://example.com/page#part, which names a #hash that @match can\'t see; use @include to match on the hash');
  // Only in the path; a query that merely looks like one is fine.
  assert.equal(matchPatternProblem('https://example.com/page?x=1*'), null);
});

test('unusableMatchGroupKey: elides the pattern, and declines anything else', () => {
  // What the corpus validator groups a survey by. Two scripts with
  // different bad patterns and the same mistake must key alike.
  const a = unusableMatchMessage(matchPatternProblem('https://www.*.com/*'));
  const b = unusableMatchMessage(matchPatternProblem('https://other.*.example/*'));
  assert.equal(unusableMatchGroupKey(a), unusableMatchGroupKey(b));
  assert.match(unusableMatchGroupKey(a), /^@match … uses "\*" inside its host, so this script would never run/);
  // Different mistakes stay apart.
  assert.notEqual(
    unusableMatchGroupKey(a),
    unusableMatchGroupKey(unusableMatchMessage(matchPatternProblem('httpx://example.com/*'))),
  );
  // Not one of ours: the warning form, and the message for a script that
  // declared no pattern at all (which ends with the same clause).
  assert.equal(unusableMatchGroupKey(ignoredMatchMessage(matchPatternProblem('https://www.*.com/*'))), null);
  assert.equal(
    unusableMatchGroupKey('No @match or @include in the metadata block, so this script would never run on any page'),
    null,
  );
  assert.equal(unusableMatchGroupKey('Syntax error: Unexpected token'), null);
});

// ---------- `.tld` hosts ----------

test('.tld: @include matches the name under any one-label TLD', () => {
  for (const url of [
    'https://www.google.com/search?q=1',
    'https://www.google.de/',
    'http://www.google.xn--p1ai/',
  ]) {
    assert.equal(includePattern('*://www.google.tld/*', url), true, url);
  }
});

test('.tld: @include takes common country second-level suffixes', () => {
  for (const url of ['https://www.google.co.uk/', 'https://www.google.com.au/', 'https://www.google.co.jp/x']) {
    assert.equal(includePattern('*://www.google.tld/*', url), true, url);
  }
});

test('.tld: never reaches a host someone else could register', () => {
  for (const url of [
    'https://www.google.evil.com/', // two arbitrary labels
    'https://www.google.com.evil.io/',
    'https://www.google.com.de/', // com.de is a name someone owns
    'https://www.google.co.de/', // nor is co.de a registry's
    'https://www.google.local/', // a LAN name, not a registry's
    'https://www.google.lan/',
    'https://www.google.internal/',
    'https://www.google/', // no TLD at all
    'https://www.googlex.com/',
    'https://xwww.google.com/',
  ]) {
    assert.equal(includePattern('*://www.google.tld/*', url), false, url);
    assert.equal(matchPattern('*://www.google.tld/*', url), false, url);
  }
});

test('.tld: a `*.` host covers the base domain and subdomains, in @match and @include', () => {
  for (const url of ['https://www.imdb.com/title/tt1/', 'https://m.imdb.de/title/tt1/', 'https://www.imdb.co.uk/title/tt1/']) {
    assert.equal(includePattern('https://*.imdb.tld/title/tt*', url), true, url);
    assert.equal(matchPattern('https://*.imdb.tld/title/tt*', url), true, url);
  }
  // The bare domain: a `@match` `*.` covers it, an `@include` glob's
  // `*` still needs the dot after it, as for any other glob.
  assert.equal(matchPattern('https://*.imdb.tld/*', 'https://imdb.co.uk/'), true);
  assert.equal(includePattern('https://*.imdb.tld/*', 'https://imdb.co.uk/'), false);
  assert.equal(matchPattern('https://*.imdb.tld/*', 'https://notimdb.com/'), false);
  assert.equal(matchPattern('https://*.imdb.tld/*', 'https://imdb.com.evil.io/'), false);
});

test('.tld: @match reads it after the lenient rewrites, and with a port', () => {
  assert.equal(matchPattern('*.google.tld/*', 'https://www.google.fr/'), true);
  assert.equal(matchPattern('http*://www.google.tld/*', 'http://www.google.fr/'), true);
  assert.equal(matchPattern('www.google.tld/*', 'https://www.google.fr/'), true);
  assert.equal(matchPattern('www.google.tld/*', 'https://www.google.evil.com/'), false);
  assert.equal(matchPattern('https://www.google.tld:8443/*', 'https://www.google.fr:8443/'), true);
  assert.equal(matchPattern('https://www.google.tld:8443/*', 'https://www.google.fr/'), false);
  assert.equal(matchPatternProblem('*://www.google.tld/*'), null);
});

test('.tld: only a host\'s last label is special', () => {
  // Literal elsewhere: in a path, or a label in the middle of a host.
  assert.equal(includePattern('https://example.com/a.tld/*', 'https://example.com/a.com/x'), false);
  assert.equal(includePattern('https://example.com/a.tld/*', 'https://example.com/a.tld/x'), true);
  assert.equal(includePattern('https://www.tld.example.com/*', 'https://www.com.example.com/'), false);
  // A regex is the author's own regex.
  assert.equal(includePattern('/www\\.google\\.tld/', 'https://www.google.com/'), false);
  // A single-label name that merely starts like a LAN one is fine.
  assert.equal(includePattern('*://www.google.tld/*', 'https://www.google.homes/'), true);
});

test('.tld: `*.tld` with no name in front stays literal, in @match and @include alike', () => {
  for (const url of ['https://example.com/', 'https://foo.tld/']) {
    assert.equal(matchPattern('*://*.tld/*', url), url === 'https://foo.tld/', url);
    assert.equal(includePattern('*://*.tld/*', url), url === 'https://foo.tld/', url);
  }
  assert.equal(hostEndsInTld('*://*.tld/*'), false);
});

test('.tld: an @include glob may run the host straight into a `*`', () => {
  assert.equal(includePattern('http://www.google.tld*', 'http://www.google.de/search?q=1'), true);
  assert.equal(includePattern('*://*.google.tld*', 'https://news.google.co.uk/'), true);
  assert.equal(includePattern('http://www.google.tld*', 'http://www.googlex.de/'), false);
  assert.equal(hostEndsInTld('http://www.google.tld*'), true);
});

test('.tld: @exclude reads it too, and still wins', () => {
  const matching = {
    matches: ['*://*/*'],
    includes: [],
    excludes: ['https://www.google.tld/search*'],
  };
  assert.equal(urlMatchesScript('https://www.google.co.uk/search?q=x', matching), false);
  assert.equal(urlMatchesScript('https://www.google.co.uk/maps', matching), true);
});

test('hostEndsInTld: which patterns Chrome cannot match for us', () => {
  assert.equal(hostEndsInTld('*://www.google.tld/*'), true);
  assert.equal(hostEndsInTld('https://*.imdb.tld:8080/x'), true);
  assert.equal(hostEndsInTld('*.google.tld/*'), true);
  assert.equal(hostEndsInTld('https://example.com/a.tld'), false);
  assert.equal(hostEndsInTld('/google\\.tld/'), false);
  assert.equal(hostEndsInTld('<all_urls>'), false);
});

test('tldCoarseGlob: the glob Chrome registers for a .tld rule', () => {
  assert.equal(tldCoarseGlob('*://www.google.tld/*', true), '*://www.google.*/*');
  assert.equal(tldCoarseGlob('*://*.imdb.tld/*', true), '*://*imdb.*/*');
  assert.equal(tldCoarseGlob('https://*.imdb.tld:8080/x', true), 'https://*imdb.*:8080/x');
  assert.equal(tldCoarseGlob('*://*.imdb.tld/*', false), '*://*.imdb.*/*');
  assert.equal(tldCoarseGlob('http://www.google.tld*', false), 'http://www.google.**');
  assert.equal(tldCoarseGlob('*.google.tld/*', false), '*.google.*/*');
});

test('tldCoarseGlob: covers every URL the exact rule matches', () => {
  // Chrome injects only where the coarse glob reaches, so it must never
  // miss a page the `.tld` rule itself matches.
  const urls = [
    'https://www.google.com/', 'https://www.google.co.uk/search?q=1', 'http://www.google.de:8080/x',
    'https://imdb.com/title/1', 'https://www.imdb.de/', 'https://m.imdb.com.au/',
  ];
  for (const rule of ['*://www.google.tld/*', '*://*.imdb.tld/*', 'http://www.google.tld/*']) {
    const coarse = tldCoarseGlob(rule, true);
    for (const url of urls) {
      if (matchPattern(rule, url)) assert.equal(includePattern(coarse, url), true, `${rule} ${url}`);
    }
  }
  for (const rule of ['*://www.google.tld/*', '*://*.imdb.tld/*', 'http://www.google.tld*']) {
    const coarse = tldCoarseGlob(rule, false);
    for (const url of urls) {
      if (includePattern(rule, url)) assert.equal(includePattern(coarse, url), true, `${rule} ${url}`);
    }
  }
});

test('isPublicSuffix: the ICANN section of the Public Suffix List', () => {
  for (const name of ['com', 'de', 'co.uk', 'com.au', 'co.io', 'xn--p1ai']) assert.equal(isPublicSuffix(name), true, name);
  // Private-section suffixes, and names nobody's registry hands out.
  for (const name of ['blogspot.com', 'github.io', 'com.de', 'local', 'lan', 'evil.com']) {
    assert.equal(isPublicSuffix(name), false, name);
  }
  // A wildcard rule (`*.ck`) and its exception (`!www.ck`).
  assert.equal(isPublicSuffix('anything.ck'), true);
  assert.equal(isPublicSuffix('www.ck'), false);
  assert.equal(isPublicSuffix('ck'), false);
});

test('.tld: any ICANN public suffix, multi-level ones included, never a private one', () => {
  for (const url of ['https://www.google.co.uk/', 'https://www.google.com.au/', 'https://www.google.xn--p1ai/']) {
    assert.equal(includePattern('*://www.google.tld/*', url), true, url);
    assert.equal(matchPattern('*://www.google.tld/*', url), true, url);
  }
  for (const url of ['https://www.google.blogspot.com/', 'https://www.google.github.io/']) {
    assert.equal(includePattern('*://www.google.tld/*', url), false, url);
    assert.equal(matchPattern('*://www.google.tld/*', url), false, url);
  }
  // Under a wildcard rule, the name sits one label further out.
  assert.equal(includePattern('*://shop.tld/*', 'https://shop.anything.ck/'), true);
  assert.equal(includePattern('*://shop.tld/*', 'https://shop.www.ck/'), false);
});

// The wrapper's matcher (`pageMatcher`'s regexes, as the prelude tests
// them) answers as `urlMatchesScript` does, except that a `.tld` rule
// reads loosely there, so the page may only say yes where the exact
// answer is no.
function pageMatches(m, url) {
  const test = ([source, flags]) => new RegExp(source, flags).test(url);
  if (m.exclude.some(test)) return false;
  return m.include.some(test);
}

const PAGE_URLS = [
  'https://example.com/',
  'https://example.com/path/page?q=1#frag',
  'http://example.com:8080/x',
  'https://EXAMPLE.com/Path',
  'https://www.example.com/a',
  'https://sub.deep.example.com/a',
  'https://notexample.com/a',
  'https://user:pw@example.com/secret',
  'file:///home/me/page.html',
  'ftp://example.com/file',
  'https://www.google.com/search?q=x',
  'https://www.google.co.uk/maps',
  'https://www.google.evil.com/',
  'http://[::1]:3000/app',
  'https://example.com/a#/route/b',
  'https://example.com/a?',
  'https://example.com/a?#x',
// As `location.href` gives them: scheme and host lowercase.
].map((u) => new URL(u).href);

const PAGE_RULES = [
  { matches: ['*://*/*'], includes: [], excludes: [] },
  { matches: ['https://example.com/*'], includes: [], excludes: [] },
  { matches: ['https://example.com/path/*'], includes: [], excludes: [] },
  { matches: ['https://example.com/Path'], includes: [], excludes: [] },
  { matches: ['*://*.example.com/*'], includes: [], excludes: [] },
  { matches: ['http://example.com:8080/*'], includes: [], excludes: [] },
  { matches: ['http://example.com:*/*'], includes: [], excludes: [] },
  { matches: ['https://example.com/*?q=*'], includes: [], excludes: [] },
  { matches: ['https://example.com/a#*'], includes: [], excludes: [] },
  { matches: ['https://example.com/a'], includes: [], excludes: [] },
  { matches: ['https://example.com/a?*'], includes: [], excludes: [] },
  { matches: ['https://user@example.com/*'], includes: [], excludes: [] },
  { matches: ['file:///*'], includes: [], excludes: [] },
  { matches: ['<all_urls>'], includes: [], excludes: [] },
  { matches: ['example.com'], includes: [], excludes: [] },
  { matches: ['*example.com/*'], includes: [], excludes: [] },
  { matches: ['ht*://example.com/*'], includes: [], excludes: [] },
  { matches: ['*://localhost:3000/*', 'http://*/app'], includes: [], excludes: [] },
  { matches: ['not a pattern'], includes: [], excludes: [] },
  { matches: [], includes: ['*example.com*'], excludes: [] },
  { matches: [], includes: ['https://example.com/path*'], excludes: [] },
  { matches: [], includes: ['/^https://(www\\.)?example\\.com\\//'], excludes: [] },
  { matches: [], includes: ['/(unclosed/'], excludes: [] },
  { matches: ['*://*/*'], includes: [], excludes: ['*secret*'] },
  { matches: ['*://*/*'], includes: [], excludes: ['/google/'] },
  { matches: ['https://example.com/*'], includes: ['*google*'], excludes: ['*maps*'] },
];

const TLD_RULES = [
  { matches: ['*://www.google.tld/*'], includes: [], excludes: [] },
  { matches: ['*://*.google.tld/*'], includes: [], excludes: [] },
  { matches: [], includes: ['http*://www.google.tld*'], excludes: [] },
  { matches: ['*://*/*'], includes: [], excludes: ['*://www.google.tld/*'] },
];

test('pageMatcher: the regexes answer as urlMatchesScript does', () => {
  for (const rules of PAGE_RULES) {
    const m = pageMatcher(rules);
    assert.equal(m.tld, undefined, JSON.stringify(rules));
    for (const url of PAGE_URLS) {
      assert.equal(pageMatches(m, url), urlMatchesScript(url, rules), `${JSON.stringify(rules)} on ${url}`);
    }
  }
});

test('pageMatcher: a .tld rule reads loosely, and says to wait for the exact answer', () => {
  for (const rules of TLD_RULES) {
    const m = pageMatcher(rules);
    assert.equal(m.tld, true, JSON.stringify(rules));
    for (const url of PAGE_URLS) {
      if (urlMatchesScript(url, rules)) assert.ok(pageMatches(m, url), `${JSON.stringify(rules)} on ${url}`);
    }
  }
  const loose = pageMatcher(TLD_RULES[0]);
  assert.ok(pageMatches(loose, 'https://www.google.evil.com/'));
  assert.ok(!pageMatches(loose, 'https://www.googlex.com/'));
});
