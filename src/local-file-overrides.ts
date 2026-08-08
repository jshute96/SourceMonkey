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
//   - A configured root IS reach the script didn't otherwise have, and
//     a script picks the path suffix it looks for, so everything under
//     a root is readable by any local script — including via
//     `@resource` + `GM_getResourceText`. That's a property of the
//     setting, stated where it's configured; roots are meant to name
//     directories of script content, not home directories.
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

import { isHttpUrl, isFileUrl, containerKind, pathToFileUrl } from './directories.js';

// An encoded path separator. The URL parser resolves `..` and `%2e%2e`
// but deliberately leaves these alone inside a segment, while Chrome's
// file-URL → filesystem-path conversion may decode them back into real
// separators. Both the declared URL's segments and a configured root
// are checked against it, so neither can move the floor.
const ENCODED_SEPARATOR_RE = /%2f|%5c/i;

// ---------- Configured search roots ----------

// Stored as an ORDERED ARRAY of canonical `file://` directory URLs —
// already parsed, already validated, already trailing-slashed. The
// options page won't save a list with a malformed line in it, so
// everything downstream can treat the stored value as ready to use;
// nothing re-parses at resolve time.
export const LOCAL_ROOTS_KEY = 'smLocalFileRoots';

// The shapes a search root may take, as a sentence fragment — the same
// role `LOCATION_SHAPES` plays for source inputs. http(s) is absent on
// purpose: a root names a directory on this machine. Unexported: unlike
// `LOCATION_SHAPES` there is only one validator, so the whole message
// is what callers see.
const ROOT_SHAPES = 'must be an absolute path starting with / or a file:// URL';

export interface ParsedRoot {
  lineNumber: number; // 1-based, so an error can say which line
  text: string;       // the line as typed, trimmed
  url?: string;       // canonical file:// URL, trailing slash — absent when invalid
  error?: string;     // format complaint, ready to show as-is
}

// Split the options-page textarea into one entry per non-blank line.
// Blank lines vanish (they're just spacing the user added); everything
// else comes back either canonicalized or carrying an error, so the UI
// can render both the valid list and the complaints from one pass.
export function parseLocalRootLines(text: string): ParsedRoot[] {
  const out: ParsedRoot[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (!trimmed) continue;
    const entry: ParsedRoot = { lineNumber: i + 1, text: trimmed };
    const url = canonicalRootUrl(trimmed);
    if (url) entry.url = url;
    else entry.error = `A local file root ${ROOT_SHAPES}`;
    out.push(entry);
  }
  return out;
}

// A typed root as a directory URL: always `file://`, always ending in
// `/` so it can be concatenated with a path suffix directly, and run
// through the URL parser so `.` / `..` the user typed are resolved
// before anything is matched against it. Null when the shape is wrong.
//
// The root is the floor every containment check is measured against, so
// it has to be at least as clean as the candidates built on top of it.
// Three things a bare `protocol` check would let through:
//   - A fragment or query. `fetch`/XHR strip those before reaching the
//     filesystem, so `file:///a/b#x/` reads `/a/b` — every candidate
//     under such a root would read one and the same file, and the
//     options page's directory probe would call a plain file a
//     directory.
//   - An encoded separator, rejected here for exactly the reason
//     `localFileCandidates` rejects it in a declared URL: the parser
//     leaves `%2F` alone and the filesystem layer may not, so the real
//     floor would sit somewhere above the stated one.
//   - A host. `file://host/share` is not a local absolute path, which
//     is what this setting takes; reads would silently never succeed.
function canonicalRootUrl(typed: string): string | null {
  if (isHttpUrl(typed)) return null;
  let raw: string;
  if (isFileUrl(typed)) raw = typed;
  else if (typed.startsWith('/')) raw = pathToFileUrl(typed);
  else return null;
  try {
    const url = new URL(raw.endsWith('/') ? raw : raw + '/');
    if (url.protocol !== 'file:') return null;
    if (url.hostname) return null;
    if (url.hash || url.search) return null;
    if (ENCODED_SEPARATOR_RE.test(url.pathname)) return null;
    // Rebuild from `pathname` rather than `toString()` so nothing but
    // the path can survive into the stored root.
    return `file://${url.pathname}`;
  } catch {
    return null;
  }
}

// The canonical URLs of every line, in the order typed — or null if any
// line is malformed. Null is the options page's "don't save" signal:
// the stored array is the parsed form, so it must never be built from
// text that didn't fully parse.
export function rootsFromText(text: string): string[] | null {
  const entries = parseLocalRootLines(text);
  if (entries.some((e) => !e.url)) return null;
  return entries.map((e) => e.url!);
}

// The stored array, rendered back into textarea lines.
export function textFromRoots(roots: readonly string[]): string {
  return roots.join('\n');
}

// Cached copy of the setting, mirroring `debug-log.ts`: `localSearchRoots`
// is called synchronously from render paths in three contexts (service
// worker, sources page, viewer), so each loads once at startup and then
// tracks `storage.onChanged`. Defaults to none, which is also what any
// caller outside the extension (the offline validator) sees.
let configuredRoots: string[] = [];
let loadOnce: Promise<void> | null = null;
// Bumped by anything that publishes a newer value, so an initial read
// still in flight knows not to overwrite it.
let loadGeneration = 0;

// Memoized so it can be both "kick this off at startup" and "make sure
// it finished" — `localRootsReady` is awaited on the resolve path, and
// without the memo that await would re-read storage on every script.
export function loadLocalRootsSetting(): Promise<void> {
  if (loadOnce) return loadOnce;
  const token = ++loadGeneration;
  loadOnce = (async () => {
    let next: string[];
    try {
      const got = await chrome.storage.local.get(LOCAL_ROOTS_KEY);
      next = readRootsSetting(got[LOCAL_ROOTS_KEY]);
    } catch {
      next = [];
    }
    // Only publish if nothing newer landed while the read was in
    // flight. A `storage.onChanged` (or a test hook) holds a NEWER
    // value, and what these roots resolve to gets PERSISTED into
    // `StoredRequire.localUrl` — so losing that write isn't merely
    // stale console noise, unlike the same pattern in `debug-log.ts`.
    if (loadGeneration === token) configuredRoots = next;
  })();
  return loadOnce;
}

// Await before calling `localSearchRoots` from a path where reading the
// setting late would silently change the answer. `localSearchRoots`
// itself is synchronous (render paths call it), so the ordering has to
// be the caller's job: a refresh that ran before the initial load
// resolved would resolve every dependency with no configured roots and
// then cache that as the current state.
export function localRootsReady(): Promise<void> {
  return loadLocalRootsSetting();
}

export function installLocalRootsListener(): void {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    const change = changes[LOCAL_ROOTS_KEY];
    if (!change) return;
    configuredRoots = readRootsSetting(change.newValue);
  });
}

// The stored value is already canonical, so this is a shape check, not
// a parse: keep the strings, drop anything that isn't one. A hand-edited
// storage key shouldn't be able to put a non-string into a search root.
// Exported because the options page reads the same key directly.
export function readRootsSetting(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((r): r is string => typeof r === 'string');
}

// Test hook. Production callers write the storage key and let the
// listener above pick it up.
export function _setLocalRootsForTests(roots: readonly string[]): void {
  configuredRoots = roots.slice();
  loadGeneration++;
  // Also satisfy `localRootsReady`, or the first resolve after this
  // would read storage and overwrite what the test just set.
  loadOnce = Promise.resolve();
}

// Ordered local directories to search for a stand-in, most specific
// first. Empty means "no substitution" — every caller short-circuits on
// that, so a script with no local roots costs exactly what it did
// before this feature existed.
//
// The host script's own folder comes first and always wins, because the
// file sitting next to the script is the least surprising answer.
// Configured roots (options page, in the order typed) follow it.
//
// The `file://`-host gate covers the configured roots too. A global
// root is a development directory; a script you installed from the web
// has no business resolving its dependencies out of it, and the
// intended answer for that case is an explicit per-file override — one
// path, named by the user, for one ref. See TODO.md.
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
    // Consistent with every other "we don't know" exit in this module:
    // if the host script's own URL won't parse, we can't establish the
    // gate's premise, so nothing is searched.
    return [];
  }
  // De-dupe: the script's own folder is a perfectly reasonable thing to
  // ALSO list as a global root. `localFileCandidates` would already
  // collapse the duplicate candidates, so this is about the list
  // reading as what it claims to be — the *additional* places searched,
  // each appearing once.
  return [parent, ...configuredRoots.filter((r) => r !== parent)];
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
  if (segments.some((s) => ENCODED_SEPARATOR_RE.test(s))) return [];

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
