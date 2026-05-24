// ==UserScript==
// @name        SourceMonkey example: GM_info
// @namespace   sourcemonkey.example
// @version     1.0.0
// @description Render GM_info as JSON onto the page.
// @match       *://*/gm-info/gm-info.html
// @match       file:///*/gm-info/gm-info.html
// @run-at      document-end
// @grant       GM_info
// ==/UserScript==

(function () {
  'use strict';

  const status = document.getElementById('runStatus');
  const out = document.getElementById('output');
  if (!out || !status) return;

  // GM_info is technically available without an explicit @grant in TM
  // and SM, but listing it under @grant here makes the dependency
  // visible to a reader.
  const info = (typeof GM_info !== 'undefined') ? GM_info : null;
  if (!info) {
    status.textContent = 'GM_info is undefined — is the script loaded?';
    return;
  }

  out.textContent = JSON.stringify(info, null, 2);
  status.classList.add('ran');
  status.textContent =
    'Userscript ran. GM_info dumped below — note scriptHandler / version / scriptMetaStr.';
})();
