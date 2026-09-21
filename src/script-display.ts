// Display helpers shared by the collections page, the userscript viewer,
// the script preview, and the service worker.
//
// Two groups live here: the script-status row formatting (size +
// status label) both pages render, and the name/path formatting that
// turns a stored URL into something a human wants to read. Pure
// functions — no DOM, no chrome.* calls. (`version-probe.js` is the
// pure half of the probe module; its fetching half lives in
// `version-probe-fetch.js` and is deliberately not reachable here.)

import type { StoredScript } from './script-store.js';
import { getValue, joinFullSource, type ParsedHeader } from './userscript-header.js';
import { outdatedProbe, probeLabel, type VersionProbe } from './version-probe.js';
import { describeDiagnostic } from './diagnostic-location.js';

// ---------- Names and paths ----------

// Anything of the form `<scheme>://…`. Used to decide whether
// percent-decoding is safe: URL path segments are encoded, on-disk
// names are literal.
const ABSOLUTE_URL_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

// Percent-decode for display. Never throws: a lone `%` (a literal
// percent in a filename) would make decodeURIComponent raise URIError,
// and losing the whole string is far worse than leaving one escape
// undecoded.
// Tooltip on a script's enable checkbox, wherever one is drawn: the
// collections page's per-row toggle, the viewer's controls row, and the
// "Other versions" panel. The viewer's panel appends a multi-enable hint
// to it (see `enableTitle` in related-versions.ts); everyone else shows
// it bare.
export const ENABLE_TITLE = 'Enable this script';

export function decodeForDisplay(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

// Last `/`-separated segment of a path. No decoding — callers that
// want a display form pass the result through decodeForDisplay.
export function leafName(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? path : path.slice(slash + 1);
}

// Readable form of a stored location — the string a heading, tooltip,
// or title shows. Scripts installed from the web (GreasyFork above
// all) carry their human name inside the URL path, so the stored URL
// is a wall of `%20` / `%F0%9F…`; Chrome's own omnibox shows those
// decoded and so do we.
//
// Only absolute URLs are decoded. A relativePath from a local directory
// collection is a literal on-disk name, where a `%20` really is a
// percent followed by two digits.
//
// Display only: hrefs, clipboard copies, fetches, and stored values
// all keep the encoded form.
export function displayLocation(urlOrPath: string): string {
  return ABSOLUTE_URL_RE.test(urlOrPath) ? decodeForDisplay(urlOrPath) : urlOrPath;
}

// Short display name for a script's location: the URL's filename (no
// query string, decoded), or the last path segment for an on-disk
// relativePath. Falls back to the whole input when a URL-shaped string
// won't parse or has an empty path, so the caller always has something
// to render.
//
// The second `leafName` is not redundant: an escaped `%2F` decodes to
// a real slash, and this feeds log IDs — a "basename" carrying a path
// separator would read as a directory in every log line.
export function scriptBasename(urlOrPath: string): string {
  if (!ABSOLUTE_URL_RE.test(urlOrPath)) return leafName(urlOrPath);
  try {
    return leafName(decodeForDisplay(leafName(new URL(urlOrPath).pathname))) || urlOrPath;
  } catch {
    return leafName(urlOrPath);
  }
}

// The trailing `#N` a log ID carries when several scripts share a
// basename, or '' when it's unique. Anchored to the `#<digits>` shape
// rather than the first `#` in the string: log IDs are decoded
// filenames, so a script whose URL carries a `%23` has a literal `#`
// mid-name and would otherwise render half its own name as a suffix.
export function logIdDupeSuffix(logId: string): string {
  return /#\d+$/.exec(logId)?.[0] ?? '';
}

// The name to show for a script in badges, menus, the collections list,
// and match listings: its `@name` when it declares a usable one, else
// its location in readable form. Shared so every surface labels the
// same script the same way.
//
// A whitespace-only `@name` counts as no name — a header that parsed
// but declared `// @name   ` must not paint a blank row where a name
// belongs.
//
// `fallback` lets a caller substitute its own location text (the
// collections page shortens a container script's URL to its basename);
// omitted, the whole location is used.
export function scriptDisplayName(
  script: Pick<StoredScript, 'header' | 'relativePath'>,
  fallback?: string,
): string {
  return headerDisplayName(script.header) || fallback || displayLocation(script.relativePath);
}

// The `@name` a header declares, or '' when it declares none usable.
// Split out so the viewer's heading label and every other surface agree
// on what counts as a name — a future change to the rule (a localized
// `@name:en`, different trimming) must not land in only one of them.
export function headerDisplayName(header: ParsedHeader | null | undefined): string {
  return (header ? getValue(header, 'name')?.trim() : undefined) || '';
}

// The script's `@name`, or its location when it declares no usable one.
// The location is NOT appended to a name that exists — a heading
// carrying both runs the width of the window, and the details panel's
// `Location` row is where a reader goes for the full path.
//
// `headerDisplayName`, not a local read of `@name`: the viewer must not
// disagree with the collections page about what a script is called.
export function scriptLabel(
  header: ParsedHeader | null | undefined,
  location: string,
): string {
  return headerDisplayName(header) || displayLocation(location);
}

// Lives here rather than in collection-display.ts, its first caller: this
// module is a leaf, and page-heading.ts needs the helper on the early
// path where dragging in collection-display's scan/network graph would
// undo the point of loading early.
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

// Format a byte count for the size column. Returns "1.2 KB", "950 B",
// etc. — short enough to fit comfortably alongside filename + status.
export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

// Text shown in the "Size" cell. Size is independent of status:
// `invalid` rows that retain prior content still show its byte count,
// and a 0-byte file shows "0 B" (distinct from unknown). Only rows
// that have never successfully loaded — `size == null` — render as
// "—" to signal "unknown".
export function formatScriptSize(script: Pick<StoredScript, 'status' | 'size'>): string {
  if (script.size == null) return '—';
  return formatBytes(script.size);
}

// Effective status shown to the user. Combines the persisted load
// status (`ok` / `invalid`), the `refreshError` annotation,
// and the live registration verdict with the highest log level observed
// in the per-script Log so far. Priority order:
//
//   invalid        — the script can't run (parse / fetch / dep failure)
//   rejected       — the script loaded fine, but Chrome refused the
//                    registration, so it never runs (script-rejection.ts)
//   refresh-failed — running fine on its cached copy, but the latest
//                    refresh failed (unreachable collection, or a fetched
//                    copy that wasn't a valid script)
//   outdated       — running fine and up to date with its own collection,
//                    but an `@updateURL` / `@downloadURL` elsewhere
//                    declares a newer `@version` (see version-probe.ts)
//   error          — script loaded fine but its Log has an error entry
//   warning        — script loaded fine but its Log has a warning entry
//   ok             — no logs, or only info-level logs
//
// `invalid` / `rejected` always win because "can't run" is the most
// actionable surface. (The two can't co-occur — an invalid script is
// never offered to Chrome.)
// `refresh-failed` and `outdated` rank above the Log-derived levels for
// the same reason: both are specific facts about the update pipeline
// that have no other surface in the collections list, whereas the
// running script's own runtime errors still show up in the Log tab
// regardless. `refresh-failed` outranks `outdated` because a collection
// we can't reach at all subsumes "some other copy is ahead".
export type DisplayStatus =
  | 'ok' | 'invalid' | 'rejected'
  | 'refresh-failed' | 'outdated' | 'warning' | 'error';

// The states a Log entry can record moving a script into (see
// `LogEntry.state` in script-log.ts): everything above except
// `warning` / `error`, which are *derived from* the Log's max level and
// so can't be the state an entry announces.
export type LoadState = Exclude<DisplayStatus, 'warning' | 'error'>;
export const LOAD_STATES: readonly LoadState[] =
  ['ok', 'invalid', 'rejected', 'refresh-failed', 'outdated'];
export function isLoadState(value: unknown): value is LoadState {
  return (LOAD_STATES as readonly unknown[]).includes(value);
}

export type LogLevelForStatus = 'info' | 'warning' | 'error';

// `outdated` and `rejected` come in as caller-computed flags rather
// than being derived here: neither lives on the script row (one is a
// version probe, the other is session state the injector writes), and
// the collections page's repaint path rebuilds status cells from DOM
// datasets with no script row in hand. Both callers read `outdated`
// from `scriptOutdatedProbe` below and `rejected` from the shared
// rejection map, so the two surfaces can't drift.
export function effectiveScriptStatus(
  script: Pick<StoredScript, 'status' | 'refreshError'>,
  maxLogLevel: LogLevelForStatus | undefined,
  outdated = false,
  rejected = false,
): DisplayStatus {
  if (script.status === 'invalid') return 'invalid';
  if (rejected) return 'rejected';
  if (script.refreshError) return 'refresh-failed';
  if (outdated) return 'outdated';
  if (maxLogLevel === 'error') return 'error';
  if (maxLogLevel === 'warning') return 'warning';
  return 'ok';
}

// The probe (if any) saying an upstream copy is ahead of the version we
// hold. Null whenever nothing is ahead, nothing was probed, or either
// side has no `@version` to compare.
export function scriptOutdatedProbe(
  script: Pick<StoredScript, 'header' | 'versionProbes'>,
): VersionProbe | null {
  const loadedVersion = script.header ? getValue(script.header, 'version') : undefined;
  return outdatedProbe(loadedVersion, script.versionProbes);
}

// Text shown in the "Status" cell. REJECTED means the script is fine but Chrome refused to register it. REFRESH
// FAILED means the script still runs from its cached copy but the last
// update attempt failed. OUTDATED means a newer version exists at a URL
// we deliberately don't update from. WARNING / ERROR mean the script
// loaded fine but its Log carries entries at that level (see
// `effectiveScriptStatus`).
export function formatScriptStatusLabel(status: DisplayStatus): string {
  switch (status) {
    case 'ok': return 'OK';
    case 'invalid': return 'INVALID';
    case 'rejected': return 'REJECTED';
    case 'refresh-failed': return 'REFRESH FAILED';
    case 'outdated': return 'OUTDATED';
    case 'warning': return 'WARNING';
    case 'error': return 'ERROR';
  }
}

// The viewer URL for a stored script, optionally landing on its Log
// pane. Shared by every in-page surface that links to or navigates to
// a script, so none of them can drift on how the tab is addressed.
//
// Page-relative, not the absolute `chrome.runtime.getURL(...)` form:
// every extension page lives at the extension root, so the browser
// resolves it against the current page, and the long
// `chrome-extension://<id>/` prefix stays out of a table that can hold
// hundreds of rows with two links each. The service worker builds the
// absolute form instead (`viewerUrlForScript` in background.ts)
// because it has no page to be relative to.
export function viewerUrl(scriptId: string, tab?: 'log'): string {
  const params = new URLSearchParams({ script: scriptId });
  // The viewer parses `#Log` via parseHash and lands on the Log pane.
  return `userscript.html?${params.toString()}${tab === 'log' ? '#Log' : ''}`;
}

// The compare page for two copies of a script (src/compare.ts). The
// right-hand side is the base: the copy on screen, or the download a
// preview is showing; `other` is the copy to hold up against it.
export function compareUrl(
  base: { script: string } | { preview: string },
  other: string,
): string {
  const params = new URLSearchParams(
    'script' in base ? { script: base.script } : { preview: base.preview },
  );
  params.set('other', other);
  return `compare.html?${params.toString()}`;
}

// The install-preview URL for a location the user typed or pasted.
// Page-relative for the same reason `viewerUrl` is; callers that need
// the absolute form wrap it in `chrome.runtime.getURL`.
export function previewUrl(location: string): string {
  return `userscript.html?preview=${encodeURIComponent(location)}`;
}

// Everything a Status cell shows about one stored script: the
// effective status, the word for it, and the hover text explaining
// whichever verdict won.
export interface ScriptStatusView {
  status: DisplayStatus;
  label: string;
  // Absent when there is nothing to add — an OK script with no logs
  // has no explanation to give.
  title?: string;
}

// What a script's Status cell should say. The label follows
// `effectiveScriptStatus`; the hover text follows whatever the cell is
// actually showing — Chrome's rejection reason, the refresh-failure
// reason, the newer version found upstream, or the load error.
//
// Shared by the viewer's own Status row and the "Other versions"
// panel's Status column, which would otherwise explain the same
// verdict two ways. The collections page keeps its own copy of this
// logic: its repaint path rebuilds status cells from DOM datasets with
// no script row in hand, which is exactly what this takes.
export function scriptStatusView(
  script: Pick<
    StoredScript,
    'status' | 'refreshError' | 'errorMessage' | 'errorLocation' | 'header' | 'versionProbes'
  >,
  maxLogLevel: LogLevelForStatus | undefined,
  rejection: string | undefined,
): ScriptStatusView {
  const outdated = scriptOutdatedProbe(script);
  const status = effectiveScriptStatus(
    script, maxLogLevel, outdated !== null, rejection !== undefined,
  );
  return { status, label: formatScriptStatusLabel(status), title: statusTitle() };

  function statusTitle(): string | undefined {
    if (status === 'rejected' && rejection) return rejection;
    if (status === 'refresh-failed') return script.refreshError;
    if (status === 'outdated' && outdated) {
      return `Version ${outdated.version} at ${probeLabel(outdated.kinds)}: ${outdated.url}`;
    }
    if (script.errorMessage) return describeDiagnostic(script.errorMessage, script.errorLocation);
    return undefined;
  }
}

// Drop a Subresource Integrity fragment from a `@require` / `@resource`
// reference, for DISPLAY only.
//
// Lives here rather than in `file-loader.ts` (which owns resolution and
// fetching) precisely because loading must never use it — it sits
// beside `displayLocation`, the other transform every human-facing URL
// goes through.
//
// Tampermonkey carries the expected hash in the URL fragment, as a
// comma-separated list of `<algo>=<hex>` or `<algo>-<base64>` parts:
//
//   @require https://example.com/lib.js#sha256=e3b0c44298fc1c149…
//   @require https://example.com/lib.js#md5=abc,sha256=def
//
// A 64-hex-digit tail is most of the width of a tooltip or a details
// row and tells the reader nothing they can act on, so every surface
// that shows a ref to a human strips it. Fetching, resolution, dedup,
// storage, and error messages all keep the verbatim form — an error
// should name what the author actually wrote.
//
// Only stripped when EVERY comma-separated part looks like a hash
// declaration. An ordinary fragment (`#section`) is content the author
// meant, so it survives; a malformed hash tail survives too, which is
// the right way round — a reader wondering why validation didn't happen
// needs to see what they typed.
//
// SourceMonkey does not yet validate these hashes; see TODO.md.
const SRI_PART_RE = /^(?:md5|sha1|sha256|sha384|sha512)[=-]\S+$/i;

export function stripSriFragment(urlOrRef: string): string {
  const hash = urlOrRef.indexOf('#');
  if (hash < 0) return urlOrRef;
  const fragment = urlOrRef.slice(hash + 1);
  if (!fragment) return urlOrRef;
  if (!fragment.split(',').every((part) => SRI_PART_RE.test(part))) return urlOrRef;
  return urlOrRef.slice(0, hash);
}

// A stored script's text as it was on disk, rebuilt from the stored
// split: what is above the header, the header, the body. The same
// string the injector splices into the registered code, so the viewer's
// main tab line N matches the file's line N AND the injected line N
// (modulo any @require sections that sit before the main script). The
// compare page diffs this too.
export function fullSource(script: StoredScript): string {
  return joinFullSource(
    script.leadingText ?? '',
    script.headerText ?? '',
    script.bodyText,
  );
}

// Pull a display basename off a require's resolved URL. Falls back to
// the verbatim ref if URL parsing fails — won't happen for entries we
// stored (the resolver wouldn't have accepted the URL otherwise), but
// the fallback keeps a future shape change from breaking the tab UI.
// Not `scriptBasename`: that one falls back to the whole URL, and a
// require tab labeled with a full CDN URL would wreck the tab strip.
export function requireBasename(url: string, ref: string): string {
  let name: string;
  try {
    name = leafName(new URL(url).pathname);
  } catch {
    return ref;
  }
  return name ? decodeForDisplay(name) : ref;
}
