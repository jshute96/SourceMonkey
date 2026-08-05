// Tests for src/url-match.ts (compiled to dist/url-match.js).
//
// Covers @match (Chrome match-pattern grammar), @include / @exclude
// (glob + /regex/ form), the combined urlMatchesScript() entry point
// including the "excludes win" rule, and the parse-time @match
// validation that keeps Chrome from refusing a whole registration.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  matchPattern,
  matchPatternProblem,
  ignoredMatchMessage,
  unusableMatchMessage,
  unusableMatchGroupKey,
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
];

test('matchPatternProblem: accepts every well-formed pattern', () => {
  for (const p of VALID_PATTERNS) {
    assert.equal(matchPatternProblem(p), null, `should accept ${p}`);
  }
});

test('matchPatternProblem: a bare origin has no path', () => {
  // The case Chrome answers "Empty path" to, and by far the most common.
  const problem = matchPatternProblem('https://example.com');
  assert.equal(problem?.pattern, 'https://example.com');
  assert.match(problem.what, /no path/);
  assert.match(problem.fix ?? '', /"\/\*"/);
});

test('matchPatternProblem: names the other malformed shapes', () => {
  assert.match(matchPatternProblem('example.com/*')?.what ?? '', /no ":\/\/"/);
  assert.match(matchPatternProblem('httpx://example.com/*')?.what ?? '', /unsupported scheme "httpx"/);
  assert.match(matchPatternProblem('https:///*')?.what ?? '', /no host/);
  // Chrome takes the port off before judging the host, so this one is
  // "Host can not be empty" to it too — not a host named ":8080".
  assert.match(matchPatternProblem('https://:8080/*')?.what ?? '', /no host/);
  assert.match(matchPatternProblem('http*://example.com/*')?.what ?? '', /unsupported scheme "http\*"/);
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
    'https://example.com',
    'example.com/*',
    'httpx://example.com/*',
    'https:///*',
    'https://www.*.com/*',
    'https://*.example.*/*',
    'https://:8080/*',
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
  const problem = matchPatternProblem('https://example.com');
  const ignored = ignoredMatchMessage(problem);
  const unusable = unusableMatchMessage(problem);
  // No trailing period, subject included — these strings land in the Log
  // and in the message bar (docs/diagnostics.md, "Wording").
  for (const message of [ignored, unusable]) {
    assert.match(message, /@match https:\/\/example\.com/);
    assert.match(message, /add a trailing "\/\*"/);
    assert.equal(message, message.replace(/\.$/, ''));
  }
  // Capitalized, per the same rules — except where the message opens on
  // a tag name, which is not a word we get to recase.
  assert.match(ignored, /^Ignoring @match /);
  assert.match(unusable, /^@match /);
  assert.match(unusable, /never run on any page/);
});

test('unusableMatchGroupKey: elides the pattern, and declines anything else', () => {
  // What the offline validator groups a survey by. Two scripts with
  // different bad patterns and the same mistake must key alike.
  const a = unusableMatchMessage(matchPatternProblem('https://example.com'));
  const b = unusableMatchMessage(matchPatternProblem('https://other.example'));
  assert.equal(unusableMatchGroupKey(a), unusableMatchGroupKey(b));
  assert.match(unusableMatchGroupKey(a), /^@match … has no path, so this script would never run/);
  // Different mistakes stay apart.
  assert.notEqual(
    unusableMatchGroupKey(a),
    unusableMatchGroupKey(unusableMatchMessage(matchPatternProblem('nonsense'))),
  );
  // Not one of ours: the warning form, and the message for a script that
  // declared no pattern at all (which ends with the same clause).
  assert.equal(unusableMatchGroupKey(ignoredMatchMessage(matchPatternProblem('https://example.com'))), null);
  assert.equal(
    unusableMatchGroupKey('No @match or @include in the metadata block, so this script would never run on any page'),
    null,
  );
  assert.equal(unusableMatchGroupKey('Syntax error: Unexpected token'), null);
});
