// Options page controller. Currently just renders the extension
// version so we can confirm the page loaded the compiled script.

const el = document.getElementById('version');
if (el) {
  el.textContent = `Version ${chrome.runtime.getManifest().version}`;
}
