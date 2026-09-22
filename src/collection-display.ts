// Pure display helpers for collections: type classification,
// display-name inference, and the colored type-bubble bookkeeping
// shared by the collections page and the userscript viewer.
//
// The bubble a collection wears says what KIND it is and, for a
// location-backed one, where it lives:
//   - `scripts`           : a container of individually installed
//                           scripts (may mix local, web, and GitHub)
//   - `<scheme>-dir`      : a scanned directory (`file-dir`, `github-dir`)
//   - `<scheme>-manifest` : a `script_manifest.json` (`file-`, `http-`,
//                           `github-manifest`)
// where the scheme is a display-only label — it doesn't drive the
// scan/fetch dispatch (which lives in `directories.ts` and keys off URL
// shape and `isGithubDirCollection` / manifest detection):
//   - github : github.com/* or raw.githubusercontent.com/*
//   - http   : any other http(s) URL
//   - file   : raw filesystem path or file:// URL
//
// Inside a `scripts` collection each row wears its own scheme chip
// (`makeSchemeChip`), since the collection itself has no single scheme.

import {
  containerKind,
  containerPath,
  scriptSchemeKind,
  githubRawToBlobUrl,
  isContainerCollection,
  isFileUrl,
  isHttpUrl,
  pathToFileUrl,
  isManifestCollection,
  type ContainerKind,
} from './directories.js';
import { MANIFEST_FILENAME } from './collection-scan.js';
import { decodeForDisplay } from './script-display.js';
import type { StoredCollection } from './script-store.js';

export type CollectionTypeKey = 'file' | 'http' | 'github';

// Why a script's enable checkbox is greyed out when its parent is off.
// Stands in for `ENABLE_TITLE` on every surface that draws one, so the
// collections page, the viewer's controls row, and the "Other versions"
// panel all explain it the same way.
export const COLLECTION_OFF_TITLE = 'Collection is disabled';

const GITHUB_HOST_RE = /^https?:\/\/(www\.)?github\.com\//i;
const RAW_GITHUB_HOST_RE = /^https?:\/\/raw\.githubusercontent\.com\//i;

// Display-only scheme classification of a collection's location.
// Stable across refreshes because it only depends on the collection
// path. GitHub recognition is intentionally broad — it covers both the
// canonical browse URL (`github.com/.../tree/...`) and the raw-content
// host (`raw.githubusercontent.com/...`) so any scheme of GitHub
// collection reads as `github` in the UI.
//
// A container has no location, so it falls through to `file` — which
// is the right answer for the one caller that asks about containers
// (`isLocalCollection` in refresh-targets: a container's local rows are
// refreshed one by one). Its bubble never comes from here.
export function inferCollectionType(path: string): CollectionTypeKey {
  if (GITHUB_HOST_RE.test(path) || RAW_GITHUB_HOST_RE.test(path)) return 'github';
  if (isHttpUrl(path)) return 'http';
  return 'file';
}

// Fixed human-readable titles for the three built-in default
// containers. These drive both the displayName backfill and the name
// the install page shows for a default that doesn't exist yet. The
// user can rename the row afterwards; the default is recognised by its
// path (`containerKind`), not by this text.
export const CONTAINER_DISPLAY_NAMES: Record<ContainerKind, string> = {
  file: 'Scripts from local disk',
  http: 'Scripts from web',
  github: 'Scripts from GitHub',
};

// The name for a container whose row carries no `displayName` — a
// pre-rename default, or (never, but defensively) a user-created one
// saved without a name. Never the raw `container:<uuid>` path.
export const UNNAMED_COLLECTION = 'Unnamed collection';

// Bubble label / CSS-key for a container: one word, since a container
// may hold scripts from every scheme.
export const SCRIPTS_BUBBLE_KEY = 'scripts';

// The built-in default containers' names are reserved, whether or not
// the row exists yet. Without this a user could name their own
// collection "Scripts from web", and the first web install would then
// auto-create `container:http` under that same name — two entries in
// the install dropdown reading identically, in a state that could not
// be re-created afterwards (the rename would be refused as a
// duplicate). Returns the kind that owns the name, or null.
//
// The owning default itself is exempt: it already has the name, and
// re-saving its own name must not be refused.
export function reservedNameOwner(name: string): ContainerKind | null {
  const key = name.trim().toLowerCase();
  if (!key) return null;
  for (const [kind, label] of Object.entries(CONTAINER_DISPLAY_NAMES)) {
    if (label.toLowerCase() === key) return kind as ContainerKind;
  }
  return null;
}

// Why a name can't be used: a built-in collection owns it. The name
// isn't repeated back — the user is standing at the field they just
// typed it into.
export const RESERVED_COLLECTION_NAME =
  'Built-in collection name is reserved. Choose another name.';

// True when the given collection may carry a reserved name: it IS the
// default that owns it. `path` is the row being created or edited;
// pass null when creating a user collection, which never may.
export function mayUseReservedName(name: string, path: string | null): boolean {
  const owner = reservedNameOwner(name);
  return owner === null || (path !== null && path === containerPath(owner));
}

// True when two collections would collide on name. Case-insensitive
// and whitespace-trimmed, since two names that differ only that way
// would read as one in the install dropdown. `excludeId` lets an edit
// keep its own current name.
export function collectionNameInUse(
  name: string,
  collections: readonly StoredCollection[],
  excludeId?: string,
): boolean {
  const key = name.trim().toLowerCase();
  if (!key) return false;
  return collections.some(
    (c) => c.id !== excludeId && effectiveDisplayName(c).trim().toLowerCase() === key,
  );
}

// True for manifest collections of any scheme. Thin wrapper so callers
// don't have to import `directories` just for this. Container
// collections can never be manifests — their `path` is the synthetic
// `container:…` identifier.
export function collectionHasManifest(path: string): boolean {
  if (isContainerCollection(path)) return false;
  return isManifestCollection(path);
}

// Bubble label / CSS-key for a collection: `scripts` for a container,
// `<scheme>-dir` for a scanned directory, `<scheme>-manifest` for a
// manifest. Same string powers the CSS class (`bubble-<key>`) and the
// visible text.
export function collectionBubbleKey(path: string): string {
  if (isContainerCollection(path)) return SCRIPTS_BUBBLE_KEY;
  const t = inferCollectionType(path);
  return collectionHasManifest(path) ? `${t}-manifest` : `${t}-dir`;
}

// The small per-row scheme chip a script wears inside a `scripts`
// collection — `file` / `http` / `github` — since the collection's own
// bubble can't say where each of its scripts loads from. Classified
// from the script's own location (`relativePath` in a container is the
// full URL/path the user installed).
export function makeSchemeChip(location: string): HTMLElement {
  const scheme = scriptSchemeKind(location);
  const span = document.createElement('span');
  span.className = `scheme-chip chip-${scheme}`;
  span.textContent = scheme;
  span.title = {
    file: 'Loaded from a local file',
    http: 'Loaded from the web',
    github: 'Loaded from GitHub',
    pushed: 'Pushed in by a development tool',
  }[scheme];
  return span;
}

// Openable URL for a collection — the link target the bubble uses. For
// github raw URLs (manifest collections, post-add-time normalization)
// we return the `github.com/.../blob/...` page URL instead, since the
// bubble exists for humans to click — the raw bytes are only used
// internally for fetching. All other http(s) / file:// URLs pass
// through; raw filesystem paths become file:// URLs so the anchor has a
// valid href (Chromium typically refuses to navigate to file:// from a
// chrome-extension page, but the URL is still readable + copyable).
// Container collections have no underlying URL — return null and let
// callers render the bubble as a non-link.
export function collectionClickUrl(path: string): string | null {
  if (isContainerCollection(path)) return null;
  if (isHttpUrl(path)) {
    return githubRawToBlobUrl(path) ?? path;
  }
  if (isFileUrl(path)) return path;
  return pathToFileUrl(path);
}

// Derive a short, human-readable display name from a collection path. The
// rules trim noise from the beginning, middle, and end of the link:
//   - drop the protocol prefix (https://, http://, file://)
//   - drop any `?query` tail
//   - drop a trailing `/<MANIFEST_FILENAME>` so a manifest collection reads
//     as the directory that hosts it
//   - github.com / raw.githubusercontent.com get scheme-specific
//     simplifications so the common shapes read as `<owner>/<repo>`
//     or `<owner>/<repo>/<ref>/<path>` rather than the full URL
//   - trailing slashes are stripped
//
// The result is stable across refreshes (depends only on the path),
// short enough for the collections-page heading, and a reasonable seed for
// a future user-renamed displayName.
export function inferDisplayName(path: string): string {
  const ck = containerKind(path);
  if (ck) return CONTAINER_DISPLAY_NAMES[ck];
  // A user-created container has no location to infer from; its name
  // is whatever the user typed, stored in `displayName`.
  if (isContainerCollection(path)) return '';
  let s = path.trim();

  // Strip the fragment + query first so trailing noise can't leak into
  // any downstream substitution (e.g. `?token=...` on a manifest URL,
  // or `#install-section` on a GreasyFork link).
  const h = s.indexOf('#');
  if (h >= 0) s = s.slice(0, h);
  const q = s.indexOf('?');
  if (q >= 0) s = s.slice(0, q);

  // Strip the protocol prefix uniformly. Raw fs paths have none and
  // pass through; file:// URLs become bare absolute paths, which is
  // what users typically recognise.
  s = s.replace(/^https?:\/\//i, '').replace(/^file:\/\//i, '');

  // Drop a trailing manifest filename so `…/foo/script_manifest.json`
  // reads as `…/foo`.
  if (s.endsWith('/' + MANIFEST_FILENAME)) {
    s = s.slice(0, -(MANIFEST_FILENAME.length + 1));
  }

  // GitHub-specific simplifications. Each rule has its own anchor on
  // the URL shape; early-return after the first match so a literal
  // directory named `tree` or `blob` (post-rewrite) doesn't get
  // re-consumed by a later rule. Order doesn't matter once we exit
  // after the first hit. Longer literal segments listed first only as
  // a readability hint.
  if (/^(www\.)?github\.com\//i.test(s)) {
    s = s.replace(/^(www\.)?github\.com\//i, '');
    s = applyFirstGithubRule(s);
  } else if (/^raw\.githubusercontent\.com\//i.test(s)) {
    s = s.replace(/^raw\.githubusercontent\.com\//i, '');
    // New-style raw URLs carry an extra `/refs/heads/` segment before
    // the branch name; strip it so the form mirrors the legacy shape.
    const m = /^([^\/]+\/[^\/]+)\/refs\/heads\/([^\/]+)(\/.*)?$/.exec(s);
    if (m) s = `${m[1]}/${m[2]}${m[3] ?? ''}`;
  }

  // Trim trailing slashes so e.g. `…/dir/` reads as `…/dir`.
  s = s.replace(/\/+$/, '');

  // Decode percent-encoded characters so e.g. a GreasyFork URL with
  // `OnePelotoncom%20Cycle...` reads as `OnePelotoncom Cycle...`.
  // Same decode-for-display rule the rest of the UI follows — see
  // docs/names-and-paths.md.
  return decodeForDisplay(s);
}

// Try each github URL-shape rewrite in turn and return on the first
// hit. Single-pass match avoids the chain-rewrite hazard where a
// post-rewrite path that happens to contain a literal `blob` / `tree`
// directory would be re-interpreted by a later rule.
function applyFirstGithubRule(s: string): string {
  // `<owner>/<repo>/tree/<ref>(/<path>?)` → `<owner>/<repo>(/<path>?)`
  let m = /^([^\/]+\/[^\/]+)\/tree\/[^\/]+(\/.*)?$/.exec(s);
  if (m) return m[1] + (m[2] ?? '');
  // `<owner>/<repo>/blob/<ref>/<path>` → `<owner>/<repo>/<ref>/<path>`
  m = /^([^\/]+\/[^\/]+)\/blob\/([^\/]+)(\/.*)?$/.exec(s);
  if (m) return `${m[1]}/${m[2]}${m[3] ?? ''}`;
  // `<owner>/<repo>/raw/refs/heads/<branch>/<path>` →
  // `<owner>/<repo>/<branch>/<path>`
  m = /^([^\/]+\/[^\/]+)\/raw\/refs\/heads\/([^\/]+)(\/.*)?$/.exec(s);
  if (m) return `${m[1]}/${m[2]}${m[3] ?? ''}`;
  // `<owner>/<repo>/raw/<ref>/<path>` → `<owner>/<repo>/<ref>/<path>`
  m = /^([^\/]+\/[^\/]+)\/raw\/([^\/]+)(\/.*)?$/.exec(s);
  if (m) return `${m[1]}/${m[2]}${m[3] ?? ''}`;
  return s;
}

// Canonical collections-page anchor for a collection. Lives here (not
// in collections.ts) so the viewer can link back to the right `#…`
// without reaching across pages for the helper.
export function collectionAnchorId(collectionId: string): string {
  return `collection-${collectionId}`;
}

// Construct the colored type-bubble for a collection. Shared by the
// collections page (heading) and the userscript viewer (Collection row)
// so the markup, classes, tooltip, and anchor target all stay in
// lockstep across both views. Returns an `<a>` for collections backed
// by a real URL/path, and a `<span>` for container collections (which
// have no underlying URL to link to).
export function makeCollectionTypeBubble(path: string): HTMLElement {
  const key = collectionBubbleKey(path);
  const href = collectionClickUrl(path);
  if (href === null) {
    // No URL to link to, so the tooltip says what this collection IS
    // rather than naming the internal "container" kind — the user never
    // sees that word — and why there is nothing to open: its scripts
    // were installed one at a time and share no parent.
    const span = document.createElement('span');
    span.className = `collection-type-bubble bubble-${key}`;
    span.textContent = key;
    span.title = 'Collection of individual scripts (no common parent directory)';
    return span;
  }
  const a = document.createElement('a');
  a.className = `collection-type-bubble bubble-${key}`;
  a.textContent = key;
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  // Names what clicking does, which differs by kind: a directory (local
  // or a GitHub tree) opens somewhere you can look around; a manifest
  // opens the one file that lists the scripts.
  a.title = collectionHasManifest(path)
    ? `Open manifest: ${path}`
    : `Browse directory: ${path}`;
  return a;
}

// Resolve the display name for a stored collection. Prefers the stored
// `displayName` (the user's own, or the one seeded at add time);
// otherwise falls back to the inferred one. The very last fallback is
// the raw `path` — or a placeholder for a container, whose synthetic
// path is not for showing — so the UI never renders an empty string.
export function effectiveDisplayName(collection: StoredCollection): string {
  const stored = collection.displayName?.trim();
  if (stored) return stored;
  const inferred = inferDisplayName(collection.path);
  if (inferred) return inferred;
  return isContainerCollection(collection.path) ? UNNAMED_COLLECTION : collection.path;
}
