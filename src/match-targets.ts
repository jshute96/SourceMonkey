// Pure helpers for converting a Chrome `@match` pattern into a
// "target" the rest of the app can act on: the pattern's representative
// origin and a click-through / page URL (the same URL serves both
// purposes — favicon HTML discovery and open-in-new-tab click).
//
// Used by:
//   - site-icon.ts — picks `representativeMatch(matching)` to drive
//     favicon discovery (origin caching, page URL for HTML probe,
//     click target).
//   - userscript.ts — calls `matchTargetInfo(pattern)` per-pattern
//     when linkifying `@match`/`@exclude`/`@include` values.
//
// No fetching, no DOM, no chrome.storage — that all lives in the
// modules that consume these primitives.

export interface MatchTarget {
  // `scheme://host[:port]` — no path. Cache key for the origin-scoped
  // favicon store; also "is this a usable site?" gate for both
  // consumers.
  origin: string;
  // A representative URL for the pattern: where to navigate on
  // click, and the page to probe for icon discovery. Built by
  // `linkPathFromMatchPath` — see its header for the wildcard-trim
  // rules.
  linkUrl: string;
}

// Parsed shape of a Chrome `@match` pattern that survived our
// origin-extraction filter. `path` keeps the original wildcards so
// `linkPathFromMatchPath` can trim them by its own rules.
interface ParsedMatch {
  scheme: 'http' | 'https';
  host: string;
  path: string;
}

// Pull a Chrome match pattern apart and dewildcard its host. Returns
// null when the pattern can't identify a single site (`<all_urls>`,
// host of `*`, non-http(s) schemes, embedded `*` after dewildcard,
// or syntactically invalid).
//
// Port handling: an explicit `:port` in the pattern is preserved
// verbatim. The favicon almost certainly is served from the same
// port the page is on (`localhost:3000`, a dev server, etc.), and
// the cache key needs to include the port to avoid collisions
// between two different servers sharing a hostname on different
// ports. Patterns without a port stay portless — the icon resolver
// will hit the default port, which is the right behavior for the
// common case.
function parseMatchPattern(pattern: string): ParsedMatch | null {
  if (pattern === '<all_urls>') return null;
  const parts = /^(\*|https?|file|ftp):\/\/([^/]*)(\/.*)?$/i.exec(pattern);
  if (!parts) return null;
  const [, rawScheme, rawHost] = parts;
  const scheme = rawScheme === '*' ? 'https' : rawScheme.toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') return null;

  // Split host:port so the host-wildcard rules apply only to the
  // host portion. The port (digits only) is preserved verbatim.
  const colon = rawHost.lastIndexOf(':');
  const hasPort = colon > 0 && /^\d+$/.test(rawHost.slice(colon + 1));
  const port = hasPort ? rawHost.slice(colon) : '';
  let host = (hasPort ? rawHost.slice(0, colon) : rawHost).toLowerCase();
  if (host === '*' || host === '') return null;
  if (host.startsWith('*.')) host = host.slice(2);
  if (!host || host.includes('*')) return null;

  return { scheme, host: host + port, path: parts[3] ?? '/' };
}

export function originFromMatchPattern(pattern: string): string | null {
  const p = parseMatchPattern(pattern);
  return p ? `${p.scheme}://${p.host}` : null;
}

// Iterate `matching.matches` and return the first origin we can
// extract. Input is `@match`-only by construction (`@include` /
// `@exclude` live in separate fields on `UrlMatching`); we'd skip
// them here anyway since they're free-form globs/regexes over the
// whole URL, not URL templates.
export function representativeOrigin(matching: {
  matches: string[];
}): string | null {
  return representativeMatch(matching)?.origin ?? null;
}

// Like representativeOrigin, but also yields a representative URL —
// the page to fetch for icon discovery AND the click-through target.
// Built segment-aware (see `linkPathFromMatchPath`):
//   https://example.com/*              → /
//   https://example.com/app/home/*     → /app/home/
//   https://example.com/posts/*/edit   → /posts/
//   https://example.com/foo/bar*       → /foo/bar
export function representativeMatch(matching: {
  matches: string[];
}): MatchTarget | null {
  for (const m of matching.matches) {
    const got = matchTargetInfo(m);
    if (got) return got;
  }
  return null;
}

// Per-pattern variant of `representativeMatch`. The linkifier calls
// this once per `@match`/`@exclude`/`@include` value rather than
// taking the first usable one.
export function matchTargetInfo(pattern: string): MatchTarget | null {
  const p = parseMatchPattern(pattern);
  if (!p) return null;
  const origin = `${p.scheme}://${p.host}`;
  const linkUrl = origin + linkPathFromMatchPath(p.path);
  return { origin, linkUrl };
}

// Build the click-through path for a `@match` pattern. Walk segments
// left-to-right and stop at the first one containing a `*`:
//
//   - Last segment, `*` at the end with a non-empty literal prefix
//     (`foo*`, `ol.php?type=precip*`): keep the literal prefix
//     verbatim. The user is targeting one specific page parametrised
//     on the tail, so the prefix typically is the real URL minus a
//     fragment and navigating to it works.
//   - Otherwise (whole-segment wildcard, mid-segment wildcard, or
//     wildcard segment followed by more path): trim back to the last
//     clean directory boundary — a partial prefix in the middle of a
//     path isn't likely to navigate, but the parent directory often
//     does.
//
// Pure-literal paths (no `*` anywhere) pass through unchanged.
export function linkPathFromMatchPath(path: string): string {
  const segments = path.split('/');
  const kept: string[] = [];
  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i];
    const star = seg.indexOf('*');
    if (star < 0) {
      kept.push(seg);
      continue;
    }
    const isLastSegment = i === segments.length - 1;
    const starAtSegmentEnd = star === seg.length - 1;
    if (isLastSegment && starAtSegmentEnd && star > 0) {
      kept.push(seg.slice(0, star));
      return '/' + kept.join('/');
    }
    // Trailing slash when we kept at least one full segment; bare `/`
    // when the wildcard segment was the first one.
    return '/' + (kept.length ? kept.join('/') + '/' : '');
  }
  return '/' + kept.join('/');
}
