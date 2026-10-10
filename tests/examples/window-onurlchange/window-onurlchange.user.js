// ==UserScript==
// @name        SourceMonkey example: window-onurlchange: window.onurlchange
// @namespace   https://github.com/jshute96/SourceMonkey
// @version     1.0.2
// @description Watch SPA navigations (pushState / replaceState / hash / back) through the urlchange event.
// @match       *://*/window-onurlchange/window-onurlchange.html*
// @match       file:///*/window-onurlchange/window-onurlchange.html*
// @run-at      document-end
// @grant       window.onurlchange
// ==/UserScript==

(function () {
  'use strict';

  const status = document.getElementById('runStatus');
  const supported = document.getElementById('supported');
  const current = document.getElementById('current');
  const count = document.getElementById('count');
  const log = document.getElementById('log');
  if (!status || !supported || !current || !count || !log) return;

  // The documented Tampermonkey feature test: the property exists and
  // is `null` exactly when the grant took effect. Without the grant it
  // is `undefined`, so this is also what an ungranted script sees.
  const isSupported = window.onurlchange === null;

  supported.textContent = isSupported
    ? 'window.onurlchange === null → urlchange events are available'
    : 'window.onurlchange is ' + String(window.onurlchange) +
      ' → this manager did not grant the feature; nothing below will fire';
  supported.className = isSupported ? 'status ran' : 'status';

  let seen = 0;

  function append(msg) {
    const li = document.createElement('li');
    li.textContent = '[' + new Date().toLocaleTimeString() + '] ' + msg;
    log.prepend(li);
  }

  function render() {
    current.textContent = location.href;
    count.textContent = String(seen);
  }

  // Nothing fires on load — the script is responsible for handling the
  // URL it started on, then listening for changes. That matches
  // Tampermonkey, whose own examples call their handler once directly
  // before subscribing.
  append('initial URL (no urlchange event for this): ' + location.href);
  render();

  if (isSupported) {
    window.addEventListener('urlchange', function (info) {
      seen += 1;
      const reported = info && info.url;
      append(
        'urlchange → ' + reported +
        (reported === location.href ? '' : '  (location.href is ' + location.href + ')'),
      );
      render();
    });
  }

  status.classList.add('ran');
  status.textContent = isSupported
    ? 'Userscript ran and is listening. Use the buttons below to change the URL without reloading.'
    : 'Userscript ran, but urlchange is not available here.';
})();
