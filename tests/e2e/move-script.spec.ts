// Moving an installed script from one "individual scripts" collection
// to another, from the viewer's Collection row (src/userscript.ts
// `makeMoveControl`, `moveScript` in src/script-store.ts).
//
// What the move must preserve is what the tests below check: the
// script keeps its stored id, and with it everything else keyed by
// that id — its `log:<id>` entries, its `gmval:<id>:*` values, its
// chrome.userScripts registration — while only the two collections'
// `scriptIds` and the row's `collectionId` change.
//
// Every test takes the `sm` fixture even when it never calls it: `sm`
// is what runs `resetAllState()` around each test.

import { test, expect } from '../fixtures/extension';
import type { Page } from '@playwright/test';
import { UserscriptServer, userscriptText } from '../fixtures/userscript-server';
import { ScriptsDir } from '../fixtures/scripts-dir';

const MOVE_BTN = '#move-collection-btn';
const DIALOG = 'dialog.move-dialog';
const SELECT = `${DIALOG} #move-target`;
const CONFIRM = `${DIALOG} #move-confirm-btn`;

function viewerUrl(extensionId: string, scriptId: string): string {
  return `chrome-extension://${extensionId}/userscript.html?script=${scriptId}`;
}

// The Collection row's display name, once the header has painted.
async function collectionName(page: Page): Promise<string> {
  return (await page.locator('.collection-cell .collection-display-name').innerText()).trim();
}

test.describe('move a script between collections', () => {
  let server: UserscriptServer;
  let scriptUrl: string;
  test.beforeEach(async () => {
    server = await UserscriptServer.start();
    server.setRoute('/hello.user.js', userscriptText('Hello'));
    scriptUrl = `${server.baseUrl}/hello.user.js`;
  });
  // Only the directory test needs one, so they are made on demand and
  // swept here rather than created for every test.
  const dirsToClean: ScriptsDir[] = [];
  test.afterEach(async () => {
    await server.stop();
    while (dirsToClean.length > 0) dirsToClean.pop()!.cleanup();
  });

  test('the list holds every scripts collection, with the current one marked', async ({
    extensionContext, extensionId, sm,
  }) => {
    const def = await sm.addCollection(scriptUrl);
    await sm.createCollection({ kind: 'scripts', name: 'Mine' });
    await sm.createCollection({ kind: 'scripts', name: 'Later' });
    const scriptId = (await sm.getCollectionWithScripts(def!.id))!.scripts[0].id;

    const page = await extensionContext.newPage();
    await page.goto(viewerUrl(extensionId, scriptId));
    await page.locator(MOVE_BTN).click();
    await expect(page.locator(DIALOG)).toBeVisible();
    await expect(page.locator(`${DIALOG} .dlg-title`))
      .toHaveText('Move script to another collection');
    expect(await page.locator(`${SELECT} option`).allTextContents()).toEqual([
      'Scripts from web (current)',
      'Mine',
      'Later',
      'New collection…',
    ]);
    // Opens on the collection it is in, so moving takes a pick.
    await expect(page.locator(`${SELECT} option:checked`))
      .toHaveText('Scripts from web (current)');
    await expect(page.locator(`${SELECT} option`, { hasText: '(current)' })).toBeDisabled();
    await expect(page.locator(CONFIRM)).toBeDisabled();
    await page.close();
  });

  // The dialog's dropdown comes from the same builder as the install
  // page's, so it inherits the open-on-release guard
  // (src/select-open-guard.ts). Asserted here because "same builder"
  // is the only reason it does.
  test('the dialog\'s dropdown refuses the press that would open it', async ({
    extensionContext, extensionId, sm,
  }) => {
    const def = await sm.addCollection(scriptUrl);
    await sm.createCollection({ kind: 'scripts', name: 'Mine' });
    const scriptId = (await sm.getCollectionWithScripts(def!.id))!.scripts[0].id;

    const page = await extensionContext.newPage();
    await page.goto(viewerUrl(extensionId, scriptId));
    await page.locator(MOVE_BTN).click();
    await expect(page.locator(SELECT)).toBeVisible();
    const prevented = await page.evaluate((sel) => new Promise<boolean>((done) => {
      const select = document.querySelector(sel) as HTMLSelectElement;
      select.addEventListener('mousedown', (e) => done(e.defaultPrevented), { once: true });
      select.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true }));
    }), SELECT);
    expect(prevented).toBe(true);
    await page.close();
  });

  test('Move keeps the script id, and both collections\' lists agree', async ({
    extensionContext, extensionId, sm,
  }) => {
    const def = await sm.addCollection(scriptUrl);
    const mine = await sm.createCollection({ kind: 'scripts', name: 'Mine' });
    const scriptId = (await sm.getCollectionWithScripts(def!.id))!.scripts[0].id;

    const page = await extensionContext.newPage();
    await page.goto(viewerUrl(extensionId, scriptId));
    await page.locator(MOVE_BTN).click();
    await page.locator(SELECT).selectOption({ label: 'Mine' });
    await expect(page.locator(CONFIRM)).toBeEnabled();
    await page.locator(CONFIRM).click();

    // The page rehydrates from the storage change — no navigation.
    await expect(page.locator('.collection-cell .collection-display-name')).toHaveText('Mine');
    expect(page.url()).toContain(`script=${scriptId}`);

    const source = await sm.getCollectionWithScripts(def!.id);
    const dest = await sm.getCollectionWithScripts(mine!.id);
    expect(source!.scripts).toHaveLength(0);
    expect(source!.collection.scriptIds).toEqual([]);
    expect(dest!.collection.scriptIds).toEqual([scriptId]);
    // Same row, so its registration, GM values and Log all follow it.
    expect(dest!.scripts[0].id).toBe(scriptId);
    expect(dest!.scripts[0].status).toBe('ok');
    await page.close();
  });

  test('Cancel closes the dialog and moves nothing', async ({
    extensionContext, extensionId, sm,
  }) => {
    const def = await sm.addCollection(scriptUrl);
    await sm.createCollection({ kind: 'scripts', name: 'Mine' });
    const scriptId = (await sm.getCollectionWithScripts(def!.id))!.scripts[0].id;

    const page = await extensionContext.newPage();
    await page.goto(viewerUrl(extensionId, scriptId));
    const before = await collectionName(page);
    await page.locator(MOVE_BTN).click();
    await page.locator(DIALOG).getByRole('button', { name: 'Cancel' }).click();
    await expect(page.locator(DIALOG)).toBeHidden();
    await expect(page.locator(MOVE_BTN)).toBeVisible();
    expect(await collectionName(page)).toBe(before);
    expect((await sm.getCollectionWithScripts(def!.id))!.scripts).toHaveLength(1);
    await page.close();
  });

  test('a collection already holding this location is listed but not pickable', async ({
    extensionContext, extensionId, sm,
  }) => {
    const def = await sm.addCollection(scriptUrl);
    const mine = await sm.createCollection({ kind: 'scripts', name: 'Mine' });
    await sm.installScript(scriptUrl, { collectionId: mine!.id });
    const scriptId = (await sm.getCollectionWithScripts(def!.id))!.scripts[0].id;

    const page = await extensionContext.newPage();
    await page.goto(viewerUrl(extensionId, scriptId));
    await page.locator(MOVE_BTN).click();
    await expect(page.locator(DIALOG)).toBeVisible();
    expect(await page.locator(`${SELECT} option`).allTextContents()).toEqual([
      'Scripts from web (current)',
      'Mine (already installed)',
      'New collection…',
    ]);
    await expect(page.locator(`${SELECT} option`, { hasText: '(already installed)' }))
      .toBeDisabled();
    // Neither entry is pickable, so Move has nothing to act on.
    await expect(page.locator(CONFIRM)).toBeDisabled();
    await page.close();
  });

  test('moving back to a default that no longer exists creates it', async ({
    extensionContext, extensionId, sm,
  }) => {
    // The script starts in a user collection, so the http default has
    // no row at all — the picker offers to make it.
    const mine = await sm.createCollection({ kind: 'scripts', name: 'Mine' });
    await sm.installScript(scriptUrl, { collectionId: mine!.id });
    const scriptId = (await sm.getCollectionWithScripts(mine!.id))!.scripts[0].id;

    const page = await extensionContext.newPage();
    await page.goto(viewerUrl(extensionId, scriptId));
    await page.locator(MOVE_BTN).click();
    expect(await page.locator(`${SELECT} option`).allTextContents()).toEqual([
      'Scripts from web (new)',
      'Mine (current)',
      'New collection…',
    ]);
    await page.locator(SELECT).selectOption({ label: 'Scripts from web (new)' });
    await page.locator(CONFIRM).click();
    await expect(page.locator('.collection-cell .collection-display-name'))
      .toHaveText('Scripts from web');

    const collections = await sm.getCollections();
    const def = collections.find((c) => c.path === 'container:http')!;
    expect(def.scriptIds).toEqual([scriptId]);
    expect((await sm.getCollectionWithScripts(mine!.id))!.collection.scriptIds).toEqual([]);
    await page.close();
  });

  test('a move across a localFiles disagreement re-resolves the script', async ({
    extensionContext, extensionId, sm,
  }) => {
    // The destination forbids local stand-ins, so the @require has to
    // be resolved again under the new collection's rule.
    server.setRoute('/lib.js', 'globalThis.__lib = 1;');
    server.setRoute('/needs-lib.user.js', [
      '// ==UserScript==',
      '// @name        NeedsLib',
      '// @match       https://example.com/*',
      `// @require     ${server.baseUrl}/lib.js`,
      '// ==/UserScript==',
      "console.log('NeedsLib');",
      '',
    ].join('\n'));
    const def = await sm.addCollection(`${server.baseUrl}/needs-lib.user.js`);
    const strict = await sm.createCollection({
      kind: 'scripts', name: 'Strict', localFiles: false,
    });
    const scriptId = (await sm.getCollectionWithScripts(def!.id))!.scripts[0].id;

    const page = await extensionContext.newPage();
    await page.goto(viewerUrl(extensionId, scriptId));
    await page.locator(MOVE_BTN).click();
    await page.locator(SELECT).selectOption({ label: 'Strict' });
    await page.locator(CONFIRM).click();
    await expect(page.locator('.collection-cell .collection-display-name')).toHaveText('Strict');

    // The refresh ran and the row came back healthy, with its require
    // still attached.
    const moved = (await sm.getCollectionWithScripts(strict!.id))!.scripts[0];
    expect(moved.id).toBe(scriptId);
    expect(moved.status).toBe('ok');
    expect(moved.requires).toHaveLength(1);
    await page.close();
  });

  test('New collection… waits for Move, then creates and moves', async ({
    extensionContext, extensionId, sm,
  }) => {
    const def = await sm.addCollection(scriptUrl);
    const scriptId = (await sm.getCollectionWithScripts(def!.id))!.scripts[0].id;

    const page = await extensionContext.newPage();
    await page.goto(viewerUrl(extensionId, scriptId));
    await page.locator(MOVE_BTN).click();
    await page.locator(SELECT).selectOption({ label: 'New collection…' });
    // Selecting alone must not open the create dialog: Chrome fires
    // `change` on every arrow key over a closed select.
    const dialog = page.locator('dialog.collection-dialog');
    await expect(dialog).toBeHidden();
    // The button names what it is about to do, since this one creates
    // before it moves.
    await expect(page.locator(CONFIRM)).toHaveText('Create and move');

    await page.locator(CONFIRM).click();
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.dlg-title')).toHaveText('Create new collection and move script');
    await expect(dialog.locator('button.primary')).toHaveText('Create and move');
    await dialog.locator('#collection-dialog-name').fill('Fresh');
    await dialog.locator('button.primary').click();

    await expect(page.locator('.collection-cell .collection-display-name')).toHaveText('Fresh');
    const collections = await sm.getCollections();
    const fresh = collections.find((c) => c.id !== def!.id)!;
    expect(fresh.scriptIds).toEqual([scriptId]);
    await page.close();
  });

  test('moving into a disabled collection stops the script running', async ({
    extensionContext, extensionId, sm,
  }) => {
    const def = await sm.addCollection(scriptUrl);
    const off = await sm.createCollection({ kind: 'scripts', name: 'Off' });
    await sm.setCollectionEnabled(off!.id, false);
    const scriptId = (await sm.getCollectionWithScripts(def!.id))!.scripts[0].id;
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(viewerUrl(extensionId, scriptId));
    await page.locator(MOVE_BTN).click();
    await page.locator(SELECT).selectOption({ label: 'Off (disabled)' });
    await page.locator(CONFIRM).click();
    await expect(page.locator('.collection-cell .collection-display-name')).toHaveText('Off');

    // The row's own flag is untouched — it is the collection that is
    // off — but nothing is registered for it any more.
    const moved = (await sm.getCollectionWithScripts(off!.id))!.scripts[0];
    expect(moved.enabled).not.toBe(false);
    const { registered } = await sm.syncNow();
    expect(registered.map((r) => r.id)).not.toContain(scriptId);
    await page.close();
  });

  // The control shares the Collection row's grid. It gets a column of
  // its own at the right edge, so a name long enough to wrap can't push
  // it onto a line of its own or drag it along to the last wrapped one.
  // Same weight of control as the versions table's per-row buttons, so
  // the details rows don't have one that stands taller than the rest.
  test('the Move button is the same height as a versions-table button', async ({
    extensionContext, extensionId, sm,
  }) => {
    const def = await sm.addCollection(scriptUrl);
    // A second copy, so the versions table draws a row with buttons.
    const mine = await sm.createCollection({ kind: 'scripts', name: 'Mine' });
    await sm.installScript(scriptUrl, { collectionId: mine!.id });
    const scriptId = (await sm.getCollectionWithScripts(def!.id))!.scripts[0].id;

    const page = await extensionContext.newPage();
    await page.goto(viewerUrl(extensionId, scriptId));
    const move = await page.locator(MOVE_BTN).boundingBox();
    const rowBtn = await page
      .locator('#other-versions tbody tr .col-actions button').first().boundingBox();
    expect(move!.height).toBe(rowBtn!.height);
    await page.close();
  });

  // A name that fits keeps the button right beside it; only a name too
  // long for the row pushes it out to the margin.
  test('the Move button sits right after a short collection name', async ({
    extensionContext, extensionId, sm,
  }) => {
    const def = await sm.addCollection(scriptUrl);
    await sm.setCollectionOptions(def!.id, { displayName: 'Short' });
    const scriptId = (await sm.getCollectionWithScripts(def!.id))!.scripts[0].id;

    const page = await extensionContext.newPage();
    await page.goto(viewerUrl(extensionId, scriptId));
    const cell = await page.locator('.collection-cell').boundingBox();
    const name = await page.locator('.collection-cell .collection-display-name').boundingBox();
    const btn = await page.locator(MOVE_BTN).boundingBox();
    // Snug against the name, nowhere near the right margin.
    expect(btn!.x - (name!.x + name!.width)).toBeLessThan(12);
    expect((cell!.x + cell!.width) - (btn!.x + btn!.width)).toBeGreaterThan(50);
    await page.close();
  });

  test('the row\'s controls hold its right edge, beside a name that wraps', async ({
    extensionContext, extensionId, sm,
  }) => {
    const def = await sm.addCollection(scriptUrl);
    await sm.setCollectionOptions(def!.id, {
      displayName: 'A deliberately long collection name that has to wrap somewhere',
    });
    const scriptId = (await sm.getCollectionWithScripts(def!.id))!.scripts[0].id;

    const page = await extensionContext.newPage();
    await page.setViewportSize({ width: 520, height: 800 });
    await page.goto(viewerUrl(extensionId, scriptId));
    const cell = await page.locator('.collection-cell').boundingBox();
    const name = await page.locator('.collection-cell .collection-display-name').boundingBox();
    const btn = await page.locator(MOVE_BTN).boundingBox();
    // The name really did wrap, or this proves nothing.
    expect(name!.height).toBeGreaterThan(btn!.height);
    // Same first line as the name, not below it.
    expect(btn!.y).toBeLessThan(name!.y + btn!.height);
    // Move… has the column to itself, flush with the row's right edge.
    expect(Math.abs((btn!.x + btn!.width) - (cell!.x + cell!.width))).toBeLessThan(1.5);
    await page.close();
  });

  // Cancelling the stacked create dialog drops back to the move
  // dialog with the choice intact, rather than abandoning the move.
  test('cancelling the create dialog returns to the move dialog', async ({
    extensionContext, extensionId, sm,
  }) => {
    const def = await sm.addCollection(scriptUrl);
    const scriptId = (await sm.getCollectionWithScripts(def!.id))!.scripts[0].id;

    const page = await extensionContext.newPage();
    await page.goto(viewerUrl(extensionId, scriptId));
    await page.locator(MOVE_BTN).click();
    await page.locator(SELECT).selectOption({ label: 'New collection…' });
    await page.locator(CONFIRM).click();

    const create = page.locator('dialog.collection-dialog');
    await expect(create).toBeVisible();
    await create.getByRole('button', { name: 'Cancel' }).click();
    await expect(create).toBeHidden();
    await expect(page.locator(DIALOG)).toBeVisible();
    await expect(page.locator(`${SELECT} option:checked`)).toHaveText('New collection…');
    expect(await sm.getCollections()).toHaveLength(1);
    await page.close();
  });

  // The direction the sweep exists for: the moved copy starts running,
  // so the copy that was running instead has to stop. Two enabled
  // copies both register and both run on every page they match.
  test('a move that starts the script switches the running copy off', async ({
    extensionContext, extensionId, sm,
  }) => {
    // The parked copy lives in a disabled collection, so it isn't
    // running; the other one is.
    const parked = await sm.createCollection({ kind: 'scripts', name: 'Parked' });
    await sm.installScript(scriptUrl, { collectionId: parked!.id });
    await sm.setCollectionEnabled(parked!.id, false);
    server.setRoute('/mirror.user.js', userscriptText('Hello'));
    const running = await sm.addCollection(`${server.baseUrl}/mirror.user.js`);
    await sm.syncNow();

    const parkedId = (await sm.getCollectionWithScripts(parked!.id))!.scripts[0].id;
    const runningId = (await sm.getCollectionWithScripts(running!.id))!.scripts[0].id;
    // Same @name and @namespace, so they are copies of one script.
    expect((await sm.getCollectionWithScripts(running!.id))!.scripts[0].enabled).not.toBe(false);
    // Both land in `container:http` after the move.
    const enabledOf = async (id: string): Promise<boolean | undefined> => {
      const rows = (await sm.getCollectionWithScripts(running!.id))!.scripts;
      return rows.find((r) => r.id === id)?.enabled;
    };

    const page = await extensionContext.newPage();
    await page.goto(viewerUrl(extensionId, parkedId));
    await page.locator(MOVE_BTN).click();
    await page.locator(SELECT).selectOption({ label: 'Scripts from web' });
    await page.locator(CONFIRM).click();
    await expect(page.locator('.collection-cell .collection-display-name'))
      .toHaveText('Scripts from web');

    // The moved copy now runs, so the mirror was switched off.
    await expect.poll(() => enabledOf(runningId)).toBe(false);
    expect(await enabledOf(parkedId)).not.toBe(false);
    await page.close();
  });

  // Side data keyed by the row id has to come along. The Log stands in
  // for all of it (`gmval:<id>:*` and the registration are keyed the
  // same way): a move that re-created the row instead of re-parenting
  // it would strand every one of them, and `removeScript` deliberately
  // wipes `log:<id>`, so this would catch a move built out of
  // remove-then-install.
  test('the per-script log survives the move', async ({
    extensionContext, extensionId, sm,
  }) => {
    const def = await sm.addCollection(scriptUrl);
    await sm.createCollection({ kind: 'scripts', name: 'Mine' });
    const scriptId = (await sm.getCollectionWithScripts(def!.id))!.scripts[0].id;
    await sm.appendScriptLog(scriptId, {
      level: 'info', source: 'test', message: 'written before the move',
    });

    const page = await extensionContext.newPage();
    await page.goto(viewerUrl(extensionId, scriptId));
    await page.locator(MOVE_BTN).click();
    await page.locator(SELECT).selectOption({ label: 'Mine' });
    await page.locator(CONFIRM).click();
    await expect(page.locator('.collection-cell .collection-display-name')).toHaveText('Mine');

    const log = await sm.getScriptLog(scriptId);
    expect(log.map((e) => e.message)).toContain('written before the move');
    await page.close();
  });

  // The store's own refusals, driven directly — the UI never offers
  // these, so nothing else reaches them.
  test('moveScript refuses a script that is not in a scripts collection', async ({ sm }) => {
    const scriptsDir = ScriptsDir.create();
    dirsToClean.push(scriptsDir);
    scriptsDir.write({ relativePath: 'one.user.js', meta: { name: 'One', match: ['*://*/*'] }, body: '' });
    const dir = await sm.addCollection(scriptsDir.path);
    const mine = await sm.createCollection({ kind: 'scripts', name: 'Mine' });
    const scriptId = (await sm.getCollectionWithScripts(dir!.id))!.scripts[0].id;

    await expect(sm.moveScript(scriptId, { collectionId: mine!.id }))
      .rejects.toThrow(/individual scripts collection/);
  });

  test('moveScript reports a destination that has since been removed', async ({ sm }) => {
    const def = await sm.addCollection(scriptUrl);
    const doomed = await sm.createCollection({ kind: 'scripts', name: 'Doomed' });
    const scriptId = (await sm.getCollectionWithScripts(def!.id))!.scripts[0].id;
    await sm.removeCollection(doomed!.id);

    await expect(sm.moveScript(scriptId, { collectionId: doomed!.id }))
      .rejects.toThrow(/no longer exists/);
  });

  test('moveScript is a no-op for the collection the script is already in', async ({ sm }) => {
    const def = await sm.addCollection(scriptUrl);
    const scriptId = (await sm.getCollectionWithScripts(def!.id))!.scripts[0].id;
    expect(await sm.moveScript(scriptId, { collectionId: def!.id })).toBe(null);
    expect((await sm.getCollectionWithScripts(def!.id))!.collection.scriptIds).toEqual([scriptId]);
  });

  test('a directory collection\'s script has no Move control', async ({
    extensionContext, extensionId, sm,
  }) => {
    const scriptsDir = ScriptsDir.create();
    dirsToClean.push(scriptsDir);
    scriptsDir.write({ relativePath: 'one.user.js', meta: { name: 'One', match: ['*://*/*'] }, body: '' });
    const dir = await sm.addCollection(scriptsDir.path);
    const scriptId = (await sm.getCollectionWithScripts(dir!.id))!.scripts[0].id;

    const page = await extensionContext.newPage();
    await page.goto(viewerUrl(extensionId, scriptId));
    await expect(page.locator('.collection-cell')).toBeVisible();
    await expect(page.locator(MOVE_BTN)).toHaveCount(0);
    await page.close();
  });
});
