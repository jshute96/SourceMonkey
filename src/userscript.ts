// Userscript viewer. Loaded as chrome-extension://…/userscript.html
// with a single query param `script=<scriptId>`. Hydrates from the
// persistent store (chrome.storage.local) rather than re-reading the
// file, so the content always matches what the options page shows.
//
// Layout: a thin controls row (Enable toggle + Refresh) on top, then
// a details panel (parsed-header fields + Location / Size / Status),
// then the highlighted code box.

import {
  getAllScripts,
  getScript,
  getSource,
  isScriptEnabled,
  isSourceEnabled,
  setScriptEnabled,
  type StoredScript,
} from './script-store.js';
import { computeLogIds } from './script-log-id.js';
import { updateScript } from './script-updater.js';
import {
  formatScriptSize,
  formatScriptStatusLabel,
} from './script-display.js';
import {
  getValue,
  getValues,
} from './userscript-header.js';
import { scriptAbsolutePath } from './directories.js';
import { renderSiteIconInto } from './site-icon.js';

declare const Prism: { highlightElement(el: Element): void };

const params = new URLSearchParams(location.search);
const scriptId = params.get('script');

const filenameEl = document.getElementById('filename')!;
const controlsRowEl = document.getElementById('meta-row')!;
const enableLabelEl = document.getElementById('enable-label') as HTMLLabelElement;
const enableCheckboxEl = document.getElementById('enable-checkbox') as HTMLInputElement;
const refreshBtn = document.getElementById('refresh-btn') as HTMLButtonElement;
const messageEl = document.getElementById('message')!;
const summaryEl = document.getElementById('header-summary')!;
const contentEl = document.getElementById('content')!;

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
// each render() (appendChild moves it, so no duplication). Keeping it
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

// Keep the displayed Log ID in sync with the global dupe set: if
// another tab (options page, viewer of a sibling) adds or removes a
// script that shares this basename, our `#N` would otherwise go
// stale. Listen for any script:* mutation and re-derive.
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  let touched = false;
  for (const key of Object.keys(changes)) {
    if (key.startsWith('script:')) { touched = true; break; }
  }
  if (!touched) return;
  void rehydrateAfterStorageChange();
});

async function rehydrateAfterStorageChange(): Promise<void> {
  if (!scriptId) return;
  // If THIS script was removed, drop into the not-found state.
  const script = await getScript(scriptId);
  if (!script) {
    showMissing('Script not found in storage. Open it from the options page.');
    return;
  }
  await refreshLogId();
  render(script);
}

// Source-enabled state is needed for greying the toggle. We cache it so
// onToggle doesn't have to re-read storage. sourcePath is cached for
// the same reason — render() builds the absolute filename from it.
let sourceEnabled = true;
let sourcePath = '';
let copyResetTimer: ReturnType<typeof setTimeout> | null = null;
// Path currently shown in the Filename cell. onCopyFilename copies
// this rather than reading textContent, which would also break if the
// dl ever wraps the path across multiple text nodes.
let currentFilenamePath = '';
// This script's log ID. Computed at load(), re-derived after refresh,
// and kept fresh while the viewer is open by listening to
// chrome.storage.onChanged for any script:* mutation (another tab
// adding/removing a sibling with the same basename would otherwise
// leave a stale `#N` on screen).
let currentLogId = '';

async function load(): Promise<void> {
  if (!scriptId) {
    showMissing('Missing `script` query parameter.');
    return;
  }
  const script = await getScript(scriptId);
  if (!script) {
    showMissing('Script not found in storage. Open it from the options page.');
    return;
  }
  const source = await getSource(script.sourceId);
  sourceEnabled = source ? isSourceEnabled(source) : true;
  sourcePath = source?.path ?? '';
  await refreshLogId();
  render(script);
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
    // Routed through the shared updater: if a background opportunistic
    // check is already in flight for this script, we wait for it
    // instead of starting a second fetch.
    const next = await updateScript(scriptId, 'manual');
    if (next) {
      await refreshLogId();
      render(next);
    }
  } finally {
    refreshBtn.disabled = false;
    refreshBtn.textContent = prior ?? 'Refresh';
  }
}

async function onToggleEnabled(enabled: boolean): Promise<void> {
  if (!scriptId) return;
  const next = await setScriptEnabled(scriptId, enabled);
  if (next) render(next);
}

async function onCopyFilename(): Promise<void> {
  if (!currentFilenamePath) return;
  try {
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
  controlsRowEl.hidden = false;
  renderFilenameHeading(script);
  document.title = `${script.relativePath} — SourceMonkey`;

  enableCheckboxEl.checked = isScriptEnabled(script);
  enableCheckboxEl.disabled = !sourceEnabled;
  enableLabelEl.classList.toggle('toggle-disabled', !sourceEnabled);
  enableLabelEl.title = sourceEnabled
    ? 'Enable this script'
    : 'Source is disabled';

  messageEl.textContent = script.errorMessage ?? '';
  messageEl.className = script.errorMessage ? 'message error' : 'message';

  renderDetails(script);

  // textContent escapes; Prism then walks the node and replaces text
  // with highlighted spans. Doing it this way (rather than innerHTML)
  // keeps untrusted file content from being interpreted as markup.
  const body = script.headerText
    ? script.headerText + '\n' + script.bodyText
    : script.bodyText;
  contentEl.textContent = body;
  Prism.highlightElement(contentEl);
}

// Replace the H1 with a favicon slot followed by the relative path.
// renderSiteIconInto paints a clickable globe placeholder
// synchronously (when the script targets a usable origin) and swaps
// it for the real favicon once the fetch resolves.
function renderFilenameHeading(script: StoredScript): void {
  filenameEl.replaceChildren();
  const iconSlot = document.createElement('span');
  iconSlot.className = 'site-icon';
  filenameEl.appendChild(iconSlot);
  filenameEl.appendChild(document.createTextNode(script.relativePath));
  renderSiteIconInto(iconSlot, script);
}

function renderDetails(script: StoredScript): void {
  summaryEl.replaceChildren();

  const dl = document.createElement('dl');

  if (script.header) {
    const name = getValue(script.header, 'name');
    if (name) appendRow(dl, 'Name', textNode(name));
    const description = getValue(script.header, 'description');
    if (description) appendRow(dl, 'Description', textNode(description));
  }
  // Log ID always renders — it's how the user maps an entry in the SW
  // console back to this script. Sits right under the header fields
  // so it's visible without scrolling.
  if (currentLogId) {
    appendRow(dl, 'Log ID', logIdCell(currentLogId));
  }
  if (script.header) {
    const matches = getValues(script.header, 'match');
    if (matches.length) appendRow(dl, 'Match', urlList(matches));
    const excludes = getValues(script.header, 'exclude');
    if (excludes.length) appendRow(dl, 'Exclude', urlList(excludes));
  }

  // Resolved location for the script: an absolute filesystem path for
  // file:// sources, or the fully-resolved URL for HTTP sources. Skip
  // the row entirely if the source row is gone — a bare relative path
  // under a "Location" label would be misleading.
  if (sourcePath) {
    currentFilenamePath = scriptAbsolutePath(sourcePath, script.relativePath);
    appendRow(dl, 'Location', filenameCell(currentFilenamePath));
  } else {
    currentFilenamePath = '';
  }

  appendRow(dl, 'Size', textNode(formatScriptSize(script)));

  const status = document.createElement('span');
  status.textContent = formatScriptStatusLabel(script.status);
  status.className = `meta-status status-${script.status}`;
  if (script.errorMessage) status.title = script.errorMessage;
  appendRow(dl, 'Status', status);

  summaryEl.appendChild(dl);
}

function logIdCell(logId: string): Node {
  const span = document.createElement('span');
  span.className = 'log-id-cell';
  span.textContent = logId;
  return span;
}

function filenameCell(path: string): Node {
  const cell = document.createElement('span');
  cell.className = 'filename-cell';

  const pathEl = document.createElement('span');
  pathEl.className = 'filename-text';
  pathEl.textContent = path;
  cell.appendChild(pathEl);

  // Reuses the module-level button; appendChild moves it into the
  // new cell. Any in-flight "Copied" flash carries across because the
  // class lives on the button (not the cell) and the timer is still
  // valid — the checkmark continues for the rest of its 1.2s window.
  cell.appendChild(filenameCopyBtn);

  return cell;
}

function appendRow(dl: HTMLDListElement, label: string, value: Node): void {
  const dt = document.createElement('dt');
  dt.textContent = label;
  const dd = document.createElement('dd');
  dd.appendChild(value);
  dl.append(dt, dd);
}

function textNode(s: string): Text {
  return document.createTextNode(s);
}

function urlList(items: string[]): Node {
  if (items.length === 1) return textNode(items[0]);
  const ul = document.createElement('ul');
  for (const item of items) {
    const li = document.createElement('li');
    li.textContent = item;
    ul.appendChild(li);
  }
  return ul;
}

function showMissing(message: string): void {
  controlsRowEl.hidden = true;
  filenameEl.textContent = 'Not available';
  messageEl.textContent = message;
  messageEl.className = 'message error';
  summaryEl.replaceChildren();
  contentEl.textContent = '';
}
