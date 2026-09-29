// Local stand-ins for the files a script declares by absolute URL.
//
// The problem: a `@require https://cdn.example.com/lib/util.js` is the
// only form other managers understand, so a script meant to be portable
// has to write it — but while you are *developing* that library you want
// the copy on your own disk, not the published one (which may not even
// exist yet).
//
// The rule: given an ordered list of local root directories, try
// progressively shorter suffixes of `<host>/<path>` under each root,
// longest first. The first readable file wins; if none is readable, the
// declared URL is fetched as usual.
//
//   root  /home/me/dev/mystuff
//   ref   https://cdn.example.com/lib/util.js
//   →     /home/me/dev/mystuff/cdn.example.com/lib/util.js
//   →     /home/me/dev/mystuff/lib/util.js
//   →     /home/me/dev/mystuff/util.js
//
// The host is included so a mirror-style tree (one directory per site,
// as scraped-copy layouts and `wget -x` produce) matches, and matches
// first — it is the most specific thing the ref can say.
//
// The same-directory case is not a separate rule — it is this rule with
// an implicit root of the host script's own folder, where the file
// sitting next to the script is the suffix that usually matches. One
// code path, so the implicit and configured forms can't drift.
//
// The COLLECTION's own root is an implicit root too, and for the same
// reason: a local directory (or manifest) collection is a tree the user
// named, its scripts sit at relative paths inside it, and a shared
// `lib/` next to those scripts is where a repo of userscripts actually
// keeps its libraries. Without it a script two levels down
// (`sites/example.com/foo.user.js`) could never see `lib/util.js`,
// because a root is a floor and the search never climbs.
//
// ## What keeps this safe
//
// Not which tag is being resolved (`@require` vs `@resource`), but WHO
// the host script is:
//
//   - Inferred substitution (this module) only applies when the host
//     script's own URL is `file://`. Its OWN folder grants nothing new:
//     a relative `@require ./util.js` already resolves there today, and
//     `file-loader.ts` confines a relative ref to exactly that folder.
//   - An http(s)-loaded script never gets inference. That is the case
//     where a hostile `@resource file:///home/you/.ssh/id_rsa` followed
//     by `GM_getResourceText` would actually matter.
//   - The collection root and a configured root ARE reach the script
//     didn't otherwise have — a relative ref cannot climb into either —
//     and a script picks the path suffix it looks for, so everything
//     under one is readable by any local script in it, including via
//     `@resource` + `GM_getResourceText`. What justifies each is that
//     the user named that directory: a configured root on the options
//     page, a collection root by adding the collection. Both say so
//     where they're set (the options page's note, the collection
//     dialog's local-overrides option) — so point a collection at a directory of
//     script content, not at a home directory.
//
// On top of that:
//
//   - Path segments come from `URL.pathname`, which the parser has
//     already normalized — no `..` and no `%2e%2e` survives into one.
//   - The HOST segment gets no such normalization: `new URL('https://../
//     x.js').host` really is `..`. So for that one segment the prefix
//     re-check in `localFileCandidates` is not belt-and-braces, it is
//     the enforcement. Don't remove it.
//   - Any segment carrying an ENCODED separator (`%2F`, `%5C`) makes the
//     whole URL ineligible — the parser leaves those alone and the
//     filesystem layer may not. The host is checked too, since it is
//     unshifted onto the segment list before that guard runs.
//   - Every candidate is re-checked against its root prefix before being
//     offered.
//
// So a search root is a floor, not a starting point for climbing.
//
// Explicit per-file overrides (a path the user typed for one specific
// ref) are a separate, later mechanism: those are allowed for any host
// script, because naming the file IS the authorization. See TODO.md.

import {
  isHttpUrl,
  isFileUrl,
  isContainerCollection,
  pathToFileUrl,
  isManifestCollection,
  isSingleFileInput,
  collectionCanonicalUrl,
  locationFsPath,
  isNonPosixFileUrl,
  listDirectory,
  type DirectoryListingCache,
  type ListingEntry,
} from './directories.js';

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
// role `LOCATION_SHAPES` plays for collection inputs. http(s) is absent
// on purpose: a root names a directory on this machine. Unexported:
// unlike `LOCATION_SHAPES` there is only one validator, so the whole
// message is what callers see.
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
    else entry.error = `Local file root ${ROOT_SHAPES}`;
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

// Cached copy of the setting, mirroring `debug-log.ts`:
// `localSearchRoots` is called synchronously from render paths in three
// contexts (service worker, collections page, viewer), so each loads
// once at startup and then tracks `storage.onChanged`. Defaults to
// none, which is also what any caller outside the extension (the
// corpus validator) sees.
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

// Set the configured roots directly, bypassing storage. Production
// callers write the storage key and let the listener above pick it up;
// this is for the two contexts with no `chrome.storage` at all — unit
// tests, and the development harness (`src/harness/`), which runs the
// same resolve pipeline under Node with roots the caller names.
export function setConfiguredLocalRoots(roots: readonly string[]): void {
  configuredRoots = roots.slice();
  loadGeneration++;
  // Also satisfy `localRootsReady`, or the first resolve after this
  // would read storage and overwrite what was just set.
  loadOnce = Promise.resolve();
}

// Test hook, kept under its old name for the tests and the SW test
// surface that call it.
export function _setLocalRootsForTests(roots: readonly string[]): void {
  setConfiguredLocalRoots(roots);
}

// What a script's collection says about local stand-ins: whether they
// are allowed at all (the per-collection toggle), and which directory
// the collection itself is rooted at. Passed as one value because every
// caller has both facts from the same collection row, and a caller that
// knew only the toggle would silently search one root too few.
export interface LocalFileScope {
  enabled: boolean;
  // The collection's stored `path`. Optional: the viewer's preview has
  // no collection row at all, and neither does the corpus validator.
  collectionPath?: string;
}

// The directory a collection is rooted at, as a search root — or null
// when it has no single tree to search:
//
//   - Container collections (`container:file` and friends) aggregate
//     individually added scripts that share no directory. Each script's
//     own folder, which `localSearchRoots` adds anyway, is the whole of
//     what they have in common. (So this is a narrower question than
//     `collectionSupportsLocalFiles` below, which says yes to a file
//     container — its scripts do get their own folders.)
//   - http(s) collections aren't local. (Their scripts can't get roots
//     either — see the `file://` gate below — so this is belt and
//     braces.)
//
// A manifest names a FILE, and its relative entries resolve against that
// file's own directory, so the root is the parent. (Only *relative*
// ones: `resolveManifestEntryUrl` applies no containment, so an entry
// may name a script outside the tree. Such a script still gets the
// manifest's directory as a root — the user wrote the manifest, which
// is the same authorization the directory case rests on.) Legacy
// single-file collection rows (`*.user.js` as the path) take the parent
// too, which is always the script's own folder and so always deduped
// away; the branch exists so the classification reads completely.
// Everything else is a local directory: itself.
function collectionRootUrl(collectionPath: string): string | null {
  if (!collectionPath) return null;
  if (isContainerCollection(collectionPath)) return null;
  if (isHttpUrl(collectionPath)) return null;
  const canonical = collectionCanonicalUrl(collectionPath);
  if (!isFileUrl(canonical)) return null;
  if (isManifestCollection(collectionPath) || isSingleFileInput(collectionPath)) {
    try {
      return canonicalRootUrl(new URL('./', canonical).toString());
    } catch {
      return null;
    }
  }
  // Same validation a configured root gets — a collection path is user
  // input too, and it becomes a floor here exactly as one does.
  return canonicalRootUrl(canonical);
}

// Ordered local directories to search for a stand-in, most specific
// first. Empty means "no substitution" — every caller short-circuits on
// that, so a script with no local roots costs exactly what it did
// before this feature existed.
//
// The order, most specific first:
//   1. The host script's own folder — the file sitting next to the
//      script is the least surprising answer.
//   2. The collection's own root, so a repo-wide `lib/` is reachable
//      from a script nested inside the tree the user added.
//   3. Configured roots (options page, in the order typed).
//
// The `file://`-host gate covers the collection root and the configured
// roots too. A global root is a development directory; a script you
// installed from the web has no business resolving its dependencies out
// of it, and the intended answer for that case is an explicit per-file
// override — one path, named by the user, for one ref. See TODO.md.
export function localSearchRoots(
  scriptFileUrl: string,
  scope: LocalFileScope,
): string[] {
  if (!scope.enabled) return [];
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
  const collectionRoot = scope.collectionPath
    ? collectionRootUrl(scope.collectionPath)
    : null;
  // De-dupe: a script at the top of its collection has its own folder
  // AS the collection root, and either is a perfectly reasonable thing
  // to ALSO list as a global root. `localFileCandidates` would already
  // collapse the duplicate candidates, so this is about the list
  // reading as what it claims to be — the *additional* places searched,
  // each appearing once.
  const roots = [parent];
  for (const root of [collectionRoot, ...configuredRoots]) {
    if (root && !roots.includes(root)) roots.push(root);
  }
  return roots;
}

// Can a collection's scripts ever have local stand-ins? Used only to
// decide whether the collection dialog offers the per-collection
// option — the real gate is `localSearchRoots`, which looks at each
// script's own URL. Not the same question as `collectionRootUrl` above:
// a container supports stand-ins but contributes no root of its own.
//
// http(s) collections are excluded: every script under them loads over
// the network, so the option would be a control that does nothing.
// Every container qualifies — even the built-in web / GitHub defaults —
// because a container may hold scripts from any scheme, and the option
// applies to whichever of them came from disk.
export function collectionSupportsLocalFiles(collectionPath: string): boolean {
  return !isHttpUrl(collectionPath);
}

// Every local file that could stand in for `declaredUrl`, in the order
// they should be tried. Readers go through `presentLocalFileCandidates`
// below, which drops the ones that can't exist before fetching each in
// turn and taking the first that reads.
//
// Suffixes run longest-first so a deliberate layout (`lib/util.js` under
// the root) beats an incidental basename collision (`util.js` sitting
// loose in the root). The declared URL's HOST counts as the outermost
// segment, so a mirror-style tree — the layout `wget -x` and every
// scraped-copy directory uses — matches before any bare path suffix:
//
//   root  /home/me/files
//   ref   https://code.jquery.com/jquery-latest.js
//   →     /home/me/files/code.jquery.com/jquery-latest.js
//   →     /home/me/files/jquery-latest.js
export function localFileCandidates(
  declaredUrl: string,
  roots: readonly string[],
): string[] {
  return localFileCandidatesDetailed(declaredUrl, roots).map((c) => c.url);
}

// One candidate with the pieces `presentLocalFileCandidates` gates on:
// which root it was built under, and the first path segment beneath
// that root — a directory name when there are more segments to come,
// the file's own name when there aren't.
export interface LocalFileCandidate {
  url: string;
  root: string;
  // Percent-encoded, as it appears in `url`.
  firstSegment: string;
  // True when `firstSegment` is the whole suffix, i.e. names the file.
  isLeaf: boolean;
}

export function localFileCandidatesDetailed(
  declaredUrl: string,
  roots: readonly string[],
): LocalFileCandidate[] {
  if (roots.length === 0) return [];
  let segments: string[];
  try {
    const parsed = new URL(declaredUrl);
    // `pathname` is already normalized and percent-encoded by the URL
    // parser: `..` and `%2e%2e` have been resolved away, so splitting on
    // `/` here can't manufacture a climbing component. What it does NOT
    // resolve is an encoded separator — see the guard just below.
    segments = parsed.pathname.split('/').filter(Boolean);
    // A ref with no path names no file, so there is nothing to stand in
    // for — checked BEFORE the host goes on, or the host alone would be
    // offered as a candidate and Chrome answers a directory read with a
    // listing rather than a failure.
    if (segments.length === 0) return [];
    // Same reason, one level down: `…/assets/` names a directory, and
    // with a host segment in play `<root>/example.com/assets` is a
    // directory that plausibly EXISTS in a mirror tree. `@require` has a
    // `.js` gate, but `@resource` and `@icon` don't — a hit there would
    // bind a directory listing as the file's body.
    if (parsed.pathname.endsWith('/')) return [];
    // `host`, not `hostname`, so a non-default port survives into the
    // directory name the way a mirroring tool would write it. Empty for
    // a `file://` ref, which then just yields the plain path suffixes.
    if (parsed.host) segments.unshift(parsed.host);
  } catch {
    return [];
  }
  // `pathname` normalizes `..` and `%2e%2e` away, but it deliberately
  // leaves an ENCODED separator (`%2F`, `%5C`) inside a segment — so
  // `/a/..%2f../secret.js` survives as a single segment `..%2f..` and
  // would pass both the path-segment reasoning and the prefix re-check below,
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

  const out: LocalFileCandidate[] = [];
  const seen = new Set<string>();
  for (const base of bases) {
    for (let k = segments.length; k >= 1; k--) {
      const candidate = base + segments.slice(-k).join('/');
      // Containment. Belt-and-braces for a PATH segment, which can't
      // climb — but load-bearing for the host segment, which the URL
      // parser does not normalize (`https://../x.js` really does have a
      // host of `..`). This is what keeps the root a floor for it.
      let normalized: string;
      try {
        normalized = new URL(candidate).toString();
      } catch {
        continue;
      }
      if (!normalized.startsWith(base)) continue;
      // Keyed on the NORMALIZED form, since that is what's returned: a
      // host of `.` makes `<root>/./x.js` and `<root>/x.js` two distinct
      // candidate strings that name one file.
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      // Taken from the NORMALIZED form, not `suffix`: a host of `.`
      // makes `<root>/./x.js` normalize to `<root>/x.js`, and the gate
      // has to describe the URL that is actually read.
      const rel = normalized.slice(base.length).split('/');
      out.push({ url: normalized, root: base, firstSegment: rel[0], isLeaf: rel.length === 1 });
    }
  }
  return out;
}

// `localFileCandidates`, minus the ones the root's directory listing
// rules out: a candidate whose first segment under the root isn't
// listed can't exist, so it is never probed.
//
// Why: each probe of a missing file is a failed request in the worker's
// DevTools Network panel — a couple of dozen per script per refresh
// before this, which reads like breakage. Only the first level is
// checked; `<root>/lib/` existing says nothing about `<root>/lib/x.js`,
// so that one is still probed. See docs/local-file-overrides.md.
//
// A root that can't be listed, or lists as empty, keeps every candidate
// — "can't tell" must fall through to the probe, or a stand-in would
// silently stop being found. (Empty is also what an unrecognized
// listing format parses to.)
export async function presentLocalFileCandidates(
  declaredUrl: string,
  roots: readonly string[],
  listings: DirectoryListingCache,
): Promise<string[]> {
  const out: string[] = [];
  for (const c of localFileCandidatesDetailed(declaredUrl, roots)) {
    if (mayExist(c, await listRoot(c.root, listings))) out.push(c.url);
  }
  return out;
}

// Roots whose listing failed, per listing cache. `DirectoryListingCache`
// deliberately forgets a failed read (see `listDirectory`), which is
// right for the scan it was built for but wrong here: a configured root
// that isn't on disk would be re-listed for every dependency of every
// script in the pass, on top of the probes it can't rule out — MORE
// failed requests than before the gate, not fewer. One attempt per root
// per cache; the memo dies with the cache it describes.
const failedRoots = new WeakMap<DirectoryListingCache, Set<string>>();

// The root's listing, or `null` for "can't tell" — every candidate
// under it is then kept.
async function listRoot(
  root: string,
  listings: DirectoryListingCache,
): Promise<readonly ListingEntry[] | null> {
  // `locationFsPath` drops the host of a UNC / drive-letter URL, so the
  // listing would describe some other directory. Those roots skip the
  // gate rather than filter against the wrong tree.
  if (isNonPosixFileUrl(root)) return null;
  let failed = failedRoots.get(listings);
  if (!failed) {
    failed = new Set();
    failedRoots.set(listings, failed);
  }
  if (failed.has(root)) return null;
  // No trailing slash (the batch keys its listings by the bare directory
  // path, and this has to hit the same entry), except that the
  // filesystem root stays `/` — the batch's own convention.
  const dir = locationFsPath(root).replace(/\/+$/, '') || '/';
  try {
    return await listDirectory(dir, listings);
  } catch {
    failed.add(root);
    return null;
  }
}

function mayExist(c: LocalFileCandidate, entries: readonly ListingEntry[] | null): boolean {
  if (entries === null || entries.length === 0) return true;
  let name: string;
  try {
    name = decodeURIComponent(c.firstSegment);
  } catch {
    return true;
  }
  const entry = entries.find((e) => e.name === name);
  // A directory entry when the segment names a directory, a file entry
  // when it names the file itself. A symlink is listed as whatever it
  // points at, so it passes the same way the read would.
  return entry !== undefined && entry.isDir !== c.isLeaf;
}
