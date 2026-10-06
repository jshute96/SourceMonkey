// ==UserScript==
// @name        SourceMonkey example: GM_xmlhttpRequest with @connect example.com
// @namespace   https://github.com/jshute96/SourceMonkey
// @version     2.0.0
// @description Declares @connect example.com, so requests there go without asking, and SourceMonkey asks before the others.
// @match       *://*/xmlhttp-connect/xmlhttp-connect.html
// @match       file:///*/xmlhttp-connect/xmlhttp-connect.html
// @run-at      document-end
// @grant       GM_xmlhttpRequest
// @connect     example.com
// ==/UserScript==

// Shows a `@connect` line covering one site: requests to example.com
// go straight through, while example.org and example.net are not
// covered, so SourceMonkey asks before sending them.
//
// Adds a row of buttons to xmlhttp-connect.html, one per target
// site, and logs each request's outcome there.

(function () {
  'use strict';

  const SCRIPT = 'connect-example-com';
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
  heading.textContent = `${SCRIPT} (@connect example.com)`;
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
