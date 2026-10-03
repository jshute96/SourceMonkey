// Unit tests for the SW-side `window.close` / `window.focus` driver.
//
// The module calls chrome.tabs.remove / chrome.windows.{get,update};
// they're stubbed here so import gets a working chrome global and every
// call is recorded.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

const calls = [];
let removeError = null;
let tabUpdateError = null;
let updateError = null;
let getError = null;
let windowState = 'normal';
let windowsAvailable = true;
// What chrome.tabs.query({windowType:'normal'}) reports. Two by
// default: the sender's tab is closable only while another exists.
let openTabs = [{ id: 12 }, { id: 13 }];

const windowsApi = {
  get: (windowId) => {
    calls.push({ fn: 'windows.get', windowId });
    return getError ? Promise.reject(getError) : Promise.resolve({ id: windowId, state: windowState });
  },
  update: (windowId, info) => {
    calls.push({ fn: 'windows.update', windowId, info });
    return updateError ? Promise.reject(updateError) : Promise.resolve({ id: windowId });
  },
};

globalThis.chrome = {
  tabs: {
    query: (info) => {
      calls.push({ fn: 'tabs.query', info });
      return Promise.resolve(openTabs);
    },
    remove: (tabId) => {
      calls.push({ fn: 'tabs.remove', tabId });
      return removeError ? Promise.reject(removeError) : Promise.resolve(undefined);
    },
    update: (tabId, info) => {
      calls.push({ fn: 'tabs.update', tabId, info });
      return tabUpdateError ? Promise.reject(tabUpdateError) : Promise.resolve({ id: tabId });
    },
  },
  get windows() {
    return windowsAvailable ? windowsApi : undefined;
  },
};

const {
  SM_WINDOW_CLOSE_MSG,
  SM_WINDOW_FOCUS_MSG,
  closeGmWindow,
  focusGmWindow,
  LAST_TAB_NOT_CLOSABLE,
} = await import('../../dist/extension/gm-window-control.js');

function reset() {
  calls.length = 0;
  removeError = null;
  tabUpdateError = null;
  updateError = null;
  getError = null;
  windowState = 'normal';
  windowsAvailable = true;
  openTabs = [{ id: 12 }, { id: 13 }];
}

test('the message types are the ones the wrapper sends', () => {
  assert.equal(SM_WINDOW_CLOSE_MSG, 'sm:gm-window-close');
  assert.equal(SM_WINDOW_FOCUS_MSG, 'sm:gm-window-focus');
});

test('closeGmWindow removes the sender tab', async () => {
  reset();
  assert.deepEqual(await closeGmWindow(12), { ok: true });
  assert.deepEqual(calls, [
    { fn: 'tabs.query', info: { windowType: 'normal' } },
    { fn: 'tabs.remove', tabId: 12 },
  ]);
});

test('closeGmWindow refuses to close the last tab in the browser', async () => {
  reset();
  openTabs = [{ id: 12 }];
  const r = await closeGmWindow(12);
  assert.equal(r.ok, false);
  assert.equal(r.error, LAST_TAB_NOT_CLOSABLE);
  // Closing it would quit the browser. TM refuses the same case.
  assert.deepEqual(calls, [{ fn: 'tabs.query', info: { windowType: 'normal' } }]);
});

test('closeGmWindow reports a refusal instead of throwing', async () => {
  reset();
  removeError = new Error('No tab with id: 12');
  const r = await closeGmWindow(12);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'This tab could not be closed: No tab with id: 12');
});

test('focusGmWindow selects the tab and raises its window', async () => {
  reset();
  assert.deepEqual(await focusGmWindow(12, 3), { ok: true });
  // Both halves matter: selecting alone leaves the tab behind another
  // window, raising alone is invisible when the user is just on a
  // different tab of the same window.
  assert.deepEqual(calls, [
    { fn: 'tabs.update', tabId: 12, info: { active: true } },
    { fn: 'windows.get', windowId: 3 },
    { fn: 'windows.update', windowId: 3, info: { focused: true } },
  ]);
});

test('focusGmWindow restores a minimized window', async () => {
  reset();
  windowState = 'minimized';
  assert.deepEqual(await focusGmWindow(12, 3), { ok: true });
  // `focused: true` alone leaves a minimized window minimized, and the
  // two can't be combined with `state: 'minimized'` — hence the read.
  assert.deepEqual(calls.at(-1), {
    fn: 'windows.update',
    windowId: 3,
    info: { focused: true, state: 'normal' },
  });
});

test('focusGmWindow still focuses when the state read fails', async () => {
  reset();
  getError = new Error('No window with id: 3');
  assert.deepEqual(await focusGmWindow(12, 3), { ok: true });
  assert.deepEqual(calls.at(-1), { fn: 'windows.update', windowId: 3, info: { focused: true } });
});

test('focusGmWindow reports an update failure', async () => {
  reset();
  updateError = new Error('No window with id: 3');
  const r = await focusGmWindow(12, 3);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'This tab could not be focused: No window with id: 3');
});

test('focusGmWindow reports a tab that has gone', async () => {
  reset();
  tabUpdateError = new Error('No tab with id: 12');
  const r = await focusGmWindow(12, 3);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'This tab could not be focused: No tab with id: 12');
  // Nothing else is attempted once the tab is known to be gone.
  assert.deepEqual(calls, [{ fn: 'tabs.update', tabId: 12, info: { active: true } }]);
});

test('focusGmWindow reports a missing chrome.windows API', async () => {
  reset();
  windowsAvailable = false;
  const r = await focusGmWindow(12, 3);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'Window focus is not available in this browser');
  assert.deepEqual(calls, []);
});
