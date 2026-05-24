// ==UserScript==
// @name        SourceMonkey example: @run-at document-start
// @namespace   sourcemonkey.example
// @version     1.1.0
// @description Demonstrates @run-at document-start (runs before DOM parses).
// @match       *://*/headers-run-at/headers-run-at.html
// @match       file:///*/headers-run-at/headers-run-at.html
// @run-at      document-start
// @grant       none
// ==/UserScript==

(function () {
  'use strict';

  // At document-start the body element typically doesn't exist yet,
  // so we capture readyState + a timestamp immediately and defer the
  // DOM append until DOMContentLoaded. The timestamp (milliseconds
  // since navigation start) is what makes the gap between
  // document-start, document-end, and document-idle visible in the
  // displayed log.
  const observed = document.readyState;
  const observedAt = performance.now();
  const bodyAtStart = String(document.body);

  function record() {
    const log = document.getElementById('log');
    if (!log) return;
    const li = document.createElement('li');
    li.dataset.script = 'start';
    li.textContent =
      `[document-start] t=${observedAt.toFixed(1)}ms readyState=${observed} body=${bodyAtStart}`;
    // Use the page's sorted-insert helper so the displayed log stays
    // in chronological order. Without this, this row appends at DCL
    // (when this DCL listener runs) and lands after document-end's
    // row even though its t= timestamp is much earlier.
    window.__SM_LOG_INSERT__(log, li, observedAt);
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
