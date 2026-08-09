// ==UserScript==
// @name        SourceMonkey example: @grant casing (canonical)
// @namespace   https://github.com/jshute96/SourceMonkey
// @version     1.0.0
// @description Control case: grants spelled exactly as TM/VM document them.
// @match       *://*/grant-case/grant-case.html
// @match       file:///*/grant-case/grant-case.html
// @run-at      document-end
// @grant       GM_log
// @grant       GM_xmlhttpRequest
// @grant       GM_getResourceURL
// ==/UserScript==

(function () {
  'use strict';

  // Shared probe shape across every variant on this page: report the
  // `typeof` of each spelling we might have been given. "undefined"
  // means the manager did not bind that name.
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
    li.dataset.script = 'canonical';
    li.dataset.probe = JSON.stringify(probe);
    li.textContent = '[canonical] ' + JSON.stringify(probe);
    log.appendChild(li);
  }

  const status = document.getElementById('runStatus');
  if (status) {
    status.classList.add('ran');
    status.textContent = 'At least one userscript ran. See log below.';
  }
})();
