// The "Other versions" panel — one table of every installed copy of
// the script being viewed, shared by the installed-script viewer and
// the not-yet-installed preview.
//
// Both modes render the same rows from the same code. What differs is
// only which actions each row offers, which the caller supplies as
// callbacks; the renderer decides *whether* a row can offer them from
// the row's own relationship to the script on screen:
//
//   - **Same location** rows are the same bytes, so a refetch is
//     meaningful — refetching that row is refetching this script. The
//     button takes the name the surrounding page already uses for the
//     same call: Refresh in the viewer, Update in a preview.
//   - **Same identity** rows are a different file that happens to be
//     the same script. We cannot install one over the other (a
//     `file://` copy can't overwrite an http one, and two mirrors are
//     two separate subscriptions), so those rows link out and toggle,
//     nothing more.
//
// See [docs/script-identity.md].

import { isContainerCollection, scriptAbsolutePath } from './directories.js';
import {
  appendWithSlashBreaks,
  displayLocation,
  ENABLE_TITLE,
  viewerUrl,
  type ScriptStatusView,
} from './script-display.js';
import { isScriptEnabled, isCollectionEnabled, type StoredScript, type StoredCollection } from './script-store.js';
import {
  COLLECTION_OFF_TITLE,
  effectiveDisplayName,
  makeCollectionTypeBubble,
  collectionAnchorId,
  collectionHasManifest,
} from './collection-display.js';
import { openExtensionTab, wireNamedTabLink } from './page-links.js';
import { getValue } from './userscript-header.js';
import { guardSelectOpeningClick } from './select-open-guard.js';
import { setDeleteIcon } from './delete-icon.js';
import { setGlyphButton } from './glyph.js';
import { markFileChanges, scriptFileTag, tagLocalFile } from './file-changes.js';
import {
  allRelatedRows,
  contentFingerprint,
  enableChanges,
  otherRunningCopies,
  type InstallOption,
  type RelatedScript,
  type RelatedVersions,
  type ScriptEnableChange,
} from './script-identity.js';

// What the "Install into" dropdown answered: one of its listed
// containers (or the not-yet-existing default), or "New collection…" —
// which the caller answers by opening the create dialog first.
export type InstallChoice = { option: InstallOption } | { newCollection: true };

// What every enable checkbox says, and the tail it adds when clicking
// it would sweep other copies. Shared so both surfaces say exactly the
// same thing — the panel rows and the controls-row toggle are the same
// control, and the hint is the only part of them that varies.
//
// Deliberately short, and deliberately fixed. Naming the copy would
// repeat the Collection and Location cells an inch to the right, and
// swapping to "Disable" when checked would make one control read two
// ways for no gain.
//
// The hint names ONE key — the one this machine has. Only one of them
// works here (on a Mac ctrl-click opens the context menu, so the
// handler takes `metaKey` there and `ctrlKey` everywhere else), and a
// message offering both would be telling half its readers about a
// gesture their keyboard doesn't have. The docs say "Ctrl/Cmd" because
// they describe every platform at once; the app knows which one it is
// running on.
const SOLO_HINT = ` (${isApplePlatform() ? 'Cmd' : 'Ctrl'}-click for multi-enable)`;

// Resolved once, at module load — the platform can't change under us.
// `userAgentData` is the supported spelling and is present in every
// Chrome that can run this extension; `platform` is the fallback for a
// non-Chrome host and for the tests' DOM stubs.
function isApplePlatform(): boolean {
  const data = (navigator as { userAgentData?: { platform?: string } }).userAgentData;
  if (data?.platform) return data.platform === 'macOS';
  return /mac|iphone|ipad/i.test(navigator.platform || '');
}

// Wording for an enable checkbox, hint included only when clicking it
// would sweep other copies.
export function enableTitle(sweepsOthers: boolean): string {
  return sweepsOthers ? `${ENABLE_TITLE}${SOLO_HINT}` : ENABLE_TITLE;
}

// Wire a checkbox so its `change` handler can find out whether the
// click that produced it carried the exclusive-opt-out modifier.
// Returns a consume-once reader.
//
// Read from `click`, not `change`: `change` carries no modifier state.
// Keyboard activation (space) fires a click too, so nothing is lost —
// and `ctrlKey` is simply false there, which is the right default.
// `metaKey` covers Cmd-click on a Mac, where ctrl-click is the context
// menu. Consumed on read, so a later `change` that arrives without a
// click in front of it can't inherit a modifier pressed once.
export function watchSoloModifier(box: HTMLInputElement): () => boolean {
  let solo = false;
  box.addEventListener('click', (ev: MouseEvent) => {
    solo = ev.ctrlKey || ev.metaKey;
  });
  return () => {
    const was = solo;
    solo = false;
    return was;
  };
}

export interface RelatedVersionsActions {
  // Apply every per-script enabled change a single click produced.
  // Rejecting the promise reverts the clicked checkbox — the row is
  // showing stored state, so it must not keep a value the store
  // refused.
  setEnabled(changes: readonly ScriptEnableChange[]): Promise<void>;
  // Refetch rows from their own collections. Installed: any row in the
  // panel; preview: same-location rows only (see `actionsCell`). Passed
  // every id at once by the "…all" control, so it is the same call as a
  // single row's — one refresh pass, one place for the caller to report
  // a failure. Omitted by callers that have nowhere to report one.
  update?(scriptIds: readonly string[]): void | Promise<void>;
  // Install a single-file copy of this location where the offer
  // section's dropdown says. Only ever offered there. Receives the row's
  // own button so the caller can put the busy state on the control
  // that was clicked.
  install?(button: HTMLButtonElement, choice: InstallChoice): void | Promise<void>;
  // Delete one stored row outright. Offered only for scripts in a
  // container collection (the single-file installs the user added one
  // at a time); a script that came in with a directory or manifest
  // collection has no meaning apart from that collection, and removing
  // it would just be undone by the collection's next refresh. Omitted
  // by callers with nowhere to report a failure.
  remove?(scriptId: string): void | Promise<void>;
  // The row for the script currently on screen, so the panel can mark
  // it instead of linking to the page the user is already on. The
  // viewer passes its own id; the preview has none.
  currentScriptId?: string;
}

export interface RelatedVersionsModel extends RelatedVersions {
  actions: RelatedVersionsActions;
  // Which page is asking. Affects the heading only: "other" makes
  // sense next to a script you already have, but on a preview there is
  // no "this one" for the rest to be other than, so the heading states
  // what exists instead. Whether the install offer appears is decided
  // by `actions.install`, not by this.
  mode: 'installed' | 'preview';
  // What the Compare column compares each row against: the
  // `contentFingerprint` of the script on screen (viewer) or of the
  // download being shown (preview). Undefined when that side has no
  // content yet — every row then shows an em dash rather than a
  // verdict that would flip once it arrives.
  content?: string;
  // Where a differing row's DIFF button leads: the compare page for
  // that row against the copy the panel is about (`compareUrl` in
  // script-display.ts). Built by the caller because only it knows
  // whether the base is a stored script or a preview's location. With
  // no builder the verdict is the plain word.
  compareHref?: (other: StoredScript) => string;
  // `@version` of the script on screen, used to fill the Version cell
  // of the install-offer row. Without it that one row
  // would read as version-less next to copies that all show one,
  // which looks like missing data rather than a missing install.
  version?: string;
  // The absolute location the panel was computed for, for the Location
  // cell of the install-offer row — the copy that row would add loads
  // from here, so the cell is filled in the same terms as the rows it
  // lines up under rather than left blank.
  location: string;
  // What each stored row's Status cell should say, keyed by script id.
  // Built by the caller because the inputs — the per-script max log
  // level and Chrome's registration verdicts — live in
  // `chrome.storage.session`, which this renderer does no reading of.
  // A row with no entry renders an em dash: absent status is not the
  // same claim as OK.
  status?: ReadonlyMap<string, ScriptStatusView>;
  // Which rows are local copies whose FILE this page can delete — a
  // copy in the Downloads copies directory (see docs/local-delete.md).
  // Passed as a predicate because the answer needs a stored setting
  // this renderer does no reading of, the same way `status` is.
  //
  // Those rows get a live trash can even though they came in with a
  // directory collection: the reason that button is normally dead
  // there is that the collection's next scan would bring the row
  // straight back, and deleting the file is exactly what stops it.
  canDeleteFile?: (script: StoredScript, collection: StoredCollection | null) => boolean;
  // A failure from one of the panel's own actions, shown inside the
  // panel. It cannot use the page's `#message` bar: that bar is
  // rewritten from the current script's stored state on every
  // `storage.onChanged` repaint, and a refresh is exactly what
  // triggers one — so a message about ANOTHER copy would be painted
  // and wiped in the same breath. Passed in on every render so a
  // repaint carries it rather than clearing it.
  message?: string;
}

// Render into `container`, or clear it when there is nothing related.
// An empty panel is emptied rather than hidden so the caller's
// `:empty { display: none }` rule does the hiding — same shape as the
// details panel next to it.
export function renderRelatedVersions(
  container: HTMLElement,
  model: RelatedVersionsModel,
): void {
  container.replaceChildren();
  const { sameLocation, sameIdentity } = model;
  // No install action means no offer section: an offer whose button
  // the caller has decided against would contradict the page around
  // it. Callers gate on:
  //   - installed mode — an Install there would add a SECOND row for a
  //     file already installed, and two enabled rows at one URL inject
  //     the script twice;
  //   - an invalid preview — the page has already said this file
  //     cannot be installed.
  const offer = model.actions.install ? model.installOptions : undefined;
  if (!sameLocation.length && !sameIdentity.length) {
    // A preview with nothing installed anywhere has no *existing*
    // versions to head a panel with, and the offer section would only
    // repeat the page's own Install callout one line lower. The
    // installed viewer never reaches this branch — its own row is
    // always in `sameLocation`.
    panelHeadDrawn = false;
    return;
  }
  // A panel whose only row is the script already on screen tells the
  // user nothing the page around it doesn't. The current row earns its
  // place only when there is something to compare it against.
  const onlySelf =
    sameIdentity.length === 0
    && !offer
    && sameLocation.length === 1
    && sameLocation[0].script.id === model.actions.currentScriptId;
  if (onlySelf) {
    panelHeadDrawn = false;
    return;
  }

  // Every row the panel is about to draw, in one list. Enabling a copy
  // disables the others, and "the others" spans both sections — the
  // point is that one copy of this script runs, not one per section.
  // Same helper the controls-row toggle uses, so both see one list.
  const allRows = allRelatedRows(model);

  // Installed only. A preview draws this table inside the "This script
  // is already installed" banner, whose one line already says what the
  // rows are and what to do with them — a heading under it would be a
  // second, quieter statement of the same thing.
  if (model.mode === 'installed') {
    const head = document.createElement('div');
    head.className = 'versions-head';
    const h2 = document.createElement('h2');
    h2.textContent = 'Other versions of this script';
    head.appendChild(h2);
    // A panel that is only now appearing — a second copy just landed
    // on a page that had none to show — opens, whatever a fold earlier
    // on this page said: the new row is the thing to look at.
    if (!panelHeadDrawn) setPanelCollapsed(false);
    panelHeadDrawn = true;
    head.appendChild(collapseToggle(container, model));
    container.appendChild(head);
    if (isPanelCollapsed()) head.classList.add('collapsed');
  } else {
    // A preview draws the rows headless, so there is no headed panel
    // now — and the flag is about the headed one.
    panelHeadDrawn = false;
  }

  // Above the fold: the panel's own failure line is the one thing in
  // here that is time-sensitive, and a report of a refresh that just
  // failed must not be held back until the user happens to unfold.
  if (model.message) {
    const p = document.createElement('p');
    p.className = 'versions-message';
    p.setAttribute('role', 'status');
    p.textContent = model.message;
    container.appendChild(p);
  }

  // Collapsed: the heading line, its toggle, and any message ARE the
  // panel. The rows are left undrawn rather than drawn and hidden —
  // hidden rows would still be found by the panel's keyboard walk and
  // by the repaint's focus bookkeeping, and every repaint would build
  // controls nobody can reach.
  if (model.mode === 'installed' && isPanelCollapsed()) return;

  // Installed, this section is never empty: the page's own row is a
  // same-location row of the anchor, or the panel re-anchors on it —
  // so the "…all" control built here is always built.
  if (sameLocation.length) {
    // "This URL" rather than "Same URL": the section also covers the
    // row the user is looking at, so it isn't "same as" anything.
    container.appendChild(sectionHeading('This URL'));
    // Every row here loads from the same place, so the refetch means
    // the same thing on all of them — including the current script's
    // own row. That duplicates the button at the top of the viewer,
    // which is fine: a table where one row is missing the control its
    // neighbours have reads as though that row couldn't be refreshed.
    //
    // The "…all" control sits in this first table's header but is the
    // PANEL's: it covers every row `actionsCell` gives a button to —
    // in the installed viewer, the different-URL section too, since a
    // refresh there is the same per-row refetch (`updatableRows`).
    const verb = refetchVerb(model.mode);
    const updatable = updatableRows(model).map((r) => r.script.id);
    const scope = model.mode === 'preview' ? 'all copies at this URL' : 'all copies of this script';
    const table = makeTable({
      headerAction:
        updatable.length > 1 && model.actions.update
          ? (model.mode === 'preview'
            ? button(`${verb} all`, `${verb} ${scope}`, () =>
              void model.actions.update?.(updatable))
            : glyphButton(
              '#sm-refresh',
              `${verb} ${scope}`,
              () => void model.actions.update?.(updatable),
              `${verb} all`,
            ))
          : undefined,
    });
    for (const rel of sameLocation) {
      table.tBodies[0].appendChild(
        versionRow(rel, model, verb, allRows),
      );
    }
    container.appendChild(table);
  }

  if (sameIdentity.length) {
    container.appendChild(
      sectionHeading('Same script from a different URL', 'same @name and @namespace'),
    );
    const table = makeTable();
    for (const rel of sameIdentity) {
      table.tBodies[0].appendChild(
        versionRow(rel, model, refetchVerb(model.mode), allRows),
      );
    }
    container.appendChild(table);
  }

  // Third and last section: the copy you do NOT have yet. A section of
  // its own rather than a row tacked onto "This URL" — it is an offer,
  // not an inventory entry, and inside the inventory its dropdown read
  // as one more cell of data with its button stranded in the actions
  // column at the far right of the table.
  if (offer) {
    container.appendChild(sectionHeading('Install another copy of this script'));
    // The heading row is there but off screen: the section above has
    // already shown the reader these labels, and this table's own
    // left-hand columns are given over to the install controls — but a
    // screen reader has no link between two tables, so the row still
    // needs headers of its own to announce against.
    const table = makeTable({ headings: 'hidden' });
    table.tBodies[0].appendChild(installRow(offer, model));
    container.appendChild(table);
  }

  // Last, once every row all three tables will hold is in the document:
  // the fit is across all of them, and a column measured before its
  // widest row existed would be too narrow for it.
  fitColumns(container);
  // And after that: a chip on any local row whose file has gone or
  // changed (file-changes.ts). Async, so it lands after the fit; the
  // chip is short and the column has room for it.
  void markFileChanges(container);
}

// Whether the installed viewer's panel is folded down to its heading
// line. The table is the page's least urgent content and can run to
// many rows, so it gets a way out of the way — but only in the
// installed viewer, where the heading it folds into exists. A preview
// draws the same rows headless inside its banner, with nothing to
// leave behind.
//
// Open by default, and a fold lasts only as long as the page: it is
// module state, deliberately not persisted. Switching to another copy
// from the table happens in place (`swapToScript`), so the fold
// survives the hop without any storage; a reload or a second viewer
// tab starts open again, which is what a view preference that nobody
// set on purpose should do.
let panelCollapsed = false;

// Whether the last paint drew a headed panel at all. A panel that
// appears after a paint without one is opened regardless of the fold
// — see the head-building code above.
let panelHeadDrawn = false;

function isPanelCollapsed(): boolean {
  return panelCollapsed;
}

function setPanelCollapsed(next: boolean): void {
  panelCollapsed = next;
}

// The fold control, in the panel's top-right corner. A triangle that
// points down while the rows are showing, and right once they are
// folded away.
function collapseToggle(container: HTMLElement, model: RelatedVersionsModel): HTMLButtonElement {
  const collapsed = isPanelCollapsed();
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'versions-collapse';
  btn.textContent = collapsed ? '\u25B8' : '\u25BE';
  // One string for both: the glyph names nothing on its own, so the
  // label a screen reader reads and the tooltip a pointer gets have to
  // be the same sentence — same as the row's Remove button.
  const label = collapsed ? 'Show the other versions' : 'Hide the other versions';
  btn.setAttribute('aria-label', label);
  btn.title = label;
  btn.setAttribute('aria-expanded', String(!collapsed));
  // The rows it folds are siblings of the button rather than inside
  // it, so the relationship has to be stated rather than implied. Only
  // when the panel has an id to point at — the viewer's does.
  if (container.id) btn.setAttribute('aria-controls', container.id);
  btn.addEventListener('click', () => {
    // Read the flag rather than the captured value, so a path that
    // changes the fold without a repaint can't be toggled backwards.
    setPanelCollapsed(!isPanelCollapsed());
    // Re-render from the model already in hand: a repaint from the
    // store would be a round trip for a change that only concerns what
    // is drawn. It can be a paint behind — one deferred while a
    // `<select>` in the panel had focus — and the deferred paint that
    // follows corrects it.
    renderRelatedVersions(container, model);
    // This button went out with the render that replaced it. Focus the
    // one that took its place, so a keyboard fold can be undone with a
    // second press.
    container.querySelector<HTMLButtonElement>('.versions-collapse')?.focus();
  });
  return btn;
}

// Columns sized to their own content rather than to a guess. Each is
// as wide as its widest cell (header included) across EVERY section
// table, so they stay aligned and Location — the column that can
// always use more room — gets everything left over.
//
// Why measure at all: `table-layout: fixed` is what keeps the two
// tables' columns aligned, and under it the `<colgroup>` decides the
// width outright, so a column can't shrink to fit its own content. A
// fixed guess has to cover the worst case (`REFRESH FAILED`, a
// date-shaped `2026.08.19`), which left a short `1.2.0` stranded a
// column's breadth from the button beside it.
//
// Only the columns whose content has a natural width. Collection and
// Location are the flexible pair that absorb the remainder, and the
// two icon columns are already exactly a control wide.
const FITTED_COLUMNS = ['col-status', 'col-version', 'col-compare', 'col-actions'] as const;

// Measured by switching the tables to `auto` layout at `max-content`
// width — the one state where a cell reports what its content actually
// needs — then restoring. Both happen inside this call with no `await`
// between, so no frame is ever painted in the measuring state.
//
// The widths land as custom properties on the panel rather than as
// inline widths on the `<col>`s: an inline width would beat the
// stylesheet's narrow-window rule, which zeroes Version below 640px.
function fitColumns(container: HTMLElement): void {
  const tables = [...container.querySelectorAll<HTMLTableElement>('.versions-table')];
  if (tables.length === 0) return;
  // The `<col>` widths have to come off for the measurement too: under
  // `auto` layout a colgroup width is still a suggestion the browser
  // honours, so leaving them on measures the guess we are trying to
  // replace.
  const cols = [...container.querySelectorAll<HTMLElement>('.versions-table col')];
  for (const col of cols) col.style.width = 'auto';
  // The header's Refresh all is taken out of the measurement entirely,
  // not merely skipped when its own cell is read. It spans Actions and
  // Remove (see `appendHeadings`), and under `auto` layout the browser
  // pushes a spanning cell's excess width down INTO the columns it
  // covers — so a cell we never read still widens Actions to the
  // header button, which is the fit this whole pass exists to avoid.
  // Left in the row but not laid out; `fitSpannedHeader` below gives
  // it back the room it needs afterwards.
  const spanHead = container.querySelector<HTMLTableCellElement>(
    '.versions-table th.col-actions[colspan]',
  );
  if (spanHead) spanHead.style.display = 'none';
  for (const table of tables) {
    table.style.tableLayout = 'auto';
    table.style.width = 'max-content';
  }
  const widths = new Map<string, number>();
  for (const table of tables) {
    for (const cls of FITTED_COLUMNS) {
      for (const cell of table.querySelectorAll<HTMLTableCellElement>(`td.${cls}, th.${cls}`)) {
        widths.set(cls, Math.max(widths.get(cls) ?? 0, cell.getBoundingClientRect().width));
      }
    }
  }
  for (const table of tables) {
    table.style.tableLayout = '';
    table.style.width = '';
  }
  for (const col of cols) col.style.width = '';
  if (spanHead) spanHead.style.display = '';
  for (const cls of FITTED_COLUMNS) {
    const width = widths.get(cls);
    // A panel measured while hidden reports zero. Leaving the property
    // unset falls back to the stylesheet's worst-case width, which is
    // wrong-but-readable; a zero would collapse the column outright.
    if (width) container.style.setProperty(`--w-${cls}`, `${Math.ceil(width)}px`);
  }
  if (spanHead) fitSpannedHeader(container, spanHead);
}

// Widen Actions if the header button, which covers Actions and Remove,
// would otherwise hang off the table's right edge — which it will
// whenever its words are wider than a row's icon button plus a can.
//
// Everything here is read AFTER the widths above have landed, in the
// layout the panel will keep: the button's own width (it is never
// stretched, so its cell's width doesn't decide it) against the width
// Remove actually rendered at. Remove is not a fitted column — it is
// one can wide, from the stylesheet — so there is nothing measured to
// ask instead. A second layout, still with no `await` between, so no
// frame is painted in the middle.
//
// Either column can be read from any table in the panel: both are
// container-wide, `--w-col-actions` by construction and Remove because
// its width is a constant.
function fitSpannedHeader(container: HTMLElement, spanHead: HTMLTableCellElement): void {
  const action = spanHead.firstElementChild;
  const remove = container.querySelector<HTMLElement>('.versions-table td.col-remove');
  const actions = container.querySelector<HTMLElement>('.versions-table td.col-actions');
  if (!action || !remove || !actions) return;
  const need = Math.ceil(
    action.getBoundingClientRect().width - remove.getBoundingClientRect().width,
  );
  if (need > actions.getBoundingClientRect().width) {
    container.style.setProperty('--w-col-actions', `${need}px`);
  }
}

// One call, two operations as far as the user is concerned — the same
// `updateScript(id, 'manual', 'force')`, named for the page it appears
// on. The installed viewer's own control says Refresh, so the panel's
// rows do too; a preview is about bringing a copy up to the file
// already on screen, so there they say Update. A third name would read
// as a third operation.
//
// The two also LOOK different, which is `actionsCell`'s business:
// Refresh is the arrow glyph, Update stays a word. A preview fetches
// nothing — the file is already downloaded — so the refresh arrow
// would be a promise of a round trip that never happens.
function refetchVerb(mode: 'installed' | 'preview'): string {
  return mode === 'installed' ? 'Refresh' : 'Update';
}

// Which rows get the refetch button, and so which ones "…all" covers.
//
// Installed: every row. The refetch is per row — each copy is re-read
// from its own collection — so a different-URL copy refreshes as well
// as a same-URL one, and a row wearing a `modified` chip always has
// the button that acts on it. (The panel files its sections by the
// script the page was opened with, so after an in-page switch the copy
// on screen may well sit in the different-URL section.)
//
// Preview: same-location rows only. The call is the same per-row
// refetch, but a preview is about the URL on screen, and Update there
// means "bring this copy up to what you are looking at" — which a
// different-URL row, refetching its own upstream, would not be.
function updatableRows(model: RelatedVersionsModel): readonly RelatedScript[] {
  return model.mode === 'preview' ? model.sameLocation : allRelatedRows(model);
}

function rowUpdatable(rel: RelatedScript, mode: RelatedVersionsModel['mode']): boolean {
  return mode === 'preview' ? rel.sameLocation : true;
}

// A section heading with an optional parenthesized gloss. The gloss
// says which of the two matches produced the rows below, so it has to
// be visible — but it's an aside to the heading, not part of it, and
// carrying the heading's weight would make the two sections read as
// equally shouty. It rides inside the `<h3>` (it belongs to the
// heading semantically) with the emphasis turned back off.
function sectionHeading(text: string, gloss?: string): HTMLElement {
  const h3 = document.createElement('h3');
  h3.className = 'versions-section-heading';
  h3.appendChild(document.createTextNode(text));
  if (gloss) {
    const span = document.createElement('span');
    span.className = 'versions-heading-gloss';
    span.textContent = ` (${gloss})`;
    h3.appendChild(span);
  }
  return h3;
}

// `headerAction` rides in the actions column of the header row, where
// it lines up under nothing and over every per-row button — the
// natural home for a control that acts on the whole section.
//
// Each section is a separate `<table>`, so their columns would size
// independently and the panel would read as unrelated grids. A
// `<colgroup>` plus `table-layout: fixed` (in the stylesheet) pins
// every column to the same width in all of them.
//
// `headings: 'hidden'` keeps the heading row but takes it off screen —
// for a section drawn under one whose labels the reader has already
// seen. Off screen rather than dropped: the visual labelling carries
// over between the tables, but the ACCESSIBILITY tree has no link
// between them, and a row of cells with no `<th>` in their own table
// announces as four unlabelled values.
function makeTable(
  opts: { headerAction?: HTMLElement; headings?: 'visible' | 'hidden' } = {},
): HTMLTableElement {
  const table = document.createElement('table');
  table.className = 'versions-table';
  const cols = document.createElement('colgroup');
  for (const cls of [
    'col-enabled',
    'col-collection',
    'col-location',
    'col-status',
    'col-version',
    'col-compare',
    'col-actions',
    'col-remove',
  ]) {
    const col = document.createElement('col');
    col.className = cls;
    cols.appendChild(col);
  }
  table.appendChild(cols);
  appendHeadings(table, opts.headerAction, opts.headings === 'hidden');
  table.createTBody();
  return table;
}

function appendHeadings(
  table: HTMLTableElement,
  headerAction: HTMLElement | undefined,
  hidden: boolean,
): void {
  const thead = table.createTHead();
  if (hidden) thead.className = 'visually-hidden';
  const head = thead.insertRow();
  for (const [label, cls] of [
    ['On', 'col-enabled'],
    ['Collection', 'col-collection'],
    ['Location', 'col-location'],
    ['Status', 'col-status'],
    ['Version', 'col-version'],
    ['Compare', 'col-compare'],
    ['', 'col-actions'],
    ['', 'col-remove'],
  ] as const) {
    // The header action (Refresh all) is the table's own control, not
    // the actions column's heading, so it spans that column and the
    // removal one and sits flush with the table's right edge. Without
    // the span it stops a can's width short of it, which reads as a
    // button that missed its alignment rather than as a heading.
    if (cls === 'col-remove' && headerAction) continue;
    const th = document.createElement('th');
    th.className = cls;
    if (cls === 'col-actions' && headerAction) {
      // No `scope`: this cell holds the table's own control, not a
      // heading for anything under it. (`colgroup` would be the value
      // if it did head both columns.)
      th.colSpan = 2;
      th.appendChild(headerAction);
    } else {
      th.scope = 'col';
      th.textContent = label;
    }
    head.appendChild(th);
  }
}

function versionRow(
  rel: RelatedScript,
  model: RelatedVersionsModel,
  verb: string,
  allRows: readonly RelatedScript[],
): HTMLTableRowElement {
  const { script } = rel;
  const { actions, mode } = model;
  const status = model.status?.get(script.id);
  // This row is a local copy whose file the page can delete — see
  // `RelatedVersionsModel.canDeleteFile`.
  const deletesFile = model.canDeleteFile?.(script, rel.collection) ?? false;
  const isCurrent = script.id === actions.currentScriptId;
  const tr = document.createElement('tr');
  if (isCurrent) {
    tr.className = 'is-current';
    // The `(this page)` marker is a run of text in the Location cell;
    // to a screen reader it reads as more path, not as "you are here".
    // This says it as state.
    tr.setAttribute('aria-current', 'true');
    // Focusable even though activating it does nothing — it is already
    // the copy on screen. Two things need it to hold focus: Up/Down
    // walk the table row by row, and a row that cannot take focus
    // would be a hole in that walk; and it is where focus lands after
    // a selection, so the user stays where they were standing.
    //
    // No `role`/`aria-label` to go with the tab stop, unlike the
    // navigable rows: this one does nothing when activated, so it
    // stays an ordinary `row` and keeps its cells' column
    // associations. `aria-current` above is what names it.
    if (mode === 'installed') tr.tabIndex = 0;
  } else if (mode === 'installed') {
    // The whole row selects this copy — the viewer picks the click up
    // off the row (see its `navigateToScript`). Marked here rather than
    // assumed there so the pointer cursor and the row that acts are the
    // same set, and so a preview — which has no script to swap and
    // navigates for real — gets neither.
    tr.className = 'is-navigable';
    // The row IS the control, so it takes the tab stop its Location
    // cell gave up when that stopped being a link: same number of stops
    // through the table as before, with Enter / Space on the row
    // handled by the viewer's keydown listener.
    tr.tabIndex = 0;
    // And it has to SAY so. A focusable element that does something
    // nameless is worse than the link it replaced: `role` is what makes
    // Enter an announced affordance, and the label is what says where
    // it goes — the cells alone read as a row of values.
    //
    // The cost, stated plainly: this row stops being a `row` to a
    // screen reader, so its cells lose their column associations. Only
    // the navigable rows pay it — the current row and every preview row
    // keep ordinary table semantics — and a row whose whole purpose is
    // to be activated is better announced as the link it behaves like.
    tr.setAttribute('role', 'link');
    tr.setAttribute('aria-label', `Open ${displayLocation(script.relativePath)}`);
  }
  tr.dataset.scriptId = script.id;

  tr.appendChild(enabledCell(rel, actions, allRows));
  tr.appendChild(collectionCell(rel));
  tr.appendChild(locationCell(rel, isCurrent, mode));
  tr.appendChild(statusCell(script.id, status));
  tr.appendChild(versionCell(script));
  tr.appendChild(contentCell(isCurrent ? undefined : script, model));
  tr.appendChild(actionsCell(rel, actions, isCurrent, verb, mode));
  tr.appendChild(removeCell(rel, actions, deletesFile));
  return tr;
}

// The per-script toggle, live. This is the panel's whole reason for
// carrying a checkbox: with several copies of one script installed,
// deciding which one runs is the action the user came here for, and
// making them visit each script's own page to do it defeats the
// point.
//
// Enabling is EXCLUSIVE: two enabled copies of one script both
// register and both run, which is almost never what the user wants, so
// turning one on turns the rest off. Turning one off is not — that
// leaves none running, which is a perfectly ordinary thing to want and
// has no other copy to promote. Ctrl/Cmd-click opts out and toggles
// just the one box, for the rare case where two copies really are
// meant to run (say, two `@match`-disjoint edits of one script).
function enabledCell(
  rel: RelatedScript,
  actions: RelatedVersionsActions,
  allRows: readonly RelatedScript[],
): HTMLTableCellElement {
  const { script } = rel;
  const td = cell('col-enabled');
  const label = document.createElement('label');
  label.className = 'toggle';
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = isScriptEnabled(script);

  // A disabled collection disables every script under it, so a row that
  // showed only `script.enabled` would read as running when it isn't —
  // in a panel whose whole point is "which copy runs". Same treatment
  // as the viewer's own toggle.
  const collectionOff = rel.collection ? !isCollectionEnabled(rel.collection) : false;
  if (collectionOff) {
    box.disabled = true;
    label.classList.add('toggle-disabled');
  }

  // The visible tooltip, same wording as the controls-row toggle. The
  // hint is only worth showing where the sweep can actually fire: with
  // nothing else running there are no "others" to keep.
  label.title = collectionOff
    ? COLLECTION_OFF_TITLE
    : enableTitle(otherRunningCopies(allRows, script.id).length > 0);

  // The screen-reader name carries what the tooltip drops. The checkbox
  // is the only content of its cell, so it has no accessible name from
  // markup at all — and five rows announcing "Enable this script" would
  // be indistinguishable, where a sighted user just reads across to the
  // Collection cell.
  const what = rel.collection ? effectiveDisplayName(rel.collection) : 'this copy';
  box.setAttribute(
    'aria-label',
    collectionOff
      ? `${what}. The collection is disabled, so this copy does not run.`
      : `${label.title}, in ${what}`,
  );

  const takeSolo = watchSoloModifier(box);

  box.onchange = () => {
    const wanted = box.checked;
    // Only enabling is exclusive, and only without the opt-out
    // modifier.
    const changes = enableChanges(script.id, wanted, takeSolo() ? [] : allRows);
    box.disabled = true;
    void actions
      .setEnabled(changes)
      // The store refused the write, so the box must not keep a value
      // that never landed. Rarely the thing the user actually sees: the
      // caller repaints from stored state on both paths, which replaces
      // this node outright. This is the backstop for a caller that
      // doesn't — the panel's contract is that a rejection means
      // nothing landed, and a box left showing an intent that was
      // refused is a lie.
      .catch(() => {
        box.checked = !wanted;
      })
      // No re-describe: the wording no longer depends on the box's own
      // state, only on what else is installed — which a repaint is
      // what re-reads.
      .finally(() => {
        box.disabled = false;
      });
  };
  label.appendChild(box);
  td.appendChild(label);
  return td;
}

// Collection name links to the collections page, scrolled to that
// collection's section — the same `#collection-<id>` anchor the
// viewer's Collection row uses, so both routes land in the same place.
//
// Bubble first, then the name: same order as the details panel's
// Collection row and the collections page's own headings. The bubble is
// a fixed-width tag and the name is the variable part, so leading with
// it also keeps a column of rows aligned down the left edge.
function collectionCell(rel: RelatedScript): HTMLTableCellElement {
  const td = cell('col-collection');
  if (!rel.collection) {
    td.appendChild(document.createTextNode('(unknown collection)'));
    return td;
  }
  td.appendChild(makeCollectionTypeBubble(rel.collection.path));
  td.appendChild(document.createTextNode(' '));
  td.appendChild(collectionNameLink(rel.collection));
  return td;
}

// Back-link to a collection's section on the collections page. One
// helper so every row carries the same class, href, and tooltip — they
// drifted apart when this was written twice.
function collectionNameLink(collection: StoredCollection): HTMLAnchorElement {
  const a = document.createElement('a');
  a.className = 'versions-collection-name';
  // Opens the collections page's named tab beside this one — see
  // src/page-links.ts — rather than navigating the viewer away.
  wireNamedTabLink(a, 'collections', collectionAnchorId(collection.id));
  a.title = 'Show this collection on the collections page';
  appendWithSlashBreaks(a, effectiveDisplayName(collection));
  return a;
}

// The copy's stored location. Display decodes, the href — where there
// still is one — does not; see [docs/names-and-paths.md].
//
// A link only in a PREVIEW, where clicking it is the only way to reach
// that copy. On the details page the whole row already opens the copy,
// so a link inside it would offer the same destination twice and
// underline one cell for no reason.
function locationCell(
  rel: RelatedScript,
  isCurrent: boolean,
  mode: RelatedVersionsModel['mode'],
): HTMLTableCellElement {
  const td = cell('col-location');
  const text = displayLocation(rel.script.relativePath);
  const title = locationTitle(rel, text);
  // The element carrying the path is tagged with the file it names, so
  // a deleted or changed file gets its chip (see `markFileChanges`).
  const tagFile = (el: HTMLElement): void => {
    const tag = rel.collection && scriptFileTag(rel.script, rel.collection.path);
    if (tag) tagLocalFile(el, tag);
  };
  if (isCurrent || mode === 'installed') {
    const span = document.createElement('span');
    if (isCurrent) span.className = 'versions-current-marker';
    if (title) span.title = title;
    appendWithSlashBreaks(span, text);
    tagFile(span);
    if (isCurrent) {
      const here = document.createElement('strong');
      here.className = 'versions-this-page';
      here.textContent = '(this page)';
      span.appendChild(document.createTextNode(' '));
      span.appendChild(here);
    }
    td.appendChild(span);
    return td;
  }
  const a = document.createElement('a');
  a.href = viewerUrl(rel.script.id);
  if (title) a.title = title;
  appendWithSlashBreaks(a, text);
  tagFile(a);
  td.appendChild(a);
  return td;
}

// What hovering the location adds to what the cell already shows: the
// FULL location, resolved and unabridged.
//
// The cell shows the stored spelling, which is only ever part of the
// answer:
//   - a directory or manifest collection stores the path under its
//     root, so `gm-menu/gm-menu.user.js` in the cell is
//     `/home/…/tests/examples/gm-menu/gm-menu.user.js` on disk — and
//     the root is over in the Collection cell, not spliced onto it;
//   - a github row stores the raw URL and resolves to the `blob` page
//     URL a human would open;
//   - a percent-encoded URL displays decoded, so the tooltip is where
//     the literal form it was installed from survives.
//
// Empty — and so no tooltip at all — when that resolves to exactly the
// text already on screen, which is the common `https://…/foo.user.js`
// case. A tooltip repeating its own cell is noise.
function locationTitle(rel: RelatedScript, shown: string): string {
  const full = rel.collection
    ? scriptAbsolutePath(rel.collection.path, rel.script.relativePath)
    : rel.script.relativePath;
  return full === shown ? '' : full;
}

// Status, linking to that copy's Log tab. Every row links, including
// OK ones, and the colour rather than the underline is what carries
// the meaning — see [docs/script-identity.md] for both arguments.
//
// The current row's href resolves to this page's own URL plus `#Log`,
// which is a same-document fragment navigation: it switches tabs via
// the ordinary hashchange listener rather than reloading. That holds
// only while the query string matches byte-for-byte — a viewer URL
// that grew a second parameter would silently turn this into a page
// load. Another row's href goes to another script, which the installed
// viewer handles in place (`navigateToScript`), landing on that copy's
// Log tab.
function statusCell(scriptId: string, status: ScriptStatusView | undefined): HTMLTableCellElement {
  const td = cell('col-status');
  if (!status) {
    // Nothing was passed for this row, so say nothing rather than
    // guess: an unlabelled cell is honest, a green OK would not be.
    td.textContent = '—';
    return td;
  }
  const a = document.createElement('a');
  // The `status-*` colour classes only — NOT the controls row's
  // `.meta-status`, which forces `color: inherit`.
  a.className = `status-${status.status}`;
  a.href = viewerUrl(scriptId, 'log');
  a.textContent = status.label;
  // Titled only when the verdict has something to add, exactly as the
  // details panel's own Status row does with the same view — a cell
  // that carried a tooltip the identical verdict lacks would read as a
  // different measurement.
  if (status.title) a.title = status.title;
  td.appendChild(a);
  return td;
}

function versionCell(script: StoredScript): HTMLTableCellElement {
  const v = script.header ? getValue(script.header, 'version') : undefined;
  return versionCellFor(v, 'This copy declares no @version');
}

function versionCellFor(version: string | undefined, noneTitle: string): HTMLTableCellElement {
  const td = cell('col-version');
  td.textContent = version ?? '—';
  if (!version) td.title = noneTitle;
  return td;
}

// Whether this row's loaded content — body and `@require`s, see
// `contentFingerprint` — matches the copy the panel compares against:
// the script on screen, or the download a preview is showing.
//
// The reference row itself (`script` undefined) is labelled rather
// than left blank: a copy is neither the same as nor different from
// itself, and a blank there read as a missing value rather than as the
// row the others are measured against. `BASE` on the viewer; `NEW` on
// a preview, where the reference is the download and the installed
// rows are what it would replace. An em dash when either side has no content to
// compare (see `contentFingerprint`: never loaded, or `@require`s it
// does not hold) — for the same reason the Status cell shows one:
// absent is not a claim.
//
// Compared against what is LOADED, not what is on disk or at the URL:
// a local file edited since it was read still says Same until it is
// refreshed, and the Location cell's `modified` chip is what says so.
function contentCell(
  script: StoredScript | undefined,
  model: RelatedVersionsModel,
): HTMLTableCellElement {
  const { mode } = model;
  const td = cell('col-compare');
  if (!script) {
    const span = document.createElement('span');
    span.className = 'content-base';
    span.textContent = mode === 'preview' ? 'NEW' : 'BASE';
    span.title = mode === 'preview'
      ? 'The script being previewed, which the installed copies are compared against'
      : 'The copy on screen, which the other rows are compared against';
    td.appendChild(span);
    return td;
  }
  const own = contentFingerprint(script);
  if (own === undefined || model.content === undefined) {
    td.textContent = '—';
    return td;
  }
  const other = mode === 'preview' ? 'the script being previewed' : 'the copy on screen';
  if (own === model.content) {
    const span = document.createElement('span');
    span.className = 'content-same';
    span.textContent = 'SAME';
    span.title = `This copy\u2019s code and @require files match ${other}`;
    td.appendChild(span);
    return td;
  }
  // A copy that differs gets a DIFF button, which opens the compare
  // page in a new tab: the panel is where the user is working, and the
  // compare page is a look at one copy from it. A button rather than a
  // coloured word, because a word in a column of verdicts does not read
  // as something to click. Without a page to link to, the verdict is
  // the plain word.
  const href = model.compareHref?.(script);
  if (!href) {
    const span = document.createElement('span');
    span.className = 'content-different';
    span.textContent = 'DIFFERENT';
    span.title = `This copy\u2019s code or @require files differ from ${other}`;
    td.appendChild(span);
    return td;
  }
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'content-diff';
  btn.textContent = 'DIFF';
  btn.title = `This copy\u2019s code or @require files differ from ${other}. Click to show the differences.`;
  btn.dataset.href = href;
  btn.addEventListener('click', () => { void openExtensionTab(href); });
  td.appendChild(btn);
  return td;
}

function actionsCell(
  rel: RelatedScript,
  actions: RelatedVersionsActions,
  isCurrent: boolean,
  verb: string,
  mode: RelatedVersionsModel['mode'],
): HTMLTableCellElement {
  const td = cell('col-actions');
  // Which rows get the button is `updatableRows`'s call. The current
  // script's own row is NOT excluded: see the call site.
  if (rowUpdatable(rel, mode) && actions.update) {
    const title = isCurrent
      ? `${verb} this script from its collection`
      : `${verb} this copy from its collection`;
    // Two different operations, so two different-looking buttons —
    // this is the one place the panel does NOT reuse the refresh arrow
    // (see `refetchVerb`).
    //
    // Installed: the arrow, the same refetch this page's own Refresh
    // does — go and see whether the upstream moved.
    //
    // Preview: a word. Nothing is fetched; the file is already
    // downloaded and sitting on screen, and the button decides whether
    // to write it over this copy. An arrow would promise a round trip
    // that isn't going to happen, and would make the row look like the
    // installed case it isn't.
    // Bold in a preview: with the file already downloaded and copies
    // listed here, updating one of them is the likelier thing to want,
    // so this is the row's recommended action and the header's Install
    // gives up its emphasis to it (`showInstallCallout`).
    td.appendChild(
      mode === 'preview'
        ? button(verb, title, () => void actions.update?.([rel.script.id]), true)
        : glyphButton('#sm-refresh', title, () => void actions.update?.([rel.script.id])),
    );
  }
  return td;
}

// The trash can, in its own column to the right of the refetch button —
// the same glyph and hover treatment as the collections page's
// per-script remove (`.remove-script`), so the two read as one control
// in two places. Its own class, because the panel sits on a different
// ground and the borders have to match that; and, unlike the
// collections page, it appears disabled rather than hidden where it
// can't act.
//
// Live only for scripts in a container collection (the "Scripts from
// local disk" / "…from web" / "…from GitHub" buckets), which the user
// added one at a time and can take back out the same way. A script that
// arrived as part of a directory, manifest, or repo collection is not
// independently removable: the next refresh of that collection would
// scan it straight back in. Rather than hide the button on those rows —
// leaving a ragged column and no clue why some rows can be removed — it
// is shown disabled, with a tooltip that says where the removal
// actually lives. What to call a collection that holds many scripts,
// when telling the user their copy can't be removed on its own.
//
// "Collection" is the name for the whole family, but it says nothing
// about how this one was added. "Directory" and "manifest" are the words
// the collections page already uses for that, so they are the ones a
// user can act on. A GitHub repo or `/tree/` collection is a directory
// of scripts too, and reads that way.
function collectionNoun(collection: StoredCollection | null): string {
  return collection && collectionHasManifest(collection.path) ? 'manifest' : 'directory';
}

function removeCell(
  rel: RelatedScript,
  actions: RelatedVersionsActions,
  deletesFile: boolean,
): HTMLTableCellElement {
  const td = cell('col-remove');
  if (!actions.remove) return td;
  // A row whose collection dangles is an orphan — the thing a user
  // would most want to clear out, and nothing will scan it back in — so
  // it gets the live button rather than a tooltip about a collection
  // that isn't there.
  const removable = deletesFile
    || (rel.collection ? isContainerCollection(rel.collection.path) : true);
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'versions-remove';  // `.icon-btn` is added by setDeleteIcon
  // The badged can only on the row whose button takes the file with
  // it; every other copy here is just a record.
  setDeleteIcon(b, deletesFile ? 'file' : 'record');
  // A local copy's button says what makes it different — in the glyph
  // above and here again in words: it takes the file off the disk as
  // well, which is why this row has one at all.
  const title = deletesFile
    ? 'Delete local script file'
    : removable
      ? 'Remove this copy of the script'
      : `Script from ${collectionNoun(rel.collection)} collection `
        + 'can only be removed by removing the collection';
  b.title = title;
  b.setAttribute('aria-label', title);
  if (removable) {
    b.onclick = () => {
      b.disabled = true;
      void actions.remove?.(rel.script.id);
    };
  } else {
    b.disabled = true;
    // Also on the cell: a disabled button is out of the tab order, so
    // hovering anywhere in the column is the one way most users will
    // ever meet the explanation.
    td.title = title;
  }
  td.appendChild(b);
  return td;
}

// The offer to install your own copy of the script you are looking at,
// somewhere of your choosing — the whole of the panel's third section.
//
// Still a row in a table like the sections above it, so the Location
// and Version of the copy you would be adding line up under the copies
// you already have. That comparison is the reason it is here rather
// than in a callout of its own.
//
// What it does NOT keep is the columns left of Location: a copy that
// does not exist has no enable box, and its collection is the question
// rather than an answer. Those two cells become one, holding the same
// question the callout asks when nothing is installed anywhere, in the
// same shape: Install, "into", dropdown, on one line. Here rather than
// in the actions column, which is a whole table's width away from the
// control that decides what the button would do.
function installRow(
  options: readonly InstallOption[],
  model: RelatedVersionsModel,
): HTMLTableRowElement {
  const actions = model.actions;
  const tr = document.createElement('tr');
  tr.className = 'is-offer';

  const controls = cell('col-install');
  controls.colSpan = 2;

  const select = buildInstallSelect(options, { onChange: () => sync() });
  select.id = OFFER_SELECT_ID;
  // The button, the word, and the dropdown read as one sentence —
  // "Install into <collection>" — with the button as its verb. The
  // label is the connector in that sentence, so it is not a heading
  // and is not bold; the select keeps the whole phrase as its
  // accessible name, since "into" alone names nothing.
  const label = document.createElement('label');
  label.htmlFor = OFFER_SELECT_ID;
  label.textContent = 'into';
  select.setAttribute('aria-label', 'Install into');

  const b = button('Install', 'Install a copy of this script into the chosen collection', () => {
    void actions.install?.(b, selectedInstallChoice(select, options));
  }, true);

  const pick = document.createElement('div');
  pick.className = 'install-offer-pick';
  pick.append(b, label, select);

  // The pre-selected entry can be one that already holds this script
  // (the default stays first regardless); Install then waits for a
  // deliberate pick, and this line says why it is off.
  //
  // Under the line rather than beside the button: the button leads a
  // sentence, and a note spliced into the middle of one breaks the
  // reading.
  const note = document.createElement('div');
  note.className = 'install-offer-note';
  const sync = (): void => {
    const blocked = installChoiceBlocked(select, options);
    b.disabled = blocked;
    note.textContent = blocked ? CHOOSE_ANOTHER_COLLECTION : '';
  };
  sync();

  controls.append(pick, note);
  tr.appendChild(controls);

  tr.appendChild(offerLocationCell(model.location));

  // No stored row, so no status: this file has never been loaded,
  // registered, or logged against. An em dash, as a row whose status
  // lookup failed also uses.
  const stat = cell('col-status');
  stat.className += ' versions-offer-text';
  stat.textContent = '—';
  tr.appendChild(stat);

  // Not a copy — an offer — so the no-version tooltip has to be about
  // the file being previewed, not about a row that doesn't exist.
  tr.appendChild(versionCellFor(model.version, 'This script declares no @version'));

  // The offer IS the download the other rows are compared against, so
  // it is the base row here — same as the current row on the viewer.
  tr.appendChild(contentCell(undefined, model));

  // Nothing to refetch and nothing to remove: the copy does not exist
  // yet. Empty cells rather than disabled controls, which would imply
  // one does.
  tr.appendChild(cell('col-actions'));
  tr.appendChild(cell('col-remove'));
  return tr;
}

// Where the copy this row offers would load from — the location the
// whole panel was computed for, in the same column as the installed
// copies' own paths.
//
// The ABSOLUTE location, which is not always the spelling above it: a
// row inside a directory or manifest collection stores its path under
// that collection's root and prints the short form. Absolute anyway,
// because it is what this row's install would store — only a scripts
// collection can take an individually installed script, and those keep
// the location whole. The column lines the two up; it does not claim
// they are spelled alike.
//
// Never a link: it is the page you are already on. Tooltipped with the
// undecoded spelling when percent-encoding makes one differ from the
// other — `locationTitle`'s decoding case, without its resolve-the-
// collection-root case, which a location that is already absolute
// cannot be in.
function offerLocationCell(location: string): HTMLTableCellElement {
  const td = cell('col-location');
  const text = displayLocation(location);
  if (text !== location) td.title = location;
  appendWithSlashBreaks(td, text);
  return td;
}

// The offer section's dropdown, which is a labelled control and so
// needs an id. Distinct from the callout's `install-target`: the callout is
// hidden rather than emptied when the row takes over, so a shared id
// would put two of them in the document.
const OFFER_SELECT_ID = 'install-target-offer';

// The `<option>` value that means "New collection…".
const NEW_COLLECTION_VALUE = 'new';

// Why the offer section's Install is off: the pre-selected default is a
// collection that already holds this script. Only this row says it in
// words — the move dialog's equivalent state is the *(current)* entry,
// which is labelled rather than explained.
const CHOOSE_ANOTHER_COLLECTION = 'Already installed there. Choose another collection.';

// Whether the dropdown's current answer is an entry neither Install
// nor Move can act on: one that already holds this script, or — for a
// move — the collection it is in now. One predicate, so the two
// controls can't disagree about when their button is live.
export function installChoiceBlocked(
  select: HTMLSelectElement,
  options: readonly InstallOption[],
): boolean {
  const chosen = selectedInstallChoice(select, options);
  return 'option' in chosen && (chosen.option.installed || chosen.option.isCurrent);
}

export interface InstallSelectConfig {
  // The dropdown's tooltip. Defaults to the install wording; the
  // viewer's Move control passes its own, since the same list answers
  // a different question there.
  title?: string;
  // The selection moved. Fires for "New collection…" like any other
  // entry — picking it only *selects* it; the dialog opens when
  // Install is clicked. Anything else would fire on a keyboard user
  // simply cursoring past it, since Chrome emits `change` on every
  // arrow key over a closed select.
  onChange?(): void;
}

// The "Install into" dropdown, in three groups separated by rules:
// the built-in default for this script's scheme (existing, or "(new)"
// — created by the install); every other scripts collection in page
// order; "New collection…". Entries that already hold this script are
// disabled and marked. The first entry is always pre-selected, even
// when it is disabled — installing a second copy is never the one-click
// path.
//
// Every entry, "New collection…" included, only *selects*. Nothing
// happens until Install is clicked.
//
// `<hr>` inside `<select>` is native in Chrome ≥ 119, well under the
// extension's floor.
export function buildInstallSelect(
  options: readonly InstallOption[],
  config: InstallSelectConfig,
): HTMLSelectElement {
  const select = document.createElement('select');
  select.className = 'install-target';
  // Opens the list on the mouse release, so the click that opens it
  // can't also pick from it — see select-open-guard.ts.
  guardSelectOpeningClick(select);
  select.title = config.title ?? 'Which collection to install this script into';
  // Which entry opens selected: the one the script is already in when
  // there is one (the move dropdown), else the scheme default that
  // leads the list. Either way the opening choice is somewhere the
  // script already lives, so acting on it takes a deliberate pick.
  const preselect = Math.max(options.findIndex((o) => o.isCurrent), 0);
  options.forEach((o, i) => {
    if (i === 1) select.appendChild(document.createElement('hr'));
    // At most one suffix, in this order: "current" is where the script
    // is now; "already installed" is why another entry can't be picked;
    // "new" says the row doesn't exist yet; "disabled" warns about what
    // happens after. The first three can't co-occur with "disabled"
    // anyway — a default that doesn't exist is created enabled.
    const text = o.isCurrent ? `${o.label} (current)`
      : o.installed ? `${o.label} (already installed)`
      : !o.collection ? `${o.label} (new)`
      : o.collectionOff ? `${o.label} (disabled)`
      : o.label;
    const opt = new Option(text, String(i));
    opt.disabled = o.installed || o.isCurrent;
    if (i === preselect) opt.selected = true;
    select.appendChild(opt);
  });
  select.appendChild(document.createElement('hr'));
  select.appendChild(new Option('New collection…', NEW_COLLECTION_VALUE));
  select.onchange = () => config.onChange?.();
  return select;
}

// What a `buildInstallSelect` dropdown currently answers: one of the
// listed containers, or "make me a new one". Falls back to the first
// entry, since the select holds nothing else.
//
// The empty-list fallback is a guard, not a reachable state:
// `installOptionsFor` always returns at least the scheme default. It
// exists because every caller dereferences `choice.option`, so a list
// that somehow came back empty must not hand them `undefined`.
export function selectedInstallChoice(
  select: HTMLSelectElement,
  options: readonly InstallOption[],
): InstallChoice {
  if (select.value === NEW_COLLECTION_VALUE) return { newCollection: true };
  const option = options[Number(select.value)] ?? options[0];
  return option ? { option } : { newCollection: true };
}

function cell(cls: string): HTMLTableCellElement {
  const td = document.createElement('td');
  td.className = cls;
  return td;
}

// The bare button both builders below start from, so `type` and the
// click wiring can't drift between them.
function makeButton(title: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.title = title;
  b.onclick = onClick;
  return b;
}

// The glyph-bearing sibling of `button`. `text` is left out for an
// icon-only button, where `title` is the whole label — the row buttons
// — and supplied where a word carries something the arrow can't, as
// "all" does in the header action.
function glyphButton(
  symbolId: string,
  title: string,
  onClick: () => void,
  text?: string,
): HTMLButtonElement {
  const b = makeButton(title, onClick);
  // Sets the title again, and the `aria-label` an icon-only button
  // can't do without.
  setGlyphButton(b, symbolId, title, text === undefined ? {} : { text });
  return b;
}

function button(
  label: string,
  title: string,
  onClick: () => void,
  primary = false,
): HTMLButtonElement {
  const b = makeButton(title, onClick);
  b.textContent = label;
  if (primary) b.className = 'primary';
  return b;
}
