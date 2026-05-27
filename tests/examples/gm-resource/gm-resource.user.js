// ==UserScript==
// @name        SourceMonkey example: GM_getResourceText / GM_getResourceURL
// @namespace   https://github.com/jshute96/SourceMonkey
// @version     1.0.0
// @description Read prefetched @resource files as text and as blob URLs.
// @match       *://*/gm-resource/gm-resource.html
// @match       file:///*/gm-resource/gm-resource.html
// @run-at      document-end
// @resource    styleSheet ./resource.css
// @resource    config     ./resource.json
// @resource    logo       ./logo.svg
// @grant       GM_addStyle
// @grant       GM_getResourceText
// @grant       GM_getResourceURL
// ==/UserScript==

(function () {
  'use strict';

  const status = document.getElementById('runStatus');
  const log = document.getElementById('log');
  if (!status || !log) return;

  function append(msg) {
    const li = document.createElement('li');
    li.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    log.prepend(li);
  }

  document.getElementById('btn-css').addEventListener('click', () => {
    // Pull the bytes back as text and hand them to GM_addStyle.
    const css = GM_getResourceText('styleSheet');
    if (typeof css !== 'string') {
      append('GM_getResourceText("styleSheet") returned undefined');
      return;
    }
    GM_addStyle(css);
    // The CSS rule targets #playground.styled — flip the class so it
    // applies. A second click is a no-op (class already present).
    const pg = document.getElementById('playground');
    if (pg) pg.classList.add('styled');
    append(`GM_getResourceText("styleSheet") -> ${css.length} chars; #playground now .styled`);
  });

  document.getElementById('btn-json').addEventListener('click', () => {
    const text = GM_getResourceText('config');
    if (typeof text !== 'string') {
      append('GM_getResourceText("config") returned undefined');
      return;
    }
    let parsed;
    try { parsed = JSON.parse(text); }
    catch (err) {
      append(`GM_getResourceText("config") parse failed: ${err.message}`);
      return;
    }
    append(`GM_getResourceText("config") -> greeting="${parsed.greeting}", items=[${parsed.items.join(',')}]`);
  });

  document.getElementById('btn-img').addEventListener('click', () => {
    const url = GM_getResourceURL('logo');
    if (typeof url !== 'string') {
      append('GM_getResourceURL("logo") returned undefined');
      return;
    }
    const slot = document.getElementById('imgSlot');
    if (slot) {
      slot.replaceChildren();
      const img = document.createElement('img');
      img.src = url;
      img.alt = 'SourceMonkey example logo';
      img.style.border = '1px solid #999';
      slot.appendChild(img);
    }
    append(`GM_getResourceURL("logo") -> ${url.slice(0, 24)}…`);
  });

  document.getElementById('btn-missing').addEventListener('click', () => {
    const text = GM_getResourceText('nope');
    const url = GM_getResourceURL('nope');
    append(`unknown name → text=${text === undefined ? 'undefined' : JSON.stringify(text)}, url=${url === undefined ? 'undefined' : url}`);
  });

  status.classList.add('ran');
  status.textContent = 'Userscript ran. Click a button to exercise GM_getResource*.';
})();
