// Userscript viewer. Loaded as chrome-extension://…/userscript.html
// with a single query param `script=<scriptId>`. Hydrates from the
// persistent store (chrome.storage.local) rather than re-reading the
// file, so the content always matches what the options page shows.
//
// The header row at the top mirrors the options-page table columns
// (filename / size / status) and adds a Refresh button that re-reads
// the file and updates storage in place.

import {
  getScript,
  refreshScript,
  type StoredScript,
} from './script-store.js';
import {
  getValue,
  getValues,
} from './userscript-header.js';

declare const Prism: { highlightElement(el: Element): void };

const params = new URLSearchParams(location.search);
const scriptId = params.get('script');

const filenameEl = document.getElementById('filename')!;
const metaRowEl = document.getElementById('meta-row')!;
const sizeEl = document.getElementById('meta-size')!;
const statusEl = document.getElementById('meta-status')!;
const refreshBtn = document.getElementById('refresh-btn') as HTMLButtonElement;
const messageEl = document.getElementById('message')!;
const summaryEl = document.getElementById('header-summary')!;
const contentEl = document.getElementById('content')!;

refreshBtn.addEventListener('click', () => void onRefresh());

void load();

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
  render(script);
}

async function onRefresh(): Promise<void> {
  if (!scriptId) return;
  refreshBtn.disabled = true;
  const prior = refreshBtn.textContent;
  refreshBtn.textContent = 'Refreshing…';
  try {
    const next = await refreshScript(scriptId);
    if (next) render(next);
  } finally {
    refreshBtn.disabled = false;
    refreshBtn.textContent = prior ?? 'Refresh';
  }
}

function render(script: StoredScript): void {
  metaRowEl.hidden = false;
  filenameEl.textContent = script.relativePath;
  document.title = `${script.relativePath} — VibeMonkey`;

  sizeEl.textContent =
    script.status === 'missing' || script.size == null
      ? 'MISSING'
      : formatBytes(script.size);

  const statusLabel = script.status === 'ok' ? 'OK' : 'ERROR';
  statusEl.textContent = statusLabel;
  statusEl.className = `meta-status status-${script.status}`;

  messageEl.textContent = script.errorMessage ?? '';
  messageEl.className = script.errorMessage ? 'message error' : 'message';

  renderSummary(script);

  // textContent escapes; Prism then walks the node and replaces text
  // with highlighted spans. Doing it this way (rather than innerHTML)
  // keeps untrusted file content from being interpreted as markup.
  const body = script.headerText
    ? script.headerText + '\n' + script.bodyText
    : script.bodyText;
  contentEl.textContent = body;
  Prism.highlightElement(contentEl);
}

function renderSummary(script: StoredScript): void {
  summaryEl.replaceChildren();
  if (!script.header) return;

  const dl = document.createElement('dl');
  const name = getValue(script.header, 'name');
  if (name) appendRow(dl, 'Name', textNode(name));
  const description = getValue(script.header, 'description');
  if (description) appendRow(dl, 'Description', textNode(description));
  const matches = getValues(script.header, 'match');
  if (matches.length) appendRow(dl, 'Match', urlList(matches));
  const excludes = getValues(script.header, 'exclude');
  if (excludes.length) appendRow(dl, 'Exclude', urlList(excludes));

  if (dl.childElementCount > 0) summaryEl.appendChild(dl);
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
  metaRowEl.hidden = true;
  filenameEl.textContent = 'Not available';
  messageEl.textContent = message;
  messageEl.className = 'message error';
  summaryEl.replaceChildren();
  contentEl.textContent = '';
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
