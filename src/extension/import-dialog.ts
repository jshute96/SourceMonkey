// The import dialog, opened from the collections page's ⋯ menu: choose
// a backup file, see what it holds against what's here, choose what
// happens, then import. Then it shows only what was done. See
// docs/import.md.

import { describeError, getAllScriptMetas, getCollections, type StoredCollection } from './script-store.js';
import { importScripts, readScriptValues } from './worker-client.js';
import { effectiveDisplayName, freeCollectionName, makeCollectionTypeBubble, makeSchemeChip } from './collection-display.js';
import {
  githubRawToBlobUrl, importInfoKey, isContainerCollection, isFileUrl, isHttpUrl, isImportedUrl, isSmDevCollection, isStoredTextUrl,
  pathToFileUrl, type ImportInfo,
} from './directories.js';
import {
  IMPORT_SCRIPT_EMPTY, ImportFormatError, isEmptyScript, readBackup, SOURCE_NAMES, type BackupProblem, type ParsedBackup,
} from './import-backup.js';
import {
  actionFor, addingScripts, arrivingLocation, ARROW, backupScriptsCollection, buildImportRequest, CHECK, collectionScripts, contentText, DEFAULT_CHOICES,
  hereTitle, locationChange, planCollections, planImport, restorable, restoredScripts, updatable, valuesText, versionText,
  type ImportChoices, type InstalledCopy, type PlannedCollection, type PlannedScript,
} from './import-plan.js';
import { sha256Hex } from '../bytes.js';
import { compareUrl, displayLocation, viewerUrl } from '../script-display.js';
import { offerImportSide, withdrawImportSides } from './import-compare.js';
import { openExtensionTab } from './page-links.js';

interface DialogElements {
  dialog: HTMLDialogElement;
  title: HTMLElement;
  fileInput: HTMLInputElement;
  chooseBtn: HTMLButtonElement;
  fileName: HTMLElement;
  // The intro and file row, hidden with the sections once the results
  // show.
  startRows: HTMLElement[];
  // Holds the sections, shown once a file is read; each section only
  // when it has something in it.
  sectionsWrap: HTMLElement;
  collectionsSection: Section;
  newSection: Section;
  existingSection: Section;
  // Existing scripts the import would leave exactly as they are: a
  // line, and their table behind a Show button.
  unchangedSection: Section;
  unchangedNote: HTMLElement;
  unchangedToggle: HTMLButtonElement;
  invalidSection: Section;
  newerLabel: HTMLElement;
  into: HTMLSelectElement;
  // Each section's own choices.
  restoreOpts: { values: HTMLInputElement; enabled: HTMLInputElement };
  newOpts: ArrivingOptions;
  // Where new scripts go: their collections from the backup, or the
  // one picked in `into`. Only offered when each has a collection.
  byCollection: HTMLInputElement;
  byCollectionRow: HTMLElement;
  pickInto: HTMLInputElement;
  existingText: HTMLInputElement[];
  existingValues: HTMLInputElement;
  existingEnabled: HTMLInputElement;
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

// A section's choices for the scripts it brings in.
interface ArrivingOptions {
  values: HTMLInputElement;
  enabled: HTMLInputElement;
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

// A section's line for the backup's enabled state and stored values:
// "Use from the backup: [x] Enabled state [x] Stored values".
function backupPair(lead: string, prefix: string): { wrap: HTMLElement; values: HTMLInputElement; enabled: HTMLInputElement } {
  const box = (id: string, label: string): { labelEl: HTMLLabelElement; input: HTMLInputElement } => {
    const labelEl = el<HTMLLabelElement>('label', 'dlg-check');
    const input = el<HTMLInputElement>('input');
    input.type = 'checkbox';
    input.id = id;
    labelEl.append(input, el('span', undefined, label));
    return { labelEl, input };
  };
  const enabled = box(`${prefix}-enabled`, 'Enabled state');
  const values = box(`${prefix}-values`, 'Stored values');
  const wrap = el<HTMLElement>('div', 'dlg-pair');
  wrap.append(el('span', undefined, `${lead} from the backup:`), enabled.labelEl, values.labelEl);
  return { wrap, values: values.input, enabled: enabled.input };
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
  const intro = el<HTMLElement>('p', 'dlg-intro',
    'Choose a backup from SourceMonkey, Tampermonkey or Violentmonkey: a .zip export, or Tampermonkey’s .txt backup.');
  body.appendChild(intro);

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
  const restore = backupPair('Use', 'import-restore');
  // Two lines in one block, so the options' spacing doesn't come between them.
  const collectionsHint = el<HTMLElement>('div', 'dlg-hint');
  collectionsHint.append('Directory collections from the backup will be created, with scripts from the backup.',
    el('br'), 'On refresh, the collections will be updated from their source.');
  const collectionsSection = section('import-collections', [collectionsHint, restore.wrap]);

  // Scripts not installed here.
  const byCollection = option('radio', 'import-new-by-collection', 'Add to collections named in the backup', undefined, 'import-new-target');
  // The label names the picker, so it stays usable without the radio.
  const intoRow = el<HTMLElement>('div', 'dlg-into');
  const pickInto = el<HTMLInputElement>('input');
  pickInto.type = 'radio';
  pickInto.name = 'import-new-target';
  pickInto.id = 'import-new-pick';
  pickInto.setAttribute('aria-label', 'Add to one collection');
  const into = el<HTMLSelectElement>('select');
  into.id = 'import-into';
  const intoLabel = el<HTMLLabelElement>('label', undefined, 'Add to one collection');
  intoLabel.htmlFor = 'import-into';
  intoRow.append(pickInto, intoLabel, into);
  const fresh = backupPair('Use', 'import-new');
  const newSection = section('import-new', [byCollection.wrap, intoRow, fresh.wrap]);

  // Scripts installed here.
  const leave = option('radio', 'import-existing-leave', 'Keep existing version', undefined, 'import-existing');
  const newer = option('radio', 'import-existing-newer', newerLabel(0), undefined, 'import-existing');
  const always = option('radio', 'import-existing-always', 'Replace with imported version always', undefined, 'import-existing');
  leave.input.value = 'leave';
  newer.input.value = 'newer';
  always.input.value = 'always';
  const replace = backupPair('Replace', 'import-existing');
  const existingSection = section('import-existing', [leave.wrap, newer.wrap, always.wrap, replace.wrap]);

  // Scripts installed here exactly as the backup has them.
  const unchangedNote = el<HTMLElement>('span');
  const unchangedToggle = el<HTMLButtonElement>('button', 'dlg-toggle', 'Show');
  unchangedToggle.type = 'button';
  unchangedToggle.id = 'import-unchanged-toggle';
  const unchangedRow = el<HTMLElement>('div', 'dlg-unchanged');
  unchangedRow.append(unchangedNote, unchangedToggle);
  const unchangedSection = section('import-unchanged', [unchangedRow]);

  // Scripts the file has that can't be imported.
  const invalidSection = section('import-invalid', [el('div', undefined, 'These scripts cannot be imported.')]);

  const sectionsWrap = el<HTMLElement>('div', 'import-sections');
  sectionsWrap.id = 'import-sections';
  sectionsWrap.append(collectionsSection.root, newSection.root, existingSection.root, unchangedSection.root, invalidSection.root);
  body.append(sectionsWrap);
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
    dialog, title, fileInput, chooseBtn, fileName, startRows: [intro, fileRow],
    sectionsWrap, collectionsSection, newSection, existingSection, unchangedSection, unchangedNote, unchangedToggle, invalidSection,
    newerLabel: newer.wrap.querySelector<HTMLElement>('.dlg-check')!, into,
    restoreOpts: { values: restore.values, enabled: restore.enabled },
    newOpts: { values: fresh.values, enabled: fresh.enabled },
    byCollection: byCollection.input, byCollectionRow: byCollection.wrap, pickInto,
    existingText: [leave.input, newer.input, always.input],
    existingValues: replace.values, existingEnabled: replace.enabled, result, error, cancel, ok,
  };
}

// Open the dialog. Resolves when it closes.
export function openImportDialog(): Promise<void> {
  if (!elements) elements = buildDialog();
  const ui = elements;
  if (dialogInFlight) return Promise.resolve();
  dialogInFlight = true;
  return new Promise((resolve) => {
    let busy = false;
    let done = false;
    let backup: ParsedBackup | null = null;
    let plan: PlannedScript[] = [];
    let planned: PlannedCollection[] = [];
    let containers: StoredCollection[] = [];
    // Each collection's place on the page, to group existing scripts by.
    let collectionOrder = new Map<string, number>();
    // The stored values of each installed copy the backup matches.
    let installedValues: Record<string, Record<string, unknown>> = {};
    // All collections here, for the new collection's free name.
    let allHere: StoredCollection[] = [];
    const checked = new Set<number>();
    // The backup's collections to restore or add scripts to, by uuid;
    // the scripts restoring puts in collections; and all those the
    // Directory collections section takes, which the other sections
    // leave out.
    const restoring = new Set<string>();
    let restored = new Set<number>();
    let taken = new Set<number>();
    // Each existing script's row, greyed when the choice leaves it alone.
    const existingRows = new Map<number, HTMLElement>();
    const sections = [
      ui.sectionsWrap, ui.collectionsSection.root, ui.newSection.root, ui.existingSection.root, ui.unchangedSection.root, ui.invalidSection.root,
    ];
    const checkboxes = [
      ...Object.values(ui.restoreOpts), ...Object.values(ui.newOpts), ui.byCollection, ui.pickInto, ui.existingValues, ui.existingEnabled,
    ];
    const abort = new AbortController();
    const on = <K extends keyof HTMLElementEventMap>(target: HTMLElement, type: K, fn: (ev: HTMLElementEventMap[K]) => void): void => {
      target.addEventListener(type, fn as EventListener, { signal: abort.signal });
    };
    const finish = (): void => {
      abort.abort();
      withdrawImportSides();
      dialogInFlight = false;
      if (ui.dialog.open) ui.dialog.close();
      resolve();
    };
    // Once the import has run, the dialog shows only its results, with
    // Close (or Esc). Nothing is left to do here: the preview no longer
    // matches what's installed, so another import starts afresh.
    const showResults = (title: string): void => {
      done = true;
      setBusy(false);
      ui.title.textContent = title;
      for (const node of [...ui.startRows, ...sections]) node.hidden = true;
      ui.cancel.hidden = true;
      ui.ok.disabled = false;
      ui.ok.textContent = 'Close';
      ui.ok.title = '';
      ui.result.parentElement!.scrollTop = 0;
      ui.ok.focus();
    };

    ui.title.textContent = 'Import scripts';
    ui.fileInput.value = '';
    ui.fileName.textContent = '';
    for (const node of sections) node.hidden = true;
    for (const node of ui.startRows) node.hidden = false;
    for (const sec of [ui.collectionsSection, ui.newSection, ui.existingSection, ui.unchangedSection, ui.invalidSection]) sec.tableWrap.replaceChildren();
    for (const [opts, start] of [[ui.restoreOpts, DEFAULT_CHOICES.restore], [ui.newOpts, DEFAULT_CHOICES.new]] as const) {
      opts.values.checked = start.values;
      opts.enabled.checked = start.enabled;
    }
    ui.byCollection.checked = DEFAULT_CHOICES.new.byCollection;
    ui.pickInto.checked = !DEFAULT_CHOICES.new.byCollection;
    for (const r of ui.existingText) r.checked = r.value === DEFAULT_CHOICES.existing.text;
    ui.existingValues.checked = DEFAULT_CHOICES.existing.values;
    ui.existingEnabled.checked = DEFAULT_CHOICES.existing.enabled;
    ui.result.hidden = true;
    ui.result.replaceChildren();
    ui.error.textContent = '';
    ui.cancel.hidden = false;
    ui.ok.textContent = 'Import';
    const controls = (): (HTMLInputElement | HTMLButtonElement | HTMLSelectElement)[] => [
      ui.chooseBtn, ui.into, ...ui.existingText, ...checkboxes,
      // Not a collection that's here already, which stays off.
      ...ui.dialog.querySelectorAll<HTMLInputElement>('.import-table input:not([data-fixed])'),
      ...ui.dialog.querySelectorAll<HTMLButtonElement>('.import-table button.import-diff'),
    ];
    for (const c of controls()) c.disabled = false;

    const choices = (): ImportChoices => ({
      restore: { values: ui.restoreOpts.values.checked, enabled: ui.restoreOpts.enabled.checked },
      new: {
        values: ui.newOpts.values.checked, enabled: ui.newOpts.enabled.checked,
        byCollection: byCollectionOffered && ui.byCollection.checked,
      },
      existing: {
        text: (ui.existingText.find((r) => r.checked)?.value ?? DEFAULT_CHOICES.existing.text) as ImportChoices['existing']['text'],
        values: ui.existingValues.checked,
        enabled: ui.existingEnabled.checked,
      },
    });

    // How many scripts here the backup has a newer version of.
    let newerCount = 0;
    // Set once the person picks a choice for existing scripts. Until
    // then it follows the default as the count changes.
    let existingPicked = false;

    // The existing rows' greying, and the button's count, from the
    // choices now. An existing row the choices do nothing to is greyed
    // with its box disabled (it keeps its check for when they change);
    // an unchecked one is greyed too.
    const refresh = (): void => {
      const newerOff = busy || done || newerCount === 0;
      ui.existingText[1].disabled = newerOff;
      ui.newerLabel.classList.toggle('off', newerOff);
      const now = choices();
      // The backup's collections column, while new scripts go elsewhere.
      for (const td of ui.newSection.tableWrap.querySelectorAll('td[data-col="collection"]')) td.classList.toggle('import-off', !now.new.byCollection);
      // The state each new script will get.
      for (const td of ui.newSection.tableWrap.querySelectorAll<HTMLElement>('td.import-enabled')) {
        td.textContent = enabledMark(!now.new.enabled || td.dataset.backupEnabled === 'true');
      }
      let count = restored.size;
      for (const c of planned) {
        const tr = ui.collectionsSection.tableWrap.querySelector<HTMLElement>(`tr[data-uuid="${CSS.escape(c.collection.uuid)}"]`);
        if (!tr) continue;
        const adding = restoring.has(c.collection.uuid) ? addingScripts(c, plan).length : 0;
        count += adding;
        tr.querySelector('[data-col="count"]')!.classList.toggle('import-change', adding > 0);
        // The state a new one will have; one here keeps its own.
        // One that can't be restored is never made.
        if (restorable(c)) tr.querySelector('[data-col="enabled"]')!.textContent = enabledMark(!now.restore.enabled || c.collection.enabled);
      }
      for (const p of plan) {
        // An empty script only a restore brings in.
        if (taken.has(p.script.index) || isEmptyScript(p.script.text) || unchanged.has(p.script.index)) continue;
        const kept = checked.has(p.script.index);
        const action = actionFor(p, now);
        const noop = action.kind === 'skip';
        const tr = existingRows.get(p.script.index);
        if (tr) {
          const skip = noop || !kept;
          tr.classList.toggle('import-skip', skip);
          // A column whose option is off is greyed; a difference the
          // import will apply is highlighted.
          const applies = { version: false, content: false, type: false, enabled: false, values: false };
          if (!skip && action.kind === 'update') {
            applies.version = applies.content = applies.type = action.text;
            applies.enabled = action.enabled;
            applies.values = action.values;
          }
          for (const [col, on] of Object.entries(applies)) {
            const td = tr.querySelector<HTMLElement>(`[data-col="${col}"]`)!;
            td.classList.toggle('import-change', on && td.dataset.differs !== undefined);
          }
          tr.querySelector('[data-col="enabled"]')!.classList.toggle('import-off', !now.existing.enabled);
          tr.querySelector('[data-col="values"]')!.classList.toggle('import-off', !now.existing.values);
          tr.querySelector<HTMLInputElement>('td:first-child input')!.disabled = busy || done || noop;
          tr.title = noop ? NOOP_TITLE : '';
        }
        if (kept && !noop) count++;
      }
      const allBox = ui.existingSection.tableWrap.querySelector<HTMLInputElement>('thead input');
      if (allBox) {
        const live = [...existingRows.values()].map((tr) => tr.querySelector<HTMLInputElement>('td:first-child input')!)
          .filter((b) => !b.disabled);
        allBox.disabled = busy || done || live.length === 0;
        if (live.length > 0) allBox.checked = live.every((b) => b.checked);
      }
      ui.ok.disabled = busy || count === 0;
      // Why it's greyed, once there's a backup to import.
      ui.ok.title = !busy && !done && backup && count === 0 ? 'This import would update zero scripts' : '';
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
      backupFileName = file.name;
      // An earlier file's copies are no longer what this dialog imports.
      withdrawImportSides();
      backup = null;
      plan = [];
      planned = [];
      restoring.clear();
      restored = new Set();
      taken = new Set();
      newerCount = 0;
      existingPicked = false;
      unchangedOpen = false;
      try {
        const parsed = readBackup(new Uint8Array(await file.arrayBuffer()));
        const [installed, hashes, collections] = await Promise.all([
          readInstalled(), Promise.all(parsed.scripts.map((s) => sha256Hex(s.text))), getCollections(),
        ]);
        if (gen !== fileGen) return;
        const planning = planImport(parsed, installed, hashes);
        const matched = [...new Set(planning.flatMap((p) => p.match ? [p.match.id] : []))];
        let values: Record<string, Record<string, unknown>> = {};
        try {
          if (matched.length > 0) values = await readScriptValues(matched);
        } catch (err) {
          throw new InstalledValuesError(`The installed scripts’ stored values could not be read: ${describeError(err)}`);
        }
        // Set only once all of it is read, and only for the latest file.
        if (gen !== fileGen) return;
        backup = parsed;
        plan = planning;
        installedValues = values;
        const mine = collections.filter((c) => !isSmDevCollection(c.path));
        planned = planCollections(parsed, mine.map((c) => ({
          id: c.id, name: effectiveDisplayName(c), path: c.path, enabled: c.enabled, scriptCount: c.scriptIds.length,
        })));
        containers = mine.filter((c) => isContainerCollection(c.path));
        collectionOrder = new Map(collections.map((c, i) => [c.id, i]));
        allHere = collections;
      } catch (err) {
        if (gen !== fileGen) return;
        for (const node of sections) node.hidden = true;
        ui.error.textContent = err instanceof ImportFormatError || err instanceof InstalledValuesError
          ? err.message : `This file could not be read: ${describeError(err)}`;
        refresh();
        return;
      }
      showPlan(backup);
    };

    const showPlan = (parsed: ParsedBackup): void => {
      checked.clear();
      for (const p of plan) checked.add(p.script.index);
      restoring.clear();
      for (const c of planned) if (restorable(c) || updatable(c, plan)) restoring.add(c.collection.uuid);
      // Directory, manifest and GitHub collections: a scripts
      // collection's scripts are listed as new or existing scripts.
      const located = planned.filter((c) => c.collection.kind !== 'scripts');
      ui.collectionsSection.heading.textContent = `Directory collections (${located.length})`;
      ui.collectionsSection.tableWrap.replaceChildren(collectionsTable(located, plan, restoring, () => {
        showScripts();
      }, on));
      ui.collectionsSection.root.hidden = located.length === 0;
      ui.sectionsWrap.hidden = false;

      // New scripts go into a new collection by default. `showScripts`
      // names it.
      newBase = parsed.source === 'other'
        ? `Imported scripts (${new Date().toLocaleDateString()})`
        : `Imported from ${SOURCE_NAMES[parsed.source]} (${new Date().toLocaleDateString()})`;
      ui.into.replaceChildren();
      ui.into.appendChild(el<HTMLOptionElement>('option'));
      for (const c of containers) {
        const o = el<HTMLOptionElement>('option', undefined, effectiveDisplayName(c));
        o.value = c.id;
        ui.into.appendChild(o);
      }
      ui.into.value = '';
      showScripts();
    };

    // The new collection's name before numbering.
    let newBase = '';
    // The chosen file's name, for the compare page's "Import from".
    let backupFileName = '';
    // Whether every new script has a scripts collection in the backup,
    // so they can go into those by name.
    let byCollectionOffered = false;
    // Existing scripts with no changes, which never import; and whether
    // their table is shown.
    let unchanged = new Set<number>();
    let unchangedOpen = false;
    const showUnchanged = (): void => {
      ui.unchangedSection.tableWrap.hidden = !unchangedOpen;
      ui.unchangedToggle.textContent = unchangedOpen ? 'Hide' : 'Show';
      ui.unchangedToggle.setAttribute('aria-expanded', String(unchangedOpen));
    };

    // An existing script's row, after its checkbox.
    // `unchanged`: in the table of scripts with no changes, which says
    // they're the same, so the Values cell doesn't.
    const existingCells = (p: PlannedScript, unchanged = false): HTMLElement[] => {
      const content = el<HTMLTableCellElement>('td', 'import-here');
      if (p.here === 'same') {
        content.textContent = contentText(p);
        content.title = hereTitle(p);
      } else {
        // Opens the compare page: the installed copy, then the backup's.
        const diff = el<HTMLButtonElement>('button', 'import-diff', 'DIFF');
        diff.type = 'button';
        diff.title = 'Compare the installed version with the version to be imported';
        diff.addEventListener('click', () => {
          const token = offerImportSide({ fileName: backupFileName, text: p.script.text, fileUrl: p.match!.fileUrl, files: p.script.files });
          void openExtensionTab(compareUrl({ import: token }, p.match!.id));
        });
        content.appendChild(diff);
      }
      const version = el<HTMLTableCellElement>('td', 'import-version', versionText(p));
      const enabled = el<HTMLTableCellElement>('td', 'import-enabled',
        p.match!.enabled === p.script.enabled ? enabledMark(p.match!.enabled)
          : `${enabledMark(p.match!.enabled)}${ARROW}${enabledMark(p.script.enabled)}`);
      const values = el<HTMLTableCellElement>('td', 'import-values', valuesText(installedValues[p.match!.id], p.script.values, !unchanged));
      const type = typeCell(p.match!.fileUrl, 'Where the installed copy loads from');
      const to = locationChange(p);
      if (to !== undefined) type.append(ARROW, ...typeCell(to ?? undefined, 'Where it would load from').childNodes);
      // Which cells `refresh` greys or highlights, and which show a
      // difference.
      for (const [td, col, differs] of [
        [version, 'version', version.textContent!.includes(ARROW)],
        [content, 'content', p.here !== 'same'],
        [type, 'type', to !== undefined],
        [enabled, 'enabled', p.match!.enabled !== p.script.enabled],
        [values, 'values', values.textContent!.includes(ARROW)],
      ] as const) {
        td.dataset.col = col;
        if (differs) td.dataset.differs = '';
      }
      return [
        el('td', 'import-collection', p.match?.collectionName ?? ''),
        installedNameCell(p),
        version,
        content,
        enabled,
        type,
        values,
      ];
    };

    // The New, Existing and Invalid sections, of the scripts no
    // restored collection takes.
    const showScripts = (): void => {
      if (!backup) return;
      // The new collection, numbered as the import will number it if the
      // name is taken, here or by a collection restored before it.
      const restoredNames = planned.filter((c) => restorable(c) && restoring.has(c.collection.uuid))
        .map((c): StoredCollection => ({ id: '', path: '', displayName: c.collection.name, scriptIds: [], enabled: true, lastRefreshedAt: 0 }));
      const newName = freeCollectionName(newBase, [...allHere, ...restoredNames], null);
      const newOption = ui.into.options[0];
      newOption.textContent = `(New) ${newName}`;
      newOption.value = '';
      newOption.dataset.newName = newName;
      restored = restoredScripts(planned, restoring);
      taken = collectionScripts(planned, plan);
      existingRows.clear();
      const outside = plan.filter((p) => !taken.has(p.script.index));
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
      // Grouped by the collection the installed copy is in, in page order.
      const place = (p: PlannedScript): number => collectionOrder.get(p.match!.collectionId) ?? Infinity;
      const matched = rest.filter((p) => p.match).sort((a, b) => place(a) - place(b));
      // Exactly the same in every column: nothing to import.
      const same = (p: PlannedScript): boolean => p.here === 'same' && p.match!.enabled === p.script.enabled
        && !valuesText(installedValues[p.match!.id], p.script.values).includes(ARROW) && locationChange(p) === undefined;
      const unchangedRows = matched.filter(same);
      const here = matched.filter((p) => !same(p));
      unchanged = new Set(unchangedRows.map((p) => p.script.index));
      const newer = here.filter((p) => p.here === 'older-here').length;

      ui.newSection.heading.textContent = `New scripts (${added.length})`;
      byCollectionOffered = added.length > 0 && added.every((p) => backupScriptsCollection(p.script, planned));
      // Names a collection made for new scripts can't take, so it's numbered.
      const takenNames = [...allHere, ...restoredNames];
      ui.byCollectionRow.hidden = !byCollectionOffered;
      ui.pickInto.hidden = !byCollectionOffered;
      ui.newSection.tableWrap.replaceChildren(scriptTable('import-new-table', added, byCollectionOffered ? [COLLECTION_HEADING, ...NEW_HEADINGS] : NEW_HEADINGS, (p) => [
        ...(byCollectionOffered ? [backupCollectionCell(backupScriptsCollection(p.script, planned)!, takenNames)] : []),
        el('td', 'import-name', p.script.name),
        el('td', 'import-version', p.script.version),
        newEnabledCell(p),
        typeCell(arrivingLocation(p.script), 'Where it will load from'),
        valuesCell(p.script.values !== undefined),
      ]));
      ui.existingSection.heading.textContent = `Existing scripts with changes (${here.length})`;
      ui.existingSection.tableWrap.replaceChildren(scriptTable('import-existing-table', here,
        EXISTING_HEADINGS, (p, tr) => {
          existingRows.set(p.script.index, tr);
          return existingCells(p);
        }));
      ui.existingSection.root.hidden = here.length === 0;
      ui.unchangedSection.heading.textContent = `Existing scripts with no changes (${unchangedRows.length})`;
      ui.unchangedNote.textContent = `${unchangedRows.length} existing ${unchangedRows.length === 1 ? 'script is' : 'scripts are'} exactly the same and will not be imported.`;
      ui.unchangedSection.tableWrap.replaceChildren(plainTable('import-unchanged-table', unchangedRows, EXISTING_HEADINGS, (p) => existingCells(p, true)));
      ui.unchangedSection.root.hidden = unchangedRows.length === 0;
      showUnchanged();
      ui.newSection.root.hidden = added.length === 0;

      ui.newerLabel.querySelector('span')!.textContent = newerLabel(newer);
      newerCount = newer;
      // The default, unless it has nothing to do: then it is greyed,
      // and Keep is the choice. A choice the person made stays, unless
      // it is the greyed one.
      if (!existingPicked) {
        const start = newer === 0 && DEFAULT_CHOICES.existing.text === 'newer' ? 'leave' : DEFAULT_CHOICES.existing.text;
        for (const r of ui.existingText) r.checked = r.value === start;
      } else if (newer === 0 && ui.existingText[1].checked) {
        ui.existingText[0].checked = true;
      }
      refresh();
    };

    // A new script's Enabled cell, filled by `refresh` from the Enabled
    // state choice.
    const newEnabledCell = (p: PlannedScript): HTMLElement => {
      const td = el<HTMLTableCellElement>('td', 'import-enabled');
      // Its own copy of the backup's state: `plan` is cleared while the
      // next file is read, and this table stays up until then.
      td.dataset.backupEnabled = String(p.script.enabled);
      return td;
    };

    // A section's table: a checkbox per script (and one for all), then
    // `cells` for each.
    const scriptTable = (
      id: string, rows: readonly PlannedScript[], headings: readonly Heading[],
      cells: (p: PlannedScript, tr: HTMLTableRowElement) => HTMLElement[],
    ): HTMLElement => {
      const table = el<HTMLTableElement>('table', 'import-table with-checks');
      table.id = id;
      const head = el<HTMLTableRowElement>('tr');
      const all = el<HTMLInputElement>('input');
      all.type = 'checkbox';
      all.checked = true;
      all.title = SELECT_ALL;
      all.setAttribute('aria-label', SELECT_ALL);
      const allCell = el<HTMLTableCellElement>('th');
      allCell.appendChild(all);
      head.append(allCell, ...headings.map(headingCell));
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
          all.checked = boxes.every((b) => b.checked || b.disabled);
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
        // Not the rows the choices do nothing to.
        rows.forEach((p, i) => {
          if (boxes[i].disabled) return;
          boxes[i].checked = all.checked;
          if (all.checked) checked.add(p.script.index);
          else checked.delete(p.script.index);
        });
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
        // Not the scripts with no changes.
        const kept = new Set([...checked].filter((i) => !unchanged.has(i)));
        const out = await importScripts(buildImportRequest(backup, plan, kept, choices(), into, planned, restoring));
        // A line per action.
        const scripts = (n: number): string => `${n} ${n === 1 ? 'script' : 'scripts'}`;
        const collections = (n: number): string => `${n} ${n === 1 ? 'collection' : 'collections'}`;
        const lines = [
          ...(out.restored > 0 ? [`Added ${collections(out.restored)} with ${scripts(out.restoredScripts)}.`] : []),
          ...(out.added > 0 ? [`Added ${scripts(out.added)} to ${collections(out.addedTo)}.`] : []),
          ...(out.installed > 0 ? [`Imported ${scripts(out.installed)}.`] : []),
          ...(out.updated > 0 ? [`Updated ${scripts(out.updated)}.`] : []),
        ];
        ui.result.replaceChildren(...(lines.length > 0 ? lines : ['Nothing changed.']).map((line) => el('p', 'dlg-done', line)));
        if (out.keptAsText.length > 0) {
          ui.result.appendChild(el('p', 'dlg-gap', 'These scripts’ files couldn’t be read, so they were imported as text and won’t update from those files:'));
          const list = el<HTMLUListElement>('ul');
          for (const name of out.keptAsText) list.appendChild(el('li', undefined, name));
          ui.result.appendChild(list);
        }
        if (out.failed.length > 0) {
          ui.result.appendChild(el('p', 'dlg-gap', 'These failed:'));
          const list = el<HTMLUListElement>('ul');
          for (const f of out.failed) list.appendChild(el('li', undefined, `${f.name}: ${f.message}`));
          ui.result.appendChild(list);
        }
        ui.result.hidden = false;
        showResults('Import finished');
      } catch (err) {
        // Some of it may have been written: open the dialog again to
        // retry against what's here now.
        showResults('Import failed');
        ui.result.replaceChildren(el('p', undefined, 'Some scripts may have been imported. Open the import again to see what’s here now.'));
        ui.result.hidden = false;
        ui.error.textContent = describeError(err);
      }
    };

    on(ui.chooseBtn, 'click', () => ui.fileInput.click());
    on(ui.fileInput, 'change', () => {
      const file = ui.fileInput.files?.[0];
      if (file) void onFile(file);
    });
    for (const input of checkboxes) on(input, 'change', refresh);
    for (const input of ui.existingText) {
      on(input, 'change', () => {
        existingPicked = true;
        refresh();
      });
    }
    // Choosing a collection there means adding to it, even the one
    // already shown.
    for (const type of ['change', 'click'] as const) {
      on(ui.into, type, () => {
        if (ui.pickInto.checked) return;
        ui.pickInto.checked = true;
        refresh();
      });
    }
    on(ui.unchangedToggle, 'click', () => {
      unchangedOpen = !unchangedOpen;
      showUnchanged();
    });
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

// The Directory collections section's table: a checkbox for each
// collection a restore can make or the import can add scripts to, then
// its name, type bubble, location, enabled state, whether it's here
// already, and its scripts. `changed` runs when a checkbox does.
function collectionsTable(
  planned: readonly PlannedCollection[],
  plan: readonly PlannedScript[],
  restoring: Set<string>,
  changed: () => void,
  on: (target: HTMLElement, type: 'change', fn: () => void) => void,
): HTMLElement {
  const table = el<HTMLTableElement>('table', 'import-table with-checks');
  table.id = 'import-collections-table';
  const head = el<HTMLTableRowElement>('tr');
  // Checks or clears every collection that can be restored.
  const all = el<HTMLInputElement>('input');
  all.type = 'checkbox';
  all.title = SELECT_ALL;
  all.setAttribute('aria-label', SELECT_ALL);
  const allCell = el<HTMLTableCellElement>('th');
  allCell.appendChild(all);
  head.append(allCell, ...COLLECTION_HEADINGS.map(headingCell));
  table.appendChild(el('thead')).appendChild(head);
  const tbody = el<HTMLTableSectionElement>('tbody');
  const live: { box: HTMLInputElement; uuid: string }[] = [];
  const syncAll = (): void => {
    all.checked = live.length > 0 && live.every((l) => l.box.checked);
  };
  for (const c of planned) {
    const bc = c.collection;
    const tr = el<HTMLTableRowElement>('tr');
    tr.dataset.uuid = bc.uuid;
    const box = el<HTMLInputElement>('input');
    box.type = 'checkbox';
    box.checked = restoring.has(bc.uuid);
    const fixed = !restorable(c) && !updatable(c, plan);
    if (fixed) {
      box.disabled = true;
      box.dataset.fixed = '';
    }
    box.setAttribute('aria-label', `${c.here ? 'Update' : 'Restore'} ${bc.name}`);
    if (!fixed) live.push({ box, uuid: bc.uuid });
    on(box, 'change', () => {
      if (box.checked) restoring.add(bc.uuid);
      else restoring.delete(bc.uuid);
      syncAll();
      changed();
    });
    const boxCell = el<HTMLTableCellElement>('td');
    boxCell.appendChild(box);
    // The type bubble the collections page shows for it.
    const kind = el<HTMLTableCellElement>('td', 'import-kind');
    if (bc.location) kind.appendChild(makeCollectionTypeBubble(bc.location));
    const status = el<HTMLTableCellElement>('td', 'import-here', c.here ? 'Already exists' : c.cantRestore ? 'Can’t restore' : 'New');
    // Only a collection whose scripts import one by one needs saying why.
    if (c.cantRestore) {
      status.title = c.here
        ? `Exists as “${c.here.name}”. Its scripts are listed as new or existing scripts.`
        : 'This export is from an older version that doesn’t record where its scripts are in the collection. Its scripts are listed as new or existing scripts.';
    }
    // Here, what it has and what it will have: an import never removes
    // its scripts.
    const adding = addingScripts(c, plan).length;
    const count = el<HTMLTableCellElement>('td', 'import-count', !c.here ? String(c.scripts.length)
      : adding > 0 ? `${c.here.scriptCount}${ARROW}${c.here.scriptCount + adding}` : String(c.here.scriptCount));
    count.dataset.col = 'count';
    // One here keeps its own state; a new one's is set by `refresh`,
    // from the choices.
    const enabled = el<HTMLTableCellElement>('td', 'import-enabled', c.here ? enabledMark(c.here.enabled) : '');
    enabled.dataset.col = 'enabled';
    tr.append(
      boxCell,
      el('td', 'import-name', bc.name),
      kind,
      locationCell(bc.location),
      enabled,
      status,
      count,
    );
    if (fixed) tr.classList.add('import-skip');
    tbody.appendChild(tr);
  }
  syncAll();
  if (live.length === 0) {
    all.disabled = true;
    all.dataset.fixed = '';
  }
  on(all, 'change', () => {
    for (const l of live) {
      l.box.checked = all.checked;
      if (all.checked) restoring.add(l.uuid);
      else restoring.delete(l.uuid);
    }
    changed();
  });
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

// The heading checkbox of each table.
const SELECT_ALL = 'Select/Unselect all';

// An existing row the choices do nothing to.
const NOOP_TITLE = 'The current choices leave this script as it is';

// The Existing section's second choice, with how many scripts it covers.
function newerLabel(count: number): string {
  return `Replace when the imported version is newer (${count})`;
}

// A table's column heading, and its tooltip saying what the column
// shows. Tooltips punctuate as messages do (CLAUDE.md): one sentence
// has no trailing period, and each of two or more has one.
type Heading = readonly [text: string, title: string];

function headingCell([text, title]: Heading): HTMLElement {
  const th = el<HTMLTableCellElement>('th', undefined, text);
  th.title = title;
  return th;
}

const COLLECTION_HEADINGS: readonly Heading[] = [
  ['Collection', 'Collection name'],
  ['Type', 'Collection type: how it loads scripts'],
  ['Location', 'Where the collection loads its scripts from'],
  ['Enabled', 'Whether the collection will be enabled'],
  ['Status', 'Whether the collection is new'],
  ['Scripts', 'How many scripts the collection has.\nWhen adding: Current count \u2192 Count after the import.'],
];

const COLLECTION_HEADING: Heading = ['Collection', 'The collection name in the backup.\n(New) when it doesn’t exist yet.'];

// A new script's collection: the one here, or the name one made for it
// will have (numbered as the import numbers it, unless it's built in),
// marked new.
function backupCollectionCell(c: PlannedCollection, taken: readonly StoredCollection[]): HTMLElement {
  const bc = c.collection;
  const made = bc.builtin ? bc.name : freeCollectionName(bc.name, taken, null);
  const td = el<HTMLTableCellElement>('td', 'import-collection', c.here ? c.here.name : `${made} (New)`);
  td.dataset.col = 'collection';
  return td;
}

const NEW_HEADINGS: readonly Heading[] = [
  ['Name', 'The script’s @name'],
  ['Version', 'The script’s @version'],
  ['Enabled', 'Whether the script will be enabled'],
  ['Type', 'Where the script will load from'],
  ['Values', 'Whether the backup has stored values for the script'],
];

const EXISTING_HEADINGS: readonly Heading[] = [
  ['Collection', 'The collection the installed copy is in'],
  ['Name', 'The script’s @name'],
  ['Version', 'The script’s @version (current and imported).\nWhen changing: Current version \u2192 Imported version.'],
  ['Content', 'Whether the script’s code (current and imported) is the same'],
  ['Enabled', 'Whether the script (current and imported) is enabled.\nWhen changing: Current state \u2192 Imported state.'],
  ['Type', 'Where the script (current and imported) loads from.\nWhen changing: Current type \u2192 Imported type.'],
  ['Values', 'Whether the script (current and imported) has stored values.\nWhen changing: Current state \u2192 Imported state, \u2205 for none.'],
];

const INVALID_HEADINGS: readonly Heading[] = [
  ['Name', 'The script’s name, or its file in a zip backup'],
  ['Reason', 'Why it can’t be imported'],
];

// Any imported location, for its Type chip.
const IMPORTED_CHIP_URL = 'imported:///';

// The Type column: the scheme chip the collections page shows for
// `location` (`http`, `file`, `imported`…), linked to it when it is a
// URL or a file. `imported` for a script with no location.
function typeCell(location: string | undefined, what: string): HTMLElement {
  const td = el<HTMLTableCellElement>('td', 'import-type');
  if (!location) {
    // Nowhere to load from: it comes in as its text.
    td.appendChild(makeSchemeChip(IMPORTED_CHIP_URL));
    return td;
  }
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
  // The chip's own tooltip would cover the link's, which names where.
  chip.removeAttribute('title');
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

// Reading the installed copies' values failed, rather than the file.
class InstalledValuesError extends Error {}

// An Enabled column state, as a mark that doesn't look clickable.
function enabledMark(on: boolean): string {
  return on ? CHECK : '\u2610';
}

// The New table's Values column: a check for a script with stored
// values in the file.
function valuesCell(hasValues: boolean): HTMLElement {
  const td = el<HTMLTableCellElement>('td', 'import-values', hasValues ? '\u2713' : '');
  if (hasValues) {
    td.title = 'Has stored values in the backup';
    td.setAttribute('aria-label', 'Has stored values');
  }
  return td;
}

// A table of scripts with no checkboxes: nothing to choose for them.
function plainTable(
  id: string, rows: readonly PlannedScript[], headings: readonly Heading[], cells: (p: PlannedScript) => HTMLElement[],
): HTMLElement {
  const table = el<HTMLTableElement>('table', 'import-table');
  table.id = id;
  const head = el<HTMLTableRowElement>('tr');
  head.append(...headings.map(headingCell));
  table.appendChild(el('thead')).appendChild(head);
  const tbody = el<HTMLTableSectionElement>('tbody');
  for (const p of rows) {
    const tr = el<HTMLTableRowElement>('tr');
    tr.append(...cells(p));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  return table;
}

// The scripts the file has that can't be imported: each one's file in
// the zip (or name, in Tampermonkey's JSON) and why.
function invalidTable(problems: readonly BackupProblem[]): HTMLElement {
  const table = el<HTMLTableElement>('table', 'import-table');
  table.id = 'import-invalid-table';
  const head = el<HTMLTableRowElement>('tr');
  head.append(...INVALID_HEADINGS.map(headingCell));
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
      inScripts: isContainerCollection(byId.get(m.collectionId)!.path),
    };
    if (m.contentHash) copy.contentHash = m.contentHash;
    const info = infos[importInfoKey(m.relativePath)] as ImportInfo | undefined;
    if (info?.foreignId) copy.importedId = info.foreignId;
    return copy;
  });
}
