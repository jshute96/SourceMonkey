// ==UserScript==
// @name        SourceMonkey example: dialogs: dialog boxes
// @namespace   https://github.com/jshute96/SourceMonkey
// @version     1.0.1
// @description Click buttons to open each kind of dialog box: alert, confirm, prompt, Leave site, file choosers, pickers and a connection prompt.
// @icon        https://jshute96.github.io/SourceMonkey/src/icons/icon-48.png
// @match       https://jshute96.github.io/SourceMonkey/userscripts/examples/dialogs/dialogs.html
// @match       *://*/*dialogs/dialogs.html
// @match       file:///*/dialogs/dialogs.html
// @run-at      document-end
// @grant       GM_xmlhttpRequest
// ==/UserScript==

// No @connect lines on purpose: the request to example.com is the one
// a manager that checks @connect asks about.
//
// Each log entry carries `data-kind` and `data-result`, so a test can
// read what each dialog gave back.

(function () {
  'use strict';

  const status = document.getElementById('runStatus');
  const log = document.getElementById('log');
  if (!status || !log) return;

  function append(kind, result, text) {
    const li = document.createElement('li');
    li.dataset.kind = kind;
    li.dataset.result = result;
    li.textContent = `[${new Date().toLocaleTimeString()}] ${kind}: ${text ?? result}`;
    log.prepend(li);
  }

  const on = (id, handler) => document.getElementById(id).addEventListener('click', handler);

  on('btn-alert', () => {
    alert('Hello from the dialogs example');
    append('alert', 'closed');
  });
  on('btn-confirm', () => {
    append('confirm', String(confirm('Delete the sample item?\n\nThis can\'t be undone.')));
  });
  on('btn-prompt', () => {
    const answer = prompt('Your name?', 'Ann Lee');
    append('prompt', answer === null ? 'cancelled' : answer, answer === null ? 'cancelled' : JSON.stringify(answer));
  });
  on('btn-two-confirms', () => {
    const first = confirm('First of two: go on?');
    const second = first && confirm('Second of two: really?');
    append('two-confirms', `${first},${second}`);
  });

  // Chrome asks only when the handler cancels the event, and only
  // after a click on the page.
  const leave = document.getElementById('leave');
  window.addEventListener('beforeunload', (event) => {
    if (!leave.checked) return;
    event.preventDefault();
    event.returnValue = '';
  });

  // An input never added to the document, as most scripts that import
  // files make one.
  function choose(kind, multiple, accept) {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = multiple;
    if (accept) input.accept = accept;
    input.addEventListener('change', () => {
      const names = [...input.files].map((f) => `${f.name} (${f.size} bytes)`);
      append(kind, String(input.files.length), names.join(', '));
    });
    input.addEventListener('cancel', () => append(kind, 'cancelled'));
    input.click();
  }
  on('btn-file', () => choose('file', false, '.json'));
  on('btn-files', () => choose('files', true));

  // The File System Access pickers. Not every browser or world has
  // them, and a cancel rejects with an AbortError. Each is called as a
  // method of `window`, as a script would.
  const PICKERS = {
    'open-picker': ['showOpenFilePicker', async () => {
      const handles = await window.showOpenFilePicker();
      return [String(handles.length), handles.map((h) => h.name).join(', ')];
    }],
    'save-picker': ['showSaveFilePicker', async () => {
      const handle = await window.showSaveFilePicker({ suggestedName: 'dialogs-example.txt' });
      const writable = await handle.createWritable();
      await writable.write('Saved by the dialogs example\n');
      await writable.close();
      return ['saved', handle.name];
    }],
    'directory-picker': ['showDirectoryPicker', async () => {
      const dir = await window.showDirectoryPicker();
      const names = [];
      for await (const name of dir.keys()) names.push(name);
      return [String(names.length), `${dir.name}: ${names.join(', ')}`];
    }],
  };
  for (const [kind, [name, call]] of Object.entries(PICKERS)) {
    on(`btn-${kind}`, async () => {
      if (typeof window[name] !== 'function') {
        append(kind, 'missing', `${name} isn't available here`);
        return;
      }
      try {
        const [result, text] = await call();
        append(kind, result, text);
      } catch (err) {
        append(kind, err.name === 'AbortError' ? 'cancelled' : 'error', `${err.name}: ${err.message}`);
      }
    });
  }

  on('btn-connect', () => {
    append('connect', 'sent', 'GET https://example.com/');
    GM_xmlhttpRequest({
      method: 'GET',
      url: 'https://example.com/',
      onload: (res) => append('connect', 'onload', `HTTP ${res.status}`),
      onerror: (e) => append('connect', 'onerror', (e && e.error) || 'Failed'),
    });
  });

  on('btn-clear', () => { log.textContent = ''; });

  status.classList.add('ran');
  status.textContent = 'Userscript ran. Click a button to open a dialog box.';
})();
