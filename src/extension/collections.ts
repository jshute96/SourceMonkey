// Collections page controller. Renders one section per registered
// collection (a local directory of userscripts, an http(s) directory or
// JSON manifest, a GitHub tree, or a "scripts" collection — a folder of
// individually installed scripts, user-created or one of the built-in
// defaults), with Remove / Edit / Refresh buttons and a script table
// showing name, size, and parse status.
//
// The Add field routes by what was typed: a single `.user.js` goes to
// the install page; anything else opens the create-collection dialog
// (src/extension/collection-dialog.ts), prefilled from a location or a name. The
// dialog probes a location before creating from it and loads every
// script it finds as part of the create, so the user doesn't need to
// click Refresh after add.
//
// The initial `render()` runs once at load to draw banners and seed
// every section. After that the page keeps itself current by REPAINTING
// FROM STORAGE: any write to the structural rows — by this page, the
// viewer, the background refresher, or another tab — marks it dirty, and
// the repaint re-reads storage and makes the DOM match. Sections and
// rows are reconciled by id and updated in place, so busy spinners,
// refresh highlights and focus survive. See docs/storage.md.
//
// The per-control toggles are the exception: they mutate their own row
// directly for immediate feedback, and show a small spinner while their
// write is in flight. The repaint is careful not to overwrite a control
// whose spinner is up.

import { scriptRowBytes } from './script-blobs.js';
import { openDeleteDialog } from './delete-dialog.js';
import { setDeleteIcon } from './delete-icon.js';
import { setGlyphButton, setGlyphButtonBusy } from './glyph.js';
import type { DownloadsCopiesSetting } from './local-copy.js';
import { deletableCopyPath, readCopiesSetting } from './local-delete.js';
import {
  DEFAULT_COLLECTIONS,
  describeError,
  needsDisplayName,
  getAllScriptMetas,
  getCollectionWithScriptMeta,
  getScriptMetas,
  getCollectionsById,
  getCollections,
  isFirstRunComplete,
  isScriptEnabled,
  isCollectionEnabled,
  readLocalStorageUsage,
  localFileScope,
  STORAGE_NEARLY_FULL,
  type ScriptMeta,
  type StoredCollection,
} from './script-store.js';
import {
  addCollection, updateAllCollections, updateCollection, updateScript,
  backfillCollectionDisplayNames, markFirstRunComplete, moveCollection, reconcileScriptMembership, removeCollection, syncAfterUserScriptsAllowed,
  removeScript, setAllScriptsEnabled, setCollectionEnabledExclusive, setScriptEnabledExclusive,
} from './worker-client.js';
import { identityKey } from './script-identity.js';
import { watchSoloModifier } from './solo-click.js';
import {
  installLocalRootsListener,
  localRootsReady,
  localSearchRoots,
  type LocalFileScope,
} from '../local-file-overrides.js';
import {
  COLLECTION_OFF_TITLE,
  effectiveDisplayName,
  makeCollectionTypeBubble,
  makeSchemeChip,
  collectionAnchorId,
  EDIT_COLLECTION_HASH_PREFIX,
} from './collection-display.js';
import { COLLECTION_PREFIX, SCRIPT_PREFIX, touchesStructuralRows } from './structural-keys.js';
import { openCollectionDialog, type CollectionDialogRequest } from './collection-dialog.js';
import { openExportDialog } from './export-dialog.js';
import { openImportDialog } from './import-dialog.js';
import { closeDetachedMenu, closeMenu, moreMenuButton, openMenu } from './more-menu.js';
import { onNamedTabFocus, openExtensionTab, openNamedTab } from './page-links.js';
import { getValue } from '../userscript-header.js';
import { describeDiagnostic } from '../diagnostic-location.js';
import { installDebugLoggingListener, isDebugLoggingEnabled, loadDebugLoggingFlag } from '../debug-log.js';
import { startPhaseTimer, type PhaseTimer } from '../phase-timing.js';
import {
  appendWithSlashBreaks,
  compareScriptNames,
  displayLocation,
  effectiveScriptStatus,
  ENABLE_TITLE,
  formatBytes,
  formatStorageUsage,
  formatScriptSize,
  formatScriptStatusLabel,
  previewUrl,
  scriptBasename,
  scriptDisplayName,
  scriptOutdatedProbe,
  viewerUrl,
} from '../script-display.js';
import { probeLabel, type VersionProbe } from '../version-probe.js';
import {
  LOG_LEVEL_KEY_PREFIX,
  getAllMaxLogLevels,
  type LogLevel,
} from './script-log.js';
import {
  REJECTIONS_KEY,
  coerceRejectionMap,
  readRejections,
  type RejectionMap,
} from './script-rejection.js';
import {
  REFRESH_ERRORS_KEY,
  coerceRefreshErrorMap,
  describeRefreshError,
  readRefreshErrors,
  type RefreshErrorMap,
} from './refresh-error.js';
import { iconRefFromHeader } from '../script-icon.js';
import { preloadSiteIcons, renderSiteIconInto } from './site-icon.js';
import {
  mapWithConcurrency,
  FETCH_COLLECTIONS_CONCURRENCY,
  FETCH_SCRIPTS_PER_COLLECTION_CONCURRENCY,
} from './concurrency.js';
import {
  localRefreshTargets,
  pathRefreshTargets,
  refreshPathProblem,
  REFRESH_FAILED_PREFIX,
  type CollectionScripts,
  type RefreshTargets,
} from './refresh-targets.js';
import {
  canonicalCollectionInput,
  isContainerCollection,
  isSmDevCollection,
  isValidLocationShape,
  LOCATION_SHAPES,
  isSingleFileInput,
  normalizeCollectionInput,
} from './directories.js';
import {
  markFileChanges,
  manifestToProbe,
  pendingOnDisk,
  refreshPendingHint,
  scriptFileTag,
  syncRefreshPendingChip,
  tagLocalFile,
} from './file-changes.js';
import {
  installGithubAuthListener,
  loadGithubAuthToken,
} from '../github-auth.js';
import {
  isFileSchemeAccessAllowed,
  renderFileAccessBanner,
} from './file-access.js';
import { probeUserScriptsApi, USER_SCRIPTS_OFF_HEADING, userScriptsFixLine } from './user-scripts-access.js';

// The page needs its own copy of the cached GitHub token for the reads
// it still makes itself (the collection dialog's location probe).
// Refreshes run in the worker, which waits for its own copy.
installGithubAuthListener();
const githubTokenReady = loadGithubAuthToken();

const bannerSlot = document.getElementById('banner-slot')!;
const collectionsEl = document.getElementById('collections')!;
const addForm = document.getElementById('add-form') as HTMLFormElement;
const addInput = document.getElementById('add-path') as HTMLInputElement;
const addButton = addForm.querySelector('button[type="submit"]') as HTMLButtonElement;
const refreshAllBtn = document.getElementById('refresh-all') as HTMLButtonElement;
const openOptionsBtn = document.getElementById('open-options') as HTMLButtonElement;
const addErrorEl = document.getElementById('add-error') as HTMLParagraphElement;

addForm.addEventListener('submit', (event) => {
  event.preventDefault();
  void onAddViaDialog(addInput.value, true);
});

// The per-collection Refresh, in one place: `renderCollection` builds
// the button with the idle label and `onRefreshCollection` puts it back
// after a refresh, so the two must not drift.
const REFRESH_COLLECTION_LABELS = {
  idle: 'Refresh this collection',
  busy: 'Refreshing this collection…',
};

setGlyphButton(refreshAllBtn, '#sm-refresh', 'Refresh all collections', { text: 'Refresh All' });
refreshAllBtn.addEventListener('click', () => void onRefreshAll());

// The page's ⋯ menu, right of Refresh All: actions on every collection.
const pageMenuBtn = moreMenuButton('More actions');
pageMenuBtn.id = 'page-menu';
pageMenuBtn.title = 'More actions';
pageMenuBtn.addEventListener('click', () => openMenu(pageMenuBtn, [
  { label: 'Import scripts\u2026', run: () => void runImport() },
  { label: 'Export all collections\u2026', run: () => openExportDialog({ scope: { all: true } }) },
]));

// The import dialog, then the collection its new scripts went into.
async function runImport(collectionId?: string): Promise<void> {
  const landed = await openImportDialog({ collectionId });
  if (!landed) return;
  await repaintPage();
  jumpToCollection(landed);
}
refreshAllBtn.after(pageMenuBtn);
// The menu is fixed in place, so it would stay put while its button
// scrolls or the layout moves it.
window.addEventListener('scroll', closeMenu, { passive: true });
window.addEventListener('resize', closeMenu);

// A new tab, not this one: the collections page is where the user was
// working, and Options is a detour. `openNamedTab` reuses the one
// Options tab if it is already open rather than stacking up copies.
openOptionsBtn.addEventListener('click', () => {
  void openNamedTab('options');
});

// Resolved once the first render has finished painting, which is what
// repaints wait for. `render()` empties the container and refills it
// across several awaits, and a repaint inside that window would build
// sections the render loop hasn't reached yet — each would append its
// own copy.
//
// Deliberately the RENDER, not all of `bootstrap()`. Bootstrap goes on
// to run first-run seeding, `?refresh` and `?add`, all of which
// go through handlers that repaint — waiting for bootstrap here would
// have those handlers waiting on themselves.
let resolveInitialRender!: () => void;
const initialRenderDone = new Promise<void>((resolve) => {
  resolveInitialRender = resolve;
});

// A link elsewhere asking this tab to show a particular collection. The
// tab is already loaded, so a fragment in its URL would not move it —
// see src/extension/page-links.ts.
//
// Registered below `initialRenderDone`, which the handler reads: a
// message can only arrive in a later task, so the order is safe either
// way, but a `const` read before its declaration throws a
// ReferenceError inside a message listener, where nothing would report
// it.
onNamedTabFocus('collections', (hash) => { void focusHashTarget(hash); });

installLocalRootsListener();
void bootstrap().catch((err: unknown) => {
  console.info('[SourceMonkey] collections page failed to start', err);
});

// Repaint Status cells when the per-script max-log-level row changes
// on the SW side (a fresh error / warning was appended, or the log
// was cleared), or when the injector rewrites the set of registrations
// Chrome refused. Filtering on those two keys keeps unrelated
// session-storage writes from kicking off pointless DOM walks.
if (chrome.storage?.session?.onChanged) {
  chrome.storage.session.onChanged.addListener((changes) => {
    let touched = false;
    for (const key of Object.keys(changes)) {
      if (key === REJECTIONS_KEY) {
        // Whole-map key: the injector rewrites it as one authoritative
        // set per sync, so we replace ours rather than merging.
        currentRejections = coerceRejectionMap(changes[key]?.newValue);
        touched = true;
        continue;
      }
      if (key === REFRESH_ERRORS_KEY) {
        // Also a whole-map key. Repainted rather than status-cell
        // patched: it changes a section's message line and the page
        // banner, neither of which `applyStatusCellsToDom` touches.
        currentRefreshErrors = coerceRefreshErrorMap(changes[key]?.newValue);
        void repaintPage();
        continue;
      }
      if (!key.startsWith(LOG_LEVEL_KEY_PREFIX)) continue;
      const scriptId = key.slice(LOG_LEVEL_KEY_PREFIX.length);
      const next = changes[key]?.newValue;
      if (next === 'info' || next === 'warning' || next === 'error') {
        currentLogLevels.set(scriptId, next);
      } else {
        currentLogLevels.delete(scriptId);
      }
      touched = true;
    }
    if (touched) applyStatusCellsToDom();
  });
}

// The debug-logging toggle is global, but each JS context reads it for
// itself — and until this, only the service worker did. That left every
// `dlog` / phase timer in page-context code permanently silent, which
// matters because the refresh pipeline runs HERE: the collections page
// imports `script-updater` directly rather than messaging the worker.
// The listener keeps the flag live, so flipping the Options checkbox
// takes effect without reloading the page.
installDebugLoggingListener();
void loadDebugLoggingFlag();

// Keep the page current with `chrome.storage.local` writes from ANY
// origin — the viewer's Refresh, a background opportunistic refresh, an
// Install captured in another tab, a second Collections tab. Before
// this the page only ever reflected the state it wrote itself, so a
// script that recovered elsewhere kept a stale badge until a manual
// reload (issue #10).
//
// The change event is treated as a "something you display moved" signal:
// only which keys changed is used, never the values it carries. The
// repaint re-reads storage and makes the DOM match, which is idempotent
// by construction: no snapshot to go stale, no per-key handler to keep
// in step with the store, and any number of events collapse into one
// pass. The keys narrow which rows it re-reads (`repaintScriptRows`).
if (chrome.storage?.local?.onChanged) {
  chrome.storage.local.onChanged.addListener((changes) => {
    // Only the keys the page draws from; an enable write's active times
    // ride along in the same event.
    const keys = Object.keys(changes).filter((key) => touchesStructuralRows([key]));
    if (keys.length > 0) void repaintPage(keys);
  });
}

// Page-wide map of {scriptId → highest log level seen}. Drives the
// Status-cell promotion to WARNING / ERROR; absent entries collapse
// to OK (or whatever the stored status mandates). Kept in sync via
// the `chrome.storage.session.onChanged` listener installed at module
// top so a fresh log entry on the SW side updates the column without
// a full page reload. Seeded from `getAllMaxLogLevels()` inside
// `render()` so the first paint already reflects the current state.
let currentLogLevels = new Map<string, LogLevel>();

// Page-wide map of {scriptId → the probe that says an upstream copy is
// ahead of ours}. Populated per row at render time; the repaint path
// rebuilds status cells from DOM datasets and has no script row to
// re-derive this from, so it reads the verdict back from here. Entries
// only ever appear for scripts whose `@updateURL` / `@downloadURL`
// points somewhere we don't fetch from — see src/version-probe.ts.
const currentOutdated = new Map<string, VersionProbe>();

// Page-wide {scriptId → why Chrome refused its registration}, mirroring
// the injector's session-storage map. Drives the REJECTED status; empty
// on a healthy profile. Seeded in `render()` and kept fresh by the
// `chrome.storage.session.onChanged` listener above.
let currentRejections: RejectionMap = {};

// Page-wide {collectionId → why its last refresh couldn't be saved},
// mirroring the session-storage map in src/extension/refresh-error.ts. Drives both
// the per-section message and the storage banner; empty on a healthy
// profile. Seeded in `render()` and kept fresh by the
// `chrome.storage.session.onChanged` listener above.
let currentRefreshErrors: RefreshErrorMap = {};

// For the Status column: after a storage.session change for one or
// more `loglevel:` rows, walk every rendered script row and rewrite its
// status cell content + class to reflect the latest effective status. Pulls the ScriptMeta.status
// off the row's data-script-status attribute so we don't have to refetch.
function applyStatusCellsToDom(): void {
  for (const row of document.querySelectorAll<HTMLTableRowElement>(
    '.script-table tr[data-script-id]',
  )) {
    const id = row.dataset.scriptId;
    const storedStatus = row.dataset.scriptStatus as ScriptMeta['status'] | undefined;
    if (!id || !storedStatus) continue;
    const cell = row.querySelector<HTMLTableCellElement>('td.status-cell');
    if (!cell) continue;
    paintStatusCell(
      cell, id, storedStatus,
      row.dataset.scriptError ?? undefined,
      row.dataset.scriptRefreshError ?? undefined,
    );
  }
}

// Write the `data-script-*` snapshot that the repaint paths read back,
// and hand the caller the description to paint with, so the initial
// render and the live in-place update can't drift. The error message is
// stored already-described (message + `(in file, line …)`) because the
// dataset is a string channel with no room for the structured location,
// and the hover text is its only consumer — the clickable form of the
// same location lives in the viewer, which this row's link opens.
// Fields that no longer apply are DELETED, not left behind: a stale
// `data-script-refresh-error` used to pin the recompute to REFRESH
// FAILED long after the refresh started succeeding again.
function applyScriptRowDatasets(
  row: HTMLTableRowElement,
  script: ScriptMeta,
): { errorMessage: string | undefined } {
  row.dataset.scriptStatus = script.status;
  const errorMessage = script.errorMessage
    ? describeDiagnostic(script.errorMessage, script.errorLocation)
    : undefined;
  if (errorMessage) row.dataset.scriptError = errorMessage;
  else delete row.dataset.scriptError;
  if (script.refreshError) row.dataset.scriptRefreshError = script.refreshError;
  else delete row.dataset.scriptRefreshError;
  // The outdated verdict needs the parsed header and the stored probes,
  // neither of which survives as a dataset attribute — record it in the
  // page-wide map instead so the repaint path can look it up by id.
  const outdated = scriptOutdatedProbe(script);
  if (outdated) currentOutdated.set(script.id, outdated);
  else currentOutdated.delete(script.id);
  return { errorMessage };
}

// Everything a status cell is drawn from, as one comparable string.
// Recorded per row by `paintStatusCell` so a repaint can tell a cell
// that needs redrawing from one that would only lose the user's focus.
// The inputs live in three places: the stored row, the session-storage
// maps this page mirrors, and the version probes.
const statusCellKeys = new Map<string, string>();

function statusCellKey(
  scriptId: string,
  storedStatus: ScriptMeta['status'],
  errorMessage: string | undefined,
  refreshError: string | undefined,
): string {
  return JSON.stringify([
    storedStatus,
    errorMessage ?? '',
    refreshError ?? '',
    currentLogLevels.get(scriptId) ?? '',
    currentOutdated.get(scriptId) ?? null,
    currentRejections[scriptId] ?? '',
  ]);
}

// Apply `effectiveScriptStatus` to one status cell: rewrite the link
// label, classes, and trash-can affordance. Used by both initial
// render and the post-storage-change repaint so the two paths can't
// drift on label / class details.
function paintStatusCell(
  cell: HTMLTableCellElement,
  scriptId: string,
  storedStatus: ScriptMeta['status'],
  errorMessage: string | undefined,
  refreshError: string | undefined,
): void {
  statusCellKeys.set(scriptId, statusCellKey(scriptId, storedStatus, errorMessage, refreshError));
  cell.textContent = '';
  cell.className = 'status-cell';
  const level = currentLogLevels.get(scriptId);
  const outdated = currentOutdated.get(scriptId);
  const rejection = currentRejections[scriptId];
  const effective = effectiveScriptStatus(
    { status: storedStatus, refreshError }, level, outdated !== undefined,
    rejection !== undefined,
  );
  cell.classList.add(`status-${effective}`);
  // Anchor that takes the user straight to the script viewer's Log
  // tab — the same destination regardless of effective status, since
  // even OK rows may have informative entries.
  const link = document.createElement('a');
  link.href = viewerUrl(scriptId, 'log');
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = formatScriptStatusLabel(effective);
  // Hover text follows whatever the cell is actually showing: Chrome's
  // rejection reason, the refresh-failure reason, the newer version we
  // found upstream, or otherwise the load errorMessage.
  const title = effective === 'rejected' && rejection
    ? rejection
    : effective === 'refresh-failed'
      ? refreshError
      : effective === 'outdated' && outdated
        ? `Version ${outdated.version} at ${probeLabel(outdated.kinds)}: ${outdated.url}`
        : errorMessage;
  if (title) link.title = title;
  cell.appendChild(link);
}

// ---------- Live repaint from storage ----------

// The page is repainted from storage whenever anything it displays may
// have moved, rather than by interpreting individual change events.
//
// Every repaint re-reads the world and makes the DOM match it, so the
// pass is idempotent: running it twice changes nothing, running it after
// a burst of writes lands on the final state, and the echo of the page's
// own write is a no-op rather than a fight with the handler that made
// it. Events only decide WHEN to repaint, never what to paint — a
// change event carries a snapshot, and a snapshot acted on later is a
// lie about the present.
let pageDirty = false;
// The changed keys the pending repaint has to cover, or null for all of
// them. Lets a change to a few script rows repaint just those rows (see
// `repaintScriptRows`).
let dirtyKeys: Set<string> | null = new Set();
let repaintChain: Promise<void> = Promise.resolve();

// Mark the page stale and resolve once a repaint has covered it. Passes
// are serialized, and a burst of events collapses: the first link to run
// clears the flag and does the work, and the rest find nothing to do.
// Awaiting the returned promise is enough for a caller to know the DOM
// matches storage as of its own call — its link runs no earlier than the
// repaint that covered it.
//
// Deliberately not debounced. The repaint is cheap, and a delay would
// only put lag between a user's click and the page agreeing with it.
//
// `keys`: the storage keys that changed, when the caller knows them.
// Without them the pass repaints everything.
function repaintPage(keys?: readonly string[]): Promise<void> {
  pageDirty = true;
  if (!keys) dirtyKeys = null;
  else if (dirtyKeys) for (const key of keys) dirtyKeys.add(key);
  repaintChain = repaintChain
    .then(async () => {
      // Waited before the flag is read, not after, so everything that
      // arrives during the initial render collapses into ONE repaint
      // rather than one per event.
      await initialRenderDone;
      if (!pageDirty) return;
      pageDirty = false;
      const changed = dirtyKeys;
      dirtyKeys = new Set();
      await repaintFromStorage(changed);
    })
    .catch((err: unknown) => {
      // Nothing here is worth failing the page over, but an unhandled
      // rejection would land in chrome://extensions/?errors and read as
      // a broken extension — keep it in the page console.
      console.info('[SourceMonkey] live update failed', err);
    });
  return repaintChain;
}

// Make the rendered sections match the stored collections: drop the ones
// that are gone, build the ones that appeared, update the rest in place,
// and re-seat them into index order (`repaintSections`), or, when only
// script rows changed, update just those rows (`repaintScriptRows`).
// Existing elements are reused so refresh highlights, in-flight
// spinners, and focus survive.
//
// `changed` is the keys that changed since the last pass, or null when
// unknown. A change to script rows only repaints those rows; anything
// else, or a change those rows can't take in place, repaints all.
async function repaintFromStorage(changed: ReadonlySet<string> | null): Promise<void> {
  const timer = startPhaseTimer('collections page repaint');
  const rows = changed ? await repaintScriptRows(changed, timer) : null;
  if (rows === null) await repaintSections(timer);
  timer.note(rows === null ? 'all rows' : `${rows} row(s)`);
  // Rows this repaint read after their write are settled.
  for (const [key, at] of writtenAt) if (at <= repaintReadAt) writtenAt.delete(key);
  timer.done();
}

// Enable writes this page made, numbered, and the number each row
// (script id, or `collection:` + id) last had one land at. A repaint
// notes the number before it reads storage, and leaves alone the
// checkbox of any row written since: it reads for hundreds of ms on a
// large store, so a click that lands meanwhile would otherwise be drawn
// over with what the row was before it.
//
// Nothing is left stale by skipping: the handler has already drawn the
// row from the write's result. The repaint that write's storage change
// starts usually reads after it is noted and draws the row as well; if
// it began first, the next repaint does, and clears the entry.
let pageWrites = 0;
let repaintReadAt = 0;
const writtenAt = new Map<string, number>();

function noteWritten(keys: Iterable<string>): void {
  pageWrites++;
  for (const key of keys) writtenAt.set(key, pageWrites);
}

function writtenSinceRead(key: string): boolean {
  return (writtenAt.get(key) ?? 0) > repaintReadAt;
}

// Show an enable write on every row it changed: the copies it turned
// off elsewhere on the page as well as the one clicked, together, so
// two copies never both show as on while the repaint catches up.
//
// Applied under another click's spinner too. The worker runs the writes
// in order (the store's lock) and answers each as it finishes, so the
// last result applied is the last write.
//
// `also` is other rows the handler drew itself (the clicked one, a
// collection's toggle), noted as written with these.
function applyEnableResult(changed: readonly ScriptMeta[], also: readonly string[] = []): void {
  noteWritten([...also, ...changed.map((s) => s.id)]);
  const sections = new Set<HTMLElement>();
  for (const script of changed) {
    const row = collectionsEl.querySelector<HTMLTableRowElement>(`tr[data-script-id="${cssEscape(script.id)}"]`);
    if (!row) continue;
    const on = isScriptEnabled(script);
    const cb = row.querySelector<HTMLInputElement>('.toggle input[type="checkbox"]');
    if (cb) cb.checked = on;
    const section = row.closest<HTMLElement>('.collection');
    const collectionOn = section ? !section.classList.contains('disabled') : true;
    row.classList.toggle('disabled', !collectionOn || !on);
    if (section) sections.add(section);
  }
  for (const section of sections) refreshBulkToggle(section);
}

// Repaint only the rows of the scripts in `changed`, when that's all
// that changed: an enable toggle, a version probe, a refresh of a few
// scripts. Those rows are read again from storage, as the full repaint
// reads every row, rather than taken from the change event.
//
// Returns how many rows it repainted, or null, having changed nothing,
// when the change needs the full repaint:
//   - a collection row or the collection list changed;
//   - a script appeared, went, or moved to another collection (those
//     write the collection rows too, so this is a backstop);
//   - a row's shown name changed, which can move it in the section's
//     name order.
async function repaintScriptRows(changed: ReadonlySet<string>, timer: PhaseTimer): Promise<number | null> {
  const ids: string[] = [];
  for (const key of changed) {
    if (!key.startsWith(SCRIPT_PREFIX)) return null;
    ids.push(key.slice(SCRIPT_PREFIX.length));
  }
  repaintReadAt = pageWrites;
  const scripts = await getScriptMetas(ids);
  timer.mark('read scripts', `${scripts.length} scripts`);
  if (scripts.length !== ids.length) return null;
  const placed: { row: HTMLTableRowElement; section: HTMLElement; script: ScriptMeta }[] = [];
  for (const script of scripts) {
    const row = collectionsEl.querySelector<HTMLTableRowElement>(`tr[data-script-id="${cssEscape(script.id)}"]`);
    const section = row?.closest<HTMLElement>('section.collection');
    if (!row || !section || section.dataset.collectionId !== script.collectionId) return null;
    placed.push({ row, section, script });
  }
  const collectionIds = [...new Set(scripts.map((s) => s.collectionId))];
  const collections = new Map((await getCollectionsById(collectionIds)).map((c) => [c.id, c] as const));
  timer.mark('read collections');
  if (collections.size !== collectionIds.length) return null;
  if (placed.some(({ script }) => shownNames.get(script.id)
    !== nameCellText(script, isContainerCollection(collections.get(script.collectionId)!.path)))) {
    return null;
  }
  // As the full repaint does, so a rebuilt Name cell draws its icon
  // straight away.
  await preloadSiteIcons(scripts);
  timer.mark('icons');
  const sections = new Set<HTMLElement>();
  const settling = new Map<HTMLTableElement, Promise<unknown>[]>();
  for (const { row, section, script } of placed) {
    const collection = collections.get(script.collectionId)!;
    // Same rule as `syncSectionFromStorage`: a toggle of the collection
    // this page made after the read already drew the section.
    const collectionOn = writtenSinceRead(COLLECTION_PREFIX + collection.id)
      ? !section.classList.contains('disabled')
      : isCollectionEnabled(collection);
    const repainted = syncScriptRow(row, script, collectionOn, collection.path, localFileScope(collection));
    const table = row.closest('table');
    if (repainted && table) settling.set(table, [...(settling.get(table) ?? []), repainted]);
    sections.add(section);
  }
  // A rebuilt Name cell may need a different icon column width.
  for (const [table, pending] of settling) fitIconColumns(table, pending);
  for (const section of sections) refreshBulkToggle(section);
  // Its usage figure moves with any write, while it's up.
  const liveIds = [...collectionsEl.querySelectorAll<HTMLElement>('section.collection')]
    .map((s) => s.dataset.collectionId ?? '');
  await syncStorageBanner(new Set(liveIds));
  markDiskChanges();
  timer.mark('paint');
  return placed.length;
}

async function repaintSections(timer: PhaseTimer): Promise<void> {
  repaintReadAt = pageWrites;
  const collections = await getCollections();
  timer.mark('read collections');
  // Ahead of the sections, so a page that just failed to save shows the
  // explanation at the top by the time the reader's eye follows the
  // section messages down. Needs the collection list, hence after the
  // read rather than first.
  await syncStorageBanner(new Set(collections.map((s) => s.id)));
  timer.mark('banner');
  // Read every collection's script rows ONCE, up front, in one call,
  // and paint from that.
  //   - Without their bodies, which the rows don't show.
  //   - Not `getAllScriptMetas()`: that lists every key first, for rows
  //     the collection list above already names.
  //   - Not one read per collection: two calls each, one after another.
  // A repaint runs on any structural write from anywhere, so it has to
  // stay proportionate.
  const scripts = await getScriptMetas(collections.flatMap((c) => c.scriptIds));
  const byId = new Map(scripts.map((sc) => [sc.id, sc]));
  const scriptsByCollection = new Map(collections.map((c) => [
    c.id,
    c.scriptIds.map((id) => byId.get(id)).filter((sc): sc is ScriptMeta => sc != null),
  ]));
  const allScripts = [...scriptsByCollection.values()].flat();
  timer.mark('read scripts', `${allScripts.length} scripts`);
  // Their size from Chrome rather than by serializing them here, which
  // on a store of several MB held this page's thread for tens of ms.
  // The rows only, which is what the read above loaded. Only with debug
  // logging on, since it is an extra storage call.
  if (isDebugLoggingEnabled()) {
    const bytes = await scriptRowBytes(allScripts.map((s) => s.id));
    timer.mark('size', formatBytes(bytes));
  }
  // Cached favicons first, so rows draw with their real icons rather
  // than globes that are swapped (and the icon column re-fitted) a
  // moment later.
  await preloadSiteIcons(allScripts);
  timer.mark('icons');

  // Forget the per-script bookkeeping of everything no longer stored,
  // in one place rather than at each of the several points a row can go
  // away — and keyed off what storage says, so a script that moved
  // between collections isn't forgotten by its old section after its
  // new one has already recorded it.
  forgetScriptsExcept(new Set(allScripts.map((s) => s.id)));

  const wanted = new Set(collections.map((s) => s.id));
  for (const section of [
    ...collectionsEl.querySelectorAll<HTMLElement>('section.collection'),
  ]) {
    const id = section.dataset.collectionId;
    if (!id || !wanted.has(id)) section.remove();
  }

  if (collections.length === 0) {
    if (!collectionsEl.querySelector('.empty-placeholder')) {
      collectionsEl.appendChild(emptyPlaceholder());
    }
    refreshMoveButtons();
    timer.mark('paint');
    return;
  }
  removeEmptyPlaceholder();

  const ordered: HTMLElement[] = [];
  for (const collection of collections) {
    const scripts = scriptsByCollection.get(collection.id) ?? [];
    const section = findSection(collection.id);
    if (section) await syncSectionFromStorage(section, collection, scripts);
    ordered.push(section ?? await renderCollectionSection(collection));
  }
  // appendChild moves an already-attached node, so appending each in
  // index order re-seats them. Only done when the order actually
  // differs: re-seating detaches the node first, and Chrome blurs
  // anything focused inside it.
  if (!sameNodeOrder(collectionsEl, ordered)) {
    for (const section of ordered) collectionsEl.appendChild(section);
  }
  refreshMoveButtons();
  markDiskChanges();
  closeDetachedMenu();
  timer.mark('paint');
}

// What the disk says that storage doesn't yet (file-changes.ts): a
// chip after the name of every local script whose file has gone or
// changed, and a "refresh pending" chip on a directory collection
// whose heading tooltip sums up what a refresh would do — deleted and
// modified rows, plus `.user.js` files on disk that no row accounts
// for. Run after each paint and repaint: a repaint follows every
// storage write, including the refresh that applies these, so the
// chips are short-lived by design — the gap between the disk changing
// and SourceMonkey noticing.
//
// One directory listing per folder on the page — but not per repaint:
// a repaint also follows an enable toggle, a log write, a refresh of
// another collection, none of which touch the disk, so a listing read
// in the last few seconds is reused. A change shows up on the first
// repaint after that window, or on reload.
function markDiskChanges(): void {
  void (async () => {
    const states = await markFileChanges(collectionsEl, DISK_LISTING_MAX_AGE_MS);
    for (const section of collectionsEl.querySelectorAll<HTMLElement>('section.collection')) {
      const collectionPath = section.dataset.collectionPath;
      if (!collectionPath) continue;
      const rows = [...section.querySelectorAll<HTMLElement>('tr[data-script-id] [data-fs-path]')];
      // The manifest file itself, against the stat its last scan
      // recorded (`manifestSize` / `manifestMtime`).
      const { manifestFsPath, manifestSize, manifestMtime } = section.dataset;
      const manifest = manifestFsPath === undefined ? null : {
        path: manifestFsPath,
        size: manifestSize === undefined ? undefined : Number(manifestSize),
        mtime: manifestMtime === undefined ? undefined : Number(manifestMtime),
      };
      const counts = await pendingOnDisk(
        collectionPath, manifest, rows.map((el) => ({ fsPath: el.dataset.fsPath!, state: states.get(el) })), DISK_LISTING_MAX_AGE_MS,
      );
      if (!counts) continue;
      const nameEl = section.querySelector<HTMLElement>('.collection-header .collection-display-name');
      if (nameEl) syncRefreshPendingChip(nameEl, refreshPendingHint(counts));
    }
  })();
}
const DISK_LISTING_MAX_AGE_MS = 5000;

// A `file://` manifest's path and last-scanned stat, on the section for
// `markDiskChanges`. Kept current on every sync: a refresh rewrites
// the stat, and the chip has to compare against the new one.
function syncManifestStatDataset(section: HTMLElement, collection: StoredCollection): void {
  const ds = section.dataset;
  // The same manifest sm-dev's `onDisk` probes.
  const probe = manifestToProbe(collection);
  if (probe) ds.manifestFsPath = probe.path;
  else delete ds.manifestFsPath;
  if (collection.manifestSize !== undefined) ds.manifestSize = String(collection.manifestSize);
  else delete ds.manifestSize;
  if (collection.manifestMtime !== undefined) ds.manifestMtime = String(collection.manifestMtime);
  else delete ds.manifestMtime;
}

// Update one already-rendered section from its stored collection row.
// The section element itself is never replaced — that would take the
// Refresh button's busy state and every row's spinner with it.
async function syncSectionFromStorage(
  section: HTMLElement,
  collection: StoredCollection,
  scripts: readonly ScriptMeta[],
): Promise<void> {
  // A toggle of this collection that landed after the repaint read
  // storage already drew the section; the stored row is older than it.
  const stale = writtenSinceRead(COLLECTION_PREFIX + collection.id);
  const collectionOn = stale ? !section.classList.contains('disabled') : isCollectionEnabled(collection);
  if (!stale) applyCollectionEnabledToDom(section, collectionOn);

  // The type bubble is derived from `collection.path`, which is the
  // collection's identity and never rewritten, so only the display name
  // can move.
  syncManifestStatDataset(section, collection);
  // Compared against what was painted, not `textContent`: the name
  // element can also hold the "refresh pending" chip (file-changes.ts),
  // whose text would make every repaint look like a rename.
  const nameEl = section.querySelector<HTMLElement>('.collection-display-name');
  const displayName = effectiveDisplayName(collection);
  if (nameEl && nameEl.dataset.displayName !== displayName) {
    nameEl.textContent = '';
    appendWithSlashBreaks(nameEl, displayName);
    nameEl.dataset.displayName = displayName;
  }

  syncSectionMessage(section, 'scan', scanErrorText(collection));
  syncSectionMessage(section, 'refresh', refreshErrorText(collection.id));

  await syncScriptRowsFromStorage(section, collection, collectionOn, scripts);
}

// The section's message lines, in the order they are drawn between the
// header and the script list. A section can carry both at once — they
// describe different attempts with different fixes — so each is tagged
// and synced on its own rather than by "the first `p.error`", which
// would have the two overwrite each other.
const SECTION_MESSAGE_KINDS = ['scan', 'refresh'] as const;
type SectionMessageKind = typeof SECTION_MESSAGE_KINDS[number];

function makeSectionMessage(kind: SectionMessageKind, text: string): HTMLElement {
  const p = makeMessage('error', '');
  p.dataset.messageKind = kind;
  fillWithLinks(p, text);
  return p;
}

// `text` into `el`, with each http(s) URL in it as a link (a failed
// read names the address it read). Punctuation right after a URL stays
// text: `Could not read <url>: HTTP 404` puts a colon there.
//
// Skipped when `el` already shows `text`: a repaint would otherwise
// rebuild a link the pointer or focus is on.
function fillWithLinks(el: HTMLElement, text: string): void {
  if (el.dataset.text === text) return;
  el.dataset.text = text;
  el.textContent = '';
  let at = 0;
  for (const match of text.matchAll(/https?:\/\/\S+/g)) {
    const url = match[0].replace(/[.,;:!?)\]]+$/, '');
    el.append(text.slice(at, match.index));
    const a = document.createElement('a');
    a.href = url;
    a.textContent = url;
    a.target = '_blank';
    a.rel = 'noopener';
    el.append(a);
    at = match.index + url.length;
  }
  el.append(text.slice(at));
}

// Add, update, or drop one of a section's message lines to match `text`
// (empty meaning "no message of this kind"). Shared by the initial build
// and the repaint so the two can't render the same failure differently.
function syncSectionMessage(
  section: HTMLElement,
  kind: SectionMessageKind,
  text: string,
): void {
  const prior = section.querySelector<HTMLElement>(
    `:scope > p[data-message-kind="${kind}"]`,
  );
  if (!text) {
    prior?.remove();
    return;
  }
  if (prior) {
    fillWithLinks(prior, text);
    return;
  }
  // Insert after whichever earlier line is present, so the kinds keep a
  // stable order however they arrive — a section that gains its scan
  // line second must not end up showing it below the refresh line.
  let anchor: Element | null = section.querySelector('.collection-header');
  for (const earlier of SECTION_MESSAGE_KINDS) {
    if (earlier === kind) break;
    anchor = section.querySelector<HTMLElement>(
      `:scope > p[data-message-kind="${earlier}"]`,
    ) ?? anchor;
  }
  anchor?.after(makeSectionMessage(kind, text));
}

// Update the section's script list in place: reuse the `<tr>` for a
// script that is still there, build one for a script that appeared, drop
// the rows whose scripts are gone, and re-seat into name order.
async function syncScriptRowsFromStorage(
  section: HTMLElement,
  collection: StoredCollection,
  collectionOn: boolean,
  scripts: readonly ScriptMeta[],
): Promise<void> {
  const localFiles = localFileScope(collection);
  scripts = sortedByShownName(scripts, isContainerCollection(collection.path));
  const block = section.querySelector<HTMLElement>(':scope > .script-block');
  const tbody = block?.querySelector('tbody');

  // A collection with no scripts shows a message instead of a table, so
  // the two shapes have to be swapped whole. Everything else is in
  // place.
  if (scripts.length === 0 || !tbody) {
    if (scripts.length === 0 && !tbody) return;   // already the message
    const fresh = await renderScriptBlock(collection, collectionOn);
    if (block) block.replaceWith(fresh);
    else section.appendChild(fresh);
    return;
  }

  const existing = new Map<string, HTMLTableRowElement>();
  for (const row of liveScriptRows(tbody)) {
    if (row.dataset.scriptId) existing.set(row.dataset.scriptId, row);
  }
  const hasActionColumn = !!tbody.parentElement?.querySelector('thead th[aria-label="Actions"]');
  const ordered: HTMLTableRowElement[] = [];
  // Rows whose icon slot was (re)built in this pass; their favicons are
  // still loading, and the column is fitted again once they settle.
  const settling: Promise<unknown>[] = [];
  for (const script of scripts) {
    const row = existing.get(script.id);
    if (row) {
      const repainted = syncScriptRow(row, script, collectionOn, collection.path, localFiles);
      if (repainted) settling.push(repainted);
      existing.delete(script.id);
    }
    // Whether the table has the trailing action column is settled by
    // the header that is already on screen — a row added into it has to
    // match, and a table whose whole point is local copies already has
    // one from the render that built it.
    if (row) {
      ordered.push(row);
      continue;
    }
    const made = renderScriptRow(script, collectionOn, collection.path, localFiles, hasActionColumn);
    ordered.push(made.row);
    settling.push(made.iconCount);
  }
  // Whatever is left in `existing` is a row whose script is gone. The
  // per-script bookkeeping is pruned by the caller, against the whole
  // stored set.
  for (const row of existing.values()) row.remove();
  // Compared against the live rows only — a tombstone sitting between
  // them would make every repaint see a mismatch and re-seat the whole
  // table, which detaches rows and blurs anything focused inside one.
  if (!sameNodeList(liveScriptRows(tbody), ordered)) {
    for (const row of ordered) tbody.appendChild(row);
  }
  // Re-seating the live rows leaves the ghosts wherever they were, so
  // they are placed again against their anchors afterwards.
  placeTombstones(tbody);
  // Rows came and went, so the icon column is fitted again: a row that
  // left may have been the wide one, a row that arrived may need more.
  fitIconColumns(tbody.parentElement as HTMLTableElement, settling);
  refreshBulkToggle(section);
}

// Repaint one already-rendered script row from its stored value WITHOUT
// recreating the <tr>, so any refresh highlight or in-flight spinner on
// the row survives. This is the heart of the issue-#10 fix: the row's
// datasets are rewritten from the stored value — and the ones that no
// longer apply are DELETED — so a cleared `refreshError` finally reaches
// the repaint instead of a stale `data-script-refresh-error` pinning the
// cell to REFRESH FAILED.
function syncScriptRow(
  row: HTMLTableRowElement,
  script: ScriptMeta,
  collectionOn: boolean,
  collectionPath: string,
  localFiles: LocalFileScope,
  // The Name cell's settle promise when it was rebuilt (see
  // `fillNameCell`), null when it was left alone.
): Promise<number> | null {
  const inContainer = isContainerCollection(collectionPath);
  const { errorMessage } = applyScriptRowDatasets(row, script);

  // Like the Name cell below, the Status cell is only rebuilt when
  // what it shows moved. `paintStatusCell` discards and recreates the
  // `<a>`, so repainting it
  // unconditionally would drop focus off it — and a repaint runs on any
  // structural write anywhere, including a background refresh of an
  // unrelated collection.
  const cell = row.querySelector<HTMLTableCellElement>('td.status-cell');
  const wanted = statusCellKey(script.id, script.status, errorMessage, script.refreshError);
  if (cell && statusCellKeys.get(script.id) !== wanted) {
    paintStatusCell(cell, script.id, script.status, errorMessage, script.refreshError);
  }

  // The action cell moves with the row's status: a copy whose file has
  // gone stops offering to delete that file, and `paintStatusCell` has
  // just given the row the plain trash can that clears its record. Two
  // trash cans on one row, one of them acting on a file that isn't
  // there, is what leaving this cell alone looked like.
  const actionCell = row.querySelector<HTMLTableCellElement>('td.action-cell');
  if (actionCell && !inContainer) {
    const wanted = isDeletableCopy(script, localFiles.collectionPath);
    const has = actionCell.childElementCount > 0;
    if (wanted && !has) actionCell.appendChild(makeDeleteCopyButton(script));
    else if (!wanted && has) actionCell.replaceChildren();
  }

  const sizeCell = row.querySelector<HTMLTableCellElement>('td.size-cell');
  const size = formatScriptSize(script);
  if (sizeCell && sizeCell.textContent !== size) sizeCell.textContent = size;

  // The Name cell is only rebuilt when something it shows actually
  // moved. Rebuilding unconditionally would re-run the favicon fetch and
  // flash the globe placeholder on every unrelated repaint.
  const nameCell = row.querySelector<HTMLTableCellElement>('td.name-cell');
  let repainted: Promise<number> | null = null;
  if (nameCell && nameCellKeys.get(script.id) !== nameCellKey(script, localFiles)) {
    // A refresh that changed `@match` may need a different icon
    // column; the caller re-fits the table once it has seen every row.
    repainted = fillNameCell(nameCell, script, collectionPath, localFiles);
  }

  // A refresh can change `@name` / `@namespace`.
  row.dataset.identity = rowIdentity(script);
  const label = row.querySelector<HTMLLabelElement>('.toggle');
  const cb = label?.querySelector<HTMLInputElement>('input[type="checkbox"]');
  // Skip the checkbox while THIS row's toggle is mid-flight (a
  // `.busy-spinner` sibling means an onToggleScript on this page holds
  // it disabled with its intended value shown). The echo of that very
  // write must not re-enable it under the spinner; the handler's
  // `finally` restores the final state. Everything else (status, size)
  // still updates.
  //
  // `checked` is also skipped when a write from this page landed on the
  // row after this repaint read storage: what it read is older than what
  // the row shows (see `noteWritten`). `disabled` follows the collection,
  // which that write didn't change.
  const busy = !!label?.querySelector('.busy-spinner');
  const stale = writtenSinceRead(script.id);
  if (cb && !busy) {
    if (!stale) cb.checked = isScriptEnabled(script);
    cb.disabled = !collectionOn;
  }
  const scriptOn = stale && cb ? cb.checked : isScriptEnabled(script);
  // Mirror applyCollectionEnabledToDom's label upkeep, spinner or not:
  // this is the parent collection's state, not the user's click, and
  // the restore in setToggleBusy reads `toggle-disabled` back to settle
  // the checkbox.
  if (label) {
    label.classList.toggle('toggle-disabled', !collectionOn);
    label.title = collectionOn ? ENABLE_TITLE : COLLECTION_OFF_TITLE;
  }
  row.classList.toggle('disabled', !collectionOn || !scriptOn);
  return repainted;
}

// Are `wanted` already the container's element children, in that order?
function sameNodeOrder(container: Element, wanted: readonly Element[]): boolean {
  return sameNodeList([...container.children], wanted);
}

function sameNodeList(current: readonly Element[], wanted: readonly Element[]): boolean {
  return (
    current.length === wanted.length && current.every((node, i) => node === wanted[i])
  );
}

// Everything the Name cell renders, as one comparable string: the
// name text, its location + description tooltip, and the favicon's inputs
// (`renderSiteIconInto` reads `matching`, the header's `@icon`, and
// `fileUrl` for resolving a relative one). Recorded per row by
// `fillNameCell` so a repaint can tell a cell that needs rebuilding from
// one that would only flash its favicon for nothing.
const nameCellKeys = new Map<string, string>();

// The name each row was last drawn with, which sets its place in the
// section (`sortedByShownName`). A repaint of only some rows can't
// re-sort the section, so it hands one whose name moved to the full
// repaint.
const shownNames = new Map<string, string>();

function nameCellKey(script: ScriptMeta, localFiles: LocalFileScope): string {
  return JSON.stringify([
    script.relativePath,
    script.fileUrl,
    // The header values the name text and its tooltip are built from,
    // raw rather than formatted — comparing the inputs is enough.
    script.header && getValue(script.header, 'name'),
    script.header && getValue(script.header, 'description'),
    // `inContainer`, the other input to the name text, is deliberately
    // absent: it's a property of the collection the script sits in, and
    // a script that moves between collections is a different row.
    iconRefFromHeader(script.header),
    script.matching,
    // The collection's local-files scope decides whether the `@icon` is
    // fetched from its declared URL or from a file on disk, so flipping
    // the toggle changes what this cell paints. Without it here,
    // toggling the switch would repaint the page and leave the old
    // favicon in place until something unrelated rebuilt the row.
    // Flattened rather than stringified whole: the key must not depend
    // on the scope object's property order.
    localFiles.enabled,
    localFiles.collectionPath ?? '',
    // The size and mtime the name link is tagged with for the
    // "modified" chip (file-changes.ts): a refresh that re-reads the
    // file moves them, and the tag has to move too or the chip would
    // outlive the refresh that applied it.
    script.size,
    script.fsMtime,
  ]);
}

// Drop the per-script bookkeeping for everything that is no longer
// stored. These maps are keyed by script id and would otherwise grow for
// the life of the page.
function forgetScriptsExcept(keep: ReadonlySet<string>): void {
  for (const id of [...nameCellKeys.keys()]) {
    if (!keep.has(id)) nameCellKeys.delete(id);
  }
  for (const id of [...shownNames.keys()]) {
    if (!keep.has(id)) shownNames.delete(id);
  }
  for (const id of [...currentOutdated.keys()]) {
    if (!keep.has(id)) currentOutdated.delete(id);
  }
  for (const id of [...statusCellKeys.keys()]) {
    if (!keep.has(id)) statusCellKeys.delete(id);
  }
}

// `?refresh` in the URL triggers a refresh-all as soon as the initial
// render is done. Lets external tools poke the extension via
//   google-chrome chrome-extension://<id>/collections.html?refresh
// after they've written new userscripts.
//
// Two narrower triggers exist for the common "I just edited files on
// disk" case, where a refresh-all would also re-read every http(s) and
// GitHub collection for nothing:
//   - `?refresh_local` — every local collection, and nothing else.
//   - `?refresh_file=<path>` — a file or directory path (raw or
//     `file://`). Refreshes the local collections whose scanned
//     directory overlaps it (so an added / renamed / deleted file is
//     noticed) plus any individually-added local script it names.
// See src/extension/refresh-targets.ts for the selection rules.
//
// `?add=<path-or-url>` does the equivalent of typing the value
// into the Add field and clicking Add. Validates the input;
// shows an error if it doesn't look like an absolute path or URL.
// On success or duplicate, jumps to the resulting collection section.
// Lets the docs/redirect-page.md deep link route here from anywhere
// on the web (see docs/deep-link.md).
async function bootstrap(): Promise<void> {
  // The GitHub auth token hydrated before anything here reads GitHub.
  // Released even if anything above the render throws: every repaint
  // waits on this, and the flow handlers await a repaint inside a `try`
  // whose `finally` resets their button — so a deferred left unresolved
  // would hang the Add form and the Refresh buttons with no way back
  // short of a reload. A repaint is the recovery from a half-built page,
  // so it must never be the thing left waiting.
  try {
    await githubTokenReady;
    // Same reasoning for the configured local-file roots: the icon
    // slots resolve stand-ins synchronously during render, so the
    // setting has to be in hand before the first paint.
    await localRootsReady();
    await render();
  } finally {
    resolveInitialRender();
  }
  // Re-trigger any `#collection-<id>` hash scroll after the async
  // render. The browser's initial jump fires immediately on page load,
  // before our render() finishes building the sections, so it finds no
  // matching element and gives up. Look at the hash again now that
  // every section is in the DOM and scroll the matching one into view.
  // Triggered for any hash matching the collection-anchor shape.
  scrollToHashCollectionIfPresent();
  if (location.hash.startsWith(`#${EDIT_COLLECTION_HASH_PREFIX}`)) void focusHashTarget(location.hash.slice(1));
  const params = new URLSearchParams(location.search);
  // First-run seeding. The SW opens this page with `?first_run` once on
  // install (see background.ts); only that auto-opened page seeds, so an
  // ordinary visit never adds the defaults. The flag is re-checked here
  // so a manual reload of the same URL can't seed twice.
  if (params.has('first_run')) {
    const done = await isFirstRunComplete();
    console.log(`[SourceMonkey] collections page opened with ?first_run (firstRunComplete=${done})`);
    if (!done) await seedDefaultCollectionsViaUi();
    else console.log('[SourceMonkey] first run already complete; skipping seed');
    scrubQueryParams(['first_run']);
  }
  if (params.has('refresh')) {
    await onRefreshAll();
    scrubQueryParams(['refresh']);
  }
  const addArg = params.get('add');
  if (addArg !== null) {
    await handleAddParam(addArg);
  }
  // After `?add`, so a collection added by the same URL is included —
  // and so a rejected `?refresh_file` message is the one left standing
  // on the page's single error line.
  if (params.has('refresh_local')) {
    await onRefreshSubset(localRefreshTargets(await readCollectionScripts()));
    scrubQueryParams(['refresh_local']);
  }
  const refreshFileArg = params.get('refresh_file');
  if (refreshFileArg !== null) {
    if (await handleRefreshFileParam(refreshFileArg)) scrubQueryParams(['refresh_file']);
  }
}

// First-run seeding, driven from the page so the user watches the
// familiar flow: each default collection's section appears, populated,
// as it loads. `addCollection` fetches each collection's scripts as
// part of the add, so no follow-up Refresh is needed. Marks first-run
// complete at the end (even if a collection failed) so it never repeats.
async function seedDefaultCollectionsViaUi(): Promise<void> {
  // Best-effort + run-once: mark complete in a finally so a failure on
  // one default (network down, bad URL) neither aborts the others nor
  // leaves the flag unset (which can't auto-retry — onInstalled fires
  // only once, so a re-open wouldn't carry ?first_run). A failed
  // collection still leaves a section with its Refresh button for
  // manual recovery.
  console.log('[SourceMonkey] first run: seeding default collections', [...DEFAULT_COLLECTIONS]);
  try {
    // Skip exact-repeat entries up front; addCollection also dedupes by
    // canonical collection path (so two spellings of the same
    // collection still yield one), this just avoids a pointless
    // duplicate-add round-trip for a byte-identical repeat. `jump:
    // false` so adding several in a row doesn't scroll-dance through
    // each new section.
    const seen = new Set<string>();
    for (const raw of DEFAULT_COLLECTIONS) {
      const path = raw.trim();
      if (!path || seen.has(path)) continue;
      seen.add(path);
      console.log('[SourceMonkey] first run: adding collection', path);
      addInput.value = path;
      try {
        await seedCollection(path);
      } catch (err) {
        console.info('[SourceMonkey] first-run add failed', path, err);
      }
    }
  } finally {
    // Clear the Add field — seedCollection clears it on success, but a
    // failed add leaves the last attempted path sitting there.
    addInput.value = '';
    console.log('[SourceMonkey] first run: seeding complete; marking firstRunComplete=true');
    // Caught here so a failure can't replace the outcome of the seeding
    // above. With the flag unset, a later install event opens the page
    // with `?first_run` again, and the add dedupes what is already
    // there.
    await markFirstRunComplete().catch((err: unknown) => {
      console.info('[SourceMonkey] could not record that first-run seeding is done:', describeError(err));
    });
  }
}

// Show what an incoming link asked for, in a tab that is already open
// and already scrolled somewhere else. The empty hash is a link to the
// page as a whole, which means the top.
//
// The URL is rewritten to match so a reload, a share, or the back
// button lands where the user is now looking — the same bargain
// `jumpToCollection` makes after an add.
async function focusHashTarget(hash: string): Promise<void> {
  // Both, not just the first render: a repaint empties the container
  // and refills it across several awaits, and a message that landed
  // mid-repaint would look for a section that is not in the document
  // yet and silently give up.
  await initialRenderDone;
  await repaintChain;
  if (!hash) {
    history.replaceState(null, '', location.pathname + location.search);
    scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  // `edit-collection-<id>` (the popup's "Collection options"): land on
  // the collection and open its edit dialog. The URL keeps the plain
  // collection anchor, so a reload doesn't reopen the dialog.
  const editId = hash.startsWith(EDIT_COLLECTION_HASH_PREFIX) ? hash.slice(EDIT_COLLECTION_HASH_PREFIX.length) : null;
  const anchor = editId !== null ? collectionAnchorId(editId) : hash;
  const section = document.getElementById(anchor);
  if (!section) return;
  history.replaceState(null, '', `#${anchor}`);
  section.scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (editId !== null) await onEditCollection(editId);
}

// If the URL hash points at a rendered collection section, scroll it
// into view. No-op otherwise; safe to call any time after render().
function scrollToHashCollectionIfPresent(): void {
  if (!location.hash.startsWith('#collection-')) return;
  const id = location.hash.slice(1);
  const section = document.getElementById(id);
  if (!section) return;
  section.scrollIntoView({ block: 'start' });
}

// Drive the Add flow from a `?add=` query param. Pre-fills the form
// field (so the user sees what was attempted) and runs the same flow
// as the manual Add button — a `.user.js` opens the install page in a
// new tab, clearing the field again as it goes; anything else opens the
// create dialog prefilled. The URL is scrubbed
// once the value was consumed; a cancelled dialog leaves it in place,
// so the user can copy/share/edit it.
async function handleAddParam(raw: string): Promise<void> {
  addInput.value = raw;
  const ok = await onAddViaDialog(raw, true);
  if (ok) scrubQueryParams(['add']);
}

// Every collection paired with the scripts it holds, which is what the
// `refresh-targets` selectors read. One storage scan for all the
// scripts rather than a per-collection read.
async function readCollectionScripts(): Promise<CollectionScripts[]> {
  const [collections, scripts] = await Promise.all([getCollections(), getAllScriptMetas()]);
  const byCollection = new Map<string, ScriptMeta[]>();
  for (const script of scripts) {
    const list = byCollection.get(script.collectionId);
    if (list) list.push(script);
    else byCollection.set(script.collectionId, [script]);
  }
  return collections.map((collection) => ({
    collection,
    scripts: byCollection.get(collection.id) ?? [],
  }));
}

// Drive a targeted refresh from a `?refresh_file=` query param.
// Returns whether the param was consumed: a value we couldn't act on —
// wrong shape, or naming somewhere no local collection or script covers
// — stays in the URL (like a rejected `?add`) with the reason on the
// page, so the caller can see what it asked for and fix it.
async function handleRefreshFileParam(raw: string): Promise<boolean> {
  const path = raw.trim();
  const problem = refreshPathProblem(path);
  if (problem !== null) {
    showPageError(`${REFRESH_FAILED_PREFIX}${problem}`);
    return false;
  }
  const targets = pathRefreshTargets(await readCollectionScripts(), path);
  if (targets.collectionIds.length === 0 && targets.scripts.length === 0) {
    showPageError(`${REFRESH_FAILED_PREFIX}No local collection or script covers ${path}`);
    return false;
  }
  showPageError(null);
  await onRefreshSubset(targets);
  return true;
}

// Remove the given query params from the current URL via
// replaceState. Preserves the rest of the URL (including any hash
// the add flow may have just written) so the user can reload without
// re-triggering a consumed action.
function scrubQueryParams(names: readonly string[]): void {
  const url = new URL(location.href);
  let changed = false;
  for (const name of names) {
    if (url.searchParams.has(name)) {
      url.searchParams.delete(name);
      changed = true;
    }
  }
  if (changed) history.replaceState(null, '', url.toString());
}

// Where local copies live, from the `smDownloadsCopies` setting. Null
// until the first copy ever has been made, and on a page that failed to
// read it — in both cases no row offers a file deletion, which is the
// safe answer. Seeded by `render`.
let currentCopiesSetting: DownloadsCopiesSetting | null = null;

// ---------- Initial render ----------

async function render(): Promise<void> {
  bannerSlot.textContent = '';
  collectionsEl.textContent = '';

  // Seed the status maps FIRST, before anything that can throw. Every
  // Status cell is drawn through them, and a repaint after a failed
  // render rebuilds the sections but does not re-seed these — so seeding
  // late would leave a recovered page painting every row without its
  // WARNING / ERROR / REJECTED promotion until an unrelated session
  // event happened along.
  currentLogLevels = await getAllMaxLogLevels();
  currentRejections = await readRejections();
  currentRefreshErrors = await readRefreshErrors();
  // Which directory holds the local copies, so every script row can be
  // asked — synchronously, while it is drawn — whether its file is one
  // SourceMonkey can delete. Re-read on every render, since a copy made
  // in another tab can be what created the setting.
  currentCopiesSetting = await readCopiesSetting();

  // Surface the file:// access state up-front. Without the toggle on
  // chrome://extensions, every fetch we try will fail.
  if (!(await isFileSchemeAccessAllowed())) {
    bannerSlot.appendChild(renderFileAccessBanner());
  }

  // The User Scripts API requires the user to flip the "Allow User
  // Scripts" toggle on chrome://extensions. Until they do, every
  // registration call throws — meaning no scripts actually inject even
  // though the badge still counts matches. Other failures (revoked permission, etc.)
  // surface their raw message so the user has something to grep for.
  await syncUserScriptsBanner();

  let collections = await getCollections();
  // One-shot backfill so older collection rows (pre-displayName) pick
  // up an inferred label on first view after upgrade. Asked of the
  // worker only when a row has none.
  if (collections.some(needsDisplayName)) {
    try {
      await backfillCollectionDisplayNames();
      collections = await getCollections();
    } catch (err) {
      // Cosmetic: the sections draw with the names they have.
      console.info('[SourceMonkey] display-name backfill failed', describeError(err));
    }
  }

  // Last of the three banners, because it is the most situational: it
  // appears only once a refresh has actually failed to save, where the
  // other two describe a setting that is wrong right now. It comes and
  // goes WITHOUT a reload (a failed refresh raises it, the next
  // successful one clears it), so it owns a sync of its own that the
  // repaint calls too.
  await syncStorageBanner(new Set(collections.map((s) => s.id)));

  const allScripts = await getAllScriptMetas();
  // Repair any collection whose `scriptIds` disagrees with the script
  // rows themselves. This is the page where the damage shows (a script
  // that runs but is listed nowhere). The worker does it from its own
  // read of the rows, and isn't waited for: a repair it writes repaints
  // this page like any other change, and failing is not worth
  // abandoning the render over.
  reconcileScriptMembership().catch((err: unknown) => {
    console.info('[SourceMonkey] membership reconcile failed', err);
  });
  if (collections.length === 0) {
    collectionsEl.appendChild(emptyPlaceholder());
    return;
  }
  // See `repaintFromStorage`.
  await preloadSiteIcons(allScripts);
  for (const collection of collections) {
    collectionsEl.appendChild(await renderCollectionSection(collection));
  }
  refreshMoveButtons();
  markDiskChanges();
}

function emptyPlaceholder(): HTMLElement {
  const p = document.createElement('p');
  p.className = 'placeholder empty-placeholder';
  p.textContent = 'No collections yet. Add one above.';
  return p;
}

// ---------- Per-section build ----------

async function renderCollectionSection(collection: StoredCollection): Promise<HTMLElement> {
  const collectionOn = isCollectionEnabled(collection);

  const section = document.createElement('section');
  section.className = 'collection';
  section.dataset.collectionId = collection.id;
  // For `markDiskChanges`, which works from the DOM after a paint.
  section.dataset.collectionPath = collection.path;
  syncManifestStatDataset(section, collection);
  // Stable per-collection anchor; lets deep links (and the post-add
  // `jumpToCollection` helper) scroll directly to this section.
  section.id = collectionAnchorId(collection.id);
  if (!collectionOn) section.classList.add('disabled');

  const header = document.createElement('div');
  header.className = 'collection-header';

  // Per-collection enable toggle sits left of the path so it visually
  // groups with the directory it controls and aligns with the
  // per-script toggle column below.
  const enableLabel = makeToggle(
    collectionOn,
    false,
    (next, label, solo) => void onToggleCollection(collection.id, next, label, solo).catch(onEnableFailure),
    'Enable scripts under this collection',
  );
  enableLabel.classList.add('collection-toggle');
  header.appendChild(enableLabel);

  const heading = document.createElement('h2');
  heading.appendChild(makeCollectionTypeBubble(collection.path));
  const nameEl = document.createElement('span');
  nameEl.className = 'collection-display-name';
  appendWithSlashBreaks(nameEl, effectiveDisplayName(collection));
  nameEl.dataset.displayName = effectiveDisplayName(collection);
  // Tooltip surfaces the raw stored path so the user can still see the
  // canonical URL / fs path behind a shortened display name. Container
  // collections have a synthetic identifier as their path, which would
  // leak `container:file` etc. — skip the tooltip in that case.
  if (!isContainerCollection(collection.path)) nameEl.title = collection.path;
  heading.appendChild(nameEl);
  header.appendChild(heading);

  const buttons = document.createElement('div');
  buttons.className = 'collection-buttons';

  buttons.appendChild(makeMoveButton('up', collection.id));
  buttons.appendChild(makeMoveButton('down', collection.id));

  // The same trash can the script rows carry, for the same reason: one
  // removal action must not look like two different controls on one
  // page. `record` — a collection's removal drops SourceMonkey's rows,
  // never the files behind them.
  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'remove-script';
  setDeleteIcon(removeBtn, 'record');
  removeBtn.title = 'Remove this collection';
  removeBtn.setAttribute('aria-label', 'Remove this collection');
  removeBtn.addEventListener('click', () => {
    onRemoveCollection(collection.id, section, removeBtn).catch((err: unknown) => {
      console.info('[SourceMonkey] remove collection failed', describeError(err));
    });
  });
  buttons.appendChild(removeBtn);

  // None for an sm-dev test collection, which its run names.
  if (!isSmDevCollection(collection.path)) {
    const editBtn = document.createElement('button');
    editBtn.className = 'edit-collection';
    // A gear, not a pencil: the dialog behind it is mostly options, and
    // a pencil would promise editing the scripts themselves.
    setGlyphButton(editBtn, '#sm-gear', 'Rename this collection or change its options');
    editBtn.addEventListener('click', () => void onEditCollection(collection.id));
    buttons.appendChild(editBtn);
  }

  // Rightmost, matching Refresh All at the top of the page: the same
  // action in the same place, whichever row of the page you are on.
  const refreshBtn = document.createElement('button');
  refreshBtn.className = 'refresh-collection';
  setGlyphButton(refreshBtn, '#sm-refresh', REFRESH_COLLECTION_LABELS.idle);
  refreshBtn.addEventListener('click', () => void onRefreshCollection(collection.id, refreshBtn));
  buttons.appendChild(refreshBtn);

  // Actions on this collection. None for an sm-dev test collection,
  // which the export leaves out.
  if (!isSmDevCollection(collection.path)) {
    const menuBtn = moreMenuButton('More actions for this collection');
    menuBtn.classList.add('collection-menu');
    menuBtn.title = 'More actions for this collection';
    menuBtn.addEventListener('click', () => openMenu(menuBtn, [
      ...(isContainerCollection(collection.path)
        ? [{ label: 'Import scripts into this collection\u2026', run: () => void runImport(collection.id) }]
        : []),
      {
        label: 'Export this collection\u2026',
        run: () => openExportDialog({ scope: { collectionId: collection.id }, collectionName: effectiveDisplayName(collection) }),
      },
    ]));
    buttons.appendChild(menuBtn);
  }

  header.appendChild(buttons);
  section.appendChild(header);

  // Both can be present: a collection can fail to save on one refresh
  // and fail to scan on the next. They describe different attempts and
  // different fixes, so neither replaces the other.
  const scanError = scanErrorText(collection);
  if (scanError) section.appendChild(makeSectionMessage('scan', scanError));
  const refreshError = refreshErrorText(collection.id);
  if (refreshError) section.appendChild(makeSectionMessage('refresh', refreshError));
  section.appendChild(await renderScriptBlock(collection, collectionOn));
  return section;
}

// The section's could-not-save line, or '' when this collection's last
// refresh stored cleanly. Reads the page-wide map rather than taking a
// parameter so the repaint path and the initial render can't disagree.
function refreshErrorText(collectionId: string): string {
  const reason = currentRefreshErrors[collectionId];
  return reason ? describeRefreshError(reason) : '';
}

// The section's scan-failure line, or '' when the collection scanned
// fine. Shared with the repaint so the two can't render the same
// failure two different ways.
//
// "Scan" is the name of our pipeline stage, not something the page ever
// shows — what the reader sees is a collection that didn't load.
// Phrased to avoid echoing what follows: most `scanError` values
// already open with `Could not read <url>: …`, so a `Could not …:`
// prefix would say "could not" twice in a row.
function scanErrorText(collection: StoredCollection): string {
  return collection.scanError ? `This collection did not load: ${collection.scanError}` : '';
}

// The section's script list: a table, or the message that stands in for
// it when the collection has no scripts. Both carry `.script-block` so
// a repaint can find whichever is present and swap one shape for the
// other without disturbing the header above it.
async function renderScriptBlock(
  collection: StoredCollection,
  collectionOn: boolean,
): Promise<HTMLElement> {
  const block = await renderScriptTable(collection, collectionOn);
  block.classList.add('script-block');
  return block;
}

async function renderScriptTable(collection: StoredCollection, collectionOn: boolean): Promise<HTMLElement> {
  const data = await getCollectionWithScriptMeta(collection.id);
  const inContainer = isContainerCollection(collection.path);
  const scripts = sortedByShownName(data?.scripts ?? [], inContainer);
  const localFiles = localFileScope(collection);

  if (scripts.length === 0) {
    return makeMessage(
      'empty',
      inContainer
        ? 'No scripts added yet'
        : 'No *.user.js files found',
    );
  }

  const allOn = allOnByIdentity(scripts.map((s) => ({ identity: rowIdentity(s), on: isScriptEnabled(s) })));

  const table = document.createElement('table');
  table.className = 'script-table';

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');

  const bulkHead = document.createElement('th');
  bulkHead.className = 'toggle-cell';
  const bulkBtn = makeBulkToggle(
    allOn,
    !collectionOn,
    (solo) => void onBulkToggleScripts(collection.id, bulkBtn, solo).catch(onEnableFailure),
    bulkTitle(collectionOn, allOn),
  );
  bulkHead.appendChild(bulkBtn);
  headRow.appendChild(bulkHead);

  for (const label of ['Name', 'Size', 'Status']) {
    const th = document.createElement('th');
    th.textContent = label;
    // Right-aligned with its cells, so the numbers line up.
    if (label === 'Size') th.className = 'size-cell';
    headRow.appendChild(th);
    if (label === 'Name' && inContainer) {
      // A scripts collection can mix local, web, and GitHub scripts,
      // so each row says where its own script loads from.
      const schemeTh = document.createElement('th');
      schemeTh.setAttribute('aria-label', 'Source');
      headRow.appendChild(schemeTh);
    }
  }
  // Trailing column carries the per-row remove button: every container
  // script has one, and outside a container a local copy has one that
  // deletes its file too. Empty text would announce as "blank column
  // header"; an aria-label tells screen-readers what it's for.
  const withActions = inContainer || scripts.some((s) => isDeletableCopy(s, collection.path));
  if (withActions) {
    const actionsTh = document.createElement('th');
    actionsTh.setAttribute('aria-label', 'Actions');
    headRow.appendChild(actionsTh);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  const settled: Promise<number>[] = [];
  for (const script of scripts) {
    const { row, iconCount } = renderScriptRow(script, collectionOn, collection.path, localFiles, withActions);
    tbody.appendChild(row);
    settled.push(iconCount);
  }
  table.appendChild(tbody);
  fitIconColumns(table, settled);
  return table;
}

function renderScriptRow(
  script: ScriptMeta,
  collectionOn: boolean,
  collectionPath: string,
  localFiles: LocalFileScope,
  // The table has a trailing action column. Every row in such a table
  // gets the cell, empty or not, or the columns stop lining up.
  withActions: boolean,
): { row: HTMLTableRowElement; iconCount: Promise<number> } {
  const inContainer = isContainerCollection(collectionPath);
  const scriptOn = isScriptEnabled(script);

  const tr = document.createElement('tr');
  tr.dataset.scriptId = script.id;
  tr.dataset.collectionId = script.collectionId;
  tr.dataset.identity = rowIdentity(script);
  // Stash the persisted status + errorMessage on the row so
  // `applyStatusCellsToDom` can repaint the Status cell after a
  // chrome.storage.session change without re-querying the store.
  const { errorMessage } = applyScriptRowDatasets(tr, script);
  if (!collectionOn || !scriptOn) tr.classList.add('disabled');

  const toggleCell = document.createElement('td');
  toggleCell.className = 'toggle-cell';
  toggleCell.appendChild(makeToggle(
    scriptOn,
    !collectionOn,    // disabled (greyed out) when the parent collection is off
    (next, label, solo) => void onToggleScript(script.id, next, label, solo).catch(onEnableFailure),
    collectionOn ? ENABLE_TITLE : COLLECTION_OFF_TITLE,
  ));
  tr.appendChild(toggleCell);

  const nameCell = document.createElement('td');
  nameCell.classList.add('name-cell');
  const iconCount = fillNameCell(nameCell, script, collectionPath, localFiles);
  tr.appendChild(nameCell);

  // For column parity with the live table. A container collection can't
  // actually reach here — its scan is built from the scripts it holds,
  // so nothing in one ever reads as vanished — but a table whose rows
  // disagree about column count stops lining up.
  if (inContainer) {
    const schemeCell = document.createElement('td');
    schemeCell.className = 'scheme-cell';
    schemeCell.appendChild(makeSchemeChip(script.relativePath));
    tr.appendChild(schemeCell);
  }

  const sizeCell = document.createElement('td');
  sizeCell.className = 'size-cell';
  sizeCell.textContent = formatScriptSize(script);
  tr.appendChild(sizeCell);

  const statusCell = document.createElement('td');
  paintStatusCell(statusCell, script.id, script.status, errorMessage, script.refreshError);
  tr.appendChild(statusCell);

  // Container rows always offer a remove button (every script inside a
  // container was added one-by-one and can be taken back out the same
  // way). A local copy offers one too, which deletes its file as well —
  // the one place SourceMonkey can. Every other row is the collection's
  // to add or drop on refresh.
  if (withActions) {
    const actionCell = document.createElement('td');
    actionCell.className = 'action-cell';
    if (inContainer) {
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'remove-script';
      setDeleteIcon(removeBtn, 'record');
      removeBtn.title = 'Remove this script';
      removeBtn.setAttribute('aria-label', 'Remove this script');
      removeBtn.addEventListener('click', () => {
        void onRemoveScript(script.id, script.collectionId, removeBtn);
      });
      actionCell.appendChild(removeBtn);
    } else if (isDeletableCopy(script, localFiles.collectionPath)) {
      actionCell.appendChild(makeDeleteCopyButton(script));
    }
    tr.appendChild(actionCell);
  }

  return { row: tr, iconCount };
}

// The icon column of a script table is as wide as its widest row —
// the number of site icons that row shows. Stored as a CSS custom
// property the stylesheet's slot width and hanging indent both read.
function setIconColumns(table: HTMLTableElement, count: number): void {
  table.style.setProperty('--icon-cols', String(count));
}

// The most icons any slot in this table currently holds. A slot whose
// favicons are still loading counts at its estimate — its icons are
// already there as globes.
function widestIconSlot(table: HTMLTableElement): number {
  let widest = 1;
  for (const slot of table.querySelectorAll('td.name-cell .site-icon')) {
    widest = Math.max(widest, slot.childElementCount);
  }
  return widest;
}

// Fit the icon column to the rows now in the table, twice: right away,
// from the header-derived estimates the fresh slots hold, so nothing
// overflows while favicons load; and again once `settling` (the
// rebuilt slots' promises) has resolved, because sites sharing one
// favicon collapse to a single icon and the column may narrow. One
// shift per pass, not one per row. Measured from the rows on screen
// rather than from what the promises carry, so rows that came or went
// in another pass meanwhile are counted too.
function fitIconColumns(table: HTMLTableElement, settling: readonly Promise<unknown>[]): void {
  setIconColumns(table, widestIconSlot(table));
  if (settling.length === 0) return;
  // No isConnected guard: a section is built detached and attached
  // later, and a table whose favicons all came from cache can settle
  // before that. Styling a detached table is harmless. `allSettled` so
  // one slot's failure can't skip the fit for the rest.
  void Promise.allSettled(settling).then(() => setIconColumns(table, widestIconSlot(table)));
}

// Build (or rebuild) the Name cell's contents: favicon slot and the
// linked name. Shared with the live in-place
// row update, which re-runs it when a refresh changed something this
// cell shows — otherwise a script whose `@match` or `@description` was
// edited keeps the old site's favicon and the old hover text until the
// section happens to be rebuilt for an unrelated reason.
function fillNameCell(
  nameCell: HTMLTableCellElement,
  script: ScriptMeta,
  collectionPath: string,
  // Where this script's collection allows local file overrides to come
  // from. Threaded alongside the path — both are per-collection facts
  // the row needs and neither is worth re-loading the collection row
  // for.
  localFiles: LocalFileScope,
  // Resolves with how many icons the slot holds once its favicons have
  // loaded — see `renderSiteIconInto`.
): Promise<number> {
  const inContainer = isContainerCollection(collectionPath);
  nameCell.textContent = '';
  // Slot for the favicons: a fixed-width container so the name
  // text always starts at the same x-position. renderSiteIconInto
  // synchronously paints one globe placeholder (clickable when the
  // script's @match yields a usable origin), then fills in each site's
  // favicon, with duplicates merged, once the fetches resolve.
  const iconSlot = document.createElement('span');
  iconSlot.className = 'site-icon';
  nameCell.appendChild(iconSlot);
  const iconCount = renderSiteIconInto(iconSlot, script, localSearchRoots(script.fileUrl, localFiles));
  const a = document.createElement('a');
  // Slash-aware appender (not textContent) so a long name wraps at `/`
  // boundaries before breaking mid-segment, matching the collection
  // heading and the viewer's Location row.
  appendWithSlashBreaks(a, nameCellText(script, inContainer));
  // Hovering the name surfaces where the script came from and what it
  // says it does. Scoped to the anchor so the Size / Status cells
  // (which carry their own meaning) don't inherit it as a row-wide
  // tooltip.
  a.title = nameCellTooltip(script);
  a.href = viewerUrl(script.id);
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  // A local file that has been deleted or changed gets a chip after
  // the name, painted by `markDiskChanges` once the section is on
  // screen.
  const tag = scriptFileTag(script, collectionPath);
  if (tag) tagLocalFile(a, tag);
  nameCell.appendChild(a);
  // Record what this cell was drawn from, so the next repaint can skip
  // it unless one of those inputs moved.
  nameCellKeys.set(script.id, nameCellKey(script, localFiles));
  shownNames.set(script.id, nameCellText(script, inContainer));
  return iconCount;
}

// Text in the Name column: the script's own `@name`, falling back to
// its location when it declares none (or hasn't parsed far enough to
// have a header at all).
//
// The fallback is shortened for container scripts, whose `relativePath`
// is the whole URL — a column that has to stay scannable at table width
// can't carry one. A manifest entry may itself be an absolute URL, so
// the non-container branch goes through displayLocation too — otherwise
// the same script reads encoded here and decoded in the viewer. Local
// directory entries have no scheme and pass through untouched.
//
// Only the column shortens. The tooltip below always gives the location
// in full, which is the point of having it there.
function nameCellText(script: ScriptMeta, inContainer: boolean): string {
  const location = inContainer
    ? scriptBasename(script.relativePath)
    : displayLocation(script.relativePath);
  return scriptDisplayName(script, location);
}

// A collection's rows are listed by the name they show, not stored
// order: that order is scan or install order, which nothing on the page
// reveals. Ties (two scripts with the same `@name`) fall back to the
// location so the order stays stable across repaints.
function sortedByShownName(scripts: readonly ScriptMeta[], inContainer: boolean): ScriptMeta[] {
  return scripts
    .map((script) => ({ script, name: nameCellText(script, inContainer) }))
    .sort((a, b) => compareScriptNames(a.name, b.name)
      || compareScriptNames(a.script.relativePath, b.script.relativePath))
    .map(({ script }) => script);
}

// Tooltip on the name link: the whole location first — the column no
// longer shows it, and it's what tells two same-named scripts apart —
// then a blank line, then the parsed `@description`, or "No description"
// when the script declares none.
function nameCellTooltip(script: ScriptMeta): string {
  const desc = script.header ? getValue(script.header, 'description') : undefined;
  return `${displayLocation(script.relativePath)}\n\n${desc?.trim() || 'No description'}`;
}

// True when this script is a local copy whose file SourceMonkey can
// delete — which takes its collection as well as the row (see
// `deletableCopyPath`). Reads the setting the render seeded, so it can
// be asked while a row is being built.
function isDeletableCopy(script: ScriptMeta, collectionPath: string | undefined): boolean {
  const collection = collectionPath === undefined ? null : { path: collectionPath };
  return deletableCopyPath(script, collection, currentCopiesSetting) !== null;
}

// The trash can on a local copy's row. Unlike the other two, this one
// deletes the file — hence the badged glyph and the red resting colour
// (src/extension/delete-icon.ts). The dialog says so too, names the path, and
// offers the dependency files that came with it (src/extension/delete-dialog.ts).
function makeDeleteCopyButton(script: ScriptMeta): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'remove-script';
  setDeleteIcon(btn, 'file');
  btn.title = 'Delete local script file';
  btn.setAttribute('aria-label', 'Delete local script file');
  btn.addEventListener('click', () => void onDeleteCopy(script, btn));
  return btn;
}

async function onDeleteCopy(script: ScriptMeta, btn: HTMLButtonElement): Promise<void> {
  const result = await openDeleteDialog({ script });
  if (!result) return;
  showPageError(null);
  btn.disabled = true;
  // The record goes with the file. Not a refresh of the collection: it
  // would drop the row too, but at the cost of a scan, and here we know
  // exactly why the file is gone.
  //
  // Its own handler rather than `onRemoveScript`, which reports a
  // failure to the console: by the time this runs the FILE is already
  // gone, so a row that stays needs to say why on the page. Both of
  // the reports below are things only this path can produce.
  try {
    await removeScript(result.scriptId);
  } catch (err) {
    showPageError(`The file was deleted, but its record could not be removed: ${describeError(err)}`);
    btn.disabled = false;
    return;
  }
  // Files left on disk after the script itself went. The same report
  // the viewer gives, so the two surfaces say the same thing about the
  // same deletion.
  if (result.dependencyErrors.length > 0) showPageError(result.dependencyErrors.join(' '));
  await repaintPage();
}

async function onRemoveScript(scriptId: string, _collectionId: string, btn: HTMLButtonElement): Promise<void> {
  btn.disabled = true;
  try {
    await removeScript(scriptId);
    // Write, then repaint — the same shape as the other flow handlers.
    // Hand-rolling the row removal here also meant hand-rolling the
    // "collection is now empty" message, which said "No *.user.js files
    // found." even on a container collection, whose empty state is
    // "No scripts added yet". Only container rows have this
    // button, so that was the common case, and no later repaint would
    // correct it.
    await repaintPage();
  } catch (err) {
    // Surface the failure rather than swallowing it — if storage rejects
    // (quota, disk error), the row stays, the button comes back, and the
    // user gets at least a console line to investigate with.
    console.info('[SourceMonkey] removeScript failed', err);
    btn.disabled = false;
  }
}

// ---------- Flow handlers ----------

// First-run seeding's add path: the `DEFAULT_COLLECTIONS` locations,
// added without asking. Everything a user types goes through
// `onAddViaDialog` instead — the dialog is where a location gets a
// name, an options choice, and a readability check — so this is
// deliberately the plainer route: no dialog, no preview hand-off, no
// scroll (several land in a row and would scroll-dance through each).
//
// The caller reports failures from its own `catch`, so nothing is
// returned; the shape checks here are belt and braces over a hardcoded
// list.
async function seedCollection(rawPath: string): Promise<void> {
  const path = rawPath.trim();
  if (!path) return;
  if (!isValidLocationShape(path)) {
    showPageError(`Location ${LOCATION_SHAPES}`);
    return;
  }
  showPageError(null);

  setAddFormBusy(true);
  try {
    // Normalize once up front so any failure (rate limit, private repo,
    // network down) surfaces here with a user-visible message instead
    // of dead-ending in the page console. `addCollection` re-normalizes
    // internally, but the second call is a no-op on already-canonical
    // inputs (idempotent for non-github and for already-resolved github
    // `/tree/<ref>/...` URLs).
    let stored;
    try {
      stored = canonicalCollectionInput(await normalizeCollectionInput(path));
    } catch (err) {
      showPageError(err instanceof Error ? err.message : String(err));
      return;
    }
    // `addCollection` seeds the collection row inside its write lock and
    // then refreshes it, so a storage failure surfaces here as a throw
    // with the seeded row already committed. Without this the add would
    // dead-end: the form un-busies and nothing says why no section
    // appeared.
    //
    // The repaint is what makes it recoverable. Re-adding won't work —
    // the row exists, so a second attempt is a duplicate — but painting
    // the section puts its Refresh button on screen, next to the
    // could-not-be-saved message explaining what to fix first.
    let result;
    try {
      result = await addCollection(stored);
    } catch (err) {
      showPageError(describeError(err));
      await repaintPage();
      return;
    }
    addInput.value = '';
    // A null result is a repeat of a location already seeded (two
    // DEFAULT_COLLECTIONS entries spelling one collection): nothing to
    // add, and the section is already on screen.
    if (!result) return;
    // The add wrote storage; a repaint builds the new section and puts
    // everything in index order.
    await repaintPage();
  } finally {
    setAddFormBusy(false);
  }
}

// The Add field's routing, by what was typed:
//   - a single `.user.js` (URL, `file://`, or absolute path) → the
//     install page, which asks where to put it;
//   - any other URL / absolute path → the create dialog, prefilled
//     with the location, which is what the dialog classifies and names
//     the collection from;
//   - blank → the create dialog, empty;
//   - anything else → the create dialog, with the text as the name of
//     a new scripts collection.
// The dialog does its own validation and probing, and only resolves
// with a collection that now exists. Returns whether the input was
// consumed — a cancelled dialog leaves the field (and a `?add=` param)
// as it was.
async function onAddViaDialog(rawPath: string, jump: boolean): Promise<boolean> {
  const text = rawPath.trim();
  showPageError(null);
  if (text && isValidLocationShape(text) && isSingleFileInput(text)) {
    // A new tab: the install question is about one file, and answering
    // it should not cost the user the collections page they were
    // adding from.
    try {
      await openExtensionTab(chrome.runtime.getURL(previewUrl(text)));
    } catch (err) {
      // Reported here rather than left to reject: an unhandled
      // rejection in an extension page lands in
      // chrome://extensions/?errors and reads as SourceMonkey being
      // broken. The field keeps what was typed, so the user can retry.
      showPageError(`The install page could not be opened: ${describeError(err)}`);
      return false;
    }
    // Cleared only once the tab is open — the same order the dialog
    // path below uses, so a failure never costs the user their text.
    addInput.value = '';
    return true;
  }
  // Anything shaped like a location — even a bad one, such as a bare
  // `/` or a relative path — goes in as the location, so the dialog's
  // shape check is what says what's wrong with it. Only text with no
  // scheme and no leading slash reads as a name.
  let request: CollectionDialogRequest;
  if (!text) request = { mode: 'create' };
  else if (looksLikeLocation(text)) request = { mode: 'create', prefill: { location: text } };
  else request = { mode: 'create', prefill: { name: text } };
  const outcome = await openCollectionDialog(request);
  if (!outcome) return false;
  addInput.value = '';
  await repaintPage();
  if (jump) jumpToCollection(outcome.collection.id);
  return true;
}

// The Edit button: rename, or change the local-overrides option. A
// changed option only affects the next refresh, so the refresh is part
// of the save — otherwise the change would appear to do nothing until
// something else happened to touch the collection.
async function onEditCollection(id: string): Promise<void> {
  // Re-read rather than trust the rendered row: the name may have been
  // changed from another tab since this section was painted.
  const data = await getCollectionWithScriptMeta(id);
  if (!data) return;
  const outcome = await openCollectionDialog({ mode: 'edit', collection: data.collection });
  if (!outcome) return;
  if (outcome.localFilesChanged) await updateCollection(id, 'manual');
  await repaintPage();
}

// What the Add field hands to the dialog as a location rather than a
// name: any URL scheme, or a leading slash.
function looksLikeLocation(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value) || value.startsWith('/');
}

// Show or clear the page's error line, which sits below the Add form.
// Pass null to hide it; pass a string to surface a validation failure.
// Shared by the Add flow, the `?refresh_file=` rejections, and what a
// local-copy deletion could not finish — one line, so the page never
// has two competing error slots.
function showPageError(message: string | null): void {
  if (message === null) {
    addErrorEl.textContent = '';
    addErrorEl.hidden = true;
    return;
  }
  addErrorEl.textContent = message;
  addErrorEl.hidden = false;
}

// Scroll the section into view and tag the URL with its anchor so a
// reload or share-the-URL preserves the selection. Triggered after a
// successful add and after a duplicate-add (where the section already
// existed).
function jumpToCollection(collectionId: string): void {
  const section = findSection(collectionId);
  if (!section) return;
  history.replaceState(null, '', `#${collectionAnchorId(collectionId)}`);
  section.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Build an Up or Down arrow button for a collection row. Centralizes
// the arrow glyph, the visible/announced label, and the click wiring so
// both buttons stay in lockstep when copy or behaviour changes.
function makeMoveButton(direction: 'up' | 'down', collectionId: string): HTMLButtonElement {
  const arrow = direction === 'up' ? '↑' : '↓';
  const label = `Move collection ${direction}`;
  const btn = document.createElement('button');
  btn.type = 'button';
  // `.icon-btn` even though the arrow is a character rather than a
  // sprite glyph: it is one of five buttons in the header row, and the
  // row lines up because they all wear the same fixed box.
  btn.className = `icon-btn move-collection move-${direction}`;
  btn.textContent = arrow;
  btn.title = label;
  btn.setAttribute('aria-label', label);
  btn.addEventListener('click', () => void onMoveCollection(collectionId, direction));
  return btn;
}

// Serializes Up/Down clicks across every collection row. A user
// clicking two arrows in quick succession (or one arrow on each of two
// rows) would otherwise issue two interleaved read-modify-write cycles
// on the `"collections"` index, last-write-wins — leaving the DOM out
// of sync with storage. Routing every move through this gate keeps the
// index write
// + DOM swap atomic w.r.t. other moves on this page.
let moveInFlight: Promise<void> = Promise.resolve();

// Swap the collection one position up or down in the index and reflect
// the change in the DOM without rebuilding any section. The store call
// rewrites the index row; the local DOM move swaps the two sibling
// sections (cheaper than a re-render and preserves the per-section
// state — checkbox spinners, scroll position, row highlights).
async function onMoveCollection(
  id: string,
  direction: 'up' | 'down',
): Promise<void> {
  const run = async (): Promise<void> => {
    const section = findSection(id);
    if (!section) return;
    const sibling = direction === 'up'
      ? section.previousElementSibling
      : section.nextElementSibling;
    if (!(sibling instanceof HTMLElement) || !sibling.classList.contains('collection')) return;
    setMoveButtonsBusy(true);
    try {
      await moveCollection(id, direction);
      if (direction === 'up') {
        collectionsEl.insertBefore(section, sibling);
      } else {
        collectionsEl.insertBefore(sibling, section);
      }
    } finally {
      // Clearing the busy flag first lets refreshMoveButtons run: it
      // recomputes per-position disabled state, which is what undoes
      // setMoveButtonsBusy — each arrow gets the correct enabled value
      // for its new index.
      setMoveButtonsBusy(false);
      refreshMoveButtons();
    }
  };
  // Chain onto the prior in-flight move so the read-modify-write of
  // the index is serialized. We swallow prior rejection so one
  // failure doesn't poison subsequent moves; each run() also catches
  // its own errors via the finally above.
  moveInFlight = moveInFlight.then(run, run);
  await moveInFlight;
}

// Disable every move arrow on the page while a move is in flight. The
// follow-up refreshMoveButtons() restores per-position disabled state
// (Up off on first, Down off on last, everything else on).
// Set while a move's index write is in flight. The write echoes back
// into the live storage watcher, whose reconcile ends in a
// refreshMoveButtons() — which would re-enable every arrow in the
// middle of the move it belongs to.
let moveButtonsBusy = false;

function setMoveButtonsBusy(busy: boolean): void {
  moveButtonsBusy = busy;
  for (const btn of collectionsEl.querySelectorAll<HTMLButtonElement>('.move-collection')) {
    btn.disabled = busy;
  }
}

// Walk every rendered collection section and set each Up/Down button's
// disabled state from its current position: Up off on the first
// section, Down off on the last. Called after the initial render,
// after any move, and after add/remove flows change the section count.
// Filters on `section.collection` so the empty-list placeholder
// (`p.empty-placeholder`) that shares this container is ignored.
function refreshMoveButtons(): void {
  if (moveButtonsBusy) return;
  const sections = collectionsEl.querySelectorAll<HTMLElement>('section.collection');
  const last = sections.length - 1;
  sections.forEach((section, i) => {
    const up = section.querySelector<HTMLButtonElement>('.move-up');
    const down = section.querySelector<HTMLButtonElement>('.move-down');
    if (up) up.disabled = i === 0;
    if (down) down.disabled = i === last;
  });
}

async function onRemoveCollection(id: string, section: HTMLElement, btn: HTMLButtonElement): Promise<void> {
  // Guard non-empty collections behind a confirm: removing a collection
  // drops every script it owns, and the action is irreversible from the
  // UI. For an empty collection there's nothing to lose, so skip the
  // prompt.
  //
  // The count read is a snapshot — a background refresh adding or
  // removing a script while the dialog is open could leave the number
  // slightly stale. The window is short and the error bounded; not
  // worth a re-read.
  const data = await getCollectionWithScriptMeta(id);
  if (!data) {
    // Collection row has been removed elsewhere (e.g. another tab).
    // Nothing to remove from the store; drop the orphan section.
    section.remove();
    return;
  }
  const scriptCount = data.scripts.length;
  if (scriptCount > 0) {
    const scriptWord = scriptCount === 1 ? 'script' : 'scripts';
    if (!confirm(`Remove collection with ${scriptCount} ${scriptWord}?`)) return;
  }

  section.classList.add('removing');
  btn.disabled = true;
  try {
    await removeCollection(id);
  } catch (err) {
    section.classList.remove('removing');
    btn.disabled = false;
    // On the page, where the user is looking, rather than the console.
    showPageError(`Could not remove the collection: ${describeError(err)}`);
    return;
  }
  // The repaint drops the section and, if that was the last collection,
  // puts the empty placeholder back.
  await repaintPage();
}

// Snapshot / refresh / repaint / highlight — the shape every refresh
// flow on this page shares. `run` does the actual refreshing;
// `collectionIds` names the sections to diff, which for a
// script-level refresh is the section that holds the script.
//
// Refresh may have added/removed scripts, flipped statuses, etc. The
// repaint brings the sections' rows in line with what was just
// written; then the rows that actually changed get their highlight.
// Rows are updated in place, so the highlight goes onto the same `<tr>`
// the user was already looking at.
//
// Never throws: a refresh that couldn't be saved already recorded its
// reason in session storage, so the repaint is what puts it on screen.
// Callers are click handlers whose `void` would drop a rejection
// silently, leaving the user watching a button finish with no
// explanation.
async function refreshAndHighlight(
  collectionIds: readonly string[],
  label: string,
  run: () => Promise<unknown>,
): Promise<void> {
  try {
    // Snapshot the prior scripts so we can highlight rows that
    // actually changed after the refresh lands.
    const priors = new Map<string, ScriptMeta[]>();
    await Promise.all(collectionIds.map(async (id) => {
      const before = await getCollectionWithScriptMeta(id);
      priors.set(id, before?.scripts ?? []);
    }));
    await run();
    await repaintPage();
    for (const id of collectionIds) {
      const section = findSection(id);
      if (!section) continue;
      const after = await getCollectionWithScriptMeta(id);
      applyChangeHighlights(
        section,
        priors.get(id) ?? [],
        after?.scripts ?? [],
        // A collection that has itself gone leaves no row to read the
        // local-overrides toggle from; ghosts there resolve their icons
        // without local stand-ins.
        after ? localFileScope(after.collection) : { enabled: false },
      );
    }
  } catch (err) {
    console.info(`[SourceMonkey] ${label} failed`, err);
    await repaintPage();
  }
}

async function onRefreshCollection(id: string, btn: HTMLButtonElement): Promise<void> {
  setGlyphButtonBusy(btn, true, REFRESH_COLLECTION_LABELS);
  try {
    // Goes through script-updater so a background opportunistic check
    // already in flight for this collection coalesces with our click
    // instead of doing redundant work.
    await refreshAndHighlight([id], 'collection refresh', () => updateCollection(id, 'manual'));
  } finally {
    setGlyphButtonBusy(btn, false, REFRESH_COLLECTION_LABELS);
  }
}

// Refresh every registered directory in parallel, then re-render each
// section in place and flash any rows that changed. Triggered by the
// header "Refresh All" button and by ?refresh in the URL.
async function onRefreshAll(): Promise<void> {
  setRefreshAllBusy(true);
  try {
    // Inside the try, and inside a flow that swallows: the click
    // handler's `void` would turn a throw from this read into an
    // unhandled rejection, which Chrome files under the extension's
    // errors even though nothing here is the user's to fix.
    const collections = await getCollections();
    // `refreshAllCollections` records each collection's failure and
    // keeps going, so anything `refreshAndHighlight` catches broke
    // outside that loop. It repaints anyway: whatever DID save should
    // show, and any recorded per-collection reason goes up with it.
    await refreshAndHighlight(
      collections.map((c) => c.id),
      'refresh all',
      () => updateAllCollections('manual'),
    );
  } catch (err) {
    console.info('[SourceMonkey] refresh all failed', err);
  } finally {
    setRefreshAllBusy(false);
  }
}

// Refresh a chosen subset — the `?refresh_local` / `?refresh_file=`
// triggers. Collections refresh whole (a re-scan is what notices added,
// renamed, and deleted files); individually-selected scripts refresh on
// their own, which is the only option for a local script in a scripts
// collection since it has no directory to scan.
//
// Bounded like the store's own fan-out so a wide target (a tree holding
// many collections) doesn't open every collection's fetch set at once.
//
// Unlike Refresh All this is a plain loop over `updateCollection`, so
// the targets don't share one file-fetch cache and each runs its own
// update-probe pass. Fine for a subset (usually one collection); don't
// assume parity with `refreshAllCollections` here.
async function onRefreshSubset(targets: RefreshTargets): Promise<void> {
  setRefreshAllBusy(true);
  try {
    // Highlight the section behind each refreshed script too, not just
    // the wholly-refreshed collections.
    const sections = new Set(targets.collectionIds);
    for (const script of targets.scripts) sections.add(script.collectionId);
    await refreshAndHighlight([...sections], 'targeted refresh', async () => {
      // Per-target catch, the way `refreshAllCollections` wraps each
      // collection: `mapWithConcurrency` rejects on the FIRST failure,
      // which would otherwise abandon the sibling collections and skip
      // the script pass below entirely. Each failure has already
      // recorded its own reason where the repaint will show it.
      await mapWithConcurrency(
        targets.collectionIds, FETCH_COLLECTIONS_CONCURRENCY,
        (id) => updateCollection(id, 'manual').catch((err: unknown) => {
          console.info(`[SourceMonkey] collection refresh failed: ${describeError(err)}`);
          return null;
        }),
      );
      await mapWithConcurrency(
        targets.scripts, FETCH_SCRIPTS_PER_COLLECTION_CONCURRENCY,
        (script) => updateScript(script.id, 'manual', 'force').catch((err: unknown) => {
          console.info(`[SourceMonkey] script refresh failed: ${describeError(err)}`);
          return null;
        }),
      );
    });
  } finally {
    setRefreshAllBusy(false);
  }
}

// Decide per script whether it changed in a refresh and tag the
// corresponding row. Two independent signals ride on the row, because
// they answer two different questions:
//
//   - WHAT happened to it — `row-added` / `row-updated`, which paint
//     the wash and put a "New" / "Updated" chip beside the status.
//   - HOW it came out — `row-failed`, which overrides the wash with
//     red. A script that arrived broken is still new, so it keeps its
//     chip and only loses the green.
//
// Scripts the refresh DROPPED get a tombstone instead: an inert ghost
// row in the place the script used to hold (see `addTombstones`).
//
// The tags persist on the row until the next refresh, which clears the
// prior ones before applying its own — rows are reused across a
// repaint, so nothing else drops them.
//
// Classification:
//   - newly-added         → row-added (+ row-failed when it isn't ok)
//   - dropped             → tombstone row
//   - re-read             → row-updated (+ row-failed when it isn't ok)
//   - status changed but no re-read (rare) → row-updated, likewise
//   - refresh just failed (refreshError newly set / changed, while the
//     cached body keeps running) → row-failed, no chip: nothing was
//     re-read, so there is no update to announce
//   - refresh recovered (refreshError cleared) → row-updated, even when
//     the body is unchanged (304 / size+mtime skip preserve loadedAt)
//   - otherwise           → no tag (unchanged path: cheap-skip
//                            optimization, OR genuine no-op)
function applyChangeHighlights(
  section: HTMLElement,
  prior: ScriptMeta[],
  next: ScriptMeta[],
  // The collection's local-file scope, so a ghost resolves its favicon
  // exactly as the live row did — including an `@icon` that points at a
  // file on disk.
  localFiles: LocalFileScope,
): void {
  // Clear the last refresh's tags first. Rows survive a refresh now
  // (they're updated in place, not rebuilt), so without this a row that
  // changed once would stay highlighted through every later refresh.
  for (const row of section.querySelectorAll<HTMLTableRowElement>('tr[data-script-id]')) {
    row.classList.remove('row-added', 'row-updated', 'row-failed');
  }
  removeTombstones(section);
  const priorById = new Map(prior.map((s) => [s.id, s]));
  for (const n of next) {
    const change = classifyChange(priorById.get(n.id), n);
    if (!change) continue;
    const row = section.querySelector<HTMLTableRowElement>(
      `tr[data-script-id="${cssEscape(n.id)}"]`,
    );
    if (!row) continue;
    if (change.kind) row.classList.add(`row-${change.kind}`);
    if (change.failed) row.classList.add('row-failed');
  }
  addTombstones(section, prior, new Set(next.map((s) => s.id)), localFiles);
}

interface RowChange {
  // What to say happened, or null when the row changed without there
  // being an update to announce (a fresh refresh failure, a file that
  // vanished out from under a row that stayed).
  kind: 'added' | 'updated' | null;
  failed: boolean;
}

function classifyChange(
  prior: ScriptMeta | undefined,
  next: ScriptMeta,
): RowChange | null {
  const failed = next.status !== 'ok';
  if (!prior) return { kind: 'added', failed };
  // A fresh refresh failure (the cached body keeps running, so status
  // stays `ok` and loadedAt doesn't move) still deserves a red flash so
  // the user notices the collection went stale.
  if (next.refreshError && next.refreshError !== prior.refreshError) {
    return { kind: null, failed: true };
  }
  // Recovery: a row that WAS refresh-failed and now isn't reads as an
  // update even when the body is unchanged (HTTP 304 / size+mtime skip,
  // which preserve loadedAt) — otherwise the row would silently drop its
  // red highlight with no "it came back" confirmation.
  if (prior.refreshError && !next.refreshError) return { kind: 'updated', failed };
  const reread = next.loadedAt !== prior.loadedAt;
  const statusChanged = next.status !== prior.status;
  if (!reread && !statusChanged) return null;
  return { kind: 'updated', failed };
}

// ---------- Tombstones (dropped scripts) ----------
//
// A script the scan no longer reports is DROPPED: its row, its storage
// key, its Log and its `gmval:` values all go, and none of it comes
// back if the file returns (see docs/storage.md, "Vanished entries").
// Nothing else on the page would say so — the row would simply not be
// there the next time the user looked.
//
// So a refresh that drops a script leaves a ghost of it in the row's
// old place: struck through, greyed, and inert. It lives in the DOM
// only, alongside the other refresh tags: the next refresh clears it,
// and a reload never rebuilds it.
//
// The ghost carries `data-tombstone` and NOT `data-script-id`, which is
// what keeps every walker on this page — status repaints, log-suffix
// updates, bulk-toggle counting, row reconciliation — away from a row
// with no stored script behind it.

// `data-tombstone-after` names the surviving row a ghost sits below, so
// it can be put back in place after a repaint re-seats the live rows.
// Empty means "top of the table".
//
// The comparison is the refresh's own before/after snapshot, so a script
// that left for another reason while the refresh ran (a trash can click
// here, a removal in another tab) is ghosted as though the refresh
// dropped it. A narrow window, and the row did leave — only the reason
// on the hover text would be wrong.
function addTombstones(
  section: HTMLElement,
  prior: readonly ScriptMeta[],
  survivingIds: ReadonlySet<string>,
  localFiles: LocalFileScope,
): void {
  // No table to hang them off: the collection lost its last script and
  // the block was swapped for the "no scripts" message.
  const tbody = section.querySelector<HTMLElement>(':scope > .script-block tbody');
  if (!tbody) return;
  const inContainer = !!section.querySelector('thead th[aria-label="Source"]');
  const withActions = !!section.querySelector('thead th[aria-label="Actions"]');
  let anchorId = '';
  // Walked in the order the rows were shown, so each ghost is anchored
  // below the row it sat under.
  for (const script of sortedByShownName(prior, inContainer)) {
    if (survivingIds.has(script.id)) {
      anchorId = script.id;
      continue;
    }
    tbody.appendChild(
      renderTombstoneRow(script, anchorId, inContainer, withActions, localFiles),
    );
  }
  placeTombstones(tbody);
  // A ghost keeps its icons, and the wide row that just left may have
  // been the one the column was fitted to.
  fitIconColumns(tbody.parentElement as HTMLTableElement, []);
}

function renderTombstoneRow(
  script: ScriptMeta,
  anchorId: string,
  inContainer: boolean,
  withActions: boolean,
  localFiles: LocalFileScope,
): HTMLTableRowElement {
  const tr = document.createElement('tr');
  tr.className = 'row-removed';
  tr.dataset.tombstone = script.id;
  tr.dataset.tombstoneAfter = anchorId;
  // Announced as not-actionable rather than made `inert`: an inert
  // subtree isn't hit-tested, which silently takes the row's own
  // explanation (the Status cell's hover text) away with it, and hides
  // the row from screen readers — on the one row whose whole purpose is
  // to say something irreversible happened. Nothing here is focusable
  // anyway: the checkbox is disabled and the favicon is de-linked below.
  tr.setAttribute('aria-disabled', 'true');

  const toggleCell = document.createElement('td');
  toggleCell.className = 'toggle-cell';
  // The same box a live row's toggle sits in, under a different class:
  // the bulk toggle's census counts `.toggle` checkboxes and this one
  // must not join it, but a bare baseline-aligned checkbox would sit a
  // pixel or two off and make the ghost row a different height from the
  // rows around it.
  const toggleBox = document.createElement('span');
  toggleBox.className = 'toggle-ghost';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = isScriptEnabled(script);
  cb.disabled = true;
  toggleBox.appendChild(cb);
  toggleCell.appendChild(toggleBox);
  tr.appendChild(toggleCell);

  const nameCell = document.createElement('td');
  nameCell.className = 'name-cell';
  // The favicon slot is painted the same way a live row's is, from the
  // snapshot we still hold: the icon is what the eye finds the row by,
  // and an empty slot would leave the name hanging in the column's
  // negative text-indent, out of line with every row around it. The
  // fetch it starts is the one the live row just made, so it comes back
  // from the icon cache.
  const iconSlot = document.createElement('span');
  iconSlot.className = 'site-icon';
  nameCell.appendChild(iconSlot);
  const iconsDone = renderSiteIconInto(iconSlot, script, localSearchRoots(script.fileUrl, localFiles));
  // Drop the href in place rather than replacing the anchor: the icon
  // fetch resolves into the very element `renderSiteIconInto` built, so
  // swapping it out would leave the favicon painting into a detached
  // node. Without the href it is no longer a link or a tab stop, which
  // is what a row with nothing left to open should be.
  //
  // Again once the icons have loaded: until then the slot may hold only
  // the first site's icon, and the others arrive as links.
  const unlinkIcons = (): void => {
    for (const iconLink of iconSlot.querySelectorAll('a.site-icon-inner')) {
      iconLink.removeAttribute('href');
      iconLink.removeAttribute('target');
      iconLink.removeAttribute('rel');
    }
  };
  unlinkIcons();
  void iconsDone.then(unlinkIcons);
  // Text, not a link: the viewer has nothing to open for a script whose
  // record is gone.
  const name = document.createElement('span');
  name.className = 'tombstone-name';
  appendWithSlashBreaks(name, nameCellText(script, inContainer));
  nameCell.appendChild(name);
  tr.appendChild(nameCell);

  // For column parity with the live table. A container collection can't
  // actually reach here — its scan is built from the scripts it holds,
  // so nothing in one ever reads as vanished — but a table whose rows
  // disagree about column count stops lining up.
  if (inContainer) {
    const schemeCell = document.createElement('td');
    schemeCell.className = 'scheme-cell';
    schemeCell.appendChild(makeSchemeChip(script.relativePath));
    tr.appendChild(schemeCell);
  }

  const sizeCell = document.createElement('td');
  sizeCell.className = 'size-cell';
  sizeCell.textContent = formatScriptSize(script);
  tr.appendChild(sizeCell);

  const statusCell = document.createElement('td');
  statusCell.className = 'status-cell';
  statusCell.title = TOMBSTONE_TITLE;
  // A real element, unlike the New / Updated chips, which are `::after`
  // on a cell that gets rebuilt from stored state. Nothing rebuilds this
  // cell (no `data-script-id`, so no repaint reaches it), and this chip
  // is the row's whole status — text a reader can select, copy, and hear
  // read out, not a decoration layered over a status word.
  const chip = document.createElement('span');
  chip.className = 'change-chip chip-removed';
  chip.textContent = 'Removed';
  statusCell.appendChild(chip);
  tr.appendChild(statusCell);

  if (withActions) tr.appendChild(document.createElement('td'));
  return tr;
}

const TOMBSTONE_TITLE =
  'This script is no longer in the collection, so the last refresh removed it '
  + 'along with its log and its stored values. This row is only a reminder: it '
  + 'goes away on the next refresh, or when you reload the page.';

// The rows a stored script stands behind, in DOM order. Every walk over
// the table goes through one of these two: `data-script-id` is what
// separates a real row from a tombstone, and a walk that forgets it
// ends up toggling, counting or reordering a row with no script.
function liveScriptRows(tbody: Element): HTMLTableRowElement[] {
  return [...tbody.querySelectorAll<HTMLTableRowElement>(':scope > tr[data-script-id]')];
}

function sectionScriptRows(section: HTMLElement): HTMLTableRowElement[] {
  return [...section.querySelectorAll<HTMLTableRowElement>('tbody tr[data-script-id]')];
}

function removeTombstones(root: ParentNode): void {
  for (const row of root.querySelectorAll('tr[data-tombstone]')) row.remove();
}

// Put each ghost back below the row it was recorded against.
//
// The live-row check is defensive: a dropped script's UUID goes with it,
// so a file that comes back comes back as a different row and can't
// collide. It costs one map lookup to be sure the table never shows the
// same id twice.
function placeTombstones(tbody: Element): void {
  const ghosts = [...tbody.querySelectorAll<HTMLTableRowElement>(':scope > tr[data-tombstone]')];
  if (ghosts.length === 0) return;
  const live = new Map(liveScriptRows(tbody).map((row) => [row.dataset.scriptId ?? '', row]));
  // Where the next ghost for a given anchor goes. Seeded with the
  // anchor row itself and advanced past each ghost placed against it,
  // so a run of scripts deleted together keeps the order they had.
  const cursors = new Map<string, Element>();
  for (const ghost of ghosts) {
    if (live.has(ghost.dataset.tombstone ?? '')) {
      ghost.remove();
      continue;
    }
    const anchorId = ghost.dataset.tombstoneAfter ?? '';
    const cursor = cursors.get(anchorId) ?? live.get(anchorId);
    // No cursor means either an empty anchor (the ghost led the table)
    // or an anchor that has itself left the table since — a script moved
    // to another collection, or removed by a click while the refresh ran.
    // Both go to the top, which is what an empty anchor asks for anyway.
    if (cursor) cursor.after(ghost);
    else tbody.insertBefore(ghost, tbody.firstChild);
    cursors.set(anchorId, ghost);
  }
}

// Turning a collection on turns off the other running copies of the
// scripts it starts; turning it off brings back the copies they
// displaced. Ctrl/Cmd-click (`solo`) flips only the collection. See
// docs/script-enablement.md.
async function onToggleCollection(
  id: string, enabled: boolean, label: HTMLLabelElement, solo: boolean,
): Promise<void> {
  setToggleBusy(label, true);
  try {
    const written = await setCollectionEnabledExclusive(id, enabled, solo);
    const section = findSection(id);
    if (section) applyCollectionEnabledToDom(section, enabled);
    applyEnableResult(written.scripts, [COLLECTION_PREFIX + id]);
  } finally {
    setToggleBusy(label, false);
  }
}

// An enable write that failed (in the worker, or reaching it): the
// boxes go back to what is stored. Logged, not thrown: a rejection the
// click handler drops would land in the extension's Errors panel.
function onEnableFailure(err: unknown): void {
  console.info('[SourceMonkey] could not change what is enabled:', describeError(err));
  void repaintPage();
}

// Turning a script on turns its other running copies off, unless
// Ctrl/Cmd-clicked (`solo`). Their rows change with this one's.
async function onToggleScript(
  id: string, enabled: boolean, label: HTMLLabelElement, solo: boolean,
): Promise<void> {
  setToggleBusy(label, true);
  try {
    const { changed } = await setScriptEnabledExclusive(id, enabled, solo);
    applyEnableResult(changed, [id]);
    const row = label.closest('tr') as HTMLTableRowElement | null;
    const section = label.closest('.collection') as HTMLElement | null;
    if (row && section) {
      const collectionOn = !section.classList.contains('disabled');
      row.classList.toggle('disabled', !collectionOn || !enabled);
      refreshBulkToggle(section);
    }
  } finally {
    setToggleBusy(label, false);
  }
}

// "Enable all" turns on one copy of each script in the collection (see
// `setAllScriptsEnabled`), and turns its other running copies off
// elsewhere unless Ctrl/Cmd-clicked (`solo`). "Disable all" turns every
// script off.
async function onBulkToggleScripts(collectionId: string, btn: HTMLButtonElement, solo: boolean): Promise<void> {
  const section = findSection(collectionId);
  if (!section) return;

  const checkboxes = Array.from(
    section.querySelectorAll<HTMLInputElement>('tbody .toggle input[type="checkbox"]'),
  );
  if (checkboxes.length === 0) return;
  const next = !allScriptsOn(section);

  const labels = checkboxes.map((cb) => cb.closest('.toggle') as HTMLLabelElement);
  setBulkBusy(btn, true);
  for (const lab of labels) setToggleBusy(lab, true);

  try {
    // One bulk write → one storage.onChanged event → one
    // syncRegistrations in the background SW. The old code wrote each
    // script's row individually, so a 15-script flip kicked off 15
    // full re-syncs of chrome.userScripts (each O(N)).
    const changed = await setAllScriptsEnabled(collectionId, next, solo);
    // Copies it turned off in other collections; this section's rows are
    // drawn from storage below.
    applyEnableResult(
      changed.filter((s) => s.collectionId !== collectionId),
      sectionScriptRows(section).map((row) => row.dataset.scriptId ?? ''),
    );

    // Reflect the stored state in every row: "Enable all" may leave a
    // second copy of a script off.
    const collectionOn = !section.classList.contains('disabled');
    const data = await getCollectionWithScriptMeta(collectionId);
    const on = new Map((data?.scripts ?? []).map((s) => [s.id, isScriptEnabled(s)]));
    for (const row of sectionScriptRows(section)) {
      const enabled = on.get(row.dataset.scriptId ?? '') ?? false;
      const cb = row.querySelector<HTMLInputElement>('.toggle input[type="checkbox"]');
      if (cb) cb.checked = enabled;
      row.classList.toggle('disabled', !collectionOn || !enabled);
    }
  } finally {
    for (const lab of labels) setToggleBusy(lab, false);
    setBulkBusy(btn, false);
    refreshBulkToggle(section);
  }
}

// Whether every script in the collection has a copy on: what flips the
// bulk toggle to "Disable all". Copies sharing `@namespace` + `@name`
// count as one script, since "Enable all" turns on only one of them.
function allOnByIdentity(rows: readonly { identity: string; on: boolean }[]): boolean {
  if (rows.length === 0) return false;
  const anyOn = new Map<string, boolean>();
  for (const r of rows) anyOn.set(r.identity, (anyOn.get(r.identity) ?? false) || r.on);
  return [...anyOn.values()].every(Boolean);
}

function allScriptsOn(section: HTMLElement): boolean {
  return allOnByIdentity(sectionScriptRows(section).flatMap((row) => {
    const cb = row.querySelector<HTMLInputElement>('.toggle input[type="checkbox"]');
    return cb ? [{ identity: row.dataset.identity ?? '', on: cb.checked }] : [];
  }));
}

// The identity a row is grouped by for `allOnByIdentity`: a script
// without `@name` stands alone.
function rowIdentity(script: ScriptMeta): string {
  return identityKey(script.header ?? null) ?? `id:${script.id}`;
}

// ---------- In-place DOM mutators ----------

function findSection(collectionId: string): HTMLElement | null {
  return collectionsEl.querySelector<HTMLElement>(
    `.collection[data-collection-id="${cssEscape(collectionId)}"]`,
  );
}

// Apply a collection enable/disable to its section without rebuilding it:
// flip the section's `.disabled` class and its own header toggle,
// retitle the per-script toggle labels, enable/disable each per-script
// checkbox, and update the bulk-toggle's disabled state. Per-script
// `enabled` values are preserved in storage, so the row classes
// recompute from each checkbox's current `checked`.
//
// A checkbox whose label carries a `.busy-spinner` belongs to a click
// this page is still awaiting, and is left alone: it shows the value the
// user just picked, and the handler's `finally` settles it. The label's
// styling and tooltip are updated anyway — they say what the COLLECTION is,
// not what the user clicked, and `setToggleBusy`'s restore reads
// `toggle-disabled` back to decide the checkbox's final disabled state.
// Skipping the label too would leave a checkbox enabled under a collection
// that was disabled while its spinner was up, with nothing left to
// repaint it.
function applyCollectionEnabledToDom(section: HTMLElement, enabled: boolean): void {
  section.classList.toggle('disabled', !enabled);

  // The collection's own toggle lives in the section header, outside
  // tbody. `onToggleCollection` arrives with it already flipped by the
  // click, but the watcher does not — without this a collection
  // disabled from another tab greys the whole section while its toggle
  // still reads "on".
  const collectionLabel = section.querySelector<HTMLLabelElement>('.collection-toggle');
  const collectionCb = collectionLabel?.querySelector<HTMLInputElement>('input[type="checkbox"]');
  if (collectionCb && !collectionLabel?.querySelector('.busy-spinner')) {
    collectionCb.checked = enabled;
  }

  for (const row of sectionScriptRows(section)) {
    const cb = row.querySelector<HTMLInputElement>('.toggle input[type="checkbox"]');
    const lab = row.querySelector<HTMLLabelElement>('.toggle');
    if (!cb || !lab) continue;
    lab.classList.toggle('toggle-disabled', !enabled);
    lab.title = enabled ? ENABLE_TITLE : COLLECTION_OFF_TITLE;
    if (!lab.querySelector('.busy-spinner')) cb.disabled = !enabled;
    row.classList.toggle('disabled', !enabled || !cb.checked);
  }

  refreshBulkToggle(section);
}

// Recompute the bulk-toggle's symbol/title/disabled state from the
// current per-row checkboxes plus the section's enabled state. Called
// after any toggle so the +/− stays in sync without a re-render.
function refreshBulkToggle(section: HTMLElement): void {
  const btn = section.querySelector<HTMLButtonElement>('.bulk-toggle');
  if (!btn) return;
  const collectionOn = !section.classList.contains('disabled');
  const allOn = allScriptsOn(section);
  btn.title = bulkTitle(collectionOn, allOn);
  // The glyph can be written even while busy — `.bulk-toggle.busy`
  // paints it transparent under the spinner, and it needs to be correct
  // for the moment the spinner clears.
  btn.textContent = allOn ? '−' : '+';
  // The disabled state must NOT be written while busy: setBulkBusy holds
  // the button disabled while its spinner is up. A bulk toggle writes
  // every row at once, and the echo of that write reaches this function
  // once per row — each call would otherwise re-enable the button
  // mid-operation.
  if (!btn.classList.contains('busy')) btn.disabled = !collectionOn;
}

function bulkTitle(collectionOn: boolean, allOn: boolean): string {
  if (!collectionOn) return COLLECTION_OFF_TITLE;
  return allOn
    ? 'Disable all scripts in this collection'
    : 'Enable all scripts in this collection (one copy of each)';
}

function removeEmptyPlaceholder(): void {
  collectionsEl.querySelector('.empty-placeholder')?.remove();
}

// ---------- Busy indicators ----------

// Append/remove a small spinner inside a toggle label and disable the
// underlying checkbox while async work is in flight. The checkbox keeps
// its just-clicked `checked` value so the user sees the intended state
// immediately.
//
// The CSS overlays the spinner on the checkbox rather than letting it
// sit in flow: the script table's toggle cell sizes to its content, so
// an in-flow spinner widened that column and shifted every row in the
// collection sideways until the write landed.
function setToggleBusy(label: HTMLLabelElement, busy: boolean): void {
  const cb = label.querySelector<HTMLInputElement>('input[type="checkbox"]');
  if (cb) cb.disabled = busy || label.classList.contains('toggle-disabled');
  let spinner = label.querySelector<HTMLElement>('.busy-spinner');
  if (busy) {
    if (!spinner) {
      spinner = document.createElement('span');
      spinner.className = 'busy-spinner';
      label.appendChild(spinner);
    }
  } else if (spinner) {
    spinner.remove();
  }
}

// Show a spinner over the bulk-toggle's +/− glyph while async work is
// in flight. `.bulk-toggle.busy` paints the glyph transparent and draws
// the ring on top, so the glyph stays in the button: emptying it moved
// the baseline of this inline-flex button, which resized the header row
// by a pixel and jiggled every collection below it for as long as the
// write ran.
//
// Clearing busy leaves the button ENABLED: callers must follow with
// `refreshBulkToggle`, synchronously, to settle it against the
// collection's own on/off state.
function setBulkBusy(btn: HTMLButtonElement, busy: boolean): void {
  btn.classList.toggle('busy', busy);
  btn.disabled = busy;
}

function setRefreshAllBusy(busy: boolean): void {
  setGlyphButtonBusy(refreshAllBtn, busy, {
    idle: 'Refresh all collections',
    busy: 'Refreshing all collections…',
  });
}

function setAddFormBusy(busy: boolean): void {
  addInput.disabled = busy;
  addButton.disabled = busy;
  let spinner = addForm.querySelector<HTMLElement>('.busy-spinner');
  if (busy) {
    if (!spinner) {
      spinner = document.createElement('span');
      spinner.className = 'busy-spinner';
      addForm.appendChild(spinner);
    }
  } else if (spinner) {
    spinner.remove();
  }
}

// ---------- Small UI helpers ----------

// A checkbox-sized button with a "−" (when everything's on, so the
// click disables) or "+" (otherwise — click enables). Distinct
// element type from the per-row checkbox toggle so it can carry its
// own affordance without confusing screen-readers about its state.
function makeBulkToggle(
  allOn: boolean,
  disabled: boolean,
  // `solo`: Ctrl/Cmd was held.
  onClick: (solo: boolean) => void,
  title: string,
): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'bulk-toggle';
  btn.disabled = disabled;
  btn.title = title;
  btn.textContent = allOn ? '−' : '+';
  btn.addEventListener('click', (ev) => { if (!btn.disabled) onClick(ev.ctrlKey || ev.metaKey); });
  return btn;
}

// A label-wrapped checkbox so the user has a generous click target.
// `disabled: true` greys it out without losing the underlying value.
// The change handler receives the new value AND the label, so flow
// handlers can attach a spinner to it while async work is in flight.
function makeToggle(
  checked: boolean,
  disabled: boolean,
  // `solo`: the click held Ctrl/Cmd (`watchSoloModifier`).
  onChange: (next: boolean, label: HTMLLabelElement, solo: boolean) => void,
  title: string,
): HTMLLabelElement {
  const label = document.createElement('label');
  label.className = 'toggle';
  if (disabled) label.classList.add('toggle-disabled');
  label.title = title;

  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = checked;
  cb.disabled = disabled;
  const takeSolo = watchSoloModifier(cb);
  cb.addEventListener('change', () => onChange(cb.checked, label, takeSolo()));
  label.appendChild(cb);
  return label;
}

// CSS.escape isn't on every old runtime; fall back to a minimal escape
// for the characters that show up in a UUID-shaped collectionId.
function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
  return value.replace(/["\\]/g, '\\$&');
}

// Put the storage banner in the slot, or take it out, to match the
// current refresh-error map.
//
// Replaces only its own element, leaving the file-access and
// user-scripts banners alone: those are probed on render (and the
// user-scripts one on returning to the tab), and re-running them on every
// repaint would mean an API call per structural storage write.
const STORAGE_BANNER_ID = 'storage-banner';

async function syncStorageBanner(liveIds: ReadonlySet<string>): Promise<void> {
  document.getElementById(STORAGE_BANNER_ID)?.remove();
  const banner = await buildStorageBanner(liveIds);
  if (!banner) return;
  banner.id = STORAGE_BANNER_ID;
  bannerSlot.appendChild(banner);
}

// The banner for "a refresh was read but couldn't be saved", or null
// when every collection saved fine.
//
// Gated on an actual failure rather than on the usage number alone. A
// profile sitting at 95% is working perfectly well, and a banner that
// appears before anything has gone wrong trains the reader to ignore
// it. Once a save HAS failed, the usage figure is what turns the report
// into something actionable, so it's fetched then and not before.
async function buildStorageBanner(liveIds: ReadonlySet<string>): Promise<HTMLElement | null> {
  // Counted against the collections actually on the page. A removal
  // racing a failing refresh of the same collection can leave an entry
  // behind (the prune runs before the failure is recorded), and a banner
  // pointing at a section that isn't there would be unexplainable.
  if (!Object.keys(currentRefreshErrors).some((id) => liveIds.has(id))) return null;

  const div = document.createElement('div');
  div.className = 'banner';

  const usage = await readLocalStorageUsage();
  const full = usage !== null && usage.used >= usage.quota * STORAGE_NEARLY_FULL;

  const heading = document.createElement('strong');
  // Never singular: on an exhausted quota every collection fails, which
  // is the case this banner exists for.
  heading.textContent = full
    ? 'SourceMonkey is out of storage space.'
    : 'Some collections could not be saved.';
  div.appendChild(heading);

  const explain = document.createElement('p');
  explain.textContent = full
    ? 'Collections below were read successfully, but Chrome refused to '
      + 'store them, so their scripts are still running the last version '
      + 'that fit. Removing a collection you no longer need (or trimming '
      + 'a very large one) frees the space to save them.'
    // The non-full branch is genuinely unexplained, so it says so
    // rather than guessing a cause the reader would then chase.
    : 'Collections below were read successfully, but Chrome refused to '
      + 'store them, so their scripts are still running the last version '
      + 'that saved. Storage is not full, so the reason is in the message '
      + 'on each collection.';
  div.appendChild(explain);

  if (usage) {
    const detail = document.createElement('p');
    detail.className = 'banner-detail';
    detail.textContent =
      `Using ${formatStorageUsage(usage.used, usage.quota)}`;
    div.appendChild(detail);
  }

  return div;
}

// Put the "Allow User Scripts" banner in the slot, or take it out, to
// match a fresh probe. Placed after the file-access banner and before the
// storage one, since a recheck can add it after both are drawn.
const USER_SCRIPTS_BANNER_ID = 'user-scripts-banner';

// The last probe's answer, null before the first.
let userScriptsUsable: boolean | null = null;

async function syncUserScriptsBanner(): Promise<void> {
  const state = await probeUserScriptsApi();
  const wasUsable = userScriptsUsable;
  userScriptsUsable = state.usable;
  const old = document.getElementById(USER_SCRIPTS_BANNER_ID);
  if (state.usable) {
    old?.remove();
    // Turned on while this page was open: nothing is registered yet,
    // and nothing else would tell the worker to register it.
    if (wasUsable === false) await syncAfterUserScriptsAllowed();
    return;
  }
  const banner = renderUserScriptsBanner(state.error);
  banner.id = USER_SCRIPTS_BANNER_ID;
  if (old) old.replaceWith(banner);
  else bannerSlot.insertBefore(banner, document.getElementById(STORAGE_BANNER_ID));
}

// Recheck when the person comes back, so the banner goes away once
// they've turned the toggle on in the extension settings, without a
// reload. Coming back to this tab fires `visibilitychange`; coming back
// to this window from another one fires only `focus`. Both run one
// recheck, since a return can fire both.
//
// Not before the first render is done: it draws the banners in order,
// and a recheck finishing in the middle would put this one first.
let recheckOnReturn: ReturnType<typeof setTimeout> | null = null;
function recheckUserScriptsWhenBack(): void {
  if (recheckOnReturn !== null) return;
  recheckOnReturn = setTimeout(() => {
    recheckOnReturn = null;
    initialRenderDone.then(syncUserScriptsBanner).catch((err) => {
      console.info('[SourceMonkey] user scripts recheck failed', describeError(err));
    });
  }, 50);
}
window.addEventListener('focus', recheckUserScriptsWhenBack);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') recheckUserScriptsWhenBack();
});

function renderUserScriptsBanner(error?: string): HTMLElement {
  const div = document.createElement('div');
  // Red: nothing runs until it's fixed. The popup's bar matches.
  div.className = 'banner banner-error';

  const heading = document.createElement('strong');
  heading.textContent = USER_SCRIPTS_OFF_HEADING;
  div.appendChild(heading);

  // The raw API error, so a failure other than the toggle being off
  // (a revoked permission, say) isn't masked by the toggle advice.
  if (error) {
    const detail = document.createElement('p');
    detail.className = 'banner-detail';
    detail.textContent = `Chrome reported: ${error}`;
    div.appendChild(detail);
  }

  const fix = userScriptsFixLine('p');
  div.appendChild(fix);

  return div;
}

function makeMessage(className: string, text: string): HTMLElement {
  const p = document.createElement('p');
  p.className = className;
  p.textContent = text;
  return p;
}
