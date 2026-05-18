// Real end-to-end injection: write userscript files into a tmp dir,
// register the dir as a source through the real addSource pipeline,
// open a fixture page in the browser, and assert the script's DOM
// mutation actually lands.
//
// This is the test that proves the full chrome.userScripts path works
// in headless mode (file:// access enabled + user_scripts_enabled set
// in extension Preferences, both done by the fixture).

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';

test.describe('injection', () => {
  let scriptsDir: ScriptsDir;

  test.beforeEach(() => {
    scriptsDir = ScriptsDir.create();
  });
  test.afterEach(() => {
    scriptsDir.cleanup();
  });

  test('script injects DOM mutation on matching page', async ({
    extensionContext,
    fixtureServer,
    vm,
  }) => {
    scriptsDir.write({
      relativePath: 'mark.user.js',
      meta: {
        name: 'Mark Target',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
      },
      body: `
        const el = document.getElementById('target');
        if (el) el.textContent = 'injected by VibeMonkey';
      `,
    });
    const source = await vm.addSource(scriptsDir.path);
    expect(source).not.toBeNull();
    await vm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('#target')).toHaveText('injected by VibeMonkey');
    await page.close();
  });

  test('script is skipped on non-matching URL', async ({
    extensionContext,
    fixtureServer,
    vm,
  }) => {
    scriptsDir.write({
      relativePath: 'mark.user.js',
      meta: {
        name: 'Mark Target Only',
        match: [`${fixtureServer.baseUrl}/target.html`],
        runAt: 'document-end',
      },
      body: `
        document.getElementById('target').textContent = 'injected';
      `,
    });
    await vm.addSource(scriptsDir.path);
    await vm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/other.html`);
    // Give Chrome a moment in case a stray injection happens.
    await page.waitForLoadState('networkidle');
    await expect(page.locator('#target')).toHaveText('other page');
    await page.close();
  });

  test('multiple matching scripts all inject', async ({
    extensionContext,
    fixtureServer,
    vm,
  }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'A',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
      },
      body: `
        const el = document.getElementById('target');
        el.dataset.a = 'yes';
      `,
    });
    scriptsDir.write({
      relativePath: 'b.user.js',
      meta: {
        name: 'B',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
      },
      body: `
        const el = document.getElementById('target');
        el.dataset.b = 'yes';
      `,
    });
    await vm.addSource(scriptsDir.path);
    await vm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('#target')).toHaveAttribute('data-a', 'yes');
    await expect(page.locator('#target')).toHaveAttribute('data-b', 'yes');
    await page.close();
  });
});
