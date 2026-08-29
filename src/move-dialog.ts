// The "move this script to another collection" dialog, opened from the
// Move button on the viewer's Collection row.
//
// It owns the whole action, the way the collection dialog owns Create:
// it offers the destinations, refuses the ones that can't be picked,
// runs `moveScript`, and reports any failure in its own error slot —
// so the caller only ever hears about a move that happened.
//
// Why a dialog rather than the dropdown inline in the Collection row:
// the control is a select plus two buttons, which is more than that row
// can hold beside a collection name without crowding it, and a modal
// can't be swept away by the header repaint that a background refresh
// of any sibling script triggers.
//
// See docs/script-viewer.md#moving-to-another-collection.

import {
  describeError,
  moveScript,
  ALREADY_INSTALLED_IN_TARGET,
  type InstallTarget,
  type StoredScript,
} from './script-store.js';
import {
  buildInstallSelect,
  installChoiceBlocked,
  selectedInstallChoice,
} from './related-versions.js';
import type { InstallOption } from './script-identity.js';
import { openCollectionDialog } from './collection-dialog.js';
import { dlog } from './debug-log.js';

export interface MoveDialogRequest {
  // The script being moved.
  scriptId: string;
  // Where it could go: `installOptionsFor` with the collection the
  // script is in now passed as `current`, so that entry is listed,
  // marked *(current)*, disabled and pre-selected. `buildInstallSelect`
  // adds the "New collection…" entry.
  options: readonly InstallOption[];
}

interface DialogElements {
  dialog: HTMLDialogElement;
  // Where the dropdown goes; the rest of the dialog is static, so it
  // is the only part `runDialog` fills in.
  slot: HTMLElement;
  error: HTMLElement;
  cancel: HTMLButtonElement;
  ok: HTMLButtonElement;
}

let elements: DialogElements | null = null;

// One at a time, claimed synchronously — same reason as the collection
// dialog's guard: two overlapping opens would leave the first caller's
// promise unsettled and `showModal` throwing on the second.
let dialogInFlight = false;

function el<T extends HTMLElement>(tag: string, className?: string, text?: string): T {
  const node = document.createElement(tag) as T;
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function buildDialog(): DialogElements {
  const dialog = el<HTMLDialogElement>('dialog', 'sm-dialog move-dialog');
  dialog.appendChild(el('h2', 'dlg-title', 'Move script to another collection'));

  const body = el<HTMLElement>('div', 'dlg-body');
  body.appendChild(el('span', 'dlg-label', 'Collection'));
  // The dropdown is rebuilt per open (its entries are the store's
  // answer at that moment), so the body holds a slot for it rather
  // than the select itself.
  const slot = el<HTMLElement>('div', 'dlg-slot');
  body.appendChild(slot);
  dialog.appendChild(body);

  const error = el<HTMLElement>('p', 'dlg-error');
  error.setAttribute('role', 'alert');
  dialog.appendChild(error);

  const actions = el<HTMLElement>('div', 'dlg-actions');
  const cancel = el<HTMLButtonElement>('button', undefined, 'Cancel');
  cancel.type = 'button';
  const ok = el<HTMLButtonElement>('button', 'primary', 'Move');
  ok.type = 'button';
  ok.id = 'move-confirm-btn';
  actions.append(cancel, ok);
  dialog.appendChild(actions);

  document.body.appendChild(dialog);
  return { dialog, slot, error, cancel, ok };
}

// Open the dialog and resolve with the moved script row, or null when
// it was dismissed or nothing was moved.
export function openMoveDialog(request: MoveDialogRequest): Promise<StoredScript | null> {
  if (!elements) elements = buildDialog();
  const ui = elements;
  if (dialogInFlight) return Promise.resolve(null);
  dialogInFlight = true;
  return new Promise((resolve) => {
    try {
      runDialog(ui, request, (moved) => {
        dialogInFlight = false;
        resolve(moved);
      });
    } catch (err) {
      // Nothing here is expected to throw, but a failure would
      // otherwise strand the caller AND leave the flag set, wedging
      // every later open.
      dialogInFlight = false;
      resolve(null);
      dlog(`[SourceMonkey] move dialog failed to open: ${describeError(err)}`);
    }
  });
}

function runDialog(
  ui: DialogElements,
  request: MoveDialogRequest,
  resolve: (moved: StoredScript | null) => void,
): void {
  const { options } = request;
  let settled = false;
  // A submit is in flight. Esc has to be refused for its duration:
  // closing the dialog would resolve the caller `null` while the move
  // is still landing, so the caller would skip the exclusive-enable
  // sweep that a newly-running copy needs — and the abandoned
  // `submit` would then write its result into whatever dialog had
  // been opened in the meantime.
  let submitting = false;
  // The destination the last attempt was refused for. Move stays off
  // until the selection moves off it, so a second click can't repeat
  // the same refusal.
  let refusedValue: string | null = null;
  const finish = (moved: StoredScript | null): void => {
    if (settled) return;
    settled = true;
    if (ui.dialog.open) ui.dialog.close();
    resolve(moved);
  };

  const select = buildInstallSelect(options, {
    title: 'Which collection to move this script into',
    onChange: () => sync(),
  });
  select.id = 'move-target';
  ui.slot.replaceChildren(select);

  // The dialog opens on the collection the script is already in, so
  // Move starts with nothing to do and a move takes a deliberate pick.
  // No message with it: the entry says *(current)* and the greyed
  // button says the rest, where red text on open would read as a
  // failure. Same predicate as the install page's offer row.
  //
  // The button also names what it is about to do. "New collection…"
  // creates before it moves, and a plain "Move" gives no hint of that
  // — the same reason the install callout's dialog says *Create and
  // install*.
  const sync = (): void => {
    ui.ok.disabled = installChoiceBlocked(select, options) || select.value === refusedValue;
    ui.ok.textContent = 'newCollection' in selectedInstallChoice(select, options)
      ? 'Create and move'
      : 'Move';
  };
  sync();

  // Replaced on every open, so stale closures can't fire.
  ui.cancel.onclick = () => finish(null);
  ui.dialog.onclose = () => finish(null);
  // `cancel` is Esc, and it is preventable — which is the only way to
  // hold the dialog open through a submit. Both buttons are already
  // disabled by then, so this closes the last way out.
  ui.dialog.oncancel = (event) => {
    if (submitting) event.preventDefault();
  };
  ui.ok.onclick = () => void submit();

  const submit = async (): Promise<void> => {
    submitting = true;
    ui.ok.disabled = true;
    ui.cancel.disabled = true;
    const spinner = el('span', 'busy-spinner');
    ui.ok.after(spinner);
    try {
      const choice = selectedInstallChoice(select, options);
      let target: InstallTarget;
      if ('newCollection' in choice) {
        // Stacked on top of this one, deliberately: cancelling the
        // create returns the user to the choice they were making,
        // rather than dropping the whole move.
        const outcome = await openCollectionDialog({
          mode: 'create',
          scriptsOnly: true,
          createPurpose: 'move',
        });
        if (!outcome) return;
        target = { collectionId: outcome.collection.id };
      } else {
        target = choice.option.collection
          ? { collectionId: choice.option.collection.id }
          : { schemeDefault: true };
      }
      const moved = await moveScript(request.scriptId, target);
      if (!moved) {
        // The dropdown disables the entries it knows about, so this is
        // a copy another tab installed while the dialog was open. The
        // list we drew is out of date for that entry, so it is taken
        // off the table until the user picks elsewhere.
        refusedValue = select.value;
        ui.error.textContent = ALREADY_INSTALLED_IN_TARGET;
        return;
      }
      finish(moved);
    } catch (err) {
      ui.error.textContent = describeError(err);
    } finally {
      submitting = false;
      spinner.remove();
      ui.cancel.disabled = false;
      // Live again even when the slot now shows a failure: a move that
      // failed on a store read deserves a retry without reopening.
      sync();
    }
  };

  // Cleared here, not in `sync`: the slot is a report of what the last
  // attempt did, which must survive a `sync` but not a reopen.
  ui.error.textContent = '';
  ui.dialog.showModal();
  select.focus();
}
