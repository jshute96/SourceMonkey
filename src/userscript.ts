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

declare const Prism: { highlightElement(el: Element): void };

const params = new URLSearchParams(location.search);
const src = params.get('src');
const displayName = params.get('name') ?? src ?? '';

const filenameEl = document.getElementById('filename')!;
const contentEl = document.getElementById('content')!;
const statusEl = document.getElementById('status')!;

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
    setStatus(null, '');
  } catch (err) {
    setStatus('error', `Failed to read: ${describeError(err)}`);
  }
}

function setStatus(kind: 'error' | null, text: string): void {
  statusEl.textContent = text;
  statusEl.className = kind ?? '';
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
