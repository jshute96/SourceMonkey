// ==UserScript==
// @name        SourceMonkey example: gm-return-values: GM_ vs GM. return values
// @namespace   https://github.com/jshute96/SourceMonkey
// @version     1.0.3
// @description Call the GM_ and GM. forms of some APIs and show what each returns.
// @icon        https://jshute96.github.io/SourceMonkey/src/icons/icon-48.png
// @match       https://jshute96.github.io/SourceMonkey/userscripts/examples/gm-return-values/gm-return-values.html
// @match       *://*/*gm-return-values/gm-return-values.html
// @match       file:///*/gm-return-values/gm-return-values.html
// @run-at      document-end
// @resource    text https://jshute96.github.io/SourceMonkey/userscripts/examples/gm-return-values/resource.txt
// @grant       GM_setValue
// @grant       GM.setValue
// @grant       GM_getValue
// @grant       GM.getValue
// @grant       GM_listValues
// @grant       GM.listValues
// @grant       GM_getResourceText
// @grant       GM.getResourceText
// @grant       GM_getResourceURL
// @grant       GM.getResourceUrl
// @grant       GM_addStyle
// @grant       GM.addStyle
// @grant       GM_addElement
// @grant       GM.addElement
// @grant       GM_log
// @grant       GM.log
// @grant       GM_registerMenuCommand
// @grant       GM.registerMenuCommand
// ==/UserScript==

(function () {
  'use strict';

  const status = document.getElementById('runStatus');
  const table = document.getElementById('results');
  if (!status || !table) return;

  // What kind of value `v` is. A Promise is recognized by its tag, not
  // `instanceof`, since a manager may make it in another realm.
  function kind(v) {
    if (Object.prototype.toString.call(v) === '[object Promise]') return 'Promise';
    if (v && typeof v === 'object' && v.nodeType === 1) {
      return typeof v.then === 'function' ? 'element with then' : 'element';
    }
    if (v && typeof v.then === 'function') return 'thenable';
    if (v === null) return 'null';
    return typeof v;
  }

  // Each row: the API's name, then a call of each form with the same
  // arguments.
  const rows = [
    ['setValue', () => GM_setValue('k', 1), () => GM.setValue('k', 2)],
    ['getValue', () => GM_getValue('k'), () => GM.getValue('k')],
    ['listValues', () => GM_listValues(), () => GM.listValues()],
    ['getResourceText', () => GM_getResourceText('text'), () => GM.getResourceText('text')],
    ['getResourceURL', () => GM_getResourceURL('text'), () => GM.getResourceUrl('text')],
    ['addStyle', () => GM_addStyle('#results {}'), () => GM.addStyle('#results {}')],
    ['addElement', () => GM_addElement('span', { textContent: '' }), () => GM.addElement('span', { textContent: '' })],
    ['log', () => GM_log('gm-return-values: GM_log'), () => GM.log('gm-return-values: GM.log')],
    ['registerMenuCommand', () => GM_registerMenuCommand('GM_ form', () => {}), () => GM.registerMenuCommand('GM. form', () => {})],
  ];

  function call(fn) {
    try { return { value: fn() }; } catch (e) { return { threw: e }; }
  }

  async function run() {
    const body = table.tBodies[0];
    body.replaceChildren();
    for (const [api, legacy, dot] of rows) {
      const tr = document.createElement('tr');
      tr.dataset.api = api;
      const cells = { api };
      const l = call(legacy);
      cells.legacy = 'threw' in l ? 'throws' : kind(l.value);
      const d = call(dot);
      if ('threw' in d) {
        cells.dot = 'throws';
        cells.awaited = '';
      } else {
        cells.dot = kind(d.value);
        try { cells.awaited = kind(await d.value); } catch (e) { cells.awaited = 'rejects'; }
      }
      for (const col of ['api', 'legacy', 'dot', 'awaited']) {
        const td = document.createElement(col === 'api' ? 'th' : 'td');
        td.dataset.col = col;
        td.textContent = cells[col];
        if (col === 'api') td.scope = 'row';
        if (cells[col] === 'Promise') td.className = 'promise';
        tr.appendChild(td);
      }
      body.appendChild(tr);
    }
    status.textContent = 'Done. Each row shows what the call returned. Reload the page to run again.';
    status.dataset.done = 'true';
  }

  // One run per page load: each run adds elements and menu commands.
  const button = document.getElementById('btn-run');
  button.addEventListener('click', () => {
    button.disabled = true;
    run();
  });
  status.classList.add('ran');
  status.textContent = 'Userscript ran. Click Run to call each API.';
})();
