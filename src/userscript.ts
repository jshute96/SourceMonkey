// Userscript viewer. Loaded as chrome-extension://…/userscript.html in
// one of two modes, chosen by the query string:
//
//   ?script=<scriptId>  — an installed script. Hydrates from the
//                         persistent store (chrome.storage.local)
//                         rather than re-reading the file, so the
//                         content always matches what the sources page
//                         shows.
//   ?preview=<url>      — a script that is NOT installed (yet). Fetches
//                         it, shows exactly the same panels, and offers
//                         Install / Update. This is where a captured
//                         `.user.js` navigation lands (see
//                         `install-capture.ts`) and where the sources
//                         page sends a single-file Add Source.
//
// Both modes render: a heading (favicon + location), a controls row,
// the details panel (`script-details.ts`), and the tabbed code view
// (`code-tabs.ts`). Preview swaps the Enable/Refresh controls for the
// install actions and has no Log tab; installed scripts have no
// install actions.
//
// The page never runs the code it shows. Bodies are rendered as text
// through Prism; the grammar extension that tints the metadata block
// lives in `prism-userscript.ts`, pulled in by `code-tabs.ts` — the
// module that actually calls `Prism.highlightElement`.
//
// See [docs/script-viewer.md] and [docs/install-capture.md].

import {
  addSource,
  buildScriptFromText,
  describeError,
  distillMatching,
  getAllScripts,
  getScript,
  getSource,
  isScriptEnabled,
  isSourceEnabled,
  setScriptEnabled,
  validateHeader,
  type StoredScript,
  type StoredSource,
} from './script-store.js';
import { computeLogIds } from './script-log-id.js';
import {
  attachFiles,
  distillRequires,
  fetchRequireForPreview,
  type FileFetchCache,
  type StoredRequire,
} from './external-files.js';
import {
  clearScriptLog,
  getMaxLogLevel,
  getScriptLog,
  type LogEntry,
  type LogLevel,
} from './script-log.js';
import { updateScript } from './script-updater.js';
import {
  decodeForDisplay,
  displayLocation,
  effectiveScriptStatus,
  formatBytes,
  formatScriptSize,
  formatScriptStatusLabel,
  leafName,
  scriptBasename,
  scriptOutdatedProbe,
} from './script-display.js';
import { probeLabel } from './version-probe.js';
import {
  getValue,
  joinFullSource,
  parseHeader,
  splitHeaderBody,
  type ParsedHeader,
} from './userscript-header.js';
import {
  canonicalSourceInput,
  fetchFileUrlText,
  fetchHttpText,
  isFileUrl,
  isHttpUrl,
  normalizeSourceInput,
  scriptAbsolutePath,
  sourceCanonicalUrl,
} from './directories.js';
import { appendWithSlashBreaks } from './source-display.js';
import { renderSiteIconInto } from './site-icon.js';
import { resolveScriptResource } from './file-loader.js';
import {
  installGithubAuthListener,
  loadGithubAuthToken,
} from './github-auth.js';
import { markInstallBypass, needsDownloadWorkaround } from './install-capture.js';
import { isFileSchemeAccessAllowed, renderFileAccessBanner } from './file-access.js';
import { checkScriptParses, installPageParseChecker } from './parse-check-client.js';
import { describeParseError } from './parse-location.js';
import { dlog } from './debug-log.js';
import { dropRawView, putRawView } from './raw-view.js';
import { displayRefText, parseStackRefs } from './stack-link.js';
import { remapStackRef, type MappedSegment, type StackRef } from './source-map.js';
import { USER_SOURCE_START_LINE, composeSource } from './composed-source.js';
import { buildRequireSourceUrl, buildSourceUrl } from './script-source-url.js';
import { CodeTabsView, type CodeTab } from './code-tabs.js';
import { renderDetails } from './script-details.js';

// Install and Refresh run the load pipeline here in the page, so this
// page needs its own parse checker — without one, Install would store
// an unparsable script as `ok` and Refresh would clear an `invalid`
// verdict it never re-derived. See src/parse-check-client.ts.
installPageParseChecker();

// Refresh (installed) and the preview fetch both run in the page
// context, so the page needs its own copy of the cached GitHub token.
// Both handlers await it before issuing a fetch so an early click
// can't go out unauthenticated.
installGithubAuthListener();
const githubTokenReady = loadGithubAuthToken();

const params = new URLSearchParams(location.search);
const scriptId = params.get('script');
// The location to preview, exactly as it arrived: the URL the user
// clicked (for a captured navigation) or typed (for Add Source). See
// the preview-mode section below for the normalized forms derived
// from it.
const previewInput = params.get('preview');

const filenameEl = document.getElementById('filename')!;
const controlsRowEl = document.getElementById('meta-row')!;
const enableLabelEl = document.getElementById('enable-label') as HTMLLabelElement;
const enableCheckboxEl = document.getElementById('enable-checkbox') as HTMLInputElement;
const refreshBtn = document.getElementById('refresh-btn') as HTMLButtonElement;
const bannerSlotEl = document.getElementById('banner-slot')!;
const actionsEl = document.getElementById('preview-actions')!;
const installBtn = document.getElementById('install-btn') as HTMLButtonElement;
const openBtn = document.getElementById('open-btn') as HTMLButtonElement;
const updateBtn = document.getElementById('update-btn') as HTMLButtonElement;
const continueBtn = document.getElementById('continue-btn') as HTMLButtonElement;
const cancelBtn = document.getElementById('cancel-btn') as HTMLButtonElement;
const viewSourceBtn = document.getElementById('view-source-btn') as HTMLButtonElement;
const messageEl = document.getElementById('message')!;
const summaryEl = document.getElementById('header-summary')!;
const tabsEl = document.getElementById('tabs')!;
const contentEl = document.getElementById('content')!;
const codePaneEl = document.getElementById('code-pane') as HTMLElement;
const logPaneEl = document.getElementById('log-pane') as HTMLElement;

const tabsView = new CodeTabsView(
  { tabsEl, codePaneEl, contentEl, logPaneEl },
  { onShowLog: () => void renderLogPane() },
);

refreshBtn.addEventListener('click', () => void onRefresh());
enableCheckboxEl.addEventListener('change', () => void onToggleEnabled(enableCheckboxEl.checked));

// Static markup for the Lucide-style copy / check icons. Safe to embed
// via innerHTML because there's no interpolation; the strings ship as
// part of the extension bundle.
const COPY_ICON_SVG =
  '<svg class="copy-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
  ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>' +
  '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>' +
  '</svg>';
const CHECK_ICON_SVG =
  '<svg class="check-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
  ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<polyline points="20 6 9 17 4 12"/>' +
  '</svg>';

// One shared copy button: created once, appendChild'd into the dl on
// each render (appendChild moves it, so no duplication). Keeping it
// shared means we don't have to re-wire the click handler.
const filenameCopyBtn = (() => {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'copy-btn';
  btn.title = 'Copy location to clipboard';
  btn.setAttribute('aria-label', 'Copy location to clipboard');
  btn.innerHTML = COPY_ICON_SVG + CHECK_ICON_SVG;
  btn.addEventListener('click', () => void onCopyFilename());
  return btn;
})();

// Whether the per-extension "Allow access to file URLs" toggle is on.
// Probed once per page rather than per failure: the toggle lives on
// chrome://extensions and flipping it doesn't reach an already-open
// page, so the answer can't change under us. Caching it also keeps the
// "was it the toggle?" question answerable from the synchronous render
// path.
//
// Fired at module scope rather than inside `load()` so it runs
// alongside the rest of module init and is normally already settled by
// the time anything awaits it. This is on every viewer open, including
// the http scripts that can never need the answer, so it should not be
// the thing first paint waits on.
const fileAccessProbe = isFileSchemeAccessAllowed();
let fileAccessAllowed = true;

void load();

async function load(): Promise<void> {
  fileAccessAllowed = await fileAccessProbe;
  if (scriptId) {
    await loadStored();
    return;
  }
  if (previewInput) {
    await loadPreview();
    return;
  }
  showMissing('Missing `script` or `preview` query parameter.');
}

// ---------- Installed-script mode ----------

// Keep the displayed Log ID in sync with the global dupe set: if
// another tab (sources page, viewer of a sibling) adds or removes a
// script that shares this basename, our `#N` would otherwise go
// stale. Listen for any script:* mutation and re-derive.
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (!scriptId) return;
  if (areaName === 'local') {
    let touched = false;
    for (const key of Object.keys(changes)) {
      if (key.startsWith('script:')) { touched = true; break; }
    }
    if (touched) void rehydrateAfterStorageChange();
    return;
  }
  if (areaName === 'session') {
    // Track THIS script's max-log-level row so the Status cell ramps
    // to WARNING / ERROR (or back down to OK) as entries arrive or
    // the log is cleared. Independent of the log-pane repaint below
    // because the Status row is visible on every tab.
    const levelKey = `loglevel:${scriptId}`;
    if (levelKey in changes) {
      const nextLevel = changes[levelKey]?.newValue;
      currentLogLevel = (nextLevel === 'info' || nextLevel === 'warning' || nextLevel === 'error')
        ? nextLevel
        : undefined;
      if (currentScript) repaintStatusRow(currentScript);
    }
    // Repaint the log pane only when THIS script's log changed and the
    // user is currently looking at it — the pane is hidden behind a
    // code tab the rest of the time, so we'd just be doing work the
    // user can't see.
    const logKey = `log:${scriptId}`;
    if (!(logKey in changes)) return;
    if (logPaneEl.hidden) return;
    const newValue = changes[logKey].newValue;
    const entries = Array.isArray(newValue) ? (newValue as LogEntry[]) : [];
    // Bump the paint epoch so an in-flight renderLogPane() read from
    // before this event can't overwrite us with its (now stale) array.
    logPaintEpoch++;
    paintLog(entries);
  }
});

// Swap the Status row's inner content without rebuilding the rest of
// the details panel — the row sits inside a <dl> we don't want to
// thrash on every log append. Find the existing meta-status anchor
// (or any node carrying the class) and replace it with a freshly
// computed one.
function repaintStatusRow(script: StoredScript): void {
  const prior = summaryEl.querySelector('.meta-status');
  if (!prior) return;
  prior.replaceWith(buildStatusCell(script));
}

async function rehydrateAfterStorageChange(): Promise<void> {
  if (!scriptId) return;
  // If THIS script was removed, drop into the not-found state.
  const script = await getScript(scriptId);
  if (!script) {
    showMissing('Script not found in storage. Open it from the sources page.');
    return;
  }
  await refreshLogId();
  render(script);
  // render() wipes the flash overlay via `textContent =` and may
  // have clamped the tab index to 0 if a require disappeared.
  // Re-anchor highlight + URL without scrolling the code pane.
  tabsView.applyHash(false);
}

// Source-enabled state is needed for greying the toggle. We cache it so
// onToggle doesn't have to re-read storage. sourcePath is cached for
// the same reason — render() builds the absolute filename from it.
// sourceRow holds the whole StoredSource (when found) so the Source
// row can render its bubble + display name without a second read.
let sourceEnabled = true;
let sourcePath = '';
let sourceRow: StoredSource | null = null;
let copyResetTimer: ReturnType<typeof setTimeout> | null = null;
// Path currently shown in the Location cell. onCopyFilename copies
// this rather than reading textContent, which would also break if the
// dl ever wraps the path across multiple text nodes.
let currentFilenamePath = '';
// This script's log ID. Computed at load(), re-derived after refresh,
// and kept fresh while the viewer is open by listening to
// chrome.storage.onChanged for any script:* mutation (another tab
// adding/removing a sibling with the same basename would otherwise
// leave a stale `#N` on screen).
let currentLogId = '';

// The injected entry's line layout, recomputed whenever the tab strip
// is rebuilt, plus the sourceURL every frame from that entry carries.
// Together they let the Log tab map a generated stack line back to the
// `@require` (or body) it was written in — see `remapLogRef`. Empty
// segments mean "nothing to undo": either the script has no
// `@require`s, or we're in preview mode with nothing injected at all.
let stackSegments: readonly MappedSegment[] = [];
let stackEntryUrl = '';
// Identity of the script state `stackSegments` was computed from, so a
// re-render for an unrelated reason doesn't redo the concatenation.
let stackLayoutKey = '';
// Most recently rendered script. The session-storage listener calls
// paintLog without re-reading the script, so we capture the latest
// here so log-pane linkification can consult the tab list without
// re-reading storage.
let currentScript: StoredScript | null = null;
// Highest level any log entry has carried so far for this script.
// Used to promote the Status row to WARNING / ERROR. Refreshed on
// load and from the storage.session.onChanged listener so the Status
// row tracks the Log pane without a full re-render.
let currentLogLevel: LogLevel | undefined;

async function loadStored(): Promise<void> {
  if (!scriptId) return;
  const script = await getScript(scriptId);
  if (!script) {
    showMissing('Script not found in storage. Open it from the sources page.');
    return;
  }
  const source = await getSource(script.sourceId);
  sourceEnabled = source ? isSourceEnabled(source) : true;
  sourcePath = source?.path ?? '';
  sourceRow = source ?? null;
  await refreshLogId();
  // Hydrate the max log level before render() so the first paint of
  // the Status row already reflects WARNING / ERROR. Without this the
  // row would briefly show OK and then flip when the storage listener
  // fires.
  currentLogLevel = await getMaxLogLevel(scriptId);

  render(script);
  // The tab view seeds its own selection from `location.hash` on the
  // first setTabs(); this applies the line highlight and normalizes
  // the URL.
  tabsView.applyHash(true);
}

async function refreshLogId(): Promise<void> {
  if (!scriptId) return;
  const all = await getAllScripts();
  const map = computeLogIds(all);
  currentLogId = map.get(scriptId) ?? '';
}

async function onRefresh(): Promise<void> {
  if (!scriptId) return;
  refreshBtn.disabled = true;
  const prior = refreshBtn.textContent;
  refreshBtn.textContent = 'Refreshing…';
  try {
    // Wait for the GitHub token cache to hydrate first; otherwise a
    // very fast Refresh click can fire before chrome.storage.local
    // has resolved and the fetch goes out unauthenticated.
    await githubTokenReady;
    // Routed through the shared updater: if a background opportunistic
    // check is already in flight for this script, we wait for it
    // instead of starting a second fetch.
    // 'force': this is a real Refresh click, so check upstream now
    // rather than waiting out the probe interval.
    const next = await updateScript(scriptId, 'manual', 'force');
    if (next) {
      await refreshLogId();
      render(next);
      // Re-anchor highlight + URL after the repaint. Scroll skipped so
      // a Refresh doesn't yank the user's scroll position.
      tabsView.applyHash(false);
    }
  } finally {
    refreshBtn.disabled = false;
    refreshBtn.textContent = prior ?? 'Refresh';
  }
}

async function onToggleEnabled(enabled: boolean): Promise<void> {
  if (!scriptId) return;
  const next = await setScriptEnabled(scriptId, enabled);
  if (next) {
    render(next);
    tabsView.applyHash(false);
  }
}

async function onCopyFilename(): Promise<void> {
  if (!currentFilenamePath) return;
  try {
    // Copies the raw location, not the decoded form the row displays:
    // a pasted URL has to still work when it goes into a terminal, an
    // address bar, or the Add Source field.
    await navigator.clipboard.writeText(currentFilenamePath);
    // .copied swaps the visible icon to a checkmark via CSS. A fresh
    // timer per click keeps rapid double-clicks from leaving the
    // checkmark stuck — each new click cancels the prior reset and
    // schedules its own.
    filenameCopyBtn.classList.add('copied');
    if (copyResetTimer !== null) clearTimeout(copyResetTimer);
    copyResetTimer = setTimeout(() => {
      filenameCopyBtn.classList.remove('copied');
      copyResetTimer = null;
    }, 1200);
  } catch {
    // Clipboard write can be rejected (e.g. permission denied); the
    // path is selectable on the page, so no fallback UI is needed.
  }
}

function render(script: StoredScript): void {
  currentScript = script;
  controlsRowEl.hidden = false;
  renderHeading(displayLocation(script.relativePath), script);
  document.title = `${displayLocation(script.relativePath)} — SourceMonkey`;

  enableCheckboxEl.checked = isScriptEnabled(script);
  enableCheckboxEl.disabled = !sourceEnabled;
  enableLabelEl.classList.toggle('toggle-disabled', !sourceEnabled);
  enableLabelEl.title = sourceEnabled
    ? 'Enable this script'
    : 'Source is disabled';

  // The banner shows the load error for `invalid` rows, and the
  // refresh-failure reason for a still-running `refresh-failed` row
  // (status `ok` + `refreshError`) — so opening a flagged script always
  // explains why. `errorMessage` takes precedence (it means the script
  // can't run at all); `refreshError` is the softer "running on a cached
  // copy, last update failed" case.
  if (script.errorMessage) {
    setMessage(script.errorMessage, 'error');
  } else if (script.refreshError) {
    setMessage(`Refresh failed: ${script.refreshError}`, 'refresh-failed');
  } else {
    setMessage('');
  }

  // Same question the preview asks after a failed fetch, for the same
  // reason: a local script we couldn't read has most likely hit the
  // file-access toggle. Cleared first because `render` re-runs on every
  // storage change — the banner must not outlive the error that raised
  // it (a Refresh that succeeds clears `refreshError`).
  //
  // Reload is the wrong advice here: this row is already in storage, so
  // re-opening the page re-renders the same cached copy and the same
  // error. Refresh is what re-reads.
  bannerSlotEl.replaceChildren();
  if (readFailed(script)) {
    showFileAccessBannerIfBlocked(script.fileUrl, 'then click Refresh');
  }

  // Resolved location for the script: an absolute filesystem path for
  // file:// sources, the github page URL for github sources, or the
  // resolved URL for non-github HTTP sources. Skip the row entirely if
  // the source row is gone — a bare relative path under a "Location"
  // label would be misleading.
  currentFilenamePath = sourcePath
    ? scriptAbsolutePath(sourcePath, script.relativePath)
    : '';

  // Anchor href: for file:// sources we use the file:// URL (the
  // display string is the bare fs path, not navigable). For everything
  // else display = href, so the user clicks the same URL they'd copy
  // from the row.
  const locationHref = isFileUrl(script.fileUrl) ? script.fileUrl : currentFilenamePath;
  renderDetails(summaryEl, {
    header: script.header,
    logId: currentLogId,
    source: sourceRow,
    location: currentFilenamePath
      ? {
          text: displayLocation(currentFilenamePath),
          href: locationHref,
          trailing: filenameCopyBtn,
          // This href is a `.user.js` URL for nearly every installed
          // script, so a plain navigation would be captured and land
          // the user in a preview of the script they are already
          // looking at. Open it the same way the preview does: bypass
          // first, then a new tab. (A github source's blob URL ends in
          // `.user.js` too, and is an HTML page, so it would land on
          // the "not an installable userscript" banner.)
          onActivate: () => navigateRaw(locationHref),
        }
      : undefined,
    size: formatScriptSize(script),
    status: buildStatusCell(script),
    versionProbes: script.versionProbes,
  });

  tabsView.setTabs(storedTabs(script));
}

// Tab strip for an installed script: main + one per `@require`, then
// the Log tab (always last so the file order stays stable as
// `@require`s come and go).
function storedTabs(script: StoredScript): CodeTab[] {
  // currentLogId is the dedup-aware label the injector uses to build
  // sourceURLs (see script-source-url.ts). Falls back to the bare
  // basename if the log-id sweep hasn't run yet — same default the
  // injector uses, so the two stay in lockstep.
  const label = currentLogId || scriptBasename(script.relativePath);
  const mainSourceUrl = buildSourceUrl(label);
  const requireSourceUrls = (script.requires ?? []).map(
    (r) => buildRequireSourceUrl(label, r.url),
  );
  // Re-derive the injected entry's line layout so the Log tab can undo
  // it — see `resolveLogRef`. Same shared `composeSource` the injector
  // runs, given the same URLs and the same start line, so the segments
  // are the ones the registered entry's source map was built from.
  //
  // Memoised: this concatenates every `@require` body with the script
  // to find the offsets, then discards the text. Renders fire on any
  // `script:*` storage mutation, and a script with a couple of MB of
  // libraries would redo that work behind unrelated events. The
  // layout only changes when the body does, which is exactly what
  // `loadedAt` tracks.
  const layoutKey = `${script.id}@${script.loadedAt}:${label}`;
  if (layoutKey !== stackLayoutKey) {
    stackLayoutKey = layoutKey;
    stackSegments = composeSource(script, {
      requireUrls: requireSourceUrls,
      mainUrl: mainSourceUrl,
      startLine: USER_SOURCE_START_LINE,
    }).segments;
  }
  stackEntryUrl = mainSourceUrl;
  const tabs: CodeTab[] = [{
    kind: 'code',
    label: scriptBasename(script.relativePath),
    body: buildMainTabBody(script),
    fileUrl: script.fileUrl,
    sourceUrl: mainSourceUrl,
  }];
  for (const [i, r] of (script.requires ?? []).entries()) {
    tabs.push({
      kind: 'code',
      label: requireBasename(r.url, r.ref),
      body: r.source,
      // fileUrl is the original fetched URL (for display so the user
      // sees the real provenance); sourceUrl is the synthetic
      // sourcemonkey:// URL for this require.
      //
      // The injector builds the same URL (`buildRequireSourceUrl` with
      // the same label) for the require's entry in the combined
      // entry's source map, so devtools' file and this tab agree.
      //
      // Raw stack frames never carry this URL — under Mode A (see
      // docs/injection-modes.md) V8 tags every frame in the combined
      // entry with the script's own sourceURL. `stackSegments` below
      // is what turns such a frame back into a ref at this URL, which
      // is what lets the Log tab linkify to this tab.
      fileUrl: r.url,
      sourceUrl: requireSourceUrls[i],
    });
  }
  tabs.push({ kind: 'log', label: 'Log' });
  return tabs;
}

// Reconstruct the original on-disk source from the stored split.
// Same string the injector splices into the registered code, so the
// viewer's main tab line N matches the file line N AND injected line
// N (modulo any @require sections that sit before the main script).
function buildMainTabBody(script: StoredScript): string {
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
function requireBasename(url: string, ref: string): string {
  let name: string;
  try {
    name = leafName(new URL(url).pathname);
  } catch {
    return ref;
  }
  return name ? decodeForDisplay(name) : ref;
}

// Build the Status row content: an anchor whose href is `#Log` so
// clicking switches the viewer to the Log tab via the regular
// hashchange listener. Labeled with the effective status (INVALID /
// MISSING / OUTDATED / ERROR / WARNING / OK) computed against the
// current log level.
function buildStatusCell(script: StoredScript): Node {
  const outdated = scriptOutdatedProbe(script);
  const effective = effectiveScriptStatus(
    { status: script.status, refreshError: script.refreshError },
    currentLogLevel,
    outdated !== null,
  );
  const link = document.createElement('a');
  link.href = '#Log';
  link.textContent = formatScriptStatusLabel(effective);
  link.className = `meta-status status-${effective}`;
  // Hover text follows whatever the cell is showing: the refresh-failure
  // reason, the newer version found upstream, or the load errorMessage.
  const title = effective === 'refresh-failed'
    ? script.refreshError
    : effective === 'outdated' && outdated
      ? `Version ${outdated.version} at ${probeLabel(outdated.kinds)}: ${outdated.url}`
      : script.errorMessage;
  if (title) link.title = title;
  return link;
}

// ---------- Preview mode ----------

// Three spellings of one location, all needed:
//
//   previewInput     — verbatim from the query string. For an http(s)
//                      capture this is the URL the browser was about to
//                      navigate to, so it's what a bypass is keyed on.
//   previewLocation  — `normalizeSourceInput` then
//                      `canonicalSourceInput`: a github.com blob URL
//                      rewritten to its raw form, a `file://` URL
//                      collapsed to its bare path, a local path left
//                      alone. Exactly what `addSource` would store as
//                      `relativePath`, so it's what the
//                      already-installed check compares, and what the
//                      Location row displays.
//   previewFileUrl   — the fetchable form of the above: a bare local
//                      path becomes `file://…`. Used for the fetch, for
//                      resolving `@require` refs, and as link hrefs.
let previewLocation = '';
let previewFileUrl = '';
// The fetched body, kept so "View raw source" can hand it to a new tab
// without a second round-trip. Empty until the fetch lands.
let previewText = '';
let previewHeader: ParsedHeader | null = null;
// Per-page cache shared by every lazily-loaded `@require` tab, so
// re-opening a tab (or two refs pointing at one URL) fetches once.
// It memoizes failures too, so a require that failed once replays its
// error for the life of the page rather than silently re-hitting the
// host on every tab click; reload to retry.
const previewFetchCache: FileFetchCache = new Map();
// Session keys backing raw-view tabs, all dropped when this page goes
// away. A set rather than a single key because each click opens its own
// tab, and two clicks can be in flight at once.
const rawViewKeys = new Set<string>();

async function loadPreview(): Promise<void> {
  const input = previewInput ?? '';
  controlsRowEl.hidden = true;
  actionsEl.hidden = false;
  cancelBtn.addEventListener('click', leavePage);
  viewSourceBtn.addEventListener('click', openRawSource);

  setMessage('Loading…');
  await githubTokenReady;

  let text: string;
  try {
    // Check the shape before canonicalizing: `sourceCanonicalUrl`
    // turns anything that isn't already http(s)/file:// into a
    // file:// URL, so an `ftp://…` param would otherwise fail with a
    // baffling `file:///ftp%3A//…` error instead of being named.
    if (!isPreviewableInput(input)) {
      throw new Error('not an http(s):// or file:// URL, or an absolute path');
    }
    // Same canonicalization `addSource` runs, so what the
    // already-installed check compares is exactly what installing
    // would store. A no-op for http(s); a plain POSIX `file://` URL
    // collapses to its bare path.
    previewLocation = canonicalSourceInput(await normalizeSourceInput(input));
    previewFileUrl = sourceCanonicalUrl(previewLocation);
    text = await fetchPreviewText(previewFileUrl);
  } catch (err) {
    // Keep the heading and the action row: the location is still worth
    // showing, and "View raw source" is a real retry — that navigation
    // carries cookies the extension's fetch doesn't.
    renderHeading(displayLocation(previewLocation || input), {
      matching: { matches: [] },
      header: null,
      fileUrl: previewFileUrl || input,
    });
    document.title = `${displayLocation(previewLocation || input)} — SourceMonkey`;
    setMessage(`Could not fetch this script: ${describeError(err)}`, 'error');
    // The likeliest reason a local file wouldn't read. `previewFileUrl`
    // is still '' if normalizeSourceInput is what threw, which is
    // correctly not a file:// URL — we never got as far as a read.
    showFileAccessBannerIfBlocked(previewFileUrl);
    summaryEl.replaceChildren();
    tabsView.clear();
    installBtn.hidden = true;
    // A fetch that failed for a location we already hold a copy of is
    // exactly when the user wants to reach the copy that works. Only
    // meaningful once we know the normalized location — if
    // normalizeSourceInput is what threw, there's nothing to match on.
    if (previewLocation) void offerOpenExisting();
    return;
  }

  setMessage('');
  previewText = text;
  renderPreview(text);
}

// Shapes we know how to preview, checked against the raw input. Mirrors
// what the sources page's Add field accepts for a single script: an
// http(s) or file:// URL, or an absolute local path.
function isPreviewableInput(input: string): boolean {
  return isHttpUrl(input) || isFileUrl(input) || input.startsWith('/');
}

// Fetch the text to preview. By this point the location has been
// canonicalized, so it is http(s) or file:// — the two shapes a
// single-file source can take.
async function fetchPreviewText(url: string): Promise<string> {
  if (isFileUrl(url)) return fetchFileUrlText(url);
  const result = await fetchHttpText(url);
  // `unchanged` needs a conditional request to happen, and we send
  // none — but the type includes it, so fail loudly rather than
  // rendering an empty page if that ever changes.
  if (result.kind !== 'ok') throw new Error('no content returned');
  return result.text;
}

function renderPreview(text: string): void {
  previewHeader = parseHeader(text);

  renderHeading(displayLocation(previewLocation), {
    matching: distillMatching(previewHeader),
    header: previewHeader,
    fileUrl: previewFileUrl,
  });
  document.title = `${displayLocation(previewLocation)} — SourceMonkey`;

  // Same split as the installed viewer's Location row: the bare fs path
  // reads better for a local file, but only the file:// URL is a usable
  // href, and the copy button hands over the raw form either way.
  currentFilenamePath = previewLocation;
  renderDetails(summaryEl, {
    header: previewHeader,
    location: {
      text: displayLocation(previewLocation),
      href: previewFileUrl,
      trailing: filenameCopyBtn,
      // Navigating this href for real would be captured straight back
      // into a second preview of the same script (or, on Chrome ≤ 151,
      // land on the download-workaround's HTML-parsed render). Route
      // it through the same path the View raw source button uses.
      onActivate: openRawSource,
    },
    size: formatBytes(new TextEncoder().encode(text).length),
  });

  tabsView.setTabs(previewTabs(text, previewHeader));
  // Previews are shareable URLs too, so `#<file>:<line>:<col>` has to
  // land the same way it does for an installed script.
  tabsView.applyHash(true);

  // Same validation the store runs when a script is added, so what the
  // preview says about a file matches what installing it would produce.
  const error = previewValidationError(text, previewHeader);
  if (error) {
    renderInvalidPreview(error);
    return;
  }
  void wireInstallButtons()
    .catch((err) => {
      setMessage(`Could not check whether this is already installed: ${describeError(err)}`, 'error');
    })
    // After, not alongside: `wireInstallButtons` renders the banner
    // with `replaceChildren`, so a warning appended while it was still
    // in flight would be wiped out.
    .then(() => runPreviewParseCheck(text, previewHeader))
    .catch((err) => {
      // Fails open like every other leg of the check — the preview is
      // still usable, and the install-time check remains the backstop.
      dlog(`[SourceMonkey] preview parse check skipped: ${describeError(err)}`);
    });
}

// Compile what installing this file would register, and say so before
// the user commits. Without it the first report of a syntax error was
// an `INVALID` row on the page you land on AFTER clicking Install.
//
// Warns rather than blocking. A missing `@match` hides Install because
// the file isn't an installable userscript at all; a syntax error is a
// property of code the user may well intend to install and fix (or
// install because they trust it more than our verdict). So the button
// stays live and the banner says what will happen.
//
// This is where the preview stops being lazy about `@require`s. Their
// bodies are half the program a syntax error can live in — the case
// that prompted this was a broken library, not a broken body — so the
// check fetches every declared one up front, and the tabs get them
// from the shared cache for free.
async function runPreviewParseCheck(text: string, header: ParsedHeader | null): Promise<void> {
  try {
    await checkPreviewSource(text, header);
  } finally {
    // "The check is over", whatever it concluded. Tests need a signal
    // they can wait on — especially the ones asserting a warning is
    // ABSENT, which otherwise race the fetches and the compile and
    // pass for the wrong reason.
    bannerSlotEl.dataset.parseCheck = 'done';
  }
}

// `header` is passed in rather than read from module scope, even
// though it currently holds the same value: the text being compiled
// and the header describing its `@require`s have to be the same
// render's, and taking one from an argument and the other from a
// mutable module variable is how those quietly come apart.
async function checkPreviewSource(text: string, header: ParsedHeader | null): Promise<void> {
  const now = Date.now();
  const script = await buildScriptFromText({
    // Placeholder identity: nothing is stored, and the preview's own
    // location is what `addSource` would record for a real install.
    id: 'preview',
    sourceId: 'preview',
    relativePath: previewLocation,
    fileUrl: previewFileUrl,
    source: text,
    now,
  });
  // A header problem is already on screen (`renderInvalidPreview`), and
  // an unparsable header means there's no body to judge.
  if (script.status !== 'ok') return;

  // The same call the store makes, not a hand-rolled loop beside it.
  // Fetching each declared `@require` individually looks equivalent and
  // isn't: `attachFiles` dedups by canonical URL (a library declared
  // twice is loaded once), and it covers `@resource`, whose bytes are
  // baked into the checked text and whose fetch failures land a real
  // install as `invalid`. A loop that skipped both would compose a
  // program no install ever produces — and duplicate library bodies
  // read as `already been declared`, i.e. a syntax error reported
  // against a perfectly healthy script.
  const files = await attachFiles({
    scriptFileUrl: previewFileUrl,
    header,
    priorRequires: new Map(),
    priorResources: new Map(),
    recheck: 'all',
    fetchCache: previewFetchCache,
    now,
  });
  if (files.errorMessage) {
    // Deliberately softer than the syntax-error wording below. A dep
    // that won't load is usually a flaky host, and the store goes out
    // of its way not to disable a working script over one — an Update
    // keeps the prior copy running and records a refresh failure. So
    // say what we couldn't do, not what will happen.
    appendPreviewWarning(
      `This script's code could not be checked: ${files.errorMessage}`,
    );
    return;
  }
  if (files.requires.length > 0) script.requires = files.requires;
  if (files.resources.length > 0) script.resources = files.resources;

  const verdict = await checkScriptParses(script);
  // `unknown` and `null` are the machinery saying it couldn't decide.
  // Only V8 answering SyntaxError may accuse a script — see
  // [docs/parse-check.md].
  if (verdict?.status !== 'syntax-error') return;
  appendPreviewWarning(
    `This script's code has a syntax error, so none of it would run: ` +
    `${describeParseError(verdict)}. ${syntaxErrorOutcome()}`,
  );
}

// What actually happens if the user goes ahead — which is not one
// sentence, because `rebuildSource` (script-store.ts) deliberately
// treats an http(s) refresh that doesn't parse as a bad *response*
// rather than a bad script: a 200 login page served in place of the
// source must not take down the copy that works. So an Update over
// http keeps the installed body running and flags the refresh, and
// promising INVALID there would simply be wrong.
//
// A first install has no prior copy to preserve, and a file:// read
// returns the file's real bytes, so both of those really do land
// INVALID.
function syntaxErrorOutcome(): string {
  // `updateBtn.hidden` is the question `wireInstallButtons` already
  // answered, so the sentence can't disagree with the button on
  // screen. It also degrades correctly: the button starts hidden in
  // the markup, so if that wiring threw we describe an install, which
  // is what an unwired preview offers.
  if (updateBtn.hidden) return 'Installing it will store it as INVALID.';
  // Preservation is gated on the installed row being `ok`, not merely
  // on it existing: `rebuildSource` keeps a prior copy running because
  // that copy WORKS. Updating a row that is already `invalid` has
  // nothing worth keeping, so the bad parse is stored like any other.
  if (isHttpUrl(previewLocation) && previewInstalledStatus === 'ok') {
    return 'Updating it will leave the installed copy running and mark the refresh as failed.';
  }
  return 'Updating it will store it as INVALID.';
}

// Status of the row this preview would update, or null when nothing is
// installed for this location. Recorded by `wireInstallButtons` so the
// warning above can describe the outcome the store will actually
// produce, which depends on the prior row and not just on the URL.
let previewInstalledStatus: StoredScript['status'] | null = null;

// Warnings the parse check has reported, so `renderBanner` can put them
// back after it replaces the slot. Preview-only; empty for an
// installed script.
const previewWarnings: string[] = [];

// Add a warning box below whatever the banner slot already says, rather
// than replacing it — the install/installed banner is still true, and
// the two facts belong on screen together.
function appendPreviewWarning(text: string): void {
  previewWarnings.push(text);
  bannerSlotEl.append(makeBanner(text));
}

// The reason this file can't be installed, or null. Deliberately the
// same pair of checks `buildScriptFromText` runs — a preview that
// offers Install for something that would land as an `invalid` row
// would be lying.
function previewValidationError(text: string, header: ParsedHeader | null): string | null {
  const split = splitHeaderBody(text);
  if (split.error) {
    return split.error === 'no metadata block'
      ? 'This file has no // ==UserScript== metadata block, so it is not an installable userscript.'
      : 'This file has an unterminated // ==UserScript== metadata block, so it is not an installable userscript.';
  }
  const invalid = validateHeader(header);
  return invalid ? `This script cannot be installed: ${invalid}` : null;
}

function renderInvalidPreview(error: string): void {
  renderBanner(error);
  installBtn.hidden = true;
  updateBtn.hidden = true;
  // Nothing to install or update, but if we already hold a copy of
  // this location the user still wants a way to reach it — a broken
  // fetch of a script you have installed is exactly when you'd want to
  // go look at the copy that works.
  void offerOpenExisting().catch(() => {
    // Only costs the user the Open button; the banner already says
    // what's wrong with the file.
  });
  // Most likely this location is not a script at all: a web page whose
  // path merely ends in `.user.js` (a forge's blob view, say), or a
  // local `.user.js` the user opened to read. The capture can't tell —
  // it runs before any response exists — so give the user the way
  // through that landing on nothing else offers: go to the location
  // itself, in this tab, with the capture stood down.
  //
  // The target is the navigable spelling: the verbatim input for
  // http(s), the `file://` form for a local file (a bare `/path` would
  // resolve against the extension's own origin).
  const continueTarget = isHttpUrl(previewInput ?? '')
    ? previewInput ?? ''
    : isFileUrl(previewFileUrl) ? previewFileUrl : '';
  if (continueTarget) {
    // "page" is wrong for a local file, and this button's whole job is
    // to tell the user where they'll end up.
    if (isFileUrl(continueTarget)) continueBtn.textContent = 'Continue to file';
    continueBtn.hidden = false;
    // Same bypass-then-go as the raw view, but in THIS tab: the user
    // asked to leave the preview, not to open a second tab.
    continueBtn.addEventListener('click', () => {
      withBypass(continueTarget, (url) => { location.href = url; });
    });
  }
}

// Tab strip for a preview: the fetched text, then one tab per declared
// `@require`. The bodies are thunks, but they no longer decide WHEN a
// dependency is fetched: `runPreviewParseCheck` pulls every declared
// file as soon as the preview renders, because the check judges the
// composed program. Both share `previewFetchCache`, so opening a tab
// is a cache hit. No Log tab: nothing has run.
function previewTabs(text: string, header: ParsedHeader | null): CodeTab[] {
  const fileUrl = previewFileUrl;
  const tabs: CodeTab[] = [{
    kind: 'code',
    label: scriptBasename(previewLocation),
    body: text,
    fileUrl,
    // No stack frames without a run, so nothing to linkify against.
    sourceUrl: '',
  }];
  for (const ref of distillRequires(header)) {
    const resolved = resolveScriptResource(ref, fileUrl);
    // An unresolvable ref still gets a tab: opening it surfaces the
    // same rejection message installing would produce.
    const url = resolved && resolved.kind !== 'data' ? resolved.url : '';
    tabs.push({
      kind: 'code',
      label: url ? requireBasename(url, ref) : ref,
      body: () => loadPreviewRequire(ref, fileUrl),
      fileUrl: url || fileUrl,
      sourceUrl: '',
    });
  }
  return tabs;
}

async function loadPreviewRequire(ref: string, fileUrl: string): Promise<string> {
  const entry: StoredRequire = await fetchRequireForPreview(
    ref,
    fileUrl,
    previewFetchCache,
    Date.now(),
  );
  return entry.source;
}

// Look for an existing row for this location and pick the button set.
// A container script's `relativePath` holds the full URL/path the user
// added, canonicalized — which is exactly what `addSource` would store
// for this install, so it's the field to match on.
async function wireInstallButtons(): Promise<void> {
  const existing = await findInstalled();

  if (!existing) {
    renderBanner('This script is not installed yet.', 'preview');
    installBtn.hidden = false;
    installBtn.disabled = false;
    installBtn.onclick = () => void doInstall();
    return;
  }

  previewInstalledStatus = existing.status;
  renderInstalledBanner(existing, previewHeader);
  installBtn.hidden = true;
  showOpenButton(existing.id);
  updateBtn.hidden = false;
  updateBtn.onclick = () => void doUpdate(existing.id);
}

async function offerOpenExisting(): Promise<void> {
  const existing = await findInstalled();
  if (existing) showOpenButton(existing.id);
}

// The stored row for the location being previewed, if we have one.
// Both sides go through `canonicalSourceInput`: `previewLocation` is
// already canonical, but a row written before `addSource` started
// collapsing `file://` inputs still carries the URL spelling, and a
// miss here is a duplicate install.
async function findInstalled(): Promise<StoredScript | undefined> {
  const scripts = await getAllScripts();
  return scripts.find((s) => canonicalSourceInput(s.relativePath) === previewLocation);
}

function showOpenButton(id: string): void {
  openBtn.hidden = false;
  openBtn.onclick = () => {
    location.href = `userscript.html?script=${encodeURIComponent(id)}`;
  };
}

async function doInstall(): Promise<void> {
  const spinner = startBusy(installBtn);
  try {
    // The normalized form, not the raw input: `addSource` normalizes
    // again internally (a no-op on an already-canonical value), and
    // for a github blob URL the raw input would cost a second
    // Contents-API round trip that can fail after the user has
    // already clicked Install.
    const result = await addSource(previewLocation);
    if (!result) {
      // Raced another tab (or the same URL under a different spelling
      // that normalizes to an already-installed one). Re-run the button
      // wiring so the page converges on the Open / Update pair instead
      // of offering an Install that can only repeat this message.
      setMessage('This script is already installed.');
      await wireInstallButtons();
      return;
    }
    const scriptId =
      result.kind === 'existingContainer'
        ? result.scriptId
        : result.source.scriptIds[0];
    location.href = scriptId
      ? `userscript.html?script=${encodeURIComponent(scriptId)}`
      : 'sources.html';
  } catch (err) {
    setMessage(`Install failed: ${describeError(err)}`, 'error');
  } finally {
    spinner.remove();
    installBtn.disabled = false;
  }
}

async function doUpdate(id: string): Promise<void> {
  const spinner = startBusy(updateBtn);
  try {
    await updateScript(id, 'manual', 'force');
    location.href = `userscript.html?script=${encodeURIComponent(id)}`;
  } catch (err) {
    setMessage(`Update failed: ${describeError(err)}`, 'error');
    spinner.remove();
    updateBtn.disabled = false;
  }
}

// Show the unprocessed file in a new tab, leaving the preview open
// behind it.
//
// This is also the escape hatch for a `.user.js` the user opened to
// *read* rather than install — the cost of capturing `file://` — so it
// has to work whether or not the fetch succeeded.
//
// Every real navigation from here sets a one-shot capture bypass,
// including `file://`: since the capture now covers local files, an
// unbypassed navigation would be pulled straight back into this same
// preview.
//
// Whether to navigate at all depends on what the browser does with a
// `.user.js` response (see install-capture.ts):
//
//   - http(s) on Chrome ≥ 152 — the browser renders it as source text
//     on its own, so navigate for real and the address bar keeps the
//     true URL.
//   - Everything else — show the copy we already fetched on
//     `raw.html`, a real page, so the tab gets a title naming the
//     file. On Chrome ≤ 151 a real navigation would land on a response
//     the download workaround rewrote to `text/html` (which HTML-parses
//     the script into one run-on line) or, for `file://`, on the legacy
//     download path. `file://` takes this branch on EVERY version:
//     `raw.html` is already the better answer (titled tab, guaranteed
//     readable) and it costs no navigation to get wrong.
//
// With no fetched copy to hand over — the fetch failed, or hasn't
// landed yet — there is nothing to render locally, so it navigates on
// any version. For http that doubles as the retry for a URL our fetch
// couldn't read: the tab carries cookies the extension's fetch
// doesn't. On Chrome ≤ 151 the result is whatever the browser makes of
// it (the run-on-line render, or a download).
function openRawSource(): void {
  const target = previewInput ?? '';
  const isHttp = isHttpUrl(target);
  if (!previewText && !isHttp && !previewFileUrl) {
    // Nothing fetched and nothing to navigate to — normalizeSourceInput
    // threw before we ever resolved a URL.
    setMessage('There is no source to open for this location.', 'error');
    return;
  }
  if (!previewText) {
    // Nothing fetched to render locally, so navigate.
    navigateRaw(isHttp ? target : previewFileUrl);
    return;
  }
  if (isHttp && !needsDownloadWorkaround(navigator.userAgent)) {
    navigateRaw(target);
    return;
  }
  putRawView({ title: scriptBasename(previewLocation), text: previewText })
    .then((url) => {
      const key = new URL(url).searchParams.get('key');
      if (key) rawViewKeys.add(key);
      openTab(url);
    })
    // `chrome.storage.session` is quota-limited and shared with the
    // per-script logs, so a big script can genuinely fail here. Say so
    // rather than having the button do nothing.
    .catch((err) => setMessage(`Could not open the source: ${describeError(err)}`, 'error'));
}

// Every navigation the preview initiates goes through here: stand the
// capture down for that one URL, then go.
//
// The bypass is keyed on the URL the browser will actually request,
// not on `previewInput` — for a local file opened by path the two
// differ (a bare path isn't navigable, only its `file://` form is).
// The `go` step runs only after the bypass row lands: the capture
// listener reads it from the service worker, and an unmarked
// navigation would be pulled straight back into this preview.
//
// `chrome.storage.session` is quota-limited and shared with the
// per-script logs, so the write can genuinely fail; say so rather than
// leaving the button inert.
function withBypass(url: string, go: (url: string) => void): void {
  markInstallBypass(url)
    .then(() => go(url))
    .catch((err) => setMessage(`Could not open ${url}: ${describeError(err)}`, 'error'));
}

// Open the real URL in a new tab, leaving this preview in place.
function navigateRaw(url: string): void {
  withBypass(url, openTab);
}

// Open a new tab beside this one. `chrome.tabs.create`, not
// `window.open`: an extension page opened through `window.open` comes
// up without the `chrome.*` APIs, so `raw.html` would have no way to
// read the text handed to it.
function openTab(url: string): void {
  void chrome.tabs.create({ url });
}

// The handed-off text outlives this page unless dropped. The tabs that
// opened it have already rendered their copies by the time this fires;
// only a reload of one would notice.
addEventListener('pagehide', () => {
  for (const key of rawViewKeys) void dropRawView(key);
  rawViewKeys.clear();
});

// Cancel: back to wherever the click came from. A captured navigation
// never committed, so the previous entry is the referring page. A tab
// opened straight into the preview (target=_blank from a site's install
// button) has no history to go back to, so close it — via
// `chrome.tabs.remove`, because Chrome refuses `window.close()` for a
// tab that wasn't opened by script.
function leavePage(): void {
  if (history.length > 1) {
    history.back();
    return;
  }
  void chrome.tabs.getCurrent().then((tab) => {
    if (tab?.id != null) void chrome.tabs.remove(tab.id);
  });
}

// Show the sources page's file-access banner when a local read failed
// *and* the toggle is the plausible reason.
//
// Chrome reports "toggle off" and "no such file" as the same opaque
// fetch failure, so the error text alone can't tell them apart — the
// toggle state can. Gated on the URL being `file://` so an http fetch
// that failed for its own reasons doesn't get blamed on a toggle that
// wouldn't have helped it.
function showFileAccessBannerIfBlocked(fileUrl: string, retry?: string): void {
  if (fileAccessAllowed || !isFileUrl(fileUrl)) return;
  replaceBanner(renderFileAccessBanner(retry));
}

// Whether the error this row is flagged with is about *reading* the
// file, as opposed to what we read once it arrived.
//
// The distinction matters because only the first kind is something the
// toggle explains. A local script with a stored parse verdict ("no
// metadata block") is flagged for a reason the toggle had nothing to do
// with, and putting the banner under that message would offer an
// unrelated setting as the explanation.
//
// Told apart by the URL: every fetch helper in `directories.ts` names
// the thing it couldn't read (`error fetching <url>`, `fetch <url>
// failed: …`), and no parse or validation message does. Deliberately
// matched against this script's own `fileUrl`, so a failed `@require`
// against some other host doesn't count either.
function readFailed(script: StoredScript): boolean {
  const message = script.errorMessage ?? script.refreshError;
  return message !== undefined && message.includes(script.fileUrl);
}

function renderBanner(text: string, extraClass = ''): void {
  replaceBanner(makeBanner(text, extraClass));
}

// The one way to replace what the banner slot says. Every caller
// REPLACES rather than appends, and each one can run after the parse
// check has reported — `doInstall` discovering the script is already
// installed, say — so each would otherwise silently delete a "this has
// a syntax error" warning the user is mid-way through reading. Going
// through here means a new banner path can't reintroduce that.
function replaceBanner(banner: HTMLElement): void {
  bannerSlotEl.replaceChildren(banner);
  for (const warning of previewWarnings) bannerSlotEl.append(makeBanner(warning));
}

function makeBanner(text: string, extraClass = ''): HTMLElement {
  const div = document.createElement('div');
  div.className = extraClass ? `banner ${extraClass}` : 'banner';
  const p = document.createElement('p');
  p.textContent = text;
  div.append(p);
  return div;
}

function renderInstalledBanner(existing: StoredScript, header: ParsedHeader | null): void {
  const installedVersion = existing.header ? getValue(existing.header, 'version') : undefined;
  const offeredVersion = header ? getValue(header, 'version') : undefined;
  let text = 'This script is already installed';
  if (installedVersion && offeredVersion && installedVersion !== offeredVersion) {
    text += ` (version ${installedVersion}; this copy says ${offeredVersion})`;
  } else if (installedVersion) {
    text += ` (version ${installedVersion})`;
  }
  text += '.';
  renderBanner(text, 'installed');
}

function startBusy(btn: HTMLButtonElement): HTMLElement {
  btn.disabled = true;
  const spinner = document.createElement('span');
  spinner.className = 'busy-spinner';
  btn.after(spinner);
  return spinner;
}

// ---------- Shared rendering ----------

// Favicon slot followed by the location, percent-decoded — for a
// script installed from (or previewed at) a URL the encoded form is
// unreadable. renderSiteIconInto paints a clickable globe placeholder
// synchronously (when the script targets a usable origin) and swaps it
// for the real favicon once the fetch resolves.
function renderHeading(
  text: string,
  script: Parameters<typeof renderSiteIconInto>[1],
): void {
  filenameEl.replaceChildren();
  const iconSlot = document.createElement('span');
  iconSlot.className = 'site-icon';
  filenameEl.appendChild(iconSlot);
  appendWithSlashBreaks(filenameEl, text);
  renderSiteIconInto(iconSlot, script);
}

function setMessage(text: string, kind: '' | 'error' | 'refresh-failed' = ''): void {
  messageEl.textContent = text;
  messageEl.className = kind ? `message ${kind}` : 'message';
}

function showMissing(message: string): void {
  currentScript = null;
  controlsRowEl.hidden = true;
  actionsEl.hidden = true;
  bannerSlotEl.replaceChildren();
  filenameEl.textContent = 'Not available';
  setMessage(message, 'error');
  summaryEl.replaceChildren();
  logPaneEl.replaceChildren();
  tabsView.clear();
}

// ---------- Log pane (installed scripts only) ----------

// Bumped on every paint request (tab-switch initial paint AND storage-
// change repaint). renderLogPane awaits a storage.get; a sm:* event
// landing during that await would call paintLog with the new array, and
// the older read would then resolve and overwrite with the stale array.
// Each paint path captures its epoch and bails if a fresher paint
// already ran.
let logPaintEpoch = 0;

async function renderLogPane(): Promise<void> {
  if (!scriptId) return;
  const epoch = ++logPaintEpoch;
  const entries = await getScriptLog(scriptId);
  if (epoch !== logPaintEpoch) return;
  paintLog(entries);
}

function paintLog(entries: LogEntry[]): void {
  logPaneEl.replaceChildren();

  // Toolbar with Clear button. Sticky so the action stays visible as
  // the user scrolls through a long log.
  const toolbar = document.createElement('div');
  toolbar.className = 'log-toolbar';
  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.textContent = 'Clear log';
  clearBtn.addEventListener('click', () => void onClearLog());
  toolbar.appendChild(clearBtn);
  logPaneEl.appendChild(toolbar);

  if (entries.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'log-empty';
    empty.textContent = 'No log entries yet. Refresh the script or trigger an event to populate this view.';
    logPaneEl.appendChild(empty);
    return;
  }

  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const trHead = document.createElement('tr');
  for (const h of ['Time', 'Level', 'Source', 'Message']) {
    const th = document.createElement('th');
    th.textContent = h;
    trHead.appendChild(th);
  }
  thead.appendChild(trHead);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  // Newest first so recent events are visible without scrolling.
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    const tr = document.createElement('tr');

    const tdTs = document.createElement('td');
    tdTs.className = 'log-ts';
    tdTs.textContent = formatLogTimestamp(e.timestamp);
    tr.appendChild(tdTs);

    const tdLevel = document.createElement('td');
    tdLevel.className = 'log-level';
    const badge = document.createElement('span');
    badge.className = `log-level-badge log-level-${e.level}`;
    badge.textContent = e.level;
    tdLevel.appendChild(badge);
    tr.appendChild(tdLevel);

    const tdSource = document.createElement('td');
    tdSource.className = 'log-source';
    tdSource.textContent = e.tabId !== undefined
      ? `tab ${e.tabId} · ${e.source}`
      : e.source;
    tr.appendChild(tdSource);

    const tdMsg = document.createElement('td');
    tdMsg.className = 'log-msg';
    appendLogMessageContent(tdMsg, e.message, e.timestamp);
    tr.appendChild(tdMsg);

    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  logPaneEl.appendChild(table);
}

// How a stack ref should be rendered, once the injected entry's
// concatenation has been undone.
//
// Errors reach the log as `err.stack` strings, and V8 does not source-
// map those — every frame from the combined entry names the script's
// own sourceURL at a GENERATED line, so a throw inside a `@require`
// arrives claiming to be in the `.user.js` at a line that is usually
// somewhere in its metadata header. Chrome's own console gets this
// right because devtools applies the entry's source map to the
// display; this is us doing the same thing for our own view.
type ResolvedRef =
  // Use it as it stands: a frame from another file, or from a script
  // with no `@require`s where nothing moved in the first place.
  | { kind: 'asIs' }
  // Rewritten to the original file and line. `stale` when the entry
  // predates the body whose layout did the rewriting.
  | { kind: 'mapped'; ref: StackRef; stale: boolean }
  // Ours, but the generated line belongs to our wrap rather than to
  // user code — the head, a `// @require` marker, a `;` ASI guard, the
  // closing brace. There is no original line at all, so it must not
  // stay clickable at the generated one: that number indexes the
  // concatenated program, and following it would land the user on
  // unrelated code (or past EOF, where the click does nothing at all).
  | { kind: 'unmappable' };

// Tooltip note for a ref mapped with a layout that isn't the one it
// was recorded under. See `resolveLogRef`.
const STALE_REF_NOTE =
  'Recorded before the current version of this script — the file and line may not match.';

function resolveLogRef(ref: StackRef, timestamp: number): ResolvedRef {
  if (stackSegments.length === 0 || ref.url !== stackEntryUrl) return { kind: 'asIs' };
  const mapped = remapStackRef(ref, stackEntryUrl, stackSegments);
  if (!mapped) return { kind: 'unmappable' };
  // The layout is recomputed from the CURRENT stored script, but the
  // log outlives refreshes — nothing clears it but the user's Clear
  // button. An entry recorded before this body loaded was generated
  // against a different arrangement of requires, so today's segments
  // may well name the wrong file and line for it.
  //
  // Mapped anyway, and still clickable. The alternative — leaving it
  // at the generated coordinate — is not the honest option it looks
  // like: that number indexes the concatenated program, so it is
  // wrong too, just less legibly, and it points into the `.user.js` at
  // an offset that includes every preceding `@require`. A best-effort
  // file and line at least lands the user somewhere they can judge.
  // The tooltip says the entry is older than the body it was mapped
  // against, so a mismatch reads as expected rather than as a bug.
  //
  // The old layout cannot be recovered to do better: a refresh
  // overwrites `bodyText` and every `requires[].source` in place, and
  // a `LogEntry` stores no layout of its own.
  //
  // The staleness signal is not airtight either: an already-open tab
  // still running the previous body can log an entry with a fresh
  // timestamp, which reads as current. Documented in
  // docs/script-log.md; closing it would need the wrapper to stamp
  // reports with the loadedAt they ran under.
  const loadedAt = currentScript?.loadedAt;
  const stale = loadedAt !== undefined && timestamp < loadedAt;
  return { kind: 'mapped', ref: mapped, stale };
}

// Paint a ref into `el` with the wire form kept as a tooltip whenever
// decoding changed it — the viewer's standing rule is that the encoded
// form is always one hover away (docs/names-and-paths.md). It earns its
// keep here beyond consistency: devtools' Sources tree indexes the file
// under the ENCODED folder name, so the tooltip is what a user needs to
// find the same file there.
function setRefText(el: HTMLElement, raw: string, url: string, stale = false): void {
  const shown = displayRefText(raw, url);
  el.textContent = shown;
  const title = refTitle(raw, shown, stale);
  if (title) el.title = title;
}

// A ref with no tab to link to. Stays a bare text node unless there is
// a tooltip to carry, which needs an element.
function refNode(raw: string, url: string, stale = false): Node {
  const shown = displayRefText(raw, url);
  const title = refTitle(raw, shown, stale);
  if (!title) return document.createTextNode(shown);
  const span = document.createElement('span');
  span.textContent = shown;
  span.title = title;
  return span;
}

// What a ref's tooltip should say: the wire form when decoding changed
// what is on screen, and the staleness caveat when the entry predates
// the layout that mapped it. Empty when there is nothing to add.
function refTitle(raw: string, shown: string, stale: boolean): string {
  const parts: string[] = [];
  if (shown !== raw) parts.push(raw);
  if (stale) parts.push(STALE_REF_NOTE);
  return parts.join('\n');
}

// Paint a log entry's message into a <td>. Each URL:line:col stack
// ref is first mapped back to the file it was written in
// (`remapLogRef`); if the result matches a code tab's `sourceUrl` it
// becomes a clickable link that switches to that tab and jumps to
// line/col. Refs that don't match any tab render as plain text — they
// may point at code outside this script (the page, another userscript,
// a browser internal).
//
// A remapped ref is re-rendered with its new URL and line, so the text
// the user reads names the real file. That is the whole point: the
// generated line number is an artifact of our injection and means
// nothing to someone reading their own script.
function appendLogMessageContent(td: HTMLElement, message: string, timestamp: number): void {
  const runs = parseStackRefs(message);
  if (runs.length === 1 && runs[0].kind === 'text') {
    td.textContent = message;
    return;
  }
  td.replaceChildren();
  for (const run of runs) {
    if (run.kind === 'text') {
      td.appendChild(document.createTextNode(run.text));
      continue;
    }
    // One `raw` and one `tabIndex` for every outcome, so that "every
    // painted ref goes through the decode" is structural rather than a
    // property of remembering to call it on each branch.
    const resolved = resolveLogRef(run, timestamp);
    const ref = resolved.kind === 'mapped' ? resolved.ref : run;
    const raw = resolved.kind === 'mapped'
      ? `${ref.url}:${ref.line}:${ref.col}`
      : run.text;
    // An unmappable ref keeps its text but must never become a link,
    // even though its URL is this script's and so does match a tab —
    // the generated line indexes the concatenated program.
    const tabIndex = resolved.kind === 'unmappable'
      ? -1
      : tabsView.findTabBySourceUrl(ref.url);
    const stale = resolved.kind === 'mapped' && resolved.stale;
    if (tabIndex < 0) {
      td.appendChild(refNode(raw, ref.url, stale));
      continue;
    }
    const a = document.createElement('a');
    a.className = 'log-stack-link';
    a.href = '#';
    setRefText(a, raw, ref.url, stale);
    a.addEventListener('click', (ev) => {
      ev.preventDefault();
      tabsView.goToTabLine(tabIndex, ref.line, ref.col);
    });
    td.appendChild(a);
  }
}

async function onClearLog(): Promise<void> {
  if (!scriptId) return;
  await clearScriptLog(scriptId);
  // Paint the empty state immediately for snappy click feedback; the
  // storage.onChanged listener will fire shortly with the same empty
  // state, so the second paint is a visual no-op. Bump the epoch so
  // any in-flight renderLogPane() read can't undo this.
  logPaintEpoch++;
  paintLog([]);
}

function formatLogTimestamp(ms: number): string {
  const d = new Date(ms);
  const yyyy = String(d.getFullYear());
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const mmm = String(d.getMilliseconds()).padStart(3, '0');
  return `${yyyy}-${mo}-${dd} ${hh}:${mm}:${ss}.${mmm}`;
}
