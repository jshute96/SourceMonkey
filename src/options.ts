// Options page controller. Renders one section per registered source
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
  getAllScripts,
  getSource,
  getSourceWithScripts,
  getSources,
  isScriptEnabled,
  isSourceEnabled,
  removeScript,
  removeSource,
  setScriptEnabled,
  setScriptsEnabled,
  setSourceEnabled,
  type StoredScript,
  type StoredSource,
} from './script-store.js';
import {
  updateAllSources,
  updateSource,
} from './script-updater.js';
import {
  formatScriptSize,
  formatScriptStatusLabel,
} from './script-display.js';
import { DEBUG_LOGGING_KEY } from './debug-log.js';
import { computeLogIds } from './script-log-id.js';
import { renderSiteIconInto } from './site-icon.js';
import { isHttpUrl, isFileUrl } from './directories.js';

const bannerSlot = document.getElementById('banner-slot')!;
const directoriesEl = document.getElementById('directories')!;
const addForm = document.getElementById('add-form') as HTMLFormElement;
const addInput = document.getElementById('add-path') as HTMLInputElement;
const addButton = addForm.querySelector('button[type="submit"]') as HTMLButtonElement;
const refreshAllBtn = document.getElementById('refresh-all') as HTMLButtonElement;
const addErrorEl = document.getElementById('add-error') as HTMLParagraphElement;
const versionEl = document.getElementById('version');

if (versionEl) {
  versionEl.textContent = `Version ${chrome.runtime.getManifest().version}`;
}

addForm.addEventListener('submit', (event) => {
  event.preventDefault();
  void onAddDirectory(addInput.value);
});

refreshAllBtn.addEventListener('click', () => void onRefreshAll());

initDebugLoggingToggle();

void bootstrap();

// Page-wide map of {scriptId → log ID}, refreshed whenever scripts are
// added / removed / refreshed. Renders the `#N` dupe suffix in the
// filename cell. Empty until `refreshLogIds()` runs.
let currentLogIds = new Map<string, string>();

async function refreshLogIds(): Promise<void> {
  const all = await getAllScripts();
  currentLogIds = computeLogIds(all);
  applyLogIdSuffixesToDom();
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
    span.textContent = suffixFromLogId(currentLogIds.get(id) ?? '');
  }
}

function suffixFromLogId(logId: string): string {
  const hash = logId.indexOf('#');
  return hash < 0 ? '' : logId.slice(hash);
}

// `?refresh` in the URL triggers a refresh-all as soon as the initial
// render is done. Lets external tools poke the extension via
//   google-chrome chrome-extension://<id>/options.html?refresh
// after they've written new userscripts.
//
// `?add_source=<path-or-url>` does the equivalent of typing the value
// into the Add Source field and clicking Add. Validates the input;
// shows an error if it doesn't look like an absolute path or URL.
// On success or duplicate, jumps to the resulting source section.
// Lets the docs/redirect-page.md deep link route here from anywhere
// on the web (see docs/deep-link.md).
async function bootstrap(): Promise<void> {
  await render();
  const params = new URLSearchParams(location.search);
  if (params.has('refresh')) {
    await onRefreshAll();
    scrubQueryParams(['refresh']);
  }
  const addSourceArg = params.get('add_source');
  if (addSourceArg !== null) {
    await handleAddSourceParam(addSourceArg);
  }
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
  for (const source of sources) {
    directoriesEl.appendChild(await renderSourceSection(source));
  }
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
  heading.textContent = source.path;
  header.appendChild(heading);

  const buttons = document.createElement('div');
  buttons.className = 'directory-buttons';

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

  if (scripts.length === 0) {
    return makeMessage('empty', 'No *.user.js files found.');
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
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const script of scripts) tbody.appendChild(renderScriptRow(script, sourceOn));
  table.appendChild(tbody);
  return table;
}

function renderScriptRow(script: StoredScript, sourceOn: boolean): HTMLTableRowElement {
  const scriptOn = isScriptEnabled(script);

  const tr = document.createElement('tr');
  tr.dataset.scriptId = script.id;
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
  a.textContent = script.relativePath;
  a.href = viewerUrl(script.id).toString();
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  nameCell.appendChild(a);
  // Dupe-suffix span, populated from currentLogIds. Empty for unique
  // basenames so the column stays clean; non-empty (e.g. " #2") only
  // when another script shares this basename.
  const suffix = document.createElement('span');
  suffix.className = 'log-id-suffix';
  suffix.textContent = suffixFromLogId(currentLogIds.get(script.id) ?? '');
  nameCell.appendChild(suffix);
  tr.appendChild(nameCell);

  const sizeCell = document.createElement('td');
  sizeCell.className = 'size-cell';
  sizeCell.textContent = formatScriptSize(script);
  tr.appendChild(sizeCell);

  const statusCell = document.createElement('td');
  statusCell.className = 'status-cell';
  const statusText = document.createElement('span');
  statusText.textContent = formatScriptStatusLabel(script.status);
  statusCell.appendChild(statusText);
  statusCell.classList.add(`status-${script.status}`);
  if (script.errorMessage) statusCell.title = script.errorMessage;
  // Trash-can affordance only for missing rows. Refresh won't recreate
  // a missing row (the scan no longer reports the file), so the user
  // needs an explicit way to clear records they don't want to see.
  if (script.status === 'missing') {
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'remove-script';
    removeBtn.textContent = '🗑';
    removeBtn.title = 'Remove this script record';
    removeBtn.setAttribute('aria-label', 'Remove this script record');
    removeBtn.addEventListener('click', () => void onRemoveScript(script.id, script.sourceId, removeBtn));
    statusCell.appendChild(removeBtn);
  }
  tr.appendChild(statusCell);

  return tr;
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
      `section.directory[data-source-id="${sourceId}"] tr[data-script-id="${scriptId}"]`,
    );
    row?.remove();
    // If this was the last script under the source, swap the table
    // for the standard "No *.user.js files found." placeholder so the
    // section doesn't show a dangling empty table.
    const section = directoriesEl.querySelector<HTMLElement>(
      `section.directory[data-source-id="${sourceId}"]`,
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
    console.error('[SourceMonkey] removeScript failed', err);
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
async function onAddDirectory(rawPath: string): Promise<boolean> {
  const path = rawPath.trim();
  if (!path) return false;

  if (!isValidSourceInput(path)) {
    showAddError(
      'Sources must be an absolute path (starting with /) or an http(s):// / file:// URL.',
    );
    return false;
  }
  showAddError(null);

  setAddFormBusy(true);
  try {
    const created = await addSource(path);
    addInput.value = '';
    if (!created) {
      // Already registered: find the existing source by path, jump
      // to it, and tell the user why nothing new appeared (otherwise
      // a deep-link with a duplicate just silently scrolls).
      const existing = (await getSources()).find((s) => s.path === path);
      if (existing) {
        showAddError('This source is already registered.');
        jumpToSource(existing.id);
      }
      return true;
    }
    // refreshSource ran inside addSource, but addSource returns the
    // seed row. Re-read so we get the post-refresh scriptIds (the
    // section render queries getSourceWithScripts anyway, but reading
    // the latest source row keeps the StoredSource we pass in sync).
    const latest = (await getSource(created.id)) ?? created;
    removeEmptyPlaceholder();
    await refreshLogIds();
    directoriesEl.appendChild(await renderSourceSection(latest));
    jumpToSource(created.id);
    return true;
  } finally {
    setAddFormBusy(false);
  }
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

// Anchor target for a section so it can be scrolled to by id and
// linked to via `#source-<id>`.
function sourceAnchorId(sourceId: string): string {
  return `source-${sourceId}`;
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

function viewerUrl(scriptId: string): URL {
  const url = new URL(chrome.runtime.getURL('userscript.html'));
  url.searchParams.set('script', scriptId);
  return url;
}

// CSS.escape isn't on every old runtime; fall back to a minimal escape
// for the characters that show up in a UUID-shaped sourceId.
function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
  return value.replace(/["\\]/g, '\\$&');
}

function initDebugLoggingToggle(): void {
  const cb = document.getElementById('debug-logging') as HTMLInputElement | null;
  if (!cb) return;
  // Hydrate from storage so the box reflects the persisted state, then
  // mirror future writes (from anywhere — DevTools, another options
  // tab) so the two never drift out of sync.
  void chrome.storage.local.get(DEBUG_LOGGING_KEY).then((got) => {
    cb.checked = got[DEBUG_LOGGING_KEY] === true;
  });
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    const change = changes[DEBUG_LOGGING_KEY];
    if (!change) return;
    cb.checked = change.newValue === true;
  });
  cb.addEventListener('change', () => {
    void chrome.storage.local.set({ [DEBUG_LOGGING_KEY]: cb.checked });
  });
}

function isFileSchemeAccessAllowed(): Promise<boolean> {
  return new Promise((resolve) => {
    chrome.extension.isAllowedFileSchemeAccess((allowed) => resolve(allowed));
  });
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

function renderFileAccessBanner(): HTMLElement {
  const div = document.createElement('div');
  div.className = 'banner';

  const heading = document.createElement('strong');
  heading.textContent = 'File access is disabled.';
  div.appendChild(heading);

  const explain = document.createElement('p');
  explain.textContent =
    'SourceMonkey can\'t read local files until you enable ' +
    '"Allow access to file URLs". Open the extension\'s details page, ' +
    'turn it on, then reload this page:';
  div.appendChild(explain);

  div.appendChild(extensionDetailsLink());

  return div;
}

// chrome:// URLs are blocked from <a href> navigation, so we use a
// click handler that calls chrome.tabs.create — that path is allowed
// from extension pages. Rendered as an <a> so it looks/behaves like
// any other link.
function extensionDetailsLink(): HTMLElement {
  const url = `chrome://extensions/?id=${chrome.runtime.id}`;
  const a = document.createElement('a');
  a.href = url;
  a.textContent = url;
  a.className = 'chrome-link';
  a.addEventListener('click', (event) => {
    event.preventDefault();
    void chrome.tabs.create({ url });
  });
  return a;
}

function makeMessage(className: string, text: string): HTMLElement {
  const p = document.createElement('p');
  p.className = className;
  p.textContent = text;
  return p;
}
