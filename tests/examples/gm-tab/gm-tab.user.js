// ==UserScript==
// @name        SourceMonkey example: gm-tab: GM_getTab / GM_saveTab / GM_getTabs
// @namespace   https://github.com/jshute96/SourceMonkey
// @version     1.0.1
// @description Count this page's loads per tab and list every tab's object with the per-tab APIs.
// @match       *://*/*gm-tab/gm-tab.html
// @match       file:///*/gm-tab/gm-tab.html
// @run-at      document-end
// @grant       GM_getTab
// @grant       GM_saveTab
// @grant       GM_getTabs
// ==/UserScript==

(function () {
  'use strict';

  const status = document.getElementById('runStatus');
  const output = document.getElementById('output');
  const note = document.getElementById('note');
  if (!status || !output || !note) return;

  function show(label, value) {
    output.textContent = `${label}\n${JSON.stringify(value, null, 2)}`;
  }

  // Count this load in the tab's object, then show it.
  GM_getTab((tab) => {
    tab.loads = (tab.loads || 0) + 1;
    GM_saveTab(tab, () => {
      note.value = tab.note || '';
      show('GM_getTab (after counting this load) ->', tab);
      status.classList.add('ran');
      status.textContent = `Userscript ran. Loads of this page in this tab: ${tab.loads}. Reload to count another.`;
    });
  });

  document.getElementById('btn-get').addEventListener('click', () => {
    GM_getTab((tab) => show('GM_getTab ->', tab));
  });

  // Read first so the save keeps `loads`: GM_saveTab replaces the
  // whole object.
  document.getElementById('btn-save').addEventListener('click', () => {
    GM_getTab((tab) => {
      tab.note = note.value;
      GM_saveTab(tab, () => show('GM_saveTab saved', tab));
    });
  });

  document.getElementById('btn-list').addEventListener('click', () => {
    GM_getTabs((tabs) => show('GM_getTabs ->', tabs));
  });
})();
