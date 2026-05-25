import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MATCH_HEADER_TAGS,
  RESOLVABLE_HEADER_TAGS,
  connectLinkUrl,
  isHeaderCloseLine,
  isHeaderOpenLine,
  parseTagLine,
  splitResourceValue,
  splitTextByUrls,
} from '../../dist/script-links.js';

test('splitTextByUrls extracts http(s) URLs from prose', () => {
  const runs = splitTextByUrls('see https://example.com/a for more');
  assert.deepEqual(runs, [
    { kind: 'text', value: 'see ' },
    { kind: 'url', value: 'https://example.com/a' },
    { kind: 'text', value: ' for more' },
  ]);
});

test('splitTextByUrls strips trailing punctuation off URLs', () => {
  const runs = splitTextByUrls('open https://example.com.');
  assert.deepEqual(runs, [
    { kind: 'text', value: 'open ' },
    { kind: 'url', value: 'https://example.com' },
    { kind: 'text', value: '.' },
  ]);
});

test('splitTextByUrls strips trailing closing brackets', () => {
  const runs = splitTextByUrls('docs (https://example.com/x)');
  assert.deepEqual(runs, [
    { kind: 'text', value: 'docs (' },
    { kind: 'url', value: 'https://example.com/x' },
    { kind: 'text', value: ')' },
  ]);
});

test('splitTextByUrls finds multiple URLs in one chunk', () => {
  const runs = splitTextByUrls('a https://a.example b http://b.example c');
  assert.deepEqual(runs, [
    { kind: 'text', value: 'a ' },
    { kind: 'url', value: 'https://a.example' },
    { kind: 'text', value: ' b ' },
    { kind: 'url', value: 'http://b.example' },
    { kind: 'text', value: ' c' },
  ]);
});

test('splitTextByUrls recognises file:// URLs', () => {
  const runs = splitTextByUrls('see file:///etc/hosts');
  assert.deepEqual(runs, [
    { kind: 'text', value: 'see ' },
    { kind: 'url', value: 'file:///etc/hosts' },
  ]);
});

test('splitTextByUrls returns single text run when no URLs', () => {
  const runs = splitTextByUrls('plain text only');
  assert.deepEqual(runs, [{ kind: 'text', value: 'plain text only' }]);
});

test('splitTextByUrls stops URLs at a `*` glob wildcard', () => {
  // The same shape an `@match` / `@exclude` line uses verbatim. The
  // URL portion should be the literal prefix up to the wildcard;
  // the `*` belongs to the surrounding text so it can't end up
  // inside the anchor's href.
  const runs = splitTextByUrls('https://www.nytimes.com/athletic/*');
  assert.deepEqual(runs, [
    { kind: 'url', value: 'https://www.nytimes.com/athletic/' },
    { kind: 'text', value: '*' },
  ]);
});

test('splitTextByUrls stops URLs at quotes inside string literals', () => {
  const runs = splitTextByUrls('"https://example.com/api"');
  assert.deepEqual(runs, [
    { kind: 'text', value: '"' },
    { kind: 'url', value: 'https://example.com/api' },
    { kind: 'text', value: '"' },
  ]);
});

test('splitTextByUrls preserves query-string params in URLs', () => {
  // `?` appears mid-URL (followed by query body) and only peels when
  // it lands at the very end of the run — i.e. sentence punctuation.
  const runs = splitTextByUrls('GET https://example.com/api?id=42&v=1');
  assert.deepEqual(runs, [
    { kind: 'text', value: 'GET ' },
    { kind: 'url', value: 'https://example.com/api?id=42&v=1' },
  ]);
});

test('splitTextByUrls peels a trailing `?` only when at the very end (sentence punctuation)', () => {
  const runs = splitTextByUrls('try https://example.com/search?q=hello?');
  assert.deepEqual(runs, [
    { kind: 'text', value: 'try ' },
    { kind: 'url', value: 'https://example.com/search?q=hello' },
    { kind: 'text', value: '?' },
  ]);
});

test('splitTextByUrls keeps balanced brackets inside URLs', () => {
  // Wikipedia-style URL with literal `(disambig)` in the path: the
  // closing paren is part of the URL, so the link's href must
  // include it.
  const runs = splitTextByUrls('see https://en.wikipedia.org/wiki/Foo_(disambig)');
  assert.deepEqual(runs, [
    { kind: 'text', value: 'see ' },
    { kind: 'url', value: 'https://en.wikipedia.org/wiki/Foo_(disambig)' },
  ]);
});

test('splitTextByUrls peels closing paren when the URL has no opening one', () => {
  // Surrounding prose parens — the close-bracket isn't part of the
  // URL, so peel it back out as text.
  const runs = splitTextByUrls('docs (https://example.com/x)');
  assert.deepEqual(runs, [
    { kind: 'text', value: 'docs (' },
    { kind: 'url', value: 'https://example.com/x' },
    { kind: 'text', value: ')' },
  ]);
});

test('splitTextByUrls peels punctuation after a balanced-paren URL', () => {
  // The closing paren is balanced, so it stays in the URL; the `.`
  // after still peels as ordinary trailing punctuation.
  const runs = splitTextByUrls('see https://en.wikipedia.org/wiki/Foo_(disambig).');
  assert.deepEqual(runs, [
    { kind: 'text', value: 'see ' },
    { kind: 'url', value: 'https://en.wikipedia.org/wiki/Foo_(disambig)' },
    { kind: 'text', value: '.' },
  ]);
});

test('parseTagLine extracts segments of a @match line', () => {
  const got = parseTagLine('// @match     https://example.com/*');
  assert.deepEqual(got, {
    before: '// @match     ',
    tag: 'match',
    value: 'https://example.com/*',
    after: '',
  });
});

test('parseTagLine preserves leading indent', () => {
  const got = parseTagLine('  // @require   ./helpers.js');
  assert.deepEqual(got, {
    before: '  // @require   ',
    tag: 'require',
    value: './helpers.js',
    after: '',
  });
});

test('parseTagLine captures trailing whitespace separately', () => {
  const got = parseTagLine('// @icon foo.png   ');
  assert.deepEqual(got, {
    before: '// @icon ',
    tag: 'icon',
    value: 'foo.png',
    after: '   ',
  });
});

test('parseTagLine handles a localised tag', () => {
  const got = parseTagLine('// @name:de Hallo');
  assert.deepEqual(got, {
    before: '// @name:de ',
    tag: 'name',
    locale: 'de',
    value: 'Hallo',
    after: '',
  });
});

test('parseTagLine rejects non-comment lines', () => {
  assert.equal(parseTagLine('const x = 1;'), null);
});

test('parseTagLine rejects bare flag tags with no value', () => {
  assert.equal(parseTagLine('// @noframes'), null);
});

test('parseTagLine rejects the metadata-block markers', () => {
  assert.equal(parseTagLine('// ==UserScript=='), null);
  assert.equal(parseTagLine('// ==/UserScript=='), null);
});

test('isHeaderOpenLine / isHeaderCloseLine accept whitespace variants', () => {
  assert.equal(isHeaderOpenLine('// ==UserScript=='), true);
  assert.equal(isHeaderOpenLine('  //  ==UserScript==  '), true);
  assert.equal(isHeaderCloseLine('// ==/UserScript=='), true);
  assert.equal(isHeaderCloseLine('  //  ==/UserScript== '), true);
});

test('isHeaderOpenLine rejects lookalike strings inside code', () => {
  assert.equal(isHeaderOpenLine('foo == "UserScript"'), false);
  assert.equal(isHeaderOpenLine('// before ==UserScript==='), false);
});

test('header-tag classifier sets cover the documented tags', () => {
  // `@match` plus `@exclude` / `@include` (which formally use a
  // different grammar but in practice are written as match patterns).
  for (const t of ['match', 'exclude', 'include']) {
    assert.equal(MATCH_HEADER_TAGS.has(t), true, t);
  }
  for (const t of ['icon', 'require', 'updateurl', 'downloadurl', 'homepage', 'homepageurl', 'website', 'source', 'supporturl']) {
    assert.equal(RESOLVABLE_HEADER_TAGS.has(t), true, t);
  }
  // `@resource` is intentionally excluded from the single-value
  // resolver — its two-arg grammar (`name url`) is handled by a
  // separate carve-out in linkForHeaderTag that linkifies only the
  // URL portion.
  assert.equal(RESOLVABLE_HEADER_TAGS.has('resource'), false);
});

test('splitResourceValue: single-space `name url` shape', () => {
  const parts = splitResourceValue('myCSS https://example.com/x.css');
  assert.deepEqual(parts, {
    prefix: 'myCSS ',
    url: 'https://example.com/x.css',
    suffix: '',
  });
  // Round-trip is exact.
  assert.equal(parts.prefix + parts.url + parts.suffix, 'myCSS https://example.com/x.css');
});

test('splitResourceValue: multi-space gap is preserved in the prefix', () => {
  const parts = splitResourceValue('myCSS    https://example.com/x.css');
  assert.deepEqual(parts, {
    prefix: 'myCSS    ',
    url: 'https://example.com/x.css',
    suffix: '',
  });
  assert.equal(parts.prefix + parts.url + parts.suffix, 'myCSS    https://example.com/x.css');
});

test('splitResourceValue: trailing junk past the URL stays as suffix', () => {
  // TM doesn't document trailing args, but the round-trip should not
  // lose them — they end up as plain-text suffix outside the anchor.
  const parts = splitResourceValue('myCSS https://example.com/x.css  extra');
  assert.deepEqual(parts, {
    prefix: 'myCSS ',
    url: 'https://example.com/x.css',
    suffix: '  extra',
  });
  assert.equal(parts.prefix + parts.url + parts.suffix, 'myCSS https://example.com/x.css  extra');
});

test('splitResourceValue: rejects values without a whitespace gap', () => {
  // Single token — can't split into name + url.
  assert.equal(splitResourceValue('justOneToken'), null);
});

test('splitResourceValue: rejects values where the URL portion is empty', () => {
  // A name followed by only trailing whitespace — no URL. parseTagLine
  // would already strip the trailing whitespace into `after`, so this
  // mostly guards against future regressions.
  assert.equal(splitResourceValue('name'), null);
});

test('connectLinkUrl: bare host gets an https:// scheme', () => {
  // Matches the exact value the example script uses.
  assert.equal(
    connectLinkUrl('api.dictionaryapi.dev'),
    'https://api.dictionaryapi.dev/',
  );
  assert.equal(connectLinkUrl('example.com'), 'https://example.com/');
  assert.equal(connectLinkUrl('localhost'), 'https://localhost/');
});

test('connectLinkUrl: subdomain wildcard collapses to apex', () => {
  assert.equal(
    connectLinkUrl('*.example.com'),
    'https://example.com/',
  );
});

test('connectLinkUrl: full URL preserved verbatim', () => {
  assert.equal(
    connectLinkUrl('https://example.com/api'),
    'https://example.com/api',
  );
  assert.equal(
    connectLinkUrl('http://localhost:8080/api'),
    'http://localhost:8080/api',
  );
});

test('connectLinkUrl: rejects values that name no single site', () => {
  assert.equal(connectLinkUrl('*'), null);
  assert.equal(connectLinkUrl('self'), null);
  assert.equal(connectLinkUrl('SELF'), null);
  assert.equal(connectLinkUrl(''), null);
  assert.equal(connectLinkUrl('   '), null);
});

test('connectLinkUrl: rejects non-http(s) schemes and values the URL parser throws on', () => {
  assert.equal(connectLinkUrl('ftp://example.com'), null);
  assert.equal(connectLinkUrl('file:///etc/hosts'), null);
  // Literal space inside a host makes `new URL` throw. The URL
  // parser is otherwise permissive (`example..com`, `$$$`, tabs all
  // pass), so this isn't a thorough "malformed host" guard — we
  // accept whatever the URL parser does, and the click-through
  // surfaces any garbage as the browser's error page.
  assert.equal(connectLinkUrl('exa mple.com'), null);
});

test('parseTagLine tolerates a stray CRLF `\\r` at end of line', () => {
  const got = parseTagLine('// @match https://example.com/*\r');
  assert.deepEqual(got, {
    before: '// @match ',
    tag: 'match',
    value: 'https://example.com/*',
    after: '\r',
  });
});
