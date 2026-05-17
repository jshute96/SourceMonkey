// Options page controller. Renders the list of registered directories
// (each picked via showDirectoryPicker), scans each for *.user.js
// files up to two subdir levels deep, and links each finding to a
// userscript.html viewer.
//
// When the user left-clicks a script link we pre-read the file's
// content on this page (where we already have read permission for the
// handle) and stash it in chrome.storage.session under a random key.
// The viewer page reads from session storage by that key. This avoids
// the viewer needing its own user-gesture permission re-grant.
// Middle-click and "open in new tab" fall back to the viewer's own
// handle-loading path (which will prompt for permission).

import {
  deleteHandle,
  getDirectories,
  loadHandle,
  readFileFromDirectory,
  saveHandle,
  scanForUserScripts,
  setDirectories,
  type DirectoryEntry,
  type FoundScript,
} from './directories.js';

interface WindowWithPicker {
  showDirectoryPicker(opts?: { id?: string; mode?: 'read' | 'readwrite' }): Promise<FileSystemDirectoryHandle>;
}

const directoriesEl = document.getElementById('directories')!;
const addButton = document.getElementById('add-directory') as HTMLButtonElement;
const versionEl = document.getElementById('version');

if (versionEl) {
  versionEl.textContent = `Version ${chrome.runtime.getManifest().version}`;
}

addButton.addEventListener('click', () => {
  void addDirectory();
});

void render();

async function addDirectory(): Promise<void> {
  let handle: FileSystemDirectoryHandle;
  try {
    handle = await (window as unknown as WindowWithPicker).showDirectoryPicker({
      id: 'vibemonkey-userscripts',
      mode: 'read',
    });
  } catch (err) {
    if ((err as DOMException)?.name === 'AbortError') return;
    throw err;
  }
  const id = crypto.randomUUID();
  await saveHandle(id, handle);
  const dirs = await getDirectories();
  dirs.push({ id, name: handle.name });
  await setDirectories(dirs);
  await render();
}

async function removeDirectory(id: string): Promise<void> {
  const dirs = await getDirectories();
  await setDirectories(dirs.filter((d) => d.id !== id));
  await deleteHandle(id);
  await render();
}

async function render(): Promise<void> {
  directoriesEl.textContent = '';
  const dirs = await getDirectories();

  if (dirs.length === 0) {
    const p = document.createElement('p');
    p.className = 'placeholder';
    p.textContent = 'No directories yet. Click "Add directory" to pick one.';
    directoriesEl.appendChild(p);
    return;
  }

  for (const dir of dirs) {
    directoriesEl.appendChild(await renderDirectory(dir));
  }
}

async function renderDirectory(dir: DirectoryEntry): Promise<HTMLElement> {
  const section = document.createElement('section');
  section.className = 'directory';

  const header = document.createElement('div');
  header.className = 'directory-header';

  const heading = document.createElement('h2');
  heading.textContent = dir.name;
  header.appendChild(heading);

  const removeBtn = document.createElement('button');
  removeBtn.textContent = 'Remove';
  removeBtn.addEventListener('click', () => {
    void removeDirectory(dir.id);
  });
  header.appendChild(removeBtn);

  section.appendChild(header);
  section.appendChild(await renderScriptList(dir));
  return section;
}

async function renderScriptList(dir: DirectoryEntry): Promise<HTMLElement> {
  const handle = await loadHandle(dir.id);
  if (!handle) {
    return makeMessage('error', 'No stored handle (Remove and re-add the directory).');
  }

  let scripts;
  try {
    scripts = await scanForUserScripts(handle);
  } catch (err) {
    return makeMessage('error', `Scan failed: ${describeError(err)}`);
  }

  if (scripts.length === 0) {
    return makeMessage('empty', 'No *.user.js files found.');
  }

  const list = document.createElement('ul');
  for (const script of scripts) {
    list.appendChild(renderScriptLink(dir, handle, script));
  }
  return list;
}

function renderScriptLink(
  dir: DirectoryEntry,
  handle: FileSystemDirectoryHandle,
  script: FoundScript,
): HTMLElement {
  const li = document.createElement('li');
  const a = document.createElement('a');
  a.textContent = script.relativePath;
  a.href = viewerUrl(dir.id, script.relativePath).toString();
  a.target = '_blank';
  a.rel = 'noopener';

  a.addEventListener('click', (event) => {
    // Let modifier-clicks and middle-clicks fall through to default
    // behavior; the viewer page will handle those itself.
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) {
      return;
    }
    event.preventDefault();
    void openWithPrefetch(dir.id, handle, script);
  });

  li.appendChild(a);
  return li;
}

function viewerUrl(dirId: string, relativePath: string, sessionKey?: string): URL {
  const url = new URL(chrome.runtime.getURL('userscript.html'));
  url.searchParams.set('dir', dirId);
  url.searchParams.set('path', relativePath);
  if (sessionKey) url.searchParams.set('key', sessionKey);
  return url;
}

async function openWithPrefetch(
  dirId: string,
  handle: FileSystemDirectoryHandle,
  script: FoundScript,
): Promise<void> {
  try {
    const content = await readFileFromDirectory(handle, script.relativePath);
    const key = crypto.randomUUID();
    await chrome.storage.session.set({
      [sessionKeyFor(key)]: { name: script.relativePath, content },
    });
    window.open(viewerUrl(dirId, script.relativePath, key).toString(), '_blank');
  } catch (err) {
    console.error('VibeMonkey prefetch failed:', err);
    // Fall back to letting the viewer load it via the handle.
    window.open(viewerUrl(dirId, script.relativePath).toString(), '_blank');
  }
}

function sessionKeyFor(key: string): string {
  return `script:${key}`;
}

function makeMessage(className: string, text: string): HTMLElement {
  const p = document.createElement('p');
  p.className = className;
  p.textContent = text;
  return p;
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
