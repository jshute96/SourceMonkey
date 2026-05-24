// Unit tests for the SW-side GM_notification dispatcher.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

const created = [];
const cleared = [];
let nextChromeNotifId = 1;
let createShouldFail = null;

globalThis.chrome = {
  notifications: {
    create: (notifId, options, callback) => {
      // The module passes '' as first arg (let Chrome assign).
      if (createShouldFail) {
        const msg = createShouldFail;
        createShouldFail = null;
        setTimeout(() => {
          globalThis.chrome.runtime.lastError = { message: msg };
          callback('');
          globalThis.chrome.runtime.lastError = undefined;
        }, 0);
        return;
      }
      const id = `chrome-notif-${nextChromeNotifId++}`;
      created.push({ id, options });
      setTimeout(() => callback(id), 0);
    },
    clear: (id) => { cleared.push(id); },
  },
  runtime: {
    lastError: undefined,
    getURL: (p) => `chrome-extension://abc/${p}`,
  },
};

const mod = await import('../../dist/gm-notification.js');
const {
  showGmNotification,
  takeForClicked,
  takeForClosed,
  dropOriginator,
} = mod;

function detailsOf(over = {}) {
  return {
    text: 'hi there',
    title: 'Title',
    image: '',
    timeout: 0,
    silent: false,
    tag: '',
    ...over,
  };
}

test('showGmNotification calls chrome.notifications.create and returns its id', async () => {
  created.length = 0;
  const res = await showGmNotification({
    scriptId: 's1',
    requestId: 'r-1',
    details: detailsOf(),
  }, 7);
  assert.equal(res.ok, true);
  assert.match(res.notificationId, /^chrome-notif-/);
  assert.equal(created.length, 1);
  assert.equal(created[0].options.title, 'Title');
  assert.equal(created[0].options.message, 'hi there');
  // Default fallback iconUrl is the extension icon.
  assert.match(created[0].options.iconUrl, /icons\/icon-128/);
});

test('user-supplied image is preferred over the extension icon fallback', async () => {
  created.length = 0;
  await showGmNotification({
    scriptId: 's1', requestId: 'r-2', details: detailsOf({ image: 'https://e.test/i.png' }),
  }, 7);
  assert.equal(created[0].options.iconUrl, 'https://e.test/i.png');
});

test('takeForClicked is non-terminal (entry survives for the closed event too)', async () => {
  const res = await showGmNotification({
    scriptId: 's1', requestId: 'r-3', details: detailsOf(),
  }, 11);
  const click1 = takeForClicked(res.notificationId);
  assert.ok(click1);
  assert.equal(click1.requestId, 'r-3');
  assert.equal(click1.originatorTabId, 11);
  // Click again — entry still present.
  const click2 = takeForClicked(res.notificationId);
  assert.ok(click2);
  // Closed IS terminal — entry gone after.
  const closed = takeForClosed(res.notificationId);
  assert.ok(closed);
  assert.equal(takeForClosed(res.notificationId), null);
  assert.equal(takeForClicked(res.notificationId), null);
});

test('showGmNotification surfaces a chrome.runtime.lastError as ok:false', async () => {
  createShouldFail = 'permission denied';
  const res = await showGmNotification({
    scriptId: 's1', requestId: 'r-fail', details: detailsOf(),
  }, 11);
  assert.equal(res.ok, false);
  assert.match(res.error, /permission denied/);
});

test('default title is applied when caller passes no title', async () => {
  created.length = 0;
  await showGmNotification({
    scriptId: 's1', requestId: 'r-t', details: detailsOf({ title: '' }),
  }, 11);
  assert.equal(created[0].options.title, 'SourceMonkey');
});

test('dropOriginator clears every entry tied to a closing tab', async () => {
  const a = await showGmNotification({ scriptId: 's', requestId: 'd1', details: detailsOf() }, 50);
  const b = await showGmNotification({ scriptId: 's', requestId: 'd2', details: detailsOf() }, 50);
  await showGmNotification({ scriptId: 's', requestId: 'd3', details: detailsOf() }, 60);
  const dropped = dropOriginator(50);
  assert.equal(dropped.length, 2);
  assert.equal(takeForClosed(a.notificationId), null);
  assert.equal(takeForClosed(b.notificationId), null);
});

test('showGmNotification short-circuits when chrome.notifications is undefined', async () => {
  const real = globalThis.chrome.notifications;
  globalThis.chrome.notifications = undefined;
  try {
    const res = await showGmNotification({
      scriptId: 's', requestId: 'r-no-perm', details: detailsOf(),
    }, 7);
    assert.equal(res.ok, false);
    assert.match(res.error, /unavailable/);
  } finally {
    globalThis.chrome.notifications = real;
  }
});

test('timeout schedules an auto-clear', async () => {
  cleared.length = 0;
  const res = await showGmNotification({
    scriptId: 's1', requestId: 'r-to', details: detailsOf({ timeout: 5 }),
  }, 11);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(cleared, [res.notificationId]);
});
