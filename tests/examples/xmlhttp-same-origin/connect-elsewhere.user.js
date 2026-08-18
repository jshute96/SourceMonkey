// ==UserScript==
// @name        SourceMonkey example: same-origin GM_xmlhttpRequest with @connect elsewhere
// @namespace   https://github.com/jshute96/SourceMonkey
// @version     1.0.0
// @description Demonstrates that declaring an unrelated @connect host keeps same-origin working.
// @match       *://*/xmlhttp-same-origin/xmlhttp-same-origin.html
// @match       file:///*/xmlhttp-same-origin/xmlhttp-same-origin.html
// @run-at      document-end
// @grant       GM_xmlhttpRequest
// @connect     api.example.com
// ==/UserScript==

(function () {
  'use strict';

  // Same request as no-connect.user.js, from a script that DID declare
  // a @connect host — just not this one. The page's own origin is
  // allowed regardless.
  const TARGET = location.href;
  const log = document.getElementById('log');
  if (!log) return;

  function record(outcome, detail) {
    const li = document.createElement('li');
    li.dataset.script = 'connect-elsewhere';
    li.dataset.outcome = outcome;
    li.textContent = `[connect-elsewhere] ${outcome}: ${detail}`;
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
