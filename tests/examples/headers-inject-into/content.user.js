// ==UserScript==
// @name        SourceMonkey example: headers-inject-into: @inject-into content
// @namespace   https://github.com/jshute96/SourceMonkey
// @version     1.0.2
// @description Runs in an isolated USER_SCRIPT world; can't see page globals.
// @match       *://*/*headers-inject-into/headers-inject-into.html
// @match       file:///*/headers-inject-into/headers-inject-into.html
// @run-at      document-end
// @inject-into content
// @grant       none
// ==/UserScript==

(function () {
  'use strict';

  // We're in the isolated USER_SCRIPT world. window is a separate
  // JS realm from the page's, so __SM_PAGE_MARKER__ should be
  // undefined here even though the page set it.
  const marker = window.__SM_PAGE_MARKER__;
  const fnVisible = typeof window.__SM_FROM_PAGE_FN__;

  const log = document.getElementById('log');
  if (log) {
    const li = document.createElement('li');
    li.dataset.script = 'content';
    li.textContent =
      `[@inject-into content] window.__SM_PAGE_MARKER__ = ${JSON.stringify(marker)}; typeof __SM_FROM_PAGE_FN__ = ${fnVisible}`;
    log.appendChild(li);
  }

  const status = document.getElementById('runStatus');
  if (status) {
    status.classList.add('ran');
    status.textContent = 'At least one userscript ran. See log below.';
  }
})();
