// VibeMonkey MV3 service worker.
//
// This is a stub: it registers nothing user-visible yet. The
// `self.VibeMonkey` surface exists so e2e tests can drive the
// extension via `serviceWorker.evaluate(...)` before any UI is wired
// up — MV3 service workers can't be triggered from a Playwright
// toolbar click, so all e2e calls go through this object.

interface VibeMonkeyApi {
  version: string;
  // Round-trip echo used by the smoke test to confirm the SW is alive
  // and `self.VibeMonkey` is reachable from `serviceWorker.evaluate`.
  ping: (value?: string) => string;
}

const api: VibeMonkeyApi = {
  version: chrome.runtime.getManifest().version,
  ping: (value = 'pong') => value,
};

(self as unknown as { VibeMonkey: VibeMonkeyApi }).VibeMonkey = api;

// Clicking the toolbar icon opens the options page. We have no popup
// configured, so onClicked fires on every action click; openOptionsPage
// honors `options_ui.open_in_tab` (true) and focuses an existing tab
// if one is already open.
chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

// background.ts is compiled as an ES module (declared via
// `"type": "module"` in manifest.json's service_worker entry). The
// explicit empty export keeps tsc treating this file as a module
// even if every real import/export is removed later.
export {};
