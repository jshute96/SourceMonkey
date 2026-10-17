// ==UserScript==
// @name        SourceMonkey example: headers-run-at: @run-at document-end
// @namespace   https://github.com/jshute96/SourceMonkey
// @version     1.1.2
// @description Demonstrates @run-at document-end (after DOMContentLoaded).
// @match       *://*/*headers-run-at/headers-run-at.html
// @match       file:///*/headers-run-at/headers-run-at.html
// @run-at      document-end
// @grant       none
// ==/UserScript==

(function () {
  'use strict';

  const log = document.getElementById('log');
  if (!log) return;

  // performance.now() is milliseconds since navigation start —
  // including it makes the gap between document-start, document-end,
  // and document-idle visible in the displayed log.
  const t = performance.now();
  const li = document.createElement('li');
  li.dataset.script = 'end';
  li.textContent =
    `[document-end] t=${t.toFixed(1)}ms readyState=${document.readyState} body=<${document.body && document.body.tagName}>`;
  // Sorted-insert so the row lands in chronological position rather
  // than at the tail — see the page's __SM_LOG_INSERT__ helper.
  window.__SM_LOG_INSERT__(log, li, t);

  const status = document.getElementById('runStatus');
  if (status) {
    status.classList.add('ran');
    status.textContent = 'At least one userscript ran. See log below.';
  }
})();
