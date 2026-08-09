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

import { isContainerCollection } from './directories.js';
import { displayLocation } from './script-display.js';
import { isScriptEnabled, isCollectionEnabled, type StoredScript, type StoredCollection } from './script-store.js';
import {
  appendWithSlashBreaks,
  CONTAINER_DISPLAY_NAMES,
  effectiveDisplayName,
  makeCollectionTypeBubble,
  collectionAnchorId,
  collectionHasManifest,
} from './collection-display.js';
import { getValue } from './userscript-header.js';
import {
  allRelatedRows,
  enableChanges,
  otherRunningCopies,
  type RelatedScript,
  type RelatedVersions,
  type ScriptEnableChange,
} from './script-identity.js';

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
const ENABLE_TITLE = 'Enable this script';
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

// …and when the parent collection is off, so the box can't be clicked
// at all. Same string the controls row has always used.
export const COLLECTION_OFF_TITLE = 'Collection is disabled';

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
  // Refetch same-location rows from their own collections. Passed every
  // id in the section at once, so the "…all" control is the same call
  // as a single row's — one refresh pass, one place for the caller to
  // report a failure. Omitted by callers that have nowhere to report
  // one.
  update?(scriptIds: readonly string[]): void | Promise<void>;
  // Add a single-file copy at this location. Only ever offered for
  // the `installTarget` row. Receives the row's own button so the
  // caller can put the busy state on the control that was clicked.
  install?(button: HTMLButtonElement): void | Promise<void>;
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
  // `@version` of the script on screen, used to fill the Version cell
  // of the not-installed-here offer row. Without it that one row
  // would read as version-less next to copies that all show one,
  // which looks like missing data rather than a missing install.
  version?: string;
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
  // No install action means no offer row. A row that says "not
  // installed here yet" and offers nothing to do about it is worse
  // than no row, and an offer whose button the caller has decided
  // against would contradict the page around it. Callers gate on:
  //   - installed mode — an Install there would add a SECOND row for a
  //     file already installed, and two enabled rows at one URL inject
  //     the script twice;
  //   - an invalid preview — the page has already said this file
  //     cannot be installed.
  const installTarget = model.actions.install ? model.installTarget : undefined;
  if (!sameLocation.length && !sameIdentity.length) {
    // A preview with nothing installed anywhere has no *existing*
    // versions to head a panel with, and the offer row would only
    // repeat the page's own Install button one line lower. The
    // installed viewer never reaches this branch — its own row is
    // always in `sameLocation`.
    return;
  }
  // A panel whose only row is the script already on screen tells the
  // user nothing they can't see above it. The current row earns its
  // place only when there is something to compare it against.
  const onlySelf =
    sameIdentity.length === 0
    && !installTarget
    && sameLocation.length === 1
    && sameLocation[0].script.id === model.actions.currentScriptId;
  if (onlySelf) return;

  // Every row the panel is about to draw, in one list. Enabling a copy
  // disables the others, and "the others" spans both sections — the
  // point is that one copy of this script runs, not one per section.
  // Same helper the controls-row toggle uses, so both see one list.
  const allRows = allRelatedRows(model);

  const h2 = document.createElement('h2');
  h2.textContent =
    model.mode === 'preview' ? 'Existing versions' : 'Other versions of this script';
  container.appendChild(h2);

  if (model.message) {
    const p = document.createElement('p');
    p.className = 'versions-message';
    p.setAttribute('role', 'status');
    p.textContent = model.message;
    container.appendChild(p);
  }

  if (sameLocation.length || installTarget) {
    // "This URL" rather than "Same URL": the section also covers the
    // row the user is looking at, and the case where nothing is
    // installed from this URL at all — neither of which is "same as"
    // anything.
    container.appendChild(sectionHeading('This URL'));
    // Every row here loads from the same place, so the refetch means
    // the same thing on all of them — including the current script's
    // own row. That duplicates the button at the top of the viewer,
    // which is fine: a table where one row is missing the control its
    // neighbours have reads as though that row couldn't be refreshed.
    const updatable = sameLocation.map((r) => r.script.id);
    const verb = refetchVerb(model.mode);
    const table = makeTable(
      updatable.length > 1 && model.actions.update
        ? button(`${verb} all`, `${verb} every copy at this URL`, () =>
            void model.actions.update?.(updatable))
        : undefined,
    );
    for (const rel of sameLocation) {
      table.tBodies[0].appendChild(versionRow(rel, model.actions, verb, allRows));
    }
    if (installTarget) {
      table.tBodies[0].appendChild(installRow(installTarget, model));
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
        versionRow(rel, model.actions, refetchVerb(model.mode), allRows),
      );
    }
    container.appendChild(table);
  }
}

// One action, two names — the same `updateScript(id, 'manual',
// 'force')` call the page's own control makes, labelled to match
// whichever control the user can see next to it. The viewer calls it
// Refresh; the preview calls it Update now. A panel button that said
// something a third way would read as a third operation.
function refetchVerb(mode: 'installed' | 'preview'): string {
  return mode === 'installed' ? 'Refresh' : 'Update';
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
// The two sections are separate `<table>`s, so their columns would
// size independently and the panel would read as two unrelated grids.
// A `<colgroup>` plus `table-layout: fixed` (in the stylesheet) pins
// every column to the same width in both.
function makeTable(headerAction?: HTMLElement): HTMLTableElement {
  const table = document.createElement('table');
  table.className = 'versions-table';
  const cols = document.createElement('colgroup');
  for (const cls of [
    'col-enabled',
    'col-collection',
    'col-location',
    'col-version',
    'col-actions',
    'col-remove',
  ]) {
    const col = document.createElement('col');
    col.className = cls;
    cols.appendChild(col);
  }
  table.appendChild(cols);
  const head = table.createTHead().insertRow();
  for (const [label, cls] of [
    ['On', 'col-enabled'],
    ['Collection', 'col-collection'],
    ['Location', 'col-location'],
    ['Version', 'col-version'],
    ['', 'col-actions'],
    ['', 'col-remove'],
  ] as const) {
    const th = document.createElement('th');
    th.className = cls;
    th.scope = 'col';
    if (cls === 'col-actions' && headerAction) th.appendChild(headerAction);
    else th.textContent = label;
    head.appendChild(th);
  }
  table.createTBody();
  return table;
}

function versionRow(
  rel: RelatedScript,
  actions: RelatedVersionsActions,
  verb: string,
  allRows: readonly RelatedScript[],
): HTMLTableRowElement {
  const { script } = rel;
  const isCurrent = script.id === actions.currentScriptId;
  const tr = document.createElement('tr');
  if (isCurrent) {
    tr.className = 'is-current';
    // The `(this page)` marker is a run of text in the Location cell;
    // to a screen reader it reads as more path, not as "you are here".
    // This says it as state.
    tr.setAttribute('aria-current', 'true');
  }
  tr.dataset.scriptId = script.id;

  tr.appendChild(enabledCell(rel, actions, allRows));
  tr.appendChild(collectionCell(rel));
  tr.appendChild(locationCell(rel, isCurrent));
  tr.appendChild(versionCell(script));
  tr.appendChild(actionsCell(rel, actions, isCurrent, verb));
  tr.appendChild(removeCell(rel, actions));
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
      ? `${what} — the collection is disabled, so this copy does not run`
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

// Back-link to a collection's section on the collections page. Shared
// by the version rows and the install-offer row so both carry the same
// class, href, and tooltip — they drifted apart when written twice.
function collectionNameLink(collection: StoredCollection): HTMLAnchorElement {
  const a = document.createElement('a');
  a.className = 'versions-collection-name';
  a.href = `collections.html#${collectionAnchorId(collection.id)}`;
  a.title = 'Show this collection on the collections page';
  appendWithSlashBreaks(a, effectiveDisplayName(collection));
  return a;
}

// Location links to that copy's own viewer page. Display decodes,
// the href does not — see [docs/names-and-paths.md].
function locationCell(rel: RelatedScript, isCurrent: boolean): HTMLTableCellElement {
  const td = cell('col-location');
  const text = displayLocation(rel.script.relativePath);
  if (isCurrent) {
    const span = document.createElement('span');
    span.className = 'versions-current-marker';
    span.title = rel.script.relativePath;
    appendWithSlashBreaks(span, text);
    const here = document.createElement('strong');
    here.className = 'versions-this-page';
    here.textContent = '(this page)';
    span.appendChild(document.createTextNode(' '));
    span.appendChild(here);
    td.appendChild(span);
    return td;
  }
  const a = document.createElement('a');
  a.href = `userscript.html?script=${encodeURIComponent(rel.script.id)}`;
  a.title = rel.script.relativePath;
  appendWithSlashBreaks(a, text);
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

function actionsCell(
  rel: RelatedScript,
  actions: RelatedVersionsActions,
  isCurrent: boolean,
  verb: string,
): HTMLTableCellElement {
  const td = cell('col-actions');
  // The refetch acts on a specific stored row, pulling from where that
  // row loads from — so it only means anything when the row loads from
  // the same place as the script on screen. A same-identity row would
  // refetch its own, different upstream: a fine thing to want, but not
  // "bring this up to date with what you are looking at", and offering
  // it here would read as though it were.
  //
  // The current script's own row is NOT excluded: see the call site.
  if (rel.sameLocation && actions.update) {
    const title = isCurrent
      ? `${verb} this script from its collection`
      : `${verb} this copy from its collection`;
    td.appendChild(button(verb, title, () => void actions.update?.([rel.script.id])));
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

function removeCell(rel: RelatedScript, actions: RelatedVersionsActions): HTMLTableCellElement {
  const td = cell('col-remove');
  if (!actions.remove) return td;
  // A row whose collection dangles is an orphan — the thing a user
  // would most want to clear out, and nothing will scan it back in — so
  // it gets the live button rather than a tooltip about a collection
  // that isn't there.
  const removable = rel.collection ? isContainerCollection(rel.collection.path) : true;
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'versions-remove';
  b.textContent = '🗑';
  const title = removable
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

// The offer to keep your own single-file copy of a script you are
// looking at inside someone else's collection. Rendered as a row in
// the same table so the container reads as one more place the script
// could live, rather than a separate call to action.
function installRow(
  target: NonNullable<RelatedVersions['installTarget']>,
  model: RelatedVersionsModel,
): HTMLTableRowElement {
  const actions = model.actions;
  const tr = document.createElement('tr');
  tr.className = 'is-offer';

  const on = cell('col-enabled');
  on.textContent = '—';
  tr.appendChild(on);

  const src = cell('col-collection');
  src.appendChild(makeCollectionTypeBubble(target.path));
  src.appendChild(document.createTextNode(' '));
  if (target.collection) {
    src.appendChild(collectionNameLink(target.collection));
  } else {
    // No row yet, so nothing to link to — the container is created by
    // the install this row offers.
    src.appendChild(document.createTextNode(CONTAINER_DISPLAY_NAMES[target.kind]));
  }
  tr.appendChild(src);

  const loc = cell('col-location');
  loc.className += ' versions-offer-text';
  loc.textContent = 'Not installed here yet';
  tr.appendChild(loc);

  // Not a copy — an offer — so the no-version tooltip has to be about
  // the file being previewed, not about a row that doesn't exist.
  tr.appendChild(versionCellFor(model.version, 'This script declares no @version'));

  const act = cell('col-actions');
  if (actions.install) {
    const b = button('Install', 'Install your own copy of this script', () => {
      void actions.install?.(b);
    }, true);
    act.appendChild(b);
  }
  tr.appendChild(act);
  // No stored row yet, so nothing to remove — an empty cell rather
  // than a disabled trash can, which would imply a copy exists.
  tr.appendChild(cell('col-remove'));
  return tr;
}

function cell(cls: string): HTMLTableCellElement {
  const td = document.createElement('td');
  td.className = cls;
  return td;
}

function button(
  label: string,
  title: string,
  onClick: () => void,
  primary = false,
): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  b.title = title;
  if (primary) b.className = 'primary';
  b.onclick = onClick;
  return b;
}
