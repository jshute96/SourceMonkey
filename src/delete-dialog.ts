// The "delete local script file" confirmation, opened from the trash
// can on a script whose file lives in the Downloads copies directory.
//
// It owns the whole action the way the copy dialog owns Copy: what will
// be deleted, the confirmation, the deletion itself, and any failure in
// its own error slot. The caller hears only about files that went.
//
// See docs/local-delete.md.

import { effectiveDisplayName } from './collection-display.js';
import { downloadsCopiesDir, readDownloadsCopiesSetting } from './local-copy.js';
import {
  copyDeletePlan,
  deletableCopyPath,
  deleteCopyFiles,
  noDownloadRecord,
  SCRIPT_FILE,
  trackedFiles,
  type CopyDeletePlan,
  type DeletableDependency,
} from './local-delete.js';
import {
  describeError,
  getCollectionWithScripts,
  type StoredScript,
} from './script-store.js';
import { dlog } from './debug-log.js';
import { makeCopyButton } from './copy-button.js';
import { missingFiles } from './file-changes.js';
import { isFileSchemeAccessAllowed } from './file-access.js';

export interface DeleteDialogRequest {
  script: StoredScript;
}

export interface DeleteDialogResult {
  scriptId: string;
  collectionId: string;
  // Dependency files that could not be deleted after the script went.
  // The script IS gone, so this is the caller's to report, not to
  // treat as a failed deletion.
  dependencyErrors: string[];
}

interface DialogElements {
  dialog: HTMLDialogElement;
  collection: HTMLElement;
  file: HTMLElement;
  filePath: HTMLElement;
  depsRow: HTMLElement;
  depsWrap: HTMLElement;
  groups: DepGroupElements[];
  error: HTMLElement;
  cancel: HTMLButtonElement;
  ok: HTMLButtonElement;
}

// One of the lists under Dependencies: a heading and the files
// filed under it. Each is hidden whole when it has nothing in it.
interface DepGroupElements {
  wrap: HTMLElement;
  heading: HTMLElement;
  list: HTMLElement;
}

let elements: DialogElements | null = null;

// One at a time, claimed synchronously — the same guard the other
// dialogs use: a second `showModal` throws and would leave the first
// caller's promise unsettled.
let dialogInFlight = false;

function el<T extends HTMLElement>(tag: string, className?: string, text?: string): T {
  const node = document.createElement(tag) as T;
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function buildDialog(): DialogElements {
  const dialog = el<HTMLDialogElement>('dialog', 'sm-dialog delete-dialog');
  dialog.appendChild(el('h2', 'dlg-title', 'Delete local script file'));

  const body = el<HTMLElement>('div', 'dlg-body');
  // Label and control carry the same tooltip, as in the copy dialog:
  // either one is what a reader points at to ask "what is this?".
  const row = (label: string, control: HTMLElement, tooltip: string): HTMLElement => {
    const cell = el<HTMLElement>('span', 'dlg-label', label);
    cell.title = tooltip;
    control.title = tooltip;
    body.appendChild(cell);
    body.appendChild(control);
    return cell;
  };

  const collection = el<HTMLElement>('span', 'dlg-static');
  collection.id = 'delete-collection';
  row('Collection', collection, 'The collection this copy belongs to, and its directory');

  const fileWrap = el<HTMLElement>('div', 'dlg-static');
  const file = el<HTMLElement>('div', 'dlg-target-name');
  file.id = 'delete-file';
  const filePath = el<HTMLElement>('span', 'dlg-hint');
  filePath.id = 'delete-file-path';
  // Beside the full path, the same copy button the viewer's Location
  // row has: the message below can tell the user to delete the file by
  // hand, and a path they can paste is what that takes.
  const pathRow = el<HTMLElement>('div', 'dlg-path-row');
  pathRow.append(filePath, makeCopyButton({
    label: 'Copy path to clipboard',
    text: () => filePath.textContent || undefined,
  }));
  fileWrap.append(file, pathRow);
  row('Script file', fileWrap, 'The file that will be deleted from disk');

  // No choice to make here: what happens to each dependency file
  // follows from facts the dialog can state — whether another script
  // loads it, whether Chrome can still be asked to delete it, and
  // whether it is still there. So the row is headed lists rather than
  // a checkbox.
  const depsWrap = el<HTMLElement>('div', 'dlg-deps');
  const groups = DEP_GROUPS.map(() => {
    const wrap = el<HTMLElement>('div', 'dlg-dep-group');
    const heading = el<HTMLElement>('div', 'dlg-hint');
    const list = el<HTMLElement>('ul', 'dlg-deps-list');
    wrap.append(heading, list);
    depsWrap.appendChild(wrap);
    return { wrap, heading, list };
  });
  const depsRow = row('Dependencies', depsWrap,
    'Local @require and @resource files this script loads from the collection’s directory.');

  dialog.appendChild(body);

  const errorRow = el<HTMLElement>('div', 'dlg-error-row');
  const error = el<HTMLElement>('p', 'dlg-error');
  error.setAttribute('role', 'alert');
  errorRow.appendChild(error);
  dialog.appendChild(errorRow);

  const actions = el<HTMLElement>('div', 'dlg-actions');
  const cancel = el<HTMLButtonElement>('button', undefined, 'Cancel');
  cancel.type = 'button';
  const ok = el<HTMLButtonElement>('button', 'primary danger', 'Delete');
  ok.type = 'button';
  ok.id = 'delete-confirm-btn';
  actions.append(cancel, ok);
  dialog.appendChild(actions);

  document.body.appendChild(dialog);
  return { dialog, collection, file, filePath, depsRow, depsWrap, groups, error, cancel, ok };
}

// Open the dialog and resolve with what was deleted, or null when it
// was dismissed or nothing was deleted.
export function openDeleteDialog(request: DeleteDialogRequest): Promise<DeleteDialogResult | null> {
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
      dlog(`[SourceMonkey] delete dialog failed to open: ${describeError(err)}`);
    }
  });
}

function runDialog(
  ui: DialogElements,
  request: DeleteDialogRequest,
  resolve: (result: DeleteDialogResult | null) => void,
): void {
  const { script } = request;
  let settled = false;
  // A deletion is in flight. Esc is refused for its duration: closing
  // would resolve the caller `null` while files are still going, so the
  // step that removes the script's record would never run.
  let submitting = false;
  // The plan, what Chrome can still be asked to delete, and what is
  // still on disk, once the open-time reads land. Until then there is nothing to confirm, so
  // the Delete button stays off.
  let plan: DeletePlan | null = null;
  let report: string | null = null;
  // The watch for files going away while the dialog is up (`watchDisk`).
  let watch: ReturnType<typeof setInterval> | null = null;
  let probing = false;

  const finish = (result: DeleteDialogResult | null): void => {
    if (settled) return;
    settled = true;
    stopWatching();
    if (ui.dialog.open) ui.dialog.close();
    resolve(result);
  };

  // The dialog can be telling the user to delete files by hand — the
  // script file when its record is gone, dependencies under the third
  // heading — and it has copy buttons for exactly that. So it watches
  // for them doing it: a file that goes drops out of the lists, and a
  // script file that goes turns the blocking message into the offer
  // to remove the entry, without closing and reopening the dialog.
  //
  // Every file in the plan is probed each tick (one directory listing
  // per folder, `missingFiles`), for the whole time the dialog is up. Not
  // just the ones the user was told to delete: a file with a record
  // can be deleted by hand too, and Chrome's `exists` flag is only as
  // fresh as its last check — attempting it would fail after the
  // fact, where moving it to the last list is right. And not just the
  // ones still there: a file put back (an undo in the file manager)
  // moves out of that list again.
  //
  // The user most likely deletes in another window and comes back, so
  // the window regaining focus probes at once rather than making them
  // wait out the tick. `focus` on `window` fires when the page's
  // window is switched back to, and `visibilitychange` when its tab
  // is; either counts.
  const probe = (): void => {
    if (settled || submitting || !plan || probing) return;
    const current = plan;
    probing = true;
    void goneFiles(planPaths(current), current.fileAccess).then((gone) => {
      probing = false;
      if (settled || plan !== current || sameSet(gone, current.gone)) return;
      plan = { ...current, gone };
      // A failed attempt's report described the files as they were;
      // the line goes back to saying what Delete would do now.
      report = null;
      paintDependencies(ui, plan);
      sync();
    });
  };
  const onReturn = (): void => {
    if (document.visibilityState === 'visible') probe();
  };
  const stopWatching = (): void => {
    if (watch !== null) clearInterval(watch);
    watch = null;
    window.removeEventListener('focus', onReturn);
    document.removeEventListener('visibilitychange', onReturn);
  };
  const watchDisk = (): void => {
    if (settled) return;
    watch = setInterval(probe, DISK_POLL_MS);
    window.addEventListener('focus', onReturn);
    document.addEventListener('visibilitychange', onReturn);
  };

  // ----- The state that is known before any read -----
  ui.collection.textContent = '…';
  ui.file.textContent = script.relativePath;
  ui.filePath.textContent = '';
  paintDependencies(ui, null);

  const sync = (): void => {
    // The script file's own record is the one thing that blocks: with
    // no way to delete it there is nothing to confirm, and its message
    // outranks the warning line. Unless the file has already gone —
    // then Delete is what clears the entry, and the line says so.
    const view = plan && planView(plan);
    const blocked = view !== null && view.scriptFile === 'untracked';
    ui.error.textContent = report
      ?? (blocked
        // Its dependencies were going with it, and are staying too.
        ? noDownloadRecord(
            SCRIPT_FILE,
            view.deleting.length + view.untracked.length > 0,
            // The watch can only see the file go with file access on.
            plan!.fileAccess)
        : deleteWarning(view));
    ui.error.classList.toggle('warn', !report && !blocked);
    ui.ok.disabled = plan === null || blocked || submitting;
  };

  // Replaced on every open, so stale closures can't fire.
  ui.cancel.onclick = () => finish(null);
  ui.dialog.onclose = () => finish(null);
  ui.dialog.oncancel = (event) => {
    if (submitting) event.preventDefault();
  };
  ui.ok.onclick = () => void submit();

  const submit = async (): Promise<void> => {
    if (!plan) return;
    const view = planView(plan);
    submitting = true;
    report = null;
    sync();
    ui.cancel.disabled = true;
    const spinner = el('span', 'busy-spinner');
    ui.ok.after(spinner);
    try {
      const result = await deleteCopyFiles({
        script: view.scriptFile === 'gone'
          ? null
          : { path: plan.path, relativePath: plan.relativePath },
        // Only the files that are this script's alone AND that Chrome
        // can still be asked about. The rest are on screen under the
        // heading that says why they are staying.
        dependencies: view.deleting,
      });
      if (result.scriptError) {
        report = result.scriptError;
      } else {
        finish({
          scriptId: script.id,
          collectionId: script.collectionId,
          dependencyErrors: result.dependencyErrors,
        });
        return;
      }
    } catch (err) {
      report = describeError(err);
    } finally {
      submitting = false;
      spinner.remove();
      ui.cancel.disabled = false;
      sync();
    }
  };

  sync();
  ui.dialog.showModal();
  ui.cancel.focus();

  // ----- The open-time reads, after the dialog is on screen -----
  void openPlan(script).then((opened) => {
    if (settled) return;
    plan = opened.plan;
    ui.collection.replaceChildren(
      el('span', 'dlg-target-name', opened.collectionName),
      el('span', 'dlg-hint', ` (${opened.copiesDir})`),
    );
    ui.file.textContent = opened.plan.relativePath;
    ui.filePath.textContent = opened.plan.path;
    paintDependencies(ui, plan);
    sync();
    watchDisk();
  }, (err: unknown) => {
    if (settled) return;
    report = describeError(err);
    sync();
  });
}

// What the dialog acts on: the plan, plus two facts about every file
// in it — whether Chrome can still be asked to delete it, and whether
// it is still on disk. `gone` is re-read while the dialog is up (the
// watch in `runDialog`) and can shrink as well as grow; `tracked` is
// read once, since a record never comes back. What the dialog shows and does follows from the two
// (`planView`).
interface DeletePlan extends CopyDeletePlan {
  // Files Chrome holds a usable download record for.
  tracked: Set<string>;
  // Files no longer on disk. Only ever populated with file access on:
  // with the toggle off a present file fails to open the same way as a
  // missing one (docs/file-access.md), and dropping a file that is
  // still there would be worse than listing it.
  gone: Set<string>;
  fileAccess: boolean;
}

// The plan as the dialog shows and acts on it.
interface DeleteView {
  // The script's own file:
  // - `tracked`: Chrome has a download record, so `removeFile` can.
  // - `gone`: not on disk — deleted by hand, most likely after this
  //   dialog said to. Delete then only removes the entry (and any
  //   dependency files still going).
  // - `untracked`: on disk, but no record. Nothing this dialog can do,
  //   so Delete is refused until the user deletes it by hand.
  scriptFile: 'tracked' | 'gone' | 'untracked';
  // This script's own dependency files still on disk, split by whether
  // Chrome can delete them: going with the script, or left for the
  // user.
  deleting: DeletableDependency[];
  untracked: DeletableDependency[];
  // Files another script loads, still on disk. Never deleted.
  shared: DeletableDependency[];
  // Files no longer on disk, own or shared. Nothing to do about them,
  // but listed rather than dropped: a file the user was just told to
  // delete by hand moving here is how they see the dialog noticed.
  gone: DeletableDependency[];
}

function planView(plan: DeletePlan): DeleteView {
  const onDisk = (d: DeletableDependency) => !plan.gone.has(d.path);
  const own = plan.own.filter(onDisk);
  return {
    scriptFile: plan.gone.has(plan.path)
      ? 'gone'
      : plan.tracked.has(plan.path) ? 'tracked' : 'untracked',
    deleting: own.filter((d) => plan.tracked.has(d.path)),
    untracked: own.filter((d) => !plan.tracked.has(d.path)),
    shared: plan.shared.filter(onDisk),
    gone: [...plan.own, ...plan.shared].filter((d) => !onDisk(d)),
  };
}

// Every file the plan mentions — the script's, and each dependency
// under any heading.
function planPaths(plan: CopyDeletePlan): string[] {
  return [plan.path, ...plan.own.map((d) => d.path), ...plan.shared.map((d) => d.path)];
}

// Everything the dialog needs, read once the dialog is up.
async function openPlan(script: StoredScript): Promise<{
  plan: DeletePlan;
  copiesDir: string;
  collectionName: string;
}> {
  const setting = await readDownloadsCopiesSetting();
  if (!setting) throw new Error(NOT_A_LOCAL_COPY);
  const copiesDir = downloadsCopiesDir(setting.downloadsDir);
  const prior = await getCollectionWithScripts(script.collectionId);
  // The STORED row, not the snapshot the button closed over: a button
  // painted once outlives any number of refreshes, so its copy of the
  // row can name `@require`s the script no longer has — and can still
  // say `ok` for a file that has since gone.
  const row = prior?.scripts.find((s) => s.id === script.id) ?? null;
  // Re-checked here, not trusted from the button: the row could have
  // moved or gone missing since it was painted, and everything below
  // assumes the collection at the copies directory is the whole set of
  // scripts that could be reading these files.
  if (!prior || !row || !deletableCopyPath(row, prior.collection, setting)) {
    throw new Error(NOT_A_LOCAL_COPY);
  }
  const plan = copyDeletePlan(row, prior.scripts, copiesDir);
  // The shared files are deliberately NOT asked about: they are never
  // deleted, so whether Chrome could remove them changes nothing, and
  // a shared file that is also untracked belongs under the heading
  // that says another script needs it — the reason it is staying.
  const fileAccess = await isFileSchemeAccessAllowed();
  const [tracked, gone] = await Promise.all([
    trackedFiles([plan.path, ...plan.own.map((d) => d.path)]),
    goneFiles(planPaths(plan), fileAccess),
  ]);
  return {
    plan: { ...plan, tracked, gone, fileAccess },
    copiesDir,
    collectionName: effectiveDisplayName(prior.collection),
  };
}

// Which of `paths` are no longer on disk. Probed rather than trusted
// from the rows' status — a row says `ok` until the collection's next
// refresh, and this dialog is opened before that happens, typically
// right after the user deleted a file by hand because it said to. The
// probe is one directory listing per folder involved, so polling is
// cheap; it never reports a file gone unless its folder listed and
// the name wasn't there (`missingFiles`).
//
// With file access off, nothing is ever reported gone (see
// `DeletePlan.gone`). `missingFiles` already answers that way — the
// listing fails — but the guard keeps the promise the dialog's
// wording makes explicit rather than incidental.
async function goneFiles(paths: readonly string[], fileAccess: boolean): Promise<Set<string>> {
  if (!fileAccess) return new Set();
  return missingFiles(paths);
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  return a.size === b.size && [...a].every((x) => b.has(x));
}

// How often the dialog re-probes its files (`watchDisk` in `runDialog`).
const DISK_POLL_MS = 1000;

const NOT_A_LOCAL_COPY =
  'This script is not in the Downloads copies directory, so SourceMonkey cannot delete its file';

// The line in the error slot when nothing has gone wrong: what Delete
// is about to do. It is a warning, not an error — the user asked for
// it — but it is the last thing they read before the files go.
function deleteWarning(plan: DeleteView | null): string {
  if (!plan) return '';
  if (plan.scriptFile === 'gone') {
    // The file went by hand; the entry is what is left. Any dependency
    // files still going are on disk and listed above, so they are
    // said once more here — this is the last thing read before they go.
    const deps = plan.deleting.length;
    const alsoFiles = deps > 0
      ? ` and ${deps} ${deps === 1 ? 'dependency file' : 'dependency files'} from disk`
      : '';
    return `Script file has already been deleted.\nDelete will remove this script from SourceMonkey${alsoFiles}.`;
  }
  const count = 1 + plan.deleting.length;
  // Once the dialog is showing lists of files, the line says how many
  // of them are going, even when the answer is just the script. "This
  // file" beside a list of files it isn't taking would read as though
  // it meant all of them.
  const listing = plan.deleting.length + plan.shared.length + plan.untracked.length > 0;
  const files = listing
    ? `${count} ${count === 1 ? 'file' : 'files'}`
    : 'this file';
  return `Delete will remove ${files} from disk.\nThis cannot be undone.`;
}

// The lists under Dependencies, in the order the user reads them:
// what is going, the two reasons a file is staying, then what has
// already gone. Each heading states a fact about the files under it,
// so there is nothing to decide — which is why this row has no
// control.
const DEP_GROUPS = [
  'Files used by this script only',
  'Not deleting files also used by other scripts',
  'Not deleting files no longer in Chrome download history',
  'Files already deleted',
] as const;

// Paint the row from the plan, `null` while it is still being read —
// the row says nothing rather than guessing.
function paintDependencies(ui: DialogElements, plan: DeletePlan | null): void {
  const view = plan && planView(plan);
  const lists = [view?.deleting ?? [], view?.shared ?? [], view?.untracked ?? [], view?.gone ?? []];
  // Hidden while the plan is being read, so the row appears once with
  // its real contents rather than flicking through an empty state.
  ui.depsRow.hidden = plan === null || lists.every((files) => files.length === 0);
  ui.depsWrap.hidden = ui.depsRow.hidden;
  ui.groups.forEach((group, i) => {
    group.wrap.hidden = lists[i].length === 0;
    group.heading.textContent = DEP_GROUPS[i];
    group.list.replaceChildren(...lists[i].map((d) => depRow(d)));
  });
}

// One file in any of the lists: its path relative to the copies
// directory, with the URL it stands in for as the tooltip, and a copy
// button for its full path — a file under "no longer in Chrome
// download history" is one the user has to delete by hand.
function depRow(dep: DeletableDependency): HTMLElement {
  const name = el<HTMLElement>('span', undefined, dep.relativePath);
  name.title = dep.url;
  const li = el<HTMLElement>('li', 'dlg-path-row');
  li.append(name, makeCopyButton({
    label: 'Copy path to clipboard',
    text: () => dep.path,
  }));
  return li;
}
