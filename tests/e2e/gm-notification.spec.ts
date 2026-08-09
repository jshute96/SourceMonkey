// End-to-end test for GM_notification.
//
// In headless Chromium, chrome.notifications.create succeeds but no
// system notification actually renders (Chrome's notification UI is
// suppressed). That's fine — we only need to verify:
//
//   1. The SW round-trip succeeds and returns a notification id.
//   2. Ungranted access remains gated.
//
// Click / close callback dispatch can't be exercised headlessly without
// driving the OS notification center, which is out of scope. The unit
// tests in gm-notification.test.mjs cover the dispatch routing.

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';

test.describe('GM_notification', () => {
  let scriptsDir: ScriptsDir;
  test.beforeEach(() => { scriptsDir = ScriptsDir.create(); });
  test.afterEach(() => { scriptsDir.cleanup(); });

  test('GM_notification with details object resolves with a notification id', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'NotifyDetails',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_notification'],
      },
      body: `
        Promise.resolve(GM_notification({ text: 'hi', title: 'T' })).then(
          (id) => { document.body.dataset.smNotif = 'ok:' + typeof id; },
          (e) => { document.body.dataset.smNotif = 'err:' + String(e && e.message || e); }
        );
      `,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-notif', /^ok:string/);
    await page.close();
  });

  test('GM_notification with positional args (text, title) also works', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'NotifyPositional',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_notification'],
      },
      body: `
        Promise.resolve(GM_notification('the text', 'the title')).then(
          (id) => { document.body.dataset.smNotif = 'ok'; },
          (e) => { document.body.dataset.smNotif = 'err:' + String(e && e.message || e); }
        );
      `,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-notif', 'ok');
    await page.close();
  });

  test('GM.notification (GM4 alias) returns a Promise', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'NotifyGmDot',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_notification'],
      },
      body: `
        const p = GM.notification({ text: 'hi via dot' });
        document.body.dataset.smIsPromise = String(p && typeof p.then === 'function');
        p.then(
          () => { document.body.dataset.smNotif = 'ok'; },
          () => { document.body.dataset.smNotif = 'err'; }
        );
      `,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-is-promise', 'true');
    await expect(page.locator('body')).toHaveAttribute('data-sm-notif', 'ok');
    await page.close();
  });

  test('empty `text` is rejected synchronously (via Promise)', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'NotifyEmpty',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_notification'],
      },
      body: `
        Promise.resolve(GM_notification({ text: '' })).then(
          () => { document.body.dataset.smNotif = 'unexpected-ok'; },
          (e) => { document.body.dataset.smNotif = 'rejected:' + String(e.message || e); }
        );
      `,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-notif', /^rejected:/);
    await page.close();
  });

  test('ungranted GM_notification is undefined in scope', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'NoNotifGrant',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_setValue'],
      },
      body: `
        document.body.dataset.smNotifType = typeof GM_notification;
      `,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-notif-type', 'undefined');
    await page.close();
  });
});
