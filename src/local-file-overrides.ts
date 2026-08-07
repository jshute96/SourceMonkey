// Local stand-ins for the files a script declares by absolute URL.
//
// The problem: a `@require https://cdn.example.com/lib/util.js` is the
// only form other managers understand, so a script meant to be portable
// has to write it — but while you are *developing* that library you want
// the copy on your own disk, not the published one (which may not even
// exist yet).
//
// The rule: given an ordered list of local root directories, try
// progressively shorter **path suffixes** of the declared URL under each
// root, longest first. The first readable file wins; if none is
// readable, the declared URL is fetched as usual.
//
//   root  /home/me/dev/mystuff
//   ref   https://cdn.example.com/lib/util.js
//   →     /home/me/dev/mystuff/lib/util.js
//   →     /home/me/dev/mystuff/util.js
//
// The same-directory case is not a separate rule — it is this rule with
// an implicit root of the host script's own folder, where the only
// suffix that can match is the bare filename. One code path, so the
// implicit and configured forms can't drift.
//
// ## What keeps this safe
//
// Not which tag is being resolved (`@require` vs `@resource`), but WHO
// the host script is:
//
//   - Inferred substitution (this module) only applies when the host
//     script's own URL is `file://`. A script loaded from a local
//     directory the user added by absolute path already has ambient
//     reach over that tree — a relative `@require ./util.js` resolves
//     there today. Giving it `<its own dir>/util.js` grants nothing new.
//   - An http(s)-loaded script never gets inference. That is the case
//     where a hostile `@resource file:///home/you/.ssh/id_rsa` followed
//     by `GM_getResourceText` would actually matter.
//
// On top of that, candidates are built only from `URL.pathname`
// segments, which the URL parser has already normalized — no `..` and no
// `%2e%2e` can survive into a segment. A segment carrying an ENCODED
// separator (`%2F`, `%5C`) is rejected outright, because the parser
// leaves those alone and the filesystem layer may not. And every
// candidate is re-checked against its root prefix before being offered.
// So a search root is a floor, not a starting point for climbing.
//
// Explicit per-file overrides (a path the user typed for one specific
// ref) are a separate, later mechanism: those are allowed for any host
// script, because naming the file IS the authorization. See TODO.md.

import { isHttpUrl, isFileUrl, containerKind } from './directories.js';

// Ordered local directories to search for a stand-in, most specific
// first. Empty means "no substitution" — every caller short-circuits on
// that, so a script with no local roots costs exactly what it did
// before this feature existed.
//
// Phase 1 produces at most one root: the host script's own folder.
// Configured per-source / global roots append after it — the implicit
// folder always wins, because the file sitting next to the script is
// the least surprising answer.
export function localSearchRoots(
  scriptFileUrl: string,
  enabled: boolean,
): string[] {
  if (!enabled) return [];
  // The gate: inference is for locally-loaded scripts only.
  if (!isFileUrl(scriptFileUrl)) return [];
  let parent: string;
  try {
    parent = new URL('./', scriptFileUrl).toString();
  } catch {
    return [];
  }
  return [parent];
}

// Can a source's scripts ever have local stand-ins? Used only to decide
// whether the sources page shows the per-source toggle — the real gate
// is `localSearchRoots`, which looks at each script's own URL.
//
// http(s) sources and the http / github containers are excluded: every
// script under them loads over the network, so the toggle would be a
// control that does nothing.
export function sourceSupportsLocalFiles(sourcePath: string): boolean {
  if (isHttpUrl(sourcePath)) return false;
  const container = containerKind(sourcePath);
  return container !== 'http' && container !== 'github';
}

// Every local file that could stand in for `declaredUrl`, in the order
// they should be tried. Callers fetch each in turn and take the first
// that reads.
//
// Suffixes run longest-first so a deliberate layout (`lib/util.js` under
// the root) beats an incidental basename collision (`util.js` sitting
// loose in the root).
export function localFileCandidates(
  declaredUrl: string,
  roots: readonly string[],
): string[] {
  if (roots.length === 0) return [];
  let segments: string[];
  try {
    // `pathname` is already normalized and percent-encoded by the URL
    // parser: `..` and `%2e%2e` have been resolved away, so splitting on
    // `/` here can't manufacture a climbing component. What it does NOT
    // resolve is an encoded separator — see the guard just below.
    segments = new URL(declaredUrl).pathname.split('/').filter(Boolean);
  } catch {
    return [];
  }
  if (segments.length === 0) return [];
  // `pathname` normalizes `..` and `%2e%2e` away, but it deliberately
  // leaves an ENCODED separator (`%2F`, `%5C`) inside a segment — so
  // `/a/..%2f../secret.js` survives as a single segment `..%2f..` and
  // would pass both the segment reasoning and the prefix re-check below,
  // while Chrome's file-URL → filesystem-path conversion may well decode
  // it back into a real separator on the way to the OS.
  //
  // Bail on the whole URL rather than filter segment by segment: an
  // encoded separator inside a path suffix has no legitimate use in
  // matching a local file, and a partial answer here would be a
  // half-trusted one.
  if (segments.some((s) => /%2f|%5c/i.test(s))) return [];

  const bases = roots.map((root) => (root.endsWith('/') ? root : root + '/'));
  // A ref that already resolves inside a search root IS the local file —
  // the ordinary relative-path case, which needs no stand-in. Bailing on
  // the whole URL rather than filtering candidate-by-candidate also
  // avoids the nonsense a local declared URL would otherwise generate,
  // where its own directory segments get re-appended to the root
  // (`…/scripts/` + `home/me/scripts/util.js`).
  if (bases.some((base) => declaredUrl.startsWith(base))) return [];

  const out: string[] = [];
  const seen = new Set<string>();
  for (const base of bases) {
    for (let k = segments.length; k >= 1; k--) {
      const candidate = base + segments.slice(-k).join('/');
      if (seen.has(candidate)) continue;
      // Belt-and-braces containment: the segments above can't climb, but
      // re-parsing costs nothing and makes the floor an enforced
      // property rather than an argued one.
      let normalized: string;
      try {
        normalized = new URL(candidate).toString();
      } catch {
        continue;
      }
      if (!normalized.startsWith(base)) continue;
      seen.add(candidate);
      out.push(normalized);
    }
  }
  return out;
}
