// The import dialog, opened from the collections page's ⋯ menus: choose
// a backup file, see what it holds against what's here, choose what
// happens, then import. It stays open to say what was done. See
// docs/import.md.

import { describeError, getAllScriptMetas, getCollections, type StoredCollection } from './script-store.js';
import { importScripts } from './worker-client.js';
import { effectiveDisplayName, makeSchemeChip } from './collection-display.js';
import {
  githubRawToBlobUrl, importInfoKey, isContainerCollection, isGithubDirCollection, isFileUrl, isHttpUrl, isImportedUrl, isSmDevCollection, isStoredTextUrl,
  pathToFileUrl, type ImportInfo,
} from './directories.js';
import {
  IMPORT_SCRIPT_EMPTY, ImportFormatError, isEmptyScript, readBackup, SOURCE_NAMES, type BackupProblem, type ParsedBackup,
} from './import-backup.js';
import {
  actionFor, buildImportRequest, DEFAULT_CHOICES, hereText, planCollections, planImport, restoredScripts,
  type ImportChoices, type InstalledCopy, type PlannedCollection, type PlannedScript,
} from './import-plan.js';
import { sha256Hex } from '../bytes.js';
import { displayLocation, viewerUrl } from '../script-display.js';
import { getValue } from '../userscript-header.js';

interface DialogElements {
  dialog: HTMLDialogElement;
  title: HTMLElement;
  fileInput: HTMLInputElement;
  chooseBtn: HTMLButtonElement;
  fileName: HTMLElement;
  // Shown once a file is read: each only when it has something in it.
  collectionsSection: Section;
  newSection: Section;
  existingSection: Section;
  invalidSection: Section;
  includeSection: HTMLElement;
  newerLabel: HTMLElement;
  into: HTMLSelectElement;
  link: HTMLInputElement;
  existing: HTMLInputElement[];
  values: HTMLInputElement;
  enabled: HTMLInputElement;
  result: HTMLElement;
  error: HTMLElement;
  cancel: HTMLButtonElement;
  ok: HTMLButtonElement;
}

// One of the dialog's sections: a heading that carries its count, its
// controls, and a table of the scripts they apply to.
interface Section {
  root: HTMLElement;
  heading: HTMLElement;
  tableWrap: HTMLElement;
}

let elements: DialogElements | null = null;
let dialogInFlight = false;

function el<T extends HTMLElement>(tag: string, className?: string, text?: string): T {
  const node = document.createElement(tag) as T;
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function option(type: 'checkbox' | 'radio', id: string, label: string, hint?: string, name?: string): { wrap: HTMLElement; input: HTMLInputElement } {
  const wrap = el<HTMLElement>('div', 'dlg-option');
  const labelEl = el<HTMLLabelElement>('label', 'dlg-check');
  const input = el<HTMLInputElement>('input');
  input.type = type;
  input.id = id;
  if (name) input.name = name;
  labelEl.append(input, el('span', undefined, label));
  wrap.appendChild(labelEl);
  if (hint) wrap.appendChild(el('div', 'dlg-hint', hint));
  return { wrap, input };
}

function section(id: string, controls: Node[]): Section {
  const root = el<HTMLElement>('section', 'import-section');
  root.id = id;
  const heading = el<HTMLElement>('h3', 'import-heading');
  const box = el<HTMLElement>('div', 'dlg-includes');
  box.append(...controls);
  const tableWrap = el<HTMLElement>('div', 'import-table-wrap');
  root.append(heading, box, tableWrap);
  return { root, heading, tableWrap };
}

function buildDialog(): DialogElements {
  const dialog = el<HTMLDialogElement>('dialog', 'sm-dialog import-dialog');
  const title = el<HTMLElement>('h2', 'dlg-title');
  dialog.appendChild(title);

  const body = el<HTMLElement>('div', 'dlg-body');
  body.appendChild(el('p', 'dlg-intro',
    'Choose a backup from SourceMonkey, Tampermonkey or Violentmonkey: a .zip export, or Tampermonkey’s .txt backup.'));

  const fileRow = el<HTMLElement>('div', 'dlg-file');
  const fileInput = el<HTMLInputElement>('input');
  fileInput.type = 'file';
  fileInput.id = 'import-file';
  fileInput.accept = '.zip,.txt,.json,application/zip,application/json,text/plain';
  fileInput.hidden = true;
  const chooseBtn = el<HTMLButtonElement>('button', undefined, 'Choose file…');
  chooseBtn.type = 'button';
  chooseBtn.id = 'import-choose';
  const fileName = el<HTMLElement>('span', 'dlg-file-name');
  fileRow.append(fileInput, chooseBtn, fileName);
  body.appendChild(fileRow);

  // A SourceMonkey export's collections, made again with their scripts.
  const collectionsSection = section('import-collections', [el('div', 'dlg-hint',
    'Restore these collections with their scripts from the backup. Each collection’s next refresh loads what its location has then.')]);

  // Scripts not installed here.
  const intoRow = el<HTMLElement>('label', 'dlg-into');
  const into = el<HTMLSelectElement>('select');
  into.id = 'import-into';
  intoRow.append(el('span', undefined, 'Into '), into);
  const link = option('checkbox', 'import-link', 'Link scripts to their location from the import',
    'If the script has a URL or file location, it can get updates from that location.');
  const newSection = section('import-new', [intoRow]);

  // Scripts installed here.
  const leave = option('radio', 'import-existing-leave', 'Leave them as they are', undefined, 'import-existing');
  const newer = option('radio', 'import-existing-newer', newerLabel(0), undefined, 'import-existing');
  const always = option('radio', 'import-existing-always', 'Replace them all', undefined, 'import-existing');
  leave.input.value = 'leave';
  newer.input.value = 'newer';
  always.input.value = 'always';
  const existingSection = section('import-existing', [leave.wrap, newer.wrap, always.wrap,
    el('div', 'dlg-hint', 'The text of a script kept only in SourceMonkey is replaced. Any other loads from its own location, so only its values and enabled state change.')]);

  // Scripts the file has that can't be imported.
  const invalidSection = section('import-invalid', [el('div', undefined, 'These scripts cannot be imported.')]);

  // What comes with each script.
  const values = option('checkbox', 'import-values', 'Stored values',
    'Each script’s GM_setValue data. They replace the values of a script already here.');
  const enabled = option('checkbox', 'import-enabled', 'Enabled state',
    'Use enabled states from the backup. Otherwise, new scripts load enabled.');
  const include = section('import-include', [link.wrap, values.wrap, enabled.wrap]);
  include.heading.textContent = 'Include';
  include.tableWrap.remove();

  body.append(collectionsSection.root, newSection.root, existingSection.root, invalidSection.root, include.root);
  const result = el<HTMLElement>('div', 'dlg-result');
  result.id = 'import-result';
  result.hidden = true;
  body.appendChild(result);
  dialog.appendChild(body);

  const errorRow = el<HTMLElement>('div', 'dlg-error-row');
  const error = el<HTMLElement>('p', 'dlg-error');
  error.id = 'import-error';
  error.setAttribute('role', 'alert');
  errorRow.appendChild(error);
  dialog.appendChild(errorRow);

  const actions = el<HTMLElement>('div', 'dlg-actions');
  const cancel = el<HTMLButtonElement>('button', undefined, 'Cancel');
  cancel.type = 'button';
  const ok = el<HTMLButtonElement>('button', 'primary', 'Import');
  ok.type = 'button';
  ok.id = 'import-confirm-btn';
  actions.append(cancel, ok);
  dialog.appendChild(actions);

  document.body.appendChild(dialog);
  return {
    dialog, title, fileInput, chooseBtn, fileName,
    collectionsSection, newSection, existingSection, invalidSection, includeSection: include.root,
    newerLabel: newer.wrap.querySelector<HTMLElement>('.dlg-check')!,
    into, link: link.input, existing: [leave.input, newer.input, always.input],
    values: values.input, enabled: enabled.input, result, error, cancel, ok,
  };
}

export interface ImportDialogRequest {
  // Started from a collection's menu: new scripts go there by default.
  collectionId?: string;
}

// Open the dialog. Resolves when it closes, with the collection new
// scripts went into, if any.
export function openImportDialog(request: ImportDialogRequest = {}): Promise<string | null> {
  if (!elements) elements = buildDialog();
  const ui = elements;
  if (dialogInFlight) return Promise.resolve(null);
  dialogInFlight = true;
  return new Promise((resolve) => {
    let busy = false;
    let done = false;
    let landed: string | null = null;
    let backup: ParsedBackup | null = null;
    let plan: PlannedScript[] = [];
    let planned: PlannedCollection[] = [];
    let containers: StoredCollection[] = [];
    const checked = new Set<number>();
    // The backup's collections to restore, by uuid, and the scripts
    // that puts in them.
    const restoring = new Set<string>();
    let restored = new Set<number>();
    // Each existing script's row, greyed when the choice leaves it alone.
    const existingRows = new Map<number, HTMLElement>();
    const sections = [ui.collectionsSection.root, ui.newSection.root, ui.existingSection.root, ui.invalidSection.root, ui.includeSection];
    const abort = new AbortController();
    const on = <K extends keyof HTMLElementEventMap>(target: HTMLElement, type: K, fn: (ev: HTMLElementEventMap[K]) => void): void => {
      target.addEventListener(type, fn as EventListener, { signal: abort.signal });
    };
    const finish = (): void => {
      abort.abort();
      dialogInFlight = false;
      if (ui.dialog.open) ui.dialog.close();
      resolve(landed);
    };

    ui.title.textContent = 'Import scripts';
    ui.fileInput.value = '';
    ui.fileName.textContent = '';
    for (const node of sections) node.hidden = true;
    for (const sec of [ui.collectionsSection, ui.newSection, ui.existingSection, ui.invalidSection]) sec.tableWrap.replaceChildren();
    ui.link.checked = DEFAULT_CHOICES.linkLocations;
    for (const r of ui.existing) r.checked = r.value === DEFAULT_CHOICES.existing;
    ui.values.checked = DEFAULT_CHOICES.values;
    ui.enabled.checked = DEFAULT_CHOICES.enabledFromFile;
    ui.result.hidden = true;
    ui.result.replaceChildren();
    ui.error.textContent = '';
    ui.cancel.hidden = false;
    ui.ok.textContent = 'Import';
    const controls = (): (HTMLInputElement | HTMLButtonElement | HTMLSelectElement)[] => [
      ui.chooseBtn, ui.into, ui.link, ...ui.existing, ui.values, ui.enabled,
      // Not a collection that's here already, which stays off.
      ...ui.dialog.querySelectorAll<HTMLInputElement>('.import-table input:not([data-fixed])'),
    ];
    for (const c of controls()) c.disabled = false;

    const choices = (): ImportChoices => ({
      existing: (ui.existing.find((r) => r.checked)?.value ?? DEFAULT_CHOICES.existing) as ImportChoices['existing'],
      values: ui.values.checked,
      enabledFromFile: ui.enabled.checked,
      linkLocations: ui.link.checked,
    });

    // How many scripts here the backup has a newer version of.
    let newerCount = 0;
    // Set once the person picks a choice for existing scripts. Until
    // then it follows the default as the count changes.
    let existingPicked = false;

    // The existing rows' greying, and the button's count, from the
    // choices now.
    const refresh = (): void => {
      const newerOff = busy || done || newerCount === 0;
      ui.existing[1].disabled = newerOff;
      ui.newerLabel.classList.toggle('off', newerOff);
      const now = choices();
      let count = restored.size;
      for (const p of plan) {
        if (restored.has(p.script.index)) continue;
        const kept = checked.has(p.script.index);
        const acts = kept && actionFor(p, now).kind !== 'skip';
        existingRows.get(p.script.index)?.classList.toggle('import-skip', !acts);
        if (acts) count++;
      }
      ui.ok.disabled = busy || count === 0;
      ui.ok.textContent = count > 0 ? `Import ${count} ${count === 1 ? 'script' : 'scripts'}` : 'Import';
    };

    const setBusy = (state: boolean): void => {
      busy = state;
      for (const c of controls()) c.disabled = state;
      ui.cancel.disabled = state;
      refresh();
      if (state) ui.ok.textContent = 'Importing…';
    };

    // Counts file choices, so a slow read of an earlier one is dropped.
    let fileGen = 0;
    const onFile = async (file: File): Promise<void> => {
      const gen = ++fileGen;
      ui.error.textContent = '';
      ui.fileName.textContent = file.name;
      backup = null;
      plan = [];
      planned = [];
      restoring.clear();
      restored = new Set();
      newerCount = 0;
      existingPicked = false;
      try {
        const parsed = readBackup(new Uint8Array(await file.arrayBuffer()));
        const [installed, hashes, collections] = await Promise.all([
          readInstalled(), Promise.all(parsed.scripts.map((s) => sha256Hex(s.text))), getCollections(),
        ]);
        if (gen !== fileGen) return;
        backup = parsed;
        plan = planImport(parsed, installed, hashes);
        const mine = collections.filter((c) => !isSmDevCollection(c.path));
        planned = planCollections(parsed, mine.map((c) => ({ id: c.id, name: effectiveDisplayName(c), path: c.path })));
        containers = mine.filter((c) => isContainerCollection(c.path));
      } catch (err) {
        if (gen !== fileGen) return;
        for (const node of sections) node.hidden = true;
        ui.error.textContent = err instanceof ImportFormatError ? err.message : `This file could not be read: ${describeError(err)}`;
        refresh();
        return;
      }
      showPlan(backup);
    };

    const showPlan = (parsed: ParsedBackup): void => {
      checked.clear();
      for (const p of plan) checked.add(p.script.index);
      restoring.clear();
      for (const c of planned) if (!c.here && !c.cantRestore) restoring.add(c.collection.uuid);
      ui.collectionsSection.heading.textContent = `Collections (${planned.length})`;
      ui.collectionsSection.tableWrap.replaceChildren(collectionsTable(planned, restoring, () => {
        showScripts();
      }, on));
      ui.collectionsSection.root.hidden = planned.length === 0;
      ui.includeSection.hidden = false;

      // New scripts go into a new collection unless the dialog was
      // opened from one.
      const newName = parsed.source === 'other'
        ? `Imported scripts (${new Date().toLocaleDateString()})`
        : `Imported from ${SOURCE_NAMES[parsed.source]} (${new Date().toLocaleDateString()})`;
      ui.into.replaceChildren();
      const newOption = el<HTMLOptionElement>('option', undefined, `A new collection, “${newName}”`);
      newOption.value = '';
      newOption.dataset.newName = newName;
      ui.into.appendChild(newOption);
      for (const c of containers) {
        const o = el<HTMLOptionElement>('option', undefined, effectiveDisplayName(c));
        o.value = c.id;
        ui.into.appendChild(o);
      }
      ui.into.value = containers.some((c) => c.id === request.collectionId) ? request.collectionId! : '';
      showScripts();
    };

    // The New, Existing and Invalid sections, of the scripts no
    // restored collection takes.
    const showScripts = (): void => {
      if (!backup) return;
      restored = restoredScripts(planned, restoring);
      existingRows.clear();
      const outside = plan.filter((p) => !restored.has(p.script.index));
      // An empty script only a restore can bring back.
      const empty = outside.filter((p) => isEmptyScript(p.script.text));
      const rest = outside.filter((p) => !empty.includes(p));
      const problems: BackupProblem[] = [
        ...backup.problems, ...empty.map((p) => ({ file: p.script.name, reason: IMPORT_SCRIPT_EMPTY })),
      ];
      ui.invalidSection.heading.textContent = `Invalid scripts (${problems.length})`;
      ui.invalidSection.tableWrap.replaceChildren(invalidTable(problems));
      ui.invalidSection.root.hidden = problems.length === 0;
      const added = rest.filter((p) => !p.match);
      const here = rest.filter((p) => p.match);
      const newer = here.filter((p) => p.here === 'older-here').length;

      ui.newSection.heading.textContent = `New scripts (${added.length})`;
      ui.newSection.tableWrap.replaceChildren(scriptTable('import-new-table', added, ['Name', 'Version', 'Type', 'Values'], (p) => [
        el('td', 'import-name', p.script.name),
        el('td', 'import-version', p.script.version),
        typeCell(p.script.location, 'Where the backup says it loaded from'),
        valuesCell(p.script.values !== undefined),
      ]));
      ui.existingSection.heading.textContent = `Existing scripts (${here.length})`;
      ui.existingSection.tableWrap.replaceChildren(scriptTable('import-existing-table', here,
        ['Name', 'Backup version', 'Installed version', 'Compared', 'Type', 'Values'], (p, tr) => {
          existingRows.set(p.script.index, tr);
          const compared = hereText(p);
          const cell = el<HTMLTableCellElement>('td', 'import-here', compared.text);
          cell.title = compared.title;
          return [
            installedNameCell(p),
            el('td', 'import-version', p.script.version),
            el('td', 'import-version', (p.match?.header ? getValue(p.match.header, 'version') : '') ?? ''),
            cell,
            typeCell(p.match?.fileUrl, 'Where the installed copy loads from'),
            valuesCell(p.script.values !== undefined),
          ];
        }));
      ui.newSection.root.hidden = added.length === 0;
      ui.existingSection.root.hidden = here.length === 0;

      ui.newerLabel.querySelector('span')!.textContent = newerLabel(newer);
      newerCount = newer;
      // The default, unless it has nothing to do: then it is greyed,
      // and Leave is the choice. A choice the person made stays, unless
      // it is the greyed one.
      if (!existingPicked) {
        const start = newer === 0 && DEFAULT_CHOICES.existing === 'newer' ? 'leave' : DEFAULT_CHOICES.existing;
        for (const r of ui.existing) r.checked = r.value === start;
      } else if (newer === 0 && ui.existing[1].checked) {
        ui.existing[0].checked = true;
      }
      refresh();
    };

    // A section's table: a checkbox per script (and one for all), then
    // `cells` for each.
    const scriptTable = (
      id: string, rows: readonly PlannedScript[], headings: readonly string[],
      cells: (p: PlannedScript, tr: HTMLTableRowElement) => HTMLElement[],
    ): HTMLElement => {
      const table = el<HTMLTableElement>('table', 'import-table with-checks');
      table.id = id;
      const head = el<HTMLTableRowElement>('tr');
      const all = el<HTMLInputElement>('input');
      all.type = 'checkbox';
      all.checked = true;
      all.title = 'Import all';
      all.setAttribute('aria-label', 'Import all');
      const allCell = el<HTMLTableCellElement>('th');
      allCell.appendChild(all);
      head.append(allCell, ...headings.map((t) => el('th', undefined, t)));
      table.appendChild(el('thead')).appendChild(head);
      const tbody = el<HTMLTableSectionElement>('tbody');
      const boxes: HTMLInputElement[] = [];
      for (const p of rows) {
        const s = p.script;
        const tr = el<HTMLTableRowElement>('tr');
        tr.dataset.index = String(s.index);
        const box = el<HTMLInputElement>('input');
        box.type = 'checkbox';
        box.checked = checked.has(s.index);
        box.setAttribute('aria-label', `Import ${s.name}`);
        on(box, 'change', () => {
          if (box.checked) checked.add(s.index);
          else checked.delete(s.index);
          all.checked = boxes.every((b) => b.checked);
          refresh();
        });
        boxes.push(box);
        all.checked &&= box.checked;
        const boxCell = el<HTMLTableCellElement>('td');
        boxCell.appendChild(box);
        tr.append(boxCell, ...cells(p, tr));
        tbody.appendChild(tr);
      }
      on(all, 'change', () => {
        for (const b of boxes) b.checked = all.checked;
        for (const p of rows) {
          if (all.checked) checked.add(p.script.index);
          else checked.delete(p.script.index);
        }
        refresh();
      });
      table.appendChild(tbody);
      return table;
    };

    const onOk = async (): Promise<void> => {
      if (done) {
        finish();
        return;
      }
      if (!backup) return;
      ui.error.textContent = '';
      const selected = ui.into.selectedOptions[0];
      const into = ui.into.value
        ? { collectionId: ui.into.value }
        : { newCollectionName: selected?.dataset.newName ?? 'Imported scripts' };
      setBusy(true);
      try {
        const out = await importScripts(buildImportRequest(backup, plan, checked, choices(), into, planned, restoring));
        done = true;
        landed = out.installed > 0 || out.restored > 0 ? out.collectionId : null;
        const parts = [
          ...(out.restored > 0
            ? [`restored ${out.restored} ${out.restored === 1 ? 'collection' : 'collections'} with ${out.restoredScripts} ${out.restoredScripts === 1 ? 'script' : 'scripts'}`]
            : []),
          ...(out.installed > 0 ? [`imported ${out.installed} ${out.installed === 1 ? 'script' : 'scripts'}`] : []),
          ...(out.updated > 0 ? [`updated ${out.updated}`] : []),
        ];
        const line = parts.length > 0
          ? `${parts.length > 2 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts.join(' and ')}.`
          : 'nothing changed.';
        ui.result.replaceChildren(el('p', 'dlg-done', line.charAt(0).toUpperCase() + line.slice(1)));
        if (out.keptAsText.length > 0) {
          ui.result.appendChild(el('p', undefined, 'These scripts’ files couldn’t be read, so they use the backup’s copy and won’t get updates:'));
          const list = el<HTMLUListElement>('ul');
          for (const name of out.keptAsText) list.appendChild(el('li', undefined, name));
          ui.result.appendChild(list);
        }
        if (out.failed.length > 0) {
          ui.result.appendChild(el('p', undefined, 'These failed:'));
          const list = el<HTMLUListElement>('ul');
          for (const f of out.failed) list.appendChild(el('li', undefined, `${f.name}: ${f.message}`));
          ui.result.appendChild(list);
        }
        ui.result.hidden = false;
        setBusy(false);
        for (const c of controls()) c.disabled = true;
        ui.cancel.hidden = true;
        ui.ok.disabled = false;
        ui.ok.textContent = 'Close';
      } catch (err) {
        // Some of it may have been written, so the preview no longer
        // matches what's here: Close, and open it again to retry.
        done = true;
        setBusy(false);
        for (const c of controls()) c.disabled = true;
        ui.cancel.hidden = true;
        ui.ok.disabled = false;
        ui.ok.textContent = 'Close';
        ui.error.textContent = `Import failed: ${describeError(err)}`;
      }
    };

    on(ui.chooseBtn, 'click', () => ui.fileInput.click());
    on(ui.fileInput, 'change', () => {
      const file = ui.fileInput.files?.[0];
      if (file) void onFile(file);
    });
    for (const input of [ui.link, ui.values, ui.enabled]) on(input, 'change', refresh);
    for (const input of ui.existing) {
      on(input, 'change', () => {
        existingPicked = true;
        refresh();
      });
    }
    on(ui.ok, 'click', () => void onOk());
    on(ui.cancel, 'click', finish);
    // Esc while importing would leave the import running behind a
    // closed dialog.
    ui.dialog.addEventListener('cancel', (ev) => {
      ev.preventDefault();
      if (!busy) finish();
    }, { signal: abort.signal });
    refresh();
    ui.dialog.showModal();
    ui.chooseBtn.focus();
  });
}

const KIND_NAMES: Record<PlannedCollection['collection']['kind'], string> = {
  directory: 'Directory',
  manifest: 'Manifest',
  scripts: 'Scripts',
};

// The Collections section's table: a checkbox for each collection a
// restore can make, its kind and location, its scripts, and whether
// it's here already. `changed` runs when a checkbox does.
function collectionsTable(
  planned: readonly PlannedCollection[],
  restoring: Set<string>,
  changed: () => void,
  on: (target: HTMLElement, type: 'change', fn: () => void) => void,
): HTMLElement {
  const table = el<HTMLTableElement>('table', 'import-table with-checks');
  table.id = 'import-collections-table';
  const head = el<HTMLTableRowElement>('tr');
  head.append(el('th'), ...['Name', 'Kind', 'Location', 'Scripts', 'Status'].map((t) => el('th', undefined, t)));
  table.appendChild(el('thead')).appendChild(head);
  const tbody = el<HTMLTableSectionElement>('tbody');
  for (const c of planned) {
    const bc = c.collection;
    const tr = el<HTMLTableRowElement>('tr');
    tr.dataset.uuid = bc.uuid;
    const box = el<HTMLInputElement>('input');
    box.type = 'checkbox';
    box.checked = restoring.has(bc.uuid);
    const fixed = c.here !== undefined || c.cantRestore === true;
    if (fixed) {
      box.disabled = true;
      box.dataset.fixed = '';
    }
    box.setAttribute('aria-label', `Restore ${bc.name}`);
    on(box, 'change', () => {
      if (box.checked) restoring.add(bc.uuid);
      else restoring.delete(bc.uuid);
      changed();
    });
    const boxCell = el<HTMLTableCellElement>('td');
    boxCell.appendChild(box);
    const kind = bc.builtin ? `${KIND_NAMES[bc.kind]} (built-in)`
      : bc.location && isGithubDirCollection(bc.location) ? 'GitHub' : KIND_NAMES[bc.kind];
    const status = el<HTMLTableCellElement>('td', 'import-here', c.here ? 'Already here' : c.cantRestore ? 'Can’t restore' : 'New');
    status.title = c.here
      ? `Here as “${c.here.name}”. Its scripts are listed as new or existing scripts.`
      : c.cantRestore
        ? 'This export is from an older version that doesn’t record where its scripts are in the collection. Its scripts are listed as new or existing scripts.'
        : 'Not here. Restoring makes it again.';
    tr.append(
      boxCell,
      el('td', 'import-name', bc.name),
      el('td', undefined, kind),
      locationCell(bc.location),
      el('td', 'import-count', String(c.scripts.length)),
      status,
    );
    if (fixed) tr.classList.add('import-skip');
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  return table;
}

// A collection's location, linked to it. Empty for a scripts collection.
function locationCell(location: string | null): HTMLElement {
  const td = el<HTMLTableCellElement>('td', 'import-location');
  if (!location) return td;
  const a = el<HTMLAnchorElement>('a', undefined, displayLocation(location));
  a.href = locationHref(location);
  a.target = '_blank';
  a.rel = 'noopener';
  td.appendChild(a);
  return td;
}

// A location as a link: a GitHub raw URL as its page, a path as a
// file:// URL.
function locationHref(location: string): string {
  return isHttpUrl(location) ? githubRawToBlobUrl(location) ?? location
    : isFileUrl(location) ? location : pathToFileUrl(location);
}

// The Existing section's second choice, with how many scripts it covers.
function newerLabel(count: number): string {
  return `Replace the ones the backup has a newer version of (${count})`;
}

// The Type column: the scheme chip the collections page shows for
// `location` (`http`, `file`, `imported`…), linked to it when it is a
// URL or a file. Empty for a script with no location.
function typeCell(location: string | undefined, what: string): HTMLElement {
  const td = el<HTMLTableCellElement>('td', 'import-type');
  if (!location) return td;
  const chip = makeSchemeChip(location);
  if (isStoredTextUrl(location)) {
    td.appendChild(chip);
    return td;
  }
  const a = el<HTMLAnchorElement>('a');
  a.href = locationHref(location);
  a.target = '_blank';
  a.rel = 'noopener';
  a.title = `${what}: ${displayLocation(location)}`;
  a.appendChild(chip);
  td.appendChild(a);
  return td;
}

// An existing script's name, linked to the installed copy the import
// would update, in the viewer.
function installedNameCell(p: PlannedScript): HTMLElement {
  const td = el<HTMLTableCellElement>('td', 'import-name');
  if (!p.match) {
    td.textContent = p.script.name;
    return td;
  }
  const a = el<HTMLAnchorElement>('a', undefined, p.script.name);
  a.href = viewerUrl(p.match.id);
  a.target = '_blank';
  a.rel = 'noopener';
  a.title = `Open the installed copy, in ${p.match.collectionName}`;
  td.appendChild(a);
  return td;
}

// The Values column: a check for a script with stored values in the file.
function valuesCell(hasValues: boolean): HTMLElement {
  const td = el<HTMLTableCellElement>('td', 'import-values', hasValues ? '\u2713' : '');
  if (hasValues) {
    td.title = 'Has stored values in the backup';
    td.setAttribute('aria-label', 'Has stored values');
  }
  return td;
}

// The scripts the file has that can't be imported: each one's file in
// the zip (or name, in Tampermonkey's JSON) and why.
function invalidTable(problems: readonly BackupProblem[]): HTMLElement {
  const table = el<HTMLTableElement>('table', 'import-table');
  table.id = 'import-invalid-table';
  const head = el<HTMLTableRowElement>('tr');
  head.append(el('th', undefined, 'File'), el('th', undefined, 'Reason'));
  table.appendChild(el('thead')).appendChild(head);
  const tbody = el<HTMLTableSectionElement>('tbody');
  for (const p of problems) {
    const tr = el<HTMLTableRowElement>('tr');
    tr.append(el('td', 'import-name', p.file), el('td', undefined, p.reason));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  return table;
}

// The scripts here an import can match: every collection's but sm-dev's.
async function readInstalled(): Promise<InstalledCopy[]> {
  const [collections, metas] = await Promise.all([getCollections(), getAllScriptMetas('import')]);
  const byId = new Map(collections.filter((c) => !isSmDevCollection(c.path)).map((c) => [c.id, c]));
  const kept = metas.filter((m) => byId.has(m.collectionId));
  const infoKeys = kept.filter((m) => isImportedUrl(m.relativePath)).map((m) => importInfoKey(m.relativePath));
  const infos = infoKeys.length > 0 ? await chrome.storage.local.get(infoKeys) : {};
  return kept.map((m) => {
    const copy: InstalledCopy = {
      id: m.id,
      collectionId: m.collectionId,
      collectionName: effectiveDisplayName(byId.get(m.collectionId)!),
      fileUrl: m.fileUrl,
      header: m.header ?? null,
      enabled: m.enabled,
      stored: isStoredTextUrl(m.relativePath),
    };
    if (m.contentHash) copy.contentHash = m.contentHash;
    const info = infos[importInfoKey(m.relativePath)] as ImportInfo | undefined;
    if (info?.foreignId) copy.importedId = info.foreignId;
    return copy;
  });
}
