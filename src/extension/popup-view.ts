// Pure model behind the toolbar popup ("Active scripts", popup.html):
// which scripts it lists for a tab, under which collection, with what
// status, tooltip, and reload banner. Built in the service worker
// (`popupViewForTab` in background.ts), which owns the inputs, and
// rendered as-is by src/extension/popup.ts. Kept free of chrome.* so the
// rules can be unit tested. Design: docs/status-popup.md.

import { RUN_SCRIPT_LABEL } from '../userscript-header.js';
import { compareScriptNames } from '../script-display.js';
import { comparePreferred, preferredCopy } from './copy-preference.js';
import { isSettling, runsHere, skippedOnDocument, type BadgeRow, type RowStatus, type TabMatchState } from './tab-status.js';

// The badge's statuses, plus the ones only the popup shows:
//   - PENDING: enabled since the page loaded; a reload would run it.
//   - STILL_RUNNING: disabled since the page loaded (its own box or its
//     collection's), or removed since, but still running in this
//     document.
//   - WARNING: running (OK otherwise), with a warning: one its header
//     earns on every load, or one it logged from this tab. Every other
//     status outranks it.
//   - INVALID: targets this page, but failed to load, so it can't run.
//     A reload won't change that. Shown whether enabled or not.
//   - NOT_RUN: a manual script that hasn't been run on this page.
export type PopupStatus = RowStatus | 'PENDING' | 'STILL_RUNNING' | 'WARNING' | 'INVALID' | 'NOT_RUN';

export const POPUP_STATUS_LABELS: Record<PopupStatus, string> = {
  OK: 'Running',
  ERROR: 'Error',
  REJECTED: 'Rejected',
  RELOAD: 'Updated',
  MISSING: 'Missing',
  UNEXPECTED: 'Unexpected',
  NOT_LOADED: 'Not loaded',
  UNTRACKED: 'Reload',
  PENDING: 'Reload to run',
  STILL_RUNNING: 'Still running',
  WARNING: 'Warning',
  INVALID: 'Invalid',
  NOT_RUN: 'Not run',
};

// Every pill's tooltip ends with what a click does: a Reload to run or
// Reload pill reloads the page, as the banner's Reload does; the rest open
// the Log.
export const POPUP_PILL_CLICK_HINT = 'Click to open the script log.';
export const POPUP_PILL_RELOAD_HINT = 'Click to reload the page.';
// The page menu's item, and the icon's right-click item doing the same.
export const RELOAD_NO_SCRIPTS_LABEL = 'Reload page with no userscripts';
export const COLLECTION_OFF_LABEL = 'Collection off';
export const COLLECTION_OFF_TOOLTIP = 'This collection is disabled, so none of its scripts run';
export const POPUP_NO_SCRIPTS = 'No scripts match this page.';
export const POPUP_NOT_INJECTABLE = 'SourceMonkey can\'t run scripts on this page.';
// The group for scripts removed since the page loaded that still run in
// it: no stored row or collection is left to list them under.
export const REMOVED_GROUP_ID = 'sm:removed';
export const REMOVED_GROUP_NAME = 'Removed scripts';

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
  // `StoredScript.fileUrl` and the copy's active times (`enablementTimes`):
  // what picks the copy shown for a script none of whose copies is
  // active or running.
  location: string;
  activeSince?: number;
  inactiveSince?: number;
  // Set when the script failed to load (`status: 'invalid'`): why, as
  // the script page words it.
  invalid?: string;
  // A manual script (`@run-at context-menu`), run only on request.
  manual?: boolean;
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
  // The document that registered it (the top frame's or a frame's),
  // where a click fires it.
  documentId?: string;
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
  // The manual scripts that can be run on this page now (the worker's
  // rules for a run: matching the URL, and an sm-dev claim allowing it).
  manualRunnableIds?: ReadonlySet<string>;
  // Scripts to list whatever the one-row-per-identity rule says: the
  // rows an open popup already shows. Its layout stays put while it's
  // open, so a row mustn't vanish because another copy took over.
  keepIds?: ReadonlySet<string>;
  // After an in-place URL change: the scripts matching the URL the
  // document loaded at. Absent when the URL hasn't changed, or isn't
  // known.
  loadUrlMatchingIds?: ReadonlySet<string>;
  // Stored scripts not listed here at all: an sm-dev run's scratch
  // scripts, outside that run's tabs. Not taken for removed ones when
  // they show up in the tab's state.
  hiddenIds?: ReadonlySet<string>;
  // The time to judge `state.settleBy` by. Defaults to now.
  now?: number;
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
  // Other copies of the script match this page, so turning this one on
  // may turn them off (the checkbox tooltip says how to opt out).
  otherCopies: boolean;
  commands: PopupMenuCommand[];
  // A manual script (`@run-at context-menu`), which no reload runs.
  manual?: boolean;
  // A manual script that can be run here now: the row's commands start
  // with "Run this script".
  runnable?: boolean;
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
  // When the banner may change with nothing else changing: the page
  // stops settling (`settleBy`) with Missing rows left out of it.
  bannerRecheckAt: number | null;
  // The per-script "Reload page with only / without this script" items.
  // Not in a tab an sm-dev run controls: which scripts run there is the
  // run's choice.
  perScriptReload: boolean;
  enabled: PopupGroup[];
  // Scripts running only in the page's iframes: neither matched nor ran
  // in the top frame (docs/frames.md). Below Enabled.
  frames: PopupGroup[];
  // Manual scripts (`@run-at context-menu`) that are on, or have run
  // here: between Enabled and Disabled.
  manual: PopupGroup[];
  disabled: PopupGroup[];
  // Every collection, in collections-page order: the popup's frozen
  // layout can hold a group the sections above no longer have.
  collections: PopupCollectionInput[];
}

export { RUN_SCRIPT_LABEL };

// ---- Messages between the popup page and the service worker ----

// Popup → worker: the view for a tab. Answered with a `PopupView`.
export const POPUP_VIEW_MESSAGE = 'sm:popup-view';
// Popup → worker: reload the tab, with some of its scripts kept out.
export const POPUP_RELOAD_MESSAGE = 'sm:popup-reload';
// Popup → worker: run one of a script's menu commands.
export const POPUP_COMMAND_MESSAGE = 'sm:popup-command';
// Popup → worker: run a manual script now ("Run this script").
export const POPUP_RUN_SCRIPT_MESSAGE = 'sm:popup-run-script';
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
  documentId?: string;
}
export interface PopupRunScriptRequest { type: typeof POPUP_RUN_SCRIPT_MESSAGE; tabId: number; scriptId: string }
export interface PopupSetEnabledRequest {
  type: typeof POPUP_SET_ENABLED_MESSAGE; target: 'script' | 'collection'; id: string; enabled: boolean;
  // Ctrl/Cmd-clicked: change only this, leaving other copies alone.
  solo?: boolean;
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
  UNTRACKED: 'This page loaded before SourceMonkey started, so its status is unknown. Reload to restart.',
  PENDING: 'Enabled since this page loaded. Reload to run it.',
  STILL_RUNNING: 'Disabled since this page loaded. It keeps running until a reload.',
  WARNING: 'Running on this page, with warnings',
  INVALID: 'The script failed to load, so it can\'t run',
  NOT_RUN: `This script runs only when you choose ${RUN_SCRIPT_LABEL}`,
};

// A manual script's OK tooltip: how many times it was run here.
export function manualRunsText(runs: number): string {
  return runs === 1 ? 'Ran once on this page' : `Ran ${runs} times on this page`;
}

// OK's tooltip for a script running only in the page's iframes.
const FRAMES_OK_TOOLTIP = 'Running in frames on this page';

// STILL_RUNNING's tooltip for a script removed since the page loaded.
const REMOVED_TOOLTIP = 'Removed since this page loaded. It keeps running until a reload.';

// PENDING's tooltip for a script that matches only the URL the page
// moved to in place: Chrome injects at a document load, not on pushState.
const MOVED_ONLY_TOOLTIP =
  'This page changed its address since it loaded, and the script matches only the new one. Reload to run it.';

// Why a NOT_LOADED script didn't run: which kind of reload, or the
// sm-dev claim, kept it out.
const SM_DEV_KEPT_OUT = 'Not run: the sm-dev run controlling this tab kept it out';

function notLoadedReason(state: TabMatchState, nameOf: (id: string) => string): string {
  if (state.scriptsSkipped) return 'Not run: the page was reloaded with no userscripts';
  if (state.skipOnly !== undefined) return `Not run: the page was reloaded with only ${nameOf(state.skipOnly)}`;
  if (state.skipWithout !== undefined) return 'Not run: the page was reloaded without this script';
  if (state.smDevAllow !== undefined) return SM_DEV_KEPT_OUT;
  return DEFAULT_TOOLTIPS.NOT_LOADED;
}

// What a reload would settle, by the statuses of the rows shown.
export interface BannerCauses {
  updated?: boolean;
  enabled?: boolean;
  disabled?: boolean;
  // A reload may well settle these too: a script that should be running
  // isn't (MISSING), or one is running that shouldn't be (UNEXPECTED).
  missing?: boolean;
  unexpected?: boolean;
  // A script matches only the URL the page moved to in place.
  notYetRun?: boolean;
  // A script removed since the page loaded still runs in it.
  removed?: boolean;
  // The page loaded before the extension started (UNTRACKED).
  loadedBefore?: boolean;
}

// The reload banner's text, naming the most specific cause.
export function bannerText(c: BannerCauses): string | null {
  // First: it explains every other cause there may be.
  if (c.loadedBefore) return 'Reload required: Page loaded before SourceMonkey started';
  if (c.enabled && (c.disabled || c.removed)) return 'Reload required: Enabled scripts changed';
  if (c.enabled) return 'Reload required: Scripts enabled';
  if (c.disabled && c.removed) return 'Reload required: Scripts disabled and removed';
  if (c.disabled) return 'Reload required: Scripts disabled';
  if (c.removed) return 'Reload required: Scripts removed';
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
    bannerRecheckAt: null,
    perScriptReload: !smDev && state != null,
    enabled: [],
    frames: [],
    manual: [],
    disabled: [],
    collections: [...input.collections],
  };
  if (!input.injectable) return view;

  const collections = new Map(input.collections.map((c) => [c.id, c]));
  const scripts = new Map(input.scripts.map((s) => [s.id, s]));
  const badgeById = new Map(input.badgeRows.map((r) => [r.id, r]));
  const nameOf = (id: string) => scripts.get(id)?.name ?? badgeById.get(id)?.name ?? id;
  const isActive = (s: PopupScriptInput) => s.enabled && (collections.get(s.collectionId)?.enabled ?? false);
  const isRunning = (id: string) => state != null && runsHere(state, id);
  const settling = state != null && isSettling(state, input.now ?? Date.now());

  // Every candidate, then one identity at a time: the copies that are
  // active or running here all show; with none of those, one copy
  // stands for the script in Disabled.
  const keep = input.keepIds ?? new Set<string>();
  const candidates = new Set<string>([...input.matchingIds, ...badgeById.keys(), ...keep]);
  const byIdentity = new Map<string, PopupScriptInput[]>();
  // Scripts deleted since they ran that still run here: listed in a
  // group of their own, since they have no collection left.
  const removed: string[] = [];
  for (const id of candidates) {
    const s = scripts.get(id);
    if (!s || !collections.has(s.collectionId)) {
      if (isRunning(id) && !input.hiddenIds?.has(id)) removed.push(id);
      continue;
    }
    const key = s.identity ?? `id:${s.id}`;
    const list = byIdentity.get(key);
    if (list) list.push(s); else byIdentity.set(key, [s]);
  }
  const shown: { script: PopupScriptInput; dup: boolean; otherCopies: boolean }[] = [];
  for (const copies of byIdentity.values()) {
    const otherCopies = copies.length > 1;
    const live = copies.filter((s) => isActive(s) || isRunning(s.id));
    const kept = copies.filter((s) => keep.has(s.id) && !live.includes(s));
    if (live.length > 0 || kept.length > 0) {
      const activeCount = live.filter(isActive).length;
      for (const s of [...live, ...kept]) shown.push({ script: s, dup: activeCount > 1 && isActive(s), otherCopies });
      continue;
    }
    // The representative: the copy closest to running and most likely
    // to be turned back on (`comparePreferred`, docs/script-enablement.md).
    const pick = preferredCopy(copies, (s) => {
      const c = collections.get(s.collectionId)!;
      return {
        enabled: s.enabled,
        collectionOn: c.enabled,
        collectionName: c.name,
        activeSince: s.activeSince,
        inactiveSince: s.inactiveSince,
        version: s.version,
        location: s.location,
      };
    }, comparePreferred)!;
    shown.push({ script: pick, dup: false, otherCopies });
  }

  const causes: BannerCauses = {};
  const rowsByCollection = {
    enabled: new Map<string, PopupRow[]>(),
    frames: new Map<string, PopupRow[]>(),
    manual: new Map<string, PopupRow[]>(),
    disabled: new Map<string, PopupRow[]>(),
  };
  for (const { script: s, dup, otherCopies } of shown) {
    const active = isActive(s);
    const badge = badgeById.get(s.id);
    let status: PopupStatus | null = null;
    // PENDING only because the page changed its URL in place.
    let movedOnly = false;
    if (s.invalid !== undefined && !isRunning(s.id)) {
      // Never registered, so no badge row, and a reload won't run it:
      // not PENDING, and no banner. Disabled ones say so too, so it's
      // clear that turning one on won't make it run.
      status = 'INVALID';
    } else if (s.manual && active) {
      // Nothing expects a manual script to run, so a reload has nothing
      // to say about it: no PENDING, RELOAD or banner. In a tab an
      // sm-dev run controls that keeps it out, it's Not loaded, as a
      // script kept out of the load would be.
      if (badge && (badge.status === 'OK' || badge.status === 'ERROR')) status = badge.status;
      else if (smDev && !input.manualRunnableIds?.has(s.id)) status = 'NOT_LOADED';
      else status = 'NOT_RUN';
    } else if (active) {
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
    // Not while the page is still settling: its scripts may be on their way.
    if (status === 'MISSING') {
      if (settling) view.bannerRecheckAt = state!.settleBy!;
      else causes.missing = true;
    }
    if (status === 'UNEXPECTED') causes.unexpected = true;
    if (status === 'UNTRACKED') causes.loadedBefore = true;

    let tooltip: string | null = null;
    if (status) {
      let text = DEFAULT_TOOLTIPS[status];
      if (status === 'OK' && badge?.framesOnly) text = FRAMES_OK_TOOLTIP;
      if (status === 'ERROR' && badge?.message) text = badge.message;
      if (status === 'REJECTED' && input.rejected[s.id]) text = input.rejected[s.id]!;
      if (status === 'NOT_LOADED' && state) {
        // A manual script isn't kept out by a reload mode, only by the claim.
        text = s.manual ? SM_DEV_KEPT_OUT : notLoadedReason(state, nameOf);
      }
      if (status === 'INVALID' && s.invalid) text = `${DEFAULT_TOOLTIPS.INVALID}: ${s.invalid}`;
      if (movedOnly) text = MOVED_ONLY_TOOLTIP;
      if (status === 'STILL_RUNNING' && s.enabled) {
        text = 'Its collection was disabled since this page loaded. It keeps running until a reload.';
      }
      const runs = state?.manualRuns?.[s.id];
      if (s.manual && status === 'OK' && runs) text = manualRunsText(runs);
      const reloads = status === 'PENDING' || status === 'UNTRACKED';
      tooltip = `${text}\n${reloads ? POPUP_PILL_RELOAD_HINT : POPUP_PILL_CLICK_HINT}`;
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
      otherCopies,
      commands: active || isRunning(s.id) ? [...(input.menuCommands.get(s.id) ?? [])] : [],
      ...(s.manual ? { manual: true } : {}),
      ...(s.manual && active && s.invalid === undefined && input.manualRunnableIds?.has(s.id) ? { runnable: true } : {}),
    };
    // Anything running in the page is listed with the active scripts,
    // even when it's disabled now (Still running) or unexpected. Manual
    // scripts have their own section, by the same rule, and so do
    // scripts running only in frames.
    const into = !(active || isRunning(s.id))
      ? rowsByCollection.disabled
      : s.manual ? rowsByCollection.manual
      : badge?.framesOnly ? rowsByCollection.frames : rowsByCollection.enabled;
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
  view.frames = toGroups(rowsByCollection.frames);
  view.manual = toGroups(rowsByCollection.manual);
  view.disabled = toGroups(rowsByCollection.disabled);
  if (removed.length > 0) {
    causes.removed = true;
    const collection: PopupCollectionInput = { id: REMOVED_GROUP_ID, name: REMOVED_GROUP_NAME, path: '', enabled: true };
    view.collections.push(collection);
    view.enabled.push({
      collection,
      rows: removed.map((id): PopupRow => ({
        id,
        name: nameOf(id),
        checked: false,
        active: false,
        status: 'STILL_RUNNING',
        warned: false,
        // No click hint: there is no script page left to open.
        tooltip: REMOVED_TOOLTIP,
        versionLine: null,
        otherCopies: false,
        commands: [...(input.menuCommands.get(id) ?? [])],
      })).sort((a, b) => compareScriptNames(a.name, b.name)),
    });
  }
  view.banner = bannerText(causes);
  return view;
}
