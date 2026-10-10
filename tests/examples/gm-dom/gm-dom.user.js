// ==UserScript==
// @name        SourceMonkey example: gm-dom: GM_addStyle / GM_addElement
// @namespace   https://github.com/jshute96/SourceMonkey
// @version     1.0.1
// @description Inject styles and elements into the page via DOM helpers.
// @match       *://*/gm-dom/gm-dom.html
// @match       file:///*/gm-dom/gm-dom.html
// @run-at      document-end
// @grant       GM_addStyle
// @grant       GM_addElement
// ==/UserScript==

(function () {
  'use strict';

  const status = document.getElementById('runStatus');
  const log = document.getElementById('log');
  const playground = document.getElementById('playground');
  if (!status || !log || !playground) return;

  const originalHTML = playground.innerHTML;
  // Every element this userscript has injected, in insertion order.
  // Reset walks this list and removes them — important because some
  // calls land outside the playground (GM_addStyle in <head>, the
  // <title> default-parent call in <head>, the <p> default-parent
  // call in <body>), so wiping playground.innerHTML alone wouldn't
  // undo them.
  const injected = [];

  function track(el) { if (el) injected.push(el); return el; }

  function append(msg) {
    const li = document.createElement('li');
    li.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    log.prepend(li);
  }

  function parentLabel(el) {
    const p = el && el.parentElement;
    if (!p) return '(none)';
    return p.id ? `<${p.tagName} id="${p.id}">` : `<${p.tagName}>`;
  }

  document.getElementById('btn-style').addEventListener('click', () => {
    const css = '#playground { border: 2px solid crimson; padding: 0.5em; background: #fff6f6; }';
    const el = track(GM_addStyle(css));
    append(`GM_addStyle(...) -> <${(el && el.tagName) || '?'}> in ${parentLabel(el)}`);
  });

  document.getElementById('btn-parent').addEventListener('click', () => {
    const el = track(GM_addElement(playground, 'span', {
      textContent: ' [span via parent form] ',
      style: 'background: yellow; padding: 0 0.25em;',
    }));
    append(`GM_addElement(playground, 'span', ...) -> appended to ${parentLabel(el)}`);
  });

  document.getElementById('btn-default').addEventListener('click', () => {
    // No parent argument — runtime picks <body> for non-head tags
    // (script/style/link/meta/title/base would go to head; <p> doesn't).
    const el = track(GM_addElement('p', {
      textContent: 'paragraph appended via the default parent',
      style: 'color: darkblue; margin: 0.5em 0;',
    }));
    append(`GM_addElement('p', ...) -> appended to ${parentLabel(el)}`);
  });

  document.getElementById('btn-title').addEventListener('click', () => {
    // <title> is a head tag, so the default parent sends it to
    // <head>. GM_addElement just appends — each click leaves a new
    // <title> sitting at the end of <head>. The browser tab text
    // stays as the original title because document.title is
    // computed from the FIRST <title> in tree order, not the last;
    // inspect <head> in DevTools to see the appended copies stack
    // up.
    const stamp = new Date().toLocaleTimeString();
    const el = track(GM_addElement('title', {
      textContent: `[appended by userscript @ ${stamp}]`,
    }));
    append(`GM_addElement('title', ...) -> appended to ${parentLabel(el)}`);
  });

  document.getElementById('btn-reset').addEventListener('click', () => {
    let removed = 0;
    for (const el of injected) {
      try { el.remove(); removed += 1; } catch { /* already detached */ }
    }
    injected.length = 0;
    playground.innerHTML = originalHTML;
    append(`reset: removed ${removed} injected element(s) and restored the playground`);
  });

  status.classList.add('ran');
  status.textContent =
    'Userscript ran. Click a button to mutate the page; click reset to undo.';
})();
