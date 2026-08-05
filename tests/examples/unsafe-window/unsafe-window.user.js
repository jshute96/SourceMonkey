// ==UserScript==
// @name        SourceMonkey example: unsafeWindow
// @namespace   https://github.com/jshute96/SourceMonkey
// @version     1.0.0
// @description Reads and writes the page's real window through unsafeWindow, while still using GM storage.
// @match       *://*/unsafe-window/unsafe-window.html
// @match       file:///*/unsafe-window/unsafe-window.html
// @run-at      document-end
// @grant       unsafeWindow
// @grant       GM_setValue
// @grant       GM_getValue
// ==/UserScript==

(function () {
  'use strict';

  function log(variant, text) {
    const list = document.getElementById('log');
    if (!list) return;
    const li = document.createElement('li');
    li.dataset.script = variant;
    li.textContent = text;
    list.appendChild(li);
  }

  // 1. Read a page-defined global. This is the whole point of the
  //    grant: `window.__PAGE_APP__` is invisible from an isolated
  //    world, so a script that gets this wrong silently sees undefined.
  const app = unsafeWindow.__PAGE_APP__;
  log('read', `unsafeWindow.__PAGE_APP__ = ${JSON.stringify(app && { name: app.name, version: app.version })}`);

  // 2. Call a page-defined function.
  const greeting = typeof (app && app.greet) === 'function'
    ? app.greet('userscript')
    : '(page function not visible)';
  log('call', `unsafeWindow.__PAGE_APP__.greet('userscript') = ${JSON.stringify(greeting)}`);

  // 3. Write something the page itself can read back. The page checks
  //    this on `load` and renders it into #pageSees.
  unsafeWindow.__FROM_SCRIPT__ = 'written-by-userscript';
  log('write', 'set unsafeWindow.__FROM_SCRIPT__ = "written-by-userscript"');

  // 4. On Chrome the script runs in the page's realm, so the two are
  //    the same object. On Firefox they differ. Scripts that branch on
  //    this need the answer to be honest.
  log('identity', `unsafeWindow === window: ${unsafeWindow === window}`);

  // 5. GM_* still works. Reaching the page realm must not cost the
  //    script its storage — this counter persists across reloads.
  const visits = GM_getValue('visits', 0);
  GM_setValue('visits', visits + 1);
  log('gm', `GM_getValue('visits') = ${visits} (incremented for next load)`);

  const status = document.getElementById('runStatus');
  if (status) {
    status.classList.add('ran');
    status.textContent = 'Userscripts ran. See log below.';
  }
})();
