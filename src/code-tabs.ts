// The tabbed code view: tab strip, highlighted code pane, line
// highlighting, clickable line-number gutter, and `#file:line:col`
// URL-fragment sync.
//
// Split out of `userscript.ts` so one implementation serves both
// viewer modes — an installed script (whose tab bodies are already in
// storage) and a preview of a script that isn't installed yet (whose
// `@require` bodies are fetched on demand, hence `TabBody` allowing a
// thunk). The Log tab is optional: previews don't have one.
//
// The view owns which tab is selected and which line is highlighted;
// the page owns what the tabs are and what the log pane contains.

import { linkifyCodeBlock } from './code-links.js';
// Side-effect import: installs the `userscript-header` token that
// `code-links.ts` keys its header linkification off. Imported here
// because this is the module that calls `Prism.highlightElement`, so
// any page reusing the view gets the grammar with it.
import './prism-userscript.js';
import { buildHash, parseHash } from './script-url-hash.js';

declare const Prism: {
  highlightElement(el: Element): void;
  plugins?: {
    lineNumbers?: {
      getLine(pre: Element, lineNumber: number): HTMLElement | undefined;
    };
  };
};

// A code tab's contents: either the text itself, or a thunk that
// fetches it the first time the tab is opened. The thunk's result is
// cached in place, so re-selecting the tab is instant and a preview
// never re-fetches a `@require` the user already looked at.
export type TabBody = string | (() => Promise<string>);

// Code tabs paint into the code pane (main script first, then one per
// @require in declaration order); the optional trailing Log tab swaps
// the code pane for the page's log pane.
//
// `fileUrl` is the tab body's canonical fetchable URL — main-script
// tabs use `script.fileUrl`; require tabs use the require's resolved
// URL so any relative ref inside the require resolves against the
// require, not the host script (uncommon — require bodies rarely have
// their own metadata block — but cheap to get right).
//
// `sourceUrl` is the `sourcemonkey://…` URL we expect stack frames for
// code in this tab to carry. Stack-ref links in the Log tab are
// linkified only when their URL matches one of the tabs' sourceUrls
// (today only the main tab — requires are concatenated into the
// script's own entry, so every frame carries the main URL. Require
// tabs get routed frames again once the Log tab learns to apply the
// entry's source map; see TODO.md).
// `title` is the tab button's tooltip. The label is a bare basename, so
// this is where a tab says which file it actually is — and, for a
// `@require` served from a local stand-in, both the URL the script
// declared and the file we read instead.
//
// `mark` is a short visible chip rendered after the label. Reserved for
// facts a reader must not have to hover to discover; today the only one
// is `local`, because running something other than what the `@require`
// line names has to be visible on its face.
export type CodeTab =
  | {
      kind: 'code';
      label: string;
      body: TabBody;
      fileUrl: string;
      sourceUrl: string;
      title?: string;
      mark?: string;
    }
  | { kind: 'log'; label: string };

export interface CodeTabsElements {
  tabsEl: HTMLElement;
  codePaneEl: HTMLElement;
  contentEl: HTMLElement;
  logPaneEl: HTMLElement;
}

export interface CodeTabsHooks {
  // Called when the Log tab becomes the active tab. The page fills
  // `logPaneEl` itself; the view only shows / hides it.
  onShowLog?: () => void;
}

export class CodeTabsView {
  private readonly els: CodeTabsElements;
  private readonly hooks: CodeTabsHooks;
  private tabList: CodeTab[] = [];
  // Index of the currently selected tab. Preserved across re-renders
  // when the new tab list still has an entry at that index; otherwise
  // falls back to 0 (the main script).
  private activeIdx = 0;
  // Highlight state tracked alongside activeIdx so the URL hash can be
  // rebuilt from a single source of truth. `undefined` means "no line
  // highlighted". Cleared on tab switch (a new tab's content has no
  // highlight to start) and set by `highlightLine` after a paint.
  private highlightLine: number | undefined;
  private highlightCol: number | undefined;
  // Bumped on every paint so a slow lazy body can't overwrite a tab
  // the user has since switched away from — including a switch to the
  // Log tab, which paints no code at all.
  private paintEpoch = 0;
  // Line/col a caller asked to highlight while the active tab's body
  // was still loading. `scrollToAndHighlightLine` needs the rendered
  // line-numbers gutter to measure against, so the request is parked
  // here and replayed once the body paints. Cleared by any paint that
  // doesn't have one pending, so it can't leak onto a later tab.
  private pendingHighlight: { line: number; col?: number; scroll: boolean } | undefined;
  // Set once the first tab list arrives, so `setTabs` knows whether to
  // seed the selection from `location.hash` (first paint) or preserve
  // the user's current tab (re-render).
  private seeded = false;
  private cachedCharWidth = 0;

  constructor(els: CodeTabsElements, hooks: CodeTabsHooks = {}) {
    this.els = els;
    this.hooks = hooks;
    window.addEventListener('hashchange', () => this.applyHash());
  }

  get tabs(): readonly CodeTab[] {
    return this.tabList;
  }

  get activeIndex(): number {
    return this.activeIdx;
  }

  // Install a new tab list and repaint. On the very first call the
  // selection is seeded from `location.hash` so the right tab paints
  // immediately — without it the main tab would flash before
  // `applyHash` swapped it.
  setTabs(tabs: CodeTab[]): void {
    this.tabList = tabs;
    if (!this.seeded) {
      this.seeded = true;
      this.activeIdx = this.resolveHashTarget(location.hash).tabIndex;
    } else if (this.activeIdx >= tabs.length) {
      this.activeIdx = 0;
      // The highlight pointed at a tab that no longer exists — drop it
      // so the URL hash doesn't claim a line on the fallback tab the
      // user never selected.
      this.resetHighlight();
    }
    this.paint();
  }

  // Forget the current selection so the NEXT `setTabs` seeds from
  // `location.hash` again, exactly as the first paint does.
  //
  // For in-page navigation to another copy of the script (see the
  // viewer's `navigateToScript`): the tab list about to arrive belongs
  // to a different file, so preserving "tab 3" — the third `@require`
  // of the script the user just left — would land them somewhere
  // arbitrary. The hash is the new page's own instruction (`#Log` from
  // a Status link, nothing from a Location link).
  reseedFromHash(): void {
    this.seeded = false;
    this.activeIdx = 0;
    this.resetHighlight();
  }

  // Wipe the view (no script to show).
  clear(): void {
    this.tabList = [];
    this.activeIdx = 0;
    this.resetHighlight();
    this.paintEpoch++;
    this.els.tabsEl.replaceChildren();
    this.els.tabsEl.hidden = true;
    this.els.contentEl.textContent = '';
    this.els.logPaneEl.hidden = true;
    this.els.codePaneEl.hidden = false;
  }

  // Index of the code tab whose `sourceUrl` matches, or -1. Used by
  // the log pane to decide whether a stack ref is one of ours.
  findTabBySourceUrl(url: string): number {
    return this.tabList.findIndex(
      (t) => t.kind === 'code' && t.sourceUrl !== '' && t.sourceUrl === url,
    );
  }

  // Switch to the given tab (if not already active), then scroll the
  // code pane to bring the requested line into view and highlight it.
  // `col` (1-based) positions the vertical accent bar at the character
  // column from the stack ref. Pass `undefined` (e.g. line-number
  // gutter clicks) to place the bar at the start of the line.
  //
  // `tabLine` is optional because not every navigation has a line to
  // offer: a diagnostic about a file as a whole (a missing metadata
  // block) knows which file to open and nothing more. Omitting it selects the
  // tab and leaves no highlight behind — including when the tab was
  // already active and carrying one from a previous jump, which would
  // otherwise read as this navigation's answer.
  goToTabLine(tabIndex: number, tabLine?: number, col?: number): void {
    if (this.activeIdx !== tabIndex) {
      this.activeIdx = tabIndex;
      this.resetHighlight();
      this.paint();
    }
    if (tabLine === undefined) this.clearLineHighlight();
    else this.scrollToAndHighlightLine(tabLine, col);
    this.updateUrlHash();
  }

  // Hydrate the view from `location.hash`. Called on initial load,
  // when the user manually edits the URL, on Back/Forward, and after
  // any re-render path that wipes the flash overlay (Refresh / enable
  // toggle / storage-change rehydrate). `scroll` defaults to true so
  // navigation jumps to the line; the re-render paths pass false so a
  // Refresh doesn't yank the user's scroll position.
  applyHash(scroll = true): void {
    if (this.tabList.length === 0) return;
    const target = this.resolveHashTarget(location.hash);

    if (this.activeIdx !== target.tabIndex) {
      this.activeIdx = target.tabIndex;
      this.resetHighlight();
      this.paint();
    }

    if (target.line !== undefined && this.tabList[this.activeIdx]?.kind === 'code') {
      this.scrollToAndHighlightLine(target.line, target.col, scroll);
    } else {
      this.clearLineHighlight();
    }

    // Normalize the URL so a partial / invalid hash collapses to the
    // canonical form for whatever state we just landed in.
    this.updateUrlHash();
  }

  // ----- painting ------------------------------------------------

  private paint(): void {
    const { tabsEl, codePaneEl, contentEl, logPaneEl } = this.els;
    // Bumped before anything else so every paint — including one that
    // shows the Log tab and touches no code — invalidates a lazy body
    // still in flight for the tab we're leaving.
    const epoch = ++this.paintEpoch;
    tabsEl.replaceChildren();
    // Always render the strip — even a single main-script tab gives the
    // page a consistent shape and tells the user the viewer is tabbed.
    tabsEl.hidden = false;

    this.tabList.forEach((tab, idx) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tab' + (idx === this.activeIdx ? ' active' : '');
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-selected', idx === this.activeIdx ? 'true' : 'false');
      btn.textContent = tab.label;
      if (tab.kind === 'code' && tab.title) btn.title = tab.title;
      if (tab.kind === 'code' && tab.mark) {
        const mark = document.createElement('span');
        mark.className = 'tab-mark';
        mark.textContent = tab.mark;
        btn.appendChild(mark);
      }
      btn.addEventListener('click', () => {
        if (this.activeIdx === idx) return;
        this.activeIdx = idx;
        this.resetHighlight();
        this.paint();
        this.updateUrlHash();
      });
      tabsEl.appendChild(btn);
    });

    const active = this.tabList[this.activeIdx];
    if (!active) return;
    if (active.kind === 'log') {
      codePaneEl.hidden = true;
      logPaneEl.hidden = false;
      this.hooks.onShowLog?.();
      return;
    }
    logPaneEl.hidden = true;
    codePaneEl.hidden = false;

    if (typeof active.body === 'string') {
      this.paintCode(active.body, active.fileUrl);
      this.applyPendingHighlight();
      return;
    }
    // Lazy body: show a placeholder, fetch, then paint — unless the
    // user switched tabs while the fetch was in flight.
    contentEl.textContent = 'Loading…';
    void active
      .body()
      .then((text) => {
        // Cache in place so re-selecting this tab is instant.
        active.body = text;
        if (epoch !== this.paintEpoch) return;
        this.paintCode(text, active.fileUrl);
        // Any highlight requested while this was loading had nothing
        // to measure against; now there is.
        this.applyPendingHighlight();
      })
      .catch((err: unknown) => {
        if (epoch !== this.paintEpoch) return;
        // A failed body has no lines, so drop the pending highlight
        // rather than leaving it to fire on some later tab.
        this.pendingHighlight = undefined;
        contentEl.textContent = `Could not load this file: ${
          err instanceof Error ? err.message : String(err)
        }`;
        this.updateUrlHash();
      });
  }

  private applyPendingHighlight(): void {
    const pending = this.pendingHighlight;
    if (!pending) return;
    this.pendingHighlight = undefined;
    this.scrollToAndHighlightLine(pending.line, pending.col, pending.scroll);
    this.updateUrlHash();
  }

  private paintCode(body: string, fileUrl: string): void {
    const { contentEl } = this.els;
    // textContent escapes; Prism then walks the node and replaces text
    // with highlighted spans. Doing it this way (rather than innerHTML)
    // keeps untrusted file content from being interpreted as markup.
    contentEl.textContent = body;
    Prism.highlightElement(contentEl);
    linkifyCodeBlock(contentEl, fileUrl);
    this.installGutterClickHandlers();
  }

  // Wire up clicks on each line-number span in the gutter so the user
  // can highlight any line (clearing any prior highlight). The gutter
  // spans are populated by the Prism line-numbers plugin during
  // `Prism.highlightElement`, so this must run after that call.
  private installGutterClickHandlers(): void {
    const rows = this.els.contentEl.querySelector('.line-numbers-rows');
    if (!rows) return;
    rows.classList.add('clickable');
    const spans = rows.children;
    for (let i = 0; i < spans.length; i++) {
      const span = spans[i] as HTMLElement;
      const lineNumber = i + 1;
      span.addEventListener('click', () => {
        this.scrollToAndHighlightLine(lineNumber, undefined, false);
        this.updateUrlHash();
      });
    }
  }

  private scrollToAndHighlightLine(
    tabLine: number,
    col?: number,
    // Gutter clicks pass `false`: the user is clicking on a row
    // they're already looking at, so re-centering it is jarring.
    // Stack-ref clicks (default `true`) need the scroll — the
    // target line may be off-screen or in a different tab.
    scroll = true,
  ): void {
    const { codePaneEl, contentEl } = this.els;
    if (codePaneEl.hidden) return;
    const active = this.tabList[this.activeIdx];
    if (active?.kind === 'code' && typeof active.body !== 'string') {
      // The body is still being fetched, so the code pane holds a
      // placeholder with no line-numbers gutter to measure against.
      // Park the request; `applyPendingHighlight` replays it as soon
      // as the real content paints. `paint()` resolves the thunk into
      // a string before that, so this can't park a second time.
      this.pendingHighlight = { line: tabLine, col, scroll };
      return;
    }
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
      const lineText = this.lineTextAt(tabLine);
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
      bar.style.left = `${flashLeftEm * fontSize + visualCol * this.measureCodeCharWidth()}px`;
      flash.appendChild(bar);
    }

    contentEl.appendChild(flash);

    // Update the tracked highlight state so the URL-hash builder can
    // read the currently-highlighted line/col. Callers that initiate a
    // UI change (gutter click, stack-ref click) then call
    // updateUrlHash() to push this to location.hash.
    this.highlightLine = tabLine;
    this.highlightCol = col;
  }

  private clearLineHighlight(): void {
    for (const prior of Array.from(this.els.contentEl.querySelectorAll('.line-flash'))) {
      prior.remove();
    }
    this.resetHighlight();
  }

  // Forget the current highlight AND any request parked behind a
  // loading body — a parked request belongs to the tab it was made
  // for, and must not replay onto whatever the user switched to.
  private resetHighlight(): void {
    this.highlightLine = undefined;
    this.highlightCol = undefined;
    this.pendingHighlight = undefined;
  }

  // Read the Nth (1-based) line of the currently-displayed source
  // from <code>'s text content. The line-numbers gutter's children
  // are empty spans (line numbers are CSS counters, not text), so
  // textContent reconstructs the source faithfully.
  private lineTextAt(tabLine: number): string {
    const text = this.els.contentEl.textContent ?? '';
    return text.split('\n')[tabLine - 1] ?? '';
  }

  // Cached monospace character width in CSS pixels for the code-pane
  // font. Computed lazily on first highlight; the viewer's font never
  // changes during a session, so a single measurement is enough.
  private measureCodeCharWidth(): number {
    if (this.cachedCharWidth > 0) return this.cachedCharWidth;
    const probe = document.createElement('span');
    // Measure across 20 'M's so sub-pixel rounding averages out.
    probe.textContent = 'M'.repeat(20);
    probe.style.visibility = 'hidden';
    probe.style.position = 'absolute';
    probe.style.whiteSpace = 'pre';
    this.els.contentEl.appendChild(probe);
    const w = probe.getBoundingClientRect().width / 20;
    probe.remove();
    this.cachedCharWidth = w;
    return w;
  }

  // ----- URL fragment navigation ---------------------------------
  //
  // `location.hash` mirrors the current tab + highlight so the URL
  // is copyable and the page reopens in the same place.
  //   <empty>                   main script, no highlight
  //   #Log                      Log tab
  //   #<filename>               that code tab
  //   #<filename>:<line>        + highlighted line
  //   #<filename>:<line>:<col>  + column accent bar
  // See `src/script-url-hash.ts` for the grammar / parser.

  // Push the current view state to `location.hash` via
  // `history.replaceState` (no Back-button entries; no hashchange
  // event re-fires into our own listener). No-op when the fragment
  // is already correct.
  private updateUrlHash(): void {
    const tab = this.tabList[this.activeIdx];
    if (!tab) return;
    const fragment = tab.kind === 'log'
      ? buildHash({ tab: 'log' })
      : buildHash({
          tab: this.activeIdx === 0 ? 'main' : 'require',
          filename: tab.label,
          // A highlight parked behind a loading body counts: dropping
          // it here would strip `:line:col` out of the user's URL
          // while the fetch is in flight, and it isn't put back.
          line: this.highlightLine ?? this.pendingHighlight?.line,
          col: this.highlightCol ?? this.pendingHighlight?.col,
        });
    const desired = fragment ? '#' + fragment : '';
    if (location.hash === desired) return;
    // Empty fragment → drop the `#` from the URL entirely.
    const next = desired || location.pathname + location.search;
    history.replaceState(null, '', next);
  }

  // Resolve a raw hash string against the current tab list. Falls back
  // to the main tab when the filename doesn't match — in that case
  // `line` and `col` are dropped because the line number was relative
  // to the missing file, not main.
  private resolveHashTarget(rawHash: string): { tabIndex: number; line?: number; col?: number } {
    const parsed = parseHash(rawHash);
    if (parsed.kind === 'log') {
      const idx = this.tabList.findIndex((t) => t.kind === 'log');
      return { tabIndex: idx >= 0 ? idx : 0 };
    }
    if (parsed.kind === 'code') {
      const idx = this.tabList.findIndex(
        (t) => t.kind === 'code' && t.label === parsed.filename,
      );
      if (idx >= 0) return { tabIndex: idx, line: parsed.line, col: parsed.col };
    }
    return { tabIndex: 0 };
  }
}

// Convert a 1-based column from V8's stack trace into a 0-based
// visual column count, expanding each tab character to the next
// `tabSize` boundary. V8 counts every tab as one column; the
// viewer renders it as enough spaces to reach the next tab stop.
export function expandToVisualColumn(lineText: string, col: number, tabSize: number): number {
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
