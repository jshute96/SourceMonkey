// Options page controller. Reads the persistent userscript store and
// renders one section per registered source (= directory). Each
// section has Refresh + Remove buttons and a script table showing
// filename, size, and parse status.
//
// "Add directory" submits an absolute filesystem path; the store
// scans the directory and loads every `*.user.js` into chrome.storage
// immediately, so the user doesn't need to click Refresh after add.

import {
  addSource,
  getSourceWithScripts,
  getSources,
  isScriptEnabled,
  isSourceEnabled,
  refreshSource,
  removeSource,
  setScriptEnabled,
  setSourceEnabled,
  type StoredScript,
  type StoredSource,
} from './script-store.js';

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
  void onAddDirectory(addInput.value);
});

void render();

async function onAddDirectory(rawPath: string): Promise<void> {
  const path = rawPath.trim();
  if (!path) return;
  await addSource(path);  // null = already added; we just no-op.
  addInput.value = '';
  await render();
}

async function onRemoveDirectory(id: string): Promise<void> {
  await removeSource(id);
  await render();
}

async function onRefreshDirectory(id: string): Promise<void> {
  await refreshSource(id);
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

  const sources = await getSources();
  if (sources.length === 0) {
    const p = document.createElement('p');
    p.className = 'placeholder';
    p.textContent = 'No directories yet. Add one above.';
    directoriesEl.appendChild(p);
    return;
  }

  for (const source of sources) {
    directoriesEl.appendChild(await renderSourceSection(source));
  }
}

async function renderSourceSection(source: StoredSource): Promise<HTMLElement> {
  const sourceOn = isSourceEnabled(source);

  const section = document.createElement('section');
  section.className = 'directory';
  if (!sourceOn) section.classList.add('disabled');

  const header = document.createElement('div');
  header.className = 'directory-header';

  const heading = document.createElement('h2');
  heading.textContent = source.path;
  header.appendChild(heading);

  const buttons = document.createElement('div');
  buttons.className = 'directory-buttons';

  const enableLabel = makeToggle(
    sourceOn,
    false,
    (next) => void onToggleSource(source.id, next),
    'Enable scripts under this directory',
  );
  buttons.appendChild(enableLabel);

  const refreshBtn = document.createElement('button');
  refreshBtn.textContent = 'Refresh';
  refreshBtn.addEventListener('click', () => {
    refreshBtn.disabled = true;
    refreshBtn.textContent = 'Refreshing…';
    void onRefreshDirectory(source.id);
  });
  buttons.appendChild(refreshBtn);

  const removeBtn = document.createElement('button');
  removeBtn.textContent = 'Remove';
  removeBtn.addEventListener('click', () => {
    void onRemoveDirectory(source.id);
  });
  buttons.appendChild(removeBtn);

  header.appendChild(buttons);
  section.appendChild(header);

  if (source.scanError) {
    section.appendChild(makeMessage('error', `Scan failed: ${source.scanError}`));
  }
  section.appendChild(await renderScriptTable(source, sourceOn));
  return section;
}

async function onToggleSource(id: string, enabled: boolean): Promise<void> {
  await setSourceEnabled(id, enabled);
  await render();
}

async function onToggleScript(id: string, enabled: boolean): Promise<void> {
  await setScriptEnabled(id, enabled);
  await render();
}

async function renderScriptTable(source: StoredSource, sourceOn: boolean): Promise<HTMLElement> {
  const data = await getSourceWithScripts(source.id);
  const scripts = data?.scripts ?? [];

  if (scripts.length === 0) {
    return makeMessage('empty', 'No *.user.js files found.');
  }

  const table = document.createElement('table');
  table.className = 'script-table';

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const label of ['', 'Filename', 'Size', 'Status']) {
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
  if (!sourceOn || !scriptOn) tr.classList.add('disabled');

  const toggleCell = document.createElement('td');
  toggleCell.className = 'toggle-cell';
  toggleCell.appendChild(makeToggle(
    scriptOn,
    !sourceOn,    // disabled (greyed out) when the parent source is off
    (next) => void onToggleScript(script.id, next),
    sourceOn ? 'Enable this script' : 'Source is disabled',
  ));
  tr.appendChild(toggleCell);

  const nameCell = document.createElement('td');
  const a = document.createElement('a');
  a.textContent = script.relativePath;
  a.href = viewerUrl(script.id).toString();
  a.target = '_blank';
  a.rel = 'noopener';
  nameCell.appendChild(a);
  tr.appendChild(nameCell);

  const sizeCell = document.createElement('td');
  sizeCell.className = 'size-cell';
  sizeCell.textContent = script.status === 'missing' || script.size == null
    ? 'MISSING'
    : formatBytes(script.size);
  tr.appendChild(sizeCell);

  const statusCell = document.createElement('td');
  statusCell.className = 'status-cell';
  const label = script.status === 'ok' ? 'OK' : 'ERROR';
  statusCell.textContent = label;
  statusCell.classList.add(`status-${script.status}`);
  if (script.errorMessage) statusCell.title = script.errorMessage;
  tr.appendChild(statusCell);

  return tr;
}

// A label-wrapped checkbox so the user has a generous click target.
// `disabled: true` greys it out without losing the underlying value.
function makeToggle(
  checked: boolean,
  disabled: boolean,
  onChange: (next: boolean) => void,
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
  cb.addEventListener('change', () => onChange(cb.checked));
  label.appendChild(cb);
  return label;
}

function viewerUrl(scriptId: string): URL {
  const url = new URL(chrome.runtime.getURL('userscript.html'));
  url.searchParams.set('script', scriptId);
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

// Format a byte count for the size column. Returns "1.2 KB", "950 B",
// etc. — short enough to fit comfortably alongside filename + status.
function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
