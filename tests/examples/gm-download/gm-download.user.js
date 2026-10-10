// ==UserScript==
// @name        SourceMonkey example: gm-download: GM_download
// @namespace   https://github.com/jshute96/SourceMonkey
// @version     1.0.4
// @description Click buttons to download files with various GM_download call shapes.
// @match       *://*/gm-download/gm-download.html
// @match       file:///*/gm-download/gm-download.html
// @run-at      document-end
// @grant       GM_download
// @connect     www.gnu.org
// ==/UserScript==

// The @connect line covers the cross-origin http:// button. Managers
// that gate GM_download on @connect (Tampermonkey does) need the host
// declared; SourceMonkey's download path doesn't consult @connect, so
// it's there for cross-manager parity.

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
        // Log every tick, not just the ones with a total. A server
        // that doesn't send Content-Length (or compresses the body)
        // leaves lengthComputable false, and dropping those events is
        // what makes a multi-second download look like nothing is
        // happening.
        if (p && p.lengthComputable) {
          const pct = p.total ? ` (${Math.floor((p.loaded / p.total) * 100)}%)` : '';
          append(`   onprogress ${p.loaded}/${p.total}${pct}`);
        } else if (p) {
          append(`   onprogress ${p.loaded ?? 0} bytes (total unknown)`);
        }
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

  // An absolute cross-origin URL, shared by every http(s) button
  // except `btn-file`. Being absolute is the point: those buttons then
  // behave the same however this page was opened, leaving `btn-file`
  // as the only one that inherits the page's scheme. How many
  // onprogress ticks it produces depends on the link — SourceMonkey
  // polls every ~500ms, so a fast connection finishes this file inside
  // the first poll and logs none.
  const REMOTE_URL = 'https://www.gnu.org/licenses/gpl-3.0.txt';
  // Same host (so `@connect` still covers it), no such file.
  const REMOTE_404_URL = 'https://www.gnu.org/licenses/sourcemonkey-no-such-file.txt';

  // `btn-file` resolves its URL against this page, so opened from disk
  // it becomes a file:// URL — which SourceMonkey refuses. Say that up
  // front instead of promising a download that can't happen.
  const localPage = location.protocol === 'file:';

  document.getElementById('btn-file').addEventListener('click', () => {
    download('details {url: sample.txt, name}', {
      url: new URL('sample.txt', location.href).href,
      name: 'sourcemonkey-example.txt',
    }, localPage
      ? 'expected to be refused — this page was opened from file://; serve it over http(s) to see it succeed'
      : 'saves sample.txt to your downloads folder');
  });

  document.getElementById('btn-http').addEventListener('click', () => {
    download('details {url: https://www.gnu.org/…}', {
      url: REMOTE_URL,
      name: 'sourcemonkey-http.txt',
    }, 'saves a cross-origin http(s) file to your downloads folder');
  });

  // A URL that resolves and connects but has nothing behind it. The
  // scheme and name both pass validation, so this is the one button
  // whose failure comes from the transfer itself rather than from a
  // check we made before starting.
  document.getElementById('btn-404').addEventListener('click', () => {
    download('details {url: …/sourcemonkey-no-such-file.txt}', {
      url: REMOTE_404_URL,
      name: 'sourcemonkey-404.txt',
    }, 'expected to fail — the server has no such file');
  });

  document.getElementById('btn-positional').addEventListener('click', () => {
    // The two-argument shorthand has no callbacks to log, so the only
    // observable outcome is the file (and whatever the manager's own
    // download UI shows).
    append('-> positional (url, name)');
    try {
      GM_download(REMOTE_URL, 'sourcemonkey-positional.txt');
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
      url: REMOTE_URL,
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
    // Absolute URL on purpose: the scheme is checked before the name,
    // so a relative (file:// on a local page) URL would make this
    // report the scheme refusal instead of the traversal one.
    download('details {name: "../escaped.txt"}', {
      url: REMOTE_URL,
      name: '../sourcemonkey-escaped.txt',
    }, 'expected to be refused');
  });

  document.getElementById('btn-clear').addEventListener('click', () => {
    log.innerHTML = '';
  });

  status.classList.add('ran');
  status.textContent = localPage
    ? 'Userscript ran. This page was opened from file://, so the "relative filename" button resolves sample.txt to a file:// URL and will be refused — serve the page over http(s) for that one. All other buttons use absolute URLs and work either way.'
    : 'Userscript ran. Click a button to download something.';
})();
