// Collections page controller. Renders one section per registered
// collection (a local directory of userscripts, an http(s) directory or
// JSON manifest, a GitHub tree, or one of the three built-in containers
// that hold individually added scripts), with Refresh + Remove buttons
// and a script table showing name, size, and parse status.
//
// Add submits the raw string; the store classifies it by shape (path vs
// URL, suffix) and scans accordingly, loading every script it finds into
// chrome.storage immediately so the user doesn't need to click Refresh
// after add. A single `.user.js` input isn't a collection of its own —
// it lands in the built-in container matching its scheme.
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

import {
  addCollection,
  backfillCollectionDisplayNames,
  DEFAULT_COLLECTIONS,
  describeError,
  getAllScripts,
  getCollectionWithScripts,
  getCollections,
  isFirstRunComplete,
  isScriptEnabled,
  isCollectionEnabled,
  markFirstRunComplete,
  moveCollection,
  readLocalStorageUsage,
  removeScript,
  removeCollection,
  setScriptEnabled,
  setScriptsEnabled,
  setCollectionEnabled,
  setCollectionLocalFiles,
  collectionUsesLocalFiles,
  localFileScope,
  STORAGE_NEARLY_FULL,
  touchesStructuralRows,
  type StoredScript,
  type StoredCollection,
} from './script-store.js';
import {
  installLocalRootsListener,
  localRootsReady,
  localSearchRoots,
  type LocalFileScope,
  collectionSupportsLocalFiles,
} from './local-file-overrides.js';
import {
  appendWithSlashBreaks,
  COLLECTION_OFF_TITLE,
  effectiveDisplayName,
  makeCollectionTypeBubble,
  collectionAnchorId,
} from './collection-display.js';
import { getValue } from './userscript-header.js';
import { describeDiagnostic } from './diagnostic-location.js';
import { installDebugLoggingListener, loadDebugLoggingFlag } from './debug-log.js';
import {
  updateAllCollections,
  updateCollection,
} from './script-updater.js';
import {
  displayLocation,
  effectiveScriptStatus,
  ENABLE_TITLE,
  formatBytes,
  formatScriptSize,
  formatScriptStatusLabel,
  logIdDupeSuffix,
  scriptBasename,
  scriptDisplayName,
  scriptOutdatedProbe,
  viewerUrl,
} from './script-display.js';
import { probeLabel, type VersionProbe } from './version-probe.js';
import { computeLogIds } from './script-log-id.js';
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
import { iconRefFromHeader, renderSiteIconInto } from './site-icon.js';
import {
  canonicalCollectionInput,
  containerKindForSingleFileInput,
  containerPath,
  isContainerCollection,
  isHttpUrl,
  isFileUrl,
  LOCATION_SHAPES,
  isSingleFileInput,
  normalizeCollectionInput,
} from './directories.js';
import {
  installGithubAuthListener,
  loadGithubAuthToken,
} from './github-auth.js';
import {
  extensionDetailsLink,
  isFileSchemeAccessAllowed,
  renderFileAccessBanner,
} from './file-access.js';
import { installPageParseChecker } from './parse-check-client.js';

// Add / Refresh / Refresh All run the load pipeline here in the page,
// so this page needs its own parse checker — without one, a
// page-driven refresh would clear an `invalid` verdict it never
// re-derived. See src/parse-check-client.ts.
installPageParseChecker();

// The page needs its own copy of the cached GitHub token — the SW's
// cached value isn't reachable from here, and the page still decides
// whether a URL is GitHub-authed (for the log-line suffix) and still
// fetches locally when the read can't be handed to the worker. Listen
// synchronously; bootstrap() awaits the initial load before any
// refresh can fire so a `?refresh` query-param can't race against
// hydration and run unauthenticated.
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
  void onAddCollection(addInput.value);
});

refreshAllBtn.addEventListener('click', () => void onRefreshAll());

openOptionsBtn.addEventListener('click', () => {
  location.href = 'options.html';
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
// The change event is treated as a bare "something you display moved"
// signal — what it says changed is ignored. The repaint re-reads storage
// and makes the DOM match, which is idempotent by construction: no
// snapshot to go stale, no per-key handler to keep in step with the
// store, and any number of events collapse into one pass.
if (chrome.storage?.local?.onChanged) {
  chrome.storage.local.onChanged.addListener((changes) => {
    if (touchesStructuralRows(Object.keys(changes))) void repaintPage();
  });
}

// Page-wide map of {scriptId → log ID}, refreshed whenever scripts are
// added / removed / refreshed. Renders the `#N` dupe suffix in the
// name cell. Empty until `refreshLogIds()` runs.
let currentLogIds = new Map<string, string>();

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
// mirroring the session-storage map in src/refresh-error.ts. Drives both
// the per-section message and the storage banner; empty on a healthy
// profile. Seeded in `render()` and kept fresh by the
// `chrome.storage.session.onChanged` listener above.
let currentRefreshErrors: RefreshErrorMap = {};

async function refreshLogIds(): Promise<void> {
  const all = await getAllScripts();
  currentLogIds = computeLogIds(all);
  applyLogIdSuffixesToDom();
}


// Mirror of `applyLogIdSuffixesToDom` for the Status column. After a
// storage.session change for one or more `loglevel:` rows, walk every
// rendered script row and rewrite its status cell content + class to
// reflect the latest effective status. Pulls the StoredScript.status
// off the row's data-script-status attribute so we don't have to refetch.
function applyStatusCellsToDom(): void {
  for (const row of document.querySelectorAll<HTMLTableRowElement>(
    '.script-table tr[data-script-id]',
  )) {
    const id = row.dataset.scriptId;
    const storedStatus = row.dataset.scriptStatus as StoredScript['status'] | undefined;
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
  script: StoredScript,
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
  storedStatus: StoredScript['status'],
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
  storedStatus: StoredScript['status'],
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
  // Trash-can affordance only on persisted-missing rows (the file
  // genuinely vanished from its listing). A row that's merely flagged
  // ERROR/WARNING via the log still has a backing file and shouldn't
  // get the destructive button.
  if (storedStatus === 'missing') {
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'remove-script';
    removeBtn.textContent = '🗑';
    removeBtn.title = 'Remove this script record';
    removeBtn.setAttribute('aria-label', 'Remove this script record');
    // Defer the row → collectionId lookup until click time.
    // paintStatusCell may be called before the cell is appended to its
    // parent row (the initial render path builds the cell first and
    // only inserts it afterwards), so a synchronous `closest('tr')`
    // here would read null and the dispatcher would be left with no
    // collectionId.
    removeBtn.addEventListener('click', () => {
      const row = removeBtn.closest<HTMLTableRowElement>('tr[data-script-id]');
      const collectionId = row?.dataset.collectionId ?? '';
      void onRemoveScript(scriptId, collectionId, removeBtn);
    });
    cell.appendChild(removeBtn);
  }
}

function applyLogIdSuffixesToDom(): void {
  // The point of this walk is the sections we DIDN'T just re-render:
  // after `onRefreshCollection` rebuilds a single section, sibling
  // sections still display their pre-refresh suffixes. The just-
  // rendered section's rows are already correct (renderScriptRow read
  // the same currentLogIds), so writing the same string over them is
  // a harmless no-op rather than the primary purpose.
  for (const row of document.querySelectorAll<HTMLTableRowElement>(
    '.script-table tr[data-script-id]',
  )) {
    const id = row.dataset.scriptId;
    if (!id) continue;
    const span = row.querySelector<HTMLSpanElement>('.log-id-suffix');
    if (!span) continue;
    span.textContent = logIdDupeSuffix(currentLogIds.get(id) ?? '');
  }
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
function repaintPage(): Promise<void> {
  pageDirty = true;
  repaintChain = repaintChain
    .then(async () => {
      // Waited before the flag is read, not after, so everything that
      // arrives during the initial render collapses into ONE repaint
      // rather than one per event.
      await initialRenderDone;
      if (!pageDirty) return;
      pageDirty = false;
      await repaintFromStorage();
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
// and re-seat them into index order. Existing elements are reused so
// refresh highlights, in-flight spinners, and focus survive.
async function repaintFromStorage(): Promise<void> {
  const collections = await getCollections();
  // Ahead of the sections, so a page that just failed to save shows the
  // explanation at the top by the time the reader's eye follows the
  // section messages down. Needs the collection list, hence after the
  // read rather than first.
  await syncStorageBanner(new Set(collections.map((s) => s.id)));
  // Read each collection's scripts ONCE, up front, and paint from that.
  // The obvious shape — `refreshLogIds()` then render each section —
  // reads the whole store twice per pass: `getAllScripts` is a
  // `storage.local.get(null)`, which drags back every script body, every
  // prefetched `@require`, and the base64 favicon cache, and then each
  // section re-reads its own scripts. A repaint runs on any structural
  // write from anywhere, so that has to stay proportionate.
  const scriptsByCollection = new Map<string, StoredScript[]>();
  for (const collection of collections) {
    scriptsByCollection.set(collection.id, (await getCollectionWithScripts(collection.id))?.scripts ?? []);
  }
  const allScripts = [...scriptsByCollection.values()].flat();

  // Dedup `#N` suffixes shift across the whole page when any script is
  // added or removed, so recompute before anything draws.
  currentLogIds = computeLogIds(allScripts);
  applyLogIdSuffixesToDom();
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
}

// Update one already-rendered section from its stored collection row.
// The section element itself is never replaced — that would take the
// Refresh button's busy state and every row's spinner with it.
async function syncSectionFromStorage(
  section: HTMLElement,
  collection: StoredCollection,
  scripts: readonly StoredScript[],
): Promise<void> {
  const collectionOn = isCollectionEnabled(collection);
  applyCollectionEnabledToDom(section, collectionOn);

  // The type bubble is derived from `collection.path`, which is the
  // collection's identity and never rewritten, so only the display name
  // can move.
  const nameEl = section.querySelector<HTMLElement>('.collection-display-name');
  const displayName = effectiveDisplayName(collection);
  if (nameEl && nameEl.textContent !== displayName) {
    nameEl.textContent = '';
    appendWithSlashBreaks(nameEl, displayName);
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
  const p = makeMessage('error', text);
  p.dataset.messageKind = kind;
  return p;
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
    `:scope > p.error[data-message-kind="${kind}"]`,
  );
  if (!text) {
    prior?.remove();
    return;
  }
  if (prior) {
    prior.textContent = text;
    return;
  }
  // Insert after whichever earlier line is present, so the kinds keep a
  // stable order however they arrive — a section that gains its scan
  // line second must not end up showing it below the refresh line.
  let anchor: Element | null = section.querySelector('.collection-header');
  for (const earlier of SECTION_MESSAGE_KINDS) {
    if (earlier === kind) break;
    anchor = section.querySelector<HTMLElement>(
      `:scope > p.error[data-message-kind="${earlier}"]`,
    ) ?? anchor;
  }
  anchor?.after(makeSectionMessage(kind, text));
}

// Update the section's script list in place: reuse the `<tr>` for a
// script that is still there, build one for a script that appeared, drop
// the rows whose scripts are gone, and re-seat into stored order.
async function syncScriptRowsFromStorage(
  section: HTMLElement,
  collection: StoredCollection,
  collectionOn: boolean,
  scripts: readonly StoredScript[],
): Promise<void> {
  const inContainer = isContainerCollection(collection.path);
  const localFiles = localFileScope(collection);
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
  for (const row of tbody.querySelectorAll<HTMLTableRowElement>('tr[data-script-id]')) {
    if (row.dataset.scriptId) existing.set(row.dataset.scriptId, row);
  }
  const ordered: HTMLTableRowElement[] = [];
  for (const script of scripts) {
    const row = existing.get(script.id);
    if (row) {
      syncScriptRow(row, script, collectionOn, inContainer, localFiles);
      existing.delete(script.id);
    }
    ordered.push(row ?? renderScriptRow(script, collectionOn, inContainer, localFiles));
  }
  // Whatever is left in `existing` is a row whose script is gone. The
  // per-script bookkeeping is pruned by the caller, against the whole
  // stored set.
  for (const row of existing.values()) row.remove();
  if (!sameNodeOrder(tbody, ordered)) {
    for (const row of ordered) tbody.appendChild(row);
  }
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
  script: StoredScript,
  collectionOn: boolean,
  inContainer: boolean,
  localFiles: LocalFileScope,
): void {
  const { errorMessage } = applyScriptRowDatasets(row, script);

  // Like the Name cell below, the Status cell is only rebuilt when
  // what it shows moved. `paintStatusCell` discards and recreates the
  // `<a>` (and the 🗑 on a missing row), so repainting it
  // unconditionally would drop focus off it — and a repaint runs on any
  // structural write anywhere, including a background refresh of an
  // unrelated collection.
  const cell = row.querySelector<HTMLTableCellElement>('td.status-cell');
  const wanted = statusCellKey(script.id, script.status, errorMessage, script.refreshError);
  if (cell && statusCellKeys.get(script.id) !== wanted) {
    paintStatusCell(cell, script.id, script.status, errorMessage, script.refreshError);
  }

  const sizeCell = row.querySelector<HTMLTableCellElement>('td.size-cell');
  const size = formatScriptSize(script);
  if (sizeCell && sizeCell.textContent !== size) sizeCell.textContent = size;

  // The Name cell is only rebuilt when something it shows actually
  // moved. Rebuilding unconditionally would re-run the favicon fetch and
  // flash the globe placeholder on every unrelated repaint.
  const nameCell = row.querySelector<HTMLTableCellElement>('td.name-cell');
  if (nameCell && nameCellKeys.get(script.id) !== nameCellKey(script, localFiles)) {
    fillNameCell(nameCell, script, inContainer, localFiles);
  }

  const scriptOn = isScriptEnabled(script);
  const label = row.querySelector<HTMLLabelElement>('.toggle');
  const cb = label?.querySelector<HTMLInputElement>('input[type="checkbox"]');
  // Skip the checkbox while THIS row's toggle is mid-flight (a
  // `.busy-spinner` sibling means an onToggleScript on this page holds
  // it disabled with its intended value shown). The echo of that very
  // write must not re-enable it under the spinner; the handler's
  // `finally` restores the final state. Everything else (status, size)
  // still updates.
  const busy = !!label?.querySelector('.busy-spinner');
  if (cb && !busy) {
    cb.checked = scriptOn;
    cb.disabled = !collectionOn;
  }
  // Mirror applyCollectionEnabledToDom's label upkeep, spinner or not:
  // this is the parent collection's state, not the user's click, and
  // the restore in setToggleBusy reads `toggle-disabled` back to settle
  // the checkbox.
  if (label) {
    label.classList.toggle('toggle-disabled', !collectionOn);
    label.title = collectionOn ? ENABLE_TITLE : COLLECTION_OFF_TITLE;
  }
  row.classList.toggle('disabled', !collectionOn || !scriptOn);
}

// Are `wanted` already the container's element children, in that order?
function sameNodeOrder(container: Element, wanted: readonly Element[]): boolean {
  const current = [...container.children];
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

function nameCellKey(script: StoredScript, localFiles: LocalFileScope): string {
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
  ]);
}

// Drop the per-script bookkeeping for everything that is no longer
// stored. These maps are keyed by script id and would otherwise grow for
// the life of the page.
function forgetScriptsExcept(keep: ReadonlySet<string>): void {
  for (const id of [...nameCellKeys.keys()]) {
    if (!keep.has(id)) nameCellKeys.delete(id);
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
// `?add=<path-or-url>` does the equivalent of typing the value
// into the Add field and clicking Add. Validates the input;
// shows an error if it doesn't look like an absolute path or URL.
// On success or duplicate, jumps to the resulting collection section.
// Lets the docs/redirect-page.md deep link route here from anywhere
// on the web (see docs/deep-link.md).
async function bootstrap(): Promise<void> {
  // Ensure the GitHub auth token is hydrated before any refresh fires.
  // Otherwise a `?refresh` query-param can race the chrome.storage.local
  // read and the first refresh-on-load runs unauthenticated.
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
}

// First-run seeding, driven from the page so the user watches the
// familiar flow: each default collection's section appears, populated,
// as it loads. Reuses the manual Add handler (`onAddCollection`), so
// there's no separate code path that can drift. `addCollection` fetches
// each collection's scripts as part of the add, so no follow-up Refresh
// is needed. Marks first-run complete at the end (even if a collection
// failed) so it never repeats.
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
        await onAddCollection(path, { jump: false, preview: false });
      } catch (err) {
        console.info('[SourceMonkey] first-run add failed', path, err);
      }
    }
  } finally {
    // Clear the Add field — onAddCollection clears it on success, but a
    // failed add leaves the last attempted path sitting there.
    addInput.value = '';
    console.log('[SourceMonkey] first run: seeding complete; marking firstRunComplete=true');
    await markFirstRunComplete();
  }
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

// Drive the Add flow from a `?add=` query param. Pre-
// fills the form field (so the user sees what was attempted) and
// runs the same flow as the manual Add button. The URL is scrubbed
// once the location was accepted — success, duplicate, or a storage
// failure that still created the row — because in all three the
// collection now exists and re-running the param would only re-report a
// duplicate. Only a value the validator REJECTED is left in place, so
// the user can copy/share/edit it.
async function handleAddParam(raw: string): Promise<void> {
  addInput.value = raw;
  const ok = await onAddCollection(raw);
  if (ok) scrubQueryParams(['add']);
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

  // One-shot backfill so older collection rows (pre-displayName) pick
  // up an inferred label on first view after upgrade. Cheap no-op once
  // every row carries a name.
  await backfillCollectionDisplayNames();

  // Surface the file:// access state up-front. Without the toggle on
  // chrome://extensions, every fetch we try will fail.
  if (!(await isFileSchemeAccessAllowed())) {
    bannerSlot.appendChild(renderFileAccessBanner());
  }

  // The User Scripts API requires the user to flip the "Allow User
  // Scripts" toggle (Chrome ≥138) or enable developer mode (120–137)
  // on chrome://extensions. Until they do, every registration call
  // throws — meaning no scripts actually inject even though the badge
  // still counts matches. Other failures (revoked permission, etc.)
  // surface their raw message so the user has something to grep for.
  const userScriptsState = await probeUserScriptsApi();
  if (!userScriptsState.usable) {
    bannerSlot.appendChild(renderUserScriptsBanner(userScriptsState.error));
  }

  const collections = await getCollections();

  // Last of the three banners, because it is the most situational: it
  // appears only once a refresh has actually failed to save, where the
  // other two describe a setting that is wrong right now. Unlike them it
  // can also come and go WITHOUT a reload — a failed refresh raises it,
  // the next successful one clears it — so it owns a sync of its own
  // that the repaint calls too.
  await syncStorageBanner(new Set(collections.map((s) => s.id)));

  await refreshLogIds();
  if (collections.length === 0) {
    collectionsEl.appendChild(emptyPlaceholder());
    return;
  }
  for (const collection of collections) {
    collectionsEl.appendChild(await renderCollectionSection(collection));
  }
  refreshMoveButtons();
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
    (next, label) => void onToggleCollection(collection.id, next, label),
    'Enable scripts under this collection',
  );
  enableLabel.classList.add('collection-toggle');
  header.appendChild(enableLabel);

  const heading = document.createElement('h2');
  heading.appendChild(makeCollectionTypeBubble(collection.path));
  const nameEl = document.createElement('span');
  nameEl.className = 'collection-display-name';
  appendWithSlashBreaks(nameEl, effectiveDisplayName(collection));
  // Tooltip surfaces the raw stored path so the user can still see the
  // canonical URL / fs path behind a shortened display name. Container
  // collections have a synthetic identifier as their path, which would
  // leak `container:file` etc. — skip the tooltip in that case.
  if (!isContainerCollection(collection.path)) nameEl.title = collection.path;
  heading.appendChild(nameEl);
  header.appendChild(heading);

  const buttons = document.createElement('div');
  buttons.className = 'collection-buttons';

  // Only where it can do something: every script under an http(s)
  // collection loads over the network, so the control would be inert
  // there.
  if (collectionSupportsLocalFiles(collection.path)) {
    buttons.appendChild(makeLocalFilesToggle(collection));
  }

  buttons.appendChild(makeMoveButton('up', collection.id));
  buttons.appendChild(makeMoveButton('down', collection.id));

  const refreshBtn = document.createElement('button');
  refreshBtn.textContent = 'Refresh';
  refreshBtn.addEventListener('click', () => void onRefreshCollection(collection.id, refreshBtn));
  buttons.appendChild(refreshBtn);

  const removeBtn = document.createElement('button');
  removeBtn.textContent = 'Remove';
  removeBtn.addEventListener('click', () => void onRemoveCollection(collection.id, section, removeBtn));
  buttons.appendChild(removeBtn);

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
  const data = await getCollectionWithScripts(collection.id);
  const scripts = data?.scripts ?? [];
  const inContainer = isContainerCollection(collection.path);
  const localFiles = localFileScope(collection);

  if (scripts.length === 0) {
    return makeMessage(
      'empty',
      inContainer
        ? 'No scripts here yet — add one above.'
        : 'No *.user.js files found.',
    );
  }

  const allOn = scripts.every(isScriptEnabled);

  const table = document.createElement('table');
  table.className = 'script-table';

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');

  const bulkHead = document.createElement('th');
  bulkHead.className = 'toggle-cell';
  const bulkBtn = makeBulkToggle(
    allOn,
    !collectionOn,
    () => void onBulkToggleScripts(collection.id, bulkBtn),
    bulkTitle(collectionOn, allOn),
  );
  bulkHead.appendChild(bulkBtn);
  headRow.appendChild(bulkHead);

  for (const label of ['Name', 'Size', 'Status']) {
    const th = document.createElement('th');
    th.textContent = label;
    headRow.appendChild(th);
  }
  if (inContainer) {
    // Trailing column carries the per-row remove button. Empty text
    // would announce as "blank column header"; an aria-label tells
    // screen-readers what it's for.
    const actionsTh = document.createElement('th');
    actionsTh.setAttribute('aria-label', 'Actions');
    headRow.appendChild(actionsTh);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const script of scripts) {
    tbody.appendChild(renderScriptRow(script, collectionOn, inContainer, localFiles));
  }
  table.appendChild(tbody);
  return table;
}

function renderScriptRow(
  script: StoredScript,
  collectionOn: boolean,
  inContainer: boolean,
  localFiles: LocalFileScope,
): HTMLTableRowElement {
  const scriptOn = isScriptEnabled(script);

  const tr = document.createElement('tr');
  tr.dataset.scriptId = script.id;
  tr.dataset.collectionId = script.collectionId;
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
    (next, label) => void onToggleScript(script.id, next, label),
    collectionOn ? ENABLE_TITLE : COLLECTION_OFF_TITLE,
  ));
  tr.appendChild(toggleCell);

  const nameCell = document.createElement('td');
  nameCell.classList.add('name-cell');
  fillNameCell(nameCell, script, inContainer, localFiles);
  tr.appendChild(nameCell);

  const sizeCell = document.createElement('td');
  sizeCell.className = 'size-cell';
  sizeCell.textContent = formatScriptSize(script);
  tr.appendChild(sizeCell);

  const statusCell = document.createElement('td');
  paintStatusCell(statusCell, script.id, script.status, errorMessage, script.refreshError);
  tr.appendChild(statusCell);

  // Container rows always offer a remove button (every script inside a
  // container was added one-by-one and can be taken back out the same
  // way). Non-container rows rely on paintStatusCell's trash affordance
  // for `missing` rows only.
  if (inContainer) {
    const actionCell = document.createElement('td');
    actionCell.className = 'action-cell';
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'remove-script';
    removeBtn.textContent = '🗑';
    removeBtn.title = 'Remove this script';
    removeBtn.setAttribute('aria-label', 'Remove this script');
    removeBtn.addEventListener('click', () => {
      void onRemoveScript(script.id, script.collectionId, removeBtn);
    });
    actionCell.appendChild(removeBtn);
    tr.appendChild(actionCell);
  }

  return tr;
}

// Build (or rebuild) the Name cell's contents: favicon slot, the
// linked name, and the dedup `#N` suffix. Shared with the live in-place
// row update, which re-runs it when a refresh changed something this
// cell shows — otherwise a script whose `@match` or `@description` was
// edited keeps the old site's favicon and the old hover text until the
// section happens to be rebuilt for an unrelated reason.
function fillNameCell(
  nameCell: HTMLTableCellElement,
  script: StoredScript,
  inContainer: boolean,
  // Where this script's collection allows local file overrides to come
  // from. Threaded alongside `inContainer` — both are per-collection
  // facts the row needs and neither is worth re-loading the collection
  // row for.
  localFiles: LocalFileScope,
): void {
  nameCell.textContent = '';
  // Slot for the favicon: a fixed-width container so the name
  // text always starts at the same x-position. renderSiteIconInto
  // synchronously paints a globe placeholder (clickable when the
  // script's @match yields a usable origin) and swaps it for the real
  // favicon once the fetch resolves.
  const iconSlot = document.createElement('span');
  iconSlot.className = 'site-icon';
  nameCell.appendChild(iconSlot);
  renderSiteIconInto(iconSlot, script, localSearchRoots(script.fileUrl, localFiles));
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
  nameCell.appendChild(a);
  // Dupe-suffix span, populated from currentLogIds. Empty for unique
  // basenames so the column stays clean; non-empty (e.g. " #2") only
  // when another script shares this basename.
  const suffix = document.createElement('span');
  suffix.className = 'log-id-suffix';
  suffix.textContent = logIdDupeSuffix(currentLogIds.get(script.id) ?? '');
  nameCell.appendChild(suffix);
  // Record what this cell was drawn from, so the next repaint can skip
  // it unless one of those inputs moved.
  nameCellKeys.set(script.id, nameCellKey(script, localFiles));
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
function nameCellText(script: StoredScript, inContainer: boolean): string {
  const location = inContainer
    ? scriptBasename(script.relativePath)
    : displayLocation(script.relativePath);
  return scriptDisplayName(script, location);
}

// Tooltip on the name link: the whole location first — the column no
// longer shows it, and it's what tells two same-named scripts apart —
// then a blank line, then the parsed `@description`, or "No description"
// when the script declares none.
function nameCellTooltip(script: StoredScript): string {
  const desc = script.header ? getValue(script.header, 'description') : undefined;
  return `${displayLocation(script.relativePath)}\n\n${desc?.trim() || 'No description'}`;
}

async function onRemoveScript(scriptId: string, _collectionId: string, btn: HTMLButtonElement): Promise<void> {
  btn.disabled = true;
  try {
    await removeScript(scriptId);
    // Write, then repaint — the same shape as the other flow handlers.
    // Hand-rolling the row removal here also meant hand-rolling the
    // "collection is now empty" message, which said "No *.user.js files
    // found." even on a container collection, whose empty state is
    // "No scripts here yet". Only container rows have this
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

// Returns true if the input was accepted by the validator and the
// add flow ran (whether the collection was newly created or already
// existed). Returns false if validation rejected the input. Used by
// `handleAddParam` to decide whether to scrub the `add`
// query param — invalid input keeps the URL so the user can edit
// and retry.
async function onAddCollection(
  rawPath: string,
  opts: { jump?: boolean; preview?: boolean } = {},
): Promise<boolean> {
  // `jump` controls the post-add smooth-scroll. On by default for the
  // manual Add button + `?add` (the user wants to land on the new
  // section); off for first-run seeding, which adds several in a row and
  // would otherwise scroll-dance through them.
  //
  // `preview` routes a single-script input to the viewer's preview mode
  // instead of adding it outright. Off for first-run seeding, which
  // must not navigate away mid-loop.
  const { jump = true, preview = true } = opts;
  const path = rawPath.trim();
  if (!path) return false;

  if (!isValidCollectionInput(path)) {
    showAddError(`A location ${LOCATION_SHAPES}`);
    return false;
  }
  showAddError(null);

  // One script → preview it first. The viewer shows its metadata,
  // what it asks permission to do, and its source text, then installs on
  // confirmation (or offers Update when we already have this URL).
  // Directory / manifest / github-dir collections still add directly:
  // previewing a whole listing needs a different UI (see TODO.md).
  if (preview && isSingleFileInput(path)) {
    location.href = `userscript.html?preview=${encodeURIComponent(path)}`;
    return true;
  }

  setAddFormBusy(true);
  try {
    // Normalize once up front so we don't burn a second GitHub API
    // call on the duplicate-jump lookup below — and so any failure
    // (rate limit, private repo, network down) surfaces here with a
    // user-visible message instead of dead-ending in the page console.
    // `addCollection` re-normalizes internally, but the second call is
    // a no-op on already-canonical inputs (idempotent for non-github
    // and for already-resolved github `/tree/<ref>/...` URLs).
    let stored;
    try {
      // Both canonicalizations `addCollection` will run, so the
      // duplicate lookup below compares the same spelling the store
      // holds.
      stored = canonicalCollectionInput(await normalizeCollectionInput(path));
    } catch (err) {
      showAddError(err instanceof Error ? err.message : String(err));
      return false;
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
    //
    // Returns `true` for the same reason: a row WAS created, so this is
    // a partial success rather than the rejected-input case below, and
    // `handleAddParam` should scrub `?add=` exactly as it would for a
    // duplicate.
    let result;
    try {
      result = await addCollection(stored);
    } catch (err) {
      showAddError(describeError(err));
      await repaintPage();
      return true;
    }
    addInput.value = '';
    if (!result) {
      // Duplicate: either the collection path is already registered, or
      // (for a single-file input) the matching container already
      // contains this URL/path. Surface the message and jump to
      // whichever section owns it.
      const collections = await getCollections();
      const existing = findDuplicateOwner(stored, collections)
        ?? collections.find((s) => s.path === stored);
      if (existing) {
        // Name the collection rather than the internal "container"
        // kind: it is the heading the jump below scrolls to, so the
        // message and the destination read as the same thing.
        showAddError(
          isContainerCollection(existing.path)
            ? `This script is already in ${effectiveDisplayName(existing)}`
            : 'This collection is already registered',
        );
        if (jump) jumpToCollection(existing.id);
      }
      return true;
    }
    // The add wrote storage; a repaint builds the new section (or, for
    // an existing container, folds the new row into the section already
    // on screen) and puts everything in index order.
    await repaintPage();
    if (jump) jumpToCollection(result.collection.id);
    return true;
  } finally {
    setAddFormBusy(false);
  }
}

// For a duplicate add, find the section that already owns this
// input. Single-file inputs route into a container, so the duplicate
// is owned by the container of the matching kind; everything else
// matches by stored collection path. Returns the collection row (or
// undefined when nothing matches — caller surfaces no jump).
function findDuplicateOwner(
  normalizedInput: string,
  collections: readonly StoredCollection[],
): StoredCollection | undefined {
  if (isSingleFileInput(normalizedInput)) {
    const kind = containerKindForSingleFileInput(normalizedInput);
    return collections.find((s) => s.path === containerPath(kind));
  }
  return collections.find((s) => s.path === normalizedInput);
}

// Accept three forms: an http(s):// URL, a file:// URL, or an
// absolute POSIX path of length > 1. Everything else (relative
// paths, bare names, other schemes, bare `/`) is rejected so the
// user gets a clear message instead of a downstream scan failure or
// a scan of the filesystem root.
function isValidCollectionInput(value: string): boolean {
  if (isHttpUrl(value) || isFileUrl(value)) return true;
  return value.startsWith('/') && value.length > 1;
}

// Show or clear the Add error line below the form. Pass null
// to hide it; pass a string to surface a validation failure.
function showAddError(message: string | null): void {
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
  btn.className = `move-collection move-${direction}`;
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
  const data = await getCollectionWithScripts(id);
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
    // The repaint drops the section and, if that was the last collection,
    // puts the empty placeholder back.
    await repaintPage();
  } catch (err) {
    section.classList.remove('removing');
    btn.disabled = false;
    throw err;
  }
}

async function onRefreshCollection(id: string, btn: HTMLButtonElement): Promise<void> {
  const prevText = btn.textContent ?? 'Refresh';
  btn.disabled = true;
  btn.textContent = 'Refreshing…';
  try {
    // Snapshot the prior scripts so we can highlight rows that
    // actually changed after the refresh lands.
    const before = await getCollectionWithScripts(id);
    const priorScripts = before?.scripts ?? [];
    // Goes through script-updater so a background opportunistic check
    // already in flight for this collection coalesces with our click
    // instead of doing redundant work.
    await updateCollection(id, 'manual');
    // Refresh may have added/removed scripts, flipped statuses, etc.
    // The repaint brings this section's rows in line with what was just
    // written; then the rows that actually changed get their highlight.
    // Rows are updated in place, so the highlight goes onto the same
    // `<tr>` the user was already looking at.
    await repaintPage();
    const section = findSection(id);
    const after = await getCollectionWithScripts(id);
    if (section) applyChangeHighlights(section, priorScripts, after?.scripts ?? []);
  } catch (err) {
    // A refresh that couldn't be saved already recorded its reason in
    // session storage, so the repaint is what puts it on screen. Caught
    // rather than rethrown because there is nothing above this to
    // handle it: the click handler's `void` would drop it silently and
    // the user would watch the button finish with no explanation.
    console.info('[SourceMonkey] collection refresh failed', err);
    await repaintPage();
  } finally {
    btn.disabled = false;
    btn.textContent = prevText;
  }
}

// Refresh every registered directory in parallel, then re-render each
// section in place and flash any rows that changed. Triggered by the
// header "Refresh All" button and by ?refresh in the URL.
async function onRefreshAll(): Promise<void> {
  setRefreshAllBusy(true);
  try {
    // Snapshot each collection's prior scripts before kicking off the
    // refresh so we can compute "what changed" per row.
    const collections = await getCollections();
    const priorsByCollection = new Map<string, StoredScript[]>();
    await Promise.all(collections.map(async (s) => {
      const before = await getCollectionWithScripts(s.id);
      priorsByCollection.set(s.id, before?.scripts ?? []);
    }));

    await updateAllCollections('manual');

    // One repaint brings the whole page in line with what was written;
    // then each section's changed rows get their highlight.
    await repaintPage();
    for (const s of collections) {
      const section = findSection(s.id);
      if (!section) continue;
      const after = await getCollectionWithScripts(s.id);
      applyChangeHighlights(section, priorsByCollection.get(s.id) ?? [], after?.scripts ?? []);
    }
  } catch (err) {
    // `refreshAllCollections` records each collection's failure and
    // keeps going, so reaching here means something outside that loop
    // broke. Repaint anyway: whatever DID save should show, and any
    // recorded per-collection reason goes up with it.
    console.info('[SourceMonkey] refresh all failed', err);
    await repaintPage();
  } finally {
    setRefreshAllBusy(false);
  }
}

// Decide per script whether it changed in a refresh and tag the
// corresponding row with the matching highlight class. The color
// persists on the row until the next refresh, which clears the prior
// colors before applying its own — rows are reused across a repaint, so
// nothing else drops them.
//
// Classification:
//   - newly-added         → row-updated (green)  if ok; else row-failed (red)
//   - went missing        → row-failed
//   - re-read AND now ok  → row-updated
//   - re-read AND errored → row-failed
//   - status changed but no re-read (rare) → color by next.status
//   - refresh just failed (refreshError newly set / changed, while the
//     cached body keeps running) → row-failed, even though status stays
//     `ok` and loadedAt is unchanged
//   - refresh recovered (refreshError cleared) → row-updated, even when
//     the body is unchanged (304 / size+mtime skip preserve loadedAt)
//   - otherwise           → no flash (unchanged path: cheap-skip
//                            optimization, OR genuine no-op)
function applyChangeHighlights(
  section: HTMLElement,
  prior: StoredScript[],
  next: StoredScript[],
): void {
  // Clear the last refresh's colors first. Rows survive a refresh now
  // (they're updated in place, not rebuilt), so without this a row that
  // changed once would stay highlighted through every later refresh.
  for (const row of section.querySelectorAll<HTMLTableRowElement>('tr[data-script-id]')) {
    row.classList.remove('row-updated', 'row-failed');
  }
  const priorById = new Map(prior.map((s) => [s.id, s]));
  for (const n of next) {
    const cls = classifyChange(priorById.get(n.id), n);
    if (!cls) continue;
    const row = section.querySelector<HTMLTableRowElement>(
      `tr[data-script-id="${cssEscape(n.id)}"]`,
    );
    if (row) row.classList.add(cls);
  }
}

function classifyChange(
  prior: StoredScript | undefined,
  next: StoredScript,
): 'row-updated' | 'row-failed' | null {
  if (!prior) {
    return next.status === 'ok' ? 'row-updated' : 'row-failed';
  }
  if (next.status === 'missing' && prior.status !== 'missing') return 'row-failed';
  if (next.status === 'missing') return null;             // was already missing
  // A fresh refresh failure (the cached body keeps running, so status
  // stays `ok` and loadedAt doesn't move) still deserves a red flash so
  // the user notices the collection went stale.
  if (next.refreshError && next.refreshError !== prior.refreshError) return 'row-failed';
  // Recovery: a row that WAS refresh-failed and now isn't gets a green
  // flash even when the body is unchanged (HTTP 304 / size+mtime skip,
  // which preserve loadedAt) — otherwise the row would silently drop its
  // red highlight with no "it came back" confirmation.
  if (prior.refreshError && !next.refreshError) return 'row-updated';
  const reread = next.loadedAt !== prior.loadedAt;
  const statusChanged = next.status !== prior.status;
  if (!reread && !statusChanged) return null;
  return next.status === 'ok' ? 'row-updated' : 'row-failed';
}

async function onToggleCollection(id: string, enabled: boolean, label: HTMLLabelElement): Promise<void> {
  setToggleBusy(label, true);
  try {
    await setCollectionEnabled(id, enabled);
    const section = findSection(id);
    if (section) applyCollectionEnabledToDom(section, enabled);
  } finally {
    setToggleBusy(label, false);
  }
}

// The per-collection "Local files" switch: may a script in this
// collection load a `@require` / `@resource` from a file on disk next
// to it, instead of the URL the declaration names? See
// docs/local-file-overrides.md.
//
// A labeled checkbox rather than the bare `makeToggle` switch used for
// enable/disable: this one sits among named buttons, and an unlabeled
// second switch in the header would read as a second enable control.
//
// Default-on, and only meaningful for local collections — which is why
// the off position is the one worth reaching for: a directory of
// scripts you didn't write is exactly where a file sitting next to one
// should NOT quietly stand in for the library it names.
function makeLocalFilesToggle(collection: StoredCollection): HTMLLabelElement {
  const label = document.createElement('label');
  label.className = 'local-files-toggle';
  label.title =
    'Load @require / @resource files from the script\'s own folder, this ' +
    'collection\'s own directory, or the search roots configured in Options, ' +
    'when a file there matches the end of the declared URL. Any file under ' +
    'those directories can be read by a script in this collection';

  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = collectionUsesLocalFiles(collection);
  cb.addEventListener('change', () => void onToggleLocalFiles(collection.id, cb));
  label.append(cb, document.createTextNode('Local files'));
  return label;
}

// Writing the flag only changes what the NEXT refresh resolves to, so
// the refresh is part of the click — otherwise the switch would appear
// to do nothing until something else happened to touch the collection.
async function onToggleLocalFiles(id: string, cb: HTMLInputElement): Promise<void> {
  cb.disabled = true;
  try {
    await setCollectionLocalFiles(id, cb.checked);
    await updateCollection(id, 'manual');
    await repaintPage();
  } finally {
    cb.disabled = false;
  }
}

async function onToggleScript(id: string, enabled: boolean, label: HTMLLabelElement): Promise<void> {
  setToggleBusy(label, true);
  try {
    await setScriptEnabled(id, enabled);
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

async function onBulkToggleScripts(collectionId: string, btn: HTMLButtonElement): Promise<void> {
  const section = findSection(collectionId);
  if (!section) return;

  const checkboxes = Array.from(
    section.querySelectorAll<HTMLInputElement>('tbody .toggle input[type="checkbox"]'),
  );
  if (checkboxes.length === 0) return;
  const allOn = checkboxes.every((cb) => cb.checked);
  const next = !allOn;

  const labels = checkboxes.map((cb) => cb.closest('.toggle') as HTMLLabelElement);
  setBulkBusy(btn, true);
  for (const lab of labels) setToggleBusy(lab, true);

  try {
    // One bulk write → one storage.onChanged event → one
    // syncRegistrations in the background SW. The old code wrote each
    // script's row individually, so a 15-script flip kicked off 15
    // full re-syncs of chrome.userScripts (each O(N)).
    const collectionOn = !section.classList.contains('disabled');
    const data = await getCollectionWithScripts(collectionId);
    const scripts = data?.scripts ?? [];
    const toFlip = scripts
      .filter((s) => isScriptEnabled(s) !== next)
      .map((s) => ({ id: s.id, enabled: next }));
    await setScriptsEnabled(toFlip);

    // Reflect the new state in every row.
    for (const cb of checkboxes) cb.checked = next;
    for (const row of section.querySelectorAll<HTMLTableRowElement>('tbody tr')) {
      row.classList.toggle('disabled', !collectionOn || !next);
    }
  } finally {
    for (const lab of labels) setToggleBusy(lab, false);
    setBulkBusy(btn, false);
    refreshBulkToggle(section);
  }
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

  for (const row of section.querySelectorAll<HTMLTableRowElement>('tbody tr')) {
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
  const checkboxes = Array.from(
    section.querySelectorAll<HTMLInputElement>('tbody .toggle input[type="checkbox"]'),
  );
  const allOn = checkboxes.length > 0 && checkboxes.every((cb) => cb.checked);
  btn.title = bulkTitle(collectionOn, allOn);
  // While busy the symbol is replaced by a spinner and the button is
  // held disabled by setBulkBusy; don't overwrite either. A bulk toggle
  // writes every row at once, and the echo of that write reaches this
  // function once per row — each call would otherwise re-enable the
  // button under its own spinner, mid-operation.
  if (!btn.classList.contains('busy')) {
    btn.disabled = !collectionOn;
    btn.textContent = allOn ? '−' : '+';
  } else {
    btn.dataset.idleText = allOn ? '−' : '+';
  }
}

function bulkTitle(collectionOn: boolean, allOn: boolean): string {
  if (!collectionOn) return COLLECTION_OFF_TITLE;
  return allOn
    ? 'Disable all scripts in this collection'
    : 'Enable all scripts in this collection';
}

function removeEmptyPlaceholder(): void {
  collectionsEl.querySelector('.empty-placeholder')?.remove();
}

// ---------- Busy indicators ----------

// Append/remove a small inline spinner inside a toggle label and
// disable the underlying checkbox while async work is in flight. The
// checkbox keeps its just-clicked `checked` value so the user sees
// the intended state immediately.
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

// Replace the bulk-toggle's +/− glyph with a spinner while async work
// is in flight. We stash the idle text on the button so
// `refreshBulkToggle` can restore the correct symbol afterwards.
function setBulkBusy(btn: HTMLButtonElement, busy: boolean): void {
  if (busy) {
    btn.dataset.idleText = btn.textContent ?? '';
    btn.textContent = '';
    btn.classList.add('busy');
    btn.disabled = true;
  } else {
    btn.classList.remove('busy');
    btn.textContent = btn.dataset.idleText ?? '';
    delete btn.dataset.idleText;
    btn.disabled = false;
  }
}

function setRefreshAllBusy(busy: boolean): void {
  refreshAllBtn.disabled = busy;
  refreshAllBtn.textContent = busy ? 'Refreshing…' : 'Refresh All';
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
  onClick: () => void,
  title: string,
): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'bulk-toggle';
  btn.disabled = disabled;
  btn.title = title;
  btn.textContent = allOn ? '−' : '+';
  btn.addEventListener('click', () => { if (!btn.disabled) onClick(); });
  return btn;
}

// A label-wrapped checkbox so the user has a generous click target.
// `disabled: true` greys it out without losing the underlying value.
// The change handler receives the new value AND the label, so flow
// handlers can attach a spinner to it while async work is in flight.
function makeToggle(
  checked: boolean,
  disabled: boolean,
  onChange: (next: boolean, label: HTMLLabelElement) => void,
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
  cb.addEventListener('change', () => onChange(cb.checked, label));
  label.appendChild(cb);
  return label;
}

// CSS.escape isn't on every old runtime; fall back to a minimal escape
// for the characters that show up in a UUID-shaped collectionId.
function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
  return value.replace(/["\\]/g, '\\$&');
}

// Probe whether chrome.userScripts is callable. Presence of the
// namespace only confirms the permission is in the manifest; the user
// still has to flip the per-extension toggle before any call works.
// Returns the raw error message so the banner can surface anything
// that isn't the routine "toggle is off" case.
async function probeUserScriptsApi(): Promise<{ usable: true } | { usable: false; error?: string }> {
  // Deliberately NOT recased to a message of ours. This value shares a
  // slot with Chrome's verbatim `err.message` below and renders as
  // `Chrome reported: <it>`, so it is written to read as Chrome's own
  // report rather than as SourceMonkey's sentence — the API-flavoured
  // wording is the point. See docs/diagnostics.md#wording.
  if (!chrome.userScripts) return { usable: false, error: 'chrome.userScripts is not available' };
  try {
    await chrome.userScripts.getScripts();
    return { usable: true };
  } catch (err) {
    return { usable: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// Put the storage banner in the slot, or take it out, to match the
// current refresh-error map.
//
// Replaces only its own element, leaving the file-access and
// user-scripts banners alone: those two are probed once per render and
// re-running them on every repaint would mean an API call per structural
// storage write.
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
      + 'that fit. Removing a collection you no longer need — or trimming '
      + 'a very large one — frees the space to save them.'
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
      `Using ${formatBytes(usage.used)} of ${formatBytes(usage.quota)}`;
    div.appendChild(detail);
  }

  return div;
}


function renderUserScriptsBanner(error?: string): HTMLElement {
  const div = document.createElement('div');
  div.className = 'banner';

  const heading = document.createElement('strong');
  heading.textContent = 'User scripts are not allowed yet.';
  div.appendChild(heading);

  const explain = document.createElement('p');
  explain.textContent =
    'SourceMonkey can find matching scripts (the toolbar badge counts ' +
    'them), but Chrome won\'t actually inject anything until you turn ' +
    'on "Allow User Scripts" for this extension. Open its details ' +
    'page, enable the toggle, then reload this page:';
  div.appendChild(explain);

  div.appendChild(extensionDetailsLink());

  // Include the raw API error so non-routine failures (e.g. quota,
  // revoked permission, malformed pattern bubbling up at getScripts
  // time) aren't masked by the generic "toggle is off" copy.
  if (error) {
    const detail = document.createElement('p');
    detail.className = 'banner-detail';
    detail.textContent = `Chrome reported: ${error}`;
    div.appendChild(detail);
  }

  return div;
}

function makeMessage(className: string, text: string): HTMLElement {
  const p = document.createElement('p');
  p.className = className;
  p.textContent = text;
  return p;
}
