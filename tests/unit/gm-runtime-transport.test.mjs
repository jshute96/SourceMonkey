// Unit tests for how src/wrapper-gm-runtime.js picks its transport.
//
// The runtime is one file registered in both worlds. In USER_SCRIPT
// world it talks to the service worker over chrome.runtime.sendMessage;
// in MAIN world, where there is no chrome.runtime, over the postMessage
// bridge. The test that tells the two apart has to be `chrome.runtime.id`
// — a web page listed in some other extension's `externally_connectable`
// has `chrome.runtime.sendMessage` in MAIN world too, and taking that
// for our channel would fail every GM_* call on that page.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WRAPPER_GM_RUNTIME } from '../../dist/generated-wrappers.js';

function loadRuntime(chrome) {
  const posted = [];
  const window = Object.create(globalThis);
  window.addEventListener = () => {};
  window.postMessage = (msg) => { posted.push(msg); };
  const document = { visibilityState: 'visible', addEventListener: () => {} };
  new Function('window', 'document', 'chrome', WRAPPER_GM_RUNTIME)(window, document, chrome);
  return { api: window.__SM_GM__, posted };
}

test('an extension context (chrome.runtime.id present) takes the direct channel', async () => {
  const sent = [];
  const chrome = { runtime: {
    id: 'abcdefghijklmnopabcdefghijklmnop',
    sendMessage: (msg) => { sent.push(msg); return Promise.resolve({ ok: true }); },
    onMessage: { addListener: () => {} },
  } };
  const { api, posted } = loadRuntime(chrome);
  await api.sendAsync({ type: 'sm:gm-log', scriptId: 's', message: 'x' });
  assert.equal(sent.length, 1);
  assert.equal(posted.length, 0);
});

test('a page with another extension\'s externally_connectable chrome.runtime takes the bridge', () => {
  // sendMessage exists, id does not — exactly what such a page sees.
  const chrome = { runtime: {
    sendMessage: () => { throw new Error('chrome.runtime.sendMessage() must specify an Extension ID'); },
  } };
  const { api, posted } = loadRuntime(chrome);
  const p = api.sendAsync({ type: 'sm:gm-log', scriptId: 's', message: 'x' });
  p.catch(() => {});
  assert.equal(posted.length, 1, 'the request went to the bridge');
  assert.equal(posted[0].__sm, 'sourcemonkey-bridge');
  assert.equal(posted[0].payload.type, 'sm:gm-log');
});

test('no chrome at all takes the bridge', () => {
  const { api, posted } = loadRuntime(undefined);
  api.sendAsync({ type: 'sm:gm-log', scriptId: 's', message: 'x' }).catch(() => {});
  assert.equal(posted.length, 1);
});
