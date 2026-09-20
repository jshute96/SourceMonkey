// The compare page (`compare.html`): two copies of one script side by
// side — their header fields in one table, then a diff of each file
// they run, tab by tab.
//
// Reached from the versions panel's Compare column: a row's DIFF
// button opens it. One side is the copy that column compared against
// — the script on screen (`?script=<id>`), or the download an install
// preview is showing (`?preview=<location>`); `?other=<id>` is the row
// whose button was pressed. The diff reads left to right, old to new,
// and which side is which follows from that:
//   - from the viewer, the script on screen is the BASE and goes on
//     the left: the diff says what the other copy changed;
//   - from a preview, the download is the NEW copy and goes on the
//     right: the diff says what installing it would change.
// A swap button between the two sides' Collection and Location cells
// turns it around.
//
// What is compared is what runs: the script's own text and every
// `@require` it declares, which is the same set the Compare column's
// verdict was computed from (`contentFingerprint`, script-identity.ts).
// A preview side is fetched afresh here — the preview page holds its
// download in memory, and nothing is stored until Install — through the
// same pipeline that page uses, so the `@require`s it resolves are the
// ones an install would store.

import {
  buildScriptFromText,
  describeError,
  getCollection,
  getScript,
  localFileScope,
  type ScriptMatching,
  type StoredCollection,
} from './script-store.js';
import { attachFiles, type FileFetchCache, type StoredRequire } from './external-files.js';
import {
  canonicalCollectionInput,
  collectionCanonicalUrl,
  fetchSingleFileText,
  isSingleFileLocation,
  LOCATION_SHAPES,
  normalizeCollectionInput,
  scriptAbsolutePath,
} from './directories.js';
import {
  appendWithSlashBreaks,
  displayLocation,
  formatScriptSize,
  fullSource,
  previewUrl,
  requireBasename,
  scriptBasename,
  scriptLabel,
  viewerUrl,
} from './script-display.js';
import { collectionCell, declaredHomepage } from './script-details.js';
import { getValue, getValues, type ParsedHeader } from './userscript-header.js';
import {
  headingPrefixEl,
  HEADING_SEPARATOR,
  INSTALLED_HEADING,
  MISSING_LABEL,
  setPageTitle,
} from './page-heading.js';
import { installHomeLinkHandler } from './page-links.js';
import { installGithubAuthListener, loadGithubAuthToken } from './github-auth.js';
import { installLocalRootsListener, localRootsReady, localSearchRoots } from './local-file-overrides.js';
import { setGlyphButton } from './glyph.js';
import { HEADING_SITE_ICONS, renderSiteIconInto } from './site-icon.js';
import { installSelectAll } from './select-all.js';
import { countChanges, diffLines, splitLines, toHunks, type DiffOp } from './line-diff.js';

// ---------- What a side is ----------

// One copy of the script, in the terms this page shows it in. Built
// once per side; the swap reorders the pair rather than rebuilding
// either.
interface Side {
  // A stored copy, or the download a preview is showing.
  kind: 'installed' | 'preview';
  // What the heading and the page title call the script.
  label: string;
  collection: StoredCollection | null;
  // The location as it reads, and the page that shows this copy on
  // its own — the viewer, or the install preview.
  location: string;
  pageUrl: string;
  header: ParsedHeader | null;
  // What the heading's favicon slot is painted from: the sites the
  // script's `@match` set names, its URL (for a relative `@icon`), and
  // the local search roots a declared `@icon` may be overridden from.
  icons: { matching: ScriptMatching; fileUrl: string; localRoots: string[] };
  // The script's own text, as on disk.
  text: string;
  requires: readonly StoredRequire[];
  // As the Size row reads it: an em dash for a copy that never loaded.
  size: string;
}

// The heading's page name, between the product's and the script's.
const COMPARE_HEADING = `${INSTALLED_HEADING}Compare${HEADING_SEPARATOR}`;

const params = new URLSearchParams(location.search);
const baseScriptId = params.get('script');
const previewInput = params.get('preview');
const otherScriptId = params.get('other');

const headingEl = document.getElementById('heading')!;
const messageEl = document.getElementById('message')!;
const fieldsEl = document.getElementById('fields')!;
const viewRowEl = document.getElementById('view-row')!;
const tabsEl = document.getElementById('tabs')!;
const diffEl = document.getElementById('diff')!;

// The two sides as they are currently shown: `left` is diffed against
// `right`. Filled by `load`, swapped by the swap button.
let left: Side | null = null;
let right: Side | null = null;
// The copy the page was opened for, whichever side it is on now: the
// script on screen, or the preview's download. The script's own tab is
// named from it and the `@require` tabs follow its declaration order,
// so neither shifts on a swap. (The heading is the LEFT side's — see
// `renderHeading`.)
let base: Side | null = null;

// Which file's diff is on screen, by index into `filePairs()`. Kept
// across a swap or a view change, which repaint the same tabs.
let activeTab = 0;

// The two view choices, remembered per browser profile: someone who
// reads diffs side by side reads them all that way.
type View = 'unified' | 'split';
type Scope = 'changes' | 'whole';
const VIEW_KEY = 'compare.view';
const SCOPE_KEY = 'compare.scope';
let view: View = readSetting(VIEW_KEY, 'unified', ['unified', 'split']);
let scope: Scope = readSetting(SCOPE_KEY, 'changes', ['changes', 'whole']);

function readSetting<T extends string>(key: string, fallback: T, allowed: readonly T[]): T {
  try {
    const got = localStorage.getItem(key);
    return allowed.includes(got as T) ? (got as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeSetting(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage that refuses a write (a locked-down profile) costs only
    // the memory of the choice; the page itself is unaffected.
  }
}

installHomeLinkHandler();
// Ctrl/Cmd-A selects the diff on screen rather than the page: the one
// pane there is, or, side by side, the pane focus is in — the left one
// when it is nowhere in particular. The line numbers and signs are
// `user-select: none`, so what is copied is the lines.
installSelectAll(() => {
  const focused = document.activeElement?.closest('.diff-body .pane');
  const pane = focused ?? diffEl.querySelector('.diff-body .pane.left') ?? diffEl.querySelector('.diff-body');
  return pane?.querySelector('table') ?? null;
});
installLocalRootsListener();
installGithubAuthListener();
const githubTokenReady = loadGithubAuthToken();
void load();

async function load(): Promise<void> {
  if (!otherScriptId || (!baseScriptId && !previewInput)) {
    fail('This page needs two copies to compare: a script and another copy of it');
    return;
  }
  setMessage('Loading…');
  try {
    // The preview side reads local stand-ins for its `@require`s the
    // way the preview page does, and that needs the configured roots.
    await localRootsReady();
    const [loadedBase, other] = await Promise.all([
      baseScriptId ? loadInstalled(baseScriptId, 'The script') : loadPreview(previewInput!),
      loadInstalled(otherScriptId, 'The other copy'),
    ]);
    base = loadedBase;
    [left, right] = baseScriptId ? [loadedBase, other] : [other, loadedBase];
  } catch (err) {
    fail(describeError(err));
    return;
  }
  setMessage('');
  renderViewRow();
  renderAll();
}

// A stored copy. The collection row may be gone — a copy whose
// collection was removed while this page was opening — and the side
// still renders, with no Collection cell to show. `what` names the side
// in the failure, so the message says which copy went missing.
async function loadInstalled(id: string, what: string): Promise<Side> {
  const script = await getScript(id);
  if (!script) throw new Error(`${what} is no longer installed`);
  const collection = (await getCollection(script.collectionId)) ?? null;
  return {
    kind: 'installed',
    label: scriptLabel(script.header, script.relativePath),
    collection,
    location: displayLocation(
      collection ? scriptAbsolutePath(collection.path, script.relativePath) : script.relativePath,
    ),
    pageUrl: viewerUrl(script.id),
    header: script.header,
    icons: {
      matching: script.matching,
      fileUrl: script.fileUrl,
      // A missing collection row reads as ENABLED, as the viewer's
      // heading has it.
      localRoots: localSearchRoots(
        script.fileUrl, collection ? localFileScope(collection) : { enabled: true },
      ),
    },
    text: fullSource(script),
    requires: script.requires ?? [],
    size: formatScriptSize(script),
  };
}

// The download an install preview is showing, fetched again here: the
// preview holds it in memory only. The same normalization and the same
// `@require` resolution the preview runs, so what this side shows is
// what installing would store.
async function loadPreview(input: string): Promise<Side> {
  if (!isSingleFileLocation(input)) {
    throw new Error(`This is not a script location — it ${LOCATION_SHAPES}`);
  }
  await githubTokenReady;
  const previewLocation = canonicalCollectionInput(await normalizeCollectionInput(input));
  const fileUrl = collectionCanonicalUrl(previewLocation);
  const text = await fetchSingleFileText(fileUrl);
  const now = Date.now();
  const script = await buildScriptFromText({
    id: 'preview',
    collectionId: 'preview',
    relativePath: previewLocation,
    fileUrl,
    text,
    now,
  });
  // The preview page refuses to install this; a diff of a file that
  // cannot be installed would only be misread as one that can.
  if (script.status !== 'ok') {
    throw new Error(`The script being previewed cannot be compared: ${script.errorMessage ?? 'It is not a valid userscript'}`);
  }
  const fetchCache: FileFetchCache = new Map();
  const localRoots = localSearchRoots(fileUrl, { enabled: true });
  const files = await attachFiles({
    scriptFileUrl: fileUrl,
    header: script.header,
    priorRequires: new Map(),
    priorResources: new Map(),
    recheck: 'all',
    fetchCache,
    now,
    localRoots,
  });
  if (files.errorMessage) {
    throw new Error(`The script being previewed cannot be compared: ${files.errorMessage}`);
  }
  return {
    kind: 'preview',
    label: scriptLabel(script.header, previewLocation),
    collection: null,
    location: displayLocation(previewLocation),
    pageUrl: previewUrl(previewLocation),
    header: script.header,
    icons: { matching: script.matching, fileUrl, localRoots },
    text,
    requires: files.requires,
    size: formatScriptSize(script),
  };
}

function fail(message: string): void {
  setMessage(message, 'error');
  setPageTitle('Compare: ', MISSING_LABEL);
}

function setMessage(text: string, kind: '' | 'error' = ''): void {
  messageEl.textContent = text;
  messageEl.className = `message ${kind}`.trim();
}

// `SourceMonkey | Compare | <icons> <name>`, as the viewer's heading
// reads — the favicons and the name of the LEFT side, so a swap
// repaints it from the other copy. (The names are usually the same;
// the icons can differ, when one copy's `@match` or `@icon` does.)
function renderHeading(): void {
  const side = left!;
  headingEl.replaceChildren(headingPrefixEl(COMPARE_HEADING));
  const iconSlot = document.createElement('span');
  iconSlot.className = 'site-icon';
  headingEl.appendChild(iconSlot);
  appendWithSlashBreaks(headingEl, side.label);
  setPageTitle('Compare: ', side.label);
  void renderSiteIconInto(
    iconSlot,
    { matching: side.icons.matching, fileUrl: side.icons.fileUrl, header: side.header },
    side.icons.localRoots,
    HEADING_SITE_ICONS,
  );
}

// Everything that depends on which side is which.
function renderAll(): void {
  renderHeading();
  renderFields();
  renderTabs();
  renderDiff();
}

// ---------- The fields table ----------

// One row of the table: a label and the two sides' values. A value is
// its items — one for a single-valued tag, one per line for a list tag.
interface FieldValue {
  items: string[];
}

interface FieldRow {
  label: string;
  values: [FieldValue, FieldValue];
}

function renderFields(): void {
  const l = left!;
  const r = right!;
  const table = document.createElement('table');
  table.className = 'fields';
  table.appendChild(fieldsHead(l, r));
  const tbody = document.createElement('tbody');
  for (const row of fieldRows(l, r)) tbody.appendChild(fieldRow(row));
  table.appendChild(tbody);
  fieldsEl.replaceChildren(table);
}

// The two rows that say which copy is which — Collection and Location,
// labelled like the rows under them — with the swap button between
// the sides, spanning both.
function fieldsHead(l: Side, r: Side): HTMLTableSectionElement {
  const thead = document.createElement('thead');
  // Tinted like the rows below when the two differ, which for the
  // collection means two different collections, not two spellings.
  const collectionRow = document.createElement('tr');
  const sameCollection = l.collection !== null && r.collection !== null
    && l.collection.id === r.collection.id;
  collectionRow.className = `side-collection ${sameCollection ? 'same' : 'differs'}`;
  collectionRow.appendChild(label('Collection'));
  collectionRow.appendChild(sideCell(collectionValue(l), 'left'));
  const swapCell = document.createElement('td');
  swapCell.className = 'swap-col';
  swapCell.rowSpan = 2;
  const swapBtn = document.createElement('button');
  swapBtn.type = 'button';
  swapBtn.id = 'swap';
  setGlyphButton(swapBtn, 'sm-swap', 'Swap the two sides');
  swapBtn.addEventListener('click', () => {
    [left, right] = [right, left];
    renderAll();
  });
  swapCell.appendChild(swapBtn);
  collectionRow.appendChild(swapCell);
  collectionRow.appendChild(sideCell(collectionValue(r), 'right'));
  thead.appendChild(collectionRow);

  const locationRow = document.createElement('tr');
  locationRow.className = 'side-location ' + (l.location === r.location ? 'same' : 'differs');
  locationRow.appendChild(label('Location'));
  locationRow.appendChild(sideCell(locationValue(l), 'left'));
  locationRow.appendChild(sideCell(locationValue(r), 'right'));
  thead.appendChild(locationRow);
  return thead;
}

function label(text: string): HTMLTableCellElement {
  const th = document.createElement('th');
  th.textContent = text;
  return th;
}

function sideCell(content: Node, side: 'left' | 'right'): HTMLTableCellElement {
  const td = document.createElement('td');
  td.className = `value ${side}`;
  td.appendChild(content);
  return td;
}

// A side's collection: its type bubble and name, linked to its section
// on the collections page — or the reason there is none.
function collectionValue(side: Side): Node {
  if (side.collection) return collectionCell(side.collection);
  const span = document.createElement('span');
  span.className = side.kind === 'preview' ? 'side-preview' : 'none';
  span.textContent = side.kind === 'preview' ? 'Not installed' : 'Collection removed';
  return span;
}

// A side's location, linked to that copy's own page: the viewer, or
// the install preview.
function locationValue(side: Side): Node {
  const a = document.createElement('a');
  a.href = side.pageUrl;
  a.target = '_blank';
  a.rel = 'noopener';
  a.title = side.kind === 'preview' ? 'Open the install preview' : 'Open this copy in the viewer';
  appendWithSlashBreaks(a, side.location);
  return a;
}

// The rows, in the viewer's details-panel order. A row appears when
// either side has something for it; a tag neither declares gets none.
function fieldRows(l: Side, r: Side): FieldRow[] {
  const rows: FieldRow[] = [];
  const single = (label: string, read: (h: ParsedHeader) => string | undefined) => {
    const a = l.header ? read(l.header) : undefined;
    const b = r.header ? read(r.header) : undefined;
    if (a === undefined && b === undefined) return;
    rows.push({ label, values: [{ items: a ? [a] : [] }, { items: b ? [b] : [] }] });
  };
  const list = (label: string, tag: string) => {
    const a = l.header ? getValues(l.header, tag) : [];
    const b = r.header ? getValues(r.header, tag) : [];
    if (a.length === 0 && b.length === 0) return;
    rows.push({ label, values: [{ items: [...a] }, { items: [...b] }] });
  };
  single('Name', (h) => getValue(h, 'name'));
  single('Description', (h) => getValue(h, 'description'));
  single('Version', (h) => getValue(h, 'version'));
  single('Homepage', declaredHomepage);
  list('Match', 'match');
  list('Include', 'include');
  list('Exclude', 'exclude');
  list('Network access', 'connect');
  list('Require', 'require');
  list('Resource', 'resource');
  rows.push({
    label: 'Size',
    values: [{ items: [l.size] }, { items: [r.size] }],
  });
  return rows;
}

function fieldRow(row: FieldRow): HTMLTableRowElement {
  const tr = document.createElement('tr');
  const [a, b] = row.values;
  const differs = !sameItems(a.items, b.items);
  tr.className = differs ? 'differs' : 'same';
  tr.appendChild(label(row.label));
  tr.appendChild(valueCell(a, b, 'left'));
  const gap = document.createElement('td');
  gap.className = 'swap-col';
  tr.appendChild(gap);
  tr.appendChild(valueCell(b, a, 'right'));
  return tr;
}

function sameItems(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, i) => item === b[i]);
}

// A value cell. A list is one item per line, with the items the OTHER
// side lacks marked, so a Match row with one new pattern shows which
// one; a single value with no counterpart reads "none".
function valueCell(value: FieldValue, other: FieldValue, side: 'left' | 'right'): HTMLTableCellElement {
  const td = document.createElement('td');
  td.className = `value ${side}`;
  if (value.items.length === 0) {
    const none = document.createElement('span');
    none.className = 'none';
    none.textContent = 'none';
    td.appendChild(none);
  } else if (value.items.length === 1 && other.items.length <= 1) {
    td.textContent = value.items[0];
  } else {
    const ul = document.createElement('ul');
    for (const item of value.items) {
      const li = document.createElement('li');
      li.textContent = item;
      if (!other.items.includes(item)) li.className = 'only';
      ul.appendChild(li);
    }
    td.appendChild(ul);
  }
  return td;
}

// ---------- The files ----------

// One tab: a file as each side has it. The script itself is always
// both sides. A `@require` is paired with the other side's by the ref
// the header declares it with, and failing that by basename — a copy
// that moved its libraries from one host to another declares every
// one of them differently, and those are the pairs worth diffing. A
// basename either side declares twice pairs nothing: which `util.js`
// is which would be a guess, and a wrong pair reads as a real diff.
// A require that matches nothing is a tab with one side empty.
interface FilePair {
  label: string;
  leftText: string | null;
  rightText: string | null;
}

function filePairs(): FilePair[] {
  const b = base!;
  const other = b === left ? right! : left!;
  // A pair in base / other terms, turned into left / right below.
  const pair = (label: string, ofBase: string | null, ofOther: string | null): FilePair => ({
    label,
    leftText: b === left ? ofBase : ofOther,
    rightText: b === left ? ofOther : ofBase,
  });
  const pairs: FilePair[] = [pair(scriptBasename(b.location), b.text, other.text)];
  const name = (req: StoredRequire) => requireBasename(req.url, req.ref);
  const ambiguous = new Set([...repeatedNames(b.requires), ...repeatedNames(other.requires)]);
  // Base's requires first, in declaration order — the same tabs in the
  // same places after a swap — each taking the first unclaimed match on
  // the other side: by ref, then by basename.
  const unclaimed = [...other.requires];
  const claim = (pick: (req: StoredRequire) => boolean): StoredRequire | undefined => {
    const at = unclaimed.findIndex(pick);
    return at < 0 ? undefined : unclaimed.splice(at, 1)[0];
  };
  for (const req of b.requires) {
    const match = claim((o) => o.ref === req.ref)
      ?? (ambiguous.has(name(req)) ? undefined : claim((o) => name(o) === name(req)));
    pairs.push(pair(name(req), req.source, match?.source ?? null));
  }
  // Then whatever the other side declares that nothing above claimed.
  for (const req of unclaimed) pairs.push(pair(name(req), null, req.source));
  return pairs;
}

// The basenames declared more than once on one side.
function repeatedNames(requires: readonly StoredRequire[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const req of requires) {
    const n = requireBasename(req.url, req.ref);
    if (seen.has(n)) repeated.add(n);
    seen.add(n);
  }
  return [...repeated];
}

// The verdict a tab wears. ADDED and REMOVED read left to right, as
// the diff does: a file only the right side declares is added.
type Verdict = 'same' | 'different' | 'added' | 'removed';

// Same means the diff would show nothing: compared line by line, the
// way the diff reads the texts, so a copy that only gained or lost a
// final newline is not called different by the chip and then shown
// with no differences below it.
function verdict(pair: FilePair): Verdict {
  if (pair.leftText === null) return 'added';
  if (pair.rightText === null) return 'removed';
  return sameItems(splitLines(pair.leftText), splitLines(pair.rightText)) ? 'same' : 'different';
}

function renderTabs(): void {
  const pairs = filePairs();
  if (activeTab >= pairs.length) activeTab = 0;
  tabsEl.replaceChildren();
  pairs.forEach((pair, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tab' + (i === activeTab ? ' active' : '');
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', String(i === activeTab));
    btn.appendChild(document.createTextNode(pair.label));
    const v = verdict(pair);
    const chip = document.createElement('span');
    chip.className = `chip chip-${v}`;
    chip.textContent = v;
    btn.appendChild(chip);
    btn.addEventListener('click', () => {
      activeTab = i;
      renderTabs();
      renderDiff();
    });
    tabsEl.appendChild(btn);
  });
  tabsEl.hidden = false;
}

// ---------- The view controls ----------

function renderViewRow(): void {
  viewRowEl.replaceChildren(
    segmented<View>(
      [['unified', 'Unified'], ['split', 'Side by side']],
      () => view,
      (v) => { view = v; writeSetting(VIEW_KEY, v); },
    ),
    segmented<Scope>(
      [['changes', 'Changes only'], ['whole', 'Whole file']],
      () => scope,
      (v) => { scope = v; writeSetting(SCOPE_KEY, v); },
    ),
  );
}

// A segmented control: one button per choice, the current one pressed.
function segmented<T extends string>(
  choices: readonly (readonly [T, string])[],
  current: () => T,
  choose: (value: T) => void,
): HTMLElement {
  const seg = document.createElement('span');
  seg.className = 'seg';
  seg.setAttribute('role', 'group');
  for (const [value, label] of choices) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = label;
    btn.dataset.value = value;
    btn.setAttribute('aria-pressed', String(value === current()));
    btn.classList.toggle('on', value === current());
    btn.addEventListener('click', () => {
      choose(value);
      for (const b of seg.querySelectorAll('button')) {
        b.classList.toggle('on', b === btn);
        b.setAttribute('aria-pressed', String(b === btn));
      }
      renderDiff();
    });
    seg.appendChild(btn);
  }
  return seg;
}

// ---------- The diff ----------

function renderDiff(): void {
  const pair = filePairs()[activeTab];
  if (!pair) {
    diffEl.hidden = true;
    return;
  }
  const a = splitLines(pair.leftText ?? '');
  const b = splitLines(pair.rightText ?? '');
  const ops = diffLines(a, b);
  const counts = countChanges(ops);
  // The lines scroll inside the body, under a summary strip that stays
  // put — the box fills what is left of the window (compare.html), so
  // the scroll bars are at the window's edge rather than under a
  // page's worth of code.
  const body = document.createElement('div');
  body.className = 'diff-body';
  // A file both sides have in full and agree on is shown once, whatever
  // the view: two identical columns say nothing the one doesn't.
  const identical = counts.added === 0 && counts.removed === 0;
  if (view === 'split' && !identical) {
    body.classList.add('split');
    body.append(...splitPanes(ops));
  } else {
    // The one scroller, focusable like the viewer's code box (side by
    // side, the panes are the scrollers and the focus targets).
    body.tabIndex = 0;
    body.appendChild(unifiedTable(ops, identical));
  }
  diffEl.replaceChildren(summaryRow(counts), body);
  diffEl.hidden = false;
}

function summaryRow(counts: { removed: number; added: number }): HTMLElement {
  const row = document.createElement('div');
  row.className = 'diff-summary';
  if (counts.removed === 0 && counts.added === 0) {
    row.textContent = 'No differences';
    return row;
  }
  const span = document.createElement('span');
  const parts: Node[] = [];
  if (counts.removed > 0) {
    const del = document.createElement('span');
    del.className = 'removed';
    del.textContent = `−${counts.removed}`;
    parts.push(del);
  }
  if (counts.added > 0) {
    const add = document.createElement('span');
    add.className = 'added';
    add.textContent = `+${counts.added}`;
    parts.push(add);
  }
  parts.forEach((part, i) => {
    if (i > 0) span.appendChild(document.createTextNode(' '));
    span.appendChild(part);
  });
  span.appendChild(document.createTextNode(counts.removed + counts.added === 1 ? ' line' : ' lines'));
  row.appendChild(span);
  return row;
}

// Which ops to draw: every line, or the hunks with `@@` seams between
// them. `whole` is forced for an identical file, where hunks would be
// nothing at all.
function visibleOps(ops: readonly DiffOp[], whole: boolean): (DiffOp | { kind: 'hunk'; text: string })[] {
  if (whole || scope === 'whole') return [...ops];
  const out: (DiffOp | { kind: 'hunk'; text: string })[] = [];
  for (const hunk of toHunks(ops)) {
    out.push({
      kind: 'hunk',
      text: `@@ -${range(hunk.aStart, hunk.aCount)} +${range(hunk.bStart, hunk.bCount)} @@`,
    });
    out.push(...hunk.ops);
  }
  return out;
}

// A hunk header's range, as git prints it: the count is left off when
// it is one.
function range(start: number, count: number): string {
  return count === 1 ? String(start) : `${start},${count}`;
}

function unifiedTable(ops: readonly DiffOp[], whole: boolean): HTMLTableElement {
  const table = document.createElement('table');
  table.className = 'diff unified';
  for (const op of visibleOps(ops, whole)) {
    const tr = document.createElement('tr');
    if (op.kind === 'hunk') {
      tr.className = 'hunk';
      tr.appendChild(td('num', ''));
      tr.appendChild(td('sign', ''));
      tr.appendChild(td('code', op.text));
    } else {
      tr.className = op.kind === 'same' ? '' : op.kind;
      // The number from whichever side has the line; a shared line's
      // two numbers can differ, and the right side's is the base's.
      tr.appendChild(td('num', String(op.bLine ?? op.aLine ?? '')));
      tr.appendChild(td('sign', op.kind === 'del' ? '−' : op.kind === 'add' ? '+' : ' '));
      tr.appendChild(td('code', op.text));
    }
    table.appendChild(tr);
  }
  return table;
}

// Side by side: a pane per side, each scrolling sideways on its own so
// a long line in one never pushes the other off screen. The two hold
// the same rows — an unchanged line on both, a removed line beside the
// added line that replaced it (a run of removals zipped with the run of
// additions after it), a blank beside a line with no counterpart — so
// they line up, and their vertical scroll is kept in step.
function splitPanes(ops: readonly DiffOp[]): [HTMLElement, HTMLElement] {
  const leftTable = document.createElement('table');
  leftTable.className = 'diff';
  const rightTable = document.createElement('table');
  rightTable.className = 'diff';
  const rows = visibleOps(ops, false);
  let i = 0;
  while (i < rows.length) {
    const op = rows[i];
    if (op.kind === 'hunk') {
      leftTable.appendChild(paneRow(op, 'left'));
      rightTable.appendChild(paneRow(op, 'right'));
      i++;
      continue;
    }
    if (op.kind === 'same') {
      leftTable.appendChild(paneRow(op, 'left'));
      rightTable.appendChild(paneRow(op, 'right'));
      i++;
      continue;
    }
    const dels: DiffOp[] = [];
    const adds: DiffOp[] = [];
    for (let next = rows[i]; next && next.kind === 'del'; next = rows[++i]) dels.push(next);
    for (let next = rows[i]; next && next.kind === 'add'; next = rows[++i]) adds.push(next);
    const n = Math.max(dels.length, adds.length);
    for (let k = 0; k < n; k++) {
      leftTable.appendChild(paneRow(dels[k], 'left'));
      rightTable.appendChild(paneRow(adds[k], 'right'));
    }
  }
  const leftPane = pane(leftTable, 'left');
  const rightPane = pane(rightTable, 'right');
  linkScroll(leftPane, rightPane);
  return [leftPane, rightPane];
}

// Keep two panes' vertical scroll in step. The scroll one pane is
// given by the other is remembered and its own event for it ignored:
// otherwise that event would set the first pane in turn, and the two
// would fight whenever the second could not scroll quite as far — a
// drag of one scrollbar then bounces between the two positions.
//
// The record is one-shot — consumed by the event it was made for —
// or a later scroll of the user's own that happens to land on the
// same value (PageDown then PageUp) would be swallowed too and leave
// the panes out of step until the next scroll.
function linkScroll(a: HTMLElement, b: HTMLElement): void {
  const given = new Map<HTMLElement, number>();
  const follow = (from: HTMLElement, to: HTMLElement) => {
    if (given.get(from) === from.scrollTop) {
      given.delete(from);
      return;
    }
    // Already level: setting the same value fires no event, so a
    // record left here would swallow a real scroll later.
    if (to.scrollTop === from.scrollTop) return;
    to.scrollTop = from.scrollTop;
    // What `to` actually landed on, which is what its event will say.
    given.set(to, to.scrollTop);
  };
  a.addEventListener('scroll', () => follow(a, b));
  b.addEventListener('scroll', () => follow(b, a));
}

// Focusable, like the viewer's code box: a pane that can be stood in
// scrolls with the arrow keys, and is what Ctrl-A selects.
function pane(table: HTMLTableElement, side: 'left' | 'right'): HTMLElement {
  const el = document.createElement('div');
  el.className = `pane ${side}`;
  el.tabIndex = 0;
  el.appendChild(table);
  return el;
}

// One row of one pane. No op is the blank across from a line the other
// side has alone.
function paneRow(
  op: DiffOp | { kind: 'hunk'; text: string } | undefined,
  side: 'left' | 'right',
): HTMLTableRowElement {
  const tr = document.createElement('tr');
  if (!op) {
    tr.className = 'filler';
    tr.appendChild(td('num', ''));
    tr.appendChild(td('code', ''));
    return tr;
  }
  if (op.kind === 'hunk') {
    tr.className = 'hunk';
    tr.appendChild(td('num', ''));
    tr.appendChild(td('code', op.text));
    return tr;
  }
  tr.className = op.kind === 'same' ? '' : op.kind;
  tr.appendChild(td('num', String(side === 'left' ? op.aLine : op.bLine)));
  tr.appendChild(td('code', op.text));
  return tr;
}

function td(className: string, text: string): HTMLTableCellElement {
  const cell = document.createElement('td');
  cell.className = className;
  cell.textContent = text;
  return cell;
}
