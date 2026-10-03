// The "make a local copy of this script" dialog, opened from the Local
// copy button on the viewer's Collection row.
//
// It owns the whole action, the way the move dialog owns Move: the
// file name and header fields, the refusals, the write through
// `makeLocalCopy`, and any failure in its own error slot — so the
// caller only ever hears about a copy that landed.
//
// See docs/local-copy.md.

import {
  checkExistingFiles,
  COPY_OVER_ITSELF,
  defaultCopyName,
  dependencyFiles,
  downloadsCopiesDir,
  DOWNLOADS_COPIES_NAME,
  DOWNLOADS_COPIES_SUBDIR,
  findDownloadsCollection,
  isCopyOfItself,
  makeLocalCopy,
  planFiles,
  readDownloadsCopiesSetting,
  validateCopyName,
  type CopyPlan,
  type DependencyFile,
  type LocalCopyResult,
} from './local-copy.js';
import { effectiveDisplayName } from './collection-display.js';
import { isFileSchemeAccessAllowed, renderFileAccessBanner } from './file-access.js';
import { formatBytes } from '../script-display.js';
import {
  collectionUsesLocalFiles,
  describeError,
  getCollections,
  type StoredCollection,
  type StoredScript,
} from './script-store.js';
import { getValue } from '../userscript-header.js';
import { localEditVersion } from '../version-compare.js';
import { dlog } from '../debug-log.js';

export interface CopyDialogRequest {
  script: StoredScript;
}

interface DialogElements {
  dialog: HTMLDialogElement;
  banner: HTMLElement;
  target: HTMLElement;
  fileName: HTMLInputElement;
  deps: HTMLInputElement;
  depsLabel: HTMLElement;
  depsText: HTMLElement;
  depsList: HTMLElement;
  depsHint: HTMLElement;
  name: HTMLElement;
  versionWas: HTMLElement;
  version: HTMLInputElement;
  description: HTMLTextAreaElement;
  error: HTMLElement;
  cancel: HTMLButtonElement;
  ok: HTMLButtonElement;
}

let elements: DialogElements | null = null;

// One at a time, claimed synchronously — same reason as the other
// dialogs' guards: two overlapping opens would leave the first caller's
// promise unsettled and `showModal` throwing on the second.
let dialogInFlight = false;

function el<T extends HTMLElement>(tag: string, className?: string, text?: string): T {
  const node = document.createElement(tag) as T;
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// A one-line box that grows with its content, to the cap the CSS sets
// (four lines) and then scrolls. A `<textarea>` rather than an
// `<input>` because the value can be a sentence, but it still holds ONE
// line of a metadata block — see `sanitizeOneLine`.
function growingInput(id: string): HTMLTextAreaElement {
  const box = document.createElement('textarea');
  box.id = id;
  box.rows = 1;
  box.spellcheck = false;
  return box;
}

// Fit the box to its content. Height is cleared first so shrinking
// works: `scrollHeight` never reports less than the current height.
function autoGrow(box: HTMLTextAreaElement): void {
  box.style.height = 'auto';
  box.style.height = `${box.scrollHeight}px`;
}

// A metadata value is one line by definition, so a pasted newline
// becomes a space rather than a broken header. Same length, so the
// caret doesn't move.
function sanitizeOneLine(box: HTMLTextAreaElement): void {
  if (box.value.includes('\n') || box.value.includes('\r')) {
    box.value = box.value.replace(/[\r\n]/g, ' ');
  }
}

function textInput(id: string): HTMLInputElement {
  const input = el<HTMLInputElement>('input');
  input.type = 'text';
  input.id = id;
  input.spellcheck = false;
  input.autocomplete = 'off';
  return input;
}

function buildDialog(): DialogElements {
  const dialog = el<HTMLDialogElement>('dialog', 'sm-dialog copy-dialog');
  dialog.appendChild(el('h2', 'dlg-title', 'Make a local copy of this script'));

  // The file-access banner, when the toggle is off: a copy that can be
  // written but never read back would register as a broken script.
  const banner = el<HTMLElement>('div', 'dlg-banner');
  dialog.appendChild(banner);

  const body = el<HTMLElement>('div', 'dlg-body');
  // One tooltip per row, on the label AND the control: the label is
  // what a reader points at to ask "what is this?", and the control is
  // where the pointer already is when they wonder.
  const row = (
    label: string,
    control: HTMLElement,
    tooltip: string,
    note?: string,
  ): void => {
    const cell = el<HTMLElement>('span', 'dlg-label', label);
    // A second line under the label, for what the field accepts that
    // its name doesn't say.
    if (note) cell.appendChild(el('span', 'dlg-label-note', note));
    cell.title = tooltip;
    control.title = tooltip;
    body.appendChild(cell);
    body.appendChild(control);
  };

  const target = el<HTMLElement>('span', 'dlg-static');
  target.id = 'copy-target';
  row('Target collection', target,
    'Copy to this collection. It uses a directory under Chrome\u2019s Downloads directory.');

  const fileName = textInput('copy-file-name');
  row('Filename', fileName,
    'Copy script here, relative to the collection\u2019s directory. '
    + 'The relative path can include a subdirectory.',
    '(with subdir)');

  const depsWrap = el<HTMLElement>('div', 'dlg-deps');
  const depsLabel = el<HTMLLabelElement>('label', 'dlg-check');
  const deps = el<HTMLInputElement>('input');
  deps.type = 'checkbox';
  deps.id = 'copy-deps';
  const depsText = el<HTMLElement>('span');
  depsLabel.append(deps, depsText);
  depsWrap.appendChild(depsLabel);
  const depsHint = el<HTMLElement>('div', 'dlg-hint');
  depsWrap.appendChild(depsHint);
  const depsList = el<HTMLElement>('ul', 'dlg-deps-list');
  depsWrap.appendChild(depsList);
  // The row's own tooltip is about the paths it lists; the checkbox
  // decides whether anything is written there, which is a different
  // question, so it carries its own.
  row('Dependencies', depsWrap,
    'Local paths for @require and @resource files this script loads. '
    + 'Files at these local paths will be used if they exist.');
  depsLabel.title = 'Also save local copies of @require and @resource files if checked.';

  // The header fields are a group of their own: everything above says
  // where the copy goes, everything below is what will differ from the
  // script it is copied from.
  const heading = el<HTMLElement>('div', 'dlg-section', 'Updated headers in downloaded script');
  body.appendChild(heading);

  const name = el<HTMLElement>('span', 'dlg-static');
  name.id = 'copy-name';
  row('Name', name,
    'The @name for the copied script. Unchanged, to keep a link to the source script.');

  // `<original> → [new]`, so the edit is read against what it replaces
  // rather than having to be remembered.
  const versionWrap = el<HTMLElement>('div', 'dlg-arrow');
  const versionWas = el<HTMLElement>('span', 'dlg-was');
  versionWas.id = 'copy-version-was';
  // Its own, overriding the row's: this half is the version being
  // copied FROM, where the box beside it is the one being written.
  versionWas.title = 'The @version of the source script';
  const version = textInput('copy-version');
  versionWrap.append(versionWas, el('span', 'dlg-arrow-mark', '\u2192'), version);
  row('Version', versionWrap,
    'The @version for the source and copied script. '
    + 'The copied script gets a "-local" suffix by default.');

  const description = growingInput('copy-description');
  row('Description', description, 'The @description for the copied script');

  dialog.appendChild(body);

  // In the shared error row, so the text lines up with the form's
  // padding rather than the dialog's edge.
  const errorRow = el<HTMLElement>('div', 'dlg-error-row');
  const error = el<HTMLElement>('p', 'dlg-error');
  error.setAttribute('role', 'alert');
  errorRow.appendChild(error);
  dialog.appendChild(errorRow);

  const actions = el<HTMLElement>('div', 'dlg-actions');
  const cancel = el<HTMLButtonElement>('button', undefined, 'Cancel');
  cancel.type = 'button';
  const ok = el<HTMLButtonElement>('button', 'primary', 'Copy');
  ok.type = 'button';
  ok.id = 'copy-confirm-btn';
  // Enter in the description would insert a line the header can't hold,
  // and it is what a one-line field is expected to submit on. Wired
  // here rather than at the field, so it can name the button directly.
  description.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter') return;
    ev.preventDefault();
    ok.click();
  });
  actions.append(cancel, ok);
  dialog.appendChild(actions);

  document.body.appendChild(dialog);
  return {
    dialog, banner, target, fileName, deps, depsLabel, depsText, depsList, depsHint,
    name, versionWas, version, description, error, cancel, ok,
  };
}

// Open the dialog and resolve with the new copy, or null when it was
// dismissed or nothing was written.
export function openCopyDialog(request: CopyDialogRequest): Promise<LocalCopyResult | null> {
  if (!elements) elements = buildDialog();
  const ui = elements;
  if (dialogInFlight) return Promise.resolve(null);
  dialogInFlight = true;
  return new Promise((resolve) => {
    try {
      runDialog(ui, request, (result) => {
        dialogInFlight = false;
        resolve(result);
      });
    } catch (err) {
      dialogInFlight = false;
      resolve(null);
      dlog(`[SourceMonkey] copy dialog failed to open: ${describeError(err)}`);
    }
  });
}

// What the dialog learned about the world when it opened. `copiesDir`
// is null before the first copy ever — nothing to check against then.
interface OpenContext {
  copiesDir: string | null;
  collection: StoredCollection | null;
  fileAccess: boolean;
}

async function readOpenContext(): Promise<OpenContext> {
  const [setting, collections, fileAccess] = await Promise.all([
    readDownloadsCopiesSetting(),
    getCollections(),
    isFileSchemeAccessAllowed(),
  ]);
  return {
    copiesDir: setting ? downloadsCopiesDir(setting.downloadsDir) : null,
    collection: findDownloadsCollection(setting, collections),
    fileAccess,
  };
}

function runDialog(
  ui: DialogElements,
  request: CopyDialogRequest,
  resolve: (result: LocalCopyResult | null) => void,
): void {
  const { script } = request;
  let settled = false;
  // A submit is in flight. Esc is refused for its duration: closing
  // would resolve the caller `null` while the files are still landing,
  // so the caller would skip the exclusive-enable sweep and the
  // navigation the new copy needs.
  let submitting = false;
  // The open-time reads have landed. Until then nothing can be checked
  // against the disk, so the confirm stays off.
  let context: OpenContext | null = null;
  // The last COMPLETED disk check, with the file name it was made for.
  // Everything about replacing — the warning line, the marks in the
  // dependency list, the confirm's wording — is drawn from this and
  // never from a half-known state: an edit leaves the last answer on
  // screen and disables the confirm until the new one lands, so the
  // marks and the button don't blink off and back on with every
  // keystroke. `null` until the first check.
  let checked: { fileName: string; existing: readonly string[] } | null = null;
  // A check is pending or in flight, so what is on screen is the
  // PREVIOUS answer. Only the confirm reacts.
  let checking = false;
  let checkTimer: ReturnType<typeof setTimeout> | undefined;
  let checkSeq = 0;

  const finish = (result: LocalCopyResult | null): void => {
    if (settled) return;
    settled = true;
    if (checkTimer !== undefined) clearTimeout(checkTimer);
    if (ui.dialog.open) ui.dialog.close();
    resolve(result);
  };

  // ----- Fill the form from the script -----
  const header = script.header;
  const originalVersion = header ? getValue(header, 'version') ?? '' : '';
  ui.name.textContent = (header && getValue(header, 'name')) || '(no @name)';
  // `<none>` rather than an empty gap: the arrow needs a left-hand
  // side, and "the script declares no version" is what it says.
  ui.versionWas.textContent = originalVersion || '<none>';
  ui.version.value = originalVersion ? localEditVersion(originalVersion) : '';
  ui.version.placeholder = originalVersion ? '' : 'none';
  ui.description.value = header ? getValue(header, 'description') ?? '' : '';
  ui.description.placeholder = ui.description.value ? '' : 'none';
  ui.fileName.value = defaultCopyName(script);

  const deps: DependencyFile[] = dependencyFiles(script);
  // Off to begin with; `paintDependencies` runs again when the
  // open-time reads land and must not undo a tick made in between.
  ui.deps.checked = false;
  paintDependencies(ui, deps, null);

  ui.target.replaceChildren();
  ui.target.appendChild(el('span', 'dlg-target-name', DOWNLOADS_COPIES_NAME));
  const targetHint = el<HTMLElement>('span', 'dlg-hint',
    ` (a ${DOWNLOADS_COPIES_SUBDIR} directory under Chrome's Downloads directory)`);
  ui.target.appendChild(targetHint);
  ui.banner.replaceChildren();

  // ----- Validation -----
  const currentPlan = (): CopyPlan => ({
    fileName: ui.fileName.value.trim(),
    version: ui.version.value,
    description: ui.description.value,
    includeDependencies: ui.deps.checked && !ui.deps.disabled,
  });

  // What the last completed check says the copy would overwrite. The
  // checkbox is read live rather than checked for: the check covers
  // every file the plan COULD write, so ticking it changes what will
  // be replaced without needing another listing.
  const replaceState = (): { scriptExists: boolean; depsExisting: number } => {
    if (!checked) return { scriptExists: false, depsExisting: 0 };
    const copyingDeps = ui.deps.checked && !ui.deps.disabled;
    return {
      scriptExists: checked.existing.includes(checked.fileName),
      depsExisting: copyingDeps
        ? checked.existing.filter((p) => p !== checked!.fileName).length
        : 0,
    };
  };

  // Paint the error slot and the confirm button from the current state.
  // `report` is what the last attempt said, which outranks the live
  // validation until the user changes something.
  let report: string | null = null;
  const sync = (): void => {
    const nameError = validateCopyName(ui.fileName.value)
      ?? (context?.copiesDir && isCopyOfItself(script, context.copiesDir, ui.fileName.value)
        ? COPY_OVER_ITSELF
        : null);
    const message = report ?? nameError;
    const blocked = !context || !context.fileAccess || nameError !== null || report !== null;
    const { scriptExists, depsExisting } = replaceState();
    const willReplace = scriptExists || depsExisting > 0;
    // Where the dependencies WOULD go, when they aren't going: still
    // worth reading, but not a description of what Copy is about to
    // do, so it and the list it heads are dimmed.
    const copyingDeps = ui.deps.checked && !ui.deps.disabled;
    ui.depsHint.classList.toggle('dimmed', !copyingDeps);
    ui.depsList.classList.toggle('dimmed', !copyingDeps);
    ui.error.textContent = message ?? replaceWarning(scriptExists, depsExisting);
    ui.error.classList.toggle('warn', !message && willReplace);
    // Paths and marks both from the last completed check, so a name
    // being typed can't pair a new path with the old answer about it.
    paintDependencyRows(ui, checked?.existing ?? [], checked?.fileName ?? '');
    ui.fileName.classList.toggle('invalid', nameError !== null);
    // A pending check is the one thing that disables the confirm
    // without changing anything else on screen: the answer it would
    // act on is about to be replaced, and it may well come back the
    // same.
    ui.ok.disabled = blocked || submitting || checking;
    ui.ok.textContent = willReplace ? 'Replace' : 'Copy';
  };

  // The disk check: which of the files this plan would write are
  // already there. Debounced behind typing, and sequenced so a slow
  // listing can't overwrite the answer for a newer name.
  const scheduleCheck = (): void => {
    report = null;
    checking = true;
    // Bumped HERE, not only in `runCheck`: a check already awaiting a
    // listing must not be allowed to land its answer for the name the
    // user has just moved off. Without this it would, then clear
    // `checking` and re-enable the confirm — so a click in the 250ms
    // before this edit's own check ran would write the new name with
    // the old name's answer about what is already there.
    checkSeq++;
    if (checkTimer !== undefined) clearTimeout(checkTimer);
    checkTimer = setTimeout(() => void runCheck(), 250);
    sync();
  };
  const runCheck = async (): Promise<void> => {
    checkTimer = undefined;
    const seq = ++checkSeq;
    const fileName = ui.fileName.value.trim();
    if (
      !context?.copiesDir
      || validateCopyName(ui.fileName.value) !== null
      || isCopyOfItself(script, context.copiesDir, ui.fileName.value)
    ) {
      // Nothing to check against — and the name is what the confirm is
      // already refusing, so the previous answer stays on screen rather
      // than being cleared to a state nobody can act on.
      checking = false;
      sync();
      return;
    }
    // Every file the plan COULD write, dependencies included, so the
    // list's marks don't depend on the checkbox.
    const files = planFiles(script, { ...currentPlan(), includeDependencies: true });
    try {
      const found = await checkExistingFiles(context.copiesDir, files);
      if (seq !== checkSeq || settled) return;
      checked = { fileName, existing: found.existing };
    } catch (err) {
      if (seq !== checkSeq || settled) return;
      dlog(`[SourceMonkey] copy dialog could not check existing files: ${describeError(err)}`);
    }
    checking = false;
    sync();
  };

  ui.fileName.oninput = scheduleCheck;
  // No re-check: the check covers every file the plan COULD write, so
  // the box only changes which of them count. `report` is cleared like
  // any other edit — otherwise a failed copy's message would sit there
  // blocking the confirm until some other field was touched.
  ui.deps.onchange = () => { report = null; sync(); };
  ui.version.oninput = () => { report = null; sync(); };
  ui.description.oninput = () => {
    sanitizeOneLine(ui.description);
    autoGrow(ui.description);
    report = null;
    sync();
  };

  // Replaced on every open, so stale closures can't fire.
  ui.cancel.onclick = () => finish(null);
  ui.dialog.onclose = () => finish(null);
  ui.dialog.oncancel = (event) => {
    if (submitting) event.preventDefault();
  };
  ui.ok.onclick = () => void submit();

  const submit = async (): Promise<void> => {
    if (!context) return;
    submitting = true;
    sync();
    ui.cancel.disabled = true;
    const spinner = el('span', 'busy-spinner');
    ui.ok.after(spinner);
    try {
      const result = await makeLocalCopy({
        script,
        plan: currentPlan(),
        overwrite: (() => {
          const { scriptExists, depsExisting } = replaceState();
          return scriptExists || depsExisting > 0;
        })(),
      });
      finish(result);
    } catch (err) {
      report = describeError(err);
    } finally {
      submitting = false;
      spinner.remove();
      ui.cancel.disabled = false;
      sync();
    }
  };

  report = null;
  checking = true;
  sync();
  ui.dialog.showModal();
  // After `showModal`: a closed dialog is `display: none`, where a box
  // has no scroll height to measure.
  autoGrow(ui.description);
  ui.fileName.focus();
  ui.fileName.setSelectionRange(0, Math.max(0, ui.fileName.value.length - '.user.js'.length));

  // ----- The open-time reads, after the dialog is on screen -----
  void readOpenContext().then((ctx) => {
    if (settled) return;
    context = ctx;
    if (ctx.copiesDir) {
      targetHint.textContent = ` (${ctx.copiesDir})`;
      if (ctx.collection) {
        ui.target.firstChild!.textContent = effectiveDisplayName(ctx.collection);
      }
    }
    paintDependencies(ui, deps, ctx.collection);
    if (!ctx.fileAccess) {
      ui.banner.replaceChildren(renderFileAccessBanner('then open this dialog again'));
    }
    void runCheck();
  }, (err: unknown) => {
    if (settled) return;
    report = `Could not read the collections: ${describeError(err)}`;
    sync();
  });
}

// What Replace would overwrite, as the line in the error slot. Which
// files: a dependency that is already there is marked in the list under
// the checkbox, which already names every file, so the line names
// none — and it counts dependencies only when they are being copied.
function replaceWarning(scriptExists: boolean, depsExisting: number): string {
  if (scriptExists && depsExisting > 0) {
    return 'Target script file and dependency files already exist and will be replaced';
  }
  if (scriptExists) return 'Target script file already exists and will be replaced';
  if (depsExisting === 1) return 'Target dependency file already exists and will be replaced';
  if (depsExisting > 1) return 'Target dependency files already exist and will be replaced';
  return '';
}

function paintDependencyRows(ui: DialogElements, existing: readonly string[], fileName: string): void {
  // Dependencies go under the SCRIPT's folder, so a file name with a
  // subdirectory in it moves them too — the list shows where each one
  // would actually land, collection-relative, like the field above it.
  const dir = fileName.includes('/') ? fileName.slice(0, fileName.lastIndexOf('/') + 1) : '';
  const set = new Set(existing);
  for (const li of ui.depsList.querySelectorAll<HTMLElement>('li')) {
    const dep = dir + (li.dataset.dep ?? '');
    li.replaceChildren(dep);
    if (set.has(dep)) li.appendChild(el('span', 'dlg-exists', ' (already exists)'));
  }
}

// The dependencies row: the checkbox's wording, whether it can be
// ticked at all, and the list under it.
function paintDependencies(
  ui: DialogElements,
  deps: readonly DependencyFile[],
  collection: StoredCollection | null,
): void {
  const total = deps.reduce((n, d) => n + d.size, 0);
  const noun = deps.length === 1 ? 'dependency file' : 'dependency files';
  const localFilesOff = collection !== null && !collectionUsesLocalFiles(collection);
  if (deps.length === 0) {
    ui.depsText.textContent = 'No dependency files to copy';
    ui.depsHint.textContent = '';
  } else {
    ui.depsText.textContent = `Also copy ${deps.length} ${noun} (${formatBytes(total)})`;
    ui.depsHint.textContent = localFilesOff
      ? 'Local files are turned off for this collection, so copies would not be used'
      : 'Local filenames in download collection';
  }
  const off = deps.length === 0 || localFilesOff;
  ui.deps.disabled = off;
  // Only ever forced off, never on: this runs a second time when the
  // open-time reads land, and a tick made before then is the user's.
  if (off) ui.deps.checked = false;
  ui.depsLabel.classList.toggle('off', off);
  ui.depsList.replaceChildren(
    ...deps.map((d) => {
      // Path relative to the SCRIPT's folder. `paintDependencyRows`
      // renders it against the current file name and adds the
      // "(already exists)" mark.
      const li = el<HTMLElement>('li', undefined, d.relativePath);
      // No tooltip of its own, so the row's applies: the declared URL
      // this file came from says nothing about the local path the row
      // is showing.
      li.dataset.dep = d.relativePath;
      return li;
    }),
  );
}
