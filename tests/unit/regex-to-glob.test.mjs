// Tests for src/regex-to-glob.ts: the globs a regex `@include` registers
// as, so Chrome skips pages it can't match. The globs must cover every
// URL the regex matches (the wrapper still applies the regex itself).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { regexIncludeGlobs } from '../../dist/regex-to-glob.js';

test('host literals stay, lowercased; path letters become ?', () => {
  assert.deepEqual(regexIncludeGlobs('/^https?:\\/\\/Example\\.COM\\/Path/'), [
    'http*://example.com/????*',
  ]);
});

test('optional and alternative groups expand; anchored alternatives that can\'t start a URL drop', () => {
  // `(?:https?:\/\/)?` without the scheme would have to start the URL
  // with `www.` or `apkadmin`, which no page a script runs on does.
  assert.deepEqual(regexIncludeGlobs('/^(?:https?:\\/\\/)?(?:www\\.)?apkadmin\\.com\\//'), [
    'http*://www.apkadmin.com/*', 'http*://apkadmin.com/*',
  ]);
  assert.deepEqual(regexIncludeGlobs('/^https:\\/\\/[a-z]*\\.(google|youtube)\\.[a-z]*/'), [
    'https://*.google.*', 'https://*@*', 'https://*.youtube.*',
  ]);
});

test('an optional character right before :// is one *, not a copy each', () => {
  for (const scheme of ['https?', 'http(s)?', 'http(|s)']) {
    assert.deepEqual(regexIncludeGlobs(`/^${scheme}:\\/\\/x\\.com\\//`), ['http*://x.com/*'], scheme);
  }
  // Elsewhere, an optional character still expands.
  assert.deepEqual(regexIncludeGlobs('/^https:\\/\\/colou?r\\.com\\//'), [
    'https://colour.com/*', 'https://color.com/*',
  ]);
});

test('single-character pieces are ?, repeats are *, lookarounds vanish', () => {
  assert.deepEqual(regexIncludeGlobs('/^https:\\/\\/(www|beta)\\.waze\\.com\\/(?!user\\/)(.{2,6}\\/)?editor.*$/'), [
    'https://www.waze.com/??*/??????*', 'https://www.waze.com/??????*',
    'https://beta.waze.com/??*/??????*', 'https://beta.waze.com/??????*',
  ]);
});

test('an unanchored regex also gets a glob for a URL embedded after a second ://', () => {
  assert.deepEqual(regexIncludeGlobs('/https:\\/\\/www\\.bilibili\\.com\\/video\\/.*/'), [
    '*https://www.bilibili.com/?????/*', '*://*://???.????????.???/?????/*',
  ]);
});

test('a piece that may match / ends the host, so later letters become ?', () => {
  // `.` can match `/`, so `google` might be in the path.
  assert.deepEqual(regexIncludeGlobs('/^https?:\\/\\/encrypted.google.[^\\/]+/'), [
    'http*://encrypted?????????*', 'http*://*@*',
  ]);
});

test('a file:// regex keeps its glob with no host: the scheme alone leaves out web pages', () => {
  assert.deepEqual(regexIncludeGlobs('/^file:\\/\\/\\/home\\/me\\/.*\\.html$/'), ['file:///????/??/*.????']);
  // An http choice beside it with no host still gives up for the whole regex.
  assert.equal(regexIncludeGlobs('/^(https?|file):\\/\\/[^?#]*\\.png$/'), null);
});

test('no glob when nothing places the host, or none of its letters survive', () => {
  for (const pattern of [
    '/flickr\\.com/', // no scheme
    '/^https?\\:\\/\\/.+/', // nothing after the scheme
    '/^(?!.*jaiminisbox).*\\/read\\/.+/',
    '/[a-zA-z]+://[^\\s]*/',
    '/^https:\\/\\/(?<x>/', // doesn't compile
    'not-a-regex',
  ]) assert.equal(regexIncludeGlobs(pattern), null, pattern);
});

// ---------- Soundness ----------
//
// A rough random sampler of URLs a regex could match, independent of
// regex-to-glob.ts. It doesn't need to be exact: the real regex decides
// which samples count, after Chrome's normalization (new URL), and every
// one must match some glob.
//
// Seeded, so a failure reproduces: the seed is in the failure message,
// and REGEX_GLOB_SEED reruns with it.
const SEED = Number(process.env.REGEX_GLOB_SEED ?? Date.now() % 2 ** 31);
// mulberry32: a tiny seedable random-number generator.
let state = SEED;
function random() {
  state = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(state ^ (state >>> 15), 1 | state);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const POOL = 'abcxyzABCXYZ0129./-_?=&#:%~@+\\';
const rnd = (n) => Math.floor(random() * n);
const pick = (s) => s[rnd(s.length)];

function splitTop(src) {
  const out = []; let depth = 0, from = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') i++;
    else if (c === '[') { i++; if (src[i] === '^') i++; for (; i < src.length && src[i] !== ']'; i++) if (src[i] === '\\') i++; }
    else if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === '|' && depth === 0) { out.push(src.slice(from, i)); from = i + 1; }
  }
  out.push(src.slice(from));
  return out;
}

function matchingChar(classSrc) {
  const re = new RegExp(`^${classSrc}$`, 'i');
  const cands = [...POOL, ...'defghijklmnopqrstuvw345678'].sort(() => random() - 0.5);
  return cands.find((c) => re.test(c)) ?? '';
}

function sample(src) {
  const alts = splitTop(src);
  return seq(alts[rnd(alts.length)]);
}

function seq(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    let gen; const c = src[i];
    if (c === '\\') {
      const n = src[i + 1];
      if ('dwsDWS'.includes(n)) { const cls = `\\${n}`; gen = () => matchingChar(cls); i += 2; }
      else if (/[bB0-9]/.test(n)) { gen = () => ''; i += 2; while (/[0-9]/.test(src[i] ?? '')) i++; }
      else { gen = () => (random() < 0.5 ? n.toUpperCase() : n.toLowerCase()); i += 2; }
    } else if (c === '[') {
      let j = i + 1; if (src[j] === '^') j++;
      for (; j < src.length && src[j] !== ']'; j++) if (src[j] === '\\') j++;
      const cls = src.slice(i, j + 1); gen = () => matchingChar(cls); i = j + 1;
    } else if (c === '(') {
      let depth = 0, j = i;
      for (; j < src.length; j++) {
        if (src[j] === '\\') j++;
        else if (src[j] === '[') { j++; for (; j < src.length && src[j] !== ']'; j++) if (src[j] === '\\') j++; }
        else if (src[j] === '(') depth++;
        else if (src[j] === ')' && --depth === 0) break;
      }
      let inner = src.slice(i + 1, j);
      if (/^\?<?[=!]/.test(inner)) gen = () => '';
      else { inner = inner.replace(/^\?:/, '').replace(/^\?<[^>]*>/, ''); gen = () => sample(inner); }
      i = j + 1;
    } else if (c === '.') { gen = () => pick(POOL); i++; }
    else if (c === '^' || c === '$') { gen = () => ''; i++; }
    else { gen = () => (random() < 0.5 ? c.toUpperCase() : c.toLowerCase()); i++; }
    let min = 1, max = 1;
    const q = src[i];
    if (q === '?') { min = 0; max = 1; i++; }
    else if (q === '*') { min = 0; max = 3; i++; }
    else if (q === '+') { min = 1; max = 3; i++; }
    else if (q === '{') { const m = /^\{(\d+)(,(\d*))?\}/.exec(src.slice(i)); if (m) { min = +m[1]; max = m[2] === undefined ? min : m[3] === '' ? min + 3 : +m[3]; i += m[0].length; } }
    if (src[i] === '?' && q && '?*+}'.includes(src[i - 1])) i++;
    const n = min + rnd(Math.min(max, min + 3) - min + 1);
    for (let k = 0; k < n; k++) out += gen();
  }
  return out;
}

// Chrome's glob: `*` any run, `?` exactly one character, case-sensitive.
function globMatch(glob, url) {
  const re = '^' + [...glob].map((ch) => ch === '*' ? '[\\s\\S]*' : ch === '?' ? '[\\s\\S]' : ch.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&')).join('') + '$';
  return new RegExp(re).test(url);
}

// URLs to try for a regex: samples as a whole URL, after a scheme, and
// embedded in another URL's query, each normalized as Chrome would.
function candidates(src) {
  const out = [];
  for (let k = 0; k < 40; k++) {
    const s = sample(src);
    // Also right after a scheme's `:`, for a regex starting `//host`.
    for (const raw of [s, `https://${s}`, `https:${s}`, `http://Example.COM/a?u=${s}`, `https://x.org/${s}`, `https://x.org/?a=${s}`]) {
      try { out.push(new URL(raw).href); } catch {}
    }
  }
  return out;
}

function checkSound(pattern, globs, tries = 1) {
  const re = new RegExp(pattern.slice(1, -1), 'i');
  const misses = [];
  let positives = 0;
  for (let t = 0; t < tries; t++) {
    for (const url of candidates(pattern.slice(1, -1))) {
      if (!/^(https?|file):/.test(url) || !re.test(url)) continue;
      positives++;
      if (!globs.some((g) => globMatch(g, url))) misses.push(url);
    }
  }
  return { positives, misses };
}


// Regexes from the GreasyFork corpus (tests/greasyfork-examples).
const CORPUS = [
  "/^http:\\/\\/forum\\.worldoftanks\\.(eu|com|ru|asia|kr)\\/index\\.php\\?app=members&module=messaging&section=view&do=showConversation&topicID=\\d+/",
  "/^https:\\/\\/[a-z0-9.]*\\.?ebay(desc)?(\\.[a-z0-9]{2,3})?(\\.[a-z]+)?\\/.*$/",
  "/^https\\:\\/\\/[a-z]*\\.(google|youtube)\\.[a-z]*/",
  "/^https?:\\/\\/gbf-raidfinder\\.aikats\\.us.*$/",
  "/^https://live\\.bilibili\\.com/[0-9]+/",
  "/http(|s)://(|(|w|0|1|2|3|4|5|6|7|8|9)*w(|w|0|1|2|3|4|5|6|7|8|9)*\\.)annuaire-telechargement.(|ws|com|org|net)/.*/",
  "/^https:\\/\\/([\\w-]+\\.)?agoda\\.[\\w.-]+([/?#].*)?$/",
  "/^https:\\/\\/([\\w-]+\\.)?amazon\\.[\\w.-]+([/?#].*)?$/",
  "/^https://[\\w\\d.]*twitter.com/.*$/",
  "/^https:\\/\\/([\\w-]+\\.)?fewo-direkt\\.[\\w.-]+([/?#].*)?$/",
  "/^https:\\/\\/([\\w-]+\\.)?lazada\\.[\\w.-]+([/?#].*)?$/",
  "/^https:\\/\\/([\\w-]+\\.)?nike\\.[\\w.-]+([/?#].*)?$/",
  "/^https:\\/\\/([\\w-]+\\.)?samsung\\.[\\w.-]+([/?#].*)?$/",
  "/^https:\\/\\/([\\w-]+\\.)?suiteness\\.[\\w.-]+([/?#].*)?$/",
  "/^https:\\/\\/([\\w-]+\\.)?trip\\.[\\w.-]+([/?#].*)?$/",
  "/http(|s)://(|(|w|v)*\\.)zone-annuaire.(|ws|com|org|net)/.*/",
  "/^https:\\/\\/([\\w-]+\\.)?wilsonsleather\\.[\\w.-]+([/?#].*)?$/",
  "/^(?:https?:\\/\\/)?(?:www\\.)?apkadmin\\.com\\//",
  "/^https:\\/\\/(www|beta)\\.waze\\.com\\/(?!user\\/)(.{2,6}\\/)?editor.*$/",
  "/^https://www\\.bilibili\\.com/video/[a-zA-Z0-9]+/",
  "/https?:\\/\\/(www\\.)?comick.io\\/.+/",
  "/^(?:https?:\\/\\/)?(?:www\\.)?douploads\\.net\\//",
  "/https?:\\/\\/((www\\.)?|encrypted\\.)google\\.[a-z]{2,3}(\\.[a-z]{2})?\\/(search|webhp|\\?gws_rd|\\?gfe_rd)?.*/",
  "/^https?://www.google.[^\\/]+/",
  "/^(?:https?:\\/\\/)?(?:www\\.)?indi-share\\.(com|net)\\//",
  "/https?:\\/\\/(www\\.)?lhtranslation.net\\/read.+/",
  "/https?:\\/\\/(www\\.)?mangareader.to\\/read\\/.+\\/.+\\/.+/",
  "/^https://(www\\.mturkcontent|s3\\.amazonaws)\\.com/",
  "/^https://(www|preview).wanikani.com/(dashboard)?$/",
  "/^https?:\\/\\/(www\\.)?sketchfab\\.com\\/.*/",
  "/^(?:https?:\\/\\/)?(?:www\\.)?techmyntra\\.(com|net)\\//",
  "/^(?:https?:\\/\\/)?(?:www\\.)?up-load\\.io\\//",
  "/^(https?:\\/\\/(www\\.)?vimeo\\.[a-zA-Z]{2,10}\\/\\d+([\\/?#].*)?)|(https?:\\/\\/player\\.vimeo\\.com\\/video\\/\\d+([\\/?#].*)?)$/",
  "/http(|s)://(|www\\.)zone\\-telechargement1\\.com/.*/",
  "/^(?:^http.://www.nytimes.com/\\d{4}\\/.*)$/"
];

test('every URL a corpus regex matches is covered by its globs', () => {
  let positives = 0;
  for (const pattern of CORPUS) {
    const globs = regexIncludeGlobs(pattern);
    assert.ok(globs, pattern);
    const r = checkSound(pattern, globs, 10);
    positives += r.positives;
    assert.deepEqual(r.misses, [], `${pattern} (seed ${SEED})`);
  }
  // Guard against the sampler silently producing nothing that matches.
  assert.ok(positives > CORPUS.length * 50, `only ${positives} matching samples`);
});

// Parser edge cases, each with a URL it matches that its globs must
// cover (or null: no globs, so `<all_urls>`, is always safe).
const EDGES = [
  // A regex starting at `//`, overlapping the URL's own `://`.
  ['/\\/\\/example\\.com\\/Download\\?url=https:\\/\\/x/', 'https://example.com/Download?url=https://x.org/'],
  ['/\\/\\/(www\\.)?google\\.com\\/url\\?q=https?:\\/\\/x/', 'https://www.google.com/URL?q=https://x'],
  // `\c` not followed by a letter: `\` and `c`.
  ['/^https:\\/\\/foo\\.com\\/.q=\\c1/', 'https://foo.com/?q=\\c1'],
  // A literal `\`, which a glob would read as an escape.
  ['/^https:\\/\\/foo\\.com\\/\\?a=\\\\./', 'https://foo.com/?a=\\x'],
  ['/^https:\\/\\/foo\\.com\\/[]/', null],
  ['/^https:\\/\\/foo\\.com\\/[^]x/', 'https://foo.com/!x'],
  ['/^https:\\/\\/foo\\.com\\/\\u{41}/', 'https://foo.com/uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu'],
  ['/^https:\\/\\/foo\\.com\\/\\p{L}/', 'https://foo.com/p{L}'],
  ['/^https:\\/\\/foo\\.com\\/a{,2}/', 'https://foo.com/a{,2}'],
  ['/^https:\\/\\/foo\\.com\\/(ab){20}/', 'https://foo.com/' + 'ab'.repeat(20)],
  ['/^https:\\/\\/(a|b|c|d|e|f|g|h|i|j|k|l|m|n|o|p|q)\\.foo\\.com/', 'https://q.foo.com/'],
  ['/^https?:\\/\\/(|www\\.)foo\\.com\\//', 'https://foo.com/'],
  ['/^https:\\/\\/foo\\.com\\/x^y/', null],
  ['/^https:\\/\\/foo\\.com\\/#!\\/Bar/', 'https://foo.com/#!/BAR'],
  ['/^HTTPS:\\/\\/FOO\\.com:8080\\/x/', 'https://foo.com:8080/X'],
];

test('parser edge cases stay covered', () => {
  for (const [pattern, url] of EDGES) {
    const globs = regexIncludeGlobs(pattern);
    if (url === null) continue;
    assert.ok(new RegExp(pattern.slice(1, -1), 'i').test(url), `${pattern} should match ${url}`);
    if (globs === null) continue;
    assert.ok(globs.some((g) => globMatch(g, url)), `${pattern}: ${url} not in ${globs.join(' | ')}`);
    assert.deepEqual(checkSound(pattern, globs, 10).misses, [], `${pattern} (seed ${SEED})`);
  }
});
