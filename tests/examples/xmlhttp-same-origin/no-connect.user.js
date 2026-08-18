// ==UserScript==
// @name        SourceMonkey example: same-origin GM_xmlhttpRequest with no @connect
// @namespace   https://github.com/jshute96/SourceMonkey
// @version     1.0.0
// @description Demonstrates that a request to the page's own origin needs no @connect line.
// @match       *://*/xmlhttp-same-origin/xmlhttp-same-origin.html
// @match       file:///*/xmlhttp-same-origin/xmlhttp-same-origin.html
// @run-at      document-end
// @grant       GM_xmlhttpRequest
// ==/UserScript==

(function () {
  'use strict';

  // The page's own URL: same origin by construction, whatever host or
  // port the example is being served from.
  const TARGET = location.href;
  const log = document.getElementById('log');
  if (!log) return;

  function record(outcome, detail) {
    const li = document.createElement('li');
    li.dataset.script = 'no-connect';
    li.dataset.outcome = outcome;
    li.textContent = `[no-connect] ${outcome}: ${detail}`;
    log.appendChild(li);
    const status = document.getElementById('runStatus');
    if (status) {
      status.classList.add('ran');
      status.textContent = 'At least one userscript ran. See log below.';
    }
  }

  GM_xmlhttpRequest({
    method: 'GET',
    url: TARGET,
    timeout: 5000,
    onload(res) { record('onload', `status=${res.status}`); },
    onerror(e) { record('onerror', (e && e.error) || String(e)); },
    ontimeout() { record('ontimeout', 'timed out'); },
  });
})();
