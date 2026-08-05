// ==UserScript==
// @name        SourceMonkey example: @grant casing (GM4 GM. forms)
// @namespace   https://github.com/jshute96/SourceMonkey
// @version     1.0.0
// @description Grants the GM. prefix-rewrite spellings instead of the GM4 ones.
// @match       *://*/grant-case/grant-case.html
// @match       file:///*/grant-case/grant-case.html
// @run-at      document-end
// @grant       GM.log
// @grant       GM.xmlhttpRequest
// @grant       GM.getResourceURL
// ==/UserScript==

(function () {
  'use strict';

  // Same probe shape as canonical.user.js. `GM.xmlhttpRequest`
  // (lower-case h) and `GM.getResourceURL` (upper-case URL) are what
  // you get by rewriting the legacy `GM_` name's suffix onto the `GM.`
  // namespace. Violentmonkey resolves those by rewriting them back, so
  // published scripts use them; the GM4-documented spellings are
  // `GM.xmlHttpRequest` and `GM.getResourceUrl`.
  //
  // The probe reports both spellings of each so you can see whether a
  // manager exposes only the granted one or the whole pair.
  const probe = {
    GM_log: typeof GM_log,
    GM_xmlhttpRequest: typeof GM_xmlhttpRequest,
    GM_getResourceURL: typeof GM_getResourceURL,
    'GM.log': typeof GM !== 'undefined' && GM ? typeof GM.log : 'no-GM',
    'GM.xmlHttpRequest': typeof GM !== 'undefined' && GM ? typeof GM.xmlHttpRequest : 'no-GM',
    'GM.xmlhttpRequest': typeof GM !== 'undefined' && GM ? typeof GM.xmlhttpRequest : 'no-GM',
    'GM.getResourceUrl': typeof GM !== 'undefined' && GM ? typeof GM.getResourceUrl : 'no-GM',
    'GM.getResourceURL': typeof GM !== 'undefined' && GM ? typeof GM.getResourceURL : 'no-GM',
  };

  const log = document.getElementById('log');
  if (log) {
    const li = document.createElement('li');
    li.dataset.script = 'gm4-case';
    li.dataset.probe = JSON.stringify(probe);
    li.textContent = '[gm4-case] ' + JSON.stringify(probe);
    log.appendChild(li);
  }

  const status = document.getElementById('runStatus');
  if (status) {
    status.classList.add('ran');
    status.textContent = 'At least one userscript ran. See log below.';
  }
})();
