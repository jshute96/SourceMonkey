// ==UserScript==
// @name        SourceMonkey example: @grant casing (mis-cased GM_ forms)
// @namespace   https://github.com/jshute96/SourceMonkey
// @version     1.0.0
// @description Grants legacy GM_ names with the wrong capitalisation.
// @match       *://*/grant-case/grant-case.html
// @match       file:///*/grant-case/grant-case.html
// @run-at      document-end
// @grant       GM_Log
// @grant       GM_xmlHttpRequest
// @grant       GM_getResourceUrl
// ==/UserScript==

(function () {
  'use strict';

  // Same probe shape as canonical.user.js. These three @grant lines
  // are mis-capitalised legacy names: `GM_xmlHttpRequest` (capital H)
  // and `GM_Log` both appear in real published GreasyFork scripts, and
  // `GM_getResourceUrl` applies the GM4 casing to the legacy prefix.
  // None of them is a name any manager binds, so every probe below
  // should read "undefined".
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
    li.dataset.script = 'legacy-case';
    li.dataset.probe = JSON.stringify(probe);
    li.textContent = '[legacy-case] ' + JSON.stringify(probe);
    log.appendChild(li);
  }

  const status = document.getElementById('runStatus');
  if (status) {
    status.classList.add('ran');
    status.textContent = 'At least one userscript ran. See log below.';
  }
})();
