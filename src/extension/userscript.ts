// Userscript viewer. Loaded as chrome-extension://…/userscript.html in
// one of two modes, chosen by the query string:
//
//   ?script=<scriptId>  — an installed script. Hydrates from the
//                         persistent store (chrome.storage.local)
//                         rather than re-reading the file, so the
//                         content always matches what the collections page
//                         shows.
//   ?preview=<url>      — a script that is NOT installed (yet). Fetches
//                         it, shows exactly the same panels, and offers
//                         Install / Update. This is where a captured
//                         `.user.js` navigation lands (see
//                         `install-capture.ts`) and where the collections
//                         page sends a single-file Add.
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
  addCollection,
  ALREADY_INSTALLED_IN_TARGET,
  installScript,
  type InstallTarget,
  buildScriptFromText,
  describeError,
  distillMatching,
  getAllScripts,
  getScript,
  getCollection,
  getCollections,
  hashSource,
  isScriptEnabled,
  isCollectionEnabled,
  removeScript,
  setScriptsEnabled,
  validateHeader,
  type StoredScript,
  localFileScope,
  type StoredCollection,
} from './script-store.js';
import {
  allRelatedRows,
  contentFingerprint,
  enableChanges,
  findRelatedVersions,
  installOptionsFor,
  isRunning,
  locationKey,
  otherRunningCopies,
  type InstallOption,
  type RelatedScript,
  type RelatedVersions,
  type ScriptEnableChange,
} from './script-identity.js';
import {
  buildInstallSelect,
  enableTitle,
  installChoiceBlocked,
  renderRelatedVersions,
  selectedInstallChoice,
  watchSoloModifier,
  type InstallChoice,
  type RelatedVersionsActions,
} from './related-versions.js';
import { openCollectionDialog } from './collection-dialog.js';
import { openMoveDialog } from './move-dialog.js';
import { openCopyDialog } from './copy-dialog.js';
import { openDeleteDialog } from './delete-dialog.js';
import { setDeleteIcon } from './delete-icon.js';
import { setGlyphButton, setGlyphButtonBusy } from './glyph.js';
import type { DownloadsCopiesSetting } from './local-copy.js';
import { deletableCopyPath, readCopiesSetting } from './local-delete.js';
import { computeLogIds } from './script-log-id.js';
import { numberMap, readScriptNumbers, SCRIPT_NUMBERS_KEY } from './sticky-numbers.js';
import {
  attachFiles,
  distillRequires,
  fetchRequireForPreview,
  type AttachFilesResult,
  type FileFetchCache,
  type StoredRequire,
  type StoredResource,
} from '../external-files.js';
import {
  clearScriptLog,
  getAllMaxLogLevels,
  getMaxLogLevel,
  getScriptLog,
  LOG_LEVEL_KEY_PREFIX,
  type LogEntry,
  type LogLevel,
} from './script-log.js';
import {
  formatLogCsv,
  formatLogMessage,
  formatLogSource,
  formatLogStatus,
  formatLogTimestamp,
  logFileName,
  logStatusClass,
  LOG_COLUMNS,
} from './log-format.js';
import {
  REJECTIONS_KEY,
  coerceRejectionMap,
  describeRejection,
  readRejections,
  type RejectionMap,
} from './script-rejection.js';
import { updateScript } from './script-updater.js';
import {
  appendWithSlashBreaks,
  compareUrl,
  scriptLabel,
  displayLocation,
  formatBytes,
  formatScriptSize,
  fullSource,
  requireBasename,
  scriptBasename,
  scriptStatusView,
  stripSriFragment,
  viewerUrl,
  type ScriptStatusView,
} from '../script-display.js';
import {
  getValue,
  parseHeader,
  splitHeaderBody,
  type ParsedHeader,
} from '../userscript-header.js';
import {
  canonicalCollectionInput,
  fetchSingleFileText,
  isContainerCollection,
  isSmDevCollection,
  isSingleFileLocation,
  isFileUrl,
  isScratchUrl,
  isHttpUrl,
  LOCATION_SHAPES,
  normalizeCollectionInput,
  scriptAbsolutePath,
  collectionCanonicalUrl,
  isSingleFileInput,
} from './directories.js';
import {
  COLLECTION_OFF_TITLE,
} from './collection-display.js';
import { HEADING_SITE_ICONS, renderSiteIconInto } from './site-icon.js';
// Also the page's early heading paint — see src/extension/page-heading.ts. The
// module runs once, so importing it here does not repeat that.
import {
  headingPrefixEl,
  INSTALLED_HEADING,
  INSTALLED_TITLE,
  MISSING_LABEL,
  PREVIEW_HEADING,
  PREVIEW_TITLE,
  notePainted,
  setPageTitle,
} from './page-heading.js';
import { installHomeLinkHandler } from './page-links.js';
import { MarkupResponseError } from '../markup-response.js';
import { resolveScriptResource } from '../file-loader.js';
import {
  installLocalRootsListener,
  localRootsReady,
  localSearchRoots,
  type LocalFileScope,
} from '../local-file-overrides.js';
import {
  installGithubAuthListener,
  loadGithubAuthToken,
} from '../github-auth.js';
import { CAPTURED_PARAM, markInstallBypass } from './install-capture.js';
import { isFileSchemeAccessAllowed, renderFileAccessBanner } from './file-access.js';
import { checkScriptParses, installPageParseChecker } from './parse-check-client.js';
import {
  describeDiagnostic,
  locationLabel,
  validLocation,
  type DiagnosticLocation,
} from '../diagnostic-location.js';
import { buildHash } from './script-url-hash.js';
import { dlog } from '../debug-log.js';
import { displayRefText, parseStackRefs } from '../stack-link.js';
import { remapStackRef, type MappedSegment, type StackRef } from '../source-map.js';
import { stackLayout } from '../composed-source.js';
import { buildRequireSourceUrl, buildSourceUrl } from '../script-source-url.js';
import { CodeTabsView, type CodeTab } from './code-tabs.js';
import { makeCopyButton } from './copy-button.js';
import { markFileChanges, missingFiles, scriptFileTag } from './file-changes.js';
import { renderDetails } from './script-details.js';
import { installSelectAll } from './select-all.js';

// Install and Refresh run the load pipeline here in the page, so this
// page needs its own parse checker — without one, Install would store
// an unparsable script as `ok` and Refresh would clear an `invalid`
// verdict it never re-derived. See src/extension/parse-check-client.ts.
installPageParseChecker();

// Refresh (installed) and the preview fetch both run in the page
// context, so the page needs its own copy of the cached GitHub token.
// Both handlers await it before issuing a fetch so an early click
// can't go out unauthenticated.
installGithubAuthListener();
const githubTokenReady = loadGithubAuthToken();

const params = new URLSearchParams(location.search);
// Which installed script the page is showing. Not `const`: the
// versions panel navigates between copies in place (see
// `navigateToScript`), which reassigns this and pushes a history
// entry rather than reloading the page.
let scriptId = params.get('script');
// The location to preview, exactly as it arrived: the URL the user
// clicked (for a captured navigation) or typed into Add). See
// the preview-mode section below for the normalized forms derived
// from it.
const previewInput = params.get('preview');
// True when the link capture put us here rather than the user asking
// for this preview. Gates the "it's a web page, get out of the way"
// escape below — see CAPTURED_PARAM.
const previewWasCaptured = params.get(CAPTURED_PARAM) === '1';

const filenameEl = document.getElementById('filename')!;
const controlsRowEl = document.getElementById('meta-row')!;
const enableLabelEl = document.getElementById('enable-label') as HTMLLabelElement;
const enableCheckboxEl = document.getElementById('enable-checkbox') as HTMLInputElement;
const metaActionsEl = document.getElementById('meta-actions')!;
const refreshBtn = document.getElementById('refresh-btn') as HTMLButtonElement;
// Built once with the idle label and restored to it after every
// refresh, so the two spellings can't drift.
const REFRESH_LABELS = { idle: 'Refresh', busy: 'Refreshing…' };
const bannerSlotEl = document.getElementById('banner-slot')!;
// Wraps the banner slot and the versions panel. Carries `merged` while
// the two are one green box — see `renderInstalledBanner`.
const statusBoxEl = document.getElementById('status-box')!;
const actionsEl = document.getElementById('preview-actions')!;
const installCalloutEl = document.getElementById('install-callout') as HTMLElement;
const installTargetLabel = document.getElementById('install-target-label') as HTMLLabelElement;
const installTargetSlot = document.getElementById('install-target-slot') as HTMLElement;
const installBtn = document.getElementById('install-btn') as HTMLButtonElement;
const openBtn = document.getElementById('open-btn') as HTMLButtonElement;
const continueBtn = document.getElementById('continue-btn') as HTMLButtonElement;
const cancelBtn = document.getElementById('cancel-btn') as HTMLButtonElement;
const viewSourceBtn = document.getElementById('view-source-btn') as HTMLButtonElement;
const messageEl = document.getElementById('message')!;
const summaryEl = document.getElementById('header-summary')!;
const versionsEl = document.getElementById('other-versions')!;
const tabsEl = document.getElementById('tabs')!;
const contentEl = document.getElementById('content')!;
const codePaneEl = document.getElementById('code-pane') as HTMLElement;
const logPaneEl = document.getElementById('log-pane') as HTMLElement;

const tabsView = new CodeTabsView(
  { tabsEl, codePaneEl, contentEl, logPaneEl },
  { onShowLog: () => void renderLogPane() },
);

setGlyphButton(refreshBtn, '#sm-refresh', REFRESH_LABELS.idle);
refreshBtn.addEventListener('click', () => void onRefresh());
// Same modifier wiring as a panel row's checkbox, from the same helper:
// ctrl/cmd-click opts out of the exclusive sweep here too.
const takeControlsRowSolo = watchSoloModifier(enableCheckboxEl);
enableCheckboxEl.addEventListener('change', () => void onToggleEnabled(enableCheckboxEl.checked));

// The Location row's copy button. One long-lived element, appendChild'd
// into the dl on each render (appendChild moves it, so no duplication),
// which is what lets an in-flight "Copied" flash survive a repaint.
// Reads `currentFilenamePath` at click time.
//
// Copies the raw location, not the decoded form the row displays: a
// pasted URL has to still work in a terminal, an address bar, or the
// Add field.
const filenameCopyBtn = makeCopyButton({
  label: 'Copy location to clipboard',
  text: () => currentFilenamePath,
});

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

installLocalRootsListener();
// The header bar's icon and product name are a link home. Delegated, so
// it survives the heading repaints an in-place copy switch does.
installHomeLinkHandler();
void load();

async function load(): Promise<void> {
  fileAccessAllowed = await fileAccessProbe;
  // Stand-in resolution (the preview's own parse check, and the icon
  // slot) reads the configured roots synchronously, so hydrate the
  // setting before either runs.
  await localRootsReady();
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

// Keep the displayed Log ID current: the service worker numbers a new
// script just after it is added, and an unnumbered script's `#N` moves
// when another sharing its basename comes or goes. Listen for any
// script:* mutation and for the numbers row, and re-derive.
chrome.storage.onChanged.addListener((changes, areaName) => {
  // Before the `scriptId` gate below: the panel's Status column speaks
  // for every copy it draws, and a PREVIEW draws copies too. Everything
  // after the gate is about the one installed script this page is
  // showing, which a preview doesn't have.
  if (areaName === 'session' && panelStatusChanged(changes)) {
    repaintPanelFromLastArgs();
  }
  if (!scriptId) return;
  if (areaName === 'local') {
    // Repaint on any script:* or script-number mutation (this script,
    // or a sibling whose add/remove shifts a `#N`) AND on a change to THIS
    // script's parent collection. A collection enable/disable or rename
    // done on the collections page or in another tab has to reach the
    // viewer's Enable toggle and Collection row, not just this script's
    // own Refresh.
    const collectionKey = currentScript ? `collection:${currentScript.collectionId}` : null;
    let touched = false;
    for (const key of Object.keys(changes)) {
      if (key.startsWith('script:') || key === SCRIPT_NUMBERS_KEY) {
        touched = true;
        break;
      }
      // A collection row is written on every refresh attempt, successful or
      // not (`lastRefreshedAt`, `scanError`), and none of that shows
      // here. Re-render only for the fields this page actually reads,
      // or a collection stuck retrying a failing scan would re-render every
      // viewer open on it, on every retry, with nothing changing.
      if (collectionKey && key === collectionKey && sourceFieldsShownHereChanged(changes[key])) {
        touched = true;
        break;
      }
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
    // Same for the injector's rejection map: a sync that finally places
    // this script (or newly refuses it) has to move the Status row and
    // the message bar, both of which are visible from every tab.
    if (REJECTIONS_KEY in changes) {
      currentRejection = coerceRejectionMap(changes[REJECTIONS_KEY]?.newValue)[scriptId];
      if (currentScript) {
        repaintStatusRow(currentScript);
        paintScriptMessage(currentScript);
      }
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

// Does a `collection:*` delta touch anything this viewer shows? The
// Enable toggle reads the collection's enabled state and the Collection
// row reads its display name and path; nothing else on the page comes
// from that row. An add or a removal always counts — the re-read
// handles both.
function sourceFieldsShownHereChanged(change: chrome.storage.StorageChange): boolean {
  const prev = change.oldValue as StoredCollection | undefined;
  const next = change.newValue as StoredCollection | undefined;
  if (!prev || !next) return true;
  return (
    isCollectionEnabled(prev) !== isCollectionEnabled(next) ||
    (prev.displayName ?? '') !== (next.displayName ?? '') ||
    prev.path !== next.path
  );
}

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

// The viewer's not-found line: this id names no stored row. One copy,
// because two surfaces reach it — the initial load and the storage
// watcher — and a message that drifted between them would read as two
// different problems.
const SCRIPT_NOT_IN_STORAGE = 'Script not found in storage. Open it from the collections page.';

async function rehydrateAfterStorageChange(): Promise<void> {
  if (!scriptId) return;
  // Same staleness rule as `loadStored`: an in-page navigation may have
  // moved the page on while this read was in flight.
  const wanted = scriptId;
  // If THIS script was removed, drop into the not-found state.
  const script = await getScript(wanted);
  if (scriptId !== wanted) return;
  if (!script) {
    // A removal made here that is already on its way to another copy.
    if (swappingAfterRemoval) return;
    // Not consumed here: this path can run more than once for a single
    // removal (our own call, then the storage event), and the second
    // pass must not downgrade the wording. `render` clears the flag
    // instead — once a script is on screen, any earlier removal is
    // history and a later disappearance is someone else's.
    showMissing(
      removedHereMessage !== null
        // Anything the removal could not finish is painted WITH it, for
        // the same reason: a message set afterwards would be wiped by
        // the next pass.
        ? [removedHereMessage, ...removedHereDetail].join(' ')
        : SCRIPT_NOT_IN_STORAGE,
    );
    return;
  }
  // Re-read the parent collection too: its enabled state greys the
  // Enable toggle and its display name shows in the Collection row, and
  // either can change from the collections page or another tab while
  // this viewer is open. render() reads these from the cached values.
  const collection = await getCollection(script.collectionId);
  if (scriptId !== wanted) return;
  cacheCollection(collection);
  await refreshLogId(wanted);
  if (scriptId !== wanted) return;
  render(script);
  // render() wipes the flash overlay via `textContent =` and may
  // have clamped the tab index to 0 if a require disappeared.
  // Re-anchor highlight + URL without scrolling the code pane.
  tabsView.applyHash(false);
}

// Collection-enabled state is needed for greying the toggle. We cache
// it so onToggle doesn't have to re-read storage. collectionPath is
// cached for the same reason — render() builds the absolute filename
// from it. collectionRow holds the whole StoredCollection (when found)
// so the Collection row can render its bubble + display name without a
// second read.
let collectionEnabled = true;
let collectionPath = '';
let collectionRow: StoredCollection | null = null;

// Single place the three cached collection values are derived, so the
// load path and the live re-hydrate can't fall out of step on what a
// missing collection means (treated as enabled, with no path and no row
// to render).
function cacheCollection(collection: StoredCollection | undefined): void {
  collectionEnabled = collection ? isCollectionEnabled(collection) : true;
  collectionPath = collection?.path ?? '';
  collectionRow = collection ?? null;
}
// Path currently shown in the Location cell. The copy button reads
// this rather than the cell's textContent, which would also break if
// the dl ever wraps the path across multiple text nodes.
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
// Lines in the user program. With no `@require`s that is the whole
// entry except its last line, which holds our closer (`})();});`) and
// shows up in every synchronous throw's stack as the arrow's call site.
// A ref past this line is ours, not the user's.
let stackBodyLineCount = 0;
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
// Chrome's reason for refusing to register THIS script, while it is
// refusing — the script loaded fine but never runs. Drives the REJECTED
// status and the message bar. Undefined in the normal case; kept fresh
// from the same storage.session listener as `currentLogLevel`.
let currentRejection: string | undefined;

async function loadStored(): Promise<void> {
  if (!scriptId) return;
  // Captured because in-page navigation can start a second hydrate
  // while this one is still reading storage (two quick clicks in the
  // panel). `scriptId` is the single source of truth for which copy the
  // page is showing, so a hydrate that no longer matches it has lost —
  // rendering it anyway would leave the URL naming one script and the
  // page showing another.
  const wanted = scriptId;
  const script = await getScript(wanted);
  if (scriptId !== wanted) return;
  if (!script) {
    showMissing(SCRIPT_NOT_IN_STORAGE);
    return;
  }
  const collection = await getCollection(script.collectionId);
  // Checked BEFORE the write, not after: `cacheCollection` and
  // `refreshLogId` both set module state that the winning hydrate's
  // later renders read, so a loser that wrote and then bailed would
  // leave the page rendering the wrong collection.
  if (scriptId !== wanted) return;
  cacheCollection(collection);
  await refreshLogId(wanted);
  if (scriptId !== wanted) return;
  // Hydrate the max log level and any registration rejection before
  // render() so the first paint of the Status row already reflects
  // WARNING / ERROR / REJECTED. Without this the row would briefly
  // show OK and then flip when the storage listener fires.
  currentLogLevel = await getMaxLogLevel(scriptId);
  currentRejection = (await readRejections())[scriptId];

  render(script);
  // The tab view seeds its own selection from `location.hash` on the
  // first setTabs(); this applies the line highlight and normalizes
  // the URL.
  tabsView.applyHash(true);
}

// Takes the id rather than reading `scriptId`: the callers work on an
// id they captured before their first await, and an in-page navigation
// can move `scriptId` on underneath them.
async function refreshLogId(id: string): Promise<void> {
  const all = await getAllScripts();
  const map = computeLogIds(all, numberMap(await readScriptNumbers()));
  currentLogId = map.get(id) ?? '';
}

async function onRefresh(): Promise<void> {
  if (!scriptId) return;
  // Same capture as `loadStored`: the user can pick another copy from
  // the panel while the refetch is in flight.
  const wanted = scriptId;
  setGlyphButtonBusy(refreshBtn, true, REFRESH_LABELS);
  try {
    const next = await refreshShownScript(wanted);
    if (!next) return;
    await refreshLogId(wanted);
    render(next);
    // Re-anchor highlight + URL after the repaint. Scroll skipped so
    // a Refresh doesn't yank the user's scroll position.
    tabsView.applyHash(false);
  } finally {
    setGlyphButtonBusy(refreshBtn, false, REFRESH_LABELS);
  }
}

// Refresh `wanted`, the copy this page is showing. Shared by the page's
// own Refresh button and the versions panel's row buttons (its row for
// this copy, and "Refresh all"), so both handle the row being dropped
// the same way.
//
// Returns the refreshed row for the caller to paint, or null when
// there is nothing left for it to do: the page has moved on to another
// copy (the user picked one meanwhile, or the check dropped this one
// and the page swapped to its successor), or has been rehydrated into
// the not-found state.
async function refreshShownScript(wanted: string): Promise<StoredScript | null> {
  // Wait for the GitHub token cache to hydrate first; otherwise a
  // very fast Refresh click can fire before chrome.storage.local
  // has resolved and the fetch goes out unauthenticated.
  await githubTokenReady;
  // Routed through the shared updater: if a background opportunistic
  // check is already in flight for this script, we wait for it
  // instead of starting a second fetch.
  // 'force': this is a real Refresh click, so check upstream now
  // rather than waiting out the probe interval.
  // A local script's check can find its file gone and drop the row
  // itself (docs/file-changes.md) — the outcome the `deleted`
  // chip's tooltip promised. The storage event for that removal
  // reaches `rehydrateAfterStorageChange` before `updateScript`
  // returns, so the wording it should paint is set in advance rather
  // than after: otherwise the generic not-found line lands first,
  // and reads as a storage fault. `render` clears it again the
  // moment the check comes back with a row, which is the usual case.
  //
  // Set only when the file IS gone right now (the same probe the
  // chip uses), so a row that goes away for some other reason during
  // the check — removed from another tab, say — isn't blamed on its
  // file.
  const local = !!currentScript && isFileUrl(currentScript.fileUrl)
    && (await missingFiles([currentFilenamePath])).has(currentFilenamePath);
  if (local) removedHereMessage = REMOVED_FILE_GONE;
  // And where the page goes if the row does get dropped: the next
  // copy in the versions table, the same way the panel's trash can
  // moves on rather than stranding the page on the not-found line.
  // Picked before the check, for the reason the trash can gives —
  // the removal's storage event reaches the listener first, and the
  // flag is what holds back its not-found paint.
  const successor = local ? await survivingRowAfter(lastRelatedRows, wanted) : undefined;
  if (successor) swappingAfterRemoval = true;
  let next: StoredScript | null;
  try {
    next = await updateScript(wanted, 'manual', 'force');
  } catch (err) {
    // No verdict, so no claim: a later removal by someone else must
    // not be painted as this refresh's doing.
    // Only our own claim: a trash can may have set its own meanwhile.
    if (local && removedHereMessage === REMOVED_FILE_GONE) removedHereMessage = null;
    if (successor) swappingAfterRemoval = false;
    throw err;
  }
  if (scriptId !== wanted) {
    if (successor) swappingAfterRemoval = false;
    return null;
  }
  if (!next) {
    if (successor) {
      try {
        await swapToScript(successor, { replace: true });
      } finally {
        swappingAfterRemoval = false;
      }
      return null;
    }
    // Driven from here too: `removeScript` writes nothing when the
    // row was already gone, so there may be no event to wait for.
    await rehydrateAfterStorageChange();
    return null;
  }
  // The row is back, so the claim is withdrawn here and not left to
  // `render`: the panel's caller paints nothing itself, and a check
  // that found nothing to write leaves the storage listener with no
  // paint to clear it with either.
  if (local && removedHereMessage === REMOVED_FILE_GONE) removedHereMessage = null;
  if (successor) swappingAfterRemoval = false;
  return next;
}

// The controls-row toggle. Same radio-button rule as the panel's rows:
// enabling this copy turns off every other copy that is running, since
// two enabled copies of one script both register and both run.
//
// It has to read the related rows itself — unlike a panel row, this
// checkbox has no table around it to take them from — but the rule
// applied to them is the shared one, so the two controls can't drift.
async function onToggleEnabled(enabled: boolean): Promise<void> {
  if (!scriptId) return;
  const solo = takeControlsRowSolo();
  let changes = enableChanges(scriptId, enabled, []);
  if (enabled && !solo) {
    try {
      const snapshot = await readStoreSnapshot();
      const script = snapshot.scripts.find((s) => s.id === scriptId);
      const related = findRelatedVersions({
        ...snapshot,
        location: script?.fileUrl ?? '',
        header: script?.header ?? null,
      });
      changes = enableChanges(scriptId, enabled, allRelatedRows(related));
    } catch (err) {
      // Fails open: the copy the user actually clicked still gets
      // written, and the panel still shows whatever else is on.
      // Blocking the toggle on a lookup it only needs for the OTHER
      // rows would be worse than under-applying the sweep.
      dlog(`[SourceMonkey] exclusive-enable lookup skipped: ${describeError(err)}`);
    }
  }
  // Before the awaits: both checkboxes are showing an intent, and a
  // radio-button pair that flips one now and the other after a round
  // trip through storage reads as a bug.
  paintEnabledOptimistically(changes);
  await applyEnableChanges(changes);
  const next = await getScript(scriptId);
  if (next) {
    render(next);
    tabsView.applyHash(false);
  }
}

// Write one click's worth of enable changes.
//
// `setScriptsEnabled`, not a loop of `setScriptEnabled`: the bulk call
// lands as ONE `chrome.storage.local.set`, so it fires one
// `storage.onChanged`. A loop fired one per copy, and every one of them
// rehydrated this page from a half-applied state — the user watched the
// Enabled checkbox flip back and forth as the batch went through. It
// also spares the background worker a registration sync per copy.
async function applyEnableChanges(changes: readonly ScriptEnableChange[]): Promise<void> {
  await setScriptsEnabled(changes.map((c) => ({ id: c.scriptId, enabled: c.enabled })));
}

// One write, so one failure — there is no half-applied batch to
// enumerate. A single change still names the copy and the direction,
// because that message can appear next to several identical-looking
// rows.
function describeEnableFailure(
  changes: readonly ScriptEnableChange[],
  scripts: readonly StoredScript[],
  err: unknown,
): string {
  if (changes.length === 1) {
    const verb = changes[0].enabled ? 'enable' : 'disable';
    return `Could not ${verb} ${describeRelatedScript(scripts, changes[0].scriptId)}: ${describeError(err)}`;
  }
  return `Could not change which copy is enabled: ${describeError(err)}`;
}

// Show an enable batch the moment it is decided, on every checkbox that
// carries part of it — the page's own toggle and any panel row for the
// same script. The write then lands underneath, and the repaint both
// callers run afterwards redraws from stored state.
//
// Purely cosmetic: nothing reads these back, and every path that calls
// this repaints unconditionally — including when the write turns out
// to be a no-op, which fires no storage event of its own. So a paint
// that got ahead of the truth is always corrected.
function paintEnabledOptimistically(changes: readonly ScriptEnableChange[]): void {
  for (const change of changes) {
    if (change.scriptId === scriptId) enableCheckboxEl.checked = change.enabled;
    const row = versionsEl.querySelector<HTMLInputElement>(
      `tr[data-script-id="${CSS.escape(change.scriptId)}"] input[type=checkbox]`,
    );
    if (row) row.checked = change.enabled;
  }
}

function render(script: StoredScript): void {
  currentScript = script;
  // A script is on screen, so no removal is pending; the next time a
  // row goes missing it is someone else's doing. See
  // `removedHereMessage`.
  removedHereMessage = null;
  removedHereDetail = [];
  controlsRowEl.hidden = false;
  // A missing collection row reads as ENABLED, matching
  // `cacheCollection`'s `collectionEnabled` default and
  // `renderHeading`'s own — three spellings of the same "row not found"
  // state should not disagree.
  const label = scriptLabel(script.header, script.relativePath);
  renderHeading(
    INSTALLED_HEADING,
    label,
    displayLocation(script.relativePath),
    script,
    collectionRow ? localFileScope(collectionRow) : { enabled: true },
  );
  setPageTitle(INSTALLED_TITLE, label);

  // Rebuilt per render rather than updated in place: both controls
  // close over the script row they were built from.
  metaActionsEl.replaceChildren(...makeScriptActions(script, collectionRow));

  enableCheckboxEl.checked = isScriptEnabled(script);
  enableCheckboxEl.disabled = !collectionEnabled;
  enableLabelEl.classList.toggle('toggle-disabled', !collectionEnabled);
  // The plain wording; `paintRelatedVersions` adds the multi-enable
  // hint when there are other copies for the click to sweep.
  enableLabelEl.title = collectionEnabled ? enableTitle(false) : COLLECTION_OFF_TITLE;

  // Identity the script's own diagnostics name it by. Set before the
  // tabs so `appendDiagnostic` below can resolve a location to tab 0.
  mainDiagFile = script.relativePath;

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
  // file:// collections, the github page URL for github collections, or
  // the resolved URL for non-github HTTP collections. Skip the row
  // entirely if the collection row is gone — a bare relative path under
  // a "Location" label would be misleading.
  currentFilenamePath = collectionPath
    ? scriptAbsolutePath(collectionPath, script.relativePath)
    : '';

  // Anchor href: for file:// collections we use the file:// URL (the
  // display string is the bare fs path, not navigable). For everything
  // else display = href, so the user clicks the same URL they'd copy
  // from the row.
  const locationHref = isFileUrl(script.fileUrl) ? script.fileUrl : currentFilenamePath;
  renderDetails(summaryEl, {
    header: script.header,
    files: { requires: script.requires, resources: script.resources, pushed: isScratchUrl(script.fileUrl) },
    scriptUrl: script.fileUrl,
    logId: currentLogId,
    collection: collectionRow,
    collectionTrailing: collectionRow ? makeMoveControl(script, collectionRow) : undefined,
    location: currentFilenamePath
      ? {
          text: displayLocation(currentFilenamePath),
          href: locationHref,
          unopenable: isScratchUrl(script.fileUrl),
          trailing: filenameCopyBtn,
          localFile: collectionPath ? scriptFileTag(script, collectionPath) ?? undefined : undefined,
          // This href is a `.user.js` URL for nearly every installed
          // script, so a plain navigation would be captured and land
          // the user in a preview of the script they are already
          // looking at. Open it the same way the preview does: bypass
          // first, then a new tab. (A github collection's blob URL ends
          // in `.user.js` too, and is an HTML page, so it would land on
          // the "not an installable userscript" banner.)
          onActivate: () => navigateRaw(locationHref),
        }
      : undefined,
    size: formatScriptSize(script),
    status: buildStatusCell(script),
    versionProbes: script.versionProbes,
  });
  // After the panel is on screen: a chip on the Location row or a Local
  // overrides entry whose file has gone or changed (file-changes.ts).
  void markFileChanges(summaryEl);

  if (!panelAnchorId) panelAnchorId = script.id;
  void repaintRelatedVersions({
    // The fallback for a paint whose anchor row can't be read — the
    // very first one included, where the anchor IS this script.
    location: script.fileUrl,
    header: script.header,
    anchorScriptId: panelAnchorId,
    mode: 'installed',
    currentScriptId: script.id,
  });

  tabsView.setTabs(storedTabs(script));

  // Painted AFTER the tabs, not with the rest of the header fields: a
  // location can only become a link once there are tabs to resolve it
  // against, and `setTabs` is what installs them.
  paintScriptMessage(script);
}

// ---------- The panel is an index, and it holds still ----------
//
// The versions panel's two sections are computed from ONE script: rows
// at the same `fileUrl` are "This URL", rows with the same
// `@namespace` + `@name` are "a different URL". Which script that is
// decides how every row is filed.
//
// Selecting another copy from the panel therefore must NOT re-anchor
// it, or the table the user just clicked in would re-file itself
// underneath them — the row they picked jumping from the second
// section to the first, and the rest shuffling with it. The anchor is
// the script the page was OPENED with, and it stays put for the life
// of the page; navigating only moves the `is-current` highlight.
//
// A full page load on the new copy anchors on that copy instead —
// which is the pre-navigation behaviour, and still what a
// middle-click or a link from elsewhere gives.
// The anchor is an ID, not a frozen copy of the row: the location and
// identity behind it are re-read from the store on every paint, so a
// Refresh or a Move of the anchor script re-files the table around what
// it is NOW. Only *which* script the sections are computed from is
// sticky.
//
// Set on the first installed render and left alone by every
// navigation. Re-anchored only if the row disappears — see
// `resolveAnchor`.
let panelAnchorId = '';

// What the compare page is told the base is: the copy on screen, or
// the download this preview is showing — the same side the Content
// column's `content` was computed from. Nothing when an installed paint
// has no current script, which is also when there is no verdict to
// link from.
function compareBase(args: RelatedVersionsPaint): { script: string } | { preview: string } | undefined {
  if (args.mode === 'preview') return { preview: previewLocation };
  return args.currentScriptId ? { script: args.currentScriptId } : undefined;
}

// The row the next panel paint should put focus on: set when a
// selection is made from the table, consumed by that paint. Held
// across the paint rather than restored inline because the paint is
// fire-and-forget — it finishes after the navigation that started it
// has already returned.
let pendingRowFocusId = '';

// Selecting a copy from the panel opens it in place rather than
// reloading the page: same table, same order, a different script below
// it. Two ways in — a viewer link (a row's Location, or its Status,
// which carries `#Log`), and anywhere else in the row that isn't a
// control of its own.
//
// Only plain left-clicks reach the swap. A modified click or a
// middle-click means "that copy, but not here", and the row carries
// that itself (`openRowInNewTab`) — its Location is plain text on this
// page, so there is no `href` for the browser to do it with. The two
// links that remain, Status and Collection, still ride their own.
versionsEl.addEventListener('click', (ev: MouseEvent) => {
  // Preview mode has no script of its own to swap out, and its panel's
  // links are how the user leaves the preview.
  if (!scriptId || ev.defaultPrevented || ev.button !== 0) return;
  const from = ev.target as Element | null;
  if (!from || !versionsEl.contains(from)) return;
  if (ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.altKey) {
    openRowInNewTab(from, ev);
    return;
  }

  const anchor = from.closest('a');
  if (anchor) {
    const target = viewerLinkTarget(anchor.getAttribute('href'));
    // Not a viewer link — the Collection cell's link to the collections
    // page. Leave it, and don't let the row swallow it either.
    if (!target) return;
    // A link to the script already on screen is the current row's Status
    // link, whose `#Log` the tab view handles as an ordinary same-document
    // fragment navigation. Leave it to do that.
    if (target.scriptId === scriptId) return;
    ev.preventDefault();
    void navigateToScript(target.scriptId, target.hash);
    return;
  }

  // The rest of the row. `is-navigable` is on exactly the rows that
  // lead somewhere — not the current one, and never in a preview.
  const row = from.closest('tr.is-navigable');
  if (!(row instanceof HTMLElement)) return;
  const id = row.dataset.scriptId;
  if (!id || id === scriptId) return;
  // Every control in the row means something of its own: the enable
  // checkbox and its label, Refresh, the trash can, the offer section's
  // dropdown. A click that lands on one is that control's, not the
  // row's.
  if (from.closest('button, input, select, label')) return;
  // A click that ends a drag-selection of the path in the Location cell
  // is the user copying text, not picking a copy.
  if (selectionInPanel()) return;
  void navigateToScript(id, '');
});

// Enter or Space on a focused row, which is the keyboard half of the
// same gesture. Only when the ROW itself has focus: a control inside it
// is its own focus target, and Enter there belongs to the control.
versionsEl.addEventListener('keydown', (ev: KeyboardEvent) => {
  if (!scriptId || ev.defaultPrevented) return;
  if (ev.key !== 'Enter' && ev.key !== ' ') return;
  const row = ev.target;
  if (!(row instanceof HTMLTableRowElement) || row.tabIndex < 0) return;
  const id = row.dataset.scriptId;
  if (!id) return;
  // Swallowed on the CURRENT row too, where selecting is a no-op:
  // Space on a focused row scrolls the page, and a tab stop that
  // scrolls when you press the key that activates its neighbours is
  // a worse answer than one that does nothing.
  ev.preventDefault();
  if (id === scriptId) return;
  void navigateToScript(id, '');
});

// Up / Down anywhere in the panel walk the table a row at a time,
// landing on the ROW — never on a control inside it, wherever they
// were pressed from.
//
// Without them the table is a long run of tab stops — every row plus
// every control in it — and reaching the copy three rows down means
// counting Tabs through the controls of the two rows between. This is
// the same shape browsers give a listbox, and it is why the CURRENT
// row is focusable too: a row you cannot stand on is a hole in the
// walk.
//
// Landing on the row rather than on the same column's control in it:
// the columns don't line up as controls. The Collection cell holds two
// links (the type bubble and the name), a same-identity row has no
// Refresh, a disabled collection's checkbox is disabled — so "the
// corresponding one" is often a guess, and a guess that lands on the
// bubble when you started on the name is worse than a rule you can
// predict. Tab still walks the controls within a row.
//
// Installed mode only, because that is where the rows are focusable.
// A preview's rows are not — nothing there selects a copy — so its
// table has no walk and Tab through the controls is what it gets. The
// alternative, landing on each row's first control, would be the same
// coin toss the row rule exists to avoid: the collection <select> in
// the install-offer section, which the guard below then traps the walk on
// while every arrow silently re-targets the install.
versionsEl.addEventListener('keydown', (ev: KeyboardEvent) => {
  if (ev.defaultPrevented) return;
  if (ev.key !== 'ArrowUp' && ev.key !== 'ArrowDown') return;
  // A modified arrow is somebody else's: the browser's own scroll and
  // caret gestures, none of which mean "next row".
  if (ev.ctrlKey || ev.metaKey || ev.altKey || ev.shiftKey) return;
  const from = ev.target;
  if (!(from instanceof HTMLElement)) return;
  // A closed <select> owns the arrow keys — they change its value, and
  // the offer section's collection picker is one.
  if (from.closest('select')) return;
  const row = from.closest('tr');
  if (!row) return;
  const rows = walkableRows();
  // `indexOf` below is what keeps a press from inside a row the walk
  // does not step between — the install offer — from joining it.
  const at = rows.indexOf(row);
  if (at < 0) return;
  const next = rows[at + (ev.key === 'ArrowDown' ? 1 : -1)];
  if (!next) return;
  ev.preventDefault();
  next.focus();
});

// Ctrl/Cmd-A anywhere on the page selects the file content — or the
// Log table when that tab is showing — instead of the whole page
// (src/extension/select-all.ts). Wherever focus is, Ctrl-A then Ctrl-C copies the
// file.
installSelectAll(selectAllTarget);

// What Ctrl-A selects: the code element (its text is exactly the file —
// the line-number gutter and the line-flash overlay hold no text), or
// the Log tab's table, skipping the toolbar buttons. An empty log
// selects its "No log entries yet" line, and a Log pane that hasn't
// painted yet selects itself: either way the key never reaches the
// whole page. Null — the browser's own select-all — only on the
// not-found page, where the code box is empty and the status box's
// message is the one thing worth copying.
function selectAllTarget(): Element | null {
  if (!codePaneEl.hidden) return contentEl.textContent ? contentEl : null;
  if (!logPaneEl.hidden) return logPaneEl.querySelector('table, .log-empty') ?? logPaneEl;
  return null;
}

// The rows the walk steps between: every body row that can be stood
// on, in the order they are read. Both sections are separate tables
// and the walk crosses between them — to the user they are one list
// under two headings — while the install offer and every preview row,
// none of which are focusable, are not part of it.
function walkableRows(): HTMLTableRowElement[] {
  const rows = Array.from(versionsEl.querySelectorAll<HTMLTableRowElement>('tbody tr'));
  return rows.filter((r) => r.tabIndex >= 0);
}

// Ctrl/Cmd-click and middle-click on a row, which mean "somewhere else,
// not here". The Location cell is plain text on this page, so there is
// no `href` left for the browser to do this with — the row carries the
// gesture instead, and opens the same URL the cell used to link to.
//
// Shift (a new window) is deliberately not covered: `window.open`
// cannot promise one, and doing nothing is honest where guessing
// wrong is not.
function openRowInNewTab(from: Element, ev: MouseEvent): void {
  if (ev.shiftKey || ev.altKey) return;
  if (from.closest('a, button, input, select, label')) return;
  const row = from.closest('tr.is-navigable');
  if (!(row instanceof HTMLElement)) return;
  const id = row.dataset.scriptId;
  if (!id) return;
  // Same guard as the plain click: this is one gesture with two
  // destinations, so a drag that ended on a selection is neither.
  if (selectionInPanel()) return;
  ev.preventDefault();
  window.open(viewerUrl(id), '_blank');
}

versionsEl.addEventListener('auxclick', (ev: MouseEvent) => {
  if (!scriptId || ev.button !== 1) return;
  const from = ev.target as Element | null;
  if (!from || !versionsEl.contains(from)) return;
  openRowInNewTab(from, ev);
});

// Is there a live text selection anywhere in the panel?
//
// Tested against the panel, not the clicked row: a drag from one row
// into the next has the `tbody` as its common ancestor, so neither row
// contains it and a row-level test would call it no selection at all —
// and then navigate, wiping what the user had just selected.
function selectionInPanel(): boolean {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false;
  return versionsEl.contains(selection.getRangeAt(0).commonAncestorContainer);
}

// The `?script=` and fragment of a viewer link, or null for anything
// else (a collection link, an external URL).
function viewerLinkTarget(href: string | null): { scriptId: string; hash: string } | null {
  if (!href) return null;
  // `URL.parse` rather than the constructor: a malformed href returns
  // null here instead of throwing, and an uncaught throw in a click
  // listener is not free — even though only our own hrefs reach here.
  const url = URL.parse(href, location.href);
  if (!url) return null;
  if (url.origin !== location.origin || url.pathname !== location.pathname) return null;
  const id = url.searchParams.get('script');
  return id ? { scriptId: id, hash: url.hash } : null;
}

// Show another installed copy without a page load: move the URL, then
// run the same hydrate the initial load runs.
//
// `replace` is for the copy on screen being deleted — the entry we are
// leaving names a script that no longer exists, so pushing on top of it
// would give Back a not-found page. Everything else pushes.
async function swapToScript(
  id: string,
  opts: { hash?: string; replace?: boolean } = {},
): Promise<void> {
  scriptId = id;
  const url = `${viewerUrl(id)}${opts.hash ?? ''}`;
  if (opts.replace) history.replaceState(null, '', url);
  else history.pushState(null, '', url);
  await showSelectedScript();
}

async function navigateToScript(id: string, hash: string): Promise<void> {
  await swapToScript(id, { hash });
}

// Back / Forward across those entries. A move that changed only the
// fragment is left to the tab view's own `hashchange` listener — it
// owns which tab and line the fragment names.
window.addEventListener('popstate', () => {
  const id = new URLSearchParams(location.search).get('script');
  if (!id || id === scriptId) return;
  scriptId = id;
  void showSelectedScript();
});

// Everything the page holds about the script that is leaving, dropped
// before the next one is read. Each of these is per-script state that
// `loadStored` either sets outright or leaves alone when it has
// nothing to set — a stale log ID or stack layout carried across would
// be attributed to the new script.
async function showSelectedScript(): Promise<void> {
  currentScript = null;
  currentLogId = '';
  currentLogLevel = undefined;
  currentRejection = undefined;
  stackSegments = [];
  stackEntryUrl = '';
  stackBodyLineCount = 0;
  stackLayoutKey = '';
  // A log read still in flight belongs to the copy being left.
  logPaintEpoch++;
  setMessage('');
  // NOT `relatedVersionsMessage`: it reports what happened to one ROW
  // ("Could not refresh <copy>"), and the table it belongs to is
  // exactly what this navigation leaves standing.
  tabsView.reseedFromHash();
  // Where focus goes once the new copy is on screen. The panel is
  // about to be rebuilt, destroying whatever was clicked or arrowed
  // to, so something has to claim it or it falls back to <body>.
  //
  // Coming from the table, that is the row for the copy now shown —
  // the same row the user was standing on, which the rebuild turns
  // into the current row. Keeping their place is the whole point of a
  // walk through the table, and the row is not silent: it carries
  // `aria-current` and the copy's location.
  //
  // Coming from anywhere else — Back / Forward, mostly — the heading
  // instead: the title, the details and the code all changed, and a
  // screen reader has had no document change to announce them.
  const pending = versionsEl.contains(document.activeElement) ? scriptId ?? '' : '';
  pendingRowFocusId = pending;
  await loadStored();
  // The local, not the field: the paint clears the field, and reading
  // it back here would send focus to the heading it had just put on
  // the row.
  if (!pending) filenameEl.focus();
}

// Paint the "Other versions" panel for whichever mode is on screen.
//
// Fire-and-forget from both render paths: the panel is supplementary,
// so a slow store read must not delay the page around it, and a failed
// one must not blank a page that is otherwise fine. A failure empties
// the panel (`:empty` hides it) and logs via `dlog` — no user-facing
// message, because "we couldn't tell you about copies you may not
// have" is not actionable.
//
// `location` is the ABSOLUTE URL, not the stored `relativePath`: see
// [docs/script-identity.md] for why the match can't use the relative
// form.
async function paintRelatedVersions(args: RelatedVersionsPaint): Promise<void> {
  const generation = ++relatedVersionsGeneration;
  lastRelatedPaint = args;
  const snapshot = await readStoreSnapshot();
  // A later paint started while this one was reading storage, so this
  // result is already stale. Drop it rather than let two in-flight
  // reads race to paint last — the installed viewer repaints on every
  // `script:*` change, so overlapping paints are routine.
  if (generation !== relatedVersionsGeneration) return;

  const anchored = resolveAnchor(args, snapshot.scripts);
  const related = findRelatedVersions({ ...snapshot, ...anchored });
  const rows = allRelatedRows(related);
  lastRelatedIds = new Set(rows.map((r) => r.script.id));
  lastRelatedRows = rows;
  // The anchor decides how the TABLE is filed, and nothing else. Two
  // things on this page are about the copy actually on screen — the
  // Move picker's targets and the enable toggle's sweep — and after an
  // in-page switch to a different-URL copy that is not the anchor. Both
  // read this second lookup, so neither can end up describing the wrong
  // script's neighbours.
  //
  // The extra `findRelatedVersions` is a scan of a snapshot already in
  // hand, not a second store read, and it is skipped in the ordinary
  // case where the two agree.
  const displayed = anchored.location === args.location && anchored.header === args.header
    ? related
    : findRelatedVersions({ ...snapshot, location: args.location, header: args.header });
  // The two inputs the Move picker needs, kept so it can open without
  // a store read of its own — see `moveTargetContext`.
  moveTargetContext = { collections: snapshot.collections, sameLocation: displayed.sameLocation };
  const status = await relatedStatuses(rows);
  // Same staleness check as after the store read: the session reads
  // above are two more awaits a newer paint can overtake.
  if (generation !== relatedVersionsGeneration) return;

  // Read alongside the panel's other inputs, so every row's trash can
  // is drawn from the same answer the dialog will act on.
  copiesSetting = await readCopiesSetting();

  const actions: RelatedVersionsActions = {
    currentScriptId: args.currentScriptId,
    setEnabled: async (changes) => {
      relatedVersionsMessage = '';
      // The clicked box has already flipped itself; this catches up the
      // rest of the batch — the other rows and the page's own toggle —
      // before the write, so the whole set moves at once.
      paintEnabledOptimistically(changes);
      let failure: unknown;
      try {
        await applyEnableChanges(changes);
      } catch (err) {
        failure = err;
        relatedVersionsMessage = describeEnableFailure(changes, snapshot.scripts, err);
      }
      // Repainted either way, and NOT left to the storage listener.
      //
      // On success because each row's handler closes over the row list
      // as it was when the row was drawn: without a repaint the second
      // click would compute "the others" from pre-first-click data and
      // sweep nothing — two enabled copies, the exact state this rule
      // exists to prevent. A preview has no storage listener at all,
      // and even on the viewer a batch that turns out to be a no-op
      // writes nothing and so fires no event.
      //
      // On failure because it redraws every box from stored state,
      // which is a better answer than the renderer's own revert of the
      // one box that was clicked.
      await afterPanelAction(args);
      if (failure) throw new Error(relatedVersionsMessage);
    },
    remove: async (id) => {
      relatedVersionsMessage = '';
      // A local copy's row deletes its FILE as well, through the same
      // dialog the trash can beside Local copy… opens — the panel's
      // button is a second way to the one action, not a second action.
      // Cancelling there leaves the row alone.
      const copy = snapshot.scripts.find((s) => s.id === id);
      const copyCollection = snapshot.collections.find((c) => c.id === copy?.collectionId);
      if (copy && deletableCopyPath(copy, copyCollection, copiesSetting)) {
        const result = await openDeleteDialog({ script: copy });
        if (!result) {
          await afterPanelAction(args);
          return;
        }
        // Both slots, unconditionally, because either can be where the
        // user is standing a moment from now: the panel's own line if
        // this page survives the removal (including a swap to another
        // copy, whose panel is where the report is still readable), and
        // the not-found state's detail if it doesn't. Assigned even
        // when empty, so a previous deletion's report can't outlive it.
        relatedVersionsMessage = result.dependencyErrors.join(' ');
        removedHereDetail = result.dependencyErrors;
      }
      // Removing the row this page is showing is allowed — it is a copy
      // like any other, and refusing only where you happen to be
      // standing would be arbitrary.
      const isCurrent = id === args.currentScriptId;
      // Deleting the copy you are standing on moves the page to the
      // next one in the table rather than stranding it on the
      // not-found line: the user asked to lose one copy, not to lose
      // the script. Only for a deletion made HERE — a copy that
      // vanishes from another tab gets the not-found state, because
      // silently swapping in some other version would be a page the
      // user never asked for.
      //
      // Both of these are decided BEFORE the removal, because the
      // removal's own storage event can be delivered while it is still
      // in flight — anything set afterwards is too late to be seen by
      // the listener it is meant for.
      const successor = isCurrent ? await survivingRowAfter(rows, id) : undefined;
      // Says the not-found state, if one is painted at all, is the
      // result the user asked for. `render` clears it as soon as a
      // script is back on screen, so the successor path pays nothing.
      if (isCurrent) removedHereMessage = REMOVED_HERE;
      // Holds back the not-found paint on the way to the successor. The
      // listener sees a `scriptId` that no longer names a stored row
      // and would tear the whole page down — heading, details, panel,
      // title — before `swapToScript` builds it back: a full-page flash
      // that reads as a page load rather than the in-place switch every
      // other move through this table makes. We already know where the
      // page is going, so there is nothing for that paint to say.
      //
      // Set only where it is owned, and cleared only on the paths that
      // set it: the other rows' trash cans stay live while this one is
      // in flight, and a second removal that reset either flag would
      // re-open the flash for the first.
      if (isCurrent && successor) swappingAfterRemoval = true;
      try {
        await removeScript(id);
      } catch (err) {
        if (isCurrent) {
          removedHereMessage = null;
          removedHereDetail = [];
          swappingAfterRemoval = false;
        }
        relatedVersionsMessage =
          `Could not remove ${describeRelatedScript(snapshot.scripts, id)}: ${describeError(err)}`;
        await afterPanelAction(args);
        return;
      }
      if (isCurrent) {
        if (successor) {
          // The fragment is dropped: it named a tab or line in the file
          // that just went away.
          try {
            await swapToScript(successor, { replace: true });
          } finally {
            swappingAfterRemoval = false;
          }
          return;
        }
        // Nothing left to show. Driven from here rather than left to
        // the storage listener: `removeScript` writes nothing when the
        // row was already gone, so there may be no event to wait for —
        // and waiting for one that never comes would leave the page
        // sitting on a table of rows it no longer has, with the trash
        // can stuck disabled. `removedHereMessage` makes the not-found state
        // read as the result the user asked for.
        await rehydrateAfterStorageChange();
        return;
      }
      await afterPanelAction(args);
    },
    update: async (ids) => {
      relatedVersionsMessage = '';
      const failures: string[] = [];
      // Sequential, not concurrent: each `updateScript` refetches and
      // rewrites storage, and the store serializes writes anyway. A
      // parallel burst would only add contention.
      //
      // The try is INSIDE the loop. Wrapping the whole loop would let
      // one unreachable host abandon every copy after it, silently —
      // the user asked for all of them.
      //
      // The row for the copy on screen goes through the page's own
      // refresh path (`refreshShownScript`): a local file the check
      // finds gone drops the row, and that path is what moves the page
      // to the next copy instead of leaving it on the not-found line.
      // The other rows' refreshes never touch what this page shows.
      //
      // Captured once: a drop moves `scriptId` to the successor, which
      // is the next row in table order — and so, in a Refresh all, the
      // next id in this loop. Read live, it would be taken for the
      // shown copy in its turn. (A preview has no `scriptId`, so the
      // mode test only says so in words.)
      const shown = args.mode === 'installed' ? scriptId : null;
      for (const id of ids) {
        try {
          if (id === shown) await refreshShownScript(id);
          else await updateScript(id, 'manual', 'force');
        } catch (err) {
          failures.push(`${describeRelatedScript(snapshot.scripts, id)}: ${describeError(err)}`);
        }
      }
      // Name which copies failed. With several rows in the table,
      // "Update failed" alone leaves the user no way to tell which one
      // to look at — see docs/diagnostics.md#wording.
      if (failures.length === 1) {
        relatedVersionsMessage = `Could not refresh ${failures[0]}`;
      } else if (failures.length > 1) {
        relatedVersionsMessage = `Could not refresh ${failures.length} copies: ${failures.join('; ')}`;
      }
      // The page moved — a swap to the successor, the not-found state,
      // or a row the user picked mid-refresh: the paint it made on the
      // way is the current one, and `args` describes the copy that is
      // no longer here. A refreshed row needs nothing more from here —
      // the storage listener repaints the page from it, as it always
      // did for this button.
      if (shown !== null && scriptId !== shown) {
        if (lastRelatedPaint) await afterPanelAction(lastRelatedPaint);
        return;
      }
      await afterPanelAction(args);
    },
    // Omitted — which is what suppresses the offer section — unless the
    // caller says installing here is a thing the user can actually do.
    install: args.offerInstall ? (btn, choice) => doInstall(btn, choice) : undefined,
  };

  // Which row the keyboard was on, so the rebuild below doesn't cost
  // the user their place. The rows are the tab stops in this table now,
  // and the panel repaints for reasons the user didn't ask for — any
  // `loglevel:` write for a drawn copy — so without this a keyboard
  // walk through the table can be dumped back to <body> mid-stride.
  //
  // A live row holding focus comes first: the user arrowed there
  // themselves, after the selection, and that is a newer answer than
  // the selection's.
  //
  // Otherwise a pending selection, whose row is by now already gone
  // from the document — there is nothing left to read the intent off
  // of. Unless the user has put focus somewhere of their own outside
  // the panel in the gap: the paint is fire-and-forget, and taking it
  // back off whatever they reached would be worse than not restoring.
  const pending = pendingRowFocusId;
  pendingRowFocusId = '';
  const focusedRowId = focusedPanelRowId()
    ?? (pending && focusIsUnclaimed() ? pending : undefined);

  // The fold toggle is a tab stop too, and the one the panel itself
  // parks focus on after a fold — so an unasked-for repaint must not
  // cost it either. A collapsed panel still repaints on any drawn
  // copy's `loglevel:` write, which is exactly when this would bite.
  const toggleFocused = document.activeElement !== null
    && document.activeElement === versionsEl.querySelector('.versions-collapse');

  // The copy the Compare column compares every other row against.
  const shownScript = args.mode === 'installed'
    ? snapshot.scripts.find((s) => s.id === args.currentScriptId)
    : undefined;
  const base = compareBase(args);
  renderRelatedVersions(versionsEl, {
    ...related,
    actions,
    status,
    content: shownScript ? contentFingerprint(shownScript) : previewContent(),
    compareHref: base && ((other) => compareUrl(base, other.id)),
    mode: args.mode,
    location: args.location,
    version: args.header ? getValue(args.header, 'version') : undefined,
    canDeleteFile: (row, collection) => deletableCopyPath(row, collection, copiesSetting) !== null,
    message: relatedVersionsMessage,
  });

  // A pending restore that found no row leaves focus on <body>, since
  // the heading was skipped for it: the copy was removed while the
  // paint was reading, or the table collapsed to nothing worth
  // showing. The heading is the fallback, as everywhere else.
  if (!restoreRowFocus(focusedRowId)) {
    if (toggleFocused) {
      versionsEl.querySelector<HTMLElement>('.versions-collapse')?.focus();
    } else if (pending) {
      claimPendingRowFocus();
    }
  }

  // Now that we know what else is installed, the controls-row toggle
  // can say what clicking it will do. `render` sets the plain wording
  // and runs before this — it has no lookup of its own — so this is
  // where the exclusive case gets named, on the one control whose
  // effect on other copies is otherwise invisible from where it sits.
  //
  // Set on every branch, not only the exclusive one: this runs after
  // repaints that had no `render` in front of them to restore the
  // default, so a title left over from a previous state would stick.
  if (args.currentScriptId && collectionEnabled) {
    const others = otherRunningCopies(allRelatedRows(displayed), args.currentScriptId);
    enableLabelEl.title = enableTitle(others.length > 0);
  }
}

// The row that should take over when `id` is deleted: the first one
// after it in the table that is still in the store, wrapping to the
// front. `undefined` when nothing is left, so the caller falls back to
// the not-found state.
//
// Table order, not store order — it is the order the user is looking
// at, so the copy that takes over is the one their eye was already
// heading towards.
//
// Each candidate is re-read because `rows` is the table as it was
// PAINTED: another tab may have deleted copies since, and swapping to
// one of those would answer a deliberate deletion with a not-found
// page for a script the user never asked for.
async function survivingRowAfter(
  rows: readonly RelatedScript[],
  id: string,
): Promise<string | undefined> {
  const at = rows.findIndex((r) => r.script.id === id);
  if (at < 0) return undefined;
  for (let step = 1; step < rows.length; step++) {
    const candidate = rows[(at + step) % rows.length].script.id;
    if (await getScript(candidate)) return candidate;
  }
  return undefined;
}

// Where this paint's two sections are computed from.
//
// The anchor row is re-read here rather than remembered, so a Refresh
// or Move of the anchor script re-files the table. If it has been
// removed outright — its trash can is in this very table — the page
// re-anchors on the copy currently on screen: a table filed under a
// script that no longer exists would keep describing copies of a
// deleted row, and would eventually stop containing the script the
// page is showing.
function resolveAnchor(
  args: RelatedVersionsPaint,
  scripts: readonly StoredScript[],
): { location: string; header: ParsedHeader | null } {
  if (!args.anchorScriptId) return { location: args.location, header: args.header };
  const anchor = scripts.find((s) => s.id === args.anchorScriptId);
  if (anchor) return { location: anchor.fileUrl, header: anchor.header };
  if (args.currentScriptId) panelAnchorId = args.currentScriptId;
  return { location: args.location, header: args.header };
}

// Has nothing taken focus since the panel started repainting? The
// removed row leaves it on <body>, which is the case a pending
// restore is for; anything else is the user's own doing, and the
// panel is where they were already if they are still in it.
function focusIsUnclaimed(): boolean {
  const active = document.activeElement;
  return active === null || active === document.body || versionsEl.contains(active);
}

// The script id of the row holding focus, if one is. Current row
// included — it is a tab stop like the rest.
function focusedPanelRowId(): string | undefined {
  const active = document.activeElement;
  if (!(active instanceof HTMLTableRowElement)) return undefined;
  if (!versionsEl.contains(active)) return undefined;
  return active.dataset.scriptId;
}

// Put focus back on the row for `id` after a rebuild. Silently does
// nothing when that row is gone — the copy was removed — because there
// is nowhere equivalent to send focus and stealing it to a neighbour
// would be worse than letting it fall back.
function restoreRowFocus(id: string | undefined): boolean {
  if (!id) return false;
  const row = versionsEl.querySelector(`tr[data-script-id="${CSS.escape(id)}"]`);
  if (!(row instanceof HTMLElement)) return false;
  row.focus();
  return true;
}

// Give up on a pending row restore and put focus on the heading, the
// same fallback the initial load and a Back use. Shared by every path
// that can leave a selection with no row to land on: a failed repaint,
// a table that came back without the row, a script that has gone
// missing outright.
function claimPendingRowFocus(): void {
  const claim = focusIsUnclaimed();
  pendingRowFocusId = '';
  if (claim) filenameEl.focus();
}

// The Status cell for every row the panel is about to draw.
//
// The two inputs live in `chrome.storage.session` — the per-script max
// log level and Chrome's registration verdicts — and neither is on the
// stored row, so they are read here and handed to the renderer rather
// than looked up per cell. One read for the whole table: a session
// `get(null)` per row would repeat the same scan once per copy.
//
// Fails open with an empty map, which renders every cell as an em
// dash. The panel is supplementary and its other columns are still
// worth showing; a status we could not compute must not blank them.
//
// Deliberately NOT reusing this page's own `currentLogLevel` /
// `currentRejection` for the current row: those track one script, and
// a cell that agreed with the page for one row while every neighbour
// came from a different read would be the drift this shares a helper
// to avoid.
async function relatedStatuses(
  rows: readonly RelatedScript[],
): Promise<Map<string, ScriptStatusView>> {
  const out = new Map<string, ScriptStatusView>();
  let levels: Map<string, LogLevel>;
  let rejections: RejectionMap;
  try {
    [levels, rejections] = await Promise.all([getAllMaxLogLevels(), readRejections()]);
  } catch (err) {
    dlog(`[SourceMonkey] related-versions status lookup failed: ${describeError(err)}`);
    return out;
  }
  for (const { script } of rows) {
    out.set(script.id, scriptStatusView(script, levels.get(script.id), rejections[script.id]));
  }
  return out;
}

// Everything that has to catch up after one of the panel's own actions
// changed storage.
//
// On the installed viewer the panel is all there is to redraw: the
// `storage.onChanged` listener rehydrates the rest of the page. A
// PREVIEW has no such listener — it returns early on `!scriptId` — so
// the page around the panel would keep whatever the load-time wiring
// left it with. Removing the copy a preview is offering to update, for
// instance, would leave the banner claiming it is still installed and
// Open / Update pointed at an id that no longer exists, with Install
// still hidden because at wiring time there was nothing to add.
//
// Only for a preview that HAS install wiring: `renderInvalidPreview`
// deliberately hides those buttons, and re-running the wiring would put
// them back on a file the page has said cannot be installed.
async function afterPanelAction(args: RelatedVersionsPaint): Promise<void> {
  await repaintRelatedVersions(args);
  if (args.mode !== 'preview' || !args.offerInstall) return;
  await wireInstallButtons().catch((err) => {
    // The panel repainted, so the user can still act from the table;
    // only the header buttons are left as they were.
    dlog(`[SourceMonkey] preview button re-wiring failed: ${describeError(err)}`);
  });
}

// How a failed copy is named in the panel's own message. The collection
// display name is what the failing row shows in its Collection cell, so
// that is what the user scans for; the location disambiguates two
// copies under one collection.
function describeRelatedScript(scripts: readonly StoredScript[], id: string): string {
  const script = scripts.find((s) => s.id === id);
  return script ? displayLocation(script.relativePath) : 'this copy';
}

interface RelatedVersionsPaint {
  // The location and identity the two sections are computed from —
  // used as-is by a preview, and as the fallback for an installed page
  // whose `anchorScriptId` no longer names a stored row.
  location: string;
  header: ParsedHeader | null;
  // Installed mode only: the script the sections stay anchored to while
  // the user switches copies in place. Resolved against the store on
  // every paint, so the anchor's own edits are picked up.
  anchorScriptId?: string;
  mode: 'installed' | 'preview';
  currentScriptId?: string;
  // Whether to offer a standalone install of this location. Never on
  // the installed page (a second row for a file already installed
  // would inject the script twice), and not for a preview the page has
  // already declared uninstallable.
  offerInstall?: boolean;
}

// Bumped by every paint so a slower earlier one can tell it lost.
let relatedVersionsGeneration = 0;

// What the last panel paint was for, so a session-storage change that
// moves any drawn copy's Status cell can re-run the same paint. Null
// until the first one. Set by previews too, and used there: the
// session branch of the listener runs before the `scriptId` gate.
let lastRelatedPaint: RelatedVersionsPaint | null = null;

// The ids the panel last drew a Status cell for. Kept so a session
// change can be tested against what is actually on screen.
let lastRelatedIds = new Set<string>();
// The rows themselves, in table order, for a Refresh that drops the
// copy on screen and wants the next one (`survivingRowAfter`).
let lastRelatedRows: readonly RelatedScript[] = [];

// Whether a `storage.session` change carries anything a Status cell
// currently on screen reads.
//
// Matched against the drawn rows, not against the `loglevel:` prefix
// alone: a page with a dozen unrelated userscripts throwing during
// load would otherwise rebuild this table a dozen times over content
// that never changed. The rejection map is one shared row, so any
// write to it may name a copy we draw.
function panelStatusChanged(changes: Record<string, unknown>): boolean {
  return Object.keys(changes).some(
    (key) => key === REJECTIONS_KEY
      || (key.startsWith(LOG_LEVEL_KEY_PREFIX)
        && lastRelatedIds.has(key.slice(LOG_LEVEL_KEY_PREFIX.length))),
  );
}

// Where local copies live, from the `smDownloadsCopies` setting, as of
// the last panel paint. Null before the first copy ever, and until the
// first read lands — in both cases no row claims a file it can delete,
// which is the safe answer. Re-read per paint rather than watched: the
// answer only moves when a copy is made, which repaints the panel
// anyway.
let copiesSetting: DownloadsCopiesSetting | null = null;

const REMOVED_HERE = 'This script has been removed';
const REMOVED_FILE_GONE = 'This script has been removed because its file was deleted';

// Set while this page is the one making the script it shows go away —
// a trash can, or a Refresh that may find the file deleted — to what
// the not-found state that follows should say. Without it that state
// reads as "the store lost your script" rather than "that worked".
// Null when no removal of ours is pending. One value rather than a
// flag plus a message, so the two can't disagree: whichever path set
// it last is the one whose wording shows.
let removedHereMessage: string | null = null;

// Set while the copy on screen is being removed and a successor is
// already picked out: `rehydrateAfterStorageChange` skips the not-found
// paint, because the swap that follows is the page the user is getting.
// See the panel's `remove` for why it is a flag and not an ordering.
let swappingAfterRemoval = false;

// What that removal could not finish — today, dependency files a local
// copy's deletion left on disk. Carried alongside `removedHereMessage` rather
// than written to the message bar after the fact, for the reason
// `rehydrateAfterStorageChange` gives. Cleared by `render`, with the
// flag itself.
let removedHereDetail: string[] = [];

// The panel's own message, surviving repaints because it is passed
// into every render. Cleared when the panel's next action starts, not
// on a repaint — a storage change caused by the very refresh that
// failed must not erase the report of that failure.
let relatedVersionsMessage = '';

// A repaint the panel owes to a storage echo, held back while the user
// is working a control that a rebuild would destroy.
//
// The install-offer section's collection dropdown — labelled *Into*,
// the panel's copy of the callout's "Install into" — is a native
// `<select>`: its
// popup is drawn by the browser and dies with the element. A rebuild
// while that popup is open closes it, and the mouseup that was going
// to pick an entry lands on whatever the rebuild put underneath —
// which reads as the dropdown selecting something on its own. Any
// session write reaches here (the injector's rejection map, a drawn
// copy's log level), so the window is small but real and not the
// user's fault.
//
// Same principle the collections page applies to a toggle mid-write:
// a repaint nobody asked for waits for the control being used.
// A flag, not the captured args: `lastRelatedPaint` is what every
// other repaint reads, and replaying a stale snapshot could let the
// flush paint older state over a newer paint that landed meanwhile.
let panelPaintDeferred = false;

// True while a `<select>` inside the panel holds focus, which is the
// state a popup is open in. Focus is the only signal the platform
// gives — there is no "is the popup showing" API — and it errs the
// safe way: a select merely tabbed to also defers, and the flush below
// catches up the moment focus leaves.
function panelSelectIsOpen(): boolean {
  const active = document.activeElement;
  return active instanceof HTMLSelectElement && versionsEl.contains(active);
}

// Repaint the panel as it was last asked for, unless the offer
// section's dropdown is open — then hold the paint back (see
// `panelPaintDeferred`). Nothing is lost: the flush repaints from the
// latest args once the dropdown is done with. For repaints the panel's
// inputs trigger on their own, not for its actions, which paint from
// their own args.
function repaintPanelFromLastArgs(): void {
  if (!lastRelatedPaint) return;
  if (panelSelectIsOpen()) {
    panelPaintDeferred = true;
  } else {
    panelPaintDeferred = false;
    void repaintRelatedVersions(lastRelatedPaint);
  }
}

// Flush whatever was held back, once the dropdown is done with.
//
// Two triggers, because focus alone doesn't cover it. Picking an entry
// closes the popup but LEAVES the select focused — Chrome fires no
// blur — so a `focusout`-only flush would sit pending until the user
// happened to click elsewhere, which may be never. A `change` means an
// entry was committed, and therefore that the popup is closed, so it
// flushes unconditionally.
function flushDeferredPanelPaint(): void {
  if (!panelPaintDeferred || !lastRelatedPaint) return;
  panelPaintDeferred = false;
  void repaintRelatedVersions(lastRelatedPaint);
}

versionsEl.addEventListener('change', () => flushDeferredPanelPaint());

// `focusout` fires BEFORE focus lands on the next element, so the check
// is deferred a task — reading `activeElement` synchronously here would
// see `body` and repaint out from under a click still travelling to a
// sibling control.
versionsEl.addEventListener('focusout', () => {
  setTimeout(() => {
    if (panelSelectIsOpen()) return;
    flushDeferredPanelPaint();
  }, 0);
});

// Re-run the panel after one of its own actions. The installed viewer
// also repaints via the `storage.onChanged` listener, but a preview has
// no `scriptId` so that listener returns early — this is what keeps the
// preview's panel current.
//
// A panel action is the user asking for this, so it repaints even with
// the dropdown focused: by then the click that opened it has been
// spent on the button that ran the action.
function repaintRelatedVersions(args: RelatedVersionsPaint): Promise<void> {
  return paintRelatedVersions(args).catch((err) => {
    // Emptied, not left as-is: the rows carry live buttons keyed to
    // script ids, and a failed re-read is exactly when those ids may
    // have stopped existing. Stale rows that still act would be worse
    // than none. `:empty` then hides the container.
    versionsEl.replaceChildren();
    // A selection was waiting for its row to be drawn, and now no row
    // will be. Hand focus to the heading rather than let it sit on an
    // element that has just been removed.
    if (pendingRowFocusId) claimPendingRowFocus();
    dlog(`[SourceMonkey] other-versions repaint failed: ${describeError(err)}`);
  });
}

// The message bar for an installed script: whichever "here is what's
// wrong" line applies, in severity order, so opening a flagged script
// always explains why.
//
//   errorMessage   — the load failed; the script can't run at all.
//   rejection      — the load was fine but Chrome refused the
//                    registration, so the script never runs either.
//                    Ranked below `errorMessage` only because the two
//                    can't co-occur (an INVALID script is never offered
//                    to Chrome), so the order is a formality.
//   refreshError   — the softer "running on a cached copy, last update
//                    failed" case.
//
// Split out of `render` so the storage listener can repaint the bar
// when a rejection appears or clears without re-rendering the page.
function paintScriptMessage(script: StoredScript): void {
  if (script.errorMessage) {
    setDiagnosticMessage(script.errorMessage, script.errorLocation, 'error');
  } else if (currentRejection) {
    // No location: Chrome names the offending value in its own words
    // (`matches[1]: Invalid port`), and we have no mapping from that
    // back to a line in the file. See docs/diagnostics.md.
    setMessage(describeRejection(currentRejection), 'error');
  } else if (script.refreshError) {
    // No location: `refreshError` means the fetch failed, so there is
    // no new content to point into, and the running copy is fine.
    setMessage(`Refresh failed: ${script.refreshError}`, 'refresh-failed');
  } else {
    setMessage('');
  }
}

// Tab strip for an installed script: main + one per `@require`, then
// the Log tab (always last so the file order stays stable as
// `@require`s come and go).
function storedTabs(script: StoredScript): CodeTab[] {
  // currentLogId is the log label the injector uses to build
  // sourceURLs (see script-source-url.ts). Falls back to the bare
  // basename if the log-id sweep hasn't run yet — same default the
  // injector uses, so the two stay in lockstep.
  const label = currentLogId || scriptBasename(script.relativePath);
  const mainSourceUrl = buildSourceUrl(label);
  const requireSourceUrls = (script.requires ?? []).map(
    (r) => buildRequireSourceUrl(label, r.url),
  );
  // Re-derive the injected entry's line layout so the Log tab can undo
  // it — see `resolveLogRef`. `stackLayout` runs the same shared
  // `composeSource` the injector runs, given the same URLs and the same
  // start line, so the segments are the ones the registered entry's
  // source map was built from.
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
    const layout = stackLayout(script, label);
    stackSegments = layout.segments;
    stackEntryUrl = layout.entryUrl;
    stackBodyLineCount = layout.lineCount;
  }
  const tabs: CodeTab[] = [{
    kind: 'code',
    label: scriptBasename(script.relativePath),
    body: fullSource(script),
    fileUrl: script.fileUrl,
    sourceUrl: mainSourceUrl,
    ...codeTabProvenance({ url: script.fileUrl }),
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
      ...codeTabProvenance(r, isScratchUrl(script.fileUrl)),
    });
  }
  tabs.push({ kind: 'log', label: 'Log' });
  return tabs;
}

// Tooltip + chip for a code tab, saying where its body came from.
//
// Every code tab gets the tooltip — the main script's as much as a
// `@require`'s. Labels are bare basenames, so "which file is this, and
// where did it come from" is a fair question on any of them, and a
// script's own URL is exactly as worth having one hover away as a
// library's.
//
// The visible chip is for `localUrl` only: that's the case where the
// tab is showing something other than what the declaration names, and a
// hover-only disclosure would be no disclosure at all.
//
// A file sm-dev pushed with a scratch script (`pushed`: one it read from
// disk) is a copy taken at the push, which no refresh rereads. Its chip
// and tooltip say so, since its `file://` URL alone reads as live.
function codeTabProvenance(
  file: { url: string; localUrl?: string },
  pushed = false,
): { title: string; mark?: string } {
  // Display form on both counts: an SRI hash tail is most of a
  // tooltip's width and nothing the reader can act on, and a URL
  // carrying a script's name is a wall of `%20` unless it goes through
  // `displayLocation` — the same decode every other URL the viewer
  // shows already gets.
  const url = displayLocation(stripSriFragment(file.url));
  if (pushed && (file.localUrl || isFileUrl(file.url))) {
    const from = file.localUrl ? displayLocation(file.localUrl) : url;
    return {
      title: `${file.localUrl ? `${url}\n\n` : ''}Snapshot of ${from}, pushed by sm-dev`,
      mark: 'snapshot',
    };
  }
  if (!file.localUrl) return { title: url };
  // Blank line between the two: they are different facts — what the
  // script declares, and what we read — not a wrapped sentence.
  //
  // The stand-in is named by its `file://` URL rather than the bare
  // path, so both lines are URLs and the pair reads as "asked for this,
  // got that". The Log's prose lines use the bare path, where a
  // sentence is what's wanted.
  return {
    title: `${url}\n\nLoaded from ${displayLocation(file.localUrl)}`,
    mark: 'local',
  };
}

// Build the Status row content: an anchor whose href is `#Log` so
// clicking switches the viewer to the Log tab via the regular
// hashchange listener. Labeled with the effective status (INVALID /
// REJECTED / OUTDATED / ERROR / WARNING / OK) computed
// against the current log level and registration verdict.
function buildStatusCell(script: StoredScript): Node {
  // The same verdict, wording, and hover text the panel's Status
  // column below shows for every other copy — a row that explained
  // itself differently from its own neighbours would read as a
  // different measurement.
  //
  // A `title` is plain text, so an error location is flattened in
  // rather than linked; the clickable form of the same verdict is in
  // the message bar this row sits above.
  const view = scriptStatusView(script, currentLogLevel, currentRejection);
  const link = document.createElement('a');
  link.href = '#Log';
  link.textContent = view.label;
  link.className = `meta-status status-${view.status}`;
  if (view.title) link.title = view.title;
  return link;
}

// ---------- Preview mode ----------

// Three spellings of one location, all needed:
//
//   previewInput     — verbatim from the query string. For an http(s)
//                      capture this is the URL the browser was about to
//                      navigate to, so it's what a bypass is keyed on.
//   previewLocation  — `normalizeCollectionInput` then
//                      `canonicalCollectionInput`: a github.com blob URL
//                      rewritten to its raw form, a `file://` URL
//                      collapsed to its bare path, a local path left
//                      alone. Exactly what `addCollection` would store as
//                      `relativePath`, so it's what the
//                      already-installed check compares, and what the
//                      Location row displays.
//   previewFileUrl   — the fetchable form of the above: a bare local
//                      path becomes `file://…`. Used for the fetch, for
//                      resolving `@require` refs, and as link hrefs.
let previewLocation = '';
let previewFileUrl = '';
// The fetched body. Empty until the fetch lands.
let previewText = '';
// `hashSource` of `previewText`: the download's half of the panel's
// Content comparison, in the same terms a stored row's `contentHash`
// is. Empty until the text is in hand.
let previewContentHash = '';
let previewHeader: ParsedHeader | null = null;
// Per-page cache shared by every lazily-loaded `@require` tab, so
// re-opening a tab (or two refs pointing at one URL) fetches once.
// It memoizes failures too, so a require that failed once replays its
// error for the life of the page rather than silently re-hitting the
// host on every tab click; reload to retry.
const previewFetchCache: FileFetchCache = new Map();
// Declared `@require` ref → the local file that stood in for it, for
// the refs where one did. Filled by the parse check (which resolves
// every declared file anyway) and read by `previewTabs` for the tooltip
// and the `local` chip.
//
// Populated after the first tab paint rather than before it: the tabs
// are what make the preview appear, and blocking them on a filesystem
// probe per require to add a chip would be the wrong trade. The check
// re-sets the tab list when it finds one.
const previewLocalFiles = new Map<string, string>();
// The parse check's resolved `@require` / `@resource` entries, for the
// byte total in the details panel's Size row. Empty until the check
// lands, at which point the panel repaints — see `recordPreviewFiles`.
let previewFiles: { requires: readonly StoredRequire[]; resources: readonly StoredResource[] } | undefined;

async function loadPreview(): Promise<void> {
  const input = previewInput ?? '';
  controlsRowEl.hidden = true;
  actionsEl.hidden = false;
  cancelBtn.addEventListener('click', leavePage);
  viewSourceBtn.addEventListener('click', openRawSource);

  setMessage('Loading…');
  await githubTokenReady;

  let text: string;
  // Set only for an input we rejected on shape. The catch below is
  // shared with the real fetch failures, and reporting a malformed
  // location as one of those would send the reader looking at their
  // network for a problem that is in the address bar.
  let badInput = false;
  try {
    // Check the shape before canonicalizing: `collectionCanonicalUrl`
    // turns anything that isn't already http(s)/file:// into a
    // file:// URL, so an `ftp://…` param would otherwise fail with a
    // baffling `file:///ftp%3A//…` error instead of being named.
    if (!isSingleFileLocation(input)) {
      badInput = true;
      // A whole sentence, not a fragment: the catch renders it as-is
      // rather than under the `Could not fetch this script: ` prefix
      // the other failures there take.
      throw new Error(`This is not a script location. It ${LOCATION_SHAPES}.`);
    }
    // Same canonicalization `addCollection` runs, so what the
    // already-installed check compares is exactly what installing
    // would store. A no-op for http(s); a plain POSIX `file://` URL
    // collapses to its bare path.
    previewLocation = canonicalCollectionInput(await normalizeCollectionInput(input));
    previewFileUrl = collectionCanonicalUrl(previewLocation);
    text = await fetchSingleFileText(previewFileUrl);
  } catch (err) {
    // The URL answered with a web page, and we only came here because
    // the capture guessed it was a script. That guess is wrong, so
    // undo it: continue to the page the user was heading for, without
    // asking. A banner offering "Continue to page" for a navigation
    // the user never asked us to intercept is a dialog about our own
    // mistake.
    //
    // Only for a captured navigation: `?preview=` reached from the
    // collections page is a question the user asked, and it gets an
    // answer instead.
    if (
      previewWasCaptured && err instanceof MarkupResponseError &&
      continueToPage('This location is a web page, not a script. Continuing to it.')
    ) {
      return;
    }
    // Keep the heading and the action row: the location is still worth
    // showing, and "View raw source" is a real retry — that navigation
    // carries cookies the extension's fetch doesn't.
    const label = scriptLabel(null, previewLocation || input);
    renderHeading(PREVIEW_HEADING, label, label, {
      matching: { matches: [] },
      header: null,
      fileUrl: previewFileUrl || input,
    });
    setPageTitle(PREVIEW_TITLE, label);
    setMessage(
      badInput ? describeError(err) : `Could not fetch this script: ${describeError(err)}`,
      'error',
    );
    // The likeliest reason a local file wouldn't read. `previewFileUrl`
    // is still '' if normalizeCollectionInput is what threw, which is
    // correctly not a file:// URL — we never got as far as a read.
    showFileAccessBannerIfBlocked(previewFileUrl);
    summaryEl.replaceChildren();
    tabsView.clear();
    hideInstallCallout();
    // A fetch that failed for a location we already hold a copy of is
    // exactly when the user wants to reach the copy that works. Only
    // meaningful once we know the normalized location — if
    // normalizeCollectionInput is what threw, there's nothing to match
    // on.
    if (previewLocation) void offerOpenExisting();
    // A markup response that we did NOT navigate away from (the user
    // asked for this preview) still deserves the way out the invalid
    // path offers — before this guard existed the page rendered as
    // "invalid" and carried this button. There is no body to show
    // alongside it, so View raw source stays as the way to see what
    // actually came back.
    if (err instanceof MarkupResponseError) offerContinueButton();
    return;
  }

  setMessage('');
  previewText = text;
  previewContentHash = await hashSource(text);
  renderPreview(text);
}

// What the panel compares its rows against on a preview: the download
// on screen, in `contentFingerprint` terms — which also answers
// undefined until the parse check has fetched the `@require`s the
// header declares, so no row says Same only to flip once they land.
function previewContent(): string | undefined {
  if (!previewContentHash) return undefined;
  return contentFingerprint({
    contentHash: previewContentHash,
    header: previewHeader,
    requires: previewFiles?.requires ?? [],
  });
}

function renderPreview(text: string): void {
  previewHeader = parseHeader(text);
  // Identity this file's own diagnostics name it by — the same one
  // `checkPreviewSource` passes as `relativePath`, so a header problem
  // and a syntax error both resolve to the main tab.
  mainDiagFile = previewLocation;

  const label = scriptLabel(previewHeader, previewLocation);
  renderHeading(PREVIEW_HEADING, label, displayLocation(previewLocation), {
    matching: distillMatching(previewHeader),
    header: previewHeader,
    fileUrl: previewFileUrl,
  });
  setPageTitle(PREVIEW_TITLE, label);

  // Same split as the installed viewer's Location row: the bare fs path
  // reads better for a local file, but only the file:// URL is a usable
  // href, and the copy button hands over the raw form either way.
  currentFilenamePath = previewLocation;
  renderPreviewDetails();

  tabsView.setTabs(previewTabs(text, previewHeader));
  // Previews are shareable URLs too, so `#<file>:<line>:<col>` has to
  // land the same way it does for an installed script.
  tabsView.applyHash(true);

  // Same validation the store runs when a script is added, so what the
  // preview says about a file matches what installing it would produce.
  const error = previewValidationError(text, previewHeader);

  // Painted either way — a file that won't install is exactly when the
  // copies you already have are worth seeing — but an invalid one gets
  // no Install offer, or the panel would contradict the banner above it
  // and the Install button the invalid path just hid.
  void repaintRelatedVersions({
    location: previewLocation,
    header: previewHeader,
    mode: 'preview',
    offerInstall: !error,
  });

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
    // location is what `addCollection` would record for a real install.
    id: 'preview',
    collectionId: 'preview',
    relativePath: previewLocation,
    fileUrl: previewFileUrl,
    text,
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
    // A preview has no collection row yet, so there's no per-collection
    // opt-out to consult — a file the user is looking at on their own
    // disk gets the same-folder rule. This is also the case the rule
    // matters most for: the published URL a script `@require`s may not
    // exist yet while it's being written.
    localRoots: previewLocalRoots(),
  });
  // Only on success. A failed `attachFiles` returns EMPTY lists rather
  // than partial ones, so recording it would strip the size and `local`
  // annotations off every row in the details panel — including the rows
  // for files that loaded fine — because one dependency was broken.
  if (!files.errorMessage) recordPreviewFiles(files);
  if (files.errorMessage) {
    // Deliberately softer than the syntax-error wording below. A dep
    // that won't load is usually a flaky host, and the store goes out
    // of its way not to disable a working script over one — an Update
    // keeps the prior copy running and records a refresh failure. So
    // say what we couldn't do, not what will happen.
    appendPreviewWarning({
      message: `This script's code could not be checked: ${files.errorMessage}`,
      // The file that wouldn't load has no tab and no content, so the
      // location is the `@require` / `@resource` line that named it.
      location: locationIn(files.errorLine),
    });
    return;
  }
  if (files.requires.length > 0) script.requires = files.requires;
  if (files.resources.length > 0) script.resources = files.resources;

  const verdict = await checkScriptParses(script);
  // `unknown` and `null` are the machinery saying it couldn't decide.
  // Only V8 answering SyntaxError may accuse a script — see
  // [docs/parse-check.md].
  if (verdict?.status !== 'syntax-error') return;
  appendPreviewWarning({
    message:
      `This script's code has a syntax error, so none of it would run: ` +
      `${verdict.message ?? 'unknown'}`,
    // Points into the `@require` tab when the error is in a library —
    // the preview builds a tab per declared `@require`, so those are
    // reachable even though nothing is installed yet.
    //
    // Validated here because this is the one path where numbers from
    // the sandbox reach the DOM without passing through the store or
    // the log: `isParseVerdict` checks only `status`, and a malformed
    // probe would otherwise render `line NaN` and scroll to it.
    location: validLocation(verdict.location),
    trailing: `. ${syntaxErrorOutcome()}`,
  });
}

// What actually happens if the user goes ahead — which is not one
// sentence, because `rebuildCollection` (script-store.ts) deliberately
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
  // `previewInstalledStatus` is the question `wireInstallButtons`
  // already answered — is there a row at this location? — rather than
  // which button it put on screen. Those came apart once the header
  // buttons started standing down in favour of the table: a copy can
  // exist here while Update is deliberately hidden, and calling that
  // an install would be wrong. It degrades the same way the old proxy
  // did: null until the wiring runs, so an unwired preview describes
  // an install, which is what it offers.
  if (previewInstalledStatus === null) return 'Installing it will store it as INVALID.';
  // Preservation is gated on the installed row being `ok`, not merely
  // on it existing: `rebuildCollection` keeps a prior copy running
  // because that copy WORKS. Updating a row that is already `invalid`
  // has nothing worth keeping, so the bad parse is stored like any
  // other.
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
//
// Held structurally rather than as rendered text: a replaced banner
// rebuilds each warning's DOM from scratch, and a location that had
// been flattened to a string on the way in could never come back as a
// link.
const previewWarnings: PreviewWarning[] = [];

// Add a warning box below whatever the banner slot already says, rather
// than replacing it — the install/installed banner is still true, and
// the two facts belong on screen together.
function appendPreviewWarning(warning: PreviewWarning): void {
  previewWarnings.push(warning);
  bannerSlotEl.append(makeBanner(warning));
}

// The reason this file can't be installed, or null. Deliberately the
// same pair of checks `buildScriptFromText` runs — a preview that
// offers Install for something that would land as an `invalid` row
// would be lying.
function previewValidationError(
  text: string,
  header: ParsedHeader | null,
): PreviewWarning | null {
  const split = splitHeaderBody(text);
  if (split.error) {
    return {
      message: cannotInstall(split.error),
      // An unterminated block has one useful place to point: the line
      // that opened it. A file with no block at all has none, so the
      // location is the file itself — clicking still gets the reader to
      // the source, which is where they have to start.
      location: locationIn(split.headerStartLine),
    };
  }
  const problem = validateHeader(header);
  if (!problem) return null;
  return {
    message: cannotInstall(problem.message),
    location: locationIn(problem.line),
  };
}

// The store's own wording for the problem, in a sentence about what it
// means here. The preview used to keep its own phrasing for the two
// metadata-block failures, which meant one problem had two texts and
// only one of them ever got improved.
//
// "This file", not "this script": the most common problem here is that
// the thing has no metadata block at all, and a prefix calling it a
// script would contradict the message saying it isn't one. Every other
// problem is about a file too.
//
// No trailing period: `appendDiagnostic` renders this as
// `<message> (in <where>)`, so one here would sit before the
// parenthetical rather than after it.
function cannotInstall(problem: string): string {
  return `This file cannot be installed: ${problem}`;
}

// A location in the previewed script's own source. `previewLocation` is
// the identity `checkPreviewSource` gives it when composing the checked
// text, so a header diagnostic and a syntax error name the same file.
function locationIn(line: number | undefined): DiagnosticLocation {
  return line === undefined
    ? { file: previewLocation }
    : { file: previewLocation, line };
}

function renderInvalidPreview(error: PreviewWarning): void {
  renderBanner(error);
  hideInstallCallout();
  // Nothing to install or update, but if we already hold a copy of
  // this location the user still wants a way to reach it — a broken
  // fetch of a script you have installed is exactly when you'd want to
  // go look at the copy that works.
  void offerOpenExisting().catch(() => {
    // Only costs the user the Open button; the banner already says
    // what's wrong with the file.
  });
  // Most likely this location isn't a script at all — a local
  // `.user.js` the user opened to read, or a file that never had a
  // metadata block. The capture can't tell in advance; it runs before
  // any response exists. So give the user the way through that landing
  // on nothing else offers: go to the location itself, with the
  // capture stood down.
  //
  // The one shape that does NOT reach here is a markup response: that
  // continues on its own without asking (see `loadPreview`).
  offerContinueButton();
}

// Show the escape hatch: leave the preview for the location itself.
// Shared by the invalid-file path and the markup one, so the two can't
// drift on the wording or on the bypass.
function offerContinueButton(): void {
  const target = continueTarget();
  if (!target) return;
  // "page" is wrong for a local file, and this button's whole job is
  // to tell the user where they'll end up.
  if (isFileUrl(target)) continueBtn.textContent = 'Continue to file';
  continueBtn.hidden = false;
  continueBtn.addEventListener('click', () => { continueToPage(); });
}

// The navigable spelling of the previewed location: the verbatim input
// for http(s), the `file://` form for a local file (a bare `/path`
// would resolve against the extension's own origin). Empty when
// neither is available — the input was rejected on shape, so there is
// nowhere to send anyone.
function continueTarget(): string {
  return isHttpUrl(previewInput ?? '')
    ? previewInput ?? ''
    : isFileUrl(previewFileUrl) ? previewFileUrl : '';
}

// Leave the preview for the location itself, in THIS tab — the user is
// going there instead of installing, not opening a second tab.
//
// Returns false when there is no navigable target, so a caller that
// was counting on leaving can fall back to rendering the problem. A
// `true` only promises the navigation was *started*: the bypass write
// is async, and if it fails `withBypass` reports that into the message
// bar of a page the caller has already stopped rendering. Storage
// writes at this size don't realistically fail, and awaiting one on
// the way out would cost every reader the delay.
// Both callers stand the capture down first (`withBypass`), or the
// navigation would be pulled straight back into this preview.
//
// `note` is for the leg that leaves on its own: an extension page that
// blanks and jumps elsewhere should say why, even though the line is
// only ever seen if the navigation is slow. The button needs none —
// the banner above it already said what this file is, and the user
// clicked knowing where they were going.
function continueToPage(note?: string): boolean {
  const target = continueTarget();
  if (!target) return false;
  if (note) setMessage(note);
  withBypass(target, (url) => { location.href = url; });
  return true;
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
    ...codeTabProvenance({ url: fileUrl }),
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
      // `url` is '' for a ref we couldn't resolve; that tab's job is to
      // report the rejection when opened, and a tooltip repeating the
      // label would add nothing.
      ...(url
        ? codeTabProvenance({ url, localUrl: previewLocalFiles.get(ref) })
        : {}),
    });
  }
  return tabs;
}

// The preview's details panel. Its own function because it is painted
// twice: once as soon as the body renders, and again when the parse
// check comes back with the resolved `@require` / `@resource` entries —
// the Size row totals their bytes, which aren't known on the first
// pass.
function renderPreviewDetails(): void {
  renderDetails(summaryEl, {
    header: previewHeader,
    mode: 'preview',
    files: previewFiles,
    scriptUrl: previewFileUrl,
    location: {
      text: displayLocation(previewLocation),
      href: previewFileUrl,
      trailing: filenameCopyBtn,
      // Navigating this href for real would be captured straight back
      // into a second preview of the same script. Route it through the
      // same path the View raw source button uses.
      onActivate: openRawSource,
    },
    size: formatBytes(new TextEncoder().encode(previewText).length),
  });
}

// Local search roots for the previewed file. Not gated on a stored
// collection row: a preview is a file the user pointed at directly, and
// `localSearchRoots` still refuses anything that isn't `file://`.
function previewLocalRoots(): string[] {
  return localSearchRoots(previewFileUrl, { enabled: true });
}

// Fold the parse check's resolved files into the preview's state and
// repaint what depends on them: the details panel's Size total and the
// tab strip's tooltips and chips.
//
// Repainting the strip is safe at any time — `setTabs` keeps the
// selected index, so a user who has already opened a require tab stays
// on it — but it is still gated on an actual change, because the check
// runs again on every re-render.
function recordPreviewFiles(files: AttachFilesResult): void {
  // Rebuilt from this pass, never merged into. Merging would make the
  // map add-only: a ref whose stand-in was deleted between checks would
  // keep its `local` chip and a "Loaded from …" tooltip naming a file
  // that no longer exists — precisely the silent-wrong-provenance this
  // feature exists to prevent.
  const next = new Map<string, string>();
  for (const r of files.requires) {
    if (r.localUrl) next.set(r.ref, r.localUrl);
  }
  const changed =
    next.size !== previewLocalFiles.size ||
    [...next].some(([ref, url]) => previewLocalFiles.get(ref) !== url);
  previewLocalFiles.clear();
  for (const [ref, url] of next) previewLocalFiles.set(ref, url);

  // The panel's Compare column compares against these too — see
  // `previewContent`. Repainted only when its answer moved: the first
  // time the requires land (the column was showing dashes for them),
  // or a re-check that fetched a library with new content.
  const contentBefore = previewContent();
  previewFiles = { requires: files.requires, resources: files.resources };
  renderPreviewDetails();
  if (previewContent() !== contentBefore) repaintPanelFromLastArgs();
  if (changed) tabsView.setTabs(previewTabs(previewText, previewHeader));
}

async function loadPreviewRequire(ref: string, fileUrl: string): Promise<string> {
  const entry: StoredRequire = await fetchRequireForPreview(
    ref,
    fileUrl,
    previewFetchCache,
    Date.now(),
    previewLocalRoots(),
  );
  return entry.source;
}

// Look for existing rows at this location and pick the button set.
//
// What the header offers depends only on whether ANY copy exists:
//
//   - none anywhere → the install callout: "Install into [collection]",
//     with the built-in default for this script's scheme pre-selected,
//     so the common case is one click;
//   - any copy, here or from a mirror → the "already installed" banner,
//     with the panel in the same box as the only place to act. Every
//     action is in there — Open (the location link) and Update on each
//     copy, Install with the same dropdown in the panel's own
//     "Install another copy of this script" section — so header buttons
//     would only leave the user guessing which copy they meant.
//
// The one exception is a location with no single-file spelling (a
// `foo.js`, a manifest URL): the panel has no offer section to carry
// Install, so the callout stays — without a dropdown — as long as
// nothing is installed at this location. `addCollection` judges those.
async function wireInstallButtons(): Promise<void> {
  // Re-runnable: `afterPanelAction` calls this again when a panel
  // action changed what is installed. Every control it owns is reset
  // first, or a copy that has just been removed would leave Open on
  // screen pointed at an id that no longer exists.
  openBtn.hidden = true;
  previewInstalledStatus = null;

  const related = await findRelatedHere();
  const existing = related.sameLocation[0]?.script;

  // Recorded before any early return: the parse-check warning describes
  // what installing WOULD do, and that depends on the row that exists
  // here, not on which surface the user will click.
  if (existing) previewInstalledStatus = existing.status;

  // "Not installed" means no copy ANYWHERE, not just none at this URL:
  // a same-`@name` copy from a mirror is still this script, installed.
  if (!existing && !related.sameIdentity.length) {
    clearBanner();
    // Nothing of this script anywhere, so Install is the only thing to
    // do here and reads as the default.
    showInstallCallout(related.installOptions, true);
    return;
  }
  renderInstalledBanner();
  // Copies are listed below, so Install is an alternative to updating
  // one of them rather than the recommended move — see the table's own
  // Update buttons, which take the emphasis instead.
  if (!related.installOptions && !existing) showInstallCallout(undefined, false);
  else hideInstallCallout();
}

// The callout, with the dropdown when the location can be installed as
// a single script. Every entry, "New collection…" included, only
// selects — Install is what acts, and for "New collection…" it opens
// the create dialog first and installs into what that makes.
//
// `recommended` is what makes Install bold. It only is when this file
// is new to SourceMonkey: with copies already listed in the table
// below, updating one of them is the likelier thing to want, and a
// bold Install would be pointing at the wrong default.
function showInstallCallout(
  options: readonly InstallOption[] | undefined,
  recommended: boolean,
): void {
  installTargetSlot.replaceChildren();
  installTargetLabel.hidden = !options;
  installCalloutEl.hidden = false;
  installBtn.disabled = false;
  installBtn.classList.toggle('primary', recommended);
  if (!options) {
    installBtn.onclick = () => void doInstall(installBtn, undefined);
    return;
  }
  const select = buildInstallSelect(options, { onChange: () => sync() });
  select.id = 'install-target';
  // Its visible label is only the connector "into" — the phrase the
  // row reads as is spread across the button, the word and the
  // dropdown, so the dropdown carries the whole of it as its name.
  select.setAttribute('aria-label', 'Install into');
  // The pre-selected default can be one that already holds this
  // script; Install then waits for a deliberate pick.
  const sync = (): void => {
    installBtn.disabled = installChoiceBlocked(select, options);
  };
  installTargetSlot.appendChild(select);
  sync();
  installBtn.onclick = () => {
    void doInstall(installBtn, selectedInstallChoice(select, options));
  };
}

function hideInstallCallout(): void {
  installCalloutEl.hidden = true;
  installBtn.onclick = null;
}

async function offerOpenExisting(): Promise<void> {
  const existing = (await findRelatedHere()).sameLocation[0]?.script;
  if (existing) showOpenButton(existing.id);
}

// Stored rows at the location being previewed, via the same lookup the
// versions panel uses — one answer to "do we already have
// this?", so the buttons and the panel agree by construction.
//
// "Agree" means the RULE is shared, not the instant: this runs its own
// read, so a write landing between it and the panel's paint can leave
// the two a moment apart. Deliberate — caching the panel's snapshot to
// close that window would hand the buttons a stale answer after an
// install or a refresh, which is a worse failure than a transient one
// that the next storage change corrects.
//
// The header IS passed, but only the banner and the table read what it
// adds. The install offer comes from `sameLocation` / `installOptions`,
// which the header cannot change: installing over a same-`@name` copy
// from another URL is not a thing we can do, so letting an identity
// match suppress Install would strand the user with no way to add the
// script. What the identity match is for is telling the user WHICH
// copies exist.
async function findRelatedHere(): Promise<RelatedVersions> {
  const snapshot = await readStoreSnapshot();
  return findRelatedVersions({ ...snapshot, location: previewLocation, header: previewHeader });
}

interface StoreSnapshot {
  scripts: StoredScript[];
  collections: StoredCollection[];
}

async function readStoreSnapshot(): Promise<StoreSnapshot> {
  const [scripts, collections] = await Promise.all([getAllScripts(), getCollections()]);
  return { scripts, collections };
}

function showOpenButton(id: string): void {
  openBtn.hidden = false;
  openBtn.onclick = () => {
    location.href = viewerUrl(id);
  };
}

// `btn` is whichever control the user actually clicked: the callout's
// Install, or the panel's offer-row Install. The busy state has to
// land on that one — spinning the header button while the clicked one
// stays live invites a second click, and a second install.
//
// `choice` is the dropdown's answer: a listed container (or the
// not-yet-existing default), or "New collection…" — which asks the
// dialog first and installs into what it made. `undefined` for a
// location with no single-file spelling, which `addCollection` adds as
// a whole collection.
async function doInstall(
  btn: HTMLButtonElement,
  choice: InstallChoice | undefined,
): Promise<void> {
  let target: InstallTarget | undefined;
  if (choice && 'newCollection' in choice) {
    // Deliberately here rather than when the dropdown changed: a
    // keyboard user cursoring past "New collection…" fires `change` on
    // a closed select, and a modal opening under the arrow keys is
    // startling. Asking at Install also makes the coupling plain —
    // the dialog says it will create AND install, and its button
    // agrees.
    const outcome = await openCollectionDialog({
      mode: 'create',
      scriptsOnly: true,
      createPurpose: 'install',
    });
    if (!outcome) return;
    target = { collectionId: outcome.collection.id };
  } else if (choice) {
    target = choice.option.collection
      ? { collectionId: choice.option.collection.id }
      : { schemeDefault: true };
  }
  const spinner = startBusy(btn);
  try {
    // The normalized form, not the raw input: the store normalizes
    // again internally (a no-op on an already-canonical value), and for
    // a github blob URL the raw input would cost a second Contents-API
    // round trip that can fail after the user has already clicked
    // Install.
    const result = target
      ? await installScript(previewLocation, target)
      : await addCollection(previewLocation);
    if (!result) {
      // Raced another tab (or the same URL under a different spelling
      // that normalizes to an already-installed one). Re-run the
      // wiring so the page converges on the table instead of offering
      // an Install that can only repeat this message.
      setMessage(ALREADY_INSTALLED_IN_TARGET);
      await wireInstallButtons();
      return;
    }
    const scriptId =
      result.kind === 'existingContainer'
        ? result.scriptId
        : result.collection.scriptIds[0];
    // Only a single-file install has one script to speak for. The
    // preview keeps its Install button for other shapes too (a bare
    // `.js` file, a manifest URL), and those land a whole collection
    // whose `scriptIds[0]` is whatever the scan ordered first —
    // arbitrary enough for a navigation target, not something to
    // rewrite enable state from.
    if (scriptId && isSingleFileInput(previewLocation)) await soloRunningCopy(scriptId);
    location.href = scriptId
      ? viewerUrl(scriptId)
      : 'collections.html';
  } catch (err) {
    setMessage(`Install failed: ${describeError(err)}`, 'error');
  } finally {
    spinner.remove();
    btn.disabled = false;
  }
}

// ---------- Move (installed viewer) ----------

// What the last panel paint learned, reused by the Move picker so it
// opens with no I/O at all.
//
// Why it can't just read the store: `readStoreSnapshot` is a
// `storage.local.get(null)`, which deserializes EVERY row — including
// every script's full source and every `gmval:` value — to answer a
// question about `fileUrl` and `collectionId`. That is a visible pause
// on a click, and the panel has already paid it. Written by every
// successful paint and never cleared, so after a paint that failed it
// holds the last good answer rather than nothing — which is the right
// trade for a list the store re-validates anyway: `moveScript` checks
// under the write lock, so a stale entry costs a message, never a bad
// move.
let moveTargetContext: {
  collections: readonly StoredCollection[];
  sameLocation: readonly RelatedScript[];
} | null = null;

// The Move button, to the right of the Collection row's display name.
// Everything it does happens in the move dialog (src/extension/move-dialog.ts);
// this is the affordance and the store write that follows.
//
// Only for a script inside a container ("individual scripts")
// collection: a directory or manifest script's `relativePath` is
// relative to its collection root, so it has no absolute spelling to
// carry into a container. `moveScript` refuses those too.
// The controls in the row under the heading, between the Enabled box
// and Refresh: Local copy… for every script, and the trash can for a
// script that IS a local copy. They act on the script the page is
// showing, which is what the rest of that row is about — the Collection
// row below keeps only Move…, which acts on the collection membership.
//
// A collection row we couldn't read costs the trash can, not the whole
// group: without it there is no way to tell a local copy from any other
// script.
function makeScriptActions(
  script: StoredScript,
  collection: StoredCollection | null,
): HTMLElement[] {
  const actions = [makeLocalCopyControl(script)];
  if (collection) actions.push(makeDeleteCopyControl(script, collection));
  return actions;
}

// The trash can beside Local copy…, for a script that IS a local copy:
// its file sits in the Downloads copies directory, which is the one
// place SourceMonkey can delete a file from. Everything it does happens
// in the delete dialog (src/extension/delete-dialog.ts); this is the affordance,
// and the record removal that follows the file's.
//
// Hidden until the setting says the file qualifies. The row is painted
// synchronously and the answer needs a storage read, so the button is
// built off-screen and revealed rather than the whole row waiting on
// it — a script that isn't a copy never shows one at all.
function makeDeleteCopyControl(
  script: StoredScript,
  collection: StoredCollection,
): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.id = 'delete-copy-btn';
  btn.className = 'remove-script';
  setDeleteIcon(btn, 'file');
  btn.hidden = true;
  // Not the plain "Remove this script record" of the other trash cans:
  // this one takes the file off the disk as well. The badged glyph
  // above says that at a glance; the tooltip spells it out.
  btn.title = 'Delete local script file';
  btn.setAttribute('aria-label', 'Delete local script file');
  void readCopiesSetting().then((setting) => {
    btn.hidden = deletableCopyPath(script, collection, setting) === null;
  });
  btn.onclick = async () => {
    const result = await openDeleteDialog({ script });
    if (!result) return;
    // The record goes with the file, explicitly. A refresh would find
    // the file gone and drop the row too, but it would cost a scan of
    // the directory, and we already know the answer.
    //
    // Both flags are set BEFORE the removal, not before the rehydrate:
    // the removal's own storage event can be delivered while the write
    // is still in flight, and a not-found state painted by that
    // listener has to read as the result the user asked for — see
    // `removedHereMessage` and the panel's own `remove`.
    removedHereMessage = REMOVED_HERE;
    removedHereDetail = result.dependencyErrors;
    try {
      await removeScript(result.scriptId);
    } catch (err) {
      removedHereMessage = null;
      removedHereDetail = [];
      setMessage(`The file was deleted, but its record could not be removed: ${describeError(err)}`, 'error');
      return;
    }
    await rehydrateAfterStorageChange();
  };
  return btn;
}

// Local copy…: write an editable copy of this script into the
// Downloads collection, switch every other copy off, and show the new
// one. The dialog owns the write and its failures — see
// `src/extension/copy-dialog.ts` and docs/local-copy.md.
function makeLocalCopyControl(script: StoredScript): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.id = 'local-copy-btn';
  btn.textContent = 'Local copy…';
  // An `invalid` row has no usable header — often no metadata block at
  // all — so a copy of it would be written with none of the header
  // edits the dialog offers and would land invalid in its turn.
  // `missing` is allowed: the row still holds the last content that
  // loaded, and rescuing it onto disk is a reason to be here.
  btn.disabled = script.status === 'invalid';
  btn.title = btn.disabled
    ? 'This script did not load, so there is nothing to copy'
    : 'Make an editable copy of this script on local disk';
  btn.onclick = async () => {
    const result = await openCopyDialog({ script });
    if (!result) return;
    // The copy is the version the user wants running now — the same
    // rule an install follows.
    await soloRunningCopy(result.script.id);
    await swapToScript(result.script.id);
  };
  return btn;
}

function makeMoveControl(
  script: StoredScript,
  collection: StoredCollection,
): HTMLButtonElement | undefined {
  if (!isContainerCollection(collection.path) || isSmDevCollection(collection.path)) return undefined;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.id = 'move-collection-btn';
  btn.className = 'collection-move';
  btn.textContent = 'Move…';
  btn.title = 'Move this script to another collection';
  btn.onclick = () => void openMove(btn);

  // Everywhere an install could land, with the collection the script
  // is in now marked as the current one — listed, disabled, and what
  // the dialog opens on.
  const targetsFrom = (
    ctx: { collections: readonly StoredCollection[]; sameLocation: readonly RelatedScript[] },
  ): readonly InstallOption[] | undefined => installOptionsFor(
    locationKey(script.fileUrl), ctx.sameLocation, ctx.collections, collection.id,
  );

  const openMove = async (button: HTMLButtonElement): Promise<void> => {
    let options = moveTargetContext ? targetsFrom(moveTargetContext) : undefined;
    // Only before the first panel paint has landed — it is fired off by
    // the same render that built this button, so the user has to be
    // quick. Reading the store here costs the pause the cache exists to
    // avoid, which is why it is the fallback and not the path.
    if (!moveTargetContext) {
      const spinner = startBusy(button);
      try {
        const snapshot = await readStoreSnapshot();
        const related = findRelatedVersions({
          ...snapshot,
          location: script.fileUrl,
          header: script.header ?? null,
        });
        options = targetsFrom({
          collections: snapshot.collections, sameLocation: related.sameLocation,
        });
      } catch (err) {
        setMessage(`Could not list collections: ${describeError(err)}`, 'error');
        return;
      } finally {
        spinner.remove();
        button.disabled = false;
      }
    }
    if (!options) {
      // `installOptionsFor` declines anything that isn't a single-file
      // location, and every container row is one — so a row that lands
      // here was written by something that shouldn't have.
      setMessage(MOVE_NOT_AVAILABLE, 'error');
      return;
    }
    // The dialog owns the move itself, errors included; it resolves
    // only once something actually moved.
    const moved = await openMoveDialog({ scriptId: script.id, options });
    if (!moved) return;
    // This control closed over the collection the script WAS in, so
    // until the repaint replaces it a second click would build the
    // list with the wrong `current`. The repaint is already on its
    // way; retiring the button is what covers the gap.
    button.disabled = true;
    // A move out of a disabled collection into an enabled one starts
    // the script, which makes it the copy that should be running.
    await soloRunningCopy(script.id);
    // Nothing to repaint by hand: the row's `collectionId` changed, so
    // the page's own `storage.onChanged` listener rehydrates the
    // header — Collection row, Move button and all.
  };

  return btn;
}

// A row whose stored location isn't a single-file one, which no
// container row should ever hold.
const MOVE_NOT_AVAILABLE =
  'Internal error: this script has no single-file location to move';

// A copy that just started running follows the same exclusive rule as
// the panel's checkboxes: it is the one the user wants running, and
// leaving an older copy of the same script on means both register and
// both run on every page they match.
//
// Two callers, because both produce a copy that is newly running: a
// fresh install, and a move INTO an enabled collection from a disabled
// one. A move that changes nothing about whether the script runs finds
// the sweep already done and is a no-op.
//
// Skipped whenever the copy won't itself run — it landed `invalid`, or
// its container collection is disabled. Switching a working copy off in
// favour of one that can't run would leave nothing running at all.
//
// Fails open and never blocks the navigation to the new script's page.
// The install itself succeeded; if the sweep didn't, the panel on that
// page is right there to fix the enable state by hand.
async function soloRunningCopy(scriptId: string): Promise<void> {
  try {
    const snapshot = await readStoreSnapshot();
    const copy = snapshot.scripts.find((s) => s.id === scriptId);
    if (!copy || copy.status !== 'ok') return;
    // Read the location and header off the STORED row rather than the
    // preview's: they are what the rest of the store will be compared
    // against from now on, and for a github blob URL the stored
    // `fileUrl` is the resolved raw one.
    const related = findRelatedVersions({
      ...snapshot,
      location: copy.fileUrl,
      header: copy.header ?? null,
    });
    const rows = allRelatedRows(related);
    // The other half of the "will it run" test: the row lands
    // `enabled`, but its container collection may be disabled, and
    // installing into a collection the user has turned off must not
    // leave every copy of the script dark. `isRunning` is the same
    // predicate the sweep applies to the rows it switches off.
    //
    // `own` can't actually be missing — the lookup ran on this row's
    // own `fileUrl`, so it always matches itself — but a partially
    // written store must not take the install's navigation down with
    // it.
    const own = rows.find((r) => r.script.id === scriptId);
    if (!own || !isRunning(own)) return;
    await applyEnableChanges(enableChanges(scriptId, true, rows));
  } catch (err) {
    dlog(`[SourceMonkey] exclusive-enable sweep skipped: ${describeError(err)}`);
  }
}

// Show the unprocessed file in a new tab, leaving the preview open
// behind it.
//
// This is also the escape hatch for a `.user.js` the user opened to
// *read* rather than install — the cost of capturing `file://` — so it
// has to work whether or not the fetch succeeded.
//
// Always a real navigation, on every scheme: Chrome renders a
// `.user.js` as source text whether it came over http or off disk, so
// the tab shows the actual file at its actual address.
//
// Which address depends on whether we could read the location:
//
//   - **Read it** — the canonical location, not what the user typed.
//     A GitHub blob URL was rewritten to its raw counterpart before we
//     fetched it, and the raw file is the source this page describes;
//     navigating to the blob URL would open GitHub's file browser
//     instead.
//   - **Couldn't** — the user's own input, when it is navigable. That
//     is the form that can carry site cookies our fetch doesn't: a
//     private repo's blob page renders for a logged-in user, where its
//     `raw.githubusercontent.com` counterpart 404s without a token.
//     So the failed-fetch case is also the retry, which is the whole
//     reason this button has to work when nothing was fetched.
//
// The two agree except where canonicalization rewrote the URL, which
// today means GitHub blob links added through the collections page.
//
// `previewFileUrl` is empty until `normalizeCollectionInput` resolves
// one, and stays empty if it threw — the only case with no address to
// offer at all, and the only one that reports instead of navigating.
//
// `navigateRaw` sets a one-shot capture bypass first, `file://`
// included: the capture covers local files, so an unbypassed
// navigation would be pulled straight back into this same preview.
function openRawSource(): void {
  const typed = isHttpUrl(previewInput ?? '') ? (previewInput ?? '') : '';
  const url = previewText ? previewFileUrl : typed || previewFileUrl;
  if (!url) {
    setMessage('There is no source to open for this location', 'error');
    return;
  }
  navigateRaw(url);
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
function withBypass(url: string, go: (url: string) => void | Promise<void>): void {
  markInstallBypass(url)
    .then(() => go(url))
    .catch((err) => {
      setMessage(`Could not open ${url}: ${describeError(err)}`, 'error');
      // Chrome refuses to navigate a tab to a `file://` URL while
      // "Allow access to file URLs" is off, and says so in terms that
      // don't name the setting. The banner does.
      showFileAccessBannerIfBlocked(url);
    });
}

// Open the real URL in a new tab, leaving this preview in place.
//
// The `tabs.create` promise is handed back to `withBypass` rather than
// dropped: it rejects for reasons the user can act on — a `file://`
// target with "Allow access to file URLs" off is refused outright —
// and an unhandled rejection in an extension page is reported into
// chrome://extensions/?errors, where it reads as SourceMonkey being
// broken instead of a setting being off.
function navigateRaw(url: string): void {
  withBypass(url, (target) => chrome.tabs.create({ url: target }).then(() => undefined));
}

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

// Show the collections page's file-access banner when a local read
// failed *and* the toggle is the plausible reason.
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
// toggle explains. A local script flagged for a header problem or a
// syntax error is flagged for a reason the toggle had nothing to do
// with, and putting the banner under that message would offer an
// unrelated setting as the explanation.
//
// Told apart by the URL: every fetch helper in `directories.ts` names
// the thing it couldn't read (`Could not read <url>: …`), and no parse
// or validation message does. Still true of rows persisted under the
// older wording, which named the URL too. Deliberately
// matched against this script's own `fileUrl`, so a failed `@require`
// against some other host doesn't count either.
function readFailed(script: StoredScript): boolean {
  const message = script.errorMessage ?? script.refreshError;
  return message !== undefined && message.includes(script.fileUrl);
}

function renderBanner(content: BannerContent, extraClass = ''): void {
  replaceBanner(makeBanner(content, extraClass));
}

// The one way to replace what the banner slot says. Every caller
// REPLACES rather than appends, and each one can run after the parse
// check has reported — `doInstall` discovering the script is already
// installed, say — so each would otherwise silently delete a "this has
// a syntax error" warning the user is mid-way through reading. Going
// through here means a new banner path can't reintroduce that.
function replaceBanner(banner: HTMLElement): void {
  // Dropped on every path, and re-set by the one banner that wants it.
  // The merged box belongs to "this script is already installed"; a
  // file-access or parse banner replacing it must not inherit a green
  // card drawn around a table it says nothing about.
  statusBoxEl.classList.remove('merged');
  bannerSlotEl.replaceChildren(banner);
  for (const warning of previewWarnings) bannerSlotEl.append(makeBanner(warning));
}

// A banner's text, optionally with somewhere in the script to point at.
// Plain strings stay plain strings — most banners ("already installed",
// "not installed yet") aren't about the content at all.
//
// `lead` is a bold opening clause on the same line as the rest, which
// `.banner strong` normally renders as its own line and
// `.banner.installed strong` keeps inline. Passed as its own field
// rather than glued onto the message so the space between the two
// can't go missing in a literal.
interface PreviewWarning {
  message: string;
  location?: DiagnosticLocation;
  // Anything to say AFTER the location. Kept separate rather than
  // glued onto `message` so the location stays in the middle of the
  // sentence where it reads naturally — "…Syntax error: X (in f, line
  // 3). Installing it will store it as INVALID."
  trailing?: string;
  // Bold opening clause, rendered before `message` on the same line.
  lead?: string;
}

type BannerContent = string | PreviewWarning;

function makeBanner(content: BannerContent, extraClass = ''): HTMLElement {
  const div = document.createElement('div');
  div.className = extraClass ? `banner ${extraClass}` : 'banner';
  const p = document.createElement('p');
  if (typeof content === 'string') {
    p.textContent = content;
  } else {
    if (content.lead) {
      const lead = document.createElement('strong');
      lead.textContent = content.lead;
      p.append(lead, ' ');
    }
    appendDiagnostic(p, content.message, content.location);
    if (content.trailing) p.append(content.trailing);
  }
  div.append(p);
  return div;
}

// Any copy exists — here, from a mirror, or several. Which ones, and
// what each can do, is the table's job — so the table is drawn inside
// this banner's box rather than under it (the `merged` class), and the
// wording names the choice without having to point anywhere.
//
// "instance", not "version": the table has a Version column holding
// `@version` strings, and asking the user to pick a version next to it
// would read as picking one of those rather than one of the rows.
function renderInstalledBanner(): void {
  // One line: the bold statement and what to do about it, with the
  // table of copies directly under it inside the same box. Two
  // sentences, so unlike every other user-visible string in the
  // extension this one is punctuated — see docs/diagnostics.md#wording.
  replaceBanner(makeBanner({
    lead: 'This script is already installed.',
    message: 'Select which instance to update or install.',
  }, 'installed'));
  statusBoxEl.classList.add('merged');
}

// No banner — the install callout carries the page's question — but
// the parse check's warnings stay.
function clearBanner(): void {
  statusBoxEl.classList.remove('merged');
  bannerSlotEl.replaceChildren();
  for (const warning of previewWarnings) bannerSlotEl.append(makeBanner(warning));
}

function startBusy(btn: HTMLButtonElement): HTMLElement {
  btn.disabled = true;
  const spinner = document.createElement('span');
  spinner.className = 'busy-spinner';
  btn.after(spinner);
  return spinner;
}

// ---------- Shared rendering ----------

// `<prefix>` `<favicon>` `<label>`. A label that fell back to the
// location is percent-decoded — for a script installed from (or
// previewed at) a URL the encoded form is unreadable. renderSiteIconInto
// paints a clickable globe placeholder synchronously (when the script
// targets a usable origin) and swaps it for the real favicon once the
// fetch resolves.
function renderHeading(
  prefix: string,
  label: string,
  // The script's location. Not drawn — it goes on the heading's
  // `aria-label`, for the one case the visible heading can't tell
  // apart: two installed copies of one script share an `@name`, and
  // switching between them from the versions panel repaints in place —
  // with focus parked on this `<h1>` whenever the switch didn't come
  // from the table itself (Back / Forward; see `showSelectedScript`).
  // Without it a screen reader hears the same heading before and after
  // the switch. Dropped when the label already IS the location.
  location: string,
  script: Parameters<typeof renderSiteIconInto>[1],
  // Local override scope for the script's `@icon`. Installed mode passes
  // its collection's; the preview passes a bare `enabled` outright, the
  // same way its `@require` / `@resource` resolution does — a file the
  // user pointed at directly has no collection row to consult.
  localFiles: LocalFileScope = { enabled: true },
): void {
  notePainted();
  filenameEl.replaceChildren();
  filenameEl.appendChild(headingPrefixEl(prefix));
  const iconSlot = document.createElement('span');
  iconSlot.className = 'site-icon';
  filenameEl.appendChild(iconSlot);
  appendWithSlashBreaks(filenameEl, label);
  // An aria-label rather than a clipped span: the location must not
  // land in `textContent`, which is what a copy/paste of the heading —
  // and every test assertion on it — reads. The comma is there so a
  // screen reader pauses instead of running the path onto the name.
  if (location && location !== label) {
    filenameEl.setAttribute('aria-label', `${prefix}${label}, ${location}`);
  } else {
    filenameEl.removeAttribute('aria-label');
  }
  void renderSiteIconInto(
    iconSlot, script, localSearchRoots(script.fileUrl, localFiles), HEADING_SITE_ICONS,
  );
}


function setMessage(text: string, kind: '' | 'error' | 'refresh-failed' = ''): void {
  messageEl.textContent = text;
  messageEl.className = kind ? `message ${kind}` : 'message';
}

// ---------- Clickable diagnostics ----------
//
// Everything SourceMonkey concludes from a script's *content* — a
// metadata block that never closes, a missing `@match`, a `@require`
// that won't load, a syntax error — arrives with a `DiagnosticLocation`
// naming the file and usually the line. This is the half that turns
// that into a place the reader can click through to.

// The file identity a diagnostic uses for the script's OWN body: its
// `relativePath` when installed, the previewed location otherwise.
//
// Only the main script needs recording. A `@require` is named by its
// resolved URL in both a diagnostic and its tab's `fileUrl`, so those
// match directly — but the main tab's `fileUrl` is the script's
// *fetchable* URL (absolute `file://` / `https://`), which is not what
// the source map calls it.
let mainDiagFile = '';

function findTabForLocation(file: string): number {
  if (file && file === mainDiagFile) return 0;
  return tabsView.tabs.findIndex((t) => t.kind === 'code' && t.fileUrl === file);
}

// Paint `<message> (in <where>)` into `el`, with the "where" a link
// that selects the tab and highlights the line.
//
// Falls back to exactly the string `describeDiagnostic` produces
// whenever there is no tab for the file. That is a real case rather
// than a defensive one: a `@require` whose fetch failed never gets a
// tab, and telling the reader which declaration is at fault is worth
// having even when we can't take them to it.
function appendDiagnostic(
  el: HTMLElement,
  message: string,
  location: DiagnosticLocation | undefined,
): void {
  const tabIndex = location ? findTabForLocation(location.file) : -1;
  const tab = tabIndex >= 0 ? tabsView.tabs[tabIndex] : undefined;
  if (!location || !tab || tab.kind !== 'code') {
    el.append(describeDiagnostic(message, location));
    return;
  }
  el.append(`${message} (in `);
  const a = document.createElement('a');
  a.className = 'diagnostic-link';
  // A real fragment rather than `href="#"`, so the link is copyable and
  // shows where it goes. It names the same place the click handler
  // navigates to — `goToTabLine` rebuilds this exact hash afterwards.
  const fragment = buildHash({
    tab: tabIndex === 0 ? 'main' : 'require',
    filename: tab.label,
    line: location.line,
    col: location.column,
  });
  a.href = fragment ? `#${fragment}` : '#';
  a.textContent = locationLabel(location);
  a.addEventListener('click', (ev) => {
    // Navigating in the handler rather than letting the fragment do it:
    // clicking a link whose hash already matches the URL fires no
    // `hashchange`, so a second click after scrolling away would sit
    // there doing nothing.
    ev.preventDefault();
    tabsView.goToTabLine(tabIndex, location.line, location.column);
  });
  el.append(a, ')');
}

// `setMessage` for a diagnostic that knows where it came from.
function setDiagnosticMessage(
  message: string,
  location: DiagnosticLocation | undefined,
  kind: 'error' | 'refresh-failed',
): void {
  setMessage('', kind);
  appendDiagnostic(messageEl, message, location);
}

function showMissing(message: string): void {
  currentScript = null;
  // Focus standing in the panel is about to be destroyed with it, and
  // no paint will run to put it anywhere (see `lastRelatedPaint` below)
  // — so the heading takes it, same as every other path that loses the
  // row it was going to.
  const focusInPanel = versionsEl.contains(document.activeElement);
  controlsRowEl.hidden = true;
  actionsEl.hidden = true;
  // With the rest: both controls close over the row that has gone, and
  // the row they sit in is only hidden, not emptied.
  metaActionsEl.replaceChildren();
  bannerSlotEl.replaceChildren();
  // No script to name, but the heading keeps its product prefix so it
  // doesn't change shape between this and a script that loaded.
  //
  // The bare product prefix in BOTH modes: the preview's carries the
  // verb ("SourceMonkey | Install | "), and there is nothing here for
  // it to offer — with no script to install, dropping the verb stops
  // the heading promising an offer this page isn't making.
  notePainted();
  filenameEl.replaceChildren();
  filenameEl.removeAttribute('aria-label');
  filenameEl.append(headingPrefixEl(INSTALLED_HEADING), MISSING_LABEL);
  // The title too, or the tab keeps advertising a script that is gone —
  // this path is reached by removing the script the viewer is open on,
  // not only by opening a bad URL.
  setPageTitle(INSTALLED_TITLE, MISSING_LABEL);
  setMessage(message, 'error');
  summaryEl.replaceChildren();
  // The panel goes with the rest. Its rows carry live toggles and trash
  // cans keyed to script ids, and its heading — "Other versions of THIS
  // script" — has nothing left to be other than. Reached when another
  // tab removes the script out from under us, and when the panel's own
  // trash can takes the last copy there was to switch to.
  versionsEl.replaceChildren();
  // And the bookkeeping that would paint it back: a `storage.session`
  // change matching one of the ids we just wiped would otherwise
  // rebuild the table on top of the "not available" page.
  lastRelatedPaint = null;
  lastRelatedIds = new Set();
  statusBoxEl.classList.remove('merged');
  logPaneEl.replaceChildren();
  tabsView.clear();
  pendingRowFocusId = '';
  if (focusInPanel) filenameEl.focus();
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

  // Toolbar with the log-wide actions. Sticky so they stay visible as
  // the user scrolls through a long log. Clear stays rightmost — it is
  // the destructive one, and it was there before Save/Copy joined it,
  // so its position doesn't move under anyone's cursor.
  const toolbar = document.createElement('div');
  toolbar.className = 'log-toolbar';

  // Both carry over whatever outcome they are still reporting when a
  // new log entry forces this repaint — see `reportLogAction`.
  const saveBtn = logActionButton(
    'save',
    'Save this log to a CSV file',
    () => void onSaveLog(entries),
  );
  saveBtn.disabled = entries.length === 0;

  const copyBtn = logActionButton(
    'copy',
    'Copy this log to the clipboard as CSV',
    () => void onCopyLog(entries),
  );
  copyBtn.disabled = entries.length === 0;

  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.textContent = 'Clear log';
  clearBtn.addEventListener('click', () => void onClearLog());

  toolbar.append(saveBtn, copyBtn, clearBtn);
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
  for (const h of LOG_COLUMNS) {
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
    badge.className = `log-level-badge ${logStatusClass(e)}`;
    badge.textContent = formatLogStatus(e);
    tdLevel.appendChild(badge);
    tr.appendChild(tdLevel);

    const tdSource = document.createElement('td');
    tdSource.className = 'log-source';
    tdSource.textContent = formatLogSource(e);
    tr.appendChild(tdSource);

    const tdMsg = document.createElement('td');
    tdMsg.className = 'log-msg';
    if (e.location) {
      // A location SourceMonkey derived (a bad header line, a syntax
      // error) rather than one scraped out of a stack trace. It is
      // already structured, so it needs none of the remapping the ref
      // scanner below does — and the message it belongs to is our own
      // prose, which has no refs in it to scan for.
      appendDiagnostic(tdMsg, e.message, e.location);
    } else {
      appendLogMessageContent(tdMsg, e.message, e.timestamp);
    }
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
  // Use it as it stands: a frame from another file, or a body line of a
  // script with no `@require`s, where nothing moved in the first place.
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
  'Recorded before the current version of this script, so the file and line may not match.';

function resolveLogRef(ref: StackRef, timestamp: number): ResolvedRef {
  if (ref.url !== stackEntryUrl) return { kind: 'asIs' };
  if (stackSegments.length === 0) {
    // No requires: generated line N is original line N, except the
    // wrap's closing line just past the body (see `stackBodyLineCount`).
    return ref.line > stackBodyLineCount ? { kind: 'unmappable' } : { kind: 'asIs' };
  }
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
function setRefText(el: HTMLElement, run: ResolvedRun): void {
  el.textContent = run.shown;
  const title = refTitle(run);
  if (title) el.title = title;
}

// A ref with no tab to link to. Stays a bare text node unless there is
// a tooltip to carry, which needs an element.
function refNode(run: ResolvedRun): Node {
  const title = refTitle(run);
  if (!title) return document.createTextNode(run.shown);
  const span = document.createElement('span');
  span.textContent = run.shown;
  span.title = title;
  return span;
}

// What a ref's tooltip should say: the wire form when decoding changed
// what is on screen, and the staleness caveat when the entry predates
// the layout that mapped it. Empty when there is nothing to add.
function refTitle(run: ResolvedRun): string {
  const parts: string[] = [];
  if (run.shown !== run.raw) parts.push(run.raw);
  if (run.stale) parts.push(STALE_REF_NOTE);
  return parts.join('\n');
}

// One piece of a log message after the stack refs in it have been
// resolved: `shown` is the text to display, and the rest says whether
// it can be clicked and what its tooltip carries.
//
// Splitting this out of the painting is what lets the Log tab and the
// exported CSV say the same thing. A ref is remapped to the file it
// was written in and decoded for reading, and both of those have to
// happen before the text exists — so a renderer that starts from the
// stored message (as an export naturally would) reports the generated
// coordinate inside our concatenated entry, which names the wrong file
// at a line the reader has no way to place.
interface ResolvedRun {
  // Display text. For a plain-text run this is the text verbatim.
  shown: string;
  // Wire form of a ref run, for the tooltip. Equal to `shown` when
  // nothing was decoded, and unused for text runs.
  raw: string;
  // Where a linkable ref points, and the tab it lands in (-1 for text
  // runs, refs outside this script, and refs into our own wrap).
  ref?: StackRef;
  tabIndex: number;
  stale: boolean;
}

function resolveLogMessageRuns(message: string, timestamp: number): ResolvedRun[] {
  return parseStackRefs(message).map((run) => {
    if (run.kind === 'text') {
      return { shown: run.text, raw: run.text, tabIndex: -1, stale: false };
    }
    // One `raw` and one `tabIndex` for every outcome, so that "every
    // rendered ref goes through the decode" is structural rather than a
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
    return {
      shown: displayRefText(raw, ref.url),
      raw,
      ref,
      tabIndex,
      stale: resolved.kind === 'mapped' && resolved.stale,
    };
  });
}

// A log entry's message as plain text, exactly as the table renders it
// — the same remapped, decoded refs, minus the links. This is what the
// CSV export carries; see `ResolvedRun`.
function logMessageText(entry: LogEntry): string {
  // An entry carrying a derived location has no refs to scan (the
  // message is our own prose), and the table appends the location with
  // the shared phrasing. `formatLogMessage` is that phrasing.
  if (entry.location) return formatLogMessage(entry);
  return resolveLogMessageRuns(entry.message, entry.timestamp)
    .map((run) => run.shown)
    .join('');
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
  const runs = resolveLogMessageRuns(message, timestamp);
  if (runs.length === 1 && runs[0].ref === undefined) {
    td.textContent = message;
    return;
  }
  td.replaceChildren();
  for (const run of runs) {
    if (!run.ref) {
      td.appendChild(document.createTextNode(run.shown));
      continue;
    }
    if (run.tabIndex < 0) {
      td.appendChild(refNode(run));
      continue;
    }
    const { ref, tabIndex } = run;
    const a = document.createElement('a');
    a.className = 'log-stack-link';
    a.href = '#';
    setRefText(a, run);
    a.addEventListener('click', (ev) => {
      ev.preventDefault();
      tabsView.goToTabLine(tabIndex, ref.line, ref.col);
    });
    td.appendChild(a);
  }
}

// Save / Copy hand out the same CSV text; only the transport differs,
// so both go through `formatLogCsv`.

// The File System Access picker, which is what makes Save a real "save
// as" rather than a silent drop into the downloads folder. Typed here
// because the extension builds against a DOM lib that doesn't declare
// it, and because we only use the two calls below.
interface SaveFilePicker {
  (options: { suggestedName?: string }): Promise<{
    createWritable(): Promise<{
      write(data: string): Promise<void>;
      close(): Promise<void>;
    }>;
  }>;
}

async function onSaveLog(entries: LogEntry[]): Promise<void> {
  // The click-time snapshot, deliberately: the dialog can sit open
  // while new entries land, and the file the user asked for is the log
  // they were looking at when they asked.
  const csv = formatLogCsv(entries, logMessageText);
  const filename = logFileName(currentLogId);

  // Read before anything is awaited, and called in the same turn, so
  // the click's user activation is still live — the picker refuses to
  // open without it.
  const picker = (window as unknown as { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker;
  let handle: Awaited<ReturnType<SaveFilePicker>> | null = null;
  if (picker) {
    try {
      handle = await picker({ suggestedName: filename });
    } catch (err) {
      // Closing the dialog is a decision, not a failure — falling back
      // to a download would write the file they just declined.
      if (err instanceof DOMException && err.name === 'AbortError') return;
      // Anything else means the API is there but wouldn't open here.
      // The download below still gets the log onto disk.
    }
  }

  if (!handle) {
    // No dialog: a plain download, which the browser announces itself.
    downloadLogFile(csv, filename);
    return;
  }

  try {
    const writable = await handle.createWritable();
    await writable.write(csv);
    await writable.close();
    reportLogAction('save', 'Saved');
  } catch {
    // The user already chose a destination, so a download into their
    // downloads folder would be a second file they never asked for —
    // and would read as the save having worked. Report instead.
    reportLogAction('save', 'Save failed');
  }
}

// Fallback path: a plain download, which lands in the browser's
// download folder under `filename` with no dialog. Used when the
// picker isn't available.
function downloadLogFile(csv: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  // Chrome reads the blob after the click returns, so revoking inline
  // can cancel the download. The delay is a courtesy to the page's
  // memory, not a correctness requirement — the URL dies with the page
  // either way.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// ---------- Toolbar action feedback ----------
//
// Save and Copy each report their outcome by briefly relabelling their
// own button. Both are held in module state rather than on the element
// because the pane repaints whenever a log entry arrives — an entry
// landing in the second after a click would otherwise replace the
// button and take the "Copied" the user is still reading with it.
// `paintLog` re-applies whatever is pending to the buttons it builds.

type LogAction = 'save' | 'copy';

const LOG_ACTION_LABELS: Record<LogAction, string> = { save: 'Save', copy: 'Copy' };

// How long a reported outcome stays on the button.
const LOG_ACTION_FEEDBACK_MS = 1200;

const logActionFeedback = new Map<LogAction, string>();
const logActionButtons = new Map<LogAction, HTMLButtonElement>();
const logActionTimers = new Map<LogAction, ReturnType<typeof setTimeout>>();

function logActionLabel(action: LogAction): string {
  return logActionFeedback.get(action) ?? LOG_ACTION_LABELS[action];
}

// Say what just happened, then fall back to the idle label. `label` of
// null resets immediately.
function reportLogAction(action: LogAction, label: string | null): void {
  if (label === null) logActionFeedback.delete(action);
  else logActionFeedback.set(action, label);

  const btn = logActionButtons.get(action);
  if (btn) btn.textContent = logActionLabel(action);

  // A fresh timer per report, so rapid clicks reschedule rather than
  // letting an early one cut the latest feedback short.
  const pending = logActionTimers.get(action);
  if (pending !== undefined) clearTimeout(pending);
  logActionTimers.delete(action);
  if (label === null) return;
  logActionTimers.set(action, setTimeout(() => {
    logActionTimers.delete(action);
    reportLogAction(action, null);
  }, LOG_ACTION_FEEDBACK_MS));
}

// One toolbar button, wearing whatever its action is currently
// reporting.
function logActionButton(
  action: LogAction,
  title: string,
  onClick: () => void,
): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = logActionLabel(action);
  btn.title = title;
  // The relabel IS the feedback, and a button's name is not announced
  // again on its own — so mark it live for a screen reader.
  btn.setAttribute('aria-live', 'polite');
  btn.addEventListener('click', onClick);
  logActionButtons.set(action, btn);
  return btn;
}

async function onCopyLog(entries: LogEntry[]): Promise<void> {
  let label = 'Copied';
  try {
    await navigator.clipboard.writeText(formatLogCsv(entries, logMessageText));
  } catch {
    // The clipboard write can be refused (no permission, page not
    // focused). Say so on the button — unlike the Location row, the
    // log is not selectable text the user can fall back to copying by
    // hand, so silence would read as a copy that worked.
    label = 'Copy failed';
  }
  reportLogAction('copy', label);
}

async function onClearLog(): Promise<void> {
  if (!scriptId) return;
  await clearScriptLog(scriptId);
  // Drop any outcome Save/Copy are still reporting: it is about a log
  // that no longer exists, and the repaint below disables those
  // buttons — a greyed-out "Copied" reads as a broken control.
  reportLogAction('save', null);
  reportLogAction('copy', null);
  // Paint the empty state ourselves rather than waiting for the
  // storage.onChanged listener, which fires shortly with the same empty
  // state — so the second paint is a visual no-op. Not instant: the
  // clear above is a message hop to the worker (which owns the log's
  // writes — see script-log.ts) and may have to wake it. Bump the epoch
  // so any in-flight renderLogPane() read can't undo this.
  logPaintEpoch++;
  paintLog([]);
}

