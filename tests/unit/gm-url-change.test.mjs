// Unit tests for the SW-side `window.onurlchange` driver.
//
// The module calls chrome.tabs.sendMessage; we stub it at the top so
// import gets a working chrome global and every send is recorded.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

const sent = [];
let sendShouldReject = false;

const subscribed = { history: [], fragment: [] };

globalThis.chrome = {
  tabs: {
    sendMessage: (tabId, message, options) => {
      sent.push({ tabId, message, options });
      return sendShouldReject
        ? Promise.reject(new Error('Could not establish connection'))
        : Promise.resolve(undefined);
    },
  },
  webNavigation: {
    onHistoryStateUpdated: { addListener: (fn) => subscribed.history.push(fn) },
    onReferenceFragmentUpdated: { addListener: (fn) => subscribed.fragment.push(fn) },
  },
};

const { SM_URL_CHANGE_MSG, shouldNotifyUrlChange, notifyUrlChange, installUrlChangeWatch } =
  await import('../../dist/gm-url-change.js');

test('shouldNotifyUrlChange accepts a normal main-frame history update', () => {
  assert.equal(
    shouldNotifyUrlChange({ tabId: 7, frameId: 0, url: 'https://example.com/a' }),
    true,
  );
});

test('shouldNotifyUrlChange accepts sub-frames (targeting keeps them off the top frame)', () => {
  assert.equal(
    shouldNotifyUrlChange({ tabId: 7, frameId: 3, url: 'https://example.com/a' }),
    true,
  );
});

test('shouldNotifyUrlChange accepts file:// URLs (we inject there)', () => {
  assert.equal(
    shouldNotifyUrlChange({ tabId: 7, frameId: 0, url: 'file:///tmp/spa.html#x' }),
    true,
  );
});

test('shouldNotifyUrlChange rejects untargetable tabs and empty URLs', () => {
  // Pre-render / devtools targets report a negative tabId that
  // chrome.tabs.sendMessage cannot address.
  assert.equal(shouldNotifyUrlChange({ tabId: -1, frameId: 0, url: 'https://x/' }), false);
  assert.equal(shouldNotifyUrlChange({ tabId: 7, frameId: -1, url: 'https://x/' }), false);
  assert.equal(shouldNotifyUrlChange({ tabId: 7, frameId: 0, url: '' }), false);
});

test('notifyUrlChange sends sm:url-change to the exact frame that changed', () => {
  sent.length = 0;
  notifyUrlChange({ tabId: 42, frameId: 5, url: 'https://example.com/next' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].tabId, 42);
  assert.deepEqual(sent[0].options, { frameId: 5 });
  assert.deepEqual(sent[0].message, {
    type: SM_URL_CHANGE_MSG,
    url: 'https://example.com/next',
  });
  assert.equal(SM_URL_CHANGE_MSG, 'sm:url-change');
});

test('notifyUrlChange sends nothing for details it would reject', () => {
  sent.length = 0;
  notifyUrlChange({ tabId: -1, frameId: 0, url: 'https://example.com/' });
  assert.deepEqual(sent, []);
});

test('notifyUrlChange does not de-duplicate repeated URLs (matches TM)', () => {
  // TM fires on every reported history update, including a
  // replaceState back to the URL the document is already on. We do the
  // same, so a script written against TM sees the same event stream.
  sent.length = 0;
  const same = { tabId: 3, frameId: 0, url: 'https://example.com/same' };
  notifyUrlChange(same);
  notifyUrlChange(same);
  assert.equal(sent.length, 2);
});

test('installUrlChangeWatch subscribes to BOTH same-document nav events', () => {
  // Fragment-only changes only surface on onReferenceFragmentUpdated;
  // pushState/replaceState only on onHistoryStateUpdated. Missing
  // either one silently loses a whole class of SPA navigation.
  subscribed.history.length = 0;
  subscribed.fragment.length = 0;
  installUrlChangeWatch();
  assert.equal(subscribed.history.length, 1);
  assert.equal(subscribed.fragment.length, 1);

  // Each subscription forwards to the frame that changed.
  sent.length = 0;
  subscribed.fragment[0]({ tabId: 9, frameId: 2, url: 'https://example.com/p#frag' });
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].options, { frameId: 2 });
  assert.equal(sent[0].message.url, 'https://example.com/p#frag');
});

test('notifyUrlChange swallows the "no receiving end" rejection', async () => {
  // Pages with no active SourceMonkey script have no __SM_GM__ runtime
  // registered, so the send legitimately rejects. It must not surface
  // as an unhandled rejection in the service worker.
  sent.length = 0;
  sendShouldReject = true;
  notifyUrlChange({ tabId: 1, frameId: 0, url: 'https://example.com/' });
  // Let the rejection settle; an unhandled one would fail the run.
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(sent.length, 1);
  sendShouldReject = false;
});
