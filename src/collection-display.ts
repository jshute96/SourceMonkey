// Pure display helpers for collections: type classification,
// display-name inference, and the colored type-bubble bookkeeping
// shared by the collections page and the userscript viewer.
//
// The three collection types here are display-only labels — they don't
// drive the scan/fetch dispatch (which lives in `directories.ts` and
// keys off URL shape and `isGithubDirCollection` / manifest detection):
//   - github : github.com/* or raw.githubusercontent.com/*
//   - http   : any other http(s) URL
//   - file   : raw filesystem path or file:// URL
//
// Manifest is an orthogonal flag (`-manifest` suffix on the bubble
// label) that mirrors `isManifestCollection`. Container collections
// (whose path is `container:<kind>`) classify to their kind and never
// carry the manifest suffix.

import {
  containerKind,
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

// Display-only classification. Stable across refreshes because it only
// depends on the collection path. GitHub recognition is intentionally
// broad — it covers both the canonical browse URL
// (`github.com/.../tree/...`) and the raw-content host
// (`raw.githubusercontent.com/...`) so any scheme of GitHub collection
// reads as `github` in the UI. Container collections project to their
// own container kind so the bubble matches the scripts they hold.
export function inferCollectionType(path: string): CollectionTypeKey {
  const ck = containerKind(path);
  if (ck) return ck;
  if (GITHUB_HOST_RE.test(path) || RAW_GITHUB_HOST_RE.test(path)) return 'github';
  if (isHttpUrl(path)) return 'http';
  return 'file';
}

// Fixed human-readable titles for the three container collections.
// These drive both the displayName backfill and the heading the
// collections page renders for each container.
export const CONTAINER_DISPLAY_NAMES: Record<ContainerKind, string> = {
  file: 'Scripts from local disk',
  http: 'Scripts from web',
  github: 'Scripts from GitHub',
};

// True for manifest collections of any scheme. Thin wrapper so callers
// don't have to import `directories` just for this. Container
// collections can never be manifests — their `path` is the synthetic
// `container:<kind>` identifier.
export function collectionHasManifest(path: string): boolean {
  if (isContainerCollection(path)) return false;
  return isManifestCollection(path);
}

// Bubble label / CSS-key for a collection. `<type>` when not a manifest,
// `<type>-manifest` when it is. Same string powers the CSS class
// (`bubble-<key>`) and the visible text.
export function collectionBubbleKey(path: string): string {
  const t = inferCollectionType(path);
  return collectionHasManifest(path) ? `${t}-manifest` : t;
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

// Append a path / URL string to an element, inserting a `<wbr>` after
// each `/` so the browser prefers slash boundaries when wrapping a
// long value. Combined with `overflow-wrap: anywhere` on the element,
// the wrap order becomes: spaces first, then slashes, then anywhere
// inside a word only when nothing else fits. The slash itself stays
// attached to the preceding segment so it reads as `foo/` then a
// break, not a `/bar` continuation.
//
// Use this for any field that may render a long path or URL: the
// collections page display name, the viewer's Location row, the Match /
// Exclude pattern rows, etc.
export function appendWithSlashBreaks(el: HTMLElement, text: string): void {
  const doc = el.ownerDocument;
  const parts = text.split('/');
  parts.forEach((part, i) => {
    if (i > 0) {
      el.appendChild(doc.createTextNode('/'));
      el.appendChild(doc.createElement('wbr'));
    }
    if (part) el.appendChild(doc.createTextNode(part));
  });
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
    // No URL to link to, so the tooltip says why rather than naming the
    // internal "container" kind — the user never sees that word, only
    // the "Scripts from …" heading these collections carry.
    const span = document.createElement('span');
    span.className = `collection-type-bubble bubble-${key}`;
    span.textContent = key;
    span.title = 'Scripts added one at a time — no URL to open';
    return span;
  }
  const a = document.createElement('a');
  a.className = `collection-type-bubble bubble-${key}`;
  a.textContent = key;
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.title = `Open collection: ${path}`;
  return a;
}

// Resolve the display name for a stored collection. Prefers an explicit
// `displayName` (future user-renamed value); otherwise falls back to
// the inferred one. The very last fallback is the raw `path` so the
// UI never renders an empty string.
export function effectiveDisplayName(collection: StoredCollection): string {
  const stored = collection.displayName?.trim();
  if (stored) return stored;
  const inferred = inferDisplayName(collection.path);
  return inferred || collection.path;
}
