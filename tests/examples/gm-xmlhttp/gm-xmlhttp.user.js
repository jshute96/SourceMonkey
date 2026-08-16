// ==UserScript==
// @name        SourceMonkey example: GM_xmlhttpRequest
// @namespace   https://github.com/jshute96/SourceMonkey
// @version     1.0.3
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
  const log = document.getElementById('log');
  const urlEl = document.getElementById('url');
  const methodEl = document.getElementById('method');
  const responseTypeEl = document.getElementById('responseType');
  const dataEl = document.getElementById('data');
  const anonymousEl = document.getElementById('anonymous');
  if (!status || !log || !urlEl || !methodEl || !responseTypeEl || !dataEl || !anonymousEl) return;

  let inflight = null;

  // Body preview length. Long enough to recognize what came back,
  // short enough that the fields printed after it stay on screen.
  const TEXT_PREVIEW_CHARS = 2000;

  // One log entry per event, newest first — the whole point is to be
  // able to compare a run against the ones before it.
  function describe(label, payload) {
    const lines = [`[${new Date().toLocaleTimeString()}] ${label}`];
    for (const [k, v] of Object.entries(payload)) {
      const display = typeof v === 'string' ? v : JSON.stringify(v);
      // Multi-line values (responseHeaders, a long body) get their own
      // indented block so they can't run off the side of one `k: v`
      // line and hide the fields printed after them.
      if (display.includes('\n')) {
        lines.push(`  ${k}:`);
        for (const line of display.split('\n')) lines.push(`    ${line}`);
      } else {
        lines.push(`  ${k}: ${display}`);
      }
    }
    const li = document.createElement('li');
    li.textContent = lines.join('\n');
    log.prepend(li);
  }

  document.getElementById('btn-send').addEventListener('click', () => {
    const url = urlEl.value;
    if (!url) { describe('error', { message: 'url is required' }); return; }
    const method = methodEl.value;
    const responseType = responseTypeEl.value;
    const data = dataEl.value || undefined;
    const anonymous = anonymousEl.checked;

    describe('-> sending', { method, url, responseType, anonymous, data: data ?? '(none)' });

    const details = {
      method, url, responseType,
      anonymous,
      data,
      onload(res) {
        // Every field the managers hand back, so the panel is enough
        // to compare them against each other. responseText is the one
        // thing capped — the rest stay whole.
        describe('onload', {
          status: res.status,
          statusText: res.statusText,
          responseURL: res.responseURL ?? '(not set)',
          finalUrl: res.finalUrl,
          responseType: typeof res.response,
          responseLength:
            typeof res.response === 'string' ? res.response.length
            : (res.response && res.response.byteLength) ?? '(n/a)',
          responseHeaders:
            typeof res.responseHeaders === 'string' && res.responseHeaders
              ? res.responseHeaders.trimEnd()
              : '(none)',
          responseText:
            typeof res.responseText === 'string'
              ? (res.responseText.length > TEXT_PREVIEW_CHARS
                  ? res.responseText.slice(0, TEXT_PREVIEW_CHARS)
                    + `\n[... ${res.responseText.length - TEXT_PREVIEW_CHARS} more characters]`
                  : res.responseText)
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
