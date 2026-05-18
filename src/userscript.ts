// Userscript viewer. Loaded as chrome-extension://…/userscript.html
// with a single query param `script=<scriptId>`. Hydrates from the
// persistent store (chrome.storage.local) rather than re-reading the
// file, so the content always matches what the options page shows.
//
// Layout: a thin controls row (Enable toggle + Refresh) on top, then
// a details panel (parsed-header fields + Filename / Size / Status),
// then the highlighted code box.

import {
  getScript,
  getSource,
  isScriptEnabled,
  isSourceEnabled,
  setScriptEnabled,
  type StoredScript,
} from './script-store.js';
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
  btn.title = 'Copy filename to clipboard';
  btn.setAttribute('aria-label', 'Copy filename to clipboard');
  btn.innerHTML = COPY_ICON_SVG + CHECK_ICON_SVG;
  btn.addEventListener('click', () => void onCopyFilename());
  return btn;
})();

void load();

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
  render(script);
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
    if (next) render(next);
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
  filenameEl.textContent = script.relativePath;
  document.title = `${script.relativePath} — VibeMonkey`;

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

function renderDetails(script: StoredScript): void {
  summaryEl.replaceChildren();

  const dl = document.createElement('dl');

  if (script.header) {
    const name = getValue(script.header, 'name');
    if (name) appendRow(dl, 'Name', textNode(name));
    const description = getValue(script.header, 'description');
    if (description) appendRow(dl, 'Description', textNode(description));
    const matches = getValues(script.header, 'match');
    if (matches.length) appendRow(dl, 'Match', urlList(matches));
    const excludes = getValues(script.header, 'exclude');
    if (excludes.length) appendRow(dl, 'Exclude', urlList(excludes));
  }

  // Absolute filesystem path: source directory + script's relative
  // path (or just the source path itself when the source is a single
  // `.user.js` file). Skip the row entirely if the source row is gone
  // — a bare relative path under a "Filename" label would be misleading.
  if (sourcePath) {
    currentFilenamePath = scriptAbsolutePath(sourcePath, script.relativePath);
    appendRow(dl, 'Filename', filenameCell(currentFilenamePath));
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
