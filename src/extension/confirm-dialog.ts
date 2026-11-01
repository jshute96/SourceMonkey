// A yes/no confirmation in the extension's own dialog shell, for an
// action one click away from losing something: the script page's
// trash can on the script it shows, and the storage debug page's on an
// installed script's values.
//
// Resolves true for the confirm button, false for Cancel or Esc.

export interface ConfirmRequest {
  title: string;
  // Labelled rows under the title, saying what is going. The first is
  // the thing itself, and shows in bold.
  details?: { label: string; value: string }[];
  confirmLabel: string;
}

interface DialogElements {
  dialog: HTMLDialogElement;
  title: HTMLElement;
  body: HTMLElement;
  cancel: HTMLButtonElement;
  ok: HTMLButtonElement;
}

let elements: DialogElements | null = null;

// One at a time: a second `showModal` throws and would leave the first
// caller's promise unsettled.
let dialogInFlight = false;

function buildDialog(): DialogElements {
  const dialog = document.createElement('dialog');
  dialog.className = 'sm-dialog confirm-dialog';
  const title = document.createElement('h2');
  title.className = 'dlg-title';
  const body = document.createElement('div');
  body.className = 'dlg-body';
  const actions = document.createElement('div');
  actions.className = 'dlg-actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = 'Cancel';
  const ok = document.createElement('button');
  ok.type = 'button';
  ok.className = 'primary danger';
  ok.id = 'confirm-ok-btn';
  actions.append(cancel, ok);
  dialog.append(title, body, actions);
  document.body.appendChild(dialog);
  return { dialog, title, body, cancel, ok };
}

export function confirmDialog(request: ConfirmRequest): Promise<boolean> {
  if (!elements) elements = buildDialog();
  const ui = elements;
  if (dialogInFlight) return Promise.resolve(false);
  dialogInFlight = true;
  ui.title.textContent = request.title;
  // Rows in the dialogs' label / value grid; the first, what is going,
  // in bold.
  const details = request.details ?? [];
  ui.body.replaceChildren(...details.flatMap(({ label, value }, i) => {
    const labelEl = document.createElement('span');
    labelEl.className = 'dlg-label';
    labelEl.textContent = label;
    const valueEl = document.createElement('span');
    valueEl.className = i === 0 ? 'dlg-static dlg-target-name' : 'dlg-static';
    valueEl.textContent = value;
    return [labelEl, valueEl];
  }));
  // Not `hidden`: the shell's `display: grid` would override it.
  ui.body.style.display = details.length ? '' : 'none';
  ui.ok.textContent = request.confirmLabel;
  return new Promise((resolve) => {
    const finish = (answer: boolean): void => {
      ui.cancel.onclick = null;
      ui.ok.onclick = null;
      ui.dialog.oncancel = null;
      if (ui.dialog.open) ui.dialog.close();
      dialogInFlight = false;
      resolve(answer);
    };
    ui.cancel.onclick = () => finish(false);
    ui.ok.onclick = () => finish(true);
    // Esc.
    ui.dialog.oncancel = (ev) => {
      ev.preventDefault();
      finish(false);
    };
    ui.dialog.showModal();
    // Cancel has the focus, so Enter doesn't confirm by accident.
    ui.cancel.focus();
  });
}
