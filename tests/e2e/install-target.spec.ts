// The install page's "Install into" dropdown (src/extension/related-versions.ts
// `buildInstallSelect`, fed by `installOptionsFor` in
// src/extension/script-identity.ts): which collections it lists, in what order,
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

  // The callout reads as one sentence — Install into <collection> —
  // with the button as its verb, so it comes first in the markup too.
  // The visible label is then only the connector, which names nothing
  // on its own; the dropdown carries the whole phrase as its name.
  test('the callout reads Install into [collection], in that order', async ({
    extensionContext, extensionId, sm,
  }) => {
    void sm;
    const page = await extensionContext.newPage();
    await page.goto(previewUrl(extensionId, scriptUrl));
    await expect(page.locator('#install-target')).toBeVisible();
    expect(await page.locator('#install-callout > *').evaluateAll(
      (els) => els.map((el) => el.id || el.tagName.toLowerCase()),
    )).toEqual(['install-btn', 'install-target-label', 'install-target-slot']);
    await expect(page.locator('#install-target-label')).toHaveText('into');
    await expect(page.locator('#install-target')).toHaveAttribute('aria-label', 'Install into');
    await page.close();
  });

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
    // A copy exists: the panel's third section carries the offer, with
    // the default selected but marked, and Install off until another
    // pick — with a line saying why.
    await expect(page.locator('#install-callout')).toBeHidden();
    await expect(page.locator(`${PANEL} .versions-section-heading`).last())
      .toHaveText('Install another copy of this script');
    const offer = page.locator(`${PANEL} tr.is-offer`);
    expect(await optionTexts(page, `${PANEL} tr.is-offer select`)).toEqual([
      'Scripts from web (already installed)',
      'Mine',
      'New collection…',
    ]);
    await expect(offer.locator('select option:checked')).toHaveText('Scripts from web (already installed)');
    await expect(offer.locator('button')).toBeDisabled();
    await expect(offer.locator('.install-offer-note'))
      .toHaveText('Already installed there. Choose another collection.');
    // The row lines up under the copies above it: same Location column.
    await expect(offer.locator('td.col-location')).toHaveText(scriptUrl);

    await offer.locator('select').selectOption({ label: 'Mine' });
    await expect(offer.locator('button')).toBeEnabled();
    await expect(offer.locator('.install-offer-note')).toHaveText('');
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
    // Scripts-only: no location may be given, so the location field
    // isn't there at all and the Type row asks only for a name.
    await expect(dialog.locator('#collection-dialog-location')).toBeHidden();
    await expect(dialog.locator('.dlg-type .collection-type-bubble')).toHaveText('invalid');
    await expect(dialog.locator('.dlg-type .dlg-hint')).toHaveText('Enter a name');
    // The title and button say the script lands too, so Create isn't a
    // surprise install.
    await expect(dialog.locator('.dlg-title')).toHaveText('Create new collection and install script');
    await expect(dialog.locator('button.primary')).toHaveText('Create and install');

    await dialog.locator('#collection-dialog-name').fill('Fresh');
    await expect(dialog.locator('.dlg-type .collection-type-bubble')).toHaveText('scripts');
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

  // The click that opens the list must not also pick out of it. See
  // src/extension/select-open-guard.ts: Chrome sometimes draws the list over the
  // control, putting an entry under the pointer that just pressed, and
  // the release of that same click commits it. The press is therefore
  // cancelled and the list opened from the release instead.
  //
  // The popup is a browser widget with no test surface, so what these
  // check is the half that is observable: the press is refused (no
  // popup can open under a held button) and the selection survives a
  // full click.
  test('the press on the dropdown is cancelled, and focus set by hand', async ({
    extensionContext, extensionId, sm,
  }) => {
    await sm.createCollection({ kind: 'scripts', name: 'Mine' });
    const page = await extensionContext.newPage();
    await page.goto(previewUrl(extensionId, scriptUrl));
    const select = page.locator('#install-target');
    await expect(select).toBeVisible();
    const before = await select.inputValue();
    await page.evaluate(() => {
      (window as unknown as { prevented?: boolean }).prevented = undefined;
      document.querySelector('#install-target')!.addEventListener('mousedown', (e) => {
        (window as unknown as { prevented?: boolean }).prevented = e.defaultPrevented;
      });
    });

    const box = (await select.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    // The press alone: no popup, so nothing to commit, and the control
    // still takes focus the way a press normally gives it.
    expect(await page.evaluate(() => (window as unknown as { prevented?: boolean }).prevented))
      .toBe(true);
    await expect(select).toBeFocused();
    await page.mouse.up();
    // Headless draws no popup, so this only says the click committed
    // nothing on its own — the press being refused above is what
    // carries the fix.
    await expect(select).toHaveValue(before);
    await page.keyboard.press('Escape');
    await page.close();
  });

  // Only the release of a press the guard itself cancelled opens the
  // list. A click with no such press behind it — the keyboard's Enter,
  // the `for=` label beside the dropdown, a programmatic `click()` —
  // must not reach `showPicker`, or it would open a list the user
  // didn't ask for (and, where Chrome opened one already, fight it).
  test('a click with no cancelled press behind it does not open the list', async ({
    extensionContext, extensionId, sm,
  }) => {
    await sm.createCollection({ kind: 'scripts', name: 'Mine' });
    const page = await extensionContext.newPage();
    await page.goto(previewUrl(extensionId, scriptUrl));
    await expect(page.locator('#install-target')).toBeVisible();
    const opened = await page.evaluate(() => {
      const sel = document.querySelector('#install-target') as HTMLSelectElement;
      let calls = 0;
      sel.showPicker = () => { calls += 1; };
      sel.click();
      document.querySelector<HTMLLabelElement>('#install-target-label')!.click();
      return calls;
    });
    expect(opened).toBe(0);
    await page.close();
  });

  // The dropdown still works as a dropdown: the guard adds no `change`
  // wiring, so a pick still reaches the Install button.
  test('a pick still commits and lights up Install', async ({
    extensionContext, extensionId, sm,
  }) => {
    await sm.createCollection({ kind: 'scripts', name: 'Mine' });
    const page = await extensionContext.newPage();
    await page.goto(previewUrl(extensionId, scriptUrl));
    await expect(page.locator('#install-target')).toBeVisible();
    await page.locator('#install-target').selectOption({ label: 'Mine' });
    await expect(page.locator('#install-target option:checked')).toHaveText('Mine');
    await expect(page.locator('#install-btn')).toBeEnabled();
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
