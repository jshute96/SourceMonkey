// Userscript viewer. Loaded as chrome-extension://…/userscript.html
// with query params:
//   - src:  file:// URL of the userscript to display
//   - name: display name (typically the path relative to the
//           registered directory)
//
// The viewer fetches `src` via XHR each time it's opened. There's no
// pre-fetch / session-storage hop, no permission re-grant — the
// "Allow access to file URLs" toggle that lets the options page scan
// also lets this page read.

import { fetchFileUrlText } from './directories.js';
import {
  parseHeader,
  getValue,
  getValues,
  type ParsedHeader,
} from './userscript-header.js';

declare const Prism: { highlightElement(el: Element): void };

const params = new URLSearchParams(location.search);
const src = params.get('src');
const displayName = params.get('name') ?? src ?? '';

const filenameEl = document.getElementById('filename')!;
const contentEl = document.getElementById('content')!;
const statusEl = document.getElementById('status')!;
const summaryEl = document.getElementById('header-summary')!;

filenameEl.textContent = displayName;
document.title = displayName ? `${displayName} — VibeMonkey` : 'VibeMonkey';

void load();

async function load(): Promise<void> {
  if (!src) {
    setStatus('error', 'Missing src parameter.');
    return;
  }
  try {
    const text = await fetchFileUrlText(src);
    // textContent escapes; Prism then walks the node and replaces text
    // with highlighted spans. Doing it this way (rather than innerHTML)
    // keeps untrusted file content from being interpreted as markup.
    contentEl.textContent = text;
    Prism.highlightElement(contentEl);
    renderSummary(parseHeader(text));
    setStatus(null, '');
  } catch (err) {
    setStatus('error', `Failed to read: ${describeError(err)}`);
  }
}

// Render a few common metadata fields above the code box. We leave the
// summary container empty (and CSS-hidden) when the script has no
// metadata block at all.
function renderSummary(header: ParsedHeader | null): void {
  summaryEl.replaceChildren();
  if (!header) return;

  const dl = document.createElement('dl');
  const name = getValue(header, 'name');
  if (name) appendRow(dl, 'Name', textNode(name));
  const description = getValue(header, 'description');
  if (description) appendRow(dl, 'Description', textNode(description));
  const matches = getValues(header, 'match');
  if (matches.length) appendRow(dl, 'Match', urlList(matches));
  const excludes = getValues(header, 'exclude');
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

function setStatus(kind: 'error' | null, text: string): void {
  statusEl.textContent = text;
  statusEl.className = kind ?? '';
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
