// ==UserScript==
// @name         GreasyFork: Install in SourceMonkey
// @namespace    https://github.com/jshute96/SourceMonkey
// @version      1.0.1
// @description  Add an "Install in SourceMonkey" button next to GreasyFork's install button.
// @author       Jeff Shute <jshute@gmail.com>
// @match        https://greasyfork.org/*
// @match        https://sleazyfork.org/*
// @grant        none
// @noframes
// @run-at       document-start
// @updateURL    https://github.com/jshute96/SourceMonkey/raw/refs/heads/main/userscripts/installers/greasyfork-installer.user.js
// @downloadURL  https://github.com/jshute96/SourceMonkey/raw/refs/heads/main/userscripts/installers/greasyfork-installer.user.js
// ==/UserScript==

(function () {
  'use strict';

  const TAG = '[grsy-sm]';
  // Web pages can't navigate directly to chrome-extension:// URLs;
  // SourceMonkey provides a redirector hosted on github.com that
  // forwards us into the extension's sources page.
  const REDIRECT_URL = 'https://github.com/jshute96/SourceMonkey/blob/main/docs/redirect-page.md';
  const BTN_ID = 'jshute-install-in-sourcemonkey';

  console.log(TAG, 'init on', location.href);

  // Try right away in case the install link is already in the DOM,
  // then keep watching for SPA re-renders / late insertion.
  tryInsertButton();
  const obs = new MutationObserver(() => tryInsertButton());
  obs.observe(document.documentElement, { childList: true, subtree: true });

  function tryInsertButton() {
    if (document.getElementById(BTN_ID)) return;
    const installLink = document.querySelector('a.install-link');
    if (!installLink) return;
    const userJsUrl = installLink.getAttribute('href');
    if (!userJsUrl) return;

    const btn = document.createElement('a');
    btn.id = BTN_ID;
    // Copy the install button's classes so it picks up greasyfork's
    // green-button styling. Use an <a> so the same CSS applies.
    btn.className = installLink.className;
    btn.textContent = 'Install in SourceMonkey';
    btn.href = '#';
    btn.style.marginLeft = '0.5em';
    btn.setAttribute('rel', 'nofollow');

    btn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const target = REDIRECT_URL +
        '?page=sources.html' +
        '&add_source=' + encodeURIComponent(userJsUrl);
      console.log(TAG, 'opening', target);
      window.open(target, '_blank');
    });

    // Insert after the install link's help-link sibling if present,
    // otherwise immediately after the install link itself.
    const helpLink = installLink.parentNode.querySelector('a.install-help-link');
    const after = helpLink || installLink;
    after.parentNode.insertBefore(btn, after.nextSibling);

    console.log(TAG, 'button inserted for', userJsUrl);
  }
})();
