// Pure display helpers for sources: type classification, display-name
// inference, and the colored type-bubble bookkeeping shared by the
// sources page and the userscript viewer.
//
// The three source types here are display-only labels — they don't
// drive the scan/fetch dispatch (which lives in `directories.ts` and
// keys off URL shape and `isGithubDirSource` / manifest detection):
//   - github : github.com/* or raw.githubusercontent.com/*
//   - http   : any other http(s) URL
//   - file   : raw filesystem path or file:// URL
//
// Manifest is an orthogonal flag (`-manifest` suffix on the bubble
// label) that mirrors `isManifestSource`.

import {
  isFileUrl,
  isHttpUrl,
  pathToFileUrl,
  isManifestSource,
} from './directories.js';
import { MANIFEST_FILENAME } from './source-scan.js';
import type { StoredSource } from './script-store.js';

export type SourceTypeKey = 'file' | 'http' | 'github';

const GITHUB_HOST_RE = /^https?:\/\/(www\.)?github\.com\//i;
const RAW_GITHUB_HOST_RE = /^https?:\/\/raw\.githubusercontent\.com\//i;

// Display-only classification. Stable across refreshes because it only
// depends on the source path. GitHub recognition is intentionally broad
// — it covers both the canonical browse URL (`github.com/.../tree/...`)
// and the raw-content host (`raw.githubusercontent.com/...`) so any
// scheme of GitHub source reads as `github` in the UI.
export function inferSourceType(path: string): SourceTypeKey {
  if (GITHUB_HOST_RE.test(path) || RAW_GITHUB_HOST_RE.test(path)) return 'github';
  if (isHttpUrl(path)) return 'http';
  return 'file';
}

// True for manifest sources of any scheme. Thin wrapper so callers
// don't have to import `directories` just for this.
export function sourceHasManifest(path: string): boolean {
  return isManifestSource(path);
}

// Bubble label / CSS-key for a source. `<type>` when not a manifest,
// `<type>-manifest` when it is. Same string powers the CSS class
// (`bubble-<key>`) and the visible text.
export function sourceBubbleKey(path: string): string {
  const t = inferSourceType(path);
  return sourceHasManifest(path) ? `${t}-manifest` : t;
}

// Fetchable / openable URL for a source — the link target the bubble
// uses. http(s) and file:// pass through; raw filesystem paths become
// file:// URLs so the anchor has a valid href (Chromium typically
// refuses to navigate to file:// from a chrome-extension page, but the
// URL is still readable + copyable).
export function sourceClickUrl(path: string): string {
  if (isHttpUrl(path) || isFileUrl(path)) return path;
  return pathToFileUrl(path);
}

// Derive a short, human-readable display name from a source path. The
// rules trim noise from the beginning, middle, and end of the link:
//   - drop the protocol prefix (https://, http://, file://)
//   - drop any `?query` tail
//   - drop a trailing `/<MANIFEST_FILENAME>` so a manifest source reads
//     as the directory that hosts it
//   - github.com / raw.githubusercontent.com get scheme-specific
//     simplifications so the common shapes read as `<owner>/<repo>`
//     or `<owner>/<repo>/<ref>/<path>` rather than the full URL
//   - trailing slashes are stripped
//
// The result is stable across refreshes (depends only on the path),
// short enough for the sources-page heading, and a reasonable seed for
// a future user-renamed displayName.
export function inferDisplayName(path: string): string {
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
  // `OnePelotoncom%20Cycle...` reads as `OnePelotoncom Cycle...`. Wrap
  // in try/catch because a malformed `%` sequence would otherwise
  // throw URIError and lose the whole inferred name; fall back to the
  // raw (still mostly-readable) form in that case.
  try {
    s = decodeURIComponent(s);
  } catch {
    /* leave the percent-encoded form */
  }
  return s;
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
// sources page display name, the viewer's Location row, the Match /
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

// Canonical sources-page anchor for a source. Lives here (not in
// sources.ts) so the viewer can link back to the right `#…` without
// reaching across pages for the helper.
export function sourceAnchorId(sourceId: string): string {
  return `source-${sourceId}`;
}

// Construct the colored type-bubble `<a>` for a source. Shared by
// the sources page (heading) and the userscript viewer (Source row)
// so the markup, classes, tooltip, and anchor target all stay in
// lockstep across both views.
export function makeSourceTypeBubble(path: string): HTMLAnchorElement {
  const key = sourceBubbleKey(path);
  const a = document.createElement('a');
  a.className = `source-type-bubble bubble-${key}`;
  a.textContent = key;
  a.href = sourceClickUrl(path);
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.title = `Open source: ${path}`;
  return a;
}

// Resolve the display name for a stored source. Prefers an explicit
// `displayName` (future user-renamed value); otherwise falls back to
// the inferred one. The very last fallback is the raw `path` so the
// UI never renders an empty string.
export function effectiveDisplayName(source: StoredSource): string {
  const stored = source.displayName?.trim();
  if (stored) return stored;
  const inferred = inferDisplayName(source.path);
  return inferred || source.path;
}
