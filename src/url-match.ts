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
  if (host === '*') {
    // any host (including empty)
  } else if (host.startsWith('*.')) {
    const suffix = host.slice(2).toLowerCase();
    const h = parsed.hostname.toLowerCase();
    if (h !== suffix && !h.endsWith('.' + suffix)) return false;
  } else if (host === '') {
    if (parsed.hostname !== '') return false;
  } else if (parsed.hostname.toLowerCase() !== host.toLowerCase()) {
    return false;
  }

  // Path glob runs against pathname + query + fragment so authors can
  // target ?id=... etc.
  const tail = parsed.pathname + parsed.search + parsed.hash;
  try {
    return globToRegExp(path).test(tail);
  } catch {
    return false;
  }
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
