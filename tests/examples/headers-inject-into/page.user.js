// ==UserScript==
// @name        SourceMonkey example: headers-inject-into: @inject-into page
// @namespace   https://github.com/jshute96/SourceMonkey
// @version     1.0.2
// @description Runs in the page's MAIN world; can see page globals.
// @match       *://*/*headers-inject-into/headers-inject-into.html
// @match       file:///*/headers-inject-into/headers-inject-into.html
// @run-at      document-end
// @inject-into page
// @grant       none
// ==/UserScript==

(function () {
  'use strict';

  // We're in the page's MAIN world. window.__SM_PAGE_MARKER__ was
  // set by the page's inline <script>; we should see it.
  const marker = window.__SM_PAGE_MARKER__;
  const fnResult = typeof window.__SM_FROM_PAGE_FN__ === 'function'
    ? window.__SM_FROM_PAGE_FN__()
    : '(function not visible)';

  // Stash a marker the spec can probe for from page.evaluate, which
  // also runs in the MAIN world.
  window.__SM_FROM_PAGE_SCRIPT__ = { marker, fnResult };

  const log = document.getElementById('log');
  if (log) {
    const li = document.createElement('li');
    li.dataset.script = 'page';
    li.textContent =
      `[@inject-into page] window.__SM_PAGE_MARKER__ = ${JSON.stringify(marker)}; fn() = ${JSON.stringify(fnResult)}`;
    log.appendChild(li);
  }

  const status = document.getElementById('runStatus');
  if (status) {
    status.classList.add('ran');
    status.textContent = 'At least one userscript ran. See log below.';
  }
})();
