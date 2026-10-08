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
  POPUP_STATUS_LABELS,
  POPUP_VIEW_MESSAGE,
  RELOAD_NO_SCRIPTS_LABEL,
  REMOVED_GROUP_ID,
  type PopupChangedMessage,
  type PopupClosingMessage,
  type PopupCommandRequest,
  type PopupRunScriptRequest,
  type PopupGroup,
  type PopupReloadRequest,
  type PopupRow,
  type PopupSetEnabledRequest,
  type PopupStatus,
  type PopupView,
  type PopupViewRequest,
  type ReloadMode,
} from './popup-view.js';
import { SM_DEV_CONTROL_LABEL } from './tab-status.js';
import { collectionAnchorId, EDIT_COLLECTION_HASH_PREFIX, makeCollectionTypeBubble } from './collection-display.js';
import { installHomeLinkHandler, namedPageUrl, openExtensionTab, openNamedTab } from './page-links.js';
import { touchesStructuralRows } from './structural-keys.js';
import { enableTitle, watchSoloModifier } from './solo-click.js';
import { ENABLE_TITLE, viewerUrl } from '../script-display.js';

// The checkbox tooltip's second line under a disabled collection: the
// box still sets the script's own flag, which has no effect for now.
const SCRIPT_COLLECTION_OFF_HINT = 'Script will not run because its collection is disabled';

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
const reloadBarEl = document.getElementById('reload-bar') as HTMLElement;
const scriptsEl = document.getElementById('scripts') as HTMLElement;
const pageMenuBtn = document.getElementById('page-menu') as HTMLButtonElement;

let tabId: number | null = null;
// The current port to the worker (`connectToWorker`).
let workerPort: chrome.runtime.Port | null = null;
let view: PopupView | null = null;
// Scripts whose command list the person opened or closed, overriding
// the default (closed past COMMANDS_SHOWN_OPEN). For as long as the
// popup is open.
const commandsOpen = new Map<string, boolean>();

installHomeLinkHandler();
document.getElementById('open-collections')!.addEventListener('click', () => {
  quietly(openNamedTab('collections').then(closeSoon));
});
pageMenuBtn.addEventListener('click', () => {
  openMenu(pageMenuBtn, [
    // A plain reload, every script included. The popup stays open
    // through it, as for the selective reloads, and redraws.
    { label: 'Reload page', run: () => reloadPlain(), hidden: tabId === null },
    {
      label: RELOAD_NO_SCRIPTS_LABEL,
      run: () => reloadTab({ kind: 'none' }),
      // Nothing to keep out on a page no script matches.
      hidden: !view?.perScriptReload || (view.enabled.length === 0 && view.disabled.length === 0),
    },
    { label: 'SourceMonkey options', run: () => openNamedTab('options').then(closeSoon) },
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
  try {
    next = (await chrome.runtime.sendMessage(req)) as PopupView | null;
  } catch {
    next = null;
  }
  if (seq !== refreshSeq) return;
  recheckBannerAt(next?.bannerRecheckAt ?? null);
  const json = JSON.stringify(next);
  if (json === drawnJson) return;
  drawnJson = json;
  view = next;
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

function render(v: PopupView | null): void {
  // A redraw while a menu is open would leave it pointing at a button
  // that is gone.
  closeMenu();
  // Emptying the scroll box would scroll it back to the top.
  const scrollTop = scriptsEl.scrollTop;
  try {
    draw(v);
  } finally {
    scriptsEl.scrollTop = scrollTop;
  }
}

function draw(v: PopupView | null): void {
  bannersEl.replaceChildren();
  reloadBarEl.replaceChildren();
  scriptsEl.replaceChildren();
  document.body.dataset.ready = 'true';
  if (!v || !v.injectable) {
    scriptsEl.append(el('div', { class: 'empty-page' }, POPUP_NOT_INJECTABLE));
    return;
  }
  if (v.smDev) bannersEl.append(el('div', { class: 'banner-row sm-dev' }, el('span', {}, SM_DEV_CONTROL_LABEL)));
  if (v.banner) {
    const reload = el('button', { type: 'button' }, 'Reload');
    reload.addEventListener('click', () => quietly(reloadPlain()));
    reloadBarEl.append(el('div', { class: 'banner-row reload' }, el('span', {}, v.banner), reload));
  }
  const { enabled, manual, disabled } = arrange(v);
  if (enabled.length === 0 && manual.length === 0 && disabled.length === 0) {
    scriptsEl.append(el('div', { class: 'empty-page' }, POPUP_NO_SCRIPTS));
    return;
  }
  renderSection('Enabled', enabled, 'No enabled scripts match this page.');
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

type SectionKey = 'enabled' | 'manual' | 'disabled';
const SECTION_KEYS: readonly SectionKey[] = ['enabled', 'manual', 'disabled'];
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
    layout = { enabled: place(v.enabled), manual: place(v.manual), disabled: place(v.disabled) };
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
  return { enabled: build(layout.enabled), manual: build(layout.manual), disabled: build(layout.disabled) };
}

function renderSection(title: string, groups: PopupGroup[], emptyText: string): void {
  const section = el('section', { class: 'script-section', 'data-section': title.toLowerCase() });
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
  // Close only once the tab is open: closing the popup ends this page,
  // and an open still in flight with it.
  name.addEventListener('click', (ev) => {
    if (!isPlainClick(ev)) return;
    ev.preventDefault();
    quietly(openNamedTab('collections', { hash }).then(closeSoon));
  });
  const off = !c.enabled;
  const kebab = kebabButton('Collection actions');
  kebab.addEventListener('click', () => openMenu(kebab, [
    { label: 'Collection details', run: () => openNamedTab('collections', { hash }).then(closeSoon) },
    {
      label: off ? 'Enable collection' : 'Disable collection',
      run: () => setEnabled('collection', c.id, off),
    },
    {
      label: 'Collection options',
      run: () => openNamedTab('collections', { hash: EDIT_COLLECTION_HASH_PREFIX + c.id }).then(closeSoon),
    },
  ]));
  const head = el('div', { class: 'group-head' + (off ? ' off' : ''), 'data-collection-id': c.id },
    name, makeCollectionTypeBubble(c.path));
  if (off) head.append(el('span', { class: 'collection-off', title: COLLECTION_OFF_TOOLTIP }, COLLECTION_OFF_LABEL));
  head.append(el('span', { class: 'spacer' }), kebab);
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
  name.addEventListener('click', (ev) => openPage(ev, viewerUrl(row.id)));

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
    pill.addEventListener('click', (ev) => openPage(ev, viewerUrl(row.id, 'log')));
    main.append(pill);
  }
  const kebab = kebabButton('Script actions');
  // Not for a manual script: no reload runs it, so running it alone or
  // keeping it out is nothing.
  const perScriptReload = view?.perScriptReload === true && !row.manual;
  kebab.addEventListener('click', () => openMenu(kebab, [
    { label: 'Script details', run: () => openExtensionTab(viewerUrl(row.id)).then(closeSoon) },
    { label: 'Script log', run: () => openExtensionTab(viewerUrl(row.id, 'log')).then(closeSoon) },
    { separator: true, hidden: !perScriptReload },
    // Greyed for a script that won't run (its box or its collection is
    // off): running it alone or keeping it out would do nothing.
    {
      label: 'Reload page with only this script', run: () => reloadTab({ kind: 'only', scriptId: row.id }),
      hidden: !perScriptReload, disabled: !row.active, title: row.active ? undefined : INACTIVE_RELOAD_TITLE,
    },
    {
      label: 'Reload page without this script', run: () => reloadTab({ kind: 'without', scriptId: row.id }),
      hidden: !perScriptReload, disabled: !row.active, title: row.active ? undefined : INACTIVE_RELOAD_TITLE,
    },
  ]));
  main.append(kebab);

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
    run.addEventListener('click', () => quietly(runScript(row.id)));
    list.append(run);
  }
  if (row.commands.length === 0) return list;
  const long = row.commands.length > COMMANDS_SHOWN_OPEN;
  const open = commandsOpen.get(row.id) ?? !long;
  if (long) {
    const toggle = el('button', { type: 'button', class: 'disclose', 'aria-expanded': String(open) },
      open ? '▾ Hide commands' : `▸ ${row.commands.length} commands`);
    toggle.addEventListener('click', () => {
      commandsOpen.set(row.id, !open);
      render(view);
    });
    list.append(toggle);
  }
  if (!open) return list;
  for (const cmd of row.commands) {
    const btn = el('button', { type: 'button', class: 'command' }, cmd.name);
    btn.addEventListener('click', () => quietly(runCommand(row.id, cmd.commandId)));
    list.append(btn);
  }
  return list;
}

// A link to a per-script page: a plain click opens it in a new tab and
// closes the popup; a modified click is left to the browser.
function openPage(ev: MouseEvent, url: string): void {
  if (!isPlainClick(ev)) return;
  ev.preventDefault();
  quietly(openExtensionTab(url).then(closeSoon));
}

function isPlainClick(ev: MouseEvent): boolean {
  return ev.button === 0 && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey && !ev.altKey;
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

async function runCommand(scriptId: string, commandId: string): Promise<void> {
  if (tabId === null) return;
  const req: PopupCommandRequest = { type: POPUP_COMMAND_MESSAGE, tabId, scriptId, commandId };
  await chrome.runtime.sendMessage(req);
  closeSoon();
}

// Run a manual script. The popup stays open, so the row's status and
// any commands the run registers show up as they arrive.
async function runScript(scriptId: string): Promise<void> {
  if (tabId === null) return;
  const req: PopupRunScriptRequest = { type: POPUP_RUN_SCRIPT_MESSAGE, tabId, scriptId };
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

interface MenuItem {
  label?: string;
  // Shown but not clickable, with `title` saying why.
  disabled?: boolean;
  title?: string;
  run?: () => Promise<unknown>;
  separator?: boolean;
  hidden?: boolean;
}

let openMenuEl: HTMLElement | null = null;
let openMenuBtn: HTMLButtonElement | null = null;

function kebabButton(label: string): HTMLButtonElement {
  return el('button', {
    type: 'button', class: 'kebab', 'aria-label': label, 'aria-haspopup': 'menu', 'aria-expanded': 'false',
  }, '⋯') as HTMLButtonElement;
}

function openMenu(btn: HTMLButtonElement, items: MenuItem[]): void {
  const wasOpen = openMenuBtn === btn;
  closeMenu();
  if (wasOpen) return;
  const menu = el('div', { class: 'menu', role: 'menu' });
  for (const item of items) {
    if (item.hidden) continue;
    if (item.separator) {
      menu.append(el('hr'));
      continue;
    }
    const b = el('button', { type: 'button', role: 'menuitem' }, item.label ?? '') as HTMLButtonElement;
    b.disabled = item.disabled === true;
    if (item.title) b.title = item.title;
    b.addEventListener('click', () => {
      closeMenu();
      if (item.run) quietly(item.run());
    });
    menu.append(b);
  }
  document.body.append(menu);
  // Under the button, right-aligned to it; above it when there's no
  // room below.
  const r = btn.getBoundingClientRect();
  const below = r.bottom + 2;
  const top = below + menu.offsetHeight > document.documentElement.clientHeight
    ? Math.max(0, r.top - menu.offsetHeight - 2) : below;
  menu.style.top = `${top}px`;
  menu.style.right = `${document.documentElement.clientWidth - r.right}px`;
  btn.setAttribute('aria-expanded', 'true');
  openMenuEl = menu;
  openMenuBtn = btn;
  (menu.querySelector('button') as HTMLButtonElement | null)?.focus();
}

function closeMenu(): void {
  openMenuEl?.remove();
  openMenuBtn?.setAttribute('aria-expanded', 'false');
  openMenuEl = null;
  openMenuBtn = null;
}

document.addEventListener('click', (ev) => {
  const t = ev.target as Element | null;
  if (!openMenuEl || t?.closest('.menu') || t?.closest('button.kebab') === openMenuBtn) return;
  closeMenu();
});
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && openMenuEl) {
    const btn = openMenuBtn;
    closeMenu();
    btn?.focus();
    ev.preventDefault();
  }
});

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
