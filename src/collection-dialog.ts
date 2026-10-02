// The create / edit collection dialog, shared by the collections page
// (Add field, Edit button) and the install page ("New collection…" in
// the Install-into dropdown). One `<dialog>` per page, built on first
// use; `openCollectionDialog` resolves when it closes.
//
// The dialog owns the whole decision: it validates live as the user
// types (name required / in use, what the location turns out to be),
// probes a location before creating from it, and shows every failure in
// its own error slot — so a location that can't be read never lands as
// a collection stuck in a scan error, and the caller only ever hears
// about a collection that exists.
//
// The type is never asked for, only reported: a Type row shows the
// collection bubble the form would produce — `scripts` with no
// location, `<scheme>-dir` / `<scheme>-manifest` for a location we
// could classify, and `invalid` for anything else.
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
  type StoredCollection,
} from './script-store.js';
import {
  canonicalCollectionInput,
  classifyLocation,
  collectionKind,
  SINGLE_SCRIPT_NOT_A_COLLECTION,
  type CollectionKind,
  type LocationVerdict,
} from './directories.js';
import {
  collectionBubbleKey,
  inferCollectionType,
  inferDisplayName,
  mayUseReservedName,
  RESERVED_COLLECTION_NAME,
  SCRIPTS_BUBBLE_KEY,
  collectionNameInUse,
} from './collection-display.js';
import { MANIFEST_FILENAME } from './collection-scan.js';
import { collectionSupportsLocalFiles } from './local-file-overrides.js';
import { dlog } from './debug-log.js';
import { previewUrl } from './script-display.js';
import { openExtensionTab } from './page-links.js';

export interface CollectionDialogRequest {
  mode: 'create' | 'edit';
  // Edit: the row being edited. Type and location are fixed; name and
  // options are what can change.
  collection?: StoredCollection;
  // Create: what the Add field already knew. A location decides the
  // type; a name seeds the Name field.
  prefill?: { location?: string; name?: string };
  // Create: no location may be given, so the result can only be a
  // scripts collection. The install page's "New collection…" installs
  // into what it creates, and only a scripts collection can take an
  // individually installed script.
  scriptsOnly?: boolean;
  // Create: what the caller does with the collection the moment it
  // exists. Says so in the title and on the confirm button — a plain
  // "Create" gives no hint that the script lands too, which read as a
  // surprise when Create both created and installed.
  createPurpose?: CreatePurpose;
}

// Why a create-mode dialog was opened, and so what its title and
// confirm button say. Kept as one table so the three read as a set.
export type CreatePurpose = 'collectionOnly' | 'install' | 'move';

const CREATE_WORDING: Record<CreatePurpose, { title: string; ok: string }> = {
  collectionOnly: { title: 'New collection', ok: 'Create' },
  install: { title: 'Create new collection and install script', ok: 'Create and install' },
  move: { title: 'Create new collection and move script', ok: 'Create and move' },
};

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

// Bubble keys that are states of the form rather than collection kinds.
// Both get their own colour in styles.css.
const INVALID_BUBBLE_KEY = 'invalid';
const CHECKING_BUBBLE_KEY = 'checking';

// What each Type bubble means, as its tooltip. The radios this row
// replaced carried a one-line gloss each; without something here a
// first-time reader gets only an uppercase token.
const TYPE_BUBBLE_TITLES: Record<string, string> = {
  [SCRIPTS_BUBBLE_KEY]: 'Scripts installed one at a time, from anywhere',
  [INVALID_BUBBLE_KEY]: 'Invalid collection specification',
  [CHECKING_BUBBLE_KEY]: 'Reading this location…',
};
function typeBubbleTitle(bubbleKey: string): string {
  const known = TYPE_BUBBLE_TITLES[bubbleKey];
  if (known) return known;
  if (bubbleKey.endsWith('-manifest')) return `Every script listed in this ${MANIFEST_FILENAME}`;
  return bubbleKey.startsWith('github')
    ? 'Every .user.js in this GitHub folder'
    : 'Every .user.js under this directory';
}

// What the Type row says beside `INVALID` on a dialog nothing has been
// typed into yet — the one state where the error slot stays empty,
// because nothing is wrong yet, only unfinished. Naming only what this
// dialog can actually take: a scripts-only create has no location
// field to point at.
function enterSomethingHint(showLocation: boolean): string {
  return showLocation ? 'Enter a name or path' : 'Enter a name';
}

// How long the location field sits still before its verdict is
// fetched. A local classification reads the disk, so it is not run per
// keystroke.
const LOCATION_PROBE_DELAY_MS = 250;

interface DialogElements {
  dialog: HTMLDialogElement;
  form: HTMLFormElement;
  title: HTMLElement;
  locationLabel: HTMLElement;
  location: HTMLInputElement;
  name: HTMLInputElement;
  typeBubble: HTMLElement;
  typeHint: HTMLElement;
  localFilesLabel: HTMLLabelElement;
  localFiles: HTMLInputElement;
  localFilesHint: HTMLElement;
  error: HTMLElement;
  errorAction: HTMLButtonElement;
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

function buildDialog(): DialogElements {
  const dialog = el<HTMLDialogElement>('dialog', 'sm-dialog collection-dialog');
  const title = el<HTMLElement>('h2', 'dlg-title');
  dialog.appendChild(title);

  const form = el<HTMLFormElement>('form', 'dlg-body');
  form.noValidate = true;
  dialog.appendChild(form);

  const nameLabel = el<HTMLLabelElement>('label', 'dlg-label', 'Name');
  nameLabel.htmlFor = 'collection-dialog-name';
  const name = el<HTMLInputElement>('input');
  name.type = 'text';
  name.id = 'collection-dialog-name';
  name.autocomplete = 'off';
  form.append(nameLabel, name);

  const locationLabel = el<HTMLLabelElement>('label', 'dlg-label', 'Directory or manifest');
  locationLabel.htmlFor = 'collection-dialog-location';
  const location = el<HTMLInputElement>('input');
  location.type = 'text';
  location.id = 'collection-dialog-location';
  location.autocomplete = 'off';
  location.spellcheck = false;
  // Short, because the label beside it already says what kind of
  // directory or manifest is wanted.
  location.placeholder = 'Absolute path or URL';
  form.append(locationLabel, location);

  form.appendChild(el('span', 'dlg-label', 'Type'));
  const typeRow = el<HTMLElement>('div', 'dlg-type');
  const typeBubble = el<HTMLElement>('span', 'collection-type-bubble');
  const typeHint = el<HTMLElement>('span', 'dlg-hint');
  typeRow.append(typeBubble, typeHint);
  form.appendChild(typeRow);

  form.appendChild(el('span', 'dlg-label', 'Options'));
  const localFilesLabel = el<HTMLLabelElement>('label', 'dlg-check');
  const localFiles = el<HTMLInputElement>('input');
  localFiles.type = 'checkbox';
  localFiles.id = 'collection-dialog-local-files';
  const localText = el('span');
  localText.appendChild(document.createTextNode('Allow local file overrides'));
  const localFilesHint = el<HTMLElement>('span', 'dlg-hint');
  localText.appendChild(localFilesHint);
  localFilesLabel.append(localFiles, localText);
  form.appendChild(localFilesLabel);

  // The message and its optional action sit side by side in one row, so
  // the offer and the reason for it read as one thing. The button is a
  // SIBLING of the message rather than a child: `.dlg-error` is what
  // every caller (and every test) reads the message from, and a nested
  // button would show up in its text even while hidden.
  const errorRow = el<HTMLElement>('div', 'dlg-error-row');
  const error = el<HTMLElement>('p', 'dlg-error');
  error.setAttribute('role', 'alert');
  // Only the single-script verdict raises it.
  const errorAction = el<HTMLButtonElement>('button', 'dlg-error-action', 'Install script');
  errorAction.type = 'button';
  errorAction.hidden = true;
  errorRow.append(error, errorAction);
  dialog.appendChild(errorRow);

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
    dialog, form, title, locationLabel, location, name, typeBubble, typeHint,
    localFilesLabel, localFiles, localFilesHint, error, errorAction, cancel, ok,
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

// Everything the form's current contents imply: what the Type row
// shows, what the error slot says and which field it blames, and
// whether Create/Save may fire.
interface FormVerdict {
  bubble: string;   // bubble key — a collection kind, or `invalid` / `checking`
  hint: string;     // beside the bubble; only the untouched-form case uses it
  message: string;  // the error slot, '' to clear it
  field: 'name' | 'location' | null;
  ready: boolean;
  // The single script typed as a location, if that's what happened —
  // the error slot then offers to install it instead.
  scriptLocation: string;
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
  // A location is off the table for a scripts-only create, and fixed
  // (shown read-only, or absent) when editing.
  const editingScripts = !!editing && collectionKind(editing.path) === 'scripts';
  const showLocation = !request.scriptsOnly && !editingScripts;
  // The empty-directory warning blocks once; the second Create goes
  // through.
  let warnedEmpty = false;
  let settled = false;
  let probeTimer: ReturnType<typeof setTimeout> | undefined;
  // The opening paint. Its location came from the Add field, not from
  // typing, so it is classified straight away rather than after the
  // keystroke debounce.
  let firstPaint = true;

  const finish = (outcome: CollectionDialogOutcome | null): void => {
    if (settled) return;
    settled = true;
    // A pending classification has nothing left to update.
    if (probeTimer !== undefined) clearTimeout(probeTimer);
    if (ui.dialog.open) ui.dialog.close();
    resolve(outcome);
  };

  // ---- fill ----
  const wording = CREATE_WORDING[request.createPurpose ?? 'collectionOnly'];
  ui.title.textContent = editing ? 'Edit collection' : wording.title;
  ui.ok.textContent = editing ? 'Save' : wording.ok;
  ui.location.value = editing ? locationFieldValue(editing.path) : request.prefill?.location ?? '';
  ui.location.disabled = !!editing;
  ui.locationLabel.hidden = !showLocation;
  ui.location.hidden = !showLocation;
  // Blank for a new location collection: the inferred name is what a
  // blank means, and echoing the path into the field would only invite
  // editing a value that isn't the user's.
  ui.name.value = editing
    ? editing.displayName?.trim() || inferDisplayName(editing.path)
    : request.prefill?.name ?? '';
  ui.localFiles.checked = editing ? collectionUsesLocalFiles(editing) : true;

  const setError = (text: string, warn = false): void => {
    ui.error.textContent = text;
    ui.error.classList.toggle('warn', warn);
  };

  // The typed location in the one spelling the store will hold, so far
  // as can be told without a network call.
  const canonicalLoc = (): string => canonicalCollectionInput(ui.location.value.trim());

  // Verdicts already reached, keyed by the exact string typed, plus the
  // debounce that fetches the next one. Declared above `evaluate`,
  // which calls it: a `const` arrow used before its line is a TDZ trap
  // for whoever adds the next caller.
  const verdicts = new Map<string, LocationVerdict>();
  let probingFor: string | null = null;
  // The verdict for `loc`, or null while we are still finding out —
  // in which case a probe is scheduled and `refresh` runs again when it
  // lands.
  //
  // `now` skips the debounce for a location the user didn't type here
  // (an Add-field prefill), which is already complete and would
  // otherwise show `checking` for a quarter second on every add.
  const verdictFor = (loc: string, now = false): LocationVerdict | null => {
    const known = verdicts.get(loc);
    if (known) return known;
    if (probingFor !== loc) {
      probingFor = loc;
      if (probeTimer !== undefined) clearTimeout(probeTimer);
      const run = (): void => {
        void classifyLocation(loc)
          // A classification that threw is still a classification —
          // whatever went wrong is what's wrong with this location.
          .catch((err): LocationVerdict => ({ kind: 'invalid', message: describeError(err) }))
          .then((verdict) => {
            verdicts.set(loc, verdict);
            if (!settled) refresh();
          });
      };
      if (now) run();
      else probeTimer = setTimeout(run, LOCATION_PROBE_DELAY_MS);
    }
    return null;
  };
  // Every edit forgets the refusals. A location that couldn't be read
  // may become readable while the dialog is open — the user creates the
  // directory, or turns file access on — and a cached refusal would
  // outlast the fix, so retyping the path is the retry. Only refusals:
  // re-reading a directory we already listed would just cost a scan.
  const forgetRefusals = (): void => {
    for (const [loc, verdict] of verdicts) {
      if (verdict.kind === 'invalid') verdicts.delete(loc);
    }
    probingFor = null;
  };

  // What's wrong with the typed name, or null. Blank is never wrong
  // here: for a location collection it means "use the inferred name",
  // and for a scripts collection the caller checks it separately (the
  // Type row says what a nameless, locationless form still needs).
  const nameProblem = (inferred: string): string | null => {
    const name = ui.name.value.trim();
    if (!name) return null;
    // The row's own path is what earns an exemption from the reserved
    // names — a built-in default keeps the name it owns.
    if (!mayUseReservedName(name, editing ? editing.path : null)) return RESERVED_COLLECTION_NAME;
    // Only a name the user chose is held unique — the same test
    // `createLocationCollection` runs, against the same canonical
    // spelling, so the two can't disagree about whether a typed name
    // counts as chosen. (A github URL the store would still rewrite via
    // its API is the one case they can: that rewrite needs a network
    // round trip, so the store's own check stays the backstop.)
    if (name !== inferred && collectionNameInUse(name, others)) {
      return collectionNameInUseMessage(name);
    }
    return null;
  };

  // Runs on every keystroke; Create/Save is disabled while it says so.
  const evaluate = (): FormVerdict => {
    const blank = { hint: '', message: '', field: null, ready: true, scriptLocation: '' } as const;
    if (editing) {
      // Type and location are fixed, so only the name can be wrong.
      // A blank name means "use the inferred one" — but a scripts
      // collection has no location to infer from, so for that one blank
      // is simply missing, exactly as it is when creating.
      const inferred = inferDisplayName(editing.path);
      const message = nameProblem(inferred);
      const missing = !message && !inferred && !ui.name.value.trim();
      return {
        ...blank,
        bubble: collectionBubbleKey(editing.path),
        hint: missing ? enterSomethingHint(false) : '',
        message: message ?? '',
        field: message ? 'name' : null,
        ready: !message && !missing,
      };
    }
    const loc = showLocation ? ui.location.value.trim() : '';
    const name = ui.name.value.trim();
    if (!loc) {
      // No location: a collection of individually installed scripts,
      // which is nothing at all until it is named.
      if (!name) {
        return { ...blank, bubble: INVALID_BUBBLE_KEY, hint: enterSomethingHint(showLocation), ready: false };
      }
      const message = nameProblem('');
      return {
        ...blank,
        bubble: SCRIPTS_BUBBLE_KEY,
        message: message ?? '',
        field: message ? 'name' : null,
        ready: !message,
      };
    }
    const verdict = verdictFor(loc, firstPaint);
    if (!verdict) return { ...blank, bubble: CHECKING_BUBBLE_KEY, ready: false };
    if (verdict.kind === 'script') {
      return {
        ...blank,
        bubble: INVALID_BUBBLE_KEY,
        message: SINGLE_SCRIPT_NOT_A_COLLECTION,
        field: 'location',
        ready: false,
        scriptLocation: loc,
      };
    }
    if (verdict.kind === 'invalid') {
      return { ...blank, bubble: INVALID_BUBBLE_KEY, message: verdict.message, field: 'location', ready: false };
    }
    // The same key `collectionBubbleKey` builds for a stored row, but
    // from the verdict rather than the path: the two agree on the
    // scheme half and can differ on the other, because this one knows
    // what was actually read where that one only has a filename.
    const bubble = `${inferCollectionType(loc)}-${verdict.kind === 'manifest' ? 'manifest' : 'dir'}`;
    if (others.some((c) => canonicalCollectionInput(c.path) === canonicalLoc())) {
      return { ...blank, bubble, message: COLLECTION_ALREADY_REGISTERED, field: 'location', ready: false };
    }
    // Name problems are reported only once the location is sound: the
    // location is the field being filled in, and marking Name while the
    // location is unusable points at the wrong one.
    const message = nameProblem(inferDisplayName(canonicalLoc()));
    return {
      ...blank,
      bubble,
      message: message ?? '',
      field: message ? 'name' : null,
      ready: !message,
    };
  };

  const refresh = (): void => {
    const state = evaluate();
    const loc = showLocation ? ui.location.value.trim() : '';
    const supportsLocal = !loc || collectionSupportsLocalFiles(loc);
    ui.localFiles.disabled = !supportsLocal;
    ui.localFilesLabel.classList.toggle('off', !supportsLocal);
    ui.localFilesHint.textContent = supportsLocal ? `: ${LOCAL_FILES_HINT}` : `: ${localFilesUnavailableHint(loc)}`;
    // The placeholder is the field's own explanation of what blank
    // means — required for a scripts collection, "use the inferred
    // name" once a location says what the collection is.
    ui.name.placeholder = !showLocation || !loc
      ? COLLECTION_NAME_REQUIRED
      : namePlaceholderFor(state.bubble);
    ui.typeBubble.className = `collection-type-bubble bubble-${state.bubble}`;
    ui.typeBubble.textContent = state.bubble;
    ui.typeBubble.title = typeBubbleTitle(state.bubble);
    ui.typeHint.textContent = state.hint;
    ui.location.classList.toggle('invalid', state.field === 'location');
    ui.name.classList.toggle('invalid', state.field === 'name');
    setError(state.message);
    ui.errorAction.hidden = !state.scriptLocation;
    ui.errorAction.onclick = state.scriptLocation
      // A new tab: the dialog's caller (usually the collections page)
      // stays where it was, so backing out of the install lands the
      // user where they started.
      ? () => { void openExtensionTab(chrome.runtime.getURL(previewUrl(state.scriptLocation))); }
      : null;
    ui.ok.disabled = !state.ready;
  };

  // ---- wiring (replaced on every open, so stale closures can't fire) ----
  ui.location.oninput = () => {
    warnedEmpty = false;
    forgetRefusals();
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
      // without retyping. So the "disabled while `evaluate` says so"
      // invariant holds only up to the first submit.
      ui.ok.disabled = false;
    }
  };

  const submit = async (): Promise<void> => {
    refresh();
    if (ui.ok.disabled) return;
    const name = ui.name.value.trim();
    const localFiles = ui.localFiles.disabled ? undefined : ui.localFiles.checked;
    const loc = showLocation ? ui.location.value.trim() : '';
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
      if (!loc) {
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
      if (!editing && loc) ui.location.classList.add('invalid');
    }
  };

  refresh();
  firstPaint = false;
  ui.dialog.showModal();
  // Where typing starts: the location for a new collection that has
  // none yet, the name otherwise.
  if (showLocation && !editing && !ui.location.value) ui.location.focus();
  else ui.name.focus();
}

// Edit-mode message for a row that vanished under the dialog: the
// shared string, wrapped with what to do about it here.
const COLLECTION_GONE_HERE = `${COLLECTION_GONE}. Close this dialog and check the page.`;

// What a blank Name means, once a location has said what kind of
// collection this is. The `checking` / `invalid` states have no kind to
// name yet, so they get the bare form.
function namePlaceholderFor(bubbleKey: string): string {
  const kind: CollectionKind | null =
    bubbleKey.endsWith('-manifest') ? 'manifest'
    : bubbleKey.endsWith('-dir') ? 'directory'
    : null;
  return kind ? `Name is optional for ${kind} collections` : 'Name is optional';
}

// What the (read-only) Location field shows for an existing row: the
// stored path, which is already the canonical spelling. A container
// has none. Not `displayLocation` — `script-display.ts` exports that
// name for a different job (a script's own location, decoded).
function locationFieldValue(path: string): string {
  return collectionKind(path) === 'scripts' ? '' : path;
}
