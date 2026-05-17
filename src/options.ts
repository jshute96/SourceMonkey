// Options page controller. Renders the list of configured directories
// (each just an absolute filesystem path), scans each one for
// *.user.js files up to two subdir levels deep, and links them as
// file:// URLs.
//
// The directory store and scanner live in src/directories.ts; this
// file is just the DOM glue.

import {
  buildScriptUrl,
  getDirectories,
  scanForUserScripts,
  setDirectories,
  type DirectoryEntry,
} from './directories.js';

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
  const raw = window.prompt('Absolute path to a userscripts directory:');
  if (!raw) return;
  const path = raw.trim();
  if (!path) return;

  const dirs = await getDirectories();
  if (dirs.some((d) => d.path === path)) {
    await render();
    return;
  }
  dirs.push({ id: crypto.randomUUID(), path });
  await setDirectories(dirs);
  await render();
}

async function removeDirectory(id: string): Promise<void> {
  const dirs = await getDirectories();
  await setDirectories(dirs.filter((d) => d.id !== id));
  await render();
}

async function render(): Promise<void> {
  directoriesEl.textContent = '';

  // Surface the file:// access state up-front: scanning won't work
  // without "Allow access to file URLs" on, and there's no API to
  // request it — only the chrome://extensions toggle can grant it.
  if (!(await isFileSchemeAccessAllowed())) {
    directoriesEl.appendChild(renderFileAccessBanner());
  }

  const dirs = await getDirectories();

  if (dirs.length === 0) {
    const p = document.createElement('p');
    p.className = 'placeholder';
    p.textContent = 'No directories yet. Click "Add directory" to add one.';
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
    return makeMessage(
      'error',
      `Scan failed: ${describeError(err)}. ` +
        'Make sure "Allow access to file URLs" is enabled for VibeMonkey in chrome://extensions.',
    );
  }

  if (scripts.length === 0) {
    return makeMessage('empty', 'No *.user.js files found.');
  }

  const list = document.createElement('ul');
  for (const script of scripts) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = buildScriptUrl(dir.path, script.relativePath);
    a.textContent = script.relativePath;
    a.target = '_blank';
    a.rel = 'noopener';
    li.appendChild(a);
    list.appendChild(li);
  }
  return list;
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
    '"Allow access to file URLs". Open the extension\'s details page and ' +
    'toggle it on, then reload this page:';
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
