// Sources page controller. Renders one section per registered source
// (a local directory of userscripts, a single `.user.js` file, an
// http(s) `.user.js` URL, or a JSON manifest — locally as a path or
// file:// URL, or remotely over http(s)), with Refresh + Remove
// buttons and a script table showing filename, size, and parse
// status.
//
// "Add source" submits the raw string; the store classifies it by
// shape (path vs URL, suffix) and scans accordingly, loading every
// script it finds into chrome.storage immediately so the user doesn't
// need to click Refresh after add. The CSS hooks (`.directory*`) and
// the `directories` container id predate http sources — they're just
// stable selector names now, not a claim that every section is a dir.
//
// State changes (toggle, add, remove, refresh) update the DOM in
// place: only the affected section/row mutates, and the control that
// triggered the change shows a small spinner while its async work is
// in flight. The initial `render()` runs once at load to draw banners
// and seed every section.

import {
  addSource,
  backfillSourceDisplayNames,
  DEFAULT_SOURCES,
  getAllScripts,
  getSource,
  getSourceWithScripts,
  getSources,
  isFirstRunComplete,
  isScriptEnabled,
  isSourceEnabled,
  markFirstRunComplete,
  moveSource,
  removeScript,
  removeSource,
  setScriptEnabled,
  setScriptsEnabled,
  setSourceEnabled,
  type StoredScript,
  type StoredSource,
} from './script-store.js';
import {
  appendWithSlashBreaks,
  effectiveDisplayName,
  makeSourceTypeBubble,
  sourceAnchorId,
} from './source-display.js';
import { getValue } from './userscript-header.js';
import {
  updateAllSources,
  updateSource,
} from './script-updater.js';
import {
  displayLocation,
  effectiveScriptStatus,
  formatScriptSize,
  formatScriptStatusLabel,
  logIdDupeSuffix,
  scriptBasename,
  scriptOutdatedProbe,
} from './script-display.js';
import { probeLabel, type VersionProbe } from './version-probe.js';
import { computeLogIds } from './script-log-id.js';
import {
  LOG_LEVEL_KEY_PREFIX,
  getAllMaxLogLevels,
  type LogLevel,
} from './script-log.js';
import { renderSiteIconInto } from './site-icon.js';
import {
  canonicalSourceInput,
  containerKindForSingleFileInput,
  containerPath,
  isContainerSource,
  isHttpUrl,
  isFileUrl,
  isSingleFileInput,
  normalizeSourceInput,
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

// Refresh-from-sources-page paths run fetchHttpText in the page
// context, so the page needs its own copy of the cached GitHub token
// — the SW's cached value isn't reachable from here. Listen
// synchronously; bootstrap() awaits the initial load before any
// refresh can fire so a `?refresh` query-param can't race against
// hydration and run unauthenticated.
installGithubAuthListener();
const githubTokenReady = loadGithubAuthToken();

const bannerSlot = document.getElementById('banner-slot')!;
const directoriesEl = document.getElementById('directories')!;
const addForm = document.getElementById('add-form') as HTMLFormElement;
const addInput = document.getElementById('add-path') as HTMLInputElement;
const addButton = addForm.querySelector('button[type="submit"]') as HTMLButtonElement;
const refreshAllBtn = document.getElementById('refresh-all') as HTMLButtonElement;
const openOptionsBtn = document.getElementById('open-options') as HTMLButtonElement;
const addErrorEl = document.getElementById('add-error') as HTMLParagraphElement;

addForm.addEventListener('submit', (event) => {
  event.preventDefault();
  void onAddDirectory(addInput.value);
});

refreshAllBtn.addEventListener('click', () => void onRefreshAll());

openOptionsBtn.addEventListener('click', () => {
  location.href = 'options.html';
});

void bootstrap();

// Repaint Status cells when the per-script max-log-level row changes
// on the SW side (a fresh error / warning was appended, or the log
// was cleared). Filtering on the `loglevel:` prefix keeps unrelated
// session-storage writes from kicking off pointless DOM walks.
if (chrome.storage?.session?.onChanged) {
  chrome.storage.session.onChanged.addListener((changes) => {
    let touched = false;
    for (const key of Object.keys(changes)) {
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

// Page-wide map of {scriptId → log ID}, refreshed whenever scripts are
// added / removed / refreshed. Renders the `#N` dupe suffix in the
// filename cell. Empty until `refreshLogIds()` runs.
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
  cell.textContent = '';
  cell.className = 'status-cell';
  const level = currentLogLevels.get(scriptId);
  const outdated = currentOutdated.get(scriptId);
  const effective = effectiveScriptStatus(
    { status: storedStatus, refreshError }, level, outdated !== undefined,
  );
  cell.classList.add(`status-${effective}`);
  // Anchor that takes the user straight to the script viewer's Log
  // tab — the same destination regardless of effective status, since
  // even OK rows may have informative entries.
  const link = document.createElement('a');
  link.href = viewerUrl(scriptId, 'log').toString();
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = formatScriptStatusLabel(effective);
  // Hover text follows whatever the cell is actually showing: the
  // refresh-failure reason, the newer version we found upstream, or
  // otherwise the load errorMessage.
  const title = effective === 'refresh-failed'
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
    // Defer the row → sourceId lookup until click time. paintStatusCell
    // may be called before the cell is appended to its parent row (the
    // initial render path builds the cell first and only inserts it
    // afterwards), so a synchronous `closest('tr')` here would read
    // null and the dispatcher would be left with no sourceId.
    removeBtn.addEventListener('click', () => {
      const row = removeBtn.closest<HTMLTableRowElement>('tr[data-script-id]');
      const sourceId = row?.dataset.sourceId ?? '';
      void onRemoveScript(scriptId, sourceId, removeBtn);
    });
    cell.appendChild(removeBtn);
  }
}

function applyLogIdSuffixesToDom(): void {
  // The point of this walk is the sections we DIDN'T just re-render:
  // after `onRefreshDirectory` rebuilds a single section, sibling
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

// `?refresh` in the URL triggers a refresh-all as soon as the initial
// render is done. Lets external tools poke the extension via
//   google-chrome chrome-extension://<id>/sources.html?refresh
// after they've written new userscripts.
//
// `?add_source=<path-or-url>` does the equivalent of typing the value
// into the Add Source field and clicking Add. Validates the input;
// shows an error if it doesn't look like an absolute path or URL.
// On success or duplicate, jumps to the resulting source section.
// Lets the docs/redirect-page.md deep link route here from anywhere
// on the web (see docs/deep-link.md).
async function bootstrap(): Promise<void> {
  // Ensure the GitHub auth token is hydrated before any refresh fires.
  // Otherwise a `?refresh` query-param can race the chrome.storage.local
  // read and the first refresh-on-load runs unauthenticated.
  await githubTokenReady;
  await render();
  // Re-trigger any `#source-<id>` hash scroll after the async render.
  // The browser's initial jump fires immediately on page load, before
  // our render() finishes building the sections, so it finds no
  // matching element and gives up. Look at the hash again now that
  // every section is in the DOM and scroll the matching one into
  // view. Triggered for any hash matching the source-anchor shape.
  scrollToHashSourceIfPresent();
  const params = new URLSearchParams(location.search);
  // First-run seeding. The SW opens this page with `?first_run` once on
  // install (see background.ts); only that auto-opened page seeds, so an
  // ordinary visit never adds the defaults. The flag is re-checked here
  // so a manual reload of the same URL can't seed twice.
  if (params.has('first_run')) {
    const done = await isFirstRunComplete();
    console.log(`[SourceMonkey] sources page opened with ?first_run (firstRunComplete=${done})`);
    if (!done) await seedDefaultSourcesViaUi();
    else console.log('[SourceMonkey] first run already complete; skipping seed');
    scrubQueryParams(['first_run']);
  }
  if (params.has('refresh')) {
    await onRefreshAll();
    scrubQueryParams(['refresh']);
  }
  const addSourceArg = params.get('add_source');
  if (addSourceArg !== null) {
    await handleAddSourceParam(addSourceArg);
  }
}

// First-run seeding, driven from the page so the user watches the
// familiar flow: each default source's section appears, populated, as it
// loads. Reuses the manual Add handler (`onAddDirectory`), so there's no
// separate code path that can drift. `addSource` fetches each source's
// scripts as part of the add, so no follow-up Refresh is needed. Marks
// first-run complete at the end (even if a source failed) so it never
// repeats.
async function seedDefaultSourcesViaUi(): Promise<void> {
  // Best-effort + run-once: mark complete in a finally so a failure on
  // one default (network down, bad URL) neither aborts the others nor
  // leaves the flag unset (which can't auto-retry — onInstalled fires
  // only once, so a re-open wouldn't carry ?first_run). A failed source
  // still leaves a section with its Refresh button for manual recovery.
  console.log('[SourceMonkey] first run: seeding default sources', [...DEFAULT_SOURCES]);
  try {
    // Skip exact-repeat entries up front; addSource also dedupes by
    // canonical source path (so two spellings of the same source still
    // yield one), this just avoids a pointless duplicate-add round-trip
    // for a byte-identical repeat. `jump: false` so adding several in a
    // row doesn't scroll-dance through each new section.
    const seen = new Set<string>();
    for (const raw of DEFAULT_SOURCES) {
      const path = raw.trim();
      if (!path || seen.has(path)) continue;
      seen.add(path);
      console.log('[SourceMonkey] first run: adding source', path);
      addInput.value = path;
      try {
        await onAddDirectory(path, { jump: false, preview: false });
      } catch (err) {
        console.info('[SourceMonkey] first-run add failed', path, err);
      }
    }
  } finally {
    // Clear the Add field — onAddDirectory clears it on success, but a
    // failed add leaves the last attempted path sitting there.
    addInput.value = '';
    console.log('[SourceMonkey] first run: seeding complete; marking firstRunComplete=true');
    await markFirstRunComplete();
  }
}

// If the URL hash points at a rendered source section, scroll it into
// view. No-op otherwise; safe to call any time after render().
function scrollToHashSourceIfPresent(): void {
  if (!location.hash.startsWith('#source-')) return;
  const id = location.hash.slice(1);
  const section = document.getElementById(id);
  if (!section) return;
  section.scrollIntoView({ block: 'start' });
}

// Drive the Add Source flow from a `?add_source=` query param. Pre-
// fills the form field (so the user sees what was attempted) and
// runs the same flow as the manual Add button. The URL is scrubbed
// only on success/duplicate; an invalid value is left in place so
// the user can copy/share/edit it.
async function handleAddSourceParam(raw: string): Promise<void> {
  addInput.value = raw;
  const ok = await onAddDirectory(raw);
  if (ok) scrubQueryParams(['add_source']);
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
  directoriesEl.textContent = '';

  // One-shot backfill so older source rows (pre-displayName) pick up
  // an inferred label on first view after upgrade. Cheap no-op once
  // every row carries a name.
  await backfillSourceDisplayNames();

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

  const sources = await getSources();
  if (sources.length === 0) {
    directoriesEl.appendChild(emptyPlaceholder());
    return;
  }

  await refreshLogIds();
  // Pre-populate log levels so the very first paint of each row's
  // Status cell already reflects WARNING / ERROR, rather than briefly
  // showing OK and then flipping when the async listener fires.
  currentLogLevels = await getAllMaxLogLevels();
  for (const source of sources) {
    directoriesEl.appendChild(await renderSourceSection(source));
  }
  refreshMoveButtons();
}

function emptyPlaceholder(): HTMLElement {
  const p = document.createElement('p');
  p.className = 'placeholder empty-placeholder';
  p.textContent = 'No sources yet. Add one above.';
  return p;
}

// ---------- Per-section build ----------

async function renderSourceSection(source: StoredSource): Promise<HTMLElement> {
  const sourceOn = isSourceEnabled(source);

  const section = document.createElement('section');
  section.className = 'directory';
  section.dataset.sourceId = source.id;
  // Stable per-source anchor; lets deep links (and the post-add
  // `jumpToSource` helper) scroll directly to this section.
  section.id = sourceAnchorId(source.id);
  if (!sourceOn) section.classList.add('disabled');

  const header = document.createElement('div');
  header.className = 'directory-header';

  // Per-source enable toggle sits left of the path so it visually
  // groups with the directory it controls and aligns with the
  // per-script toggle column below.
  const enableLabel = makeToggle(
    sourceOn,
    false,
    (next, label) => void onToggleSource(source.id, next, label),
    'Enable scripts under this source',
  );
  enableLabel.classList.add('directory-toggle');
  header.appendChild(enableLabel);

  const heading = document.createElement('h2');
  heading.appendChild(makeSourceTypeBubble(source.path));
  const nameEl = document.createElement('span');
  nameEl.className = 'source-display-name';
  appendWithSlashBreaks(nameEl, effectiveDisplayName(source));
  // Tooltip surfaces the raw stored path so the user can still see the
  // canonical URL / fs path behind a shortened display name. Container
  // sources have a synthetic identifier as their path, which would
  // leak `container:file` etc. — skip the tooltip in that case.
  if (!isContainerSource(source.path)) nameEl.title = source.path;
  heading.appendChild(nameEl);
  header.appendChild(heading);

  const buttons = document.createElement('div');
  buttons.className = 'directory-buttons';

  buttons.appendChild(makeMoveButton('up', source.id));
  buttons.appendChild(makeMoveButton('down', source.id));

  const refreshBtn = document.createElement('button');
  refreshBtn.textContent = 'Refresh';
  refreshBtn.addEventListener('click', () => void onRefreshDirectory(source.id, refreshBtn));
  buttons.appendChild(refreshBtn);

  const removeBtn = document.createElement('button');
  removeBtn.textContent = 'Remove';
  removeBtn.addEventListener('click', () => void onRemoveDirectory(source.id, section, removeBtn));
  buttons.appendChild(removeBtn);

  header.appendChild(buttons);
  section.appendChild(header);

  if (source.scanError) {
    section.appendChild(makeMessage('error', `Scan failed: ${source.scanError}`));
  }
  section.appendChild(await renderScriptTable(source, sourceOn));
  return section;
}

async function renderScriptTable(source: StoredSource, sourceOn: boolean): Promise<HTMLElement> {
  const data = await getSourceWithScripts(source.id);
  const scripts = data?.scripts ?? [];
  const inContainer = isContainerSource(source.path);

  if (scripts.length === 0) {
    return makeMessage(
      'empty',
      inContainer
        ? 'No scripts in this container yet — add one above.'
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
    !sourceOn,
    () => void onBulkToggleScripts(source.id, bulkBtn),
    bulkTitle(sourceOn, allOn),
  );
  bulkHead.appendChild(bulkBtn);
  headRow.appendChild(bulkHead);

  for (const label of ['Filename', 'Size', 'Status']) {
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
  for (const script of scripts) tbody.appendChild(renderScriptRow(script, sourceOn, inContainer));
  table.appendChild(tbody);
  return table;
}

function renderScriptRow(
  script: StoredScript,
  sourceOn: boolean,
  inContainer: boolean,
): HTMLTableRowElement {
  const scriptOn = isScriptEnabled(script);

  const tr = document.createElement('tr');
  tr.dataset.scriptId = script.id;
  // Stash the persisted status + sourceId + errorMessage on the row so
  // `applyStatusCellsToDom` can repaint the Status cell after a
  // chrome.storage.session change without re-querying the store.
  tr.dataset.scriptStatus = script.status;
  tr.dataset.sourceId = script.sourceId;
  if (inContainer) tr.dataset.inContainer = '1';
  if (script.errorMessage) tr.dataset.scriptError = script.errorMessage;
  if (script.refreshError) tr.dataset.scriptRefreshError = script.refreshError;
  // The outdated verdict needs the parsed header and the stored probes,
  // neither of which survives as a dataset attribute — record it here
  // so the repaint path can look it up by id.
  const outdated = scriptOutdatedProbe(script);
  if (outdated) currentOutdated.set(script.id, outdated);
  else currentOutdated.delete(script.id);
  if (!sourceOn || !scriptOn) tr.classList.add('disabled');

  const toggleCell = document.createElement('td');
  toggleCell.className = 'toggle-cell';
  toggleCell.appendChild(makeToggle(
    scriptOn,
    !sourceOn,    // disabled (greyed out) when the parent source is off
    (next, label) => void onToggleScript(script.id, next, label),
    sourceOn ? 'Enable this script' : 'Source is disabled',
  ));
  tr.appendChild(toggleCell);

  const nameCell = document.createElement('td');
  nameCell.classList.add('name-cell');
  // Slot for the favicon: a fixed-width container so the filename
  // text always starts at the same x-position. renderSiteIconInto
  // synchronously paints a globe placeholder (clickable when the
  // script's @match yields a usable origin) and swaps it for the real
  // favicon once the fetch resolves.
  const iconSlot = document.createElement('span');
  iconSlot.className = 'site-icon';
  nameCell.appendChild(iconSlot);
  renderSiteIconInto(iconSlot, script);
  const a = document.createElement('a');
  // For container scripts the `relativePath` is the full URL/path —
  // show just the basename in the filename column to keep rows
  // scannable. The viewer's Location row carries the URL in full.
  // A manifest entry may itself be an absolute URL, so the non-
  // container branch goes through displayLocation too — otherwise the
  // same script reads encoded here and decoded in the viewer. Local
  // directory entries have no scheme and pass through untouched.
  const nameText = inContainer
    ? scriptBasename(script.relativePath)
    : displayLocation(script.relativePath);
  // Slash-aware appender (not textContent) so a long name wraps at `/`
  // boundaries before breaking mid-segment, matching the source heading
  // and the viewer's Location row.
  appendWithSlashBreaks(a, nameText);
  // Hovering the filename surfaces the `@description`. Scoped to the
  // anchor so the Size / Status cells (which carry their own meaning)
  // don't inherit the description as a row-wide tooltip.
  a.title = scriptDescription(script);
  a.href = viewerUrl(script.id).toString();
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
  tr.appendChild(nameCell);

  const sizeCell = document.createElement('td');
  sizeCell.className = 'size-cell';
  sizeCell.textContent = formatScriptSize(script);
  tr.appendChild(sizeCell);

  const statusCell = document.createElement('td');
  paintStatusCell(statusCell, script.id, script.status, script.errorMessage, script.refreshError);
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
      void onRemoveScript(script.id, script.sourceId, removeBtn);
    });
    actionCell.appendChild(removeBtn);
    tr.appendChild(actionCell);
  }

  return tr;
}

// Tooltip text for a script row: the parsed `@description` value, or
// "No description" when the script declares none (or hasn't parsed
// far enough to have a header at all).
function scriptDescription(script: StoredScript): string {
  const desc = script.header ? getValue(script.header, 'description') : undefined;
  return desc?.trim() || 'No description';
}

async function onRemoveScript(scriptId: string, sourceId: string, btn: HTMLButtonElement): Promise<void> {
  btn.disabled = true;
  try {
    await removeScript(scriptId);
    // Remove just this row in place. A full-section re-render would
    // briefly blank out every other row and is the kind of flicker
    // users read as "everything disappeared". The other rows are
    // unaffected by removing one script, so there's nothing to redraw.
    const row = directoriesEl.querySelector<HTMLTableRowElement>(
      `section.directory[data-source-id="${cssEscape(sourceId)}"] tr[data-script-id="${cssEscape(scriptId)}"]`,
    );
    row?.remove();
    // If this was the last script under the source, swap the table
    // for the standard "No *.user.js files found." placeholder so the
    // section doesn't show a dangling empty table.
    const section = directoriesEl.querySelector<HTMLElement>(
      `section.directory[data-source-id="${cssEscape(sourceId)}"]`,
    );
    const table = section?.querySelector<HTMLTableElement>('.script-table');
    if (table && table.querySelectorAll('tbody tr').length === 0) {
      table.replaceWith(makeMessage('empty', 'No *.user.js files found.'));
    }
    await refreshLogIds();
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
// add flow ran (whether the source was newly created or already
// existed). Returns false if validation rejected the input. Used by
// `handleAddSourceParam` to decide whether to scrub the `add_source`
// query param — invalid input keeps the URL so the user can edit
// and retry.
async function onAddDirectory(
  rawPath: string,
  opts: { jump?: boolean; preview?: boolean } = {},
): Promise<boolean> {
  // `jump` controls the post-add smooth-scroll. On by default for the
  // manual Add button + `?add_source` (the user wants to land on the new
  // section); off for first-run seeding, which adds several in a row and
  // would otherwise scroll-dance through them.
  //
  // `preview` routes a single-script input to the viewer's preview mode
  // instead of adding it outright. Off for first-run seeding, which
  // must not navigate away mid-loop.
  const { jump = true, preview = true } = opts;
  const path = rawPath.trim();
  if (!path) return false;

  if (!isValidSourceInput(path)) {
    showAddError(
      'Sources must be an absolute path (starting with /) or an http(s):// / file:// URL.',
    );
    return false;
  }
  showAddError(null);

  // One script → preview it first. The viewer shows its metadata,
  // what it asks permission to do, and its source, then installs on
  // confirmation (or offers Update when we already have this URL).
  // Directory / manifest / github-dir sources still add directly:
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
    // `addSource` re-normalizes internally, but the second call is
    // a no-op on already-canonical inputs (idempotent for non-github
    // and for already-resolved github `/tree/<ref>/...` URLs).
    let stored;
    try {
      // Both canonicalizations `addSource` will run, so the duplicate
      // lookup below compares the same spelling the store holds.
      stored = canonicalSourceInput(await normalizeSourceInput(path));
    } catch (err) {
      showAddError(err instanceof Error ? err.message : String(err));
      return false;
    }
    const result = await addSource(stored);
    addInput.value = '';
    if (!result) {
      // Duplicate: either the source path is already registered, or
      // (for a single-file input) the matching container already
      // contains this URL/path. Surface the message and jump to
      // whichever section owns it.
      const sources = await getSources();
      const existing = findDuplicateOwner(stored, sources)
        ?? sources.find((s) => s.path === stored);
      if (existing) {
        showAddError(
          isContainerSource(existing.path)
            ? 'This script is already in its container.'
            : 'This source is already registered.',
        );
        if (jump) jumpToSource(existing.id);
      }
      return true;
    }
    // refreshSource ran inside addSource; re-read the source row so
    // the render sees post-refresh scriptIds in sync with storage.
    const latest = (await getSource(result.source.id)) ?? result.source;
    await refreshLogIds();
    if (result.kind === 'existingContainer') {
      // Add into an existing container — re-render that section in
      // place to surface the new row without disturbing siblings.
      const section = findSection(latest.id);
      const fresh = await renderSourceSection(latest);
      if (section) section.replaceWith(fresh);
      else directoriesEl.appendChild(fresh);
    } else {
      removeEmptyPlaceholder();
      directoriesEl.appendChild(await renderSourceSection(latest));
    }
    refreshMoveButtons();
    if (jump) jumpToSource(latest.id);
    return true;
  } finally {
    setAddFormBusy(false);
  }
}

// For a duplicate add, find the section that already owns this
// input. Single-file inputs route into a container, so the duplicate
// is owned by the container of the matching kind; everything else
// matches by stored source path. Returns the source row (or
// undefined when nothing matches — caller surfaces no jump).
function findDuplicateOwner(
  normalizedInput: string,
  sources: readonly StoredSource[],
): StoredSource | undefined {
  if (isSingleFileInput(normalizedInput)) {
    const kind = containerKindForSingleFileInput(normalizedInput);
    return sources.find((s) => s.path === containerPath(kind));
  }
  return sources.find((s) => s.path === normalizedInput);
}

// Accept three forms: an http(s):// URL, a file:// URL, or an
// absolute POSIX path of length > 1. Everything else (relative
// paths, bare names, other schemes, bare `/`) is rejected so the
// user gets a clear message instead of a downstream scan failure or
// a scan of the filesystem root.
function isValidSourceInput(value: string): boolean {
  if (isHttpUrl(value) || isFileUrl(value)) return true;
  return value.startsWith('/') && value.length > 1;
}

// Show or clear the Add Source error line below the form. Pass null
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
function jumpToSource(sourceId: string): void {
  const section = findSection(sourceId);
  if (!section) return;
  history.replaceState(null, '', `#${sourceAnchorId(sourceId)}`);
  section.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Build an Up or Down arrow button for a source row. Centralizes the
// arrow glyph, the visible/announced label, and the click wiring so
// both buttons stay in lockstep when copy or behaviour changes.
function makeMoveButton(direction: 'up' | 'down', sourceId: string): HTMLButtonElement {
  const arrow = direction === 'up' ? '↑' : '↓';
  const label = `Move source ${direction}`;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `move-source move-${direction}`;
  btn.textContent = arrow;
  btn.title = label;
  btn.setAttribute('aria-label', label);
  btn.addEventListener('click', () => void onMoveSource(sourceId, direction));
  return btn;
}

// Serializes Up/Down clicks across every source row. A user clicking
// two arrows in quick succession (or one arrow on each of two rows)
// would otherwise issue two interleaved read-modify-write cycles on the
// `"sources"` index, last-write-wins — leaving the DOM out of sync with
// storage. Routing every move through this gate keeps the index write
// + DOM swap atomic w.r.t. other moves on this page.
let moveInFlight: Promise<void> = Promise.resolve();

// Swap the source one position up or down in the index and reflect the
// change in the DOM without rebuilding any section. The store call
// rewrites the index row; the local DOM move swaps the two sibling
// sections (cheaper than a re-render and preserves the per-section
// state — checkbox spinners, scroll position, row highlights).
async function onMoveSource(
  id: string,
  direction: 'up' | 'down',
): Promise<void> {
  const run = async (): Promise<void> => {
    const section = findSection(id);
    if (!section) return;
    const sibling = direction === 'up'
      ? section.previousElementSibling
      : section.nextElementSibling;
    if (!(sibling instanceof HTMLElement) || !sibling.classList.contains('directory')) return;
    setMoveButtonsBusy(true);
    try {
      await moveSource(id, direction);
      if (direction === 'up') {
        directoriesEl.insertBefore(section, sibling);
      } else {
        directoriesEl.insertBefore(sibling, section);
      }
    } finally {
      // refreshMoveButtons recomputes per-position disabled state, so
      // we don't need to undo setMoveButtonsBusy explicitly — the
      // refresh writes the correct enabled/disabled value for each
      // arrow based on its new index.
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
function setMoveButtonsBusy(busy: boolean): void {
  for (const btn of directoriesEl.querySelectorAll<HTMLButtonElement>('.move-source')) {
    btn.disabled = busy;
  }
}

// Walk every rendered source section and set each Up/Down button's
// disabled state from its current position: Up off on the first
// section, Down off on the last. Called after the initial render,
// after any move, and after add/remove flows change the section count.
// Filters on `section.directory` so the empty-list placeholder
// (`p.empty-placeholder`) that shares this container is ignored.
function refreshMoveButtons(): void {
  const sections = directoriesEl.querySelectorAll<HTMLElement>('section.directory');
  const last = sections.length - 1;
  sections.forEach((section, i) => {
    const up = section.querySelector<HTMLButtonElement>('.move-up');
    const down = section.querySelector<HTMLButtonElement>('.move-down');
    if (up) up.disabled = i === 0;
    if (down) down.disabled = i === last;
  });
}

async function onRemoveDirectory(id: string, section: HTMLElement, btn: HTMLButtonElement): Promise<void> {
  // Guard non-empty sources behind a confirm: removing a source drops
  // every script it owns, and the action is irreversible from the UI.
  // For an empty source there's nothing to lose, so skip the prompt.
  //
  // The count read is a snapshot — a background refresh adding or
  // removing a script while the dialog is open could leave the number
  // slightly stale. The window is short and the error bounded; not
  // worth a re-read.
  const data = await getSourceWithScripts(id);
  if (!data) {
    // Source row has been removed elsewhere (e.g. another tab).
    // Nothing to remove from the store; drop the orphan section.
    section.remove();
    return;
  }
  const scriptCount = data.scripts.length;
  if (scriptCount > 0) {
    const scriptWord = scriptCount === 1 ? 'script' : 'scripts';
    if (!confirm(`Remove source with ${scriptCount} ${scriptWord}?`)) return;
  }

  section.classList.add('removing');
  btn.disabled = true;
  try {
    await removeSource(id);
    section.remove();
    if (directoriesEl.querySelector('.directory') == null) {
      directoriesEl.appendChild(emptyPlaceholder());
    }
    refreshMoveButtons();
    await refreshLogIds();
  } catch (err) {
    section.classList.remove('removing');
    btn.disabled = false;
    throw err;
  }
}

async function onRefreshDirectory(id: string, btn: HTMLButtonElement): Promise<void> {
  const prevText = btn.textContent ?? 'Refresh';
  btn.disabled = true;
  btn.textContent = 'Refreshing…';
  try {
    // Snapshot the prior scripts so we can highlight rows that
    // actually changed after the refresh lands.
    const before = await getSourceWithScripts(id);
    const priorScripts = before?.scripts ?? [];
    // Goes through script-updater so a background opportunistic check
    // already in flight for this source coalesces with our click instead
    // of doing redundant work.
    await updateSource(id, 'manual');
    // Refresh may have added/removed scripts, flipped statuses, etc.
    // Rebuild just this one section so the rest of the page (other
    // directories, banners, scroll position) is undisturbed.
    const section = findSection(id);
    const latest = await getSource(id);
    if (section && latest) {
      await refreshLogIds();
      const fresh = await renderSourceSection(latest);
      section.replaceWith(fresh);
      refreshMoveButtons();
      const after = await getSourceWithScripts(id);
      applyChangeHighlights(fresh, priorScripts, after?.scripts ?? []);
    } else {
      // Section gone or source disappeared — fall back to button reset.
      btn.disabled = false;
      btn.textContent = prevText;
    }
  } catch (err) {
    btn.disabled = false;
    btn.textContent = prevText;
    throw err;
  }
}

// Refresh every registered directory in parallel, then re-render each
// section in place and flash any rows that changed. Triggered by the
// header "Refresh All" button and by ?refresh in the URL.
async function onRefreshAll(): Promise<void> {
  setRefreshAllBusy(true);
  try {
    // Snapshot each source's prior scripts before kicking off the
    // refresh so we can compute "what changed" per row.
    const sources = await getSources();
    const priorsBySource = new Map<string, StoredScript[]>();
    await Promise.all(sources.map(async (s) => {
      const before = await getSourceWithScripts(s.id);
      priorsBySource.set(s.id, before?.scripts ?? []);
    }));

    await updateAllSources('manual');

    await refreshLogIds();
    // Re-render each section in place. We don't blow away the whole
    // directories list so scroll position + un-refreshed sections (if
    // any new ones were added concurrently) stay put.
    for (const s of sources) {
      const section = findSection(s.id);
      const latest = await getSource(s.id);
      if (!section || !latest) continue;
      const fresh = await renderSourceSection(latest);
      section.replaceWith(fresh);
      const after = await getSourceWithScripts(s.id);
      applyChangeHighlights(fresh, priorsBySource.get(s.id) ?? [], after?.scripts ?? []);
    }
    refreshMoveButtons();
  } finally {
    setRefreshAllBusy(false);
  }
}

// Decide per script whether it changed in a refresh and tag the
// corresponding row with the matching highlight class. The color
// persists on the row until the next refresh re-renders the section.
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
  // the user notices the source went stale.
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

async function onToggleSource(id: string, enabled: boolean, label: HTMLLabelElement): Promise<void> {
  setToggleBusy(label, true);
  try {
    await setSourceEnabled(id, enabled);
    const section = findSection(id);
    if (section) applySourceEnabledToDom(section, enabled);
  } finally {
    setToggleBusy(label, false);
  }
}

async function onToggleScript(id: string, enabled: boolean, label: HTMLLabelElement): Promise<void> {
  setToggleBusy(label, true);
  try {
    await setScriptEnabled(id, enabled);
    const row = label.closest('tr') as HTMLTableRowElement | null;
    const section = label.closest('.directory') as HTMLElement | null;
    if (row && section) {
      const sourceOn = !section.classList.contains('disabled');
      row.classList.toggle('disabled', !sourceOn || !enabled);
      refreshBulkToggle(section);
    }
  } finally {
    setToggleBusy(label, false);
  }
}

async function onBulkToggleScripts(sourceId: string, btn: HTMLButtonElement): Promise<void> {
  const section = findSection(sourceId);
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
    const sourceOn = !section.classList.contains('disabled');
    const data = await getSourceWithScripts(sourceId);
    const scripts = data?.scripts ?? [];
    const toFlip = scripts
      .filter((s) => isScriptEnabled(s) !== next)
      .map((s) => ({ id: s.id, enabled: next }));
    await setScriptsEnabled(toFlip);

    // Reflect the new state in every row.
    for (const cb of checkboxes) cb.checked = next;
    for (const row of section.querySelectorAll<HTMLTableRowElement>('tbody tr')) {
      row.classList.toggle('disabled', !sourceOn || !next);
    }
  } finally {
    for (const lab of labels) setToggleBusy(lab, false);
    setBulkBusy(btn, false);
    refreshBulkToggle(section);
  }
}

// ---------- In-place DOM mutators ----------

function findSection(sourceId: string): HTMLElement | null {
  return directoriesEl.querySelector<HTMLElement>(
    `.directory[data-source-id="${cssEscape(sourceId)}"]`,
  );
}

// Apply a source enable/disable to its section without rebuilding it:
// flip the section's `.disabled` class, retitle the per-script toggle
// labels, enable/disable each per-script checkbox, and update the
// bulk-toggle's disabled state. Per-script `enabled` values are
// preserved in storage, so the row classes recompute from each
// checkbox's current `checked`.
function applySourceEnabledToDom(section: HTMLElement, enabled: boolean): void {
  section.classList.toggle('disabled', !enabled);

  for (const row of section.querySelectorAll<HTMLTableRowElement>('tbody tr')) {
    const cb = row.querySelector<HTMLInputElement>('.toggle input[type="checkbox"]');
    const lab = row.querySelector<HTMLLabelElement>('.toggle');
    if (!cb || !lab) continue;
    cb.disabled = !enabled;
    lab.classList.toggle('toggle-disabled', !enabled);
    lab.title = enabled ? 'Enable this script' : 'Source is disabled';
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
  const sourceOn = !section.classList.contains('disabled');
  const checkboxes = Array.from(
    section.querySelectorAll<HTMLInputElement>('tbody .toggle input[type="checkbox"]'),
  );
  const allOn = checkboxes.length > 0 && checkboxes.every((cb) => cb.checked);
  btn.disabled = !sourceOn;
  btn.title = bulkTitle(sourceOn, allOn);
  // While busy the symbol is replaced by a spinner; don't overwrite it.
  if (!btn.classList.contains('busy')) {
    btn.textContent = allOn ? '−' : '+';
  } else {
    btn.dataset.idleText = allOn ? '−' : '+';
  }
}

function bulkTitle(sourceOn: boolean, allOn: boolean): string {
  if (!sourceOn) return 'Source is disabled';
  return allOn
    ? 'Disable all scripts in this source'
    : 'Enable all scripts in this source';
}

function removeEmptyPlaceholder(): void {
  directoriesEl.querySelector('.empty-placeholder')?.remove();
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

// A page-relative viewer link (e.g. `userscript.html?script=<id>#Log`).
// Relative — not the absolute `chrome.runtime.getURL(...)` form — because
// both pages live at the extension root, so the browser resolves it
// against the current page; this keeps the long `chrome-extension://<id>/`
// prefix from being inlined twice per row (filename + status link) across
// a table that can hold hundreds of scripts. Returns a string; the two
// callers already `.toString()` it (a no-op on a string).
function viewerUrl(scriptId: string, tab?: 'log'): string {
  const params = new URLSearchParams({ script: scriptId });
  // The viewer parses #Log via parseHash and lands on the Log pane.
  const hash = tab === 'log' ? '#Log' : '';
  return `userscript.html?${params.toString()}${hash}`;
}

// CSS.escape isn't on every old runtime; fall back to a minimal escape
// for the characters that show up in a UUID-shaped sourceId.
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
  if (!chrome.userScripts) return { usable: false, error: 'chrome.userScripts is not available' };
  try {
    await chrome.userScripts.getScripts();
    return { usable: true };
  } catch (err) {
    return { usable: false, error: err instanceof Error ? err.message : String(err) };
  }
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
