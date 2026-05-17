// Options page controller. Renders the list of registered directory
// paths, scans each via file:// URL fetching (up to two subdir levels
// deep), and links each finding to the userscript.html viewer.
//
// All persistence is in chrome.storage.local — no FileSystemHandles,
// no IndexedDB. The cost is that the user must enable "Allow access
// to file URLs" on chrome://extensions once per install; the benefit
// is no per-session permission re-grant.

import {
  getDirectories,
  scanForUserScripts,
  setDirectories,
  scriptFileUrl,
  type DirectoryEntry,
  type FoundScript,
} from './directories.js';

const bannerSlot = document.getElementById('banner-slot')!;
const directoriesEl = document.getElementById('directories')!;
const addForm = document.getElementById('add-form') as HTMLFormElement;
const addInput = document.getElementById('add-path') as HTMLInputElement;
const versionEl = document.getElementById('version');

if (versionEl) {
  versionEl.textContent = `Version ${chrome.runtime.getManifest().version}`;
}

addForm.addEventListener('submit', (event) => {
  event.preventDefault();
  void addDirectory(addInput.value);
});

void render();

async function addDirectory(rawPath: string): Promise<void> {
  const path = rawPath.trim();
  if (!path) return;
  const dirs = await getDirectories();
  if (dirs.some((d) => d.path === path)) {
    addInput.value = '';
    return;
  }
  dirs.push({ id: crypto.randomUUID(), path });
  await setDirectories(dirs);
  addInput.value = '';
  await render();
}

async function removeDirectory(id: string): Promise<void> {
  const dirs = await getDirectories();
  await setDirectories(dirs.filter((d) => d.id !== id));
  await render();
}

async function render(): Promise<void> {
  bannerSlot.textContent = '';
  directoriesEl.textContent = '';

  // Surface the file:// access state up-front. Without the toggle on
  // chrome://extensions, every fetch we try will fail.
  if (!(await isFileSchemeAccessAllowed())) {
    bannerSlot.appendChild(renderFileAccessBanner());
  }

  const dirs = await getDirectories();
  if (dirs.length === 0) {
    const p = document.createElement('p');
    p.className = 'placeholder';
    p.textContent = 'No directories yet. Add one above.';
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
  heading.textContent = dir.path;
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
  let scripts;
  try {
    scripts = await scanForUserScripts(dir.path);
  } catch (err) {
    return makeMessage('error', `Scan failed: ${describeError(err)}`);
  }

  if (scripts.length === 0) {
    return makeMessage('empty', 'No *.user.js files found.');
  }

  const list = document.createElement('ul');
  for (const script of scripts) {
    list.appendChild(renderScriptLink(dir, script));
  }
  return list;
}

function renderScriptLink(dir: DirectoryEntry, script: FoundScript): HTMLElement {
  const li = document.createElement('li');
  const a = document.createElement('a');
  a.textContent = script.relativePath;
  a.href = viewerUrl(dir.path, script.relativePath).toString();
  a.target = '_blank';
  a.rel = 'noopener';
  li.appendChild(a);
  return li;
}

function viewerUrl(absoluteDir: string, relativePath: string): URL {
  const url = new URL(chrome.runtime.getURL('userscript.html'));
  url.searchParams.set('src', scriptFileUrl(absoluteDir, relativePath));
  url.searchParams.set('name', relativePath);
  return url;
}

function isFileSchemeAccessAllowed(): Promise<boolean> {
  return new Promise((resolve) => {
    chrome.extension.isAllowedFileSchemeAccess((allowed) => resolve(allowed));
  });
}

function renderFileAccessBanner(): HTMLElement {
  const div = document.createElement('div');
  div.className = 'banner';

  const heading = document.createElement('strong');
  heading.textContent = 'File access is disabled.';
  div.appendChild(heading);

  const explain = document.createElement('p');
  explain.textContent =
    'VibeMonkey can\'t read local directories until you enable ' +
    '"Allow access to file URLs". Open the extension\'s details page, ' +
    'turn it on, then reload this page:';
  div.appendChild(explain);

  const code = document.createElement('code');
  code.textContent = `chrome://extensions/?id=${chrome.runtime.id}`;
  div.appendChild(code);

  return div;
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
