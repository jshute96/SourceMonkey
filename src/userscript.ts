// Userscript viewer. Loaded as chrome-extension://…/userscript.html
// with a single query param `script=<scriptId>`. Hydrates from the
// persistent store (chrome.storage.local) rather than re-reading the
// file, so the content always matches what the sources page shows.
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
  type StoredSource,
} from './script-store.js';
import { basenameOf, computeLogIds } from './script-log-id.js';
import type { StoredRequire } from './external-files.js';
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
  joinFullSource,
} from './userscript-header.js';
import { isFileUrl, scriptAbsolutePath } from './directories.js';
import {
  appendWithSlashBreaks,
  effectiveDisplayName,
  makeSourceTypeBubble,
  sourceAnchorId,
} from './source-display.js';
import { matchTargetInfo } from './match-targets.js';
import { renderSiteIconInto } from './site-icon.js';
import { resolveScriptResource } from './file-loader.js';
import {
  MATCH_HEADER_TAGS,
  RESOLVABLE_HEADER_TAGS,
  connectLinkUrl,
  splitResourceValue,
  splitTextByUrls,
} from './script-links.js';
import {
  installGithubAuthListener,
  loadGithubAuthToken,
} from './github-auth.js';
import { parseStackRefs } from './stack-link.js';
import { buildSourceUrl } from './script-source-url.js';
import { buildHash, parseHash } from './script-url-hash.js';

// The viewer's Refresh button runs fetchHttpText in the page context,
// so the page needs its own copy of the cached GitHub token. The
// Refresh handler awaits the initial load before issuing the fetch so
// a click before hydration can't run unauthenticated.
installGithubAuthListener();
const githubTokenReady = loadGithubAuthToken();

declare const Prism: {
  highlightElement(el: Element): void;
  languages: {
    insertBefore(lang: string, before: string, grammar: Record<string, unknown>): void;
  };
  plugins?: {
    lineNumbers?: {
      getLine(pre: Element, lineNumber: number): HTMLElement | undefined;
    };
  };
};

// Extend Prism's JavaScript syntax highlighting grammar to recognise the
// `// ==UserScript== … // ==/UserScript==` block. The outer token
// keeps the `comment` alias so any non-tag line inside the block
// still reads as comment-grey. Inner tokens use existing Prism theme
// classes via `alias`:
//   - markers (`==UserScript==`, `==/UserScript==`, sans `//`) → `bold`
//   - `@tag` names → `constant` (matches identifier color in the body)
//   - values after the tag → `string` (matches string-literal color)
// Order inside matters: `header-tag-value` must run before
// `header-tag-name`, because the value's lookbehind needs the `@tag`
// substring to still be present in the unconsumed text when it scans.
Prism.languages.insertBefore('javascript', 'comment', {
  'userscript-header': {
    // Trailing `[ \t]*\r?\n?` swallows whitespace + the line-terminating
    // newline after `==/UserScript==` (CRLF and LF). We need the
    // newline inside the span because we render the span as
    // `display: block` for the tinted band, and a newline left in
    // the text node *after* the block would render as an extra blank
    // line on top of the block break the browser already inserts.
    pattern: /\/\/[ \t]*==UserScript==[\s\S]*?\/\/[ \t]*==\/UserScript==[ \t]*\r?\n?/,
    alias: 'comment',
    inside: {
      'header-marker': {
        pattern: /(\/\/[ \t]*)==\/?UserScript==/,
        lookbehind: true,
        alias: 'bold',
      },
      'header-tag-value': {
        // `[^\r\n]*` (not `[^\n]*`) so a CRLF file doesn't sweep the
        // line-terminating `\r` into the value span, which would
        // leak a trailing `\r` into anchor hrefs / `matchTargetInfo`
        // input downstream.
        pattern: /(\/\/[ \t]*@[A-Za-z][\w-]*(?::[\w-]+)?[ \t]+)\S[^\r\n]*/,
        lookbehind: true,
        alias: 'string',
      },
      'header-tag-name': {
        pattern: /(\/\/[ \t]*)@[A-Za-z][\w-]*(?::[\w-]+)?/,
        lookbehind: true,
        alias: 'constant',
      },
    },
  },
});

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
// another tab (sources page, viewer of a sibling) adds or removes a
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
    showMissing('Script not found in storage. Open it from the sources page.');
    return;
  }
  await refreshLogId();
  render(script);
  // render() wipes the flash overlay via `textContent =` and may
  // have clamped currentTabIndex to 0 if a require disappeared.
  // Re-anchor highlight + URL without scrolling the code pane.
  applyHashToView(false);
}

// Source-enabled state is needed for greying the toggle. We cache it so
// onToggle doesn't have to re-read storage. sourcePath is cached for
// the same reason — render() builds the absolute filename from it.
// sourceRow holds the whole StoredSource (when found) so the Source
// row can render its bubble + display name without a second read.
let sourceEnabled = true;
let sourcePath = '';
let sourceRow: StoredSource | null = null;
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
// Most recently rendered script. The session-storage listener calls
// paintLog without re-reading the script, so we capture the latest
// here so log-pane linkification can build tabs (and their
// `sourceUrl`s) without re-reading storage.
let currentScript: StoredScript | null = null;

async function load(): Promise<void> {
  if (!scriptId) {
    showMissing('Missing `script` query parameter.');
    return;
  }
  const script = await getScript(scriptId);
  if (!script) {
    showMissing('Script not found in storage. Open it from the sources page.');
    return;
  }
  const source = await getSource(script.sourceId);
  sourceEnabled = source ? isSourceEnabled(source) : true;
  sourcePath = source?.path ?? '';
  sourceRow = source ?? null;
  await refreshLogId();

  // Pre-select the tab from `location.hash` so render() paints the
  // right one on the first pass — without this we'd flash main
  // before applyHashToView re-rendered.
  currentTabIndex = resolveHashTarget(location.hash, buildTabs(script)).tabIndex;

  render(script);
  // applyHashToView handles the rest (highlight + URL normalize),
  // and avoids re-rendering since currentTabIndex already matches.
  applyHashToView(true);
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
    // Wait for the GitHub token cache to hydrate first; otherwise a
    // very fast Refresh click can fire before chrome.storage.local
    // has resolved and the fetch goes out unauthenticated.
    await githubTokenReady;
    // Routed through the shared updater: if a background opportunistic
    // check is already in flight for this script, we wait for it
    // instead of starting a second fetch.
    const next = await updateScript(scriptId, 'manual');
    if (next) {
      await refreshLogId();
      render(next);
      // Re-anchor highlight + URL after the repaint (see notes on
      // applyHashToView). Scroll skipped so a Refresh doesn't yank
      // the user's scroll position.
      applyHashToView(false);
    }
  } finally {
    refreshBtn.disabled = false;
    refreshBtn.textContent = prior ?? 'Refresh';
  }
}

async function onToggleEnabled(enabled: boolean): Promise<void> {
  if (!scriptId) return;
  const next = await setScriptEnabled(scriptId, enabled);
  if (next) {
    render(next);
    applyHashToView(false);
  }
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
  currentScript = script;
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
// `sourceUrl` is the `sourcemonkey://…` URL we expect stack frames
// for code in this tab to carry. Stack-ref links in the Log tab are
// linkified only when their URL matches one of the tabs' sourceUrls
// (today only the main tab — the injector doesn't yet emit a
// per-require `//# sourceURL=`, so frames inside `@require` code
// share the main URL and currently aren't routed to require tabs).
type Tab =
  | { kind: 'code'; label: string; body: string; fileUrl: string; sourceUrl: string }
  | { kind: 'log'; label: string };

// Index of the currently selected tab. Preserved across re-renders
// when the new tab list still has an entry at that index; otherwise
// falls back to 0 (the main script).
let currentTabIndex = 0;
// Highlight state tracked alongside currentTabIndex so the URL hash
// can be rebuilt from a single source of truth. `undefined` means
// "no line highlighted". Cleared on tab switch (a new tab's content
// has no highlight to start) and set by scrollToAndHighlightLine
// after a successful paint.
let currentHighlightLine: number | undefined;
let currentHighlightCol: number | undefined;

function buildTabs(script: StoredScript): Tab[] {
  const name = (script.header && getValue(script.header, 'name')) || script.relativePath;
  const tabs: Tab[] = [{
    kind: 'code',
    label: basenameOf(script.relativePath),
    body: buildMainTabBody(script),
    fileUrl: script.fileUrl,
    sourceUrl: buildSourceUrl(script.id, name),
  }];
  for (const r of script.requires ?? []) {
    tabs.push({
      kind: 'code',
      label: requireBasename(r),
      body: r.source,
      fileUrl: r.url,
      // Empty until the injector emits per-require sourceURLs; a
      // ref will never match an empty sourceUrl, so require tabs
      // simply aren't linkified for now.
      sourceUrl: '',
    });
  }
  // Log tab always last so the file order stays stable as @requires
  // come and go.
  tabs.push({ kind: 'log', label: 'Log' });
  return tabs;
}

// Reconstruct the original on-disk source from the stored split.
// Same string the injector splices into the registered code, so the
// viewer's main tab line N matches the file line N AND injected line
// N (modulo any @require sections that sit before the main script).
function buildMainTabBody(script: StoredScript): string {
  return joinFullSource(
    script.leadingText ?? '',
    script.headerText ?? '',
    script.bodyText,
  );
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
  if (currentTabIndex >= tabs.length) {
    currentTabIndex = 0;
    // The highlight pointed at a tab that no longer exists — drop
    // it so the URL hash doesn't claim a line on the fallback tab
    // the user never selected.
    currentHighlightLine = undefined;
    currentHighlightCol = undefined;
  }

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
      currentHighlightLine = undefined;
      currentHighlightCol = undefined;
      renderTabsAndBody(script);
      updateUrlHash();
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
    installGutterClickHandlers();
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

  // Compute the tab list once for the whole render; every row's
  // message column needs the same set to look up stack refs by
  // URL. Falls back to an empty list when the script isn't yet
  // hydrated — appendLogMessageContent handles that case.
  const tabs = currentScript ? buildTabs(currentScript) : [];

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
    appendLogMessageContent(tdMsg, e.message, tabs);
    tr.appendChild(tdMsg);

    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  logPaneEl.appendChild(table);
}

// Paint a log entry's message into a <td>. Each
// `sourcemonkey://<this-script's-id>/<file>:<line>:<col>` reference
// whose URL matches a code tab's `sourceUrl` becomes a clickable
// link that switches to that tab and jumps to line/col. Refs whose
// URL doesn't match any tab render as plain text — they may point
// at a file the viewer doesn't have a tab for (e.g. an `@require`
// source, until the injector emits per-require sourceURLs).
function appendLogMessageContent(
  td: HTMLElement,
  message: string,
  tabs: Tab[],
): void {
  const script = currentScript;
  if (!script) {
    td.textContent = message;
    return;
  }
  const runs = parseStackRefs(message, script.id);
  if (runs.length === 1 && runs[0].kind === 'text') {
    td.textContent = message;
    return;
  }
  td.replaceChildren();
  for (const run of runs) {
    if (run.kind === 'text') {
      td.appendChild(document.createTextNode(run.text));
      continue;
    }
    const tabIndex = tabs.findIndex(
      (t) => t.kind === 'code' && t.sourceUrl && t.sourceUrl === run.url,
    );
    if (tabIndex < 0) {
      td.appendChild(document.createTextNode(run.text));
      continue;
    }
    const a = document.createElement('a');
    a.className = 'log-stack-link';
    a.href = '#';
    a.textContent = run.text;
    a.addEventListener('click', (ev) => {
      ev.preventDefault();
      goToTabLine(tabIndex, run.line, run.col);
    });
    td.appendChild(a);
  }
}

// Switch to the given tab (if not already active), then scroll the
// code pane to bring the requested line into view and highlight it.
// `col` (1-based) positions the vertical accent bar at the character
// column from the stack ref. Pass `undefined` (e.g. line-number
// gutter clicks) to place the bar at the start of the line.
function goToTabLine(tabIndex: number, tabLine: number, col?: number): void {
  if (!currentScript) return;
  if (currentTabIndex !== tabIndex) {
    currentTabIndex = tabIndex;
    currentHighlightLine = undefined;
    currentHighlightCol = undefined;
    renderTabsAndBody(currentScript);
  }
  scrollToAndHighlightLine(tabLine, col);
  updateUrlHash();
}

function scrollToAndHighlightLine(
  tabLine: number,
  col?: number,
  // Gutter clicks pass `false`: the user is clicking on a row
  // they're already looking at, so re-centering it is jarring.
  // Stack-ref clicks (default `true`) need the scroll — the
  // target line may be off-screen or in a different tab.
  scroll = true,
): void {
  if (codePaneEl.hidden) return;
  const api = Prism.plugins?.lineNumbers;
  if (!api?.getLine) return;
  const gutterSpan = api.getLine(codePaneEl, tabLine);
  if (!gutterSpan) return;

  // gutterSpan's offsetParent is `.line-numbers-rows`, which is
  // positioned absolutely at top: 0 of <code>. So its offsetTop
  // doubles as the y-coordinate of the matching code line within
  // <code>, and inside the <pre> the same value lines up with the
  // pre's scrollable content.
  const top = gutterSpan.offsetTop;
  const height = gutterSpan.offsetHeight || 0;

  if (scroll) {
    codePaneEl.scrollTop = top - codePaneEl.clientHeight / 2 + height / 2;
  }

  // Replace any leftover highlight so successive clicks land on the
  // newest line only (we never stack overlays).
  for (const prior of Array.from(contentEl.querySelectorAll('.line-flash'))) {
    prior.remove();
  }
  const flash = document.createElement('div');
  flash.className = 'line-flash';
  flash.style.top = `${top}px`;
  flash.style.height = `${height}px`;

  // Accent bar at the column position, but only when the caller
  // supplied one (stack-ref clicks carry `col`; line-number gutter
  // clicks don't). Skip on line 1: the wrapper prefix shares that
  // physical line, so a reported column points into the shim rather
  // than user code.
  if (col !== undefined && col > 0 && tabLine > 1) {
    const cs = getComputedStyle(codePaneEl);
    // Tabs in V8's column count are one character each, but the
    // viewer renders them as `tab-size` columns wide (Prism's CSS
    // sets 4). Walk the source line and expand each tab to the next
    // tab stop so the bar lands on the actual rendered glyph.
    const lineText = lineTextAt(tabLine);
    const tabSize = parseInt(cs.tabSize, 10) || 8;
    const visualCol = expandToVisualColumn(lineText, col, tabSize);
    // `.line-flash` extends 0.8em left of <code>'s content area so
    // the highlight can cover the header band's negative-margin
    // extension. The bar's `left:` is measured from the flash's
    // edge, so add that 0.8em back to anchor at code's column 0.
    const fontSize = parseFloat(cs.fontSize) || 13;
    const flashLeftEm = 0.8;
    const bar = document.createElement('div');
    bar.className = 'line-flash-col-bar';
    bar.style.left = `${flashLeftEm * fontSize + visualCol * measureCodeCharWidth()}px`;
    flash.appendChild(bar);
  }

  contentEl.appendChild(flash);

  // Update the tracked highlight state so the URL-hash builder
  // can read the currently-highlighted line/col. Callers that
  // initiate a UI change (gutter click, stack-ref click) then call
  // updateUrlHash() to push this to location.hash.
  currentHighlightLine = tabLine;
  currentHighlightCol = col;
}

// Wire up clicks on each line-number span in the gutter so the user
// can highlight any line (clearing any prior highlight). The gutter
// spans are populated by the Prism line-numbers plugin during
// `Prism.highlightElement`, so this must run after that call.
function installGutterClickHandlers(): void {
  const rows = contentEl.querySelector('.line-numbers-rows');
  if (!rows) return;
  rows.classList.add('clickable');
  const spans = rows.children;
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i] as HTMLElement;
    const lineNumber = i + 1;
    span.addEventListener('click', () => {
      scrollToAndHighlightLine(lineNumber, undefined, false);
      updateUrlHash();
    });
  }
}

// ----- URL fragment navigation --------------------------------
//
// `location.hash` mirrors the current tab + highlight so the URL
// is copyable and the page reopens in the same place.
//   <empty>                   main script, no highlight
//   #Log                      Log tab
//   #<filename>               that code tab
//   #<filename>:<line>        + highlighted line
//   #<filename>:<line>:<col>  + column accent bar
// See `src/script-url-hash.ts` for the grammar / parser.

// Push the current viewer state to `location.hash` via
// `history.replaceState` (no Back-button entries; no hashchange
// event re-fires into our own listener). No-op when the fragment
// is already correct.
function updateUrlHash(): void {
  if (!currentScript) return;
  const tabs = buildTabs(currentScript);
  const tab = tabs[currentTabIndex];
  if (!tab) return;
  const fragment = tab.kind === 'log'
    ? buildHash({ tab: 'log' })
    : buildHash({
        tab: currentTabIndex === 0 ? 'main' : 'require',
        filename: tab.label,
        line: currentHighlightLine,
        col: currentHighlightCol,
      });
  const desired = fragment ? '#' + fragment : '';
  if (location.hash === desired) return;
  // Empty fragment → drop the `#` from the URL entirely.
  const next = desired || location.pathname + location.search;
  history.replaceState(null, '', next);
}

interface HashTarget {
  tabIndex: number;
  line?: number;
  col?: number;
}

// Resolve a raw hash string against the current tab list. Falls back
// to the main tab when the filename doesn't match — in that case
// `line` and `col` are dropped because the line number was relative
// to the missing file, not main.
function resolveHashTarget(rawHash: string, tabs: Tab[]): HashTarget {
  const parsed = parseHash(rawHash);
  if (parsed.kind === 'log') {
    const idx = tabs.findIndex((t) => t.kind === 'log');
    return { tabIndex: idx >= 0 ? idx : 0 };
  }
  if (parsed.kind === 'code') {
    const idx = tabs.findIndex(
      (t) => t.kind === 'code' && t.label === parsed.filename,
    );
    if (idx >= 0) return { tabIndex: idx, line: parsed.line, col: parsed.col };
  }
  return { tabIndex: 0 };
}

// Hydrate the view from `location.hash`. Called on initial load,
// when the user manually edits the URL, on Back/Forward, and after
// any re-render path that wipes the flash overlay (onRefresh /
// onToggleEnabled / storage-change rehydrate). `scroll` defaults to
// true so navigation jumps to the line; the re-render paths pass
// false so a Refresh doesn't yank the user's scroll position.
function applyHashToView(scroll = true): void {
  if (!currentScript) return;
  const tabs = buildTabs(currentScript);
  const target = resolveHashTarget(location.hash, tabs);

  if (currentTabIndex !== target.tabIndex) {
    currentTabIndex = target.tabIndex;
    currentHighlightLine = undefined;
    currentHighlightCol = undefined;
    renderTabsAndBody(currentScript);
  }

  if (target.line !== undefined && tabs[currentTabIndex].kind === 'code') {
    scrollToAndHighlightLine(target.line, target.col, scroll);
  } else {
    clearLineHighlight();
  }

  // Normalize the URL so a partial / invalid hash collapses to the
  // canonical form for whatever state we just landed in.
  updateUrlHash();
}

function clearLineHighlight(): void {
  for (const prior of Array.from(contentEl.querySelectorAll('.line-flash'))) {
    prior.remove();
  }
  currentHighlightLine = undefined;
  currentHighlightCol = undefined;
}

window.addEventListener('hashchange', () => {
  applyHashToView();
});

// Read the Nth (1-based) line of the currently-displayed source
// from <code>'s text content. The line-numbers gutter's children
// are empty spans (line numbers are CSS counters, not text), so
// textContent reconstructs the source faithfully.
function lineTextAt(tabLine: number): string {
  const text = contentEl.textContent ?? '';
  const lines = text.split('\n');
  return lines[tabLine - 1] ?? '';
}

// Convert a 1-based column from V8's stack trace into a 0-based
// visual column count, expanding each tab character to the next
// `tabSize` boundary. V8 counts every tab as one column; the
// viewer renders it as enough spaces to reach the next tab stop.
function expandToVisualColumn(lineText: string, col: number, tabSize: number): number {
  let visualCol = 0;
  const stop = Math.min(Math.max(col - 1, 0), lineText.length);
  for (let i = 0; i < stop; i++) {
    if (lineText.charCodeAt(i) === 9) {
      visualCol += tabSize - (visualCol % tabSize);
    } else {
      visualCol++;
    }
  }
  return visualCol;
}

// Cached monospace character width in CSS pixels for the code-pane
// font. Computed lazily on first highlight; the viewer's font never
// changes during a session, so a single measurement is enough.
let cachedCharWidth = 0;
function measureCodeCharWidth(): number {
  if (cachedCharWidth > 0) return cachedCharWidth;
  const probe = document.createElement('span');
  // Measure across 20 'M's so sub-pixel rounding averages out.
  probe.textContent = 'M'.repeat(20);
  probe.style.visibility = 'hidden';
  probe.style.position = 'absolute';
  probe.style.whiteSpace = 'pre';
  contentEl.appendChild(probe);
  const w = probe.getBoundingClientRect().width / 20;
  probe.remove();
  cachedCharWidth = w;
  return w;
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
  appendWithSlashBreaks(filenameEl, script.relativePath);
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

  // Source row: same colored bubble + display name combo the sources
  // page uses, with the display name doubling as a back-link to the
  // sources page (anchored to this source's section). Renders above
  // the Location row so the viewer's "where did this come from"
  // information is grouped.
  if (sourceRow) {
    appendRow(dl, 'Source', sourceCell(sourceRow));
  }

  // Resolved location for the script: an absolute filesystem path for
  // file:// sources, the github page URL for github sources, or the
  // resolved URL for non-github HTTP sources. Skip the row entirely if
  // the source row is gone — a bare relative path under a "Location"
  // label would be misleading.
  if (sourcePath) {
    currentFilenamePath = scriptAbsolutePath(sourcePath, script.relativePath);
    // Anchor href: for file:// sources we use the file:// URL (the
    // display string is the bare fs path, not navigable). For
    // everything else display = href, so the user clicks the same URL
    // they'd copy from the row.
    const href = isFileUrl(script.fileUrl) ? script.fileUrl : currentFilenamePath;
    appendRow(dl, 'Location', filenameCell(currentFilenamePath, href));
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

// Source-row cell: colored type bubble on the left (linking out to the
// underlying file:// / http(s):// URL), followed by the source's
// display name as a back-link to the sources page anchored at this
// source's section.
function sourceCell(source: StoredSource): Node {
  const cell = document.createElement('span');
  cell.className = 'source-cell';

  cell.appendChild(makeSourceTypeBubble(source.path));

  const nameLink = document.createElement('a');
  nameLink.className = 'source-display-name';
  appendWithSlashBreaks(nameLink, effectiveDisplayName(source));
  nameLink.href = chrome.runtime.getURL(`sources.html#${sourceAnchorId(source.id)}`);
  // Tooltip surfaces the raw stored path; the anchor itself jumps to
  // the section on the sources page.
  nameLink.title = source.path;
  cell.appendChild(nameLink);

  return cell;
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
  // (file://... vs http://...) without clicking through. Slash-aware
  // appender lets long paths wrap at `/` boundaries before breaking
  // mid-segment.
  pathEl.title = hrefUrl;
  appendWithSlashBreaks(pathEl, path);
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
  if (!info) {
    // Non-linkable pattern (`<all_urls>`, regex literal, etc.); render
    // as plain text but still allow slash-aware wrapping in case the
    // pattern is long.
    const span = document.createElement('span');
    appendWithSlashBreaks(span, pattern);
    return span;
  }
  return openInNewTabAnchor(info.linkUrl, pattern);
}

function openInNewTabAnchor(
  href: string,
  text: string,
  // When true, insert `<wbr>` markers after each `/` so a long URL
  // wraps at slash boundaries — desired in the details panel (Match
  // patterns, Location row). The code box passes false: with
  // `white-space: pre`, Chrome still honors `<wbr>` as a break
  // opportunity, so a URL inside a single source line could wrap
  // mid-line and misalign the line-numbers gutter.
  slashBreaks = true,
): HTMLAnchorElement {
  const a = document.createElement('a') as HTMLAnchorElement;
  a.className = 'code-link';
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  if (slashBreaks) {
    appendWithSlashBreaks(a, text);
  } else {
    a.textContent = text;
  }
  return a;
}

// Post-Prism walk over the highlighted code: replace eligible text
// runs with anchors. Two passes:
//
//   1. Metadata blocks are recognised as `.token.userscript-header`
//      spans by the Prism grammar extension above; inside each, the
//      `@tag` is a `.header-tag-name` span and its value is a
//      `.header-tag-value` span. For tags we know how to linkify
//      (@match → wildcard-trimmed link, @icon/@require/@updateURL/…
//      → resolved against the script's fileUrl) the value span's
//      contents become an anchor; non-linkable tags fall through to
//      URL mode on the value text.
//   2. Every other text node has its absolute http(s) / file:// URLs
//      turned into anchors — covers comment URLs outside the header,
//      URLs inside strings, and `@require` source bodies (no header).
//
// Driving the header detection off the Prism token class (rather
// than line-shape matching) means a single-line string literal like
// `"// ==UserScript=="` can't trick the linkifier — Prism tokenises
// it as a string, not as our header block. A multi-line template
// literal that contains BOTH markers can still be picked up because
// our pattern is inserted before `string`/template tokens; in
// practice no userscript embeds a fake metadata block that way, but
// it's worth knowing.
function linkifyCodeBlock(root: HTMLElement, fileUrl: string): void {
  for (const headerEl of Array.from(root.querySelectorAll('.userscript-header'))) {
    linkifyHeaderBlock(headerEl as HTMLElement, fileUrl);
  }

  // Walk text nodes AFTER the header pass so the tree mutations from
  // linkifyHeaderBlock are reflected. Skip nodes inside marker /
  // tag-name / tag-value spans — they were either handled by
  // linkifyHeaderBlock or are anchor labels we just inserted and
  // don't want to re-process.
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let n: Node | null;
  while ((n = walker.nextNode()) !== null) {
    const tn = n as Text;
    const parent = tn.parentElement;
    if (parent && parent.closest('.header-marker, .header-tag-name, .header-tag-value')) {
      continue;
    }
    nodes.push(tn);
  }
  for (const tn of nodes) linkifyTextNodeUrls(tn);
}

// Process one `.userscript-header` span: for each `.header-tag-value`
// inside it, look back for the matching `.header-tag-name` and turn
// the value into an anchor (or URL-linkified text for tags we don't
// know how to resolve).
function linkifyHeaderBlock(headerEl: HTMLElement, fileUrl: string): void {
  const valueEls = headerEl.querySelectorAll<HTMLElement>('.header-tag-value');
  for (const valueEl of Array.from(valueEls)) {
    const tag = findPrecedingTagName(valueEl);
    if (!tag) continue;
    const value = valueEl.textContent ?? '';
    const link = linkForHeaderTag(tag, value, fileUrl);
    if (link) {
      const doc = headerEl.ownerDocument;
      valueEl.replaceChildren(
        doc.createTextNode(link.prefix),
        openInNewTabAnchor(link.href, link.linkText, false),
        doc.createTextNode(link.suffix),
      );
    } else {
      // Fall back to URL-only linkification (e.g. an http URL inside
      // a `@description` value). Only touch the leaf text node so we
      // don't disturb any nested tokens (shouldn't exist today, but
      // safe if Prism's grammar evolves).
      const tn = valueEl.firstChild;
      if (tn && tn.nodeType === Node.TEXT_NODE) {
        linkifyTextNodeUrls(tn as Text);
      }
    }
  }
}

// Walk back from a tag-value span past whitespace text nodes to find
// the immediately-preceding tag-name span; returns the lowercased
// canonical tag (no `@`, no locale suffix), or null if the structure
// doesn't match (defensive — Prism should always pair them).
function findPrecedingTagName(valueEl: Element): string | null {
  let prev: Node | null = valueEl.previousSibling;
  while (prev) {
    if (prev.nodeType === Node.ELEMENT_NODE) {
      const el = prev as Element;
      if (!el.classList.contains('header-tag-name')) return null;
      const text = el.textContent ?? '';
      const m = /^@([A-Za-z][\w-]*)(?::[\w-]+)?$/.exec(text);
      return m ? m[1].toLowerCase() : null;
    }
    prev = prev.previousSibling;
  }
  return null;
}

function linkifyTextNodeUrls(tn: Text): void {
  const runs = splitTextByUrls(tn.data);
  if (runs.length === 1 && runs[0].kind === 'text') return;
  const doc = tn.ownerDocument;
  const replacement: Node[] = runs.map((r) =>
    r.kind === 'url'
      ? openInNewTabAnchor(r.value, r.value, false)
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
  currentScript = null;
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
