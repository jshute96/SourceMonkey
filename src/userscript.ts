// Userscript viewer. Loaded as chrome-extension://…/userscript.html
// with a single query param `script=<scriptId>`. Hydrates from the
// persistent store (chrome.storage.local) rather than re-reading the
// file, so the content always matches what the options page shows.
//
// Layout: a thin controls row (Enable toggle + Refresh) on top, then
// a details panel (parsed-header fields + Location / Size / Status),
// then the highlighted code box.

import {
  getAllScripts,
  getScript,
  getSource,
  isScriptEnabled,
  isSourceEnabled,
  setScriptEnabled,
  type StoredScript,
} from './script-store.js';
import { basenameOf, computeLogIds } from './script-log-id.js';
import type { StoredRequire } from './requires.js';
import {
  clearScriptLog,
  getScriptLog,
  type LogEntry,
} from './script-log.js';
import { updateScript } from './script-updater.js';
import {
  formatScriptSize,
  formatScriptStatusLabel,
} from './script-display.js';
import {
  getValue,
  getValues,
} from './userscript-header.js';
import { scriptAbsolutePath } from './directories.js';
import { matchTargetInfo } from './match-targets.js';
import { renderSiteIconInto } from './site-icon.js';
import { resolveScriptResource } from './file-loader.js';
import {
  MATCH_HEADER_TAGS,
  RESOLVABLE_HEADER_TAGS,
  connectLinkUrl,
  isHeaderCloseLine,
  isHeaderOpenLine,
  parseTagLine,
  splitResourceValue,
  splitTextByUrls,
} from './script-links.js';

declare const Prism: { highlightElement(el: Element): void };

const params = new URLSearchParams(location.search);
const scriptId = params.get('script');

const filenameEl = document.getElementById('filename')!;
const controlsRowEl = document.getElementById('meta-row')!;
const enableLabelEl = document.getElementById('enable-label') as HTMLLabelElement;
const enableCheckboxEl = document.getElementById('enable-checkbox') as HTMLInputElement;
const refreshBtn = document.getElementById('refresh-btn') as HTMLButtonElement;
const messageEl = document.getElementById('message')!;
const summaryEl = document.getElementById('header-summary')!;
const tabsEl = document.getElementById('tabs')!;
const contentEl = document.getElementById('content')!;
const codePaneEl = document.getElementById('code-pane') as HTMLElement;
const logPaneEl = document.getElementById('log-pane') as HTMLElement;

refreshBtn.addEventListener('click', () => void onRefresh());
enableCheckboxEl.addEventListener('change', () => void onToggleEnabled(enableCheckboxEl.checked));

// Static markup for the Lucide-style copy / check icons. Safe to embed
// via innerHTML because there's no interpolation; the strings ship as
// part of the extension bundle.
const COPY_ICON_SVG =
  '<svg class="copy-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
  ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>' +
  '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>' +
  '</svg>';
const CHECK_ICON_SVG =
  '<svg class="check-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
  ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<polyline points="20 6 9 17 4 12"/>' +
  '</svg>';

// One shared copy button: created once, appendChild'd into the dl on
// each render() (appendChild moves it, so no duplication). Keeping it
// shared means we don't have to re-wire the click handler.
const filenameCopyBtn = (() => {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'copy-btn';
  btn.title = 'Copy location to clipboard';
  btn.setAttribute('aria-label', 'Copy location to clipboard');
  btn.innerHTML = COPY_ICON_SVG + CHECK_ICON_SVG;
  btn.addEventListener('click', () => void onCopyFilename());
  return btn;
})();

void load();

// Keep the displayed Log ID in sync with the global dupe set: if
// another tab (options page, viewer of a sibling) adds or removes a
// script that shares this basename, our `#N` would otherwise go
// stale. Listen for any script:* mutation and re-derive.
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local') {
    let touched = false;
    for (const key of Object.keys(changes)) {
      if (key.startsWith('script:')) { touched = true; break; }
    }
    if (touched) void rehydrateAfterStorageChange();
    return;
  }
  if (areaName === 'session' && scriptId) {
    // Repaint the log pane only when THIS script's log changed and the
    // user is currently looking at it — the pane is hidden behind a
    // code tab the rest of the time, so we'd just be doing work the
    // user can't see.
    const logKey = `log:${scriptId}`;
    if (!(logKey in changes)) return;
    if (logPaneEl.hidden) return;
    const newValue = changes[logKey].newValue;
    const entries = Array.isArray(newValue) ? (newValue as LogEntry[]) : [];
    // Bump the paint epoch so an in-flight renderLogPane() read from
    // before this event can't overwrite us with its (now stale) array.
    logPaintEpoch++;
    paintLog(entries);
  }
});

async function rehydrateAfterStorageChange(): Promise<void> {
  if (!scriptId) return;
  // If THIS script was removed, drop into the not-found state.
  const script = await getScript(scriptId);
  if (!script) {
    showMissing('Script not found in storage. Open it from the options page.');
    return;
  }
  await refreshLogId();
  render(script);
}

// Source-enabled state is needed for greying the toggle. We cache it so
// onToggle doesn't have to re-read storage. sourcePath is cached for
// the same reason — render() builds the absolute filename from it.
let sourceEnabled = true;
let sourcePath = '';
let copyResetTimer: ReturnType<typeof setTimeout> | null = null;
// Path currently shown in the Filename cell. onCopyFilename copies
// this rather than reading textContent, which would also break if the
// dl ever wraps the path across multiple text nodes.
let currentFilenamePath = '';
// This script's log ID. Computed at load(), re-derived after refresh,
// and kept fresh while the viewer is open by listening to
// chrome.storage.onChanged for any script:* mutation (another tab
// adding/removing a sibling with the same basename would otherwise
// leave a stale `#N` on screen).
let currentLogId = '';

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
  const source = await getSource(script.sourceId);
  sourceEnabled = source ? isSourceEnabled(source) : true;
  sourcePath = source?.path ?? '';
  await refreshLogId();
  render(script);
}

async function refreshLogId(): Promise<void> {
  if (!scriptId) return;
  const all = await getAllScripts();
  const map = computeLogIds(all);
  currentLogId = map.get(scriptId) ?? '';
}

async function onRefresh(): Promise<void> {
  if (!scriptId) return;
  refreshBtn.disabled = true;
  const prior = refreshBtn.textContent;
  refreshBtn.textContent = 'Refreshing…';
  try {
    // Routed through the shared updater: if a background opportunistic
    // check is already in flight for this script, we wait for it
    // instead of starting a second fetch.
    const next = await updateScript(scriptId, 'manual');
    if (next) {
      await refreshLogId();
      render(next);
    }
  } finally {
    refreshBtn.disabled = false;
    refreshBtn.textContent = prior ?? 'Refresh';
  }
}

async function onToggleEnabled(enabled: boolean): Promise<void> {
  if (!scriptId) return;
  const next = await setScriptEnabled(scriptId, enabled);
  if (next) render(next);
}

async function onCopyFilename(): Promise<void> {
  if (!currentFilenamePath) return;
  try {
    await navigator.clipboard.writeText(currentFilenamePath);
    // .copied swaps the visible icon to a checkmark via CSS. A fresh
    // timer per click keeps rapid double-clicks from leaving the
    // checkmark stuck — each new click cancels the prior reset and
    // schedules its own.
    filenameCopyBtn.classList.add('copied');
    if (copyResetTimer !== null) clearTimeout(copyResetTimer);
    copyResetTimer = setTimeout(() => {
      filenameCopyBtn.classList.remove('copied');
      copyResetTimer = null;
    }, 1200);
  } catch {
    // Clipboard write can be rejected (e.g. permission denied); the
    // path is selectable on the page, so no fallback UI is needed.
  }
}

function render(script: StoredScript): void {
  controlsRowEl.hidden = false;
  renderFilenameHeading(script);
  document.title = `${script.relativePath} — SourceMonkey`;

  enableCheckboxEl.checked = isScriptEnabled(script);
  enableCheckboxEl.disabled = !sourceEnabled;
  enableLabelEl.classList.toggle('toggle-disabled', !sourceEnabled);
  enableLabelEl.title = sourceEnabled
    ? 'Enable this script'
    : 'Source is disabled';

  messageEl.textContent = script.errorMessage ?? '';
  messageEl.className = script.errorMessage ? 'message error' : 'message';

  renderDetails(script);
  renderTabsAndBody(script);
}

// Tab strip entries. Code tabs paint into the code-pane (main script
// first, then one per @require in declaration order); the trailing
// Log tab swaps the code pane for the log table. `fileUrl` is the
// tab body's canonical fetchable URL — main-script tabs use
// `script.fileUrl`; require tabs use the require's resolved URL so
// any relative ref inside the require resolves against the require,
// not the host script (uncommon — require sources rarely have their
// own metadata block — but cheap to get right).
type Tab =
  | { kind: 'code'; label: string; body: string; fileUrl: string }
  | { kind: 'log'; label: string };

// Index of the currently selected tab. Preserved across re-renders
// when the new tab list still has an entry at that index; otherwise
// falls back to 0 (the main script).
let currentTabIndex = 0;

function buildTabs(script: StoredScript): Tab[] {
  const tabs: Tab[] = [{
    kind: 'code',
    label: basenameOf(script.relativePath),
    body: script.headerText
      ? script.headerText + '\n' + script.bodyText
      : script.bodyText,
    fileUrl: script.fileUrl,
  }];
  for (const r of script.requires ?? []) {
    tabs.push({
      kind: 'code',
      label: requireBasename(r),
      body: r.source,
      fileUrl: r.url,
    });
  }
  // Log tab always last so the file order stays stable as @requires
  // come and go.
  tabs.push({ kind: 'log', label: 'Log' });
  return tabs;
}

// Pull a display basename off a require's resolved URL. Falls back to
// the verbatim ref if URL parsing fails — won't happen for entries we
// stored (the resolver wouldn't have accepted the URL otherwise), but
// the fallback keeps a future shape change from breaking the tab UI.
// decodeURIComponent throws URIError on malformed `%` sequences, so it
// gets its own try/catch with a raw-name fallback rather than wrapping
// it inside the URL-parse try (where a decode failure would leak the
// entire basename for the ref-fallback path).
function requireBasename(r: StoredRequire): string {
  let name: string;
  try {
    const path = new URL(r.url).pathname;
    const slash = path.lastIndexOf('/');
    name = slash < 0 ? path : path.slice(slash + 1);
  } catch {
    return r.ref;
  }
  if (!name) return r.ref;
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

function renderTabsAndBody(script: StoredScript): void {
  const tabs = buildTabs(script);
  if (currentTabIndex >= tabs.length) currentTabIndex = 0;

  tabsEl.replaceChildren();
  // Always render the strip — even a single main-script tab gives the
  // page a consistent shape and tells the user the viewer is tabbed.
  tabsEl.hidden = false;

  tabs.forEach((tab, idx) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tab' + (idx === currentTabIndex ? ' active' : '');
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', idx === currentTabIndex ? 'true' : 'false');
    btn.textContent = tab.label;
    btn.addEventListener('click', () => {
      if (currentTabIndex === idx) return;
      currentTabIndex = idx;
      renderTabsAndBody(script);
    });
    tabsEl.appendChild(btn);
  });

  const active = tabs[currentTabIndex];
  if (active.kind === 'log') {
    codePaneEl.hidden = true;
    logPaneEl.hidden = false;
    void renderLogPane();
  } else {
    logPaneEl.hidden = true;
    codePaneEl.hidden = false;
    // textContent escapes; Prism then walks the node and replaces text
    // with highlighted spans. Doing it this way (rather than innerHTML)
    // keeps untrusted file content from being interpreted as markup.
    contentEl.textContent = active.body;
    Prism.highlightElement(contentEl);
    linkifyCodeBlock(contentEl, active.fileUrl);
  }
}

// Bumped on every paint request (tab-switch initial paint AND storage-
// change repaint). renderLogPane awaits a storage.get; a sm:* event
// landing during that await would call paintLog with the new array, and
// the older read would then resolve and overwrite with the stale array.
// Each paint path captures its epoch and bails if a fresher paint
// already ran.
let logPaintEpoch = 0;

async function renderLogPane(): Promise<void> {
  if (!scriptId) return;
  const epoch = ++logPaintEpoch;
  const entries = await getScriptLog(scriptId);
  if (epoch !== logPaintEpoch) return;
  paintLog(entries);
}

function paintLog(entries: LogEntry[]): void {
  logPaneEl.replaceChildren();

  // Toolbar with Clear button. Sticky so the action stays visible as
  // the user scrolls through a long log.
  const toolbar = document.createElement('div');
  toolbar.className = 'log-toolbar';
  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.textContent = 'Clear log';
  clearBtn.addEventListener('click', () => void onClearLog());
  toolbar.appendChild(clearBtn);
  logPaneEl.appendChild(toolbar);

  if (entries.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'log-empty';
    empty.textContent = 'No log entries yet. Refresh the script or trigger an event to populate this view.';
    logPaneEl.appendChild(empty);
    return;
  }

  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const trHead = document.createElement('tr');
  for (const h of ['Time', 'Level', 'Source', 'Message']) {
    const th = document.createElement('th');
    th.textContent = h;
    trHead.appendChild(th);
  }
  thead.appendChild(trHead);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  // Newest first so recent events are visible without scrolling.
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    const tr = document.createElement('tr');

    const tdTs = document.createElement('td');
    tdTs.className = 'log-ts';
    tdTs.textContent = formatLogTimestamp(e.timestamp);
    tr.appendChild(tdTs);

    const tdLevel = document.createElement('td');
    tdLevel.className = 'log-level';
    const badge = document.createElement('span');
    badge.className = `log-level-badge log-level-${e.level}`;
    badge.textContent = e.level;
    tdLevel.appendChild(badge);
    tr.appendChild(tdLevel);

    const tdSource = document.createElement('td');
    tdSource.className = 'log-source';
    tdSource.textContent = e.tabId !== undefined
      ? `tab ${e.tabId} · ${e.source}`
      : e.source;
    tr.appendChild(tdSource);

    const tdMsg = document.createElement('td');
    tdMsg.className = 'log-msg';
    tdMsg.textContent = e.message;
    tr.appendChild(tdMsg);

    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  logPaneEl.appendChild(table);
}

async function onClearLog(): Promise<void> {
  if (!scriptId) return;
  await clearScriptLog(scriptId);
  // Paint the empty state immediately for snappy click feedback; the
  // storage.onChanged listener will fire shortly with the same empty
  // state, so the second paint is a visual no-op. Bump the epoch so
  // any in-flight renderLogPane() read can't undo this.
  logPaintEpoch++;
  paintLog([]);
}

function formatLogTimestamp(ms: number): string {
  const d = new Date(ms);
  const yyyy = String(d.getFullYear());
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const mmm = String(d.getMilliseconds()).padStart(3, '0');
  return `${yyyy}-${mo}-${dd} ${hh}:${mm}:${ss}.${mmm}`;
}

// Replace the H1 with a favicon slot followed by the relative path.
// renderSiteIconInto paints a clickable globe placeholder
// synchronously (when the script targets a usable origin) and swaps
// it for the real favicon once the fetch resolves.
function renderFilenameHeading(script: StoredScript): void {
  filenameEl.replaceChildren();
  const iconSlot = document.createElement('span');
  iconSlot.className = 'site-icon';
  filenameEl.appendChild(iconSlot);
  filenameEl.appendChild(document.createTextNode(script.relativePath));
  renderSiteIconInto(iconSlot, script);
}

function renderDetails(script: StoredScript): void {
  summaryEl.replaceChildren();

  const dl = document.createElement('dl');

  if (script.header) {
    const name = getValue(script.header, 'name');
    if (name) appendRow(dl, 'Name', textNode(name));
    const description = getValue(script.header, 'description');
    if (description) appendRow(dl, 'Description', textNode(description));
  }
  // Log ID always renders — it's how the user maps an entry in the SW
  // console back to this script. Sits right under the header fields
  // so it's visible without scrolling.
  if (currentLogId) {
    appendRow(dl, 'Log ID', logIdCell(currentLogId));
  }
  if (script.header) {
    const matches = getValues(script.header, 'match');
    if (matches.length) appendRow(dl, 'Match', patternList(matches));
    const excludes = getValues(script.header, 'exclude');
    if (excludes.length) appendRow(dl, 'Exclude', patternList(excludes));
  }

  // Resolved location for the script: an absolute filesystem path for
  // file:// sources, or the fully-resolved URL for HTTP sources. Skip
  // the row entirely if the source row is gone — a bare relative path
  // under a "Location" label would be misleading.
  if (sourcePath) {
    currentFilenamePath = scriptAbsolutePath(sourcePath, script.relativePath);
    // Anchor target: the canonical fetchable URL (http(s) or file://).
    // Display text stays the human form (bare fs path for file://).
    appendRow(dl, 'Location', filenameCell(currentFilenamePath, script.fileUrl));
  } else {
    currentFilenamePath = '';
  }

  appendRow(dl, 'Size', textNode(formatScriptSize(script)));

  const status = document.createElement('span');
  status.textContent = formatScriptStatusLabel(script.status);
  status.className = `meta-status status-${script.status}`;
  if (script.errorMessage) status.title = script.errorMessage;
  appendRow(dl, 'Status', status);

  summaryEl.appendChild(dl);
}

function logIdCell(logId: string): Node {
  const span = document.createElement('span');
  span.className = 'log-id-cell';
  span.textContent = logId;
  return span;
}

function filenameCell(path: string, hrefUrl: string): Node {
  const cell = document.createElement('span');
  cell.className = 'filename-cell';

  // Wrap the path in an anchor so it doubles as an open-in-new-tab
  // link. http(s) URLs navigate normally; file:// links are accepted
  // by the anchor but Chromium typically refuses to navigate to them
  // from a chrome-extension page — the path is still readable, still
  // selectable, and the Copy button beside it is the reliable
  // "send this to another app" affordance.
  const pathEl = document.createElement('a') as HTMLAnchorElement;
  pathEl.className = 'filename-text';
  pathEl.href = hrefUrl;
  pathEl.target = '_blank';
  pathEl.rel = 'noopener noreferrer';
  // Display text is the bare fs path for file:// scripts; tooltip
  // surfaces the actual href so the user can see what would open
  // (file://... vs http://...) without clicking through.
  pathEl.title = hrefUrl;
  pathEl.textContent = path;
  cell.appendChild(pathEl);

  // Reuses the module-level button; appendChild moves it into the
  // new cell. Any in-flight "Copied" flash carries across because the
  // class lives on the button (not the cell) and the timer is still
  // valid — the checkmark continues for the rest of its 1.2s window.
  cell.appendChild(filenameCopyBtn);

  return cell;
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

// `@match` / `@exclude` / `@include` row renderer: each pattern that
// resolves to a usable linkUrl via the same wildcard-trim rule as the
// site favicon becomes a clickable open-in-new-tab anchor. Patterns
// we can't linkify (host wildcard, `<all_urls>`, regex literals,
// file://) render as plain text so the row still shows every entry.
function patternList(items: string[]): Node {
  if (items.length === 1) return patternValueNode(items[0]);
  const ul = document.createElement('ul');
  for (const item of items) {
    const li = document.createElement('li');
    li.appendChild(patternValueNode(item));
    ul.appendChild(li);
  }
  return ul;
}

function patternValueNode(pattern: string): Node {
  const info = matchTargetInfo(pattern);
  if (!info) return textNode(pattern);
  return openInNewTabAnchor(info.linkUrl, pattern);
}

function openInNewTabAnchor(href: string, text: string): HTMLAnchorElement {
  const a = document.createElement('a') as HTMLAnchorElement;
  a.className = 'code-link';
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.textContent = text;
  return a;
}

// Post-Prism walk over the highlighted code: replace eligible text
// runs with anchors. Two modes interleaved by a simple state machine
// driven by the `// ==UserScript== … // ==/UserScript==` markers:
//
//   - inside the metadata block: each line is matched against the
//     `// @tag value` shape. For tags we know how to linkify
//     (@match → wildcard-trimmed link, @icon/@require/@updateURL/…
//     → resolved against the script's fileUrl) the value substring
//     is wrapped in an anchor; other tags fall through to URL mode.
//   - outside the metadata block (and on tag-line fallbacks): every
//     absolute http(s) / file:// URL inside the text node becomes
//     an anchor. The same rule applies to @require source bodies
//     (which have no metadata block).
//
// Marker / tag matching is gated on Prism's `.token.comment` class
// so a string literal like `"// ==UserScript=="` inside the body
// can't flip the state machine.
function linkifyCodeBlock(root: HTMLElement, fileUrl: string): void {
  // Snapshot text nodes first; we mutate the tree as we go, and a
  // live TreeWalker would re-visit the new anchor children.
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let n: Node | null;
  while ((n = walker.nextNode()) !== null) nodes.push(n as Text);

  let inHeader = false;
  for (const tn of nodes) {
    const parent = tn.parentElement;
    const isComment = !!parent && parent.classList.contains('comment');
    const text = tn.data;

    if (isComment && isHeaderOpenLine(text)) {
      inHeader = true;
      continue;
    }
    if (isComment && isHeaderCloseLine(text)) {
      inHeader = false;
      continue;
    }

    if (inHeader && isComment) {
      const parsed = parseTagLine(text);
      if (parsed) {
        const link = linkForHeaderTag(parsed.tag, parsed.value, fileUrl);
        if (link) {
          // The anchor wraps just the `linkText` substring inside the
          // value; the `prefix` (e.g. the `<name>` of an `@resource`)
          // and `suffix` stay as plain text either side of it.
          const doc = root.ownerDocument;
          tn.replaceWith(
            doc.createTextNode(parsed.before + link.prefix),
            openInNewTabAnchor(link.href, link.linkText),
            doc.createTextNode(link.suffix + parsed.after),
          );
          continue;
        }
      }
    }

    linkifyTextNodeUrls(tn);
  }
}

function linkifyTextNodeUrls(tn: Text): void {
  const runs = splitTextByUrls(tn.data);
  if (runs.length === 1 && runs[0].kind === 'text') return;
  const doc = tn.ownerDocument;
  const replacement: Node[] = runs.map((r) =>
    r.kind === 'url'
      ? openInNewTabAnchor(r.value, r.value)
      : doc.createTextNode(r.value),
  );
  tn.replaceWith(...replacement);
}

// One header-tag link spec. `prefix` + `linkText` + `suffix` together
// reconstruct the parsed.value verbatim, so the line round-trips
// without losing any characters. Most tags use the whole value as
// the link text (prefix=suffix=''); `@resource` is the carve-out
// where prefix is the `<name>` token + gap and only the URL portion
// is wrapped.
interface HeaderTagLink {
  prefix: string;
  linkText: string;
  href: string;
  suffix: string;
}

function linkForHeaderTag(
  tag: string,
  value: string,
  fileUrl: string,
): HeaderTagLink | null {
  if (MATCH_HEADER_TAGS.has(tag)) {
    const linkUrl = matchTargetInfo(value)?.linkUrl;
    if (!linkUrl) return null;
    return { prefix: '', linkText: value, href: linkUrl, suffix: '' };
  }
  if (RESOLVABLE_HEADER_TAGS.has(tag)) {
    const resolved = resolveScriptResource(value, fileUrl);
    if (!resolved) return null;
    // A `data:` URL is technically navigable but its href would be
    // many KB long inside the anchor, drowning the code box. Inline
    // data URLs are already rendered via the favicon path; in the
    // body we just show the value as plain text.
    if (resolved.kind === 'data') return null;
    return { prefix: '', linkText: value, href: resolved.url, suffix: '' };
  }
  if (tag === 'resource') {
    // `@resource <name> <url>`: keep the name + gap as plain text;
    // linkify only the URL portion. The pure splitter in
    // script-links.ts owns the round-trip — see `splitResourceValue`.
    const parts = splitResourceValue(value);
    if (!parts) return null;
    const resolved = resolveScriptResource(parts.url, fileUrl);
    if (!resolved || resolved.kind === 'data') return null;
    return {
      prefix: parts.prefix,
      linkText: parts.url,
      href: resolved.url,
      suffix: parts.suffix,
    };
  }
  if (tag === 'connect') {
    // `@connect` values are hosts (`example.com`, `*.example.com`)
    // or full URLs, not match patterns. `connectLinkUrl` picks the
    // click target; `*` and `self` return null and fall through to
    // plain text since neither names a single site.
    const href = connectLinkUrl(value);
    if (!href) return null;
    return { prefix: '', linkText: value, href, suffix: '' };
  }
  return null;
}

function showMissing(message: string): void {
  controlsRowEl.hidden = true;
  filenameEl.textContent = 'Not available';
  messageEl.textContent = message;
  messageEl.className = 'message error';
  summaryEl.replaceChildren();
  tabsEl.replaceChildren();
  tabsEl.hidden = true;
  contentEl.textContent = '';
  logPaneEl.hidden = true;
  logPaneEl.replaceChildren();
  codePaneEl.hidden = false;
}
