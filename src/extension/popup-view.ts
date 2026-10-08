// Pure model behind the toolbar popup ("Active scripts", popup.html):
// which scripts it lists for a tab, under which collection, with what
// status, tooltip, and reload banner. Built in the service worker
// (`popupViewForTab` in background.ts), which owns the inputs, and
// rendered as-is by src/extension/popup.ts. Kept free of chrome.* so the
// rules can be unit tested. Design: docs/status-popup.md.

import { compareScriptNames } from '../script-display.js';
import { skippedOnDocument, type BadgeRow, type RowStatus, type TabMatchState } from './tab-status.js';

// The badge's statuses, plus ones only the popup tells apart:
//   - PENDING: enabled since the page loaded; a reload would run it.
//   - STILL_RUNNING: disabled since the page loaded (its own box or its
//     collection's), or deleted since, but still running in this
//     document.
//   - WARNING: running (OK otherwise), with a warning: one its header
//     earns on every load, or one it logged from this tab. Every other
//     status outranks it.
export type PopupStatus = RowStatus | 'PENDING' | 'STILL_RUNNING' | 'WARNING';

export const POPUP_STATUS_LABELS: Record<PopupStatus, string> = {
  OK: 'Running',
  ERROR: 'Error',
  REJECTED: 'Rejected',
  RELOAD: 'Updated',
  MISSING: 'Missing',
  UNEXPECTED: 'Unexpected',
  NOT_LOADED: 'Not loaded',
  PENDING: 'Reload to run',
  STILL_RUNNING: 'Still running',
  WARNING: 'Warning',
};

// Every pill's tooltip ends with what a click does: a Reload to run
// pill reloads the page, as the banner's Reload does; the rest open
// the Log.
export const POPUP_PILL_CLICK_HINT = 'Click to open the script log.';
export const POPUP_PILL_RELOAD_HINT = 'Click to reload the page.';
// The page menu's item, and the icon's right-click item doing the same.
export const RELOAD_NO_SCRIPTS_LABEL = 'Reload page with no userscripts';
export const COLLECTION_OFF_LABEL = 'Collection off';
export const COLLECTION_OFF_TOOLTIP = 'This collection is disabled, so none of its scripts run';
export const POPUP_NO_SCRIPTS = 'No scripts match this page.';
export const POPUP_NOT_INJECTABLE = 'SourceMonkey can\'t run scripts on this page.';

// What the popup needs to know about one stored script.
export interface PopupScriptInput {
  id: string;
  name: string;
  collectionId: string;
  // The script's own toggle, not its collection's.
  enabled: boolean;
  // `identityKey` (@namespace + @name), or null when it has no @name.
  identity: string | null;
  version: string | null;
  // Its header earns a warning on every load (`startupLogs`).
  headerWarnings: boolean;
}

export interface PopupCollectionInput {
  id: string;
  name: string;
  // The collection's location, for its type bubble.
  path: string;
  enabled: boolean;
}

export interface PopupMenuCommand {
  commandId: string;
  name: string;
}

export interface PopupViewInput {
  url: string;
  // False for a page no script can run on (chrome://, about:, …).
  injectable: boolean;
  state: TabMatchState | null;
  // `computeBadge(state).rows`, or [] without a state.
  badgeRows: readonly BadgeRow[];
  // Chrome's refusals, id → its message.
  rejected: Readonly<Record<string, string>>;
  // Scripts whose rules match the tab's URL now, enabled or not.
  matchingIds: ReadonlySet<string>;
  // Every script `matchingIds` and `badgeRows` name, where still stored.
  scripts: readonly PopupScriptInput[];
  // In collections-page order.
  collections: readonly PopupCollectionInput[];
  menuCommands: ReadonlyMap<string, readonly PopupMenuCommand[]>;
  // Scripts to list whatever the one-row-per-identity rule says: the
  // rows an open popup already shows. Its layout stays put while it's
  // open, so a row mustn't vanish because another copy took over.
  keepIds?: ReadonlySet<string>;
  // After an in-place URL change: the scripts matching the URL the
  // document loaded at. Absent when the URL hasn't changed, or isn't
  // known.
  loadUrlMatchingIds?: ReadonlySet<string>;
  // Scripts with a badge row that are no longer stored: deleted since
  // they ran here.
  deletedIds?: ReadonlySet<string>;
}

export interface PopupRow {
  id: string;
  name: string;
  // The script's own toggle: ticked even under a disabled collection.
  checked: boolean;
  // Enabled and its collection on.
  active: boolean;
  status: PopupStatus | null;
  // Running here with a warning, whatever its status shows.
  warned: boolean;
  tooltip: string | null;
  // `Version X`, only when another copy of the script is active too.
  versionLine: string | null;
  commands: PopupMenuCommand[];
}

export interface PopupGroup {
  collection: PopupCollectionInput;
  rows: PopupRow[];
}

export interface PopupView {
  url: string;
  injectable: boolean;
  smDev: boolean;
  // `Reload required: …`, or null.
  banner: string | null;
  // The per-script "Reload page with only / without this script" items.
  // Not in a tab an sm-dev run controls: which scripts run there is the
  // run's choice.
  perScriptReload: boolean;
  enabled: PopupGroup[];
  disabled: PopupGroup[];
  // Scripts deleted since the page loaded that are still running in
  // it, by name. Still running, since a reload would remove them.
  deleted: PopupRow[];
  // Every collection, in collections-page order: the popup's frozen
  // layout can hold a group the sections above no longer have.
  collections: PopupCollectionInput[];
}

// ---- Messages between the popup page and the service worker ----

// Popup → worker: the view for a tab. Answered with a `PopupView`.
export const POPUP_VIEW_MESSAGE = 'sm:popup-view';
// Popup → worker: reload the tab, with some of its scripts kept out.
export const POPUP_RELOAD_MESSAGE = 'sm:popup-reload';
// Popup → worker: run one of a script's menu commands.
export const POPUP_COMMAND_MESSAGE = 'sm:popup-command';
// Popup → worker: tick or untick a script's or a collection's box. The
// worker writes it, so the popup needn't load the script store.
export const POPUP_SET_ENABLED_MESSAGE = 'sm:popup-set-enabled';
// Worker → popup: something the view for `tabId` shows changed
// (badge state, menu commands). The popup asks for a fresh view. Sent
// over the port an open popup holds, named this prefix + its tab id.
export const POPUP_CHANGED_MESSAGE = 'sm:popup-changed';
// Worker → popup, over the same port: close. The click that opened it
// turned out to be the first of a double click.
export const POPUP_CLOSE_MESSAGE = 'sm:popup-close';
// Popup → worker, over the port: closing after an action (a link, a
// menu command). Its close is then no double click's second click.
export const POPUP_CLOSING_MESSAGE = 'sm:popup-closing';
export const POPUP_PORT_PREFIX = 'sm-popup:';

// Which scripts a popup-driven reload keeps out:
//   - none: every one ("Reload page with no userscripts");
//   - only: all but `scriptId`;
//   - without: just `scriptId`.
export type ReloadMode =
  | { kind: 'none' }
  | { kind: 'only'; scriptId: string }
  | { kind: 'without'; scriptId: string };

export interface PopupViewRequest {
  type: typeof POPUP_VIEW_MESSAGE;
  tabId: number;
  // Rows the popup already shows, to keep listing (see `keepIds`), and
  // the URL it placed them for.
  keepIds?: string[];
  keepUrl?: string;
}
export interface PopupReloadRequest { type: typeof POPUP_RELOAD_MESSAGE; tabId: number; mode: ReloadMode }
export interface PopupCommandRequest {
  type: typeof POPUP_COMMAND_MESSAGE; tabId: number; scriptId: string; commandId: string;
}
export interface PopupSetEnabledRequest {
  type: typeof POPUP_SET_ENABLED_MESSAGE; target: 'script' | 'collection'; id: string; enabled: boolean;
}
export interface PopupChangedMessage { type: typeof POPUP_CHANGED_MESSAGE; tabId: number }
export interface PopupCloseMessage { type: typeof POPUP_CLOSE_MESSAGE }
export interface PopupClosingMessage { type: typeof POPUP_CLOSING_MESSAGE }

const DEFAULT_TOOLTIPS: Record<PopupStatus, string> = {
  OK: 'Running on this page',
  ERROR: 'The script reported an error on this page',
  REJECTED: 'Chrome refused to register this script, so it can\'t run',
  RELOAD: 'The script changed since this page loaded. Reload to run the new version.',
  MISSING: 'Expected on this page, but it hasn\'t started',
  UNEXPECTED: 'Started on this page, but its rules don\'t match this page',
  NOT_LOADED: 'Not run on this page load',
  PENDING: 'Enabled since this page loaded. Reload to run it.',
  STILL_RUNNING: 'Disabled since this page loaded. It keeps running until a reload.',
  WARNING: 'Running on this page, with warnings',
};

// STILL_RUNNING's tooltip for a script deleted since the page loaded.
const DELETED_TOOLTIP = 'Deleted since this page loaded. It keeps running until a reload.';

// PENDING's tooltip for a script that matches only the URL the page
// moved to in place: Chrome injects at a document load, not on pushState.
const MOVED_ONLY_TOOLTIP =
  'This page changed its address since it loaded, and the script matches only the new one. Reload to run it.';

// Why a NOT_LOADED script didn't run: which kind of reload, or the
// sm-dev claim, kept it out.
function notLoadedReason(state: TabMatchState, nameOf: (id: string) => string): string {
  if (state.scriptsSkipped) return 'Not run: the page was reloaded with no userscripts';
  if (state.skipOnly !== undefined) return `Not run: the page was reloaded with only ${nameOf(state.skipOnly)}`;
  if (state.skipWithout !== undefined) return 'Not run: the page was reloaded without this script';
  if (state.smDevAllow !== undefined) return 'Not run: the sm-dev run controlling this tab kept it out';
  return DEFAULT_TOOLTIPS.NOT_LOADED;
}

// What a reload would settle, by the statuses of the rows shown.
export interface BannerCauses {
  updated?: boolean;
  enabled?: boolean;
  disabled?: boolean;
  deleted?: boolean;
  // A reload may well settle these too: a script that should be running
  // isn't (MISSING), or one is running that shouldn't be (UNEXPECTED).
  // Both are common after the extension restarted under an open page,
  // which loses what the worker knew about it.
  missing?: boolean;
  unexpected?: boolean;
  // A script matches only the URL the page moved to in place.
  notYetRun?: boolean;
}

// The reload banner's text, naming the most specific cause.
export function bannerText(c: BannerCauses): string | null {
  if (c.enabled && (c.disabled || c.deleted)) return 'Reload required: Enabled scripts changed';
  if (c.enabled) return 'Reload required: Scripts enabled';
  if (c.disabled && c.deleted) return 'Reload required: Scripts disabled or deleted';
  if (c.disabled) return 'Reload required: Scripts disabled';
  if (c.deleted) return 'Reload required: Scripts deleted';
  if (c.updated) return 'Reload required: Scripts updated';
  if (c.notYetRun) return 'Reload required: Some scripts haven\'t run on this page yet';
  if (c.missing && c.unexpected) return 'Reload required: Some scripts are missing or unexpected';
  if (c.missing) return 'Reload required: Some scripts are missing';
  if (c.unexpected) return 'Reload required: Unexpected scripts are running';
  return null;
}

export function buildPopupView(input: PopupViewInput): PopupView {
  const { state } = input;
  const smDev = state?.smDevAllow !== undefined;
  const view: PopupView = {
    url: input.url,
    injectable: input.injectable,
    smDev,
    banner: null,
    perScriptReload: !smDev && state != null,
    enabled: [],
    disabled: [],
    deleted: [],
    collections: [...input.collections],
  };
  if (!input.injectable) return view;

  const collections = new Map(input.collections.map((c) => [c.id, c]));
  const scripts = new Map(input.scripts.map((s) => [s.id, s]));
  const badgeById = new Map(input.badgeRows.map((r) => [r.id, r]));
  const nameOf = (id: string) => scripts.get(id)?.name ?? badgeById.get(id)?.name ?? id;
  const isActive = (s: PopupScriptInput) => s.enabled && (collections.get(s.collectionId)?.enabled ?? false);
  const isRunning = (id: string) => state?.actual[id] != null;

  // Every candidate, then one identity at a time: the copies that are
  // active or running here all show; with none of those, one copy
  // stands for the script in Disabled.
  const keep = input.keepIds ?? new Set<string>();
  const candidates = new Set<string>([...input.matchingIds, ...badgeById.keys(), ...keep]);
  const byIdentity = new Map<string, PopupScriptInput[]>();
  for (const id of candidates) {
    const s = scripts.get(id);
    // A script deleted since it ran lists apart (`deleted` below).
    if (!s || !collections.has(s.collectionId)) continue;
    const key = s.identity ?? `id:${s.id}`;
    const list = byIdentity.get(key);
    if (list) list.push(s); else byIdentity.set(key, [s]);
  }
  const collectionOrder = new Map(input.collections.map((c, i) => [c.id, i]));
  const shown: { script: PopupScriptInput; dup: boolean }[] = [];
  for (const copies of byIdentity.values()) {
    const live = copies.filter((s) => isActive(s) || isRunning(s.id));
    const kept = copies.filter((s) => keep.has(s.id) && !live.includes(s));
    if (live.length > 0 || kept.length > 0) {
      const activeCount = live.filter(isActive).length;
      for (const s of [...live, ...kept]) shown.push({ script: s, dup: activeCount > 1 && isActive(s) });
      continue;
    }
    // The representative: a copy whose own box is ticked (so its
    // collection is what's off), else the first in collection order.
    const pick = copies.slice().sort((a, b) =>
      Number(b.enabled) - Number(a.enabled)
      || (collectionOrder.get(a.collectionId)! - collectionOrder.get(b.collectionId)!))[0]!;
    shown.push({ script: pick, dup: false });
  }

  const causes: BannerCauses = {};
  const rowsByCollection = { enabled: new Map<string, PopupRow[]>(), disabled: new Map<string, PopupRow[]>() };
  for (const { script: s, dup } of shown) {
    const active = isActive(s);
    const badge = badgeById.get(s.id);
    let status: PopupStatus | null = null;
    // PENDING only because the page changed its URL in place.
    let movedOnly = false;
    if (active) {
      status = badge?.status ?? (state ? 'PENDING' : null);
      // Matched now but not when the page loaded, and never reported:
      // enabled (or installed) since, or matching only the URL the page
      // moved to in place. Not in a tab an sm-dev run controls, where a
      // reload still wouldn't run it, nor over a refusal, which a
      // reload doesn't cure.
      const atLoad = state?.loadMatchIds;
      if (
        state && atLoad && !atLoad.includes(s.id) && !isRunning(s.id)
        && status !== 'REJECTED' && !(smDev && skippedOnDocument(state, s.id))
      ) {
        status = 'PENDING';
        movedOnly = input.loadUrlMatchingIds !== undefined && !input.loadUrlMatchingIds.has(s.id);
      }
    } else if (isRunning(s.id)) {
      status = 'STILL_RUNNING';
    }
    const warned = isRunning(s.id) && (s.headerWarnings || (state?.warnedIds?.includes(s.id) ?? false));
    if (status === 'OK' && warned) status = 'WARNING';
    if (status === 'RELOAD') causes.updated = true;
    if (status === 'PENDING') {
      if (movedOnly) causes.notYetRun = true; else causes.enabled = true;
    }
    if (status === 'STILL_RUNNING') causes.disabled = true;
    if (status === 'MISSING') causes.missing = true;
    if (status === 'UNEXPECTED') causes.unexpected = true;

    let tooltip: string | null = null;
    if (status) {
      let text = DEFAULT_TOOLTIPS[status];
      if (status === 'ERROR' && badge?.message) text = badge.message;
      if (status === 'REJECTED' && input.rejected[s.id]) text = input.rejected[s.id]!;
      if (status === 'NOT_LOADED' && state) text = notLoadedReason(state, nameOf);
      if (movedOnly) text = MOVED_ONLY_TOOLTIP;
      if (status === 'STILL_RUNNING' && s.enabled) {
        text = 'Its collection was disabled since this page loaded. It keeps running until a reload.';
      }
      tooltip = `${text}\n${status === 'PENDING' ? POPUP_PILL_RELOAD_HINT : POPUP_PILL_CLICK_HINT}`;
    }
    const row: PopupRow = {
      id: s.id,
      name: s.name,
      checked: s.enabled,
      active,
      status,
      warned,
      tooltip,
      versionLine: dup && s.version ? `Version ${s.version}` : null,
      commands: active || isRunning(s.id) ? [...(input.menuCommands.get(s.id) ?? [])] : [],
    };
    const into = active ? rowsByCollection.enabled : rowsByCollection.disabled;
    const list = into.get(s.collectionId);
    if (list) list.push(row); else into.set(s.collectionId, [row]);
  }

  const toGroups = (byColl: Map<string, PopupRow[]>): PopupGroup[] =>
    input.collections
      .filter((c) => byColl.has(c.id))
      .map((c) => ({
        collection: c,
        rows: byColl.get(c.id)!.sort((a, b) => compareScriptNames(a.name, b.name)),
      }));
  view.enabled = toGroups(rowsByCollection.enabled);
  view.disabled = toGroups(rowsByCollection.disabled);
  for (const id of input.deletedIds ?? []) {
    const badge = badgeById.get(id);
    if (!badge || !isRunning(id)) continue;
    causes.deleted = true;
    view.deleted.push({
      id,
      name: badge.name,
      checked: false,
      active: false,
      status: 'STILL_RUNNING',
      warned: false,
      tooltip: `${DELETED_TOOLTIP}\n${POPUP_PILL_RELOAD_HINT}`,
      versionLine: null,
      commands: [...(input.menuCommands.get(id) ?? [])],
    });
  }
  view.deleted.sort((a, b) => compareScriptNames(a.name, b.name));
  view.banner = bannerText(causes);
  return view;
}
