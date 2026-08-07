// ==UserScript==
// @name        SourceMonkey example: GM_download
// @namespace   https://github.com/jshute96/SourceMonkey
// @version     1.1.0
// @description Explore GM_download: preset calls, an editable argument form, and a log of every call.
// @match       *://*/gm-download/gm-download.html
// @match       file:///*/gm-download/gm-download.html
// @run-at      document-end
// @grant       GM_download
// @connect     www.gnu.org
// @require     ./api-explorer.js
// ==/UserScript==

// The @connect line covers the cross-origin http:// button. Managers
// that gate GM_download on @connect (Tampermonkey does) need the host
// declared; SourceMonkey's download path doesn't consult @connect, so
// it's there for cross-manager parity.
//
// The @require is a relative path — a SourceMonkey extension, so this
// example is SM-only. See tests/examples/README.md.

(function () {
  'use strict';

  const status = document.getElementById('runStatus');
  if (!status) return;

  // An absolute cross-origin URL, shared by every http(s) preset except
  // `relative`. Being absolute is the point: those presets then behave
  // the same however this page was opened, leaving `relative` as the
  // only one that inherits the page's scheme.
  const REMOTE_URL = 'https://www.gnu.org/licenses/gpl-3.0.txt';
  // Same host (so `@connect` still covers it), no such file.
  const REMOTE_404_URL = 'https://www.gnu.org/licenses/sourcemonkey-no-such-file.txt';

  // The `relative` preset resolves its URL against this page, so opened
  // from disk it becomes a file:// URL — which SourceMonkey refuses.
  // Say that up front instead of promising a download that can't happen.
  const localPage = location.protocol === 'file:';

  // Placeholder the blob preset carries in its `args`, swapped for a
  // real object URL by `prepare` at click time. It has to be visible in
  // the button's hover text as *something*, and a URL minted now would
  // be stale (and leaked) by the time anyone clicked.
  const BLOB_PLACEHOLDER = 'blob:(minted when you click)';

  // GM_download's return value is a control object, and abort() is the
  // only part of the API that acts on a call already in flight. It gets
  // a button of its own rather than a preset, so it needs the most
  // recent call's control object kept here.
  let lastControl = null;

  ApiExplorer.create({
    mount: '#explorer',
    examples: '#examples',
    log: '#log',
    boxes: [{
      id: 'download',
      signature: 'GM_download(details)',
      fnName: 'GM_download',
      // The interesting part of the return value is whether there's an
      // abort() on it, which `call` reports itself.
      logReturn: false,
      fields: [
        { name: 'url', kind: 'string', required: true,
          placeholder: 'https://example.com/file.txt' },
        { name: 'name', kind: 'string', label: 'name (saved filename)',
          placeholder: 'my-file.txt',
          hint: 'Optional in SourceMonkey; may contain subdirectories. TM requires it.' },
        { name: 'headers', kind: 'json', rows: 2,
          placeholder: '{"Referer": "https://example.com/"}',
          hint: 'http(s) only — ignored on the blob:/data: path.' },
        { name: 'timeout', kind: 'number', placeholder: '5000', hint: 'milliseconds' },
        { name: 'saveAs', kind: 'bool', label: 'saveAs (show the file dialog)' },
      ],

      // The blob preset needs bytes minted at click time. Returning the
      // rewritten args means the log and the form both show the URL the
      // call actually used, not the placeholder.
      prepare(args) {
        if (args.url !== BLOB_PLACEHOLDER) return args;
        const blob = new Blob(['Hello from a blob URL\n'], { type: 'text/plain' });
        args.url = URL.createObjectURL(blob);
        return args;
      },

      // The one place this example touches GM. Everything above is the
      // form; everything below is the API.
      call(args, ctx) {
        const details = Object.assign({}, args, {
          onload: (r) => ctx.report(`onload ${apiExplorerDescribe(r)}`),
          onerror: (e) => ctx.report(`onerror ${apiExplorerDescribe(e)}`, 'error'),
          ontimeout: () => ctx.report('ontimeout', 'error'),
          onabort: () => ctx.report('onabort'),
          onprogress: (p) => {
            // Log every tick, not just the ones with a total. A server
            // that doesn't send Content-Length (or compresses the body)
            // leaves lengthComputable false, and dropping those events
            // is what makes a slow download look like nothing happening.
            if (!p) return;
            if (p.lengthComputable && p.total) {
              ctx.report(`onprogress ${p.loaded}/${p.total} (${Math.floor((p.loaded / p.total) * 100)}%)`);
            } else {
              ctx.report(`onprogress ${p.loaded ?? 0} bytes (total unknown)`);
            }
          },
        });
        // A blob: URL is only good for one download; release it once the
        // browser has taken the click. `url` may be missing entirely —
        // the form doesn't police it, and GM_download's own refusal is
        // what should show up in the log.
        if (typeof args.url === 'string' && args.url.startsWith('blob:')) {
          const url = args.url;
          const onload = details.onload;
          details.onload = (r) => { onload(r); URL.revokeObjectURL(url); };
        }
        lastControl = null;
        const control = GM_download(details);
        // Managers differ in what they hand back — a control object, or
        // nothing at all — so the abort affordance is conditional.
        if (control && typeof control.abort === 'function') {
          lastControl = control;
          ctx.report('returned a control object — the abort() button cancels it');
        }
        return undefined;
      },

      presets: [
        { id: 'file', label: 'relative filename',
          args: { url: new URL('sample.txt', location.href).href, name: 'sourcemonkey-example.txt' },
          note: localPage
            ? 'refused — this page was opened from file://; serve it over http(s) to see it succeed'
            : 'saves sample.txt to your downloads folder' },
        { id: 'http', label: 'absolute http(s) URL',
          args: { url: REMOTE_URL, name: 'sourcemonkey-http.txt' },
          note: 'saves a cross-origin http(s) file to your downloads folder' },
        // A URL that resolves and connects but has nothing behind it.
        // The scheme and name both pass validation, so this is the one
        // preset whose failure comes from the transfer itself rather
        // than from a check made before starting.
        { id: '404', label: '404 — fails',
          args: { url: REMOTE_404_URL, name: 'sourcemonkey-404.txt' },
          note: 'fails — the server has no such file' },
        { id: 'data', label: 'data: URL',
          args: { url: 'data:text/plain;charset=utf-8,Hello%20from%20a%20data%20URL',
            name: 'sourcemonkey-data.txt' },
          note: 'saves a file built from a data: URL' },
        // The shape media-downloader scripts use: build the bytes in the
        // page, then hand GM_download the blob URL.
        { id: 'blob', label: 'blob: URL',
          args: { url: BLOB_PLACEHOLDER, name: 'sourcemonkey-blob.txt' },
          note: 'saves a file built from a blob: URL minted in the page' },
        { id: 'saveas', label: 'saveAs dialog',
          args: { url: REMOTE_URL, name: 'sourcemonkey-saveas.txt', saveAs: true },
          note: 'prompts for a location instead of saving straight to the downloads folder' },
        { id: 'scheme', label: 'file:// URL — refused',
          args: { url: 'file:///etc/hostname', name: 'sourcemonkey-refused.txt' },
          note: 'refused — a userscript should not be able to pull local files onto disk' },
        // Absolute URL on purpose: the scheme is checked before the
        // name, so a relative (file:// on a local page) URL would make
        // this report the scheme refusal instead of the traversal one.
        { id: 'traversal', label: '../ name — refused',
          args: { url: REMOTE_URL, name: '../sourcemonkey-escaped.txt' },
          note: 'refused for trying to escape the download directory' },
      ],
    }],
  });

  const explorerLog = document.getElementById('log');
  const abortBtn = document.getElementById('btn-abort');
  if (abortBtn) {
    abortBtn.addEventListener('click', () => {
      const li = document.createElement('li');
      li.className = 'explorer-entry';
      li.textContent = lastControl
        ? '→ abort() on the most recent download'
        : '→ abort(): no control object from the last call — nothing to abort';
      explorerLog.prepend(li);
      if (lastControl) lastControl.abort();
    });
  }

  // The two-argument shorthand takes no callbacks, so it can't be a
  // preset of the details form — it's a different call shape, and the
  // point is that managers accept it at all.
  const positionalBtn = document.getElementById('btn-positional');
  if (positionalBtn) {
    positionalBtn.addEventListener('click', () => {
      const li = document.createElement('li');
      li.className = 'explorer-entry';
      try {
        GM_download(REMOTE_URL, 'sourcemonkey-positional.txt');
        li.textContent = `→ GM_download(${JSON.stringify(REMOTE_URL)}, "sourcemonkey-positional.txt") — returned`;
      } catch (e) {
        li.dataset.level = 'error';
        li.textContent = `→ GM_download(url, name) threw: ${(e && e.message) || e}`;
      }
      explorerLog.prepend(li);
    });
  }

  status.classList.add('ran');
  status.textContent = localPage
    ? 'Userscript ran. This page was opened from file://, so the "relative filename" preset resolves sample.txt to a file:// URL and will be refused — serve the page over http(s) for that one. Every other preset uses an absolute URL and works either way.'
    : 'Userscript ran. Click a preset, or fill in the form and submit.';
})();
