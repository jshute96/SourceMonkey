// ==UserScript==
// @name        SourceMonkey example: gm-open-in-tab: GM_openInTab
// @namespace   https://github.com/jshute96/SourceMonkey
// @version     1.0.3
// @description Open new tabs via every GM_openInTab call shape.
// @icon        https://jshute96.github.io/SourceMonkey/src/icons/icon-48.png
// @match       https://jshute96.github.io/SourceMonkey/tests/examples/gm-open-in-tab/gm-open-in-tab.html
// @match       *://*/*gm-open-in-tab/gm-open-in-tab.html
// @match       file:///*/gm-open-in-tab/gm-open-in-tab.html
// @run-at      document-end
// @grant       GM_openInTab
// ==/UserScript==

(function () {
  'use strict';

  const status = document.getElementById('runStatus');
  const log = document.getElementById('log');
  const url = document.getElementById('url');
  if (!status || !log || !url) return;

  function append(msg) {
    const li = document.createElement('li');
    li.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    log.prepend(li);
  }

  let lastControl = null;

  function open(label, args) {
    append(`-> GM_openInTab(${label})`);
    try {
      const ctl = GM_openInTab.apply(null, args);
      lastControl = ctl;
      const closedFlag = ctl && typeof ctl.closed === 'boolean' ? String(ctl.closed) : 'n/a';
      append(`   returned: ${typeof ctl} (closed=${closedFlag})`);
    } catch (e) {
      append(`   threw: ${(e && e.message) || e}`);
    }
  }

  document.getElementById('btn-active').addEventListener('click', () => {
    open(`${JSON.stringify(url.value)}, { active: true }`, [url.value, { active: true }]);
  });
  document.getElementById('btn-background').addEventListener('click', () => {
    open(`${JSON.stringify(url.value)}, { active: false }`, [url.value, { active: false }]);
  });
  document.getElementById('btn-positional').addEventListener('click', () => {
    open(`${JSON.stringify(url.value)}, true (legacy positional)`, [url.value, true]);
  });
  document.getElementById('btn-onclose').addEventListener('click', () => {
    open(`${JSON.stringify(url.value)}, { active: true } + onclose`, [
      url.value,
      { active: true },
    ]);
    if (lastControl) {
      lastControl.onclose = () => append('   onclose fired for the just-opened tab');
    }
  });
  document.getElementById('btn-close').addEventListener('click', () => {
    if (!lastControl) {
      append('no tab to close (open one first)');
      return;
    }
    try {
      lastControl.close();
      append(`closed last-opened (closed flag now: ${String(lastControl.closed)})`);
    } catch (e) {
      append(`close threw: ${(e && e.message) || e}`);
    }
  });

  status.classList.add('ran');
  status.textContent =
    'Userscript ran. Click a button to open a new tab.';
})();
