// The export dialog, opened from the collections page's ⋯ menus: what to
// include, then Chrome's Save As. It stays open to say how many scripts
// went in and where the file went. See docs/export.md.

import { describeError } from './script-store.js';
import { makeCopyButton } from './copy-button.js';
import { EXPORT_CANCELLED, runExport, type ExportScope } from './export-backup.js';

interface DialogElements {
  dialog: HTMLDialogElement;
  title: HTMLElement;
  values: HTMLInputElement;
  files: HTMLInputElement;
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

function checkbox(id: string, label: string, hint: string): { wrap: HTMLElement; input: HTMLInputElement } {
  const wrap = el<HTMLElement>('div', 'dlg-option');
  const labelEl = el<HTMLLabelElement>('label', 'dlg-check');
  const input = el<HTMLInputElement>('input');
  input.type = 'checkbox';
  input.id = id;
  labelEl.append(input, el('span', undefined, label));
  wrap.append(labelEl, el('div', 'dlg-hint', hint));
  return { wrap, input };
}

function buildDialog(): DialogElements {
  const dialog = el<HTMLDialogElement>('dialog', 'sm-dialog export-dialog');
  const title = el<HTMLElement>('h2', 'dlg-title');
  dialog.appendChild(title);

  const body = el<HTMLElement>('div', 'dlg-body');
  body.appendChild(el('p', 'dlg-intro',
    'This saves a .zip file that SourceMonkey, Tampermonkey, Violentmonkey, and other compatible managers can import.'));
  const include = el<HTMLElement>('div', 'dlg-includes');
  const values = checkbox('export-values', 'Stored values',
    'Each script’s GM_setValue data.');
  const files = checkbox('export-files', 'Dependency files',
    'The @require, @resource and @icon files each script uses.');
  include.append(values.wrap, files.wrap);
  body.append(el('span', 'dlg-label', 'Include'), include);
  const result = el<HTMLElement>('div', 'dlg-result');
  result.id = 'export-result';
  result.hidden = true;
  body.appendChild(result);
  dialog.appendChild(body);

  const errorRow = el<HTMLElement>('div', 'dlg-error-row');
  const error = el<HTMLElement>('p', 'dlg-error');
  error.setAttribute('role', 'alert');
  errorRow.appendChild(error);
  dialog.appendChild(errorRow);

  const actions = el<HTMLElement>('div', 'dlg-actions');
  const cancel = el<HTMLButtonElement>('button', undefined, 'Cancel');
  cancel.type = 'button';
  const ok = el<HTMLButtonElement>('button', 'primary', 'Export…');
  ok.type = 'button';
  ok.id = 'export-confirm-btn';
  actions.append(cancel, ok);
  dialog.appendChild(actions);

  document.body.appendChild(dialog);
  return { dialog, title, values: values.input, files: files.input, result, error, cancel, ok };
}

export interface ExportDialogRequest {
  scope: ExportScope;
  // The collection's name, for a one-collection export.
  collectionName?: string;
}

// Open the dialog. Resolves when it closes.
export function openExportDialog(request: ExportDialogRequest): Promise<void> {
  if (!elements) elements = buildDialog();
  const ui = elements;
  if (dialogInFlight) return Promise.resolve();
  dialogInFlight = true;
  return new Promise((resolve) => {
    let busy = false;
    let done = false;
    const abort = new AbortController();
    const finish = (): void => {
      abort.abort();
      dialogInFlight = false;
      if (ui.dialog.open) ui.dialog.close();
      resolve();
    };

    ui.title.textContent = 'all' in request.scope
      ? 'Export all collections'
      : `Export collection: ${request.collectionName ?? ''}`;
    ui.values.checked = true;
    ui.files.checked = false;
    ui.values.disabled = false;
    ui.files.disabled = false;
    ui.result.hidden = true;
    ui.result.replaceChildren();
    ui.error.textContent = '';
    ui.cancel.hidden = false;
    ui.cancel.disabled = false;
    ui.ok.disabled = false;
    ui.ok.textContent = 'Export…';

    const setBusy = (on: boolean): void => {
      busy = on;
      ui.values.disabled = on;
      ui.files.disabled = on;
      ui.cancel.disabled = on;
      ui.ok.disabled = on;
      ui.ok.textContent = on ? 'Exporting…' : 'Export…';
    };

    const onOk = async (): Promise<void> => {
      if (done) {
        finish();
        return;
      }
      ui.error.textContent = '';
      setBusy(true);
      try {
        const out = await runExport(request.scope, { values: ui.values.checked, files: ui.files.checked });
        done = true;
        // The saved path in code font, with a button that copies it.
        const saved = el<HTMLElement>('p', 'dlg-saved');
        const pathEl = el<HTMLElement>('code', 'dlg-saved-path', out.path);
        pathEl.id = 'export-saved-path';
        saved.append(
          `Exported ${out.scriptCount} ${out.scriptCount === 1 ? 'script' : 'scripts'} to `,
          pathEl,
          makeCopyButton({ label: 'Copy path to clipboard', text: () => out.path }),
        );
        ui.result.replaceChildren(saved);
        ui.result.hidden = false;
        setBusy(false);
        ui.values.disabled = true;
        ui.files.disabled = true;
        ui.cancel.hidden = true;
        ui.ok.textContent = 'Close';
      } catch (err) {
        setBusy(false);
        const message = describeError(err);
        if (message !== EXPORT_CANCELLED) ui.error.textContent = `Export failed: ${message}`;
      }
    };

    ui.ok.addEventListener('click', () => void onOk(), { signal: abort.signal });
    ui.cancel.addEventListener('click', finish, { signal: abort.signal });
    // Esc while the zip is being saved would leave the save running
    // behind a closed dialog.
    ui.dialog.addEventListener('cancel', (ev) => {
      ev.preventDefault();
      if (!busy) finish();
    }, { signal: abort.signal });
    ui.dialog.showModal();
    ui.ok.focus();
  });
}
