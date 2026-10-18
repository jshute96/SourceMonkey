// The import dialog, opened from the collections page's ⋯ menus: choose
// a backup file, see what it holds against what's here, choose what
// happens, then import. It stays open to say what was done. See
// docs/import.md.

import { describeError, getAllScriptMetas, getCollections, type StoredCollection } from './script-store.js';
import { importScripts } from './worker-client.js';
import { effectiveDisplayName } from './collection-display.js';
import { importInfoKey, isContainerCollection, isImportedUrl, isSmDevCollection, isStoredTextUrl, type ImportInfo } from './directories.js';
import { ImportFormatError, readBackup, SOURCE_NAMES, type ParsedBackup } from './import-backup.js';
import {
  actionFor, actionText, buildImportRequest, DEFAULT_CHOICES, hereText, planImport,
  type ImportChoices, type InstalledCopy, type PlannedScript,
} from './import-plan.js';
import { sha256Hex } from '../bytes.js';
import { displayLocation } from '../script-display.js';

interface DialogElements {
  dialog: HTMLDialogElement;
  title: HTMLElement;
  fileInput: HTMLInputElement;
  chooseBtn: HTMLButtonElement;
  fileName: HTMLElement;
  summary: HTMLElement;
  problems: HTMLElement;
  tableWrap: HTMLElement;
  options: HTMLElement[];
  into: HTMLSelectElement;
  follow: HTMLInputElement;
  existing: HTMLInputElement[];
  values: HTMLInputElement;
  enabled: HTMLInputElement;
  result: HTMLElement;
  error: HTMLElement;
  cancel: HTMLButtonElement;
  ok: HTMLButtonElement;
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
  body.append(el('span', 'dlg-label', 'File'), fileRow);

  const summary = el<HTMLElement>('p', 'dlg-summary');
  summary.id = 'import-summary';
  const problems = el<HTMLElement>('div', 'dlg-problems');
  problems.id = 'import-problems';
  const tableWrap = el<HTMLElement>('div', 'import-table-wrap');
  body.append(summary, problems, tableWrap);

  // New scripts.
  const newLabel = el<HTMLElement>('span', 'dlg-label', 'New scripts');
  const newSlot = el<HTMLElement>('div', 'dlg-includes');
  const intoRow = el<HTMLElement>('label', 'dlg-into');
  const into = el<HTMLSelectElement>('select');
  into.id = 'import-into';
  intoRow.append(el('span', undefined, 'Into '), into);
  const follow = option('checkbox', 'import-follow', 'Update from their web addresses',
    'A script with a web address loads from it and takes its updates. The rest are kept as the file’s text.');
  newSlot.append(intoRow, follow.wrap);

  // Scripts already here.
  const existingLabel = el<HTMLElement>('span', 'dlg-label', 'Already here');
  const existingSlot = el<HTMLElement>('div', 'dlg-includes');
  const leave = option('radio', 'import-existing-leave', 'Leave them as they are', undefined, 'import-existing');
  const newer = option('radio', 'import-existing-newer', 'Replace the ones the file has a newer version of', undefined, 'import-existing');
  const always = option('radio', 'import-existing-always', 'Replace them all', undefined, 'import-existing');
  leave.input.value = 'leave';
  newer.input.value = 'newer';
  always.input.value = 'always';
  existingSlot.append(leave.wrap, newer.wrap, always.wrap,
    el('div', 'dlg-hint', 'The text of a script kept only in SourceMonkey is replaced. Any other loads from its own location, so only its values and on/off state change.'));

  // What comes with each script.
  const includeLabel = el<HTMLElement>('span', 'dlg-label', 'Include');
  const includeSlot = el<HTMLElement>('div', 'dlg-includes');
  const values = option('checkbox', 'import-values', 'Stored values',
    'Each script’s GM_setValue data. They replace the values of a script already here.');
  const enabled = option('checkbox', 'import-enabled', 'On/off state',
    'Without it, new scripts come in turned off.');
  includeSlot.append(values.wrap, enabled.wrap);

  body.append(newLabel, newSlot, existingLabel, existingSlot, includeLabel, includeSlot);
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
    dialog, title, fileInput, chooseBtn, fileName, summary, problems, tableWrap,
    options: [newLabel, newSlot, existingLabel, existingSlot, includeLabel, includeSlot],
    into, follow: follow.input, existing: [leave.input, newer.input, always.input],
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
    let containers: StoredCollection[] = [];
    const checked = new Set<number>();
    const resultCells = new Map<number, HTMLElement>();
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
    ui.fileName.textContent = 'No file chosen';
    ui.summary.textContent = '';
    ui.summary.hidden = true;
    ui.problems.replaceChildren();
    ui.problems.hidden = true;
    ui.tableWrap.replaceChildren();
    ui.tableWrap.hidden = true;
    for (const node of ui.options) node.hidden = true;
    ui.follow.checked = DEFAULT_CHOICES.followUrls;
    for (const r of ui.existing) r.checked = r.value === DEFAULT_CHOICES.existing;
    ui.values.checked = DEFAULT_CHOICES.values;
    ui.enabled.checked = DEFAULT_CHOICES.enabledFromFile;
    ui.result.hidden = true;
    ui.result.replaceChildren();
    ui.error.textContent = '';
    ui.cancel.hidden = false;
    ui.ok.textContent = 'Import';
    const controls = (): (HTMLInputElement | HTMLButtonElement | HTMLSelectElement)[] => [
      ui.chooseBtn, ui.into, ui.follow, ...ui.existing, ui.values, ui.enabled,
      ...ui.tableWrap.querySelectorAll('input'),
    ];
    for (const c of controls()) c.disabled = false;

    const choices = (): ImportChoices => ({
      existing: (ui.existing.find((r) => r.checked)?.value ?? DEFAULT_CHOICES.existing) as ImportChoices['existing'],
      values: ui.values.checked,
      enabledFromFile: ui.enabled.checked,
      followUrls: ui.follow.checked,
    });

    // Each row's Result, and the button's count, from the choices now.
    const refresh = (): void => {
      const now = choices();
      let count = 0;
      for (const p of plan) {
        const action = actionFor(p, now);
        const kept = checked.has(p.script.index);
        const cell = resultCells.get(p.script.index);
        if (cell) {
          cell.textContent = kept ? actionText(action, p) : 'Skip';
          cell.classList.toggle('import-skip', !kept || action.kind === 'skip');
        }
        if (kept && action.kind !== 'skip') count++;
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
      try {
        const parsed = readBackup(new Uint8Array(await file.arrayBuffer()));
        const [installed, hashes, collections] = await Promise.all([
          readInstalled(), Promise.all(parsed.scripts.map((s) => sha256Hex(s.text))), getCollections(),
        ]);
        if (gen !== fileGen) return;
        backup = parsed;
        plan = planImport(parsed, installed, hashes);
        containers = collections.filter((c) => isContainerCollection(c.path) && !isSmDevCollection(c.path));
      } catch (err) {
        if (gen !== fileGen) return;
        ui.summary.hidden = true;
        ui.problems.hidden = true;
        ui.tableWrap.hidden = true;
        for (const node of ui.options) node.hidden = true;
        ui.error.textContent = err instanceof ImportFormatError ? err.message : `This file could not be read: ${describeError(err)}`;
        refresh();
        return;
      }
      showPlan(backup);
    };

    const showPlan = (parsed: ParsedBackup): void => {
      const here = plan.filter((p) => p.match).length;
      ui.summary.textContent = `${parsed.label}: ${plan.length} ${plan.length === 1 ? 'script' : 'scripts'}`
        + (here > 0 ? `, ${here} already here.` : '.');
      ui.summary.hidden = false;
      ui.problems.replaceChildren();
      if (parsed.problems.length > 0) {
        ui.problems.appendChild(el('p', undefined, 'These could not be read, and are left out:'));
        const list = el<HTMLUListElement>('ul');
        for (const text of parsed.problems) list.appendChild(el('li', undefined, text));
        ui.problems.appendChild(list);
      }
      ui.problems.hidden = parsed.problems.length === 0;

      checked.clear();
      for (const p of plan) checked.add(p.script.index);
      ui.tableWrap.replaceChildren(buildTable());
      ui.tableWrap.hidden = false;

      // New scripts go into a new collection unless the dialog was
      // opened from one.
      const newName = parsed.source === 'other'
        ? `Imported scripts (${new Date().toLocaleDateString()})`
        : `Imported from ${SOURCE_NAMES[parsed.source]} (${new Date().toLocaleDateString()})`;
      ui.into.replaceChildren();
      const fresh = el<HTMLOptionElement>('option', undefined, `A new collection, “${newName}”`);
      fresh.value = '';
      fresh.dataset.newName = newName;
      ui.into.appendChild(fresh);
      for (const c of containers) {
        const o = el<HTMLOptionElement>('option', undefined, effectiveDisplayName(c));
        o.value = c.id;
        ui.into.appendChild(o);
      }
      ui.into.value = containers.some((c) => c.id === request.collectionId) ? request.collectionId! : '';
      for (const node of ui.options) node.hidden = false;
      refresh();
    };

    const buildTable = (): HTMLElement => {
      resultCells.clear();
      const table = el<HTMLTableElement>('table', 'import-table');
      table.id = 'import-table';
      const head = el<HTMLTableRowElement>('tr');
      const all = el<HTMLInputElement>('input');
      all.type = 'checkbox';
      all.checked = true;
      all.title = 'Import all';
      all.setAttribute('aria-label', 'Import all');
      const allCell = el<HTMLTableCellElement>('th');
      allCell.appendChild(all);
      head.append(allCell, ...['Name', 'Version', 'Here', 'Values', 'Result'].map((t) => el('th', undefined, t)));
      table.appendChild(el('thead')).appendChild(head);
      const tbody = el<HTMLTableSectionElement>('tbody');
      const boxes: HTMLInputElement[] = [];
      for (const p of plan) {
        const s = p.script;
        const tr = el<HTMLTableRowElement>('tr');
        tr.dataset.index = String(s.index);
        const box = el<HTMLInputElement>('input');
        box.type = 'checkbox';
        box.checked = true;
        box.setAttribute('aria-label', `Import ${s.name}`);
        on(box, 'change', () => {
          if (box.checked) checked.add(s.index);
          else checked.delete(s.index);
          all.checked = boxes.every((b) => b.checked);
          refresh();
        });
        boxes.push(box);
        const boxCell = el<HTMLTableCellElement>('td');
        boxCell.appendChild(box);
        const name = el<HTMLTableCellElement>('td', 'import-name', s.name);
        if (s.location) name.title = displayLocation(s.location);
        const here = hereText(p);
        const hereCell = el<HTMLTableCellElement>('td', 'import-here', here.text);
        hereCell.title = here.title;
        const count = s.values ? Object.keys(s.values).length : 0;
        const result = el<HTMLTableCellElement>('td', 'import-result');
        resultCells.set(s.index, result);
        tr.append(boxCell, name, el('td', 'import-version', s.version), hereCell,
          el('td', 'import-values', count > 0 ? String(count) : ''), result);
        tbody.appendChild(tr);
      }
      on(all, 'change', () => {
        for (const b of boxes) b.checked = all.checked;
        checked.clear();
        if (all.checked) for (const p of plan) checked.add(p.script.index);
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
        const out = await importScripts(buildImportRequest(backup, plan, checked, choices(), into));
        done = true;
        landed = out.installed > 0 ? out.collectionId : null;
        const parts = [
          ...(out.installed > 0 ? [`imported ${out.installed} ${out.installed === 1 ? 'script' : 'scripts'}`] : []),
          ...(out.updated > 0 ? [`updated ${out.updated}`] : []),
        ];
        const line = parts.length > 0 ? `${parts.join(' and ')}.` : 'nothing changed.';
        ui.result.replaceChildren(el('p', 'dlg-done', line.charAt(0).toUpperCase() + line.slice(1)));
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
    for (const input of [ui.follow, ...ui.existing, ui.values, ui.enabled]) on(input, 'change', refresh);
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
