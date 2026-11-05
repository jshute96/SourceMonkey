// ==UserScript==
// @name        SourceMonkey example: resource-missing: a @resource that doesn't load
// @namespace   https://github.com/jshute96/SourceMonkey
// @version     1.0.0
// @description Declares a @resource whose URL doesn't exist, and shows what the script gets when it asks for it.
// @icon        https://jshute96.github.io/SourceMonkey/src/icons/icon-48.png
// @match       https://jshute96.github.io/SourceMonkey/userscripts/examples/resource-missing/resource-missing.html
// @match       *://*/*resource-missing/resource-missing.html
// @match       file:///*/resource-missing/resource-missing.html
// @run-at      document-end
// @resource    missing https://jshute96.github.io/SourceMonkey/userscripts/examples/resource-missing/no-such-file.css
// @resource    working data:text/plain;base64,aGVsbG8=
// @grant       GM_getResourceText
// @grant       GM_getResourceURL
// @grant       GM.getResourceText
// @grant       GM.getResourceUrl
// ==/UserScript==

(async function () {
  'use strict';

  const status = document.getElementById('runStatus');
  const body = document.querySelector('#results tbody');
  if (!status || !body) return;

  // Each row: which call, and how to make it. The row's name is what the
  // spec reads it by.
  const rows = [
    ['GM_getResourceText', () => GM_getResourceText('missing')],
    ['GM_getResourceURL', () => GM_getResourceURL('missing')],
    ['GM.getResourceText', () => GM.getResourceText('missing')],
    ['GM.getResourceUrl', () => GM.getResourceUrl('missing')],
    ['GM_getResourceText, working resource', () => GM_getResourceText('working')],
    ['GM_info.script.resources lists it', () => GM_info.script.resources.some((r) => r.name === 'missing')],
  ];

  for (const [name, call] of rows) {
    let shown;
    try {
      shown = JSON.stringify(await call());
    } catch (e) {
      shown = `threw ${e}`;
    }
    const tr = body.insertRow();
    const th = document.createElement('th');
    th.scope = 'row';
    th.textContent = name;
    tr.appendChild(th);
    const td = tr.insertCell();
    td.dataset.call = name;
    td.textContent = String(shown);
  }

  status.classList.add('ran');
  status.textContent = 'Userscript ran, with a @resource that did not load.';
  status.dataset.done = 'true';
})();
