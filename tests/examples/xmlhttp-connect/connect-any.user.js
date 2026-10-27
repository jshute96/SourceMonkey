// ==UserScript==
// @name        SourceMonkey example: xmlhttp-connect: GM_xmlhttpRequest with @connect *
// @namespace   https://github.com/jshute96/SourceMonkey
// @version     2.0.3
// @description Declares @connect *, so requests to any site go without asking.
// @icon        https://jshute96.github.io/SourceMonkey/src/icons/icon-48.png
// @match       https://jshute96.github.io/SourceMonkey/tests/examples/xmlhttp-connect/xmlhttp-connect.html
// @match       *://*/*xmlhttp-connect/xmlhttp-connect.html
// @match       file:///*/xmlhttp-connect/xmlhttp-connect.html
// @run-at      document-end
// @grant       GM_xmlhttpRequest
// @connect     *
// ==/UserScript==

// Shows the `@connect *` wildcard: every site is covered, so no
// request asks first.
//
// Adds a row of buttons to xmlhttp-connect.html, one per target
// site, and logs each request's outcome there.

(function () {
  'use strict';

  const SCRIPT = 'connect-any';
  const container = document.getElementById('scripts');
  const log = document.getElementById('log');
  if (!container || !log) return;

  // Where each button sends a GET. The page's own address is the
  // same-origin case, which never needs `@connect`; it's left out when
  // the page was opened as a file, which has no site to be the same as.
  const TARGETS = [
    ...(location.protocol === 'file:' ? [] : [{ id: 'self', label: 'This page', url: location.href }]),
    { id: 'example.com', label: 'example.com', url: 'https://example.com/' },
    { id: 'example.org', label: 'example.org', url: 'https://example.org/' },
    { id: 'example.net', label: 'example.net', url: 'https://example.net/' },
  ];

  function record(target, outcome, detail) {
    const li = document.createElement('li');
    li.dataset.script = SCRIPT;
    li.dataset.target = target.id;
    li.dataset.outcome = outcome;
    li.textContent = `[${SCRIPT}] ${target.label}: ${outcome}: ${detail}`;
    log.prepend(li);
  }

  function send(target) {
    GM_xmlhttpRequest({
      method: 'GET',
      url: target.url,
      timeout: 10000,
      onload(res) { record(target, 'onload', `HTTP ${res.status}`); },
      onerror(e) { record(target, 'onerror', (e && e.error) || String(e)); },
      ontimeout() { record(target, 'ontimeout', 'Timed out'); },
    });
  }

  // One row of buttons per script, in the page's "Try it" section.
  const section = document.createElement('section');
  section.dataset.script = SCRIPT;
  const heading = document.createElement('h3');
  heading.textContent = `${SCRIPT} (@connect *)`;
  const buttons = document.createElement('div');
  buttons.className = 'buttons';
  for (const target of TARGETS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.target = target.id;
    button.textContent = target.label;
    button.addEventListener('click', () => send(target));
    buttons.appendChild(button);
  }
  section.append(heading, buttons);
  container.appendChild(section);
  document.getElementById('waiting')?.remove();
})();
