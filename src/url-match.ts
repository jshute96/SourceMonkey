// URL matching for userscripts.
//
// Implements Tampermonkey-style three flavours of pattern:
//
//   @match    Chrome match-pattern grammar: <scheme>://<host>/<path>
//             - scheme: *, http, https, file, ftp
//             - host:   *, *.domain, exact domain, or empty (for file://)
//             - path:   glob with `*` (matches any chars including `/`)
//             Plus the special literal `<all_urls>` (any http/https/file/ftp URL).
//
//   @include  Free-form glob over the *whole* URL string. `*` matches any
//             run of characters. If the pattern is wrapped in `/.../` it
//             is treated as a JavaScript regex.
//
//   @exclude  Same syntax as @include. If any @exclude matches, the
//             script does not match — excludes win over both @match and
//             @include.
//
// `urlMatchesScript(url, matching)` is the entry point used by the
// background SW; the per-pattern helpers are exported for tests.

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

// Test a single Chrome @match pattern against a URL. Returns false for
// any malformed input rather than throwing — callers loop over many
// patterns and a typo in one shouldn't break the others.
export function matchPattern(pattern: string, url: string): boolean {
  if (pattern === '<all_urls>') return HTTP_LIKE_SCHEMES.test(url);

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

  // Path glob runs against pathname + query + fragment so authors can
  // target ?id=... etc.
  const tail = parsed.pathname + parsed.search + parsed.hash;
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
// accepts it.
export function matchPatternProblem(pattern: string): MatchPatternProblem | null {
  if (pattern === '<all_urls>') return null;

  const sep = pattern.indexOf('://');
  if (sep < 0) {
    return {
      pattern,
      what: 'has no "://" between its scheme and its host',
      // The shape this catches most often in the wild is a bare
      // `*.example.com/*`, so the fix names the scheme to put in front
      // of it rather than restating the grammar.
      fix: 'add a scheme — "*://" covers http and https, as in *://example.com/*',
    };
  }
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
      fix: 'add a trailing "/*" to match every page on that host',
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

  return null;
}

// The warning for a pattern we dropped from a script that still has
// others to run on. Parallel to the unknown-`@grant` wording: name what
// is being ignored first, since that is the fact the reader is
// scanning the Log for.
export function ignoredMatchMessage(problem: MatchPatternProblem): string {
  const fix = problem.fix ? `; ${problem.fix}` : '';
  return `Ignoring @match ${problem.pattern} — it ${problem.what}${fix}`;
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
  const fix = problem.fix ? ` — ${problem.fix}` : '';
  return `${MATCH_TAG}${problem.pattern} ${problem.what}${NEVER_RUNS}${fix}`;
}

// One of those messages with the offending pattern elided, or null when
// the message is something else. What a bulk survey groups on — dozens
// of scripts making the same mistake with different URLs are one row,
// not dozens (`scripts/validate-userscripts.mjs`).
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
// whole URL string.
export function includePattern(pattern: string, url: string): boolean {
  if (pattern.length >= 2 && pattern.startsWith('/') && pattern.endsWith('/')) {
    try {
      return new RegExp(pattern.slice(1, -1)).test(url);
    } catch {
      return false;
    }
  }
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
export function urlMatchesScript(url: string, matching: UrlMatching): boolean {
  for (const ex of matching.excludes) {
    if (includePattern(ex, url)) return false;
  }
  for (const m of matching.matches) {
    if (matchPattern(m, url)) return true;
  }
  for (const inc of matching.includes) {
    if (includePattern(inc, url)) return true;
  }
  return false;
}
