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

import { displayLocation } from './script-display.js';
import { isScriptEnabled, isSourceEnabled, type StoredScript, type StoredSource } from './script-store.js';
import {
  appendWithSlashBreaks,
  CONTAINER_DISPLAY_NAMES,
  effectiveDisplayName,
  makeSourceTypeBubble,
  sourceAnchorId,
} from './source-display.js';
import { getValue } from './userscript-header.js';
import type { RelatedScript, RelatedVersions } from './script-identity.js';

export interface RelatedVersionsActions {
  // Flip a row's per-script enabled toggle. Rejecting the promise
  // reverts the checkbox — the row is showing stored state, so it
  // must not keep a value the store refused.
  setEnabled(scriptId: string, enabled: boolean): Promise<void>;
  // Refetch same-location rows from their own sources. Passed every
  // id in the section at once, so the "…all" control is the same call
  // as a single row's — one refresh pass, one place for the caller to
  // report a failure. Omitted by callers that have nowhere to report
  // one.
  update?(scriptIds: readonly string[]): void | Promise<void>;
  // Add a single-file copy at this location. Only ever offered for
  // the `installTarget` row. Receives the row's own button so the
  // caller can put the busy state on the control that was clicked.
  install?(button: HTMLButtonElement): void | Promise<void>;
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
  if (!sameLocation.length && !sameIdentity.length && !installTarget) return;
  // A panel whose only row is the script already on screen tells the
  // user nothing they can't see above it. The current row earns its
  // place only when there is something to compare it against.
  const onlySelf =
    sameIdentity.length === 0
    && !installTarget
    && sameLocation.length === 1
    && sameLocation[0].script.id === model.actions.currentScriptId;
  if (onlySelf) return;

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
      table.tBodies[0].appendChild(versionRow(rel, model.actions, verb));
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
      table.tBodies[0].appendChild(versionRow(rel, model.actions, refetchVerb(model.mode)));
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
  for (const cls of ['col-enabled', 'col-source', 'col-location', 'col-version', 'col-actions']) {
    const col = document.createElement('col');
    col.className = cls;
    cols.appendChild(col);
  }
  table.appendChild(cols);
  const head = table.createTHead().insertRow();
  for (const [label, cls] of [
    ['On', 'col-enabled'],
    ['Source', 'col-source'],
    ['Location', 'col-location'],
    ['Version', 'col-version'],
    ['', 'col-actions'],
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
): HTMLTableRowElement {
  const { script } = rel;
  const isCurrent = script.id === actions.currentScriptId;
  const tr = document.createElement('tr');
  if (isCurrent) {
    tr.className = 'is-current';
    // The `(this page)` marker lives in the Location cell, which the
    // narrow layout hides — leaving background colour as the only cue,
    // and none at all for a screen reader. This one survives both.
    tr.setAttribute('aria-current', 'true');
  }
  tr.dataset.scriptId = script.id;

  tr.appendChild(enabledCell(rel, actions));
  tr.appendChild(sourceCell(rel));
  tr.appendChild(locationCell(rel, isCurrent));
  tr.appendChild(versionCell(script));
  tr.appendChild(actionsCell(rel, actions, isCurrent, verb));
  return tr;
}

// The per-script toggle, live. This is the panel's whole reason for
// carrying a checkbox: with several copies of one script installed,
// deciding which one runs is the action the user came here for, and
// making them visit each script's own page to do it defeats the
// point.
function enabledCell(rel: RelatedScript, actions: RelatedVersionsActions): HTMLTableCellElement {
  const { script } = rel;
  const td = cell('col-enabled');
  const label = document.createElement('label');
  label.className = 'toggle';
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = isScriptEnabled(script);

  // A disabled source disables every script under it, so a row that
  // showed only `script.enabled` would read as running when it isn't —
  // in a panel whose whole point is "which copy runs". Same treatment
  // as the viewer's own toggle.
  const sourceOff = rel.source ? !isSourceEnabled(rel.source) : false;
  if (sourceOff) {
    box.disabled = true;
    label.classList.add('toggle-disabled');
  }

  // The checkbox is the only content of its cell, so it has no
  // accessible name from markup. Naming the copy rather than "this
  // copy" keeps several identical-looking rows distinguishable.
  const what = rel.source ? effectiveDisplayName(rel.source) : 'this copy';
  const describe = (): void => {
    const verb = box.checked ? 'Disable' : 'Enable';
    const text = sourceOff
      ? `${what} — the source is disabled, so this copy does not run`
      : `${verb} this copy in ${what}`;
    box.setAttribute('aria-label', text);
    label.title = text;
  };
  describe();

  box.onchange = () => {
    const wanted = box.checked;
    box.disabled = true;
    void actions
      .setEnabled(script.id, wanted)
      // The store refused the write, so the box must not keep a value
      // that never landed. Only reachable when NO repaint follows: a
      // write that succeeds fires `storage.onChanged`, which re-renders
      // this row from stored state and discards this node entirely.
      .catch(() => {
        box.checked = !wanted;
      })
      .finally(() => {
        box.disabled = false;
        describe();
      });
  };
  label.appendChild(box);
  td.appendChild(label);
  return td;
}

// Source name links to the sources page, scrolled to that source's
// section — the same `#source-<id>` anchor the viewer's Source row
// uses, so both routes land in the same place.
//
// Bubble first, then the name: same order as the details panel's
// Source row and the sources page's own headings. The bubble is a
// fixed-width tag and the name is the variable part, so leading with
// it also keeps a column of rows aligned down the left edge.
function sourceCell(rel: RelatedScript): HTMLTableCellElement {
  const td = cell('col-source');
  if (!rel.source) {
    td.appendChild(document.createTextNode('(unknown source)'));
    return td;
  }
  td.appendChild(makeSourceTypeBubble(rel.source.path));
  td.appendChild(document.createTextNode(' '));
  td.appendChild(sourceNameLink(rel.source));
  return td;
}

// Back-link to a source's section on the sources page. Shared by the
// version rows and the install-offer row so both carry the same class,
// href, and tooltip — they drifted apart when written twice.
function sourceNameLink(source: StoredSource): HTMLAnchorElement {
  const a = document.createElement('a');
  a.className = 'versions-source-name';
  a.href = `sources.html#${sourceAnchorId(source.id)}`;
  a.title = 'Show this source on the sources page';
  appendWithSlashBreaks(a, effectiveDisplayName(source));
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
      ? `${verb} this script from its source`
      : `${verb} this copy from its source`;
    td.appendChild(button(verb, title, () => void actions.update?.([rel.script.id])));
  }
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

  const src = cell('col-source');
  src.appendChild(makeSourceTypeBubble(target.path));
  src.appendChild(document.createTextNode(' '));
  if (target.source) {
    src.appendChild(sourceNameLink(target.source));
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
