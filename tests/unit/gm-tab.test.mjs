// Unit tests for the SW-side GM_openInTab dispatcher.
//
// The module uses chrome.tabs.create / .remove; we stub both at the
// top so import gets a working chrome global.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

const created = [];
const removed = [];
let nextChromeTabId = 100;
let createShouldThrow = null;

globalThis.chrome = {
  tabs: {
    create: async (opts) => {
      if (createShouldThrow) {
        const e = new Error(createShouldThrow);
        createShouldThrow = null;
        throw e;
      }
      const id = nextChromeTabId++;
      created.push({ id, ...opts });
      return { id, url: opts.url, active: opts.active };
    },
    remove: async (id) => {
      removed.push(id);
    },
  },
};

const mod = await import('../../dist/extension/gm-tab.js');
const { openGmTab, closeGmTab, takeRequestForClosedTab, dropOriginator } = mod;

test('openGmTab: forwards url + active to chrome.tabs.create and returns the assigned id', async () => {
  created.length = 0;
  const res = await openGmTab({
    scriptId: 's1',
    requestId: 'r-1',
    url: 'https://example.com/',
    active: true,
    insert: false,
  }, 7);
  assert.equal(res.ok, true);
  assert.equal(typeof res.tabId, 'number');
  assert.equal(created.length, 1);
  assert.equal(created[0].url, 'https://example.com/');
  assert.equal(created[0].active, true);
  // No insert → no openerTabId.
  assert.equal(created[0].openerTabId, undefined);
});

test('openGmTab: insert:true sets openerTabId to bias placement', async () => {
  created.length = 0;
  await openGmTab({
    scriptId: 's1', requestId: 'r-2', url: 'https://x.test/', active: false, insert: true,
  }, 42);
  assert.equal(created[0].openerTabId, 42);
});

test('takeRequestForClosedTab maps a chrome tab id back to its originator', async () => {
  const res = await openGmTab({
    scriptId: 's1', requestId: 'r-3', url: 'https://example.com/', active: true, insert: false,
  }, 11);
  const taken = takeRequestForClosedTab(res.tabId);
  assert.ok(taken);
  assert.equal(taken.originatorTabId, 11);
  assert.equal(taken.requestId, 'r-3');
  // Idempotent: a second take returns null.
  assert.equal(takeRequestForClosedTab(res.tabId), null);
});

test('closeGmTab calls chrome.tabs.remove with the right id', async () => {
  removed.length = 0;
  const res = await openGmTab({
    scriptId: 's1', requestId: 'r-4', url: 'https://example.com/', active: true, insert: false,
  }, 11);
  await closeGmTab('r-4');
  assert.deepEqual(removed, [res.tabId]);
  // In production, chrome.tabs.onRemoved fires and calls
  // takeRequestForClosedTab to clear the entry. Simulate that here,
  // then verify a follow-up close is a no-op.
  takeRequestForClosedTab(res.tabId);
  await closeGmTab('r-4');
  assert.deepEqual(removed, [res.tabId]);
});

test('closeGmTab is a no-op when the request never existed', async () => {
  removed.length = 0;
  await closeGmTab('no-such-request');
  assert.deepEqual(removed, []);
});

test('openGmTab surfaces chrome.tabs.create failures as ok:false', async () => {
  createShouldThrow = 'something exploded';
  const res = await openGmTab({
    scriptId: 's1', requestId: 'r-fail', url: 'https://e.test/', active: true, insert: false,
  }, 11);
  assert.equal(res.ok, false);
  assert.match(res.error, /something exploded/);
});

test('close() called before chrome.tabs.create resolves still closes the opened tab', async () => {
  // Make chrome.tabs.create slow so we can fire close() in between.
  removed.length = 0;
  let resolveCreate;
  const slow = new Promise((r) => { resolveCreate = r; });
  const realCreate = globalThis.chrome.tabs.create;
  globalThis.chrome.tabs.create = async (opts) => {
    await slow;
    return realCreate(opts);
  };
  try {
    const openPromise = openGmTab({
      scriptId: 's', requestId: 'r-race', url: 'https://e.test/', active: true, insert: false,
    }, 11);
    // Fire close() while create is still pending.
    await closeGmTab('r-race');
    // Now let create resolve.
    resolveCreate();
    const res = await openPromise;
    assert.equal(res.ok, true);
    // The created tab should have been removed because of the
    // pending close.
    assert.deepEqual(removed, [res.tabId]);
  } finally {
    globalThis.chrome.tabs.create = realCreate;
  }
});

test('dropOriginator removes every request tied to a closed originator', async () => {
  await openGmTab({ scriptId: 's', requestId: 'd-1', url: 'https://e.test/a', active: true, insert: false }, 99);
  await openGmTab({ scriptId: 's', requestId: 'd-2', url: 'https://e.test/b', active: true, insert: false }, 99);
  await openGmTab({ scriptId: 's', requestId: 'd-3', url: 'https://e.test/c', active: true, insert: false }, 200);
  const dropped = dropOriginator(99);
  assert.equal(dropped.length, 2);
  assert.ok(dropped.includes('d-1'));
  assert.ok(dropped.includes('d-2'));
  // d-3 lives.
  removed.length = 0;
  await closeGmTab('d-3');
  assert.equal(removed.length, 1);
});
