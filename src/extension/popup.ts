// The toolbar popup, "Active scripts" (popup.html): the scripts that
// match the current tab, grouped by collection, with toggles, statuses,
// menu commands and per-script actions. The service worker builds the
// view (src/extension/popup-view.ts, `popupViewForTab` in background.ts);
// this page renders it and sends back what the person clicks. Design:
// docs/status-popup.md.
//
// Opened by the worker with `action.openPopup`, it shows the active tab
// of its own window. `?tab=<id>` names a tab instead, so tests can open
// the page in an ordinary tab; `&close=1` then has it close itself as
// a popup would.

import {
  COLLECTION_OFF_LABEL,
  COLLECTION_OFF_TOOLTIP,
  POPUP_CHANGED_MESSAGE,
  POPUP_CLOSE_MESSAGE,
  POPUP_CLOSING_MESSAGE,
  POPUP_COMMAND_MESSAGE,
  POPUP_NO_SCRIPTS,
  POPUP_RUN_SCRIPT_MESSAGE,
  RUN_SCRIPT_LABEL,
  POPUP_NOT_INJECTABLE,
  POPUP_PORT_PREFIX,
  POPUP_RELOAD_MESSAGE,
  POPUP_SET_ENABLED_MESSAGE,
  POPUP_SET_COMMANDS_OPEN_MESSAGE,
  POPUP_STATUS_LABELS,
  POPUP_VIEW_MESSAGE,
  RELOAD_NO_SCRIPTS_LABEL,
  RELOAD_WITH_LABEL,
  REMOVED_GROUP_ID,
  RERUN_UPDATED_ALL_LABEL,
  RERUN_UPDATED_LABEL,
  RUN_ENABLED_LABEL,
  RUN_NOW_LABEL,
  RUN_NOW_WARNING_OTHER_COPY,
  runNowTooltip,
  type PopupChangedMessage,
  type PopupClosingMessage,
  type PopupCommandRequest,
  type PopupRunScriptRequest,
  type PopupGroup,
  type PopupReloadRequest,
  type PopupRow,
  type PopupSetCommandsOpenRequest,
  type PopupSetEnabledRequest,
  type PopupStatus,
  type PopupView,
  type PopupViewRequest,
  type ReloadMode,
} from './popup-view.js';
import { SM_DEV_CONTROL_LABEL } from './tab-status.js';
import { closeMenu, moreMenuButton, openMenu as openSharedMenu, type MenuItem as SharedMenuItem } from './more-menu.js';
import { collectionAnchorId, EDIT_COLLECTION_HASH_PREFIX, makeCollectionTypeBubble } from './collection-display.js';
import {
  namedPageUrl, openBackgroundTab, openExtensionTab, openExtensionWindow, openHow, openNamedTab, type NamedPage,
  type OpenHow,
} from './page-links.js';
import { touchesStructuralRows } from './structural-keys.js';
import { enableTitle, watchSoloModifier } from './solo-click.js';
import { ENABLE_TITLE, viewerUrl } from '../script-display.js';
import { ignoreResizeObserverLoopErrors } from './resize-observer-loop.js';
import { probeUserScriptsApi, USER_SCRIPTS_OFF_HEADING, userScriptsFixLine } from './user-scripts-access.js';

// The checkbox tooltip's second line under a disabled collection: the
// box still sets the script's own flag, which has no effect for now.
const SCRIPT_COLLECTION_OFF_HINT = 'Script will not run because its collection is disabled';

// The page menu's run of several scripts, hidden when there are none.
function runAllItem(label: string, all: PopupView['runEnabled']): MenuItem {
  return {
    label, hidden: !all, warning: runNowTooltip(all?.warnings ?? []),
    run: () => runScripts(all?.ids ?? []),
  };
}

// Why a disabled script's per-script reloads are greyed.
const INACTIVE_RELOAD_TITLE = 'This script is disabled, so it isn\'t running on this page';

// More menu commands than this start collapsed behind a disclosure row.
const COMMANDS_SHOWN_OPEN = 4;

const params = new URLSearchParams(location.search);
const tabParam = params.get('tab');
// In a real popup, opening a page or running a command should close
// it, as Chrome's own menus do. In a tab (tests) there is nothing to
// close, unless `&close=1` asks for the popup's behavior anyway.
const inPopup = tabParam === null || params.has('close');

const bannersEl = document.getElementById('banners') as HTMLElement;
const scriptsEl = document.getElementById('scripts') as HTMLElement;
const pageMenuBtn = document.getElementById('page-menu') as HTMLButtonElement;

let tabId: number | null = null;
// The current port to the worker (`connectToWorker`).
let workerPort: chrome.runtime.Port | null = null;
let view: PopupView | null = null;
// "Allow User Scripts" is off, so nothing injects: probed by the popup
// itself on each refresh, since the view comes from the worker.
let userScriptsOff = false;
// Scripts whose command list the person opened or closed in this popup,
// overriding the default (closed past COMMANDS_SHOWN_OPEN). The worker
// keeps them for the tab's lifetime (`view.commandsOpen`); these cover
// a toggle until the next view brings it back.
const commandsOpen = new Map<string, boolean>();

// The Open button and the header's home links (icon, product name).
for (const home of document.querySelectorAll<HTMLElement>('#open-collections, a.page-home')) {
  onOpenClick(home, namedPageUrl('collections'), () => openNamedTab('collections').then(closeSoon));
}
pageMenuBtn.addEventListener('click', () => {
  openMenu(pageMenuBtn, [
    // A plain reload, every script included. The popup stays open
    // through it, as for the selective reloads, and redraws.
    { label: 'Reload page', run: () => reloadPlain(), hidden: tabId === null },
    {
      label: RELOAD_NO_SCRIPTS_LABEL,
      run: () => reloadTab({ kind: 'none' }),
      // Nothing to keep out on a page no script matches.
      hidden: !view?.perScriptReload
        || (view.enabled.length === 0 && view.frames.length === 0 && view.disabled.length === 0),
    },
    // Rather than reloading for them: docs/run-now.md.
    { separator: true, hidden: !view?.runEnabled && !view?.rerunUpdated },
    runAllItem(RUN_ENABLED_LABEL, view?.runEnabled),
    runAllItem(RERUN_UPDATED_ALL_LABEL, view?.rerunUpdated),
    { separator: true, hidden: !view?.runEnabled && !view?.rerunUpdated },
    namedPageItem('SourceMonkey options', 'options'),
  ]);
});

async function start(): Promise<void> {
  tabId = tabParam !== null ? Number(tabParam) : await activeTabId();
  if (tabId !== null) connectToWorker(tabId);
  // Names, enabled flags and the collection list live in storage. Only
  // those rows: the session area churns with every tab's state and
  // every Log entry, and the worker reports this tab's state itself.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && touchesStructuralRows(Object.keys(changes))) scheduleRefresh();
  });
  await refresh();
}

// The port the worker reports this tab's changes over (badge state,
// menu commands). It drops when the worker goes idle or restarts, so it
// is reopened, with a refresh for whatever was missed meanwhile.
function connectToWorker(id: number): void {
  const port = chrome.runtime.connect({ name: POPUP_PORT_PREFIX + id });
  workerPort = port;
  port.onMessage.addListener((message) => {
    const type = (message as Partial<PopupChangedMessage> | null)?.type;
    if (type === POPUP_CHANGED_MESSAGE) scheduleRefresh();
    else if (type === POPUP_CLOSE_MESSAGE) closeSoon();
  });
  port.onDisconnect.addListener(() => {
    // Read, so Chrome doesn't report it as unchecked.
    void chrome.runtime.lastError;
    setTimeout(() => {
      connectToWorker(id);
      scheduleRefresh();
    }, 1000);
  });
}

async function activeTabId(): Promise<number | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

// Changes come in bursts (a toggle writes storage, then the worker
// re-badges every tab), so they collapse into one redraw.
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleRefresh(): void {
  if (refreshTimer !== null) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    quietly(refresh());
  }, 50);
}

// Refreshes can overlap (a toggle's storage write, then the worker's
// report), and their replies can arrive out of order: only the latest
// request's reply is drawn.
let refreshSeq = 0;
// The last view drawn, serialized, so a refresh that changed nothing
// doesn't redraw (which would close an open menu).
let drawnJson: string | null = null;

async function refresh(): Promise<void> {
  if (tabId === null) {
    render(null);
    return;
  }
  const seq = ++refreshSeq;
  const req: PopupViewRequest = { type: POPUP_VIEW_MESSAGE, tabId, keepIds: layoutIds(), keepUrl: layoutUrl ?? undefined };
  let next: PopupView | null;
  const probe = probeUserScriptsApi();
  try {
    next = (await chrome.runtime.sendMessage(req)) as PopupView | null;
  } catch {
    next = null;
  }
  const off = !(await probe).usable;
  if (seq !== refreshSeq) return;
  recheckBannerAt(next?.bannerRecheckAt ?? null);
  const json = JSON.stringify({ next, off });
  if (json === drawnJson) return;
  drawnJson = json;
  view = next;
  userScriptsOff = off;
  render(view);
}

// A refresh for when the page stops settling, which nothing reports
// should the worker's own post-load check not come first.
let recheckTimer: ReturnType<typeof setTimeout> | null = null;

function recheckBannerAt(at: number | null): void {
  if (recheckTimer !== null) clearTimeout(recheckTimer);
  recheckTimer = at === null ? null : setTimeout(() => {
    recheckTimer = null;
    scheduleRefresh();
  }, Math.max(0, at - Date.now()) + 100);
}

function closeSoon(): void {
  if (!inPopup) return;
  // So the worker doesn't take this close for the second click of a
  // double click on the icon.
  const msg: PopupClosingMessage = { type: POPUP_CLOSING_MESSAGE };
  try {
    workerPort?.postMessage(msg);
  } catch {
    // Disconnected; nothing is waiting on it.
  }
  window.close();
}

// Run a click's action, logging rather than dropping a failure (the tab
// closed meanwhile, say). An unhandled rejection in an extension page
// lands in chrome://extensions/?errors, where it reads as SourceMonkey
// being broken.
function quietly(work: Promise<unknown>): void {
  work.catch((err) => console.info('[SourceMonkey] popup action failed:', err));
}

// ---------- Rendering ----------

// Whether script rows are on screen, so a banner coming or going now
// does so under the pointer, rather than as part of the first draw.
let listShown = false;

function render(v: PopupView | null): void {
  // A redraw while a menu is open would leave it pointing at a button
  // that is gone.
  closeMenu();
  // Emptying the scroll box would scroll it back to the top.
  const scrollTop = scriptsEl.scrollTop;
  const listHeight = scriptsEl.clientHeight;
  const scrolling = scriptsEl.scrollHeight > scriptsEl.clientHeight;
  const bannersHeight = bannersEl.offsetHeight;
  const anchor = listShown ? topAnchor() : null;
  try {
    draw(v);
  } finally {
    scriptsEl.scrollTop = scrollTop;
    const grew = bannersEl.offsetHeight - bannersHeight;
    if (grew !== 0 && listShown) keepListInPlace(grew, scrollTop, listHeight, scrolling);
    if (anchor) restoreAnchor(anchor);
    listShown = scriptsEl.querySelector('.row') !== null;
  }
}

// The redraw replaces every row, which leaves Chrome's own scroll
// anchoring nothing to hold on to. So it is done here: the row or
// collection heading at the top of the list's view stays where it was
// on screen. Otherwise a row above it changing height (a command list
// coming or going after a reload, a pill rewrapping its name) would
// move everything in view.
interface Anchor { key: string; top: number }

function topAnchor(): Anchor | null {
  const listTop = scriptsEl.getBoundingClientRect().top;
  for (const e of scriptsEl.querySelectorAll('.row, .group-head')) {
    const r = e.getBoundingClientRect();
    if (r.bottom > listTop) return { key: anchorKey(e), top: r.top };
  }
  return null;
}

function restoreAnchor(anchor: Anchor): void {
  for (const e of scriptsEl.querySelectorAll('.row, .group-head')) {
    if (anchorKey(e) !== anchor.key) continue;
    scriptsEl.scrollTop += e.getBoundingClientRect().top - anchor.top;
    return;
  }
}

// A collection can head a group in more than one section; a script is
// in just one.
function anchorKey(e: Element): string {
  const section = e.closest('section')?.getAttribute('data-section') ?? '';
  const script = e.getAttribute('data-script-id');
  return script ? `script:${script}` : `${section}:${e.getAttribute('data-collection-id') ?? ''}`;
}

// A banner appeared above the list while the popup was open (the
// reload banner, after a toggle). Keep the rows where they were, so the
// one just clicked stays under the pointer: the banner covers the top
// of the list's view rather than pushing it down.
// - Already scrolling, the popup is at its full height and the list
//   just got shorter: scroll it on by the banner's height.
// - Not scrolling, pin the list to its old height less the banner's,
//   scrolled down by that much. Scrolling back up grows the popup
//   instead (`growPinnedList`), and the pin goes once the top is back.
// - Not when the banner would hide more than it leaves: then the popup
//   just grows.
// The banner going (ticking the box back, say) undoes this: the list
// scrolls back by as much, and a pinned one grows into the space.
// The list has no padding or border, so its heights are its content's.
function keepListInPlace(grew: number, scrollTop: number, listHeight: number, scrolling: boolean): void {
  const pinned = scriptsEl.style.maxHeight !== '';
  if (grew < 0 && pinned) {
    scriptsEl.style.maxHeight = `${listHeight - grew}px`;
  } else if (grew > 0 && !scrolling) {
    if (listHeight - grew < grew) return;
    scriptsEl.style.maxHeight = `${listHeight - grew}px`;
  } else if (!scrolling) {
    return;
  }
  scriptsEl.scrollTop = scrollTop + grew;
  growPinnedList();
}

// Only grows: rows added while pinned (a command list opened, say) are
// scrolled to as usual, without the popup shrinking.
function growPinnedList(): void {
  if (!scriptsEl.style.maxHeight) return;
  if (scriptsEl.scrollTop <= 0) unpinList();
  else {
    const height = Math.max(parseFloat(scriptsEl.style.maxHeight), scriptsEl.scrollHeight - scriptsEl.scrollTop);
    scriptsEl.style.maxHeight = `${height}px`;
  }
}

function unpinList(): void {
  scriptsEl.style.maxHeight = '';
}

scriptsEl.addEventListener('scroll', growPinnedList);

// The popup is always wider by a scrollbar (see popup.html). Without
// one, the rows pad that strip (`--gutter`); with one, the scrollbar
// fills it. Either way the rows keep their width and don't rewrap. The
// list's content box changes width as a scrollbar comes or goes, which
// the observer sees before the frame is painted.
const scrollbarWidth = measureScrollbar();
document.body.style.setProperty('--scrollbar-width', `${scrollbarWidth}px`);
// Set before the first frame too, so the first frame needs no fix-up.
// Later, when a scrollbar comes or goes, the frame lays out once with
// both scrollbar and gutter; a row can rewrap, and the observer's fix
// resizes the list again in the same frame. Chrome reports that as a
// ResizeObserver loop error, which is harmless and kept out of the
// Errors panel.
scriptsEl.style.setProperty('--gutter', `${scrollbarWidth}px`);
ignoreResizeObserverLoopErrors();
new ResizeObserver(() => {
  const scrolling = scriptsEl.offsetWidth > scriptsEl.clientWidth;
  scriptsEl.style.setProperty('--gutter', scrolling ? '0px' : `${scrollbarWidth}px`);
}).observe(scriptsEl);

// At a fractional scale (`devicePixelRatio` 1.359375, say), a popup
// of whole CSS px can end partway through a screen pixel: 223px is
// 303.14 screen rows. Chrome shows only the whole rows (303, which
// `visualViewport` reports), but places the fixed border overlay as if
// the page went on to the next whole row (304). Its bottom line then
// falls in the row that isn't shown. So the overlay ends short by the
// rows not shown (none at a whole-number scale). Chrome resizes the
// popup as its content changes, which fires `resize`.
// - The small epsilon keeps float error from rounding up a product
//   that should be whole (200 * 1.1 is 220.00000000000003).
// - At most one screen pixel: anything more (a page scrollbar or pinch
//   zoom in a tab, where `visualViewport` is smaller for other
//   reasons) isn't this rounding.
function trimEdges(): void {
  const dpr = window.devicePixelRatio;
  const trim = (laid: number, shown: number) => {
    const rows = Math.ceil(laid * dpr - 1e-6) - Math.round(shown * dpr);
    return `${Math.min(Math.max(rows, 0), 1) / dpr}px`;
  };
  document.body.style.setProperty('--edge-trim-x', trim(window.innerWidth, visualViewport!.width));
  document.body.style.setProperty('--edge-trim-y', trim(window.innerHeight, visualViewport!.height));
}
trimEdges();
window.addEventListener('resize', trimEdges);

function measureScrollbar(): number {
  const probe = el('div', { style: 'position: absolute; visibility: hidden; overflow: scroll; width: 100px' });
  document.body.append(probe);
  const width = probe.offsetWidth - probe.clientWidth;
  probe.remove();
  return width;
}

function draw(v: PopupView | null): void {
  bannersEl.replaceChildren();
  scriptsEl.replaceChildren();
  document.body.dataset.ready = 'true';
  // On every page: it's why no page runs scripts.
  if (userScriptsOff) {
    bannersEl.append(el('div', { class: 'banner-row user-scripts-off' },
      el('span', {}, el('strong', {}, USER_SCRIPTS_OFF_HEADING), userScriptsFixLine('span'))));
  }
  if (!v || !v.injectable) {
    scriptsEl.append(el('div', { class: 'empty-page' }, POPUP_NOT_INJECTABLE));
    return;
  }
  if (v.smDev) bannersEl.append(el('div', { class: 'banner-row sm-dev' }, el('span', {}, SM_DEV_CONTROL_LABEL)));
  // Not while user scripts are off: a reload wouldn't run them. Once
  // they're on again, a page that loaded meanwhile asks for a reload
  // (UNTRACKED).
  if (v.banner && !userScriptsOff) {
    const reload = el('button', { type: 'button' }, 'Reload');
    reload.addEventListener('click', () => quietly(reloadPlain()));
    bannersEl.append(el('div', { class: 'banner-row reload' }, el('span', {}, v.banner), reload));
  }
  const { enabled, frames, manual, disabled } = arrange(v);
  if (enabled.length === 0 && frames.length === 0 && manual.length === 0 && disabled.length === 0) {
    scriptsEl.append(el('div', { class: 'empty-page' }, POPUP_NO_SCRIPTS));
    return;
  }
  renderSection('Enabled', enabled, 'No enabled scripts match this page.');
  // Only when there are some: scripts that run in the page's iframes
  // without matching the page itself (docs/frames.md).
  if (frames.length > 0) renderSection('Active in frames', frames, '');
  // Only when there are some: most pages have no manual scripts.
  if (manual.length > 0) renderSection('Manual', manual, '');
  renderSection('Disabled', disabled, 'None');
}

// ---------- A layout that stays put ----------
//
// Where each row sits (section, collection group, order) is fixed by
// the first view, and kept for as long as the popup is open. A toggle
// or a reload then changes rows in place rather than moving them, so
// the row under the pointer stays under it. Reopening the popup sorts
// afresh.
//
// The worker is sent every id placed here (`keepIds`), so a placed row
// keeps being listed even when another copy of its script becomes the
// one the identity rule would pick.

type SectionKey = 'enabled' | 'frames' | 'manual' | 'disabled';
const SECTION_KEYS: readonly SectionKey[] = ['enabled', 'frames', 'manual', 'disabled'];
interface PlacedGroup { collectionId: string; ids: string[] }
let layout: Record<SectionKey, PlacedGroup[]> | null = null;
// The URL the layout was placed for. On another URL (the page
// navigated) it's another page's layout, and is placed afresh.
let layoutUrl: string | null = null;

function layoutIds(): string[] {
  if (!layout) return [];
  return SECTION_KEYS.flatMap((k) => layout![k]).flatMap((g) => g.ids);
}

function arrange(v: PopupView): Record<SectionKey, PopupGroup[]> {
  // Where the view would put each row now.
  const fresh = new Map<string, { row: PopupRow; collectionId: string; section: SectionKey }>();
  for (const section of SECTION_KEYS) {
    for (const g of v[section]) for (const row of g.rows) fresh.set(row.id, { row, collectionId: g.collection.id, section });
  }
  if (layoutUrl !== v.url) {
    layout = null;
    layoutUrl = v.url;
  }
  if (!layout) {
    const place = (groups: PopupGroup[]): PlacedGroup[] =>
      groups.map((g) => ({ collectionId: g.collection.id, ids: g.rows.map((r) => r.id) }));
    layout = { enabled: place(v.enabled), frames: place(v.frames), manual: place(v.manual), disabled: place(v.disabled) };
  } else {
    // A row whose collection changed (the script moved) leaves its old
    // group; then anything not placed yet goes at the end of its group,
    // or in a new group at the end of its section.
    const placed = new Set<string>();
    for (const section of SECTION_KEYS) {
      for (const g of layout[section]) {
        g.ids = g.ids.filter((id) => {
          const now = fresh.get(id);
          return !now || now.collectionId === g.collectionId;
        });
        for (const id of g.ids) placed.add(id);
      }
    }
    for (const [id, info] of fresh) {
      if (placed.has(id)) continue;
      const groups = layout[info.section];
      let group = groups.find((g) => g.collectionId === info.collectionId);
      if (!group) {
        group = { collectionId: info.collectionId, ids: [] };
        groups.push(group);
      }
      group.ids.push(id);
    }
  }
  const collections = new Map(v.collections.map((c) => [c.id, c]));
  const build = (groups: PlacedGroup[]): PopupGroup[] => groups
    .map((g) => ({
      collection: collections.get(g.collectionId)!,
      // A row the view no longer has (its script was deleted) drops out.
      rows: g.ids.map((id) => fresh.get(id)?.row).filter((r): r is PopupRow => r !== undefined),
    }))
    .filter((g) => g.collection !== undefined && g.rows.length > 0);
  return {
    enabled: build(layout.enabled), frames: build(layout.frames), manual: build(layout.manual), disabled: build(layout.disabled),
  };
}

function renderSection(title: string, groups: PopupGroup[], emptyText: string): void {
  const section = el('section', { class: 'script-section', 'data-section': title.toLowerCase().replace(/ /g, '-') });
  section.append(el('div', { class: 'section-head' }, title));
  if (groups.length === 0) section.append(el('div', { class: 'empty-note' }, emptyText));
  for (const group of groups) {
    section.append(groupHead(group));
    for (const row of group.rows) section.append(scriptRow(row, group));
  }
  scriptsEl.append(section);
}

// A pill whose click reloads the page, as the banner's Reload does.
function reloadPill(row: PopupRow, status: PopupStatus): HTMLElement {
  const pill = el('button', {
    type: 'button',
    class: `pill ${PILL_CLASSES[status]}`,
    title: row.tooltip ?? '',
    'data-status': status,
  }, POPUP_STATUS_LABELS[status]);
  pill.addEventListener('click', () => quietly(reloadPlain()));
  return pill;
}

function groupHead(group: PopupGroup): HTMLElement {
  const c = group.collection;
  // Scripts removed since the page loaded: a plain heading, with no
  // collection to open or toggle.
  if (c.id === REMOVED_GROUP_ID) {
    return el('div', { class: 'group-head', 'data-collection-id': c.id },
      el('span', { class: 'collection-name' }, c.name));
  }
  const hash = collectionAnchorId(c.id);
  const name = el('a', {
    class: 'collection-name', href: namedPageUrl('collections', hash), target: '_blank',
    title: 'Show this collection on the collections page',
  }, c.name);
  onOpenClick(name, namedPageUrl('collections', hash), () => openNamedTab('collections', { hash }).then(closeSoon));
  const off = !c.enabled;
  const menuBtn = moreMenuButton('Collection actions');
  menuBtn.addEventListener('click', () => openMenu(menuBtn, [
    namedPageItem('Collection details', 'collections', hash),
    {
      label: off ? 'Enable collection' : 'Disable collection',
      run: () => setEnabled('collection', c.id, off),
    },
    namedPageItem('Collection options', 'collections', EDIT_COLLECTION_HASH_PREFIX + c.id),
  ]));
  const head = el('div', { class: 'group-head' + (off ? ' off' : ''), 'data-collection-id': c.id },
    name, makeCollectionTypeBubble(c.path));
  if (off) head.append(el('span', { class: 'collection-off', title: COLLECTION_OFF_TOOLTIP }, COLLECTION_OFF_LABEL));
  head.append(el('span', { class: 'spacer' }), menuBtn);
  return head;
}

const PILL_CLASSES: Record<PopupStatus, string> = {
  OK: 'ok', ERROR: 'error', REJECTED: 'rejected', RELOAD: 'reload', MISSING: 'missing',
  UNEXPECTED: 'unexpected', NOT_LOADED: 'not-loaded', UNTRACKED: 'untracked', PENDING: 'pending', STILL_RUNNING: 'still-running',
  WARNING: 'warning', INVALID: 'invalid', NOT_RUN: 'not-run',
};

function scriptRow(row: PopupRow, group: PopupGroup): HTMLElement {
  if (group.collection.id === REMOVED_GROUP_ID) return removedRow(row);
  const boxTitle = group.collection.enabled
    ? enableTitle(row.otherCopies)
    : `${ENABLE_TITLE}\n${SCRIPT_COLLECTION_OFF_HINT}`;
  const box = el('input', { type: 'checkbox', title: boxTitle }) as HTMLInputElement;
  box.checked = row.checked;
  // Exclusive, as everywhere: turning it on turns the script's other
  // active copies off, unless Ctrl/Cmd-clicked.
  const takeSolo = watchSoloModifier(box);
  box.addEventListener('change', () => quietly(setEnabled('script', row.id, box.checked, takeSolo())));

  const name = el('a', { class: 'script-name', href: viewerUrl(row.id), target: '_blank', title: 'Open the script page' }, row.name);
  onOpenClick(name, viewerUrl(row.id));

  const main = el('div', { class: 'row-main' }, box, name);
  if (row.status === 'PENDING' || row.status === 'UNTRACKED') {
    // Reload to run, or Reload: a click does just that.
    main.append(reloadPill(row, row.status));
  } else if (row.status) {
    const pill = el('a', {
      class: `pill ${PILL_CLASSES[row.status]}`,
      href: viewerUrl(row.id, 'log'),
      target: '_blank',
      title: row.tooltip ?? '',
      'data-status': row.status,
    }, POPUP_STATUS_LABELS[row.status]);
    onOpenClick(pill, viewerUrl(row.id, 'log'));
    main.append(pill);
  }
  const menuBtn = moreMenuButton('Script actions');
  // Not for a manual script: no reload runs it, so running it alone or
  // keeping it out is nothing.
  const perScriptReload = view?.perScriptReload === true && !row.manual;
  // A script that's off: "Reload page with this script" stands in for
  // the two that would do nothing, unless it failed to load.
  const reloadWith = perScriptReload && !row.active && row.status !== 'INVALID';
  const run = row.runNow;
  menuBtn.addEventListener('click', () => openMenu(menuBtn, [
    pageItem('Script details', viewerUrl(row.id)),
    pageItem('Script log', viewerUrl(row.id, 'log')),
    { separator: true, hidden: !perScriptReload },
    // Greyed for a script that won't run (its box or its collection is
    // off) and can't be run either: running it alone or keeping it out
    // would do nothing.
    {
      label: 'Reload page with only this script', run: () => reloadTab({ kind: 'only', scriptId: row.id }),
      hidden: !perScriptReload || reloadWith, disabled: !row.active, title: row.active ? undefined : INACTIVE_RELOAD_TITLE,
    },
    {
      label: 'Reload page without this script', run: () => reloadTab({ kind: 'without', scriptId: row.id }),
      hidden: !perScriptReload || reloadWith, disabled: !row.active, title: row.active ? undefined : INACTIVE_RELOAD_TITLE,
    },
    {
      label: RELOAD_WITH_LABEL, run: () => reloadTab({ kind: 'with', scriptId: row.id }),
      hidden: !reloadWith, warning: runNowTooltip(run?.warnings.filter((w) => w === RUN_NOW_WARNING_OTHER_COPY) ?? []),
    },
    { separator: true, hidden: !run },
    {
      label: run?.kind === 'rerun' ? RERUN_UPDATED_LABEL : RUN_NOW_LABEL,
      run: () => runScripts([row.id]),
      hidden: !run, warning: runNowTooltip(run?.warnings ?? []),
    },
  ]));
  main.append(menuBtn);

  const cls = 'row' + (row.active ? '' : ' off') + (row.checked && !group.collection.enabled ? ' muted' : '');
  const out = el('div', { class: cls, 'data-script-id': row.id }, main);
  if (row.versionLine) out.append(el('div', { class: 'version-line' }, row.versionLine));
  if (row.commands.length > 0 || row.runnable) out.append(commandList(row));
  return out;
}

// A script removed since the page loaded that still runs in it: its
// name, status and menu commands, with nothing to toggle or open.
function removedRow(row: PopupRow): HTMLElement {
  const main = el('div', { class: 'row-main' }, el('span', { class: 'script-name' }, row.name));
  if (row.status) {
    main.append(el('span', {
      class: `pill ${PILL_CLASSES[row.status]}`, title: row.tooltip ?? '', 'data-status': row.status,
    }, POPUP_STATUS_LABELS[row.status]));
  }
  const out = el('div', { class: 'row off', 'data-script-id': row.id }, main);
  if (row.commands.length > 0) out.append(commandList(row));
  return out;
}

function commandList(row: PopupRow): HTMLElement {
  const list = el('div', { class: 'commands' });
  // A manual script's own item comes first, and never folds away with
  // the script's commands.
  if (row.runnable) {
    const run = el('button', { type: 'button', class: 'command run-script' }, RUN_SCRIPT_LABEL);
    run.addEventListener('click', () => quietly(runScripts([row.id])));
    list.append(run);
  }
  if (row.commands.length === 0) return list;
  const long = row.commands.length > COMMANDS_SHOWN_OPEN;
  const open = commandsOpen.get(row.id) ?? view?.commandsOpen?.[row.id] ?? !long;
  if (long) {
    const toggle = el('button', { type: 'button', class: 'disclose', 'aria-expanded': String(open) },
      open ? '▾ Hide commands' : `▸ ${row.commands.length} commands`);
    toggle.addEventListener('click', () => {
      commandsOpen.set(row.id, !open);
      render(view);
      if (tabId !== null) {
        const req: PopupSetCommandsOpenRequest = {
          type: POPUP_SET_COMMANDS_OPEN_MESSAGE, tabId, scriptId: row.id, open: !open,
        };
        quietly(chrome.runtime.sendMessage(req));
      }
    });
    list.append(toggle);
  }
  if (!open) return list;
  for (const cmd of row.commands) {
    const btn = el('button', { type: 'button', class: 'command' }, cmd.name);
    btn.addEventListener('click', () => quietly(runCommand(row.id, cmd.commandId, cmd.documentId)));
    list.append(btn);
  }
  return list;
}

// How a click on something that opens a page opens it (`openHow` in
// src/extension/page-links.ts). In the popup:
// - plain: `openPlain`, then the popup closes;
// - background: the popup (and any menu) stays open, to open several
//   pages in a row;
// - tab, window: the popup closes, since they leave it behind.
// Handled here even on links: Chrome closes a real popup when a link
// opens a tab its own way.
//
// Wire `target` to open `url` by the click's gesture. `openPlain`
// defaults to a plain new tab. Each closes the popup only once the page
// is open: closing it ends this page, and an open still in flight with
// it. The middle button fires `auxclick`, not `click`.
function onOpenClick(
  target: HTMLElement, url: string,
  openPlain: () => Promise<unknown> = () => openExtensionTab(url).then(closeSoon),
  onOpened?: (how: OpenHow) => void,
): void {
  const handle = (ev: MouseEvent): void => {
    const how = openHow(ev);
    if (!how) return;
    ev.preventDefault();
    onOpened?.(how);
    if (how === 'plain') quietly(openPlain());
    else if (how === 'background') quietly(openBackgroundTab(url));
    else if (how === 'tab') quietly(openExtensionTab(url).then(closeSoon));
    else quietly(openExtensionWindow(url).then(closeSoon));
  };
  target.addEventListener('click', handle);
  target.addEventListener('auxclick', handle);
}

// ---------- Actions ----------

async function reloadPlain(): Promise<void> {
  if (tabId !== null) await chrome.tabs.reload(tabId);
}

async function reloadTab(mode: ReloadMode): Promise<void> {
  if (tabId === null) return;
  const req: PopupReloadRequest = { type: POPUP_RELOAD_MESSAGE, tabId, mode };
  await chrome.runtime.sendMessage(req);
}

async function runCommand(scriptId: string, commandId: string, documentId?: string): Promise<void> {
  if (tabId === null) return;
  const req: PopupCommandRequest = {
    type: POPUP_COMMAND_MESSAGE, tabId, scriptId, commandId, ...(documentId ? { documentId } : {}),
  };
  await chrome.runtime.sendMessage(req);
  closeSoon();
}

// Run scripts now: a manual script's Run, or "Run now". The popup stays
// open, so the rows' statuses and any commands the runs register show
// up as they arrive.
async function runScripts(scriptIds: string[]): Promise<void> {
  if (tabId === null || scriptIds.length === 0) return;
  const req: PopupRunScriptRequest = { type: POPUP_RUN_SCRIPT_MESSAGE, tabId, scriptIds };
  await chrome.runtime.sendMessage(req);
}

// Ticks a script's or collection's box. The worker writes the row, and
// the storage change redraws the popup. When the write fails nothing
// changes, so the view would match the one drawn and be skipped: forget
// it, so the redraw puts the box back as stored.
// `solo`: Ctrl/Cmd-clicked, so other copies are left alone
// (docs/script-enablement.md).
async function setEnabled(
  target: PopupSetEnabledRequest['target'], id: string, enabled: boolean, solo = false,
): Promise<void> {
  const req: PopupSetEnabledRequest = { type: POPUP_SET_ENABLED_MESSAGE, target, id, enabled, solo };
  const reply = (await chrome.runtime.sendMessage(req)) as { ok?: boolean } | null;
  if (reply?.ok !== true) {
    drawnJson = null;
    await refresh();
  }
}

// ---------- Menus ----------

// The popup's items: a page item (`url`) opens by any of
// `onOpenClick`'s gestures, and a background open leaves the menu up.
interface MenuItem extends Omit<SharedMenuItem, 'run'> {
  run?: () => Promise<unknown>;
  // The page `run` opens, for the other ways to open it (`onOpenClick`).
  url?: string;
}

// Menu items that open a page, by any of `onOpenClick`'s gestures.
function pageItem(label: string, url: string): MenuItem {
  return { label, run: () => openExtensionTab(url).then(closeSoon), url };
}

function namedPageItem(label: string, page: NamedPage, hash?: string): MenuItem {
  return { label, run: () => openNamedTab(page, { hash }).then(closeSoon), url: namedPageUrl(page, hash) };
}

function openMenu(btn: HTMLButtonElement, items: MenuItem[]): void {
  openSharedMenu(btn, items.map(({ url, run, ...rest }): SharedMenuItem => {
    if (url && run) {
      return { ...rest, wire: (b, close) => onOpenClick(b, url, run, (how) => { if (how !== 'background') close(); }) };
    }
    return { ...rest, ...(run ? { run: () => quietly(run()) } : {}) };
  }));
}

function el(tag: string, attrs: Record<string, string> = {}, ...kids: (Node | string)[]): HTMLElement {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else e.setAttribute(k, v);
  }
  e.append(...kids);
  return e;
}

// Last, so every module-level binding above is initialized before the
// first render reads it.
quietly(start());
