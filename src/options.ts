// Options page controller. Owns the actual configurable settings
// (debug-logging gate, GitHub auth token). The per-source management
// UI lives on `sources.html` / `sources.ts`; a header link points
// users back and forth.

import { DEBUG_LOGGING_KEY } from './debug-log.js';
import { GITHUB_AUTH_TOKEN_KEY } from './github-auth.js';

const openSourcesBtn = document.getElementById('open-sources') as HTMLButtonElement;
openSourcesBtn.addEventListener('click', () => {
  location.href = 'sources.html';
});

initDebugLoggingToggle();
initGithubTokenControls();
initVersionFooter();

function initVersionFooter(): void {
  const el = document.getElementById('version');
  if (!el) return;
  el.textContent = `Version ${chrome.runtime.getManifest().version}`;
}

function initDebugLoggingToggle(): void {
  const cb = document.getElementById('debug-logging') as HTMLInputElement | null;
  if (!cb) return;
  // Hydrate from storage so the box reflects the persisted state, then
  // mirror future writes (from anywhere — DevTools, another options
  // tab) so the two never drift out of sync.
  void chrome.storage.local.get(DEBUG_LOGGING_KEY).then((got) => {
    cb.checked = got[DEBUG_LOGGING_KEY] === true;
  });
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    const change = changes[DEBUG_LOGGING_KEY];
    if (!change) return;
    cb.checked = change.newValue === true;
  });
  cb.addEventListener('change', () => {
    void chrome.storage.local.set({ [DEBUG_LOGGING_KEY]: cb.checked });
  });
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
