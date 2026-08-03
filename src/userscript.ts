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
import { dropRawView, putRawView } from './raw-view.js';
import { parseStackRefs } from './stack-link.js';
import { remapStackRef, type MappedSegment, type StackRef } from './source-map.js';
import { USER_SOURCE_START_LINE, composeSource } from './composed-source.js';
import { buildRequireSourceUrl, buildSourceUrl } from './script-source-url.js';
import { CodeTabsView, type CodeTab } from './code-tabs.js';
import { renderDetails } from './script-details.js';

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

void load();

async function load(): Promise<void> {
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

  // Resolved location for the script: an absolute filesystem path for
  // file:// sources, the github page URL for github sources, or the
  // resolved URL for non-github HTTP sources. Skip the row entirely if
  // the source row is gone — a bare relative path under a "Location"
  // label would be misleading.
  currentFilenamePath = sourcePath
    ? scriptAbsolutePath(sourcePath, script.relativePath)
    : '';

  renderDetails(summaryEl, {
    header: script.header,
    logId: currentLogId,
    source: sourceRow,
    location: currentFilenamePath
      ? {
          text: displayLocation(currentFilenamePath),
          // Anchor href: for file:// sources we use the file:// URL (the
          // display string is the bare fs path, not navigable). For
          // everything else display = href, so the user clicks the same
          // URL they'd copy from the row.
          href: isFileUrl(script.fileUrl) ? script.fileUrl : currentFilenamePath,
          trailing: filenameCopyBtn,
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
  // it — see `remapLogRef`. Same shared `composeSource` the injector
  // runs, given the same URLs and the same start line, so the segments
  // are the ones the registered entry's source map was built from.
  stackSegments = composeSource(script, {
    requireUrls: requireSourceUrls,
    mainUrl: mainSourceUrl,
    startLine: USER_SOURCE_START_LINE,
  }).segments;
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
      // Raw stack frames never carry this URL — under Mode A V8 tags
      // every frame in the combined entry with the script's own
      // sourceURL. `stackSegments` below is what turns such a frame
      // back into a ref at this URL, which is what lets the Log tab
      // linkify to this tab.
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
//   previewInput     — verbatim from the query string. What `addSource`
//                      is handed, and what a capture bypass is keyed on
//                      (it's the URL the browser would navigate to).
//   previewLocation  — `normalizeSourceInput(previewInput)`: a
//                      github.com blob URL rewritten to its raw form, a
//                      local path left alone. Exactly what `addSource`
//                      would store as `relativePath`, so it's what the
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
    previewLocation = await normalizeSourceInput(input);
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
  void wireInstallButtons().catch((err) => {
    setMessage(`Could not check whether this is already installed: ${describeError(err)}`, 'error');
  });
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
  // Most likely this URL is a web page that merely ends in `.user.js` —
  // a forge's blob view, say. The capture can't tell (it runs before
  // any response headers exist), so give the user the way through that
  // landing on nothing else offers: go to the page. Only meaningful for
  // http(s); a local file has nothing to navigate to.
  if (isHttpUrl(previewInput ?? '')) {
    continueBtn.hidden = false;
    continueBtn.addEventListener('click', () => {
      const url = previewInput ?? '';
      markInstallBypass(url)
        .then(() => { location.href = url; })
        // storage.session is quota-limited, so this can genuinely
        // fail. Say so rather than leaving the button inert.
        .catch((err) => setMessage(`Could not open the page: ${describeError(err)}`, 'error'));
    });
  }
}

// Tab strip for a preview: the fetched text, then one tab per declared
// `@require`. Bodies for the requires are thunks — nothing is fetched
// from a third-party host until the user opens that tab, so merely
// looking at a script we haven't installed doesn't pull down its
// dependencies. No Log tab: nothing has run.
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

// Look for an existing row for this URL and pick the button set. A
// container script's `relativePath` holds the full URL the user added
// (post-normalization), which is exactly what `addSource` would store
// for this install — so it's the field to match on.
async function wireInstallButtons(): Promise<void> {
  const scripts = await getAllScripts();
  const existing = scripts.find((s) => s.relativePath === previewLocation);

  if (!existing) {
    renderBanner('This script is not installed yet.', 'preview');
    installBtn.hidden = false;
    installBtn.disabled = false;
    installBtn.onclick = () => void doInstall();
    return;
  }

  renderInstalledBanner(existing, previewHeader);
  installBtn.hidden = true;
  showOpenButton(existing.id);
  updateBtn.hidden = false;
  updateBtn.onclick = () => void doUpdate(existing.id);
}

async function offerOpenExisting(): Promise<void> {
  const scripts = await getAllScripts();
  const existing = scripts.find((s) => s.relativePath === previewLocation);
  if (existing) showOpenButton(existing.id);
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
// A local file has none of the complications below: nothing captures
// `file://` navigations and no response header gets rewritten, so it
// opens the fetched copy on `raw.html` (titled with the filename) or,
// with no copy in hand, the file:// URL itself.
//
// For http(s) it depends on what the browser does with a `.user.js`
// response (see install-capture.ts):
//
//   - Chrome ≥ 152 renders it as source text on its own, so navigate
//     for real — the address bar keeps the true URL. Capture is stood
//     down for that one navigation.
//   - Chrome ≤ 151 renders it only if the download workaround has
//     rewritten the response to `text/html`, which HTML-parses the
//     script into one unreadable run-on line. Show the copy we already
//     fetched on `raw.html` instead — a real page, so the tab gets a
//     title naming the file.
//
// With no fetched copy to hand over — the fetch failed, or hasn't
// landed yet — there is nothing to render locally, so it navigates on
// any version. That doubles as the retry for a URL our fetch couldn't
// read: the tab carries cookies the extension's fetch doesn't. On
// Chrome ≤ 151 the result is whatever the browser makes of it (the
// run-on-line render, or a download).
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
    // Nothing fetched to render locally, so navigate. For http that
    // doubles as the retry for an auth-gated URL — the tab carries
    // cookies the extension's fetch doesn't — and needs the capture
    // stood down for one navigation.
    const nav = isHttp ? target : previewFileUrl;
    (isHttp ? markInstallBypass(target) : Promise.resolve())
      .then(() => openTab(nav))
      .catch((err) => setMessage(`Could not open the source: ${describeError(err)}`, 'error'));
    return;
  }
  if (isHttp && !needsDownloadWorkaround(navigator.userAgent)) {
    // Mark the bypass before opening so the capture listener can't see
    // the navigation first.
    markInstallBypass(target)
      .then(() => openTab(target))
      .catch((err) => setMessage(`Could not open the source: ${describeError(err)}`, 'error'));
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

function renderBanner(text: string, extraClass = ''): void {
  bannerSlotEl.replaceChildren();
  const div = document.createElement('div');
  div.className = extraClass ? `banner ${extraClass}` : 'banner';
  const p = document.createElement('p');
  p.textContent = text;
  div.append(p);
  bannerSlotEl.append(div);
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
    appendLogMessageContent(tdMsg, e.message);
    tr.appendChild(tdMsg);

    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  logPaneEl.appendChild(table);
}

// Undo the injected entry's concatenation for one stack ref.
//
// Errors reach the log as `err.stack` strings, and V8 does not source-
// map those — every frame from the combined entry names the script's
// own sourceURL at a GENERATED line, so a throw inside a `@require`
// arrives claiming to be in the `.user.js` at a line that is usually
// somewhere in its metadata header. Chrome's own console gets this
// right because devtools applies the entry's source map to the
// display; this is us doing the same thing for our own view.
//
// Returns the ref unchanged when there is nothing to undo: no
// `@require`s (nothing moved), a frame from another file, or a
// generated line that belongs to our wrap rather than to user code.
function remapLogRef(ref: StackRef): StackRef {
  return remapStackRef(ref, stackEntryUrl, stackSegments) ?? ref;
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
function appendLogMessageContent(td: HTMLElement, message: string): void {
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
    const mapped = remapLogRef(run);
    const text = mapped === run ? run.text : `${mapped.url}:${mapped.line}:${mapped.col}`;
    const tabIndex = tabsView.findTabBySourceUrl(mapped.url);
    if (tabIndex < 0) {
      td.appendChild(document.createTextNode(text));
      continue;
    }
    const a = document.createElement('a');
    a.className = 'log-stack-link';
    a.href = '#';
    a.textContent = text;
    a.addEventListener('click', (ev) => {
      ev.preventDefault();
      tabsView.goToTabLine(tabIndex, mapped.line, mapped.col);
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
