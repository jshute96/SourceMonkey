// Options page controller. Owns the actual configurable settings
// (link capture, debug-logging gate, local-file-override search roots,
// GitHub auth token), plus a read-only storage-usage table. The
// per-collection management UI lives on `collections.html` /
// `collections.ts`; a header link points users back and forth.

import {
  DEBUG_LOGGING_KEY,
  installDebugLoggingListener,
  loadDebugLoggingFlag,
} from '../debug-log.js';
import { GITHUB_AUTH_TOKEN_KEY } from '../github-auth.js';
import { INSTALL_CAPTURE_KEY } from './install-capture.js';
import {
  LOCAL_ROOTS_KEY,
  parseLocalRootLines,
  readRootsSetting,
  rootsFromText,
  textFromRoots,
  type ParsedRoot,
} from '../local-file-overrides.js';
import { fetchFileUrlText } from './directories.js';
import { describeError, getCollections } from './script-store.js';
import { updateCollection, writeSetting } from './worker-client.js';
import { timeStorageRead } from './storage-scan.js';
import { formatQuota, formatStorageUsage } from '../script-display.js';
import {
  summarizeLocalStorage,
  toWholeKb,
  withRemainder,
  type UsageRow,
} from './storage-usage.js';
import { collectionSupportsLocalFiles } from '../local-file-overrides.js';
import { isFileSchemeAccessAllowed, renderFileAccessBanner } from './file-access.js';
import {
  DOWNLOADS_COPIES_KEY,
  parseDownloadsCopiesSetting,
  readDownloadsCopiesSetting,
  type DownloadsCopiesSetting,
} from './local-copy.js';
import {
  HELP_URL, installHomeLinkHandler, namedPageUrl, onNamedTabFocus, openNamedTab, openTabBeside, wireOpenButton,
} from './page-links.js';

const openCollectionsBtn = document.getElementById('open-collections') as HTMLButtonElement;
// The collections page is a named tab: focus the open one if there is
// one, and otherwise open a new tab rather than replacing this one. A
// middle or Shift click opens another, as on a link.
wireOpenButton(openCollectionsBtn, namedPageUrl('collections'), () => openNamedTab('collections'));
wireOpenButton(document.getElementById('open-help')!, HELP_URL, () => openTabBeside(HELP_URL));

// The header bar's icon and product name are the same link.
installHomeLinkHandler();

// A link elsewhere focusing this tab rather than opening a second one.
// This page has no anchors of its own to land on, so the whole of it is
// the target: back to the top. See src/extension/page-links.ts.
onNamedTabFocus('options', () => {
  scrollTo({ top: 0, behavior: 'smooth' });
});

// Both boolean settings differ only in their storage key and what an
// absent value means, so they share one binder. `defaultValue` is what
// an unset key reads back as — capture is opt-out, debug logging is
// opt-in.
initBooleanSetting('capture-userjs', INSTALL_CAPTURE_KEY, true);
// This page both sets the flag AND reads storage through shared code
// that logs under it (the storage-read timings in `storage-scan`), so
// it observes the flag like any other context: each one reads it for
// itself. Refreshes it asks for run in the worker, which has its own.
installDebugLoggingListener();
void loadDebugLoggingFlag();

initBooleanSetting('debug-logging', DEBUG_LOGGING_KEY, false);
initGithubTokenControls();
initLocalRootControls();
initDownloadsDirControls();
initStorageUsage();

// Read-only table of what is stored in `chrome.storage.local`, by
// kind, against Chrome's quota. Each paint scans every row, so a burst
// of writes (a refresh, a script spamming GM_setValue) is coalesced into
// one repaint a second at most.
function initStorageUsage(): void {
  const table = document.getElementById('storage-usage') as HTMLTableElement | null;
  const limit = document.getElementById('storage-limit');
  if (!table || !limit) return;
  const quota = chrome.storage.local.QUOTA_BYTES;
  if (typeof quota === 'number' && quota > 0) {
    limit.textContent = `Chrome limits each extension to ${formatQuota(quota)} of storage.`;
    limit.hidden = false;
  }
  let pending = false;
  // Paints can overlap (a slow full read, then a change); only the
  // newest one may draw, so an older read finishing last can't put
  // stale numbers back.
  let latest = 0;
  const paint = async (): Promise<void> => {
    pending = false;
    const mine = ++latest;
    const usage = await readUsage();
    if (mine === latest) table.replaceChildren(...usageRows(usage));
  };
  void paint();
  chrome.storage.onChanged.addListener((_changes, areaName) => {
    if (areaName !== 'local' || pending) return;
    pending = true;
    setTimeout(() => void paint(), 1000);
  });
}

type Usage = { rows: UsageRow[]; used: number; quota: number } | { error: string };

async function readUsage(): Promise<Usage> {
  const quota = chrome.storage.local.QUOTA_BYTES;
  if (typeof quota !== 'number' || quota <= 0) {
    return { error: 'Chrome did not report its storage limit' };
  }
  try {
    const [rows, used] = await Promise.all([
      timeStorageRead('storage usage', () => chrome.storage.local.get(null)),
      chrome.storage.local.getBytesInUse(null),
    ]);
    return { rows: withRemainder(summarizeLocalStorage(rows), used), used, quota };
  } catch (err) {
    return { error: `Could not read storage usage: ${describeError(err)}` };
  }
}

const kbFormat = new Intl.NumberFormat();


function usageRows(usage: Usage): HTMLTableRowElement[] {
  const row = (
    cells: Array<[string, string?, number?]>, className?: string,
  ): HTMLTableRowElement => {
    const tr = document.createElement('tr');
    if (className) tr.className = className;
    for (const [text, cls, span] of cells) {
      const td = document.createElement('td');
      td.textContent = text;
      if (cls) td.className = cls;
      if (span) td.colSpan = span;
      tr.appendChild(td);
    }
    return tr;
  };
  if ('error' in usage) return [row([[usage.error]])];

  // Whole KB throughout, so the column visibly adds up to the total.
  const kb = toWholeKb(usage.rows, usage.used);
  return [
    // A row that rounds to nothing is left out rather than shown as 0.
    ...usage.rows.flatMap((r, i) => kb[i] === 0 ? [] : [
      row([[r.label], [r.count, 'num'], [`${kbFormat.format(kb[i])} KB`, 'num']]),
    ]),
    row([
      ['Total'],
      // Spans Count too: in the Size column alone, this longer text
      // would set that column's width and open a wide gap before every
      // size.
      [formatStorageUsage(usage.used, usage.quota), 'num', 2],
    ], 'total'),
  ];
}

// The Downloads folder the local-copy feature learned (see
// docs/local-copy.md). Editable for the one case the extension can't
// detect on its own: Chrome's download location changed after the
// first copy. Saving keeps the recorded collection id — the next copy
// re-checks whether that collection still sits at the new path.
function initDownloadsDirControls(): void {
  const box = document.getElementById('downloads-dir') as HTMLInputElement | null;
  const saveBtn = document.getElementById('downloads-dir-save') as HTMLButtonElement | null;
  const status = document.getElementById('downloads-dir-status') as HTMLElement | null;
  if (!box || !saveBtn || !status) return;

  let saved: DownloadsCopiesSetting | null = null;
  const paint = (setting: DownloadsCopiesSetting | null): void => {
    saved = setting;
    if (!box.matches(':focus')) box.value = setting?.downloadsDir ?? '';
    saveBtn.disabled = box.value.trim() === (saved?.downloadsDir ?? '');
  };
  void readDownloadsCopiesSetting().then(paint);
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    const change = changes[DOWNLOADS_COPIES_KEY];
    if (change) paint(parseDownloadsCopiesSetting(change.newValue));
  });
  box.addEventListener('input', () => {
    saveBtn.disabled = box.value.trim() === (saved?.downloadsDir ?? '');
    status.textContent = '';
  });
  saveBtn.addEventListener('click', () => {
    const dir = box.value.trim().replace(/\/+$/, '');
    if (!dir.startsWith('/')) {
      status.textContent = 'The Downloads folder must be an absolute path';
      status.className = 'token-status err';
      return;
    }
    void writeSetting(DOWNLOADS_COPIES_KEY, { downloadsDir: dir, collectionId: saved?.collectionId ?? null })
      .then(() => {
        status.textContent = 'Saved';
        status.className = 'token-status ok';
      }, (err: unknown) => {
        status.textContent = `Could not save the Downloads folder: ${describeError(err)}`;
        status.className = 'token-status err';
      });
  });
}

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
    const wanted = cb.checked;
    writeSetting(key, wanted).catch((err: unknown) => {
      console.info(`[SourceMonkey] could not save ${key}:`, describeError(err));
      // Back to what is stored, unless another change has moved it since.
      if (cb.checked === wanted) cb.checked = !wanted;
    });
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
      await writeSetting(LOCAL_ROOTS_KEY, roots);
      // The roots only change what the NEXT refresh resolves to, so the
      // refresh is part of the save — same reasoning as the collection
      // dialog's local-overrides option, which refreshes its collection
      // on save. Without it a newly-added root would
      // appear to do nothing until something else happened to touch a
      // collection.
      setStatus('Saved, refreshing scripts', '');
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
        'No directories configured, so only each script\'s own folder and its collection\'s are searched',
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
    void writeSetting(GITHUB_AUTH_TOKEN_KEY, next).then(() => {
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
    }, (err: unknown) => setStatus(`Could not save the token: ${describeError(err)}`, 'err'));
  });

  clearBtn.addEventListener('click', () => {
    void writeSetting(GITHUB_AUTH_TOKEN_KEY, null).then(() => {
      input.value = '';
      // Mirror Save's input reset so Show→Clear doesn't leave the
      // (now empty) field stuck in text mode with a "Hide" button.
      input.type = 'password';
      revealBtn.textContent = 'Show';
      storedToken = '';
      renderStatus();
    }, (err: unknown) => setStatus(`Could not remove the token: ${describeError(err)}`, 'err'));
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
