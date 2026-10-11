// Pure helpers for converting a Chrome `@match` pattern into a
// "target" the rest of the app can act on: the pattern's representative
// origin and a click-through / page URL (the same URL serves both
// purposes — favicon HTML discovery and open-in-new-tab click).
//
// Used by:
//   - site-icon.ts — takes `representativeMatches(matching)` (the
//     first few distinct sites) to drive favicon discovery (origin
//     caching, page URL for HTML probe, click target) — one icon per
//     site.
//   - script-details.ts / code-links.ts — call `matchTargetInfo(pattern)`
//     per-pattern when linkifying `@match`/`@exclude`/`@include` values,
//     falling back to `sameDirLinkUrl` for patterns that name no site.
//
// No fetching, no DOM, no chrome.storage — that all lives in the
// modules that consume these primitives.

import { canonicalMatchPatterns } from './url-match.js';
// Pure regex rewrite, no fetching — imported so the same-directory
// fallback below points a github-hosted script's neighbour at the
// github.com page instead of its raw bytes.
import { githubRawToBlobUrl } from './github-urls.js';

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
  // Read the pattern the way the matcher and the registration do — a
  // scheme-less `*.example.com/*` names a site, and should get an icon
  // and a click-through like any other. An expansion only varies the
  // scheme, and this picks one representative origin, so prefer a form
  // that isn't `http://`: `*` is read as https below, and a port-pinned
  // `*://host:8443/*` (which canonicalizes to the http + https pair)
  // must keep pointing at the https member — fetching the icon over
  // http would fail on a TLS-only port.
  const canonical = canonicalMatchPatterns(pattern);
  const preferred = canonical.find((p) => !p.startsWith('http://')) ?? canonical[0] ?? pattern;
  const parts = /^(\*|https?|file|ftp):\/\/([^/]*)(\/.*)?$/i.exec(preferred);
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
  // `.tld` means "any public suffix" (see url-match.ts); `.com` is
  // the one most such sites answer on, so the icon and link use it.
  if (host.endsWith('.tld')) host = host.slice(0, -4) + '.com';

  // The host slot has to hold a host we could actually navigate to.
  // Worth checking since the scheme-less reading above will supply a
  // scheme for any text at all (`not a pattern` → `*://not a pattern`),
  // and this origin becomes a fetch and an href.
  try {
    new URL(`${scheme}://${host}${port}/`);
  } catch {
    return null;
  }

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
  return representativeMatches(matching, 1)[0] ?? null;
}

// How many distinct sites a script's icon slot shows by default — the
// collections-table limit, where the slot sits in a column beside the
// name. The viewer heading has room for more and passes its own.
export const MAX_SITE_ICONS = 3;

// The first `limit` DISTINCT sites named by `matching.matches`, in
// header order. Two patterns are the same site when their hosts match
// after dropping a leading `www.`; the scheme is ignored, so
// `http://www.example.com/*` and `https://example.com/*` yield one
// entry (the first seen). Ports still distinguish — `localhost:3000`
// and `localhost:8080` are different servers with different icons.
export function representativeMatches(
  matching: { matches: string[] },
  limit: number = MAX_SITE_ICONS,
): MatchTarget[] {
  const out: MatchTarget[] = [];
  const seen = new Set<string>();
  for (const m of matching.matches) {
    if (out.length >= limit) break;
    const got = matchTargetInfo(m);
    if (!got) continue;
    const key = siteKey(got.origin);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(got);
  }
  return out;
}

// Identity of a site for the purpose of "one icon per site": the
// host[:port] with a leading `www.` removed and the scheme dropped.
function siteKey(origin: string): string {
  const host = origin.slice(origin.indexOf('://') + 3).toLowerCase();
  return host.startsWith('www.') ? host.slice(4) : host;
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

// Fallback for patterns that name no site: link to a page sitting in
// the same directory as the script itself. Full rule, worked examples
// and rationale in docs/script-viewer.md#same-directory-fallback; in
// short, a pattern with no host whose literal trailing directories
// (and any literal text ending a wildcard directory, like `*gm-menu`)
// match the tail of the script's own directory D links to D + its
// filename.
//
// It exists for the site-less patterns a script uses to name the page
// it ships beside, such as:
//
//   @match *://*/gm-menu/gm-menu.html
//   @match *://*/*gm-menu/gm-menu.html
//   @match file:///*/gm-menu/gm-menu.html
//
// None yields a target above (the `*://` ones have a host of `*`, the
// other a `file:` scheme), so their rows rendered as plain text even
// though the page is sitting next to the script we're viewing.
//
// Two properties worth keeping in mind when editing:
//   - The result is D plus one literal filename, so no pattern can
//     walk out of the script's own directory.
//   - Existence is never checked, so a script linkifies identically
//     whether it was loaded from disk or from a server.
export function sameDirLinkUrl(pattern: string, scriptUrl: string | undefined): string | null {
  if (!scriptUrl) return null;
  // Only the schemes a site-less pattern is written with. Anchoring
  // the scheme (rather than accepting any `x://`) keeps
  // `/^https?:\/\/x/`-style regex literals — legal in `@include` /
  // `@exclude` — out of here, and `https?\*?` admits the
  // `http*://` shorthand those tags are often written with.
  const parts = /^(?:\*|https?\*?|file):\/\/([^/]*)(\/.*)$/i.exec(pattern.trim());
  if (!parts) return null;
  const [, host, path] = parts;
  if (host !== '' && host !== '*') return null;

  const segments = path.split('/').slice(1);
  const filename = segments.pop() ?? '';
  // A query or fragment means the page is parametrised, not a plain
  // file next door — and `?` is legal in a `@match` path glob
  // (`ol.php?type=precip*`), so it has to be rejected explicitly
  // rather than left to the extension check.
  if (!filename || /[*?#]/.test(filename) || !/\.[A-Za-z0-9]+$/.test(filename)) return null;

  // Everything at or before the last wildcard segment is absorbed by
  // that wildcard; what follows has to be matched literally.
  // (A hand-rolled findLastIndex — the project's lib target predates it.)
  let lastWildcard = -1;
  segments.forEach((seg, i) => {
    if (seg.includes('*')) lastWildcard = i;
  });
  const literalDirs = segments.slice(lastWildcard + 1);
  // The text after that segment's last `*` (`gm-menu` in `*gm-menu`)
  // still has to end the directory the wildcard stands in for.
  const wildSuffix = lastWildcard < 0
    ? ''
    : segments[lastWildcard].slice(segments[lastWildcard].lastIndexOf('*') + 1);
  if (literalDirs.length === 0 && !wildSuffix) return null;
  if (literalDirs.some((s) => s === '')) return null;

  const dir = scriptDirUrl(scriptUrl);
  if (!dir) return null;
  const dirSegments = dir.pathname.split('/').filter(Boolean).map(decodeSegment);
  const needed = literalDirs.length + (wildSuffix ? 1 : 0);
  if (dirSegments.length < needed) return null;
  const tail = dirSegments.slice(dirSegments.length - literalDirs.length);
  if (tail.some((seg, i) => seg !== decodeSegment(literalDirs[i]))) return null;
  if (wildSuffix
      && !dirSegments[dirSegments.length - needed].endsWith(decodeSegment(wildSuffix))) {
    return null;
  }

  // Resolved through the URL parser rather than concatenated, so a
  // filename carrying a space or other raw character is escaped the
  // same way the directory around it already is. Safe against
  // traversal: the checks above leave a filename with no `/`.
  let href: string;
  try {
    href = new URL(filename, dir).href;
  } catch {
    return null;
  }
  // Same reasoning as `collectionClickUrl`: a github collection fetches
  // `raw.githubusercontent.com`, which serves HTML as `text/plain`, so
  // the raw neighbour of a script is a plaintext dump. Humans clicking
  // want the github.com page — the same URL the Location row shows.
  return githubRawToBlobUrl(href) ?? href;
}

// The script's parent directory as a URL ending in `/`. Only the
// schemes a script can be loaded from — the href becomes an anchor.
function scriptDirUrl(scriptUrl: string): URL | null {
  try {
    const dir = new URL('.', scriptUrl);
    if (!['http:', 'https:', 'file:'].includes(dir.protocol)) return null;
    return dir;
  } catch {
    return null;
  }
}

// A directory read off a URL is percent-encoded; the same directory
// written into a `@match` pattern usually isn't. Compare both decoded
// so `my dir` and `my%20dir` are the same segment.
function decodeSegment(seg: string): string {
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
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
