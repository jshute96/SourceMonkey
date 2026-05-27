// Options page controller. Owns the actual configurable settings
// (currently just the debug-logging gate). The per-source management
// UI lives on `sources.html` / `sources.ts`; a header link points
// users back and forth.

import { DEBUG_LOGGING_KEY } from './debug-log.js';

const versionEl = document.getElementById('version');
if (versionEl) {
  versionEl.textContent = `Version ${chrome.runtime.getManifest().version}`;
}

const openSourcesBtn = document.getElementById('open-sources') as HTMLButtonElement;
openSourcesBtn.addEventListener('click', () => {
  location.href = 'sources.html';
});

initDebugLoggingToggle();

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
