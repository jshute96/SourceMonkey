// Unit tests for how src/wrapper-gm-runtime.js picks its transport.
//
// The runtime is one file registered in both worlds. In USER_SCRIPT
// world it talks to the service worker over chrome.runtime.sendMessage;
// in MAIN world, where there is no chrome.runtime, over the DOM-event
// bridge. The test that tells the two apart has to be `chrome.runtime.id`
// — a web page listed in some other extension's `externally_connectable`
// has `chrome.runtime.sendMessage` in MAIN world too, and taking that
// for our channel would fail every GM_* call on that page.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WRAPPER_GM_RUNTIME } from '../../dist/generated-wrappers.js';

function loadRuntime(chrome) {
  // The bridge leg is a CustomEvent on `document`, so that is what a
  // MAIN-world request shows up as here.
  const posted = [];
  const dispatched = [];
  const window = Object.create(globalThis);
  window.addEventListener = () => {};
  window.postMessage = (msg) => { posted.push(msg); };
  const document = {
    visibilityState: 'visible',
    addEventListener: () => {},
    dispatchEvent: (ev) => { dispatched.push(ev); return true; },
  };
  new Function('window', 'document', 'chrome', WRAPPER_GM_RUNTIME)(window, document, chrome);
  // `detail` is a JSON string because event details don't cross realms.
  const requests = () => dispatched
    .filter((ev) => ev.type === 'sourcemonkey-bridge-sync')
    .map((ev) => JSON.parse(ev.detail));
  return { api: window.__SM_GM__, posted, dispatched, requests };
}

test('an extension context (chrome.runtime.id present) takes the direct channel', async () => {
  const sent = [];
  const chrome = { runtime: {
    id: 'abcdefghijklmnopabcdefghijklmnop',
    sendMessage: (msg) => { sent.push(msg); return Promise.resolve({ ok: true }); },
    onMessage: { addListener: () => {} },
  } };
  const { api, posted, dispatched } = loadRuntime(chrome);
  await api.sendAsync({ type: 'sm:gm-log', scriptId: 's', message: 'x' });
  assert.equal(sent.length, 1);
  assert.equal(posted.length, 0);
  assert.equal(dispatched.length, 0);
});

test('a page with another extension\'s externally_connectable chrome.runtime takes the bridge', () => {
  // sendMessage exists, id does not — exactly what such a page sees.
  const chrome = { runtime: {
    sendMessage: () => { throw new Error('chrome.runtime.sendMessage() must specify an Extension ID'); },
  } };
  const { api, requests } = loadRuntime(chrome);
  const p = api.sendAsync({ type: 'sm:gm-log', scriptId: 's', message: 'x' });
  p.catch(() => {});
  const reqs = requests();
  assert.equal(reqs.length, 1, 'the request went to the bridge');
  assert.equal(reqs[0].payload.type, 'sm:gm-log');
  // A requestId is what tells the bridge to send a reply back.
  assert.equal(typeof reqs[0].requestId, 'string');
});

test('no chrome at all takes the bridge', () => {
  const { api, requests } = loadRuntime(undefined);
  api.sendAsync({ type: 'sm:gm-log', scriptId: 's', message: 'x' }).catch(() => {});
  assert.equal(requests().length, 1);
});

test('a reply delivered inside the dispatch still resolves the caller', async () => {
  // The bridge's listener runs INSIDE our dispatch, so the earliest a
  // reply can come back is immediately. `bridgeSend` therefore records
  // its pending entry before dispatching; swap those two statements and
  // the reply lands on an empty table and this hangs.
  const window = Object.create(globalThis);
  let onMessage = null;
  window.addEventListener = (type, fn) => { if (type === 'message') onMessage = fn; };
  window.postMessage = () => {};
  const document = {
    visibilityState: 'visible',
    addEventListener: () => {},
    dispatchEvent: (ev) => {
      const env = JSON.parse(ev.detail);
      onMessage({
        source: window,
        data: {
          __sm: 'sourcemonkey-bridge-reply',
          requestId: env.requestId,
          reply: { ok: true, echoed: env.payload.type },
        },
      });
      // The bridge cancels what it takes, as a receipt.
      return false;
    },
  };
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', 'chrome', WRAPPER_GM_RUNTIME)(window, document, undefined);
  const reply = await window.__SM_GM__.sendAsync({ type: 'sm:gm-log', scriptId: 's', message: 'x' });
  assert.deepEqual(reply, { ok: true, echoed: 'sm:gm-log' });
});

test('a bridge request rejects when the DOM-event path is unusable', async () => {
  // No dispatchEvent to capture at init: every GM_* call has to reject
  // rather than park a Promise for the full 30s bridge timeout.
  const window = Object.create(globalThis);
  window.addEventListener = () => {};
  window.postMessage = () => {};
  const document = { visibilityState: 'visible', addEventListener: () => {} };
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', 'chrome', WRAPPER_GM_RUNTIME)(window, document, undefined);
  await assert.rejects(
    window.__SM_GM__.sendAsync({ type: 'sm:gm-log', scriptId: 's', message: 'x' }),
    /GM bridge unavailable/,
  );
});

test('a request sent before the bridge is in goes out when it announces itself', async () => {
  // The bridge is its own registration and can come after the runtime.
  // An event nobody cancels is one no bridge took; the runtime holds it
  // and sends it again on the bridge's ready event. A ready event with
  // still no bridge (the page can fire one) keeps it held.
  const window = Object.create(globalThis);
  let onMessage = null;
  let onReady = null;
  window.addEventListener = (type, fn) => {
    if (type === 'message') onMessage = fn;
    if (type === 'sourcemonkey-bridge-ready') onReady = fn;
  };
  window.postMessage = () => {};
  let bridgeIn = false;
  const taken = [];
  const document = {
    visibilityState: 'visible',
    addEventListener: () => {},
    dispatchEvent: (ev) => {
      assert.equal(ev.cancelable, true);
      if (!bridgeIn) return true;
      const env = JSON.parse(ev.detail);
      taken.push(env.payload.type);
      if (env.requestId) {
        onMessage({
          source: window,
          data: { __sm: 'sourcemonkey-bridge-reply', requestId: env.requestId, reply: { ok: true } },
        });
      }
      return false;
    },
  };
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', 'chrome', WRAPPER_GM_RUNTIME)(window, document, undefined);
  let settled = false;
  const reply = window.__SM_GM__.sendAsync({ type: 'sm:gm-menu-register', scriptId: 's' })
    .then((r) => { settled = true; return r; });
  const second = window.__SM_GM__.sendAsync({ type: 'sm:gm-xhr-start', scriptId: 's' });
  assert.equal(typeof onReady, 'function', 'listening for the bridge');

  onReady();
  await Promise.resolve();
  assert.equal(settled, false);
  assert.deepEqual(taken, []);

  bridgeIn = true;
  onReady();
  assert.deepEqual(await reply, { ok: true });
  assert.deepEqual(await second, { ok: true });
  assert.deepEqual(taken, ['sm:gm-menu-register', 'sm:gm-xhr-start']);
  // Sent once: a later ready event finds nothing held.
  onReady();
  assert.equal(taken.length, 2);
});

test('a request that timed out before the bridge came is not sent', async () => {
  // Its caller has already been rejected; sending it now would start
  // an XHR or register a menu command nobody is waiting on.
  const window = Object.create(globalThis);
  let onReady = null;
  window.addEventListener = (type, fn) => { if (type === 'sourcemonkey-bridge-ready') onReady = fn; };
  window.postMessage = () => {};
  let bridgeIn = false;
  const taken = [];
  const document = {
    visibilityState: 'visible',
    addEventListener: () => {},
    dispatchEvent: (ev) => {
      if (!bridgeIn) return true;
      taken.push(JSON.parse(ev.detail).payload.type);
      return false;
    },
  };
  // The bridge timeout, held for the test to fire.
  const timers = [];
  const setTimeoutStub = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', 'chrome', 'setTimeout', 'clearTimeout', WRAPPER_GM_RUNTIME)(
    window, document, undefined, setTimeoutStub, () => {});
  const call = window.__SM_GM__.sendAsync({ type: 'sm:gm-xhr-start', scriptId: 's' });
  timers.find((t) => t.ms === 30000).fn();
  await assert.rejects(call, /GM bridge timed out/);

  bridgeIn = true;
  onReady();
  assert.deepEqual(taken, []);
});
