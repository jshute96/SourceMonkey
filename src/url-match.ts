// URL matching for userscripts.
//
// Implements Tampermonkey-style three flavours of pattern:
//
//   @match    Chrome match-pattern grammar: <scheme>://<host>/<path>
//             - scheme: *, http, https, file, ftp
//             - host:   *, *.domain, exact domain, or empty (for file://)
//             - path:   glob with `*` (matches any chars including `/`)
//             Plus the special literal `<all_urls>` (any http/https/file/ftp URL).
//             Two shapes Chrome's parser refuses are read leniently
//             first — see `canonicalMatchPatterns`.
//
//   @include  Free-form glob over the *whole* URL string. `*` matches any
//             run of characters. If the pattern is wrapped in `/.../` it
//             is treated as a JavaScript regex.
//
//   @exclude  Same syntax as @include. If any @exclude matches, the
//             script does not match — excludes win over both @match and
//             @include.
//
// All three also take Tampermonkey's `.tld` host suffix, meaning "any
// public suffix" — see `.tld` hosts below.
//
// `urlMatchesScript(url, matching)` is the entry point used by the
// background SW; the per-pattern helpers are exported for tests.

import { ICANN_SUFFIX_RULES } from './public-suffixes.js';

export interface UrlMatching {
  matches: string[];
  includes: string[];
  excludes: string[];
}

const HTTP_LIKE_SCHEMES = /^(https?|file|ftp):/i;

// Escape every regex metacharacter except `*`, which we want to keep so
// the caller can substitute it in. Used by both pattern flavours.
function escapeForRegexExceptStar(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

// Convert a `*`-glob (where `*` matches any chars, including `/`) to an
// anchored RegExp.
function globToRegExp(glob: string): RegExp {
  const body = escapeForRegexExceptStar(glob).replace(/\*/g, '.*');
  return new RegExp('^' + body + '$');
}

// ---------- `.tld` hosts ----------
//
// Tampermonkey and Violentmonkey read a host ending in `.tld` as "this
// name under any public suffix": `*://www.google.tld/*` runs on
// www.google.com, www.google.de and www.google.co.uk. They take it in
// `@match`, `@include` and `@exclude` alike.
//
// A public suffix is one under which anyone can register a name. We
// take them from the ICANN section of the Public Suffix List (PSL,
// publicsuffix.org), generated into public-suffixes.ts:
//   - That covers multi-level ones (`co.uk`, `com.au`) where a
//     registry keeps the second level, and not `com.de`, an ordinary
//     name someone owns.
//   - The PSL's private section (`blogspot.com`, `github.io`) is left
//     out: `www.google.blogspot.com` belongs to whoever registered it
//     there, not to Google. (Violentmonkey includes it.)
//   - So are names no registry hands out (`.local`, `.lan`): the PSL's
//     implicit "any unknown label" rule isn't applied.
//
// Matching tries each public suffix the URL's own host ends in, with
// `.tld` replaced by it, as an ordinary pattern (see `tldSuffixesOf`).
//
// The list stays out of the page: the wrapper's in-page matcher reads
// `.tld` loosely, and the service worker's start check (the reply to
// `sm:check-pending`) applies this exact reading. See docs/matching.md.

// PSL rules, parsed on first use: plain suffixes, `*.x` wildcards
// (every label under x is a suffix), and `!y` exceptions to them.
let suffixRules: { plain: Set<string>; wild: Set<string>; except: Set<string> } | null = null;

function rules(): NonNullable<typeof suffixRules> {
  if (suffixRules) return suffixRules;
  const r = { plain: new Set<string>(), wild: new Set<string>(), except: new Set<string>() };
  for (const line of ICANN_SUFFIX_RULES.split('\n')) {
    if (!line) continue;
    if (line.startsWith('!')) r.except.add(line.slice(1));
    else if (line.startsWith('*.')) r.wild.add(line.slice(2));
    else r.plain.add(line);
  }
  suffixRules = r;
  return r;
}

// Is this (lowercase, punycode) name exactly an ICANN public suffix?
export function isPublicSuffix(name: string): boolean {
  const r = rules();
  if (r.except.has(name)) return false;
  if (r.plain.has(name)) return true;
  const dot = name.indexOf('.');
  return dot > 0 && r.wild.has(name.slice(dot + 1));
}

// The public suffixes a URL's host ends in, shortest first: for
// `www.google.co.uk`, `uk` and `co.uk`. Never the whole host, since a
// `.tld` pattern always names something in front of it.
function tldSuffixesOf(url: string): string[] {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return [];
  }
  const labels = hostname.split('.');
  const out: string[] = [];
  for (let k = 1; k < labels.length; k++) {
    const suffix = labels.slice(-k).join('.');
    if (isPublicSuffix(suffix)) out.push(suffix);
  }
  return out;
}

// A `.tld` pattern tested as each of its readings for this URL, with
// `.tld` replaced by one of the host's public suffixes. Null when the
// pattern has no `.tld` host, for the caller to test it as it is.
function testTld(pattern: string, url: string, globStar: boolean, test: (p: string) => boolean): boolean | null {
  const at = tldIndex(pattern, globStar);
  if (at < 0) return null;
  return tldSuffixesOf(url).some((suffix) => test(pattern.slice(0, at) + '.' + suffix + pattern.slice(at + 4)));
}

// Where the `.tld` that ends a pattern's host starts, or -1 when its
// host doesn't end in one. The host is what follows `://` (the start,
// for a pattern naming no scheme) up to the next `/`, less a `:port`.
// Only a host's LAST label counts: `.tld` elsewhere is literal text.
//
// `globStar`: an `@include` glob may run the host straight into a `*`
// with no `/` (`http://www.google.tld*`), as older scripts do. The
// `.tld` still ends the host, and the `*` stays a glob star. Not for a
// `@match`, whose grammar has no `*` after the host.
//
// A `.tld` with no name in front (`*.tld`, a bare `.tld`) stays
// literal: "any host under any TLD" is not what anybody means by it.
function tldIndex(pattern: string, globStar = false): number {
  const sep = pattern.indexOf('://');
  const start = sep < 0 ? 0 : sep + 3;
  const slash = pattern.indexOf('/', start);
  let host = pattern.slice(start, slash < 0 ? pattern.length : slash).replace(/:(\d+|\*)$/, '');
  if (globStar && host.endsWith('*')) host = host.slice(0, -1);
  if (!host.toLowerCase().endsWith('.tld')) return -1;
  const base = host.slice(0, -4);
  if (base === '' || base === '*') return -1;
  return start + host.length - 4;
}

// Does this glob or `@match` pattern have a `.tld` host — one Chrome
// can't match for us? Regex patterns never do: `.tld` in a regex is
// the author's own regex text.
export function hostEndsInTld(pattern: string): boolean {
  if (isRegexPattern(pattern)) return false;
  if (pattern === '<all_urls>') return false;
  return tldIndex(pattern, true) >= 0;
}

// A glob Chrome can register for a `.tld` `@match` or `@include`, as a
// coarse first pass: the `.tld` becomes `.*`, so `*://www.google.tld/*`
// registers as `*://www.google.*/*`. It reaches more than `.tld` means
// (`www.google.evil.com`, and a glob `*` also crosses `/`), so the
// wrapper's in-page matcher, which reads `.tld` exactly, must still
// narrow it. A `@match` host's leading `*.` also covers the bare name
// (`*.imdb.tld` runs on `imdb.com`), which as a glob needs `*imdb.*`.
// Only for patterns where `hostEndsInTld` is true.
export function tldCoarseGlob(pattern: string, isMatch: boolean): string {
  const at = tldIndex(pattern, !isMatch);
  let head = pattern.slice(0, at);
  if (isMatch) {
    const sep = head.indexOf('://');
    if (sep >= 0 && head.startsWith('*.', sep + 3)) head = head.slice(0, sep + 3) + '*' + head.slice(sep + 5);
  }
  return head + '.*' + pattern.slice(at + 4);
}

function isRegexPattern(pattern: string): boolean {
  return pattern.length >= 2 && pattern.startsWith('/') && pattern.endsWith('/');
}

// ---------- lenient readings ----------
//
// The concrete schemes a `@match` may name — `MATCH_SCHEMES` minus the
// `*` that stands for http-or-https. Also what a scheme glob is
// expanded against.
const CONCRETE_SCHEMES = ['http', 'https', 'file', 'ftp'];

// Rewrite the two `@match` shapes Chrome's parser refuses but the other
// managers run, into the patterns Chrome's grammar spells them with.
// Returns one pattern per concrete scheme the original names — usually
// one, and the input verbatim when there is nothing to rewrite.
//
//   *.example.com/*        → *://*.example.com/*   (scheme omitted)
//   //example.com/*        → *://example.com/*     (scheme-relative)
//   ://example.com/*       → *://example.com/*     (empty scheme)
//   *//example.com/*       → *://example.com/*     (`*://` less its colon)
//   http*://example.com/*  → *://example.com/*     (scheme glob)
//   *s://example.com/*     → https://example.com/*
//
// Why: an omitted scheme and `http*` together account for nearly every
// `@match` in the Greasy Fork corpus that Chrome refuses — the rewrite
// turns 877 of those 1,035 patterns into ones it takes, across the
// 1,991 most-installed scripts, which are working scripts under the
// managers their authors use (see docs/matching.md). Both shapes have
// one obvious reading; Chrome's parser is the only thing that can't
// spell it, so we spell it for it.
//
// A scheme glob is ENUMERATED, not approximated: `*` comes back only
// when the glob names exactly the pair `*` stands for, and every other
// expansion comes back as concrete schemes (`*s://` → `https://`). So
// no caller has to re-check the scheme afterwards — a rounded-up `*`
// would have to be filtered somewhere, and Chrome, which does the
// matching, has nowhere to filter before injecting.
//
// A scheme glob matching no supported scheme (`chrome-*://`) is left
// alone, so `matchPatternProblem` still names it as unsupported rather
// than silently widening it.
//
// This runs ahead of BOTH the matcher and the validator, so what we
// register with Chrome and what our own matcher says stay the same
// thing. Keep it in lockstep with the copy in `userscript-prelude.js`.
export function canonicalMatchPatterns(pattern: string): string[] {
  if (pattern === '<all_urls>') return [pattern];

  // Supply the scheme the author left out. `//host/…` is the
  // protocol-relative spelling of the same omission, and `*//host/…` is
  // a `*://host/…` with the colon dropped — read literally that one
  // would be "any host, path beginning `//host/`", which names a
  // different site than the one written.
  let p = pattern;
  if (p.startsWith('*//')) p = '*:' + p.slice(1);
  else if (p.startsWith('//')) p = '*:' + p;
  else if (!p.includes('://')) p = '*://' + p;

  const sep = p.indexOf('://');
  const scheme = p.slice(0, sep).toLowerCase();
  const rest = p.slice(sep); // keeps the `://`
  if (scheme === '*' || scheme === '') return anyScheme(rest);
  if (!scheme.includes('*')) return [p];

  let schemeRx: RegExp;
  try {
    schemeRx = globToRegExp(scheme);
  } catch {
    return [pattern];
  }
  const expanded = CONCRETE_SCHEMES.filter((s) => schemeRx.test(s));
  if (expanded.length === 0) return [pattern];
  // Exactly the pair `*` already means, so say it the way `*` is said.
  if (expanded.join() === 'http,https') return anyScheme(rest);
  return expanded.map((s) => s + rest);
}

// `*://<rest>` — http-or-https — spelled the way Chrome will take it.
//
// Chrome's parser refuses `*` beside a numeric port ("Invalid port"),
// though it takes the same port after a named scheme and takes
// `*://host:*/…` as well. Probed against Chrome 148; the e2e case in
// `tests/e2e/injection.spec.ts` is the standing check.
// Writing the pair out is the only spelling of those patterns Chrome
// will register, and means exactly what `*` does.
function anyScheme(rest: string): string[] {
  const host = rest.slice(3).split('/')[0];
  if (!/:\d+$/.test(host)) return ['*' + rest];
  return ['http' + rest, 'https' + rest];
}

// Test a single Chrome @match pattern against a URL. Returns false for
// any malformed input rather than throwing — callers loop over many
// patterns and a typo in one shouldn't break the others.
export function matchPattern(pattern: string, url: string): boolean {
  if (pattern === '<all_urls>') return HTTP_LIKE_SCHEMES.test(url);
  const tld = testTld(pattern, url, false, (p) => matchPattern(p, url));
  if (tld !== null) return tld;
  return canonicalMatchPatterns(pattern).some((p) => matchCanonical(p, url));
}

// `matchPattern` for a pattern already in Chrome's spelling.
function matchCanonical(pattern: string, url: string): boolean {
  const parts = /^(\*|https?|file|ftp):\/\/([^/]*)(\/.*)$/i.exec(pattern);
  if (!parts) return false;
  const [, scheme, host, path] = parts;

  let parsed: URL;
  try { parsed = new URL(url); } catch { return false; }

  // Scheme: `*` only covers http(s), per Chrome's match-pattern rules.
  if (scheme === '*') {
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  } else if (parsed.protocol !== `${scheme.toLowerCase()}:`) {
    return false;
  }

  // Host. file:// URLs typically have an empty host; we allow `*` to
  // match that too so `file:///*` style patterns work.
  //
  // Chrome's documented match-pattern grammar disallows ports, but
  // Chrome's actual matcher accepts them — `http://host:port/*` will
  // be registered and Chrome will match it against URLs on that port.
  // (Not beside a `*` scheme, which is why `anyScheme` above writes
  // that pair out.)
  // Honoring that here keeps OUR matcher in step with Chrome's, which
  // matters because the badge classification uses our matcher and would
  // otherwise show UNEXPECTED for every wrapper Chrome happily injected.
  // Strategy: split off a trailing `:port` if present and check
  // hostname + port separately. Pattern hosts without a port match any
  // port (the user opted not to constrain it).
  const colon = host.lastIndexOf(':');
  // Must look like host:digits — IPv6 literals are bracketed so a colon
  // outside `[…]` is unambiguous; we don't support bracketed v6 here.
  const hasPort = colon > 0 && /^\d+$/.test(host.slice(colon + 1));
  const patternHost = hasPort ? host.slice(0, colon) : host;
  const patternPort = hasPort ? host.slice(colon + 1) : '';
  if (patternHost === '*') {
    // any host (including empty)
  } else if (patternHost.startsWith('*.')) {
    const suffix = patternHost.slice(2).toLowerCase();
    const h = parsed.hostname.toLowerCase();
    if (h !== suffix && !h.endsWith('.' + suffix)) return false;
  } else if (patternHost === '') {
    if (parsed.hostname !== '') return false;
  } else if (parsed.hostname.toLowerCase() !== patternHost.toLowerCase()) {
    return false;
  }
  // If the pattern pinned a port, the URL must use exactly that port
  // (after URL parsing normalises default ports — http defaults port to
  // '', so a pattern of `http://host:80/*` won't match `http://host/`
  // because parsed.port is ''. That mirrors Chrome's literal compare.)
  if (patternPort !== '' && parsed.port !== patternPort) return false;

  // Path glob runs against pathname + query, so authors can target
  // ?id=... etc. Not the fragment: Chrome's matcher ignores it, so a
  // `#` in the pattern matches nothing and a URL's `#hash` never stops
  // a match.
  const tail = parsed.pathname + parsed.search;
  try {
    return globToRegExp(path).test(tail);
  } catch {
    return false;
  }
}

// ---------- @match validation ----------
//
// Chrome re-parses every `@match` we hand `chrome.userScripts.register`
// with its own match-pattern grammar, and refuses the WHOLE
// registration — every other pattern in it, and the script with them —
// over a single malformed one. Its complaint comes back in Chrome's
// coordinates ("matches[1]: Empty path"), with no way back to the
// header line that caused it.
//
// So we check the same grammar here, at parse time, where the line IS
// still in hand: `script-store.ts` turns a problem into a located
// warning (or into the script's error, when it leaves nothing to match
// on) and `injector.ts` drops the pattern before Chrome sees it.
//
// Deliberately narrower than Chrome's parser. It flags only shapes that
// are certainly wrong, because a false positive would stop a working
// script from running for no reason. Subtler refusals (a malformed
// port, a host Chrome's canonicalizer rejects) still reach Chrome and
// still come back as REJECTED — see docs/diagnostics.md.
//
// The invariant that makes dropping safe: every pattern flagged here is
// one `matchPattern` above can never match, so no page loses a script
// it was getting. `tests/unit/url-match.test.mjs` pins it.

// The schemes a `@match` may name, which is also exactly the set
// `matchPattern` implements. `*` covers http and https only, per
// Chrome's grammar.
export const MATCH_SCHEMES = ['*', 'http', 'https', 'file', 'ftp'];

// Why Chrome would refuse one `@match`, in the pieces a caller needs to
// phrase it for its own surface.
export interface MatchPatternProblem {
  // The offending pattern, verbatim — callers use it to find the header
  // line it was declared on, and name it in the message.
  pattern: string;
  // What is wrong, as a clause completing `@match <pattern> …`.
  what: string;
  // What to do about it. Absent when there is nothing specific to say.
  fix?: string;
}

// The problem with a `@match` pattern, or null when Chrome's grammar
// accepts it — after the lenient rewrites in `canonicalMatchPatterns`,
// which is the same text `buildRegistrationSpec` registers.
//
// The problem names the pattern the author WROTE, not its rewritten
// form: that is the text they have to go and find in the header.
//
// A pattern is a problem only when EVERY canonical form is one. A
// scheme glob can expand into a usable form and an unusable one
// (`f*:///*` → `file:///*`, legal, plus `ftp:///*`, an empty host for a
// scheme that needs one), and `buildRegistrationSpec` registers the
// forms that survive — so reporting on the worst of them would warn
// about a pattern that is running, or store a script INVALID for
// having no usable `@match` while one of its forms was registered.
export function matchPatternProblem(pattern: string): MatchPatternProblem | null {
  if (pattern === '<all_urls>') return null;
  let first: MatchPatternProblem | null = null;
  for (const canonical of canonicalMatchPatterns(pattern)) {
    const problem = canonicalPatternProblem(canonical);
    if (!problem) return null;
    first ??= { ...problem, pattern };
  }
  return first;
}

// The check itself, over a pattern already in Chrome's spelling. Every
// shape that reaches here has a `://` — `canonicalMatchPatterns`
// supplies one when the author didn't.
function canonicalPatternProblem(pattern: string): MatchPatternProblem | null {
  const sep = pattern.indexOf('://');
  const scheme = pattern.slice(0, sep);
  if (!MATCH_SCHEMES.includes(scheme.toLowerCase())) {
    return {
      pattern,
      what: `names the unsupported scheme "${scheme}"`,
      fix: `use one of ${MATCH_SCHEMES.join(', ')} ("*" covers http and https)`,
    };
  }

  const rest = pattern.slice(sep + 3);
  const slash = rest.indexOf('/');
  // The single most common malformed pattern: a bare origin. Chrome
  // calls it "Empty path" and refuses the registration.
  if (slash < 0) {
    return {
      pattern,
      what: 'has no path',
      fix: 'add a trailing "/*" to match all pages on that host',
    };
  }

  const host = rest.slice(0, slash);
  // Chrome takes a `:port` off the host before judging it, so
  // `https://:8080/*` is an empty host rather than a host named
  // ":8080". Strip the same suffix — the port itself is left to Chrome
  // (a malformed one is exactly the kind of subtler refusal this
  // function doesn't try to reproduce).
  const bareHost = host.replace(/:(\d+|\*)$/, '');
  // `file://` URLs have no host, so an empty one is only wrong for the
  // schemes that do.
  if (bareHost === '' && scheme.toLowerCase() !== 'file') {
    return {
      pattern,
      what: 'has no host',
      fix: 'name a host, or "*" for any host',
    };
  }
  // Characters no hostname can hold. Checked because the scheme-less
  // reading supplies a scheme for ANY text: a regex someone pasted into
  // an `@match` (`https?:\/\/weibo.com/p/*`, a real one) reads as a
  // pattern whose host is `https?:\`, which would otherwise pass every
  // check below and be handed to Chrome — and Chrome refusing it takes
  // the whole registration down. A reject-list rather than a list of
  // legal characters, so an internationalized host still passes.
  //
  // No `:` in the list, deliberately. A colon that survived the port
  // strip means a malformed port (`https://host:notaport/*`), and ports
  // are the part of the grammar this function leaves to Chrome — see
  // the narrowness note above, and `tests/e2e/rejected-registration.spec.ts`,
  // which provokes REJECTED with exactly that shape.
  if (/[\s\\?#@%"<>{}|^`]/.test(bareHost)) {
    return {
      pattern,
      what: `names the invalid host "${bareHost}"`,
      fix: 'use a host name like example.com, "*" for any host, '
        + 'or "*.example.com" for a domain and its subdomains',
    };
  }
  // A host wildcard is either the whole host or the leading label —
  // anywhere else Chrome answers "Invalid host wildcard".
  const afterWildcard =
    bareHost === '*' ? '' : bareHost.startsWith('*.') ? bareHost.slice(2) : bareHost;
  if (afterWildcard.includes('*')) {
    return {
      pattern,
      what: 'uses "*" inside its host',
      fix: '"*" has to be the whole host or its first label, as in *.example.com',
    };
  }
  // Chrome takes this one, but matches it against URLs without their
  // fragment, so it can never match. Violentmonkey does match it, so a
  // script written there would otherwise just never run here.
  if (rest.slice(slash).includes('#')) {
    return {
      pattern,
      what: 'names a #hash that @match can\'t see',
      fix: 'use @include to match on the hash',
    };
  }

  return null;
}

// The warning for a pattern we dropped from a script that still has
// others to run on. Parallel to the unknown-`@grant` wording: name what
// is being ignored first, since that is the fact the reader is
// scanning the Log for.
export function ignoredMatchMessage(problem: MatchPatternProblem): string {
  const fix = problem.fix ? `; ${problem.fix}` : '';
  return `Ignoring @match ${problem.pattern}, which ${problem.what}${fix}`;
}

// The pieces `unusableMatchMessage` is built from, kept separate so the
// recognizer below can be derived from the same strings rather than
// from a copy of the wording.
//
// The clause deliberately ends the way `NO_MATCH_OR_INCLUDE`
// (`script-store.ts`) does: the two failures are the same outcome
// reached two ways — no pattern at all, versus none Chrome will take —
// and reading alike is the point.
const MATCH_TAG = '@match ';
const NEVER_RUNS = ', so this script would never run on any page';

// The error for a script whose `@match` patterns are ALL unusable and
// which has no `@include` to fall back on. Same problem, different
// consequence — the script cannot run at all, so this is the row's
// `errorMessage` rather than a warning beside a working script.
//
// Starts with the tag rather than a capitalized word, like the
// `@require` failures do: the tag names what the reader has to go and
// fix, and a `@match` isn't a word we get to recase.
export function unusableMatchMessage(problem: MatchPatternProblem): string {
  const fix = problem.fix ? `; ${problem.fix}` : '';
  return `${MATCH_TAG}${problem.pattern} ${problem.what}${NEVER_RUNS}${fix}`;
}

// One of those messages with the offending pattern elided, or null when
// the message is something else. What a bulk survey groups on — dozens
// of scripts making the same mistake with different URLs are one row,
// not dozens (`tests/greasyfork-examples/validate-corpus.mjs`).
//
// Derived from the constants above rather than matching the wording: a
// recognizer that carries its own copy of the sentence goes stale the
// first time the sentence is reworded, and does it silently. See
// docs/diagnostics.md, "One string, one place".
export function unusableMatchGroupKey(message: string): string | null {
  if (!message.startsWith(MATCH_TAG) || !message.includes(NEVER_RUNS)) return null;
  const afterPattern = message.indexOf(' ', MATCH_TAG.length);
  if (afterPattern < 0) return null;
  return `${MATCH_TAG}… ${message.slice(afterPattern + 1)}`;
}

// Test a single @include / @exclude pattern against a URL. Patterns
// wrapped in `/.../` are regex; everything else is a `*`-glob over the
// whole URL string. A regex ignores case, as Tampermonkey's and
// Violentmonkey's do. A glob doesn't: Chrome evaluates those itself,
// case-sensitively, and this has to agree with it.
export function includePattern(pattern: string, url: string): boolean {
  if (isRegexPattern(pattern)) {
    try {
      return new RegExp(pattern.slice(1, -1), 'i').test(url);
    } catch {
      return false;
    }
  }
  const tld = testTld(pattern, url, true, (p) => includePattern(p, url));
  if (tld !== null) return tld;
  try {
    return globToRegExp(pattern).test(url);
  } catch {
    return false;
  }
}

// Combined script-level test: a script matches a URL iff
//   - no @exclude pattern matches, AND
//   - at least one @match or @include pattern matches.
// A script with zero match/include patterns never matches anything,
// which is intentional — validateHeader already flags those as errors.
//
// Stops at the first rule that settles it: this runs for every script
// on every URL the badge checks. `explainUrlMatch` is the same rule,
// listing every hit instead; `tests/unit/url-match.test.mjs` pins the
// two together.
export function urlMatchesScript(url: string, matching: UrlMatching): boolean {
  if (matching.excludes.some((ex) => includePattern(ex, url))) return false;
  return matching.matches.some((m) => matchPattern(m, url)) || matching.includes.some((inc) => includePattern(inc, url));
}

export interface UrlMatchExplanation {
  matches: boolean;
  /** Which header line decided, e.g. `@exclude *://example.com/admin*`. */
  rule: string | null;
  /** Every `@match` / `@include` line that covers the URL, excluded or not. */
  matchedBy: string[];
  /** Every `@exclude` line that covers it. Any one keeps the script off. */
  excludedBy: string[];
}

// The same test, also naming the rules that answered, for a developer
// asking why a script did or didn't run. Slower than `urlMatchesScript`,
// since it tries every rule to list them all.
export function explainUrlMatch(url: string, matching: UrlMatching): UrlMatchExplanation {
  const excludedBy = matching.excludes.filter((ex) => includePattern(ex, url)).map((ex) => `@exclude ${ex}`);
  const matchedBy = [
    ...matching.matches.filter((m) => matchPattern(m, url)).map((m) => `@match ${m}`),
    ...matching.includes.filter((inc) => includePattern(inc, url)).map((inc) => `@include ${inc}`),
  ];
  const matches = excludedBy.length === 0 && matchedBy.length > 0;
  return { matches, rule: excludedBy[0] ?? matchedBy[0] ?? null, matchedBy, excludedBy };
}
