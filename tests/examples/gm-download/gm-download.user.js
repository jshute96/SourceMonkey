// ==UserScript==
// @name        SourceMonkey example: GM_download
// @namespace   https://github.com/jshute96/SourceMonkey
// @version     1.0.0
// @description Click buttons to download files with various GM_download call shapes.
// @match       *://*/gm-download/gm-download.html
// @match       file:///*/gm-download/gm-download.html
// @run-at      document-end
// @grant       GM_download
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

  // Call GM_download and route every callback into the log. Returns
  // the control object so a caller can abort it.
  //
  // Managers differ in what they hand back (a control object, or
  // nothing at all), so the return is treated as optional.
  function download(label, details, expectation) {
    append(`-> ${label}`);
    // Log the callback AND still run whatever the caller passed —
    // `btn-blob` relies on its own onload to revoke the object URL.
    const also = (name) => (arg) => {
      if (typeof details[name] === 'function') details[name](arg);
    };
    const withLogging = Object.assign({}, details, {
      onload: (r) => { append(`   onload ${describe(r)}  -- ${expectation}`); also('onload')(r); },
      onerror: (e) => { append(`   onerror ${describe(e)}  -- ${expectation}`); also('onerror')(e); },
      ontimeout: (t) => { append(`   ontimeout  -- ${expectation}`); also('ontimeout')(t); },
      onprogress: (p) => {
        if (p && p.lengthComputable) append(`   onprogress ${p.loaded}/${p.total}`);
        also('onprogress')(p);
      },
    });
    try {
      return GM_download(withLogging);
    } catch (e) {
      append(`   threw: ${(e && e.message) || e}  -- ${expectation}`);
      return null;
    }
  }

  // Flatten whatever the manager passed to a callback into one line.
  function describe(value) {
    if (!value || typeof value !== 'object') return String(value ?? '');
    const parts = [];
    if (value.error) parts.push(`error=${value.error}`);
    if (value.details && value.details.current) parts.push(`current=${value.details.current}`);
    if (value.details && value.details.message) parts.push(`message=${value.details.message}`);
    if (value.filename) parts.push(`filename=${value.filename}`);
    return parts.length ? parts.join(' ') : '(no details)';
  }

  document.getElementById('btn-file').addEventListener('click', () => {
    download('details {url: sample.txt, name}', {
      url: new URL('sample.txt', location.href).href,
      name: 'sourcemonkey-example.txt',
    }, 'saves sample.txt to your downloads folder');
  });

  document.getElementById('btn-positional').addEventListener('click', () => {
    // The two-argument shorthand has no callbacks to log, so the only
    // observable outcome is the file (and whatever the manager's own
    // download UI shows).
    append('-> positional (url, name)');
    try {
      GM_download(new URL('sample.txt', location.href).href, 'sourcemonkey-positional.txt');
      append('   returned  -- saves sourcemonkey-positional.txt');
    } catch (e) {
      append(`   threw: ${(e && e.message) || e}`);
    }
  });

  document.getElementById('btn-data').addEventListener('click', () => {
    download('details {url: data:...}', {
      url: 'data:text/plain;charset=utf-8,Hello%20from%20a%20data%20URL',
      name: 'sourcemonkey-data.txt',
    }, 'saves a file built from a data: URL');
  });

  document.getElementById('btn-blob').addEventListener('click', () => {
    // The shape media-downloader scripts use: build the bytes in the
    // page, then hand GM_download the blob URL.
    const blob = new Blob(['Hello from a blob URL\n'], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    download('details {url: blob:...}', {
      url,
      name: 'sourcemonkey-blob.txt',
      onload: () => URL.revokeObjectURL(url),
    }, 'saves a file built from a blob: URL');
  });

  document.getElementById('btn-abort').addEventListener('click', () => {
    const control = download('details {...} then abort()', {
      url: new URL('sample.txt', location.href).href,
      name: 'sourcemonkey-aborted.txt',
    }, 'aborted immediately — expect an error/abort callback, or nothing');
    if (control && typeof control.abort === 'function') {
      control.abort();
      append('   abort() called');
    } else {
      append('   no control object returned — nothing to abort');
    }
  });

  document.getElementById('btn-scheme').addEventListener('click', () => {
    download('details {url: file:///etc/hostname}', {
      url: 'file:///etc/hostname',
      name: 'sourcemonkey-refused.txt',
    }, 'expected to be refused');
  });

  document.getElementById('btn-traversal').addEventListener('click', () => {
    download('details {name: "../escaped.txt"}', {
      url: new URL('sample.txt', location.href).href,
      name: '../sourcemonkey-escaped.txt',
    }, 'expected to be refused');
  });

  document.getElementById('btn-clear').addEventListener('click', () => {
    log.innerHTML = '';
  });

  status.classList.add('ran');
  status.textContent = 'Userscript ran. Click a button to download something.';
})();
