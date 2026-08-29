// The install page's "Install into" dropdown (src/related-versions.ts
// `buildInstallSelect`, fed by `installOptionsFor` in
// src/script-identity.ts): which collections it lists, in what order,
// what it pre-selects, and where a script lands when Install is clicked.
//
// Every test takes the `sm` fixture even when it never calls it: `sm`
// is what runs `resetAllState()` around each test.

import { test, expect } from '../fixtures/extension';
import type { Page } from '@playwright/test';
import { UserscriptServer, userscriptText } from '../fixtures/userscript-server';

const PANEL = '#other-versions';

function previewUrl(extensionId: string, location: string): string {
  return `chrome-extension://${extensionId}/userscript.html?preview=${encodeURIComponent(location)}`;
}

// Waits for the select to be on screen first: the dropdown is built
// after the page has read the store, and `allTextContents` doesn't wait.
async function optionTexts(page: Page, select: string): Promise<string[]> {
  await expect(page.locator(select)).toBeVisible();
  return page.locator(`${select} option`).allTextContents();
}

test.describe('install target dropdown', () => {
  let server: UserscriptServer;
  let scriptUrl: string;
  test.beforeEach(async () => {
    server = await UserscriptServer.start();
    server.setRoute('/hello.user.js', userscriptText('Hello'));
    scriptUrl = `${server.baseUrl}/hello.user.js`;
  });
  test.afterEach(async () => { await server.stop(); });

  test('with no collections at all, the list is the scheme default (new) and New collection…', async ({
    extensionContext, extensionId, sm,
  }) => {
    void sm;
    const page = await extensionContext.newPage();
    await page.goto(previewUrl(extensionId, scriptUrl));
    await expect(page.locator('#install-callout')).toBeVisible();
    expect(await optionTexts(page, '#install-target')).toEqual([
      'Scripts from web (new)',
      'New collection…',
    ]);
    await expect(page.locator('#install-target option:checked')).toHaveText('Scripts from web (new)');
    await expect(page.locator('#install-btn')).toBeEnabled();
    await page.close();
  });

  test('the list is three groups: scheme default, other scripts collections in page order, New collection…', async ({
    extensionContext, extensionId, sm,
  }) => {
    // Page order puts the user's collection first; the default still
    // leads. A directory collection never appears.
    await sm.createCollection({ kind: 'scripts', name: 'Mine' });
    server.setRoute('/other.user.js', userscriptText('Other'));
    await sm.addCollection(`${server.baseUrl}/other.user.js`);
    await sm.createCollection({ kind: 'scripts', name: 'Later' });

    const page = await extensionContext.newPage();
    await page.goto(previewUrl(extensionId, scriptUrl));
    expect(await optionTexts(page, '#install-target')).toEqual([
      'Scripts from web',
      'Mine',
      'Later',
      'New collection…',
    ]);
    await expect(page.locator('#install-target hr')).toHaveCount(2);
    await expect(page.locator('#install-target option:checked')).toHaveText('Scripts from web');
    await page.close();
  });

  test('a renamed default is still the default, under its new name', async ({
    extensionContext, extensionId, sm,
  }) => {
    server.setRoute('/other.user.js', userscriptText('Other'));
    const def = await sm.addCollection(`${server.baseUrl}/other.user.js`);
    await sm.setCollectionOptions(def!.id, { displayName: 'Web stuff' });
    await sm.createCollection({ kind: 'scripts', name: 'Mine' });

    const page = await extensionContext.newPage();
    await page.goto(previewUrl(extensionId, scriptUrl));
    expect(await optionTexts(page, '#install-target')).toEqual(['Web stuff', 'Mine', 'New collection…']);
    await page.close();
  });

  test('with the default removed, it is offered as (new) ahead of the user\'s own', async ({
    extensionContext, extensionId, sm,
  }) => {
    await sm.createCollection({ kind: 'scripts', name: 'Mine' });
    const page = await extensionContext.newPage();
    await page.goto(previewUrl(extensionId, scriptUrl));
    expect(await optionTexts(page, '#install-target')).toEqual([
      'Scripts from web (new)',
      'Mine',
      'New collection…',
    ]);
    await page.close();
  });

  test('a disabled collection is offered, marked', async ({
    extensionContext, extensionId, sm,
  }) => {
    const mine = await sm.createCollection({ kind: 'scripts', name: 'Mine' });
    await sm.setCollectionEnabled(mine!.id, false);
    const page = await extensionContext.newPage();
    await page.goto(previewUrl(extensionId, scriptUrl));
    expect(await optionTexts(page, '#install-target')).toEqual([
      'Scripts from web (new)',
      'Mine (disabled)',
      'New collection…',
    ]);
    // Marked, not refused — the user may be about to switch it back on.
    await expect(page.locator('#install-target option', { hasText: 'Mine (disabled)' }))
      .toBeEnabled();
    await page.close();
  });

  test('Install puts the script into the chosen collection', async ({
    extensionContext, extensionId, sm,
  }) => {
    const mine = await sm.createCollection({ kind: 'scripts', name: 'Mine' });
    const page = await extensionContext.newPage();
    await page.goto(previewUrl(extensionId, scriptUrl));
    await page.locator('#install-target').selectOption({ label: 'Mine' });
    await page.locator('#install-btn').click();
    await page.waitForURL(/userscript\.html\?script=/);

    // No default was created — the chosen collection got it.
    const collections = await sm.getCollections();
    expect(collections).toHaveLength(1);
    expect(collections[0].id).toBe(mine!.id);
    const { scripts } = (await sm.getCollectionWithScripts(mine!.id))!;
    expect(scripts.map((s) => s.relativePath)).toEqual([scriptUrl]);
    expect(scripts[0].status).toBe('ok');
    await page.close();
  });

  test('the same URL can be installed into a second collection, which then runs instead', async ({
    extensionContext, extensionId, sm,
  }) => {
    const def = await sm.addCollection(scriptUrl);
    const mine = await sm.createCollection({ kind: 'scripts', name: 'Mine' });
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(previewUrl(extensionId, scriptUrl));
    // A copy exists: the table carries the offer, with the default
    // selected but marked, and Install off until another pick.
    await expect(page.locator('#install-callout')).toBeHidden();
    const offer = page.locator(`${PANEL} tr.is-offer`);
    expect(await optionTexts(page, `${PANEL} tr.is-offer select`)).toEqual([
      'Scripts from web (already installed)',
      'Mine',
      'New collection…',
    ]);
    await expect(offer.locator('select option:checked')).toHaveText('Scripts from web (already installed)');
    await expect(offer.locator('button')).toBeDisabled();

    await offer.locator('select').selectOption({ label: 'Mine' });
    await expect(offer.locator('button')).toBeEnabled();
    await expect(offer).toContainText('Not installed here yet');
    await offer.locator('button').click();
    await page.waitForURL(/userscript\.html\?script=/);

    const first = (await sm.getCollectionWithScripts(def!.id))!.scripts[0];
    const second = (await sm.getCollectionWithScripts(mine!.id))!.scripts[0];
    expect(second.relativePath).toBe(scriptUrl);
    // Installing is an enable, and enabling is exclusive: the new copy
    // runs, the old one is switched off.
    expect(second.enabled).toBe(true);
    expect(first.enabled).toBe(false);
    await page.close();
  });

  // Selecting the entry must NOT open the dialog: Chrome fires `change`
  // on every arrow key over a closed select, so a keyboard user
  // cursoring past it would get a modal in the face.
  test('New collection… only selects; the dialog waits for Install', async ({
    extensionContext, extensionId, sm,
  }) => {
    void sm;
    const page = await extensionContext.newPage();
    await page.goto(previewUrl(extensionId, scriptUrl));
    await page.locator('#install-target').selectOption({ label: 'New collection…' });

    const dialog = page.locator('dialog.collection-dialog');
    await expect(dialog).toBeHidden();
    await expect(page.locator('#install-target option:checked')).toHaveText('New collection…');
    await expect(page.locator('#install-btn')).toBeEnabled();
    await page.close();
  });

  test('Install with New collection… selected creates the collection and installs into it', async ({
    extensionContext, extensionId, sm,
  }) => {
    const page = await extensionContext.newPage();
    await page.goto(previewUrl(extensionId, scriptUrl));
    await page.locator('#install-target').selectOption({ label: 'New collection…' });
    await page.locator('#install-btn').click();

    const dialog = page.locator('dialog.collection-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('input[name="collection-kind"][value="scripts"]')).toBeChecked();
    await expect(dialog.locator('input[name="collection-kind"][value="directory"]')).toBeDisabled();
    // The title and button say the script lands too, so Create isn't a
    // surprise install.
    await expect(dialog.locator('.dlg-title')).toHaveText('Create new collection and install script');
    await expect(dialog.locator('button.primary')).toHaveText('Create and install');

    await dialog.locator('#collection-dialog-name').fill('Fresh');
    await dialog.locator('button.primary').click();
    await page.waitForURL(/userscript\.html\?script=/);

    const collections = await sm.getCollections();
    expect(collections).toHaveLength(1);
    expect((collections[0] as { displayName?: string }).displayName).toBe('Fresh');
    expect(collections[0].path).toMatch(/^container:[0-9a-f-]{36}$/);
    const { scripts } = (await sm.getCollectionWithScripts(collections[0].id))!;
    expect(scripts.map((s) => s.relativePath)).toEqual([scriptUrl]);
    await page.close();
  });

  test('cancelling the create-and-install dialog installs nothing and keeps the page usable', async ({
    extensionContext, extensionId, sm,
  }) => {
    const page = await extensionContext.newPage();
    await page.goto(previewUrl(extensionId, scriptUrl));
    await page.locator('#install-target').selectOption({ label: 'New collection…' });
    await page.locator('#install-btn').click();
    const dialog = page.locator('dialog.collection-dialog');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    expect(await sm.getCollections()).toHaveLength(0);
    await expect(page.locator('#install-btn')).toBeEnabled();
    await page.close();
  });
});
