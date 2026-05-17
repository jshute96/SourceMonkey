// Userscript viewer. Loaded as chrome-extension://…/userscript.html with
// query params:
//   - dir:  directory id (key into the IndexedDB handle store)
//   - path: relative path within that directory
//   - key:  optional chrome.storage.session key whose value is a
//           {name, content} object pre-fetched by the options page
//
// Two load paths:
//   1. Fast path — `key` is present, content is in session storage
//      from the options-page click handler. Display directly.
//   2. Fallback — load the FileSystemDirectoryHandle from IndexedDB,
//      query permission, and either read on the spot or show a
//      "Grant access and load" button (requestPermission needs a
//      user gesture, which the button click supplies).

import {
  ensureReadPermission,
  hasReadPermission,
  loadHandle,
  readFileFromDirectory,
} from './directories.js';

declare const Prism: { highlightElement(el: Element): void };

const params = new URLSearchParams(location.search);
const dirId = params.get('dir');
const relPath = params.get('path');
const sessionKey = params.get('key');

const filenameEl = document.getElementById('filename')!;
const contentEl = document.getElementById('content')!;
const statusEl = document.getElementById('status')!;
const grantBtn = document.getElementById('grant') as HTMLButtonElement;

if (relPath) {
  filenameEl.textContent = relPath;
  document.title = `${relPath} — VibeMonkey`;
}

grantBtn.addEventListener('click', () => {
  void loadViaHandle(true);
});

void init();

async function init(): Promise<void> {
  if (await tryLoadFromSession()) return;
  await loadViaHandle(false);
}

async function tryLoadFromSession(): Promise<boolean> {
  if (!sessionKey) return false;
  const storageKey = `script:${sessionKey}`;
  const data = await chrome.storage.session.get(storageKey);
  const entry = data[storageKey] as { name: string; content: string } | undefined;
  if (!entry) return false;
  // One-shot: clear so a refresh doesn't keep stale content around.
  await chrome.storage.session.remove(storageKey);
  showContent(entry.name, entry.content);
  return true;
}

async function loadViaHandle(canRequestPermission: boolean): Promise<void> {
  if (!dirId || !relPath) {
    setStatus('error', 'Missing dir or path parameter.');
    return;
  }
  const handle = await loadHandle(dirId);
  if (!handle) {
    setStatus('error', 'That directory is no longer registered.');
    return;
  }

  if (!(await hasReadPermission(handle))) {
    if (!canRequestPermission) {
      grantBtn.hidden = false;
      setStatus(null, 'Permission required to read this file.');
      return;
    }
    if (!(await ensureReadPermission(handle))) {
      setStatus('error', 'Permission denied.');
      return;
    }
  }

  try {
    const content = await readFileFromDirectory(handle, relPath);
    showContent(relPath, content);
  } catch (err) {
    setStatus('error', `Failed to read: ${describeError(err)}`);
  }
}

function showContent(name: string, content: string): void {
  filenameEl.textContent = name;
  document.title = `${name} — VibeMonkey`;
  // textContent escapes; Prism then walks the node and replaces text
  // with highlighted spans. Doing it this way (rather than innerHTML)
  // keeps untrusted file content from being interpreted as markup.
  contentEl.textContent = content;
  Prism.highlightElement(contentEl);
  grantBtn.hidden = true;
  setStatus(null, '');
}

function setStatus(kind: 'error' | null, text: string): void {
  statusEl.textContent = text;
  statusEl.className = kind ?? '';
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
