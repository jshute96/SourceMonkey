// ==UserScript==
// @name        SourceMonkey example: @run-at document-start
// @namespace   sourcemonkey.example
// @version     1.0.0
// @description Demonstrates @run-at document-start (runs before DOM parses).
// @match       *://*/headers-run-at/headers-run-at.html
// @match       file:///*/headers-run-at/headers-run-at.html
// @run-at      document-start
// @grant       none
// ==/UserScript==

(function () {
  'use strict';

  // At document-start the body element typically doesn't exist yet,
  // so we capture readyState immediately and defer the DOM append
  // until DOMContentLoaded.
  const observed = document.readyState;
  const bodyAtStart = String(document.body);

  function record() {
    const log = document.getElementById('log');
    if (!log) return;
    const li = document.createElement('li');
    li.dataset.script = 'start';
    li.textContent =
      `[document-start] readyState=${observed} body=${bodyAtStart}`;
    log.appendChild(li);
    const status = document.getElementById('runStatus');
    if (status) {
      status.classList.add('ran');
      status.textContent = 'At least one userscript ran. See log below.';
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', record);
  } else {
    record();
  }
})();
