// ==UserScript==
// @name        SourceMonkey example: gm-cookie: GM_cookie
// @namespace   https://github.com/jshute96/SourceMonkey
// @version     1.0.5
// @description Click buttons to set, list and delete cookies with GM_cookie and GM.cookie.
// @match       *://*/*gm-cookie/gm-cookie.html
// @match       file:///*/gm-cookie/gm-cookie.html
// @run-at      document-end
// @grant       GM_cookie
// @grant       GM.cookie
// ==/UserScript==

(function () {
  'use strict';

  const status = document.getElementById('runStatus');
  const log = document.getElementById('log');
  if (!status || !log) return;

  // One log entry per call, newest first, under one timestamp: what was
  // called, what came back, and (after a change) what the page itself
  // now sees.
  function entry(call, result, withPageView) {
    const li = document.createElement('li');
    li.style.whiteSpace = 'pre-wrap';
    const lines = [`[${new Date().toLocaleTimeString()}] ${call}`, `  → ${result}`];
    if (withPageView) lines.push(`  document.cookie: ${document.cookie || '(empty)'}`);
    li.textContent = lines.join('\n');
    log.prepend(li);
  }

  const name = () => document.getElementById('name').value;
  const value = () => document.getElementById('value').value;
  const errText = (e) => (e && e.message) || String(e);
  // The two list buttons filter by the name field, or list all when
  // it's empty, so they differ only in callback vs Promise.
  const listDetails = () => (name() ? { name: name() } : {});
  const listCall = (api) => `${api}(${name() ? `{ name: "${name()}" }` : '{}'})`;
  // A list result: the count, then one cookie per line.
  const describe = (cookies) => (cookies.length
    ? `${cookies.length} cookie${cookies.length === 1 ? '' : 's'}:\n`
      + cookies.map((c) => `      ${c.name}=${c.value}`).join('\n')
    : 'no cookies');

  document.getElementById('btn-set').addEventListener('click', () => {
    const call = `GM_cookie.set({ name: "${name()}", value: "${value()}" })`;
    GM_cookie.set({ name: name(), value: value() }, (error) => {
      entry(call, error ? `error: ${errText(error)}` : 'set', true);
    });
  });

  document.getElementById('btn-list').addEventListener('click', () => {
    const call = listCall('GM_cookie.list');
    GM_cookie.list(listDetails(), (cookies, error) => {
      entry(call, error ? `error: ${errText(error)}` : describe(cookies));
    });
  });

  document.getElementById('btn-list-all').addEventListener('click', () => {
    GM_cookie.list({}, (cookies, error) => {
      entry('GM_cookie.list({})', error ? `error: ${errText(error)}` : describe(cookies));
    });
  });

  document.getElementById('btn-delete').addEventListener('click', () => {
    const call = `GM_cookie.delete({ name: "${name()}" })`;
    GM_cookie.delete({ name: name() }, (error) => {
      entry(call, error ? `error: ${errText(error)}` : 'deleted', true);
    });
  });

  document.getElementById('btn-gm-list').addEventListener('click', () => {
    const call = listCall('GM.cookie.list');
    GM.cookie.list(listDetails()).then(
      (cookies) => entry(call, describe(cookies)),
      (e) => entry(call, `error: ${errText(e)}`),
    );
  });

  document.getElementById('btn-elsewhere').addEventListener('click', () => {
    const call = 'GM.cookie.list({ url: "https://example.com/" })';
    GM.cookie.list({ url: 'https://example.com/' }).then(
      (cookies) => entry(call, `${describe(cookies)}\n  (expected an error)`),
      (e) => entry(call, `error: ${errText(e)} (expected: the script doesn't match that site)`),
    );
  });

  document.getElementById('btn-clear').addEventListener('click', () => {
    log.innerHTML = '';
  });

  status.classList.add('ran');
  status.textContent = 'Userscript ran. Click a button to call GM_cookie.';
})();
