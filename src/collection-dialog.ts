// The create / edit collection dialog, shared by the collections page
// (Add field, Edit button) and the install page ("New collection…" in
// the Install-into dropdown). One `<dialog>` per page, built on first
// use; `openCollectionDialog` resolves when it closes.
//
// The dialog owns the whole decision: it validates live as the user
// types (name required / in use, location shape, a `.user.js` where a
// collection was expected), probes a location before creating from it,
// and shows every failure in its own error slot — so a location that
// can't be read never lands as a collection stuck in a scan error, and
// the caller only ever hears about a collection that exists.
//
// See docs/storage.md#the-collection-dialog.

import {
  COLLECTION_ALREADY_REGISTERED,
  COLLECTION_GONE,
  COLLECTION_NAME_REQUIRED,
  collectionNameInUseMessage,
  createCollection,
  collectionUsesLocalFiles,
  describeError,
  getCollections,
  probeCollectionLocation,
  setCollectionOptions,
  SINGLE_SCRIPT_NOT_A_COLLECTION,
  type StoredCollection,
} from './script-store.js';
import {
  canonicalCollectionInput,
  collectionKind,
  isFileUrl,
  isHttpUrl,
  isManifestCollection,
  isSingleFileInput,
  LOCATION_SHAPES,
  type CollectionKind,
} from './directories.js';
import { MANIFEST_FILENAME } from './collection-scan.js';
import {
  collectionNameInUse,
  inferCollectionType,
  inferDisplayName,
  mayUseReservedName,
  RESERVED_COLLECTION_NAME,
} from './collection-display.js';
import { collectionSupportsLocalFiles } from './local-file-overrides.js';
import { dlog } from './debug-log.js';

export interface CollectionDialogRequest {
  mode: 'create' | 'edit';
  // Edit: the row being edited. Type and location are fixed; name and
  // options are what can change.
  collection?: StoredCollection;
  // Create: what the Add field already knew. A location picks the type
  // (manifest by filename, directory otherwise) and seeds the name.
  prefill?: { kind?: CollectionKind; location?: string; name?: string };
  // Create: the only type on offer. The install page's "New
  // collection…" can only make a scripts collection.
  lockKind?: CollectionKind;
  // Create: the caller installs a script into the new collection as
  // soon as it exists. Says so in the title and on the confirm button —
  // a plain "Create" gives no hint that the script lands too, which
  // read as a surprise when Create both created and installed.
  andInstall?: boolean;
}

export interface CollectionDialogOutcome {
  collection: StoredCollection;
  created: boolean;
  // Edit: the local-overrides option changed, so the caller should
  // refresh — the flag only affects the NEXT refresh.
  localFilesChanged: boolean;
}

// The hint under the local-overrides option, by why it does or doesn't
// apply. The option is shown for every collection so the dialog's
// shape doesn't shift with the type; where it can't act, the hint says
// why instead of leaving a greyed box to wonder about.
const LOCAL_FILES_HINT =
  'Load local versions of @require and @resource files found in the ' +
  'script or collection directories, or in the global search path';
function localFilesUnavailableHint(location: string): string {
  const where = inferCollectionType(location) === 'github' ? 'from GitHub' : 'over http';
  return `Not applicable for scripts loaded ${where}`;
}

// Shown once when a location reads fine but holds no scripts. A
// warning, not a refusal: a directory can fill up later, so the next
// Create goes through.
const EMPTY_LOCATION_WARNING =
  'No .user.js files found. Click Create to add this collection anyway.';

interface DialogElements {
  dialog: HTMLDialogElement;
  form: HTMLFormElement;
  title: HTMLElement;
  kindInputs: HTMLInputElement[];
  locationLabel: HTMLElement;
  location: HTMLInputElement;
  name: HTMLInputElement;
  localFilesLabel: HTMLLabelElement;
  localFiles: HTMLInputElement;
  localFilesHint: HTMLElement;
  error: HTMLElement;
  cancel: HTMLButtonElement;
  ok: HTMLButtonElement;
}

let elements: DialogElements | null = null;

// One dialog at a time, claimed SYNCHRONOUSLY. `dialog.open` can't be
// the guard: `runDialog` reads the collection list before it calls
// `showModal`, so during that await a second call would see a closed
// dialog, pass, and then overwrite every handler the first run
// installed — leaving the first caller's promise unsettled forever and
// the second's rejected by `showModal` on an already-open dialog.
// Reachable by double-clicking Edit.
let dialogInFlight = false;

function el<T extends HTMLElement>(tag: string, className?: string, text?: string): T {
  const node = document.createElement(tag) as T;
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// Type radio with its one-line gloss. Kept as data so the three read
// as a set and a fourth can't drift in wording.
const KIND_CHOICES: { kind: CollectionKind; label: string; hint: string }[] = [
  { kind: 'scripts', label: 'Individual scripts', hint: 'installed one at a time, from anywhere' },
  { kind: 'directory', label: 'Directory', hint: 'all scripts under a directory or GitHub folder' },
  { kind: 'manifest', label: 'Manifest', hint: 'all scripts listed in a script_manifest.json file' },
];

function buildDialog(): DialogElements {
  const dialog = el<HTMLDialogElement>('dialog', 'collection-dialog');
  const title = el<HTMLElement>('h2', 'dlg-title');
  dialog.appendChild(title);

  const form = el<HTMLFormElement>('form', 'dlg-body');
  form.noValidate = true;
  dialog.appendChild(form);

  form.appendChild(el('span', 'dlg-label', 'Type'));
  const radios = el<HTMLElement>('div', 'dlg-radios');
  const kindInputs: HTMLInputElement[] = [];
  for (const choice of KIND_CHOICES) {
    const label = el<HTMLLabelElement>('label', 'dlg-radio');
    const input = el<HTMLInputElement>('input');
    input.type = 'radio';
    input.name = 'collection-kind';
    input.value = choice.kind;
    kindInputs.push(input);
    const text = el('span');
    text.appendChild(document.createTextNode(choice.label + ' '));
    text.appendChild(el('span', 'dlg-hint', `— ${choice.hint}`));
    label.append(input, text);
    radios.appendChild(label);
  }
  form.appendChild(radios);

  const locationLabel = el<HTMLLabelElement>('label', 'dlg-label', 'Location');
  locationLabel.htmlFor = 'collection-dialog-location';
  const location = el<HTMLInputElement>('input');
  location.type = 'text';
  location.id = 'collection-dialog-location';
  location.autocomplete = 'off';
  location.spellcheck = false;
  location.placeholder = 'Absolute path, file:// URL, https:// manifest, or github.com/…/tree/… URL';
  form.append(locationLabel, location);

  const nameLabel = el<HTMLLabelElement>('label', 'dlg-label', 'Name');
  nameLabel.htmlFor = 'collection-dialog-name';
  const name = el<HTMLInputElement>('input');
  name.type = 'text';
  name.id = 'collection-dialog-name';
  name.autocomplete = 'off';
  form.append(nameLabel, name);

  form.appendChild(el('span', 'dlg-label', 'Options'));
  const localFilesLabel = el<HTMLLabelElement>('label', 'dlg-check');
  const localFiles = el<HTMLInputElement>('input');
  localFiles.type = 'checkbox';
  localFiles.id = 'collection-dialog-local-files';
  const localText = el('span');
  localText.appendChild(document.createTextNode('Allow local file overrides '));
  const localFilesHint = el<HTMLElement>('span', 'dlg-hint');
  localText.appendChild(localFilesHint);
  localFilesLabel.append(localFiles, localText);
  form.appendChild(localFilesLabel);

  const error = el<HTMLElement>('p', 'dlg-error');
  error.setAttribute('role', 'alert');
  dialog.appendChild(error);

  const actions = el<HTMLElement>('div', 'dlg-actions');
  const cancel = el<HTMLButtonElement>('button', undefined, 'Cancel');
  cancel.type = 'button';
  const ok = el<HTMLButtonElement>('button', 'primary');
  ok.type = 'submit';
  ok.setAttribute('form', 'collection-dialog-form');
  form.id = 'collection-dialog-form';
  actions.append(cancel, ok);
  dialog.appendChild(actions);

  document.body.appendChild(dialog);
  return {
    dialog, form, title, kindInputs, locationLabel, location, name,
    localFilesLabel, localFiles, localFilesHint, error, cancel, ok,
  };
}

// Open the dialog and resolve with what it made or changed, or null
// when it was dismissed. One at a time: a second call while one is
// open resolves null immediately.
export function openCollectionDialog(
  request: CollectionDialogRequest,
): Promise<CollectionDialogOutcome | null> {
  if (!elements) elements = buildDialog();
  const ui = elements;
  if (dialogInFlight) return Promise.resolve(null);
  dialogInFlight = true;
  return new Promise((resolve) => {
    void runDialog(ui, request, (outcome) => {
      dialogInFlight = false;
      resolve(outcome);
    }).catch((err) => {
      // Nothing in `runDialog` before `showModal` is expected to throw,
      // but a rejection there would otherwise strand the caller AND
      // leave the flag set, wedging every later open.
      dialogInFlight = false;
      resolve(null);
      dlog(`[SourceMonkey] collection dialog failed to open: ${describeError(err)}`);
    });
  });
}

async function runDialog(
  ui: DialogElements,
  request: CollectionDialogRequest,
  resolve: (outcome: CollectionDialogOutcome | null) => void,
): Promise<void> {
  const { mode, collection } = request;
  const editing = mode === 'edit' ? collection ?? null : null;
  // Everything else on the page, for the live "already exists" checks.
  // A snapshot: a collection added from another tab while this dialog
  // is open is caught by the store's own check on submit.
  const others = (await getCollections()).filter((c) => c.id !== editing?.id);

  // ---- state ----
  let kind: CollectionKind =
    editing ? collectionKind(editing.path)
    : request.lockKind ?? request.prefill?.kind
      ?? (request.prefill?.location ? inferKindFromLocation(request.prefill.location) : 'scripts');
  const kindLocked = !!editing || !!request.lockKind;
  // The empty-directory warning blocks once; the second Create goes
  // through.
  let warnedEmpty = false;
  let settled = false;

  const finish = (outcome: CollectionDialogOutcome | null): void => {
    if (settled) return;
    settled = true;
    if (ui.dialog.open) ui.dialog.close();
    resolve(outcome);
  };

  // ---- fill ----
  ui.title.textContent = editing ? 'Edit collection'
    : request.andInstall ? 'Create new collection and install script'
    : 'New collection';
  ui.ok.textContent = editing ? 'Save'
    : request.andInstall ? 'Create and install'
    : 'Create';
  ui.location.value = editing ? locationFieldValue(editing.path) : request.prefill?.location ?? '';
  ui.location.disabled = !!editing;
  // Blank for a new location collection: the inferred name is what a
  // blank means, and echoing the path into the field would only invite
  // editing a value that isn't the user's.
  ui.name.value = editing
    ? editing.displayName?.trim() || inferDisplayName(editing.path)
    : request.prefill?.name ?? '';
  ui.localFiles.checked = editing ? collectionUsesLocalFiles(editing) : true;
  for (const input of ui.kindInputs) {
    input.checked = input.value === kind;
    input.disabled = kindLocked;
    input.closest('label')?.classList.toggle('off', kindLocked);
  }

  const setError = (text: string, warn = false): void => {
    ui.error.textContent = text;
    ui.error.classList.toggle('warn', warn);
  };

  // What's wrong with the form as it stands, or null — and WHICH field
  // it is about, so the caller can mark that field without reading the
  // prose (see CLAUDE.md: never pattern-match a message's wording).
  // Runs on every keystroke; Create/Save is disabled while it returns
  // something.
  // The typed location in the one spelling the store will hold, so far
  // as can be told without a network call. Declared above `problem`,
  // which calls it: a `const` arrow used before its line is a TDZ trap
  // for whoever adds the next caller.
  const canonicalLoc = (): string => canonicalCollectionInput(ui.location.value.trim());

  const problem = (): { field: 'name' | 'location'; message: string } | null => {
    const name = ui.name.value.trim();
    const loc = ui.location.value.trim();
    const onName = (message: string) => ({ field: 'name' as const, message });
    const onLocation = (message: string) => ({ field: 'location' as const, message });
    // The row's own path is what earns an exemption from the reserved
    // names — a built-in default keeps the name it owns.
    const ownPath = editing ? editing.path : null;
    const reserved = name && !mayUseReservedName(name, ownPath);
    if (kind === 'scripts') {
      if (reserved) return onName(RESERVED_COLLECTION_NAME);
      // A blank name disables Create without a message: the field's own
      // placeholder already says it is required.
      if (name && collectionNameInUse(name, others)) {
        return onName(collectionNameInUseMessage(name));
      }
      return null;
    }
    if (!editing) {
      if (!loc || !isValidLocation(loc)) return onLocation(`Location ${LOCATION_SHAPES}`);
      if (isSingleFileInput(loc)) return onLocation(SINGLE_SCRIPT_NOT_A_COLLECTION);
      if (kind === 'manifest' && !isManifestCollection(loc)) {
        return onLocation(`Location must end with /${MANIFEST_FILENAME} for a manifest collection`);
      }
      if (kind === 'directory' && isManifestCollection(loc)) {
        return onLocation('This location is a manifest. Choose Manifest as the type.');
      }
      if (others.some((c) => canonicalCollectionInput(c.path) === canonicalLoc())) {
        return onLocation(COLLECTION_ALREADY_REGISTERED);
      }
    }
    // Name problems are reported only once the location is sound: for a
    // location collection the location is the field being filled in,
    // and marking Name while Location is malformed points at the wrong
    // one.
    if (reserved) return onName(RESERVED_COLLECTION_NAME);
    // Only a name the user chose is held unique — the same test
    // `createLocationCollection` runs, against the same canonical
    // spelling, so the two can't disagree about whether a typed name
    // counts as chosen. (A github URL the store would still rewrite via
    // its API is the one case they can: that rewrite needs a network
    // round trip, so the store's own check stays the backstop.)
    const inferred = inferDisplayName(editing ? editing.path : canonicalLoc());
    if (name && name !== inferred && collectionNameInUse(name, others)) {
      return onName(collectionNameInUseMessage(name));
    }
    return null;
  };

  const refresh = (): void => {
    const loc = ui.location.value.trim();
    const showLocation = kind !== 'scripts';
    ui.locationLabel.hidden = !showLocation;
    ui.location.hidden = !showLocation;
    const supportsLocal = kind === 'scripts' || !loc || collectionSupportsLocalFiles(loc);
    ui.localFiles.disabled = !supportsLocal;
    ui.localFilesLabel.classList.toggle('off', !supportsLocal);
    ui.localFilesHint.textContent = supportsLocal ? `— ${LOCAL_FILES_HINT}` : `— ${localFilesUnavailableHint(loc)}`;
    // The placeholder is the field's own explanation of what blank
    // means, by type — so it reads before anything is typed.
    ui.name.placeholder = kind === 'scripts'
      ? COLLECTION_NAME_REQUIRED
      : `Name is optional for ${kind} collections`;
    const p = problem();
    ui.location.classList.toggle('invalid', p?.field === 'location');
    ui.name.classList.toggle('invalid', p?.field === 'name');
    setError(p?.message ?? '');
    ui.ok.disabled = !!p || (kind === 'scripts' && !ui.name.value.trim());
  };

  // ---- wiring (replaced on every open, so stale closures can't fire) ----
  for (const input of ui.kindInputs) {
    input.onchange = () => {
      if (!input.checked) return;
      kind = input.value as CollectionKind;
      warnedEmpty = false;
      refresh();
    };
  }
  ui.location.oninput = () => {
    const loc = ui.location.value.trim();
    warnedEmpty = false;
    if (loc && !kindLocked) {
      kind = inferKindFromLocation(loc);
      for (const input of ui.kindInputs) input.checked = input.value === kind;
    }
    refresh();
  };
  ui.name.oninput = () => refresh();
  ui.localFiles.onchange = () => refresh();
  ui.cancel.onclick = () => finish(null);
  ui.dialog.onclose = () => finish(null);
  ui.form.onsubmit = (event) => {
    event.preventDefault();
    void submit();
  };

  const busy = async <T>(work: () => Promise<T>): Promise<T> => {
    ui.ok.disabled = true;
    ui.cancel.disabled = true;
    const spinner = el('span', 'busy-spinner');
    ui.ok.after(spinner);
    try {
      return await work();
    } finally {
      spinner.remove();
      ui.cancel.disabled = false;
      // Live again even when the slot now shows a failure, deliberately:
      // the empty-directory warning is a "click Create again" prompt,
      // and a probe that failed on a network blip deserves a retry
      // without retyping. So the "disabled while `problem()` returns
      // something" invariant holds only up to the first submit.
      ui.ok.disabled = false;
    }
  };

  const submit = async (): Promise<void> => {
    refresh();
    if (ui.ok.disabled) return;
    const name = ui.name.value.trim();
    const localFiles = ui.localFiles.disabled ? undefined : ui.localFiles.checked;
    try {
      if (editing) {
        const priorLocal = collectionUsesLocalFiles(editing);
        const updated = await busy(() => setCollectionOptions(editing.id, {
          displayName: name,
          ...(localFiles === undefined ? {} : { localFiles }),
        }));
        if (!updated) {
          setError(COLLECTION_GONE_HERE);
          return;
        }
        finish({
          collection: updated,
          created: false,
          localFilesChanged: localFiles !== undefined && localFiles !== priorLocal,
        });
        return;
      }
      if (kind === 'scripts') {
        // Only a location collection can come back null (a duplicate
        // location); the scripts branch throws on the one thing it
        // refuses, a name already in use. A null here would be a store
        // bug, so it says so rather than guessing at a cause.
        const result = await busy(() => createCollection({ kind: 'scripts', name, localFiles }));
        if (!result) {
          setError('Internal error: the collection was not created');
          return;
        }
        finish({ collection: result.collection, created: true, localFilesChanged: false });
        return;
      }
      const loc = ui.location.value.trim();
      // Read before writing: a location that can't be listed is
      // refused here, with the reason, rather than becoming a section
      // whose only content is a scan error. Empty is allowed, but said
      // once first.
      const probe = await busy(() => probeCollectionLocation(loc));
      if (probe.scriptCount === 0 && !warnedEmpty) {
        warnedEmpty = true;
        setError(EMPTY_LOCATION_WARNING, true);
        return;
      }
      const result = await busy(() => createCollection({ kind: 'location', path: loc, name, localFiles }));
      if (!result) {
        setError(COLLECTION_ALREADY_REGISTERED);
        return;
      }
      finish({ collection: result.collection, created: true, localFilesChanged: false });
    } catch (err) {
      setError(describeError(err));
      // A create that failed on the location — the probe, or the store's
      // own dedup — is about that field.
      if (!editing && kind !== 'scripts') ui.location.classList.add('invalid');
    }
  };

  refresh();
  ui.dialog.showModal();
  // Where typing starts: the location for a location collection that
  // has none yet, the name otherwise.
  if (kind !== 'scripts' && !editing && !ui.location.value) ui.location.focus();
  else ui.name.focus();
}

// Edit-mode message for a row that vanished under the dialog: the
// shared string, wrapped with what to do about it here.
const COLLECTION_GONE_HERE = `${COLLECTION_GONE}. Close this dialog and check the page.`;

function inferKindFromLocation(location: string): CollectionKind {
  return isManifestCollection(location) ? 'manifest' : 'directory';
}

// The location as the Add field accepts it: `http(s)://`, `file://`,
// or an absolute POSIX path of length > 1 (bare `/` would scan the
// filesystem root).
function isValidLocation(value: string): boolean {
  if (isHttpUrl(value) || isFileUrl(value)) return true;
  return value.startsWith('/') && value.length > 1;
}

// What the (read-only) Location field shows for an existing row: the
// stored path, which is already the canonical spelling. A container
// has none. Not `displayLocation` — `script-display.ts` exports that
// name for a different job (a script's own location, decoded).
function locationFieldValue(path: string): string {
  return collectionKind(path) === 'scripts' ? '' : path;
}
