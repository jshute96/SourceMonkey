// ==UserScript==
// @name        SourceMonkey example: headers-run-at: @run-at document-idle
// @namespace   https://github.com/jshute96/SourceMonkey
// @version     1.2.3
// @description Demonstrates @run-at document-idle (default; once readyState is complete, just before load).
// @icon        https://jshute96.github.io/SourceMonkey/src/icons/icon-48.png
// @match       https://jshute96.github.io/SourceMonkey/tests/examples/headers-run-at/headers-run-at.html
// @match       *://*/*headers-run-at/headers-run-at.html
// @match       file:///*/headers-run-at/headers-run-at.html
// @run-at      document-idle
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
  li.dataset.script = 'idle';
  li.textContent =
    `[document-idle] t=${t.toFixed(1)}ms readyState=${document.readyState} body=<${document.body && document.body.tagName}>`;
  // Sorted-insert so the row lands in chronological position rather
  // than at the tail — see the page's __SM_LOG_INSERT__ helper.
  window.__SM_LOG_INSERT__(log, li, t);

  // Old scripts often set themselves up in a load listener. This row
  // shows whether it fired: it does in SourceMonkey, but not in every
  // manager (Tampermonkey and Violentmonkey run this @grant none script
  // after `load` here).
  window.addEventListener('load', () => {
    const seen = document.createElement('li');
    seen.dataset.script = 'idle-load';
    seen.textContent = '[document-idle] its load listener ran';
    log.appendChild(seen);
  });

  const status = document.getElementById('runStatus');
  if (status) {
    status.classList.add('ran');
    status.textContent = 'At least one userscript ran. See log below.';
  }
})();
