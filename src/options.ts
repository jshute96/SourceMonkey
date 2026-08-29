// Options page controller. Owns the actual configurable settings
// (link capture, debug-logging gate, local-file-override search roots,
// GitHub auth token). The per-collection management UI lives on
// `collections.html` / `collections.ts`; a header link points users
// back and forth.

import {
  DEBUG_LOGGING_KEY,
  installDebugLoggingListener,
  loadDebugLoggingFlag,
} from './debug-log.js';
import { GITHUB_AUTH_TOKEN_KEY } from './github-auth.js';
import { INSTALL_CAPTURE_KEY } from './install-capture.js';
import {
  LOCAL_ROOTS_KEY,
  parseLocalRootLines,
  readRootsSetting,
  rootsFromText,
  textFromRoots,
  type ParsedRoot,
} from './local-file-overrides.js';
import { fetchFileUrlText } from './directories.js';
import { getCollections } from './script-store.js';
import { collectionSupportsLocalFiles } from './local-file-overrides.js';
import { updateCollection } from './script-updater.js';
import { isFileSchemeAccessAllowed, renderFileAccessBanner } from './file-access.js';

const openCollectionsBtn = document.getElementById('open-collections') as HTMLButtonElement;
openCollectionsBtn.addEventListener('click', () => {
  location.href = 'collections.html';
});

// Both boolean settings differ only in their storage key and what an
// absent value means, so they share one binder. `defaultValue` is what
// an unset key reads back as — capture is opt-out, debug logging is
// opt-in.
initBooleanSetting('capture-userjs', INSTALL_CAPTURE_KEY, true);
// This page both sets the flag AND runs refreshes (`updateCollection`
// on a search-roots save), so it needs to observe it like any other
// context — each one reads the flag for itself. Without this a refresh
// started from Options produces no timing output while the identical
// refresh from the collections page does.
installDebugLoggingListener();
void loadDebugLoggingFlag();

initBooleanSetting('debug-logging', DEBUG_LOGGING_KEY, false);
initGithubTokenControls();
initLocalRootControls();

function initBooleanSetting(elementId: string, key: string, defaultValue: boolean): void {
  const cb = document.getElementById(elementId) as HTMLInputElement | null;
  if (!cb) return;
  const read = (raw: unknown): boolean => (typeof raw === 'boolean' ? raw : defaultValue);
  // Hydrate from storage so the box reflects the persisted state, then
  // mirror future writes (from anywhere — DevTools, another options
  // tab) so the two never drift out of sync.
  void chrome.storage.local.get(key).then((got) => {
    cb.checked = read(got[key]);
  });
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    const change = changes[key];
    if (!change) return;
    cb.checked = read(change.newValue);
  });
  cb.addEventListener('change', () => {
    void chrome.storage.local.set({ [key]: cb.checked });
  });
}

// Local search roots: a multi-line box, one absolute path per line.
//
// The setting stores the PARSED array, so this box is where text
// becomes roots — which is why Save is disabled while any line is
// malformed. Nothing downstream re-parses, so nothing downstream has to
// decide what a bad line means.
//
// Two kinds of complaint, and only one of them blocks Save:
//   - Format. Decided locally and instantly. Blocks.
//   - Existence. Requires a `file://` read, so it's debounced — and
//     it's a warning: a directory can appear later (a repo you haven't
//     cloned yet), and saving a root that isn't there yet costs
//     nothing, since resolution simply finds no candidate under it.
function initLocalRootControls(): void {
  const box = document.getElementById('local-roots-text') as HTMLTextAreaElement | null;
  const saveBtn = document.getElementById('local-roots-save') as HTMLButtonElement | null;
  const status = document.getElementById('local-roots-status') as HTMLElement | null;
  const problems = document.getElementById('local-roots-problems') as HTMLElement | null;
  const fileAccess = document.getElementById('local-roots-file-access') as HTMLElement | null;
  if (!box || !saveBtn || !status || !problems || !fileAccess) return;

  let savedText = '';
  let checkTimer: ReturnType<typeof setTimeout> | undefined;
  // Existence results, keyed by canonical root URL. Cached for the
  // page's lifetime so re-validating on each keystroke doesn't re-probe
  // every unchanged line.
  const exists = new Map<string, boolean>();

  void chrome.storage.local.get(LOCAL_ROOTS_KEY).then((got) => {
    savedText = textFromRoots(readRootsSetting(got[LOCAL_ROOTS_KEY]));
    // Don't overwrite a user who started typing before the read landed
    // — the same reasoning as the cross-tab guard below, for the much
    // narrower window between page load and hydration.
    if (!box.value) box.value = savedText;
    void validate();
  });
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    const change = changes[LOCAL_ROOTS_KEY];
    if (!change) return;
    const next = textFromRoots(readRootsSetting(change.newValue));
    if (next === savedText) return;
    savedText = next;
    // Don't clobber an edit being typed in THIS box with a write from
    // another options tab. Focus is the signal: a box the user is in
    // keeps its text and shows "Unsaved changes" against the new saved
    // value, so nothing is lost silently either way.
    if (box.value !== next && !box.matches(':focus')) box.value = next;
    void validate();
  });

  box.addEventListener('input', () => {
    renderProblems();
    if (checkTimer !== undefined) clearTimeout(checkTimer);
    checkTimer = setTimeout(() => void validate(), 400);
  });

  saveBtn.addEventListener('click', () => void onSave());

  async function onSave(): Promise<void> {
    const roots = rootsFromText(box!.value);
    // Save is disabled while this is null, so reaching it means a
    // keystroke landed between the last render and the click.
    if (!roots) return;
    // Write back the canonical form: the stored array IS the setting,
    // and showing anything else would leave the box disagreeing with
    // what's actually searched.
    savedText = textFromRoots(roots);
    box!.value = savedText;
    saveBtn!.disabled = true;
    try {
      await chrome.storage.local.set({ [LOCAL_ROOTS_KEY]: roots });
      // The roots only change what the NEXT refresh resolves to, so the
      // refresh is part of the save — same reasoning as the collection
      // dialog's local-overrides option, which refreshes its collection
      // on save. Without it a newly-added root would
      // appear to do nothing until something else happened to touch a
      // collection.
      setStatus('Saved — refreshing scripts', '');
      await refreshLocalCollections();
    } finally {
      saveBtn!.disabled = false;
    }
    await validate();
  }

  // Refresh only the collections a root could possibly affect. http(s)
  // collections and the web / GitHub containers resolve everything over
  // the network, so refreshing them would be cost with no possible
  // change.
  async function refreshLocalCollections(): Promise<void> {
    try {
      const collections = await getCollections();
      for (const collection of collections) {
        if (!collectionSupportsLocalFiles(collection.path)) continue;
        await updateCollection(collection.id, 'manual');
      }
    } catch {
      // A refresh that fails is not a failed save: the setting is
      // written, and every collection re-resolves on its own next
      // refresh. Per-collection failures already surface on the
      // collections page.
    }
  }

  // Probe every well-formed root that hasn't been probed yet, then
  // repaint. Cheap after the first pass — `exists` short-circuits.
  async function validate(): Promise<void> {
    renderProblems();
    const entries = parseLocalRootLines(box!.value);
    // A malformed line already blocks Save, so there is nothing to be
    // learned from probing the others yet — and the format complaint is
    // the one the user has to act on first.
    if (entries.some((e) => e.error)) return;
    const unknown = entries
      .flatMap((e) => (e.url ? [e.url] : []))
      .filter((url) => !exists.has(url));
    // Before the early return, or a banner raised by an earlier pass
    // outlives the condition that raised it — deleting the offending
    // line would leave it on screen with nothing left to probe.
    if (unknown.length === 0) {
      if (await isFileSchemeAccessAllowed()) fileAccess!.replaceChildren();
      return;
    }
    // With "Allow access to file URLs" off, every read fails the same
    // way a missing directory does — so say which it is, using the
    // shared banner rather than a second copy of its wording. Reload is
    // the right retry here: `exists` is cached for the page's life.
    if (!(await isFileSchemeAccessAllowed())) {
      if (!fileAccess!.firstChild) fileAccess!.appendChild(renderFileAccessBanner());
      return;
    }
    fileAccess!.replaceChildren();
    await Promise.all(
      unknown.map(async (url) => {
        exists.set(url, await isReadableDir(url));
      }),
    );
    renderProblems();
  }

  function renderProblems(): void {
    const entries = parseLocalRootLines(box!.value);
    problems!.replaceChildren();
    for (const entry of entries) {
      const message = problemFor(entry);
      if (!message) continue;
      const li = document.createElement('li');
      li.textContent = message;
      problems!.appendChild(li);
    }
    renderStatus(entries);
  }

  function problemFor(entry: ParsedRoot): string | null {
    if (entry.error) return `Line ${entry.lineNumber}: ${entry.error}`;
    if (entry.url && exists.get(entry.url) === false) {
      return `Line ${entry.lineNumber}: No directory found at ${entry.text}`;
    }
    return null;
  }

  function renderStatus(entries: ParsedRoot[]): void {
    const bad = entries.filter((e) => e.error).length;
    // A format error is the one thing that blocks a save. The listed
    // problem already names the line and the fix, and the button is
    // visibly disabled, so the status line stays out of it rather than
    // restating both.
    saveBtn!.disabled = bad > 0;
    if (bad > 0) {
      setStatus('', '');
      return;
    }
    if (textFromRoots(rootsFromText(box!.value) ?? []) !== savedText) {
      setStatus('Unsaved changes', '');
      return;
    }
    if (entries.length === 0) {
      setStatus(
        'No directories configured — only each script\'s own folder and its collection\'s',
        '',
      );
      return;
    }
    setStatus(
      `Searching ${entries.length} ${entries.length === 1 ? 'directory' : 'directories'} after each script's own folder and its collection's`,
      'ok',
    );
  }

  function setStatus(text: string, cls: 'ok' | 'err' | ''): void {
    status!.textContent = text;
    status!.classList.remove('ok', 'err');
    if (cls) status!.classList.add(cls);
  }
}

// True when the URL names a readable directory. Chrome serves a
// directory listing for a `file://` URL ending in `/`, and fails for a
// plain file or a missing path — so the trailing slash the canonical
// root form already carries is what makes this a directory test.
async function isReadableDir(rootUrl: string): Promise<boolean> {
  try {
    await fetchFileUrlText(rootUrl);
    return true;
  } catch {
    return false;
  }
}

function initGithubTokenControls(): void {
  const input = document.getElementById('github-token') as HTMLInputElement | null;
  const revealBtn = document.getElementById('github-token-reveal') as HTMLButtonElement | null;
  const saveBtn = document.getElementById('github-token-save') as HTMLButtonElement | null;
  const clearBtn = document.getElementById('github-token-clear') as HTMLButtonElement | null;
  const status = document.getElementById('github-token-status') as HTMLElement | null;
  if (!input || !revealBtn || !saveBtn || !clearBtn || !status) return;

  // Hydrate from storage. We deliberately do NOT pre-fill the input
  // when a token already exists — instead show a "token is set" status
  // and leave the field empty, so a shoulder-surfer (or screenshot)
  // doesn't reveal the value. Saving an empty input is a no-op; Clear
  // is the only way to remove a stored token.
  let storedToken = '';
  void chrome.storage.local.get(GITHUB_AUTH_TOKEN_KEY).then((got) => {
    const raw = got[GITHUB_AUTH_TOKEN_KEY];
    storedToken = typeof raw === 'string' ? raw : '';
    renderStatus();
  });
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    const change = changes[GITHUB_AUTH_TOKEN_KEY];
    if (!change) return;
    storedToken = typeof change.newValue === 'string' ? change.newValue : '';
    renderStatus();
  });

  revealBtn.addEventListener('click', () => {
    const visible = input.type === 'text';
    input.type = visible ? 'password' : 'text';
    revealBtn.textContent = visible ? 'Show' : 'Hide';
  });

  saveBtn.addEventListener('click', () => {
    const next = input.value.trim();
    if (!next) {
      setStatus('Enter a token, or use Clear to remove the saved one.', 'err');
      return;
    }
    void chrome.storage.local.set({ [GITHUB_AUTH_TOKEN_KEY]: next }).then(() => {
      input.value = '';
      input.type = 'password';
      revealBtn.textContent = 'Show';
      // Reuse the same "A token is saved (ends in …XXXX)" message
      // renderStatus produces on a hydrated page. Don't show a transient
      // "Token saved." line that vanishes — the persistent message
      // makes it obvious there IS a token, and which one.
      // (The storage.onChanged listener will also fire renderStatus,
      // but the explicit call here keeps the UI immediate.)
      storedToken = next;
      renderStatus();
    });
  });

  clearBtn.addEventListener('click', () => {
    void chrome.storage.local.remove(GITHUB_AUTH_TOKEN_KEY).then(() => {
      input.value = '';
      // Mirror Save's input reset so Show→Clear doesn't leave the
      // (now empty) field stuck in text mode with a "Hide" button.
      input.type = 'password';
      revealBtn.textContent = 'Show';
      storedToken = '';
      renderStatus();
    });
  });

  // Allow Enter inside the input to save, so users don't have to mouse
  // over to the Save button.
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      saveBtn.click();
    }
  });

  function renderStatus(): void {
    if (storedToken) {
      setStatus(`A token is saved (ends in …${storedToken.slice(-4)}). Saved tokens are never re-displayed; paste a new one to replace it.`, 'ok');
    } else {
      setStatus('No token saved. SourceMonkey will use unauthenticated GitHub API calls (60/hr).', '');
    }
  }

  function setStatus(text: string, cls: 'ok' | 'err' | ''): void {
    status!.textContent = text;
    status!.classList.remove('ok', 'err');
    if (cls) status!.classList.add(cls);
  }
}
