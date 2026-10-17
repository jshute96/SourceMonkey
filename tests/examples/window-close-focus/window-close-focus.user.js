// ==UserScript==
// @name        SourceMonkey example: window-close-focus: window.close / window.focus
// @namespace   https://github.com/jshute96/SourceMonkey
// @version     1.0.4
// @description Close the current tab and raise the browser window through the manager's window.* grants.
// @match       *://*/*window-close-focus/window-close-focus.html
// @match       file:///*/window-close-focus/window-close-focus.html
// @run-at      document-end
// @grant       window.close
// @grant       window.focus
// ==/UserScript==

(function () {
  'use strict';

  const status = document.getElementById('runStatus');
  const closeKind = document.getElementById('closeKind');
  const focusKind = document.getElementById('focusKind');
  const log = document.getElementById('log');
  if (!status || !closeKind || !focusKind || !log) return;

  function append(msg) {
    const li = document.createElement('li');
    li.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    log.prepend(li);
  }

  // There is no documented feature test for these grants (unlike
  // window.onurlchange, the methods exist either way). Looking for
  // `[native code]` in the function source is the next best thing: the
  // manager's replacement is ordinary script.
  function kindOf(fn) {
    try {
      return Function.prototype.toString.call(fn).includes('native code')
        ? 'browser'
        : 'manager';
    } catch (e) {
      return 'unknown';
    }
  }

  const closeIs = kindOf(window.close);
  const focusIs = kindOf(window.focus);
  closeKind.textContent = `window.close: ${closeIs}`;
  focusKind.textContent = `window.focus: ${focusIs}`;
  if (closeIs === 'manager') closeKind.classList.add('ran');
  if (focusIs === 'manager') focusKind.classList.add('ran');

  document.getElementById('btn-focus').addEventListener('click', () => {
    append('-> window.focus()');
    window.focus();
    append('   returned (nothing to see — this tab is already the front one)');
  });

  document.getElementById('btn-focus-delayed').addEventListener('click', () => {
    append('will call window.focus() in 3s — switch away now');
    setTimeout(() => {
      window.focus();
      append('-> window.focus() (delayed) returned');
    }, 3000);
  });

  document.getElementById('btn-close').addEventListener('click', () => {
    append('-> window.close()');
    window.close();
    // The call returns immediately either way — the manager does the
    // work in the background — so "still here" is only meaningful once
    // the tab has had time to go away.
    setTimeout(() => append('   still here: the call was not performed'), 1000);
  });

  status.classList.add('ran');
  status.textContent = 'Userscript ran. Click a button.';
})();
