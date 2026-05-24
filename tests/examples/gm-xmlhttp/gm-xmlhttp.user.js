// ==UserScript==
// @name        SourceMonkey example: GM_xmlhttpRequest
// @namespace   sourcemonkey.example
// @version     1.0.0
// @description Issue cross-origin HTTP requests via GM_xmlhttpRequest.
// @match       *://*/gm-xmlhttp/gm-xmlhttp.html
// @match       file:///*/gm-xmlhttp/gm-xmlhttp.html
// @run-at      document-end
// @grant       GM_xmlhttpRequest
// @connect     *
// ==/UserScript==

(function () {
  'use strict';

  const status = document.getElementById('runStatus');
  const out = document.getElementById('output');
  const urlEl = document.getElementById('url');
  const methodEl = document.getElementById('method');
  const responseTypeEl = document.getElementById('responseType');
  const dataEl = document.getElementById('data');
  if (!status || !out || !urlEl || !methodEl || !responseTypeEl || !dataEl) return;

  let inflight = null;

  function describe(label, payload) {
    const lines = [`[${new Date().toLocaleTimeString()}] ${label}`];
    for (const [k, v] of Object.entries(payload)) {
      const display = typeof v === 'string' ? v : JSON.stringify(v);
      lines.push(`  ${k}: ${display}`);
    }
    out.textContent = lines.join('\n');
  }

  document.getElementById('btn-send').addEventListener('click', () => {
    const url = urlEl.value;
    if (!url) { describe('error', { message: 'url is required' }); return; }
    const method = methodEl.value;
    const responseType = responseTypeEl.value;
    const data = dataEl.value || undefined;

    describe('-> sending', { method, url, responseType, data: data ?? '(none)' });

    const details = {
      method, url, responseType,
      data,
      onload(res) {
        describe('onload', {
          status: res.status,
          statusText: res.statusText,
          finalUrl: res.finalUrl,
          responseType: typeof res.response,
          responseLength:
            typeof res.response === 'string' ? res.response.length
            : (res.response && res.response.byteLength) ?? '(n/a)',
          responseText:
            typeof res.responseText === 'string'
              ? res.responseText.slice(0, 200) + (res.responseText.length > 200 ? '...' : '')
              : '(no text)',
        });
        inflight = null;
      },
      onerror(e) {
        describe('onerror', { error: (e && e.error) || String(e) });
        inflight = null;
      },
      ontimeout() {
        describe('ontimeout', { message: 'request exceeded timeout' });
        inflight = null;
      },
      onabort() {
        describe('onabort', { message: 'request aborted' });
        inflight = null;
      },
    };

    try {
      inflight = GM_xmlhttpRequest(details);
    } catch (e) {
      describe('threw', { error: (e && e.message) || String(e) });
    }
  });

  document.getElementById('btn-abort').addEventListener('click', () => {
    if (!inflight) {
      describe('abort', { message: 'no request in flight' });
      return;
    }
    try {
      inflight.abort();
      describe('abort', { message: 'abort() called' });
    } catch (e) {
      describe('abort threw', { error: (e && e.message) || String(e) });
    }
  });

  status.classList.add('ran');
  status.textContent =
    'Userscript ran. Enter a URL and click GM_xmlhttpRequest.';
})();
