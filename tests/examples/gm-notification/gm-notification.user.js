// ==UserScript==
// @name        SourceMonkey example: GM_notification
// @namespace   sourcemonkey.example
// @version     1.0.0
// @description Click buttons to fire various GM_notification call shapes.
// @match       *://*/gm-notification/gm-notification.html
// @match       file:///*/gm-notification/gm-notification.html
// @run-at      document-end
// @grant       GM_notification
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

  // Call GM_notification with the given args and route both the
  // synchronous-return and Promise paths into the log. Wrapping in
  // Promise.resolve handles managers that return the id synchronously
  // (TM legacy) the same way as managers that return a Promise (SM).
  function show(label, args, expectation) {
    append(`-> ${label}`);
    try {
      const ret = GM_notification.apply(null, args);
      Promise.resolve(ret).then(
        (id) => append(`   resolved id=${id ?? '(none)'}  -- ${expectation}`),
        (e) => append(`   rejected: ${(e && e.message) || e}  -- ${expectation}`),
      );
    } catch (e) {
      append(`   threw: ${(e && e.message) || e}  -- ${expectation}`);
    }
  }

  document.getElementById('btn-simple').addEventListener('click', () => {
    show('details {text, title}',
      [{ text: 'Hello from a userscript', title: 'Hello' }],
      'simple notification');
  });

  document.getElementById('btn-timeout').addEventListener('click', () => {
    show('details {text, title, timeout: 3000}',
      [{ text: 'Auto-clears in 3 seconds', title: 'Timeout', timeout: 3000 }],
      'auto-clears');
  });

  document.getElementById('btn-callbacks').addEventListener('click', () => {
    show('details {text, title, onclick, ondone}', [{
      text: 'Click me, then close me',
      title: 'Callbacks',
      onclick: () => append('     onclick fired'),
      ondone:  () => append('     ondone fired'),
    }], 'callbacks log here when the user clicks/closes the OS notification');
  });

  document.getElementById('btn-positional').addEventListener('click', () => {
    show('positional (text, title, image, onclick)', [
      'Positional call shape',
      'Positional',
      '',
      () => append('     positional onclick fired'),
    ], 'legacy 4-arg form');
  });

  document.getElementById('btn-empty').addEventListener('click', () => {
    show('details {text: ""}', [{ text: '' }], 'empty text — expected to reject');
  });

  document.getElementById('btn-clear').addEventListener('click', () => {
    log.innerHTML = '';
  });

  status.classList.add('ran');
  status.textContent = 'Userscript ran. Click a button to fire a notification.';
})();
