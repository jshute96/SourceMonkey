// The storage debug page (/debug/storage.html): where
// `chrome.storage.local` goes, by script, by stored file, or in GM
// values. Read-only. See docs/storage.md#storage-debug-page.

import { collectionAnchorId } from '../collection-display.js';
import { installHomeLinkHandler, namedPageUrl, wireNamedTabLink } from '../page-links.js';
import { timeStorageRead } from '../storage-scan.js';
import { describeError } from '../script-store.js';
import { appendWithSlashBreaks, viewerUrl } from '../../script-display.js';
import {
  buildStorageBreakdown,
  defaultSortDir,
  fileIdentity,
  sortFiles,
  sortScripts,
  sortValues,
  type FileEntry,
  type FileUse,
  type ItemKind,
  type ScriptRef,
  type SortDir,
  type SortKey,
  type StorageBreakdown,
} from '../storage-breakdown.js';

type View = 'script' | 'file' | 'values';

const summaryEl = document.getElementById('storage-summary') as HTMLParagraphElement;
const emptyEl = document.getElementById('storage-empty') as HTMLDivElement;
const tableEl = document.getElementById('storage-table') as HTMLTableElement;
const viewButtons = [...document.querySelectorAll<HTMLButtonElement>('.views button')];

installHomeLinkHandler();

// Each view keeps its own sort while the page is open.
const sorts: Record<View, { key: SortKey; dir: SortDir }> = {
  script: { key: 'size', dir: 'desc' },
  file: { key: 'size', dir: 'desc' },
  values: { key: 'size', dir: 'desc' },
};

let breakdown: StorageBreakdown | null = null;
let loadError = '';

// The view is the URL's fragment, so a reload keeps it.
function currentView(): View {
  const hash = location.hash.slice(1);
  return hash === 'file' || hash === 'values' ? hash : 'script';
}

for (const button of viewButtons) {
  button.addEventListener('click', () => {
    const view = button.dataset.view as View;
    history.replaceState(null, '', view === 'script' ? location.pathname : `#${view}`);
    render();
  });
}
addEventListener('hashchange', render);

// ---------- Formatting ----------

const numberFormat = new Intl.NumberFormat();

function plural(n: number, one: string, many = `${one}s`): string {
  return `${numberFormat.format(n)} ${n === 1 ? one : many}`;
}

// Whole KB, as on the Options page; a size too small to show as 1 KB
// still reads as something rather than 0.
function formatKb(bytes: number): string {
  const kb = Math.round(bytes / 1024);
  if (kb === 0 && bytes > 0) return '< 1 KB';
  return `${numberFormat.format(kb)} KB`;
}

const KIND_LABELS: Record<ItemKind, string> = {
  script: 'script',
  metadata: 'metadata',
  require: '@require',
  resource: '@resource',
  'smdev-text': 'sm-dev script text',
  'smdev-file': 'sm-dev pushed file',
};

// ---------- Cells ----------

function span(className: string, text: string): HTMLSpanElement {
  const el = document.createElement('span');
  el.className = className;
  el.textContent = text;
  return el;
}

function td(className?: string, ...children: Array<Node | string>): HTMLTableCellElement {
  const cell = document.createElement('td');
  if (className) cell.className = className;
  // Spaces between the parts, so a kind, a name and a location wrap
  // as words.
  children.forEach((child, i) => {
    if (i > 0) cell.append(' ');
    cell.append(child);
  });
  return cell;
}

// A name cell running down beside the group's item lines, so a long
// name wraps alongside them rather than pushing them down.
function spanGroup(cell: HTMLTableCellElement, items: number): HTMLTableCellElement {
  cell.rowSpan = 1 + items;
  return cell;
}

function sizeCell(bytes: number): HTMLTableCellElement {
  const cell = td('num', formatKb(bytes));
  cell.title = `${numberFormat.format(bytes)} bytes`;
  return cell;
}

// Blank for a file only one script uses.
function sharedCell(shared: number): HTMLTableCellElement {
  return td('num', shared > 1 ? numberFormat.format(shared) : '');
}

function collectionCell(ref: ScriptRef): HTMLTableCellElement {
  if (!ref.collectionId) return td(undefined, span('muted', 'No collection'));
  const a = document.createElement('a');
  // Break after slashes, as the collections page does: a name is often a path.
  appendWithSlashBreaks(a, ref.collectionName);
  const hash = collectionAnchorId(ref.collectionId);
  wireNamedTabLink(a, 'collections', hash);
  // Its page-relative href would resolve inside debug/, beside this page.
  a.href = chrome.runtime.getURL(namedPageUrl('collections', hash));
  return td(undefined, a);
}

function scriptCell(ref: ScriptRef): HTMLTableCellElement {
  const a = document.createElement('a');
  appendWithSlashBreaks(a, ref.scriptName);
  a.href = `../${viewerUrl(ref.scriptId)}`;
  a.target = '_blank';
  a.rel = 'noopener';
  return td(undefined, a);
}

// The parts naming an item: its kind, `@resource` name and location,
// whichever it has and the caller wants.
function itemParts(item: { kind?: ItemKind; name?: string; location?: string; missing?: boolean }): Node[] {
  const parts: Node[] = [];
  if (item.kind) parts.push(span('kind', KIND_LABELS[item.kind]));
  if (item.name) parts.push(span('loc', item.name));
  if (item.location) {
    const loc = span('loc', '');
    appendWithSlashBreaks(loc, item.location);
    parts.push(loc);
  }
  if (item.missing) parts.push(span('muted', MISSING));
  return parts;
}

// A file scripts point at that isn't in storage (see `missing` in
// storage-breakdown.ts).
const MISSING = '(missing from storage)';

function row(className: string, cells: HTMLTableCellElement[]): HTMLTableRowElement {
  const tr = document.createElement('tr');
  tr.className = className;
  tr.append(...cells);
  return tr;
}

function group(rows: HTMLTableRowElement[]): HTMLTableSectionElement {
  const tbody = document.createElement('tbody');
  tbody.className = 'group';
  tbody.append(...rows);
  return tbody;
}

// ---------- Tables ----------

interface Column {
  label: string;
  // Absent for a column that doesn't sort.
  sort?: SortKey;
  // `col` class, for its width.
  width?: string;
  num?: boolean;
}

function head(view: View, columns: Column[]): HTMLElement[] {
  const colgroup = document.createElement('colgroup');
  for (const c of columns) {
    const col = document.createElement('col');
    if (c.width) col.className = c.width;
    colgroup.append(col);
  }
  const thead = document.createElement('thead');
  const tr = document.createElement('tr');
  const sort = sorts[view];
  for (const c of columns) {
    const th = document.createElement('th');
    th.textContent = c.label;
    const classes = [c.num ? 'num' : '', c.sort ? 'sortable' : ''].filter(Boolean);
    if (classes.length) th.className = classes.join(' ');
    if (c.sort) {
      const key = c.sort;
      th.dataset.sort = key;
      if (sort.key === key) {
        th.append(span('sort-arrow', sort.dir === 'desc' ? '▼' : '▲'));
        th.setAttribute('aria-sort', sort.dir === 'desc' ? 'descending' : 'ascending');
      }
      th.addEventListener('click', () => {
        sorts[view] = sort.key === key
          ? { key, dir: sort.dir === 'desc' ? 'asc' : 'desc' }
          : { key, dir: defaultSortDir(key) };
        render();
      });
    }
    tr.append(th);
  }
  thead.append(tr);
  return [colgroup, thead];
}

function scriptTable(b: StorageBreakdown): HTMLElement[] {
  const { key, dir } = sorts.script;
  return [
    ...head('script', [
      { label: 'Collection', sort: 'collection', width: 'col-collection' },
      { label: 'Script', sort: 'script', width: 'col-name' },
      { label: 'File' },
      { label: 'Size', sort: 'size', width: 'col-size', num: true },
      { label: 'Shared copies', sort: 'shared', width: 'col-shared', num: true },
    ]),
    ...sortScripts(b.scripts, key, dir).map((s) => group([
      row('group-head', [
        spanGroup(collectionCell(s), s.items.length), spanGroup(scriptCell(s), s.items.length),
        td('total-label', 'Total'), sizeCell(s.bytes), td(),
      ]),
      ...s.items.map((item) => row('group-item', [
        td('item', ...itemParts(item)), sizeCell(item.bytes), sharedCell(item.shared),
      ])),
    ])),
  ];
}

function fileGroup(file: FileEntry): HTMLTableSectionElement {
  const id = fileIdentity(file);
  // The heading names what every use agrees on; each use's line names
  // the rest.
  const heading = id.kind === null
    ? [span('muted', 'Multiple locations')]
    : [
      ...itemParts({
        kind: id.kind,
        name: id.sameName ? id.name : undefined,
        location: id.sameLocation ? id.location : undefined,
      }),
      ...(id.sameLocation ? [] : [span('muted', 'multiple locations')]),
    ];
  if (file.missing) heading.push(span('muted', MISSING));
  const own = (use: FileUse) => id.kind === null ? itemParts(use) : itemParts({
    name: id.sameName ? undefined : use.name,
    location: id.sameLocation ? undefined : use.location,
  });
  const useCells = (use: FileUse) => [collectionCell(use), scriptCell(use)].map((cell) => {
    cell.classList.add('use');
    return cell;
  });
  // When the heading says it all, the first use goes on the heading's
  // line rather than leaving a gap above the uses, and the heading runs
  // down beside the rest, so a long one wraps without pushing them down.
  const [first, ...rest] = file.uses;
  const lead = first && file.uses.every((use) => own(use).length === 0) ? first : undefined;
  if (lead) {
    return group([
      row('group-head', [
        spanGroup(td(undefined, ...heading), rest.length), ...useCells(lead),
        sizeCell(file.bytes), sharedCell(file.uses.length),
      ]),
      ...rest.map((use) => row('group-item', [...useCells(use), td(), td()])),
    ]);
  }
  return group([
    row('group-head', [td(undefined, ...heading), td(), td(), sizeCell(file.bytes), sharedCell(file.uses.length)]),
    ...file.uses.map((use) => row('group-item', [
      td('item', ...own(use)), ...useCells(use), td(), td(),
    ])),
  ]);
}

function fileTable(b: StorageBreakdown): HTMLElement[] {
  const { key, dir } = sorts.file;
  const parts: HTMLElement[] = [
    ...head('file', [
      { label: 'File' },
      { label: 'Collection', width: 'col-collection' },
      { label: 'Script', width: 'col-name' },
      { label: 'Size', sort: 'size', width: 'col-size', num: true },
      { label: 'Shared copies', sort: 'shared', width: 'col-shared', num: true },
    ]),
    // Only those two headings sort here.
    ...sortFiles(b.files, key === 'shared' ? 'shared' : 'size', dir).map(fileGroup),
  ];
  // Always last: it belongs to no collection or script to sort by.
  if (b.unused.length > 0) {
    const unused = [...b.unused].sort((x, y) => y.bytes - x.bytes);
    parts.push(group([
      row('group-head', [
        td(undefined, span('muted', 'Not used by any script')), td(), td(),
        sizeCell(unused.reduce((sum, f) => sum + f.bytes, 0)), td(),
      ]),
      ...unused.map((f) => row('group-item', [
        td('item', span('loc', f.key)), td(), td(), sizeCell(f.bytes), td(),
      ])),
    ]));
  }
  return parts;
}

function valuesTable(b: StorageBreakdown): HTMLElement[] {
  const { key, dir } = sorts.values;
  return [
    ...head('values', [
      { label: 'Collection', sort: 'collection', width: 'col-values-name' },
      { label: 'Script', sort: 'script' },
      { label: 'Size', sort: 'size', width: 'col-size', num: true },
      { label: 'Values', sort: 'count', width: 'col-count', num: true },
    ]),
    ...sortValues(b.values, key, dir).map((v) => group([
      row('group-head', v.script
        ? [collectionCell(v.script), scriptCell(v.script), sizeCell(v.bytes), td('num', numberFormat.format(v.count))]
        : [
          td(undefined, span('muted', 'Removed script')), td(undefined, span('loc', v.scriptId)),
          sizeCell(v.bytes), td('num', numberFormat.format(v.count)),
        ]),
    ])),
  ];
}

// ---------- Render ----------

function summary(view: View, b: StorageBreakdown): string {
  if (view === 'script') {
    // Scripts whose collection row is missing ('') aren't one more.
    const collections = new Set(b.scripts.map((s) => s.collectionId).filter(Boolean)).size;
    return `${plural(b.scripts.length, 'script')} in ${plural(collections, 'collection')}. `
      + 'Shared files are counted once in each script that references them.';
  }
  if (view === 'file') {
    // A missing file isn't stored.
    const all = [...b.files.filter((f) => !f.missing), ...b.unused];
    const bytes = all.reduce((sum, f) => sum + f.bytes, 0);
    return `${plural(all.length, 'stored file')}, ${formatKb(bytes)}. Each shared file counts once.`;
  }
  const count = b.values.reduce((sum, v) => sum + v.count, 0);
  const bytes = b.values.reduce((sum, v) => sum + v.bytes, 0);
  return `${plural(count, 'value')} in ${plural(b.values.length, 'script')}, ${formatKb(bytes)}.`;
}

const EMPTY: Record<View, string> = {
  script: 'No scripts in storage.',
  file: 'No stored files.',
  values: 'No scripts have stored values.',
};

function render(): void {
  const view = currentView();
  for (const button of viewButtons) button.setAttribute('aria-pressed', String(button.dataset.view === view));
  if (!breakdown) {
    summaryEl.textContent = loadError;
    emptyEl.hidden = true;
    tableEl.hidden = true;
    return;
  }
  const b = breakdown;
  const isEmpty = view === 'script' ? b.scripts.length === 0
    : view === 'file' ? b.files.length + b.unused.length === 0
      : b.values.length === 0;
  summaryEl.textContent = isEmpty ? '' : summary(view, b);
  emptyEl.textContent = EMPTY[view];
  emptyEl.hidden = !isEmpty;
  tableEl.hidden = isEmpty;
  tableEl.replaceChildren(...(isEmpty ? [] : view === 'script' ? scriptTable(b) : view === 'file' ? fileTable(b) : valuesTable(b)));
}

// Each load reads every row, so a burst of writes (a refresh, a script
// spamming GM_setValue) is coalesced into one reload a second at most.
// Loads can overlap; only the newest one may draw.
let latest = 0;
let pending = false;

async function load(): Promise<void> {
  pending = false;
  const mine = ++latest;
  try {
    const rows = await timeStorageRead('storage debug page', () => chrome.storage.local.get(null));
    if (mine !== latest) return;
    breakdown = buildStorageBreakdown(rows);
  } catch (err) {
    if (mine !== latest) return;
    breakdown = null;
    loadError = `Could not read storage: ${describeError(err)}`;
  }
  render();
}

chrome.storage.onChanged.addListener((_changes, areaName) => {
  if (areaName !== 'local' || pending) return;
  pending = true;
  setTimeout(() => void load(), 1000);
});
render();
void load();
