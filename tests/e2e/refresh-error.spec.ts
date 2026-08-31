// Coverage for the "read but couldn't be saved" report — what the user
// sees when a refresh fetches everything successfully and the write to
// `chrome.storage.local` is what fails.
//
// The motivating case is an exhausted 10 MB quota (see docs/storage.md).
// Filling the quota honestly would mean pushing ~10 MB of userscripts
// through the real pipeline on every run — slow, and it leaves the
// profile wedged for whatever runs next — so `sm.failCollectionWrites`
// throws at the point a quota rejection lands: after every fetch, with
// nothing written. Everything downstream of the write is the real code.
//
// What this does NOT cover is Chrome's own quota enforcement, i.e. that
// a genuinely oversized `set` rejects rather than silently truncating.
// That stays a manual check.

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';

const SECTION_MESSAGE = 'could not be saved';
const BANNER = 'SourceMonkey is out of storage space';

test.describe('a refresh that cannot be saved', () => {
  let scriptsDir: ScriptsDir;

  test.beforeEach(async () => {
    scriptsDir = ScriptsDir.create();
    scriptsDir.write({
      relativePath: 'hello.user.js',
      meta: { name: 'Hello', match: ['https://example.com/*'] },
      body: 'console.log("hello");',
    });
  });

  test.afterEach(() => {
    scriptsDir.cleanup();
  });

  test('records the reason per collection instead of failing silently', async ({ sm }) => {
    const collection = await sm.addCollection(scriptsDir.path);
    expect(await sm.getRefreshErrors()).toEqual({});

    await sm.failCollectionWrites('QUOTA_BYTES quota exceeded');
    await sm.updateCollection(collection!.id, 'manual').catch(() => {});

    const errors = await sm.getRefreshErrors();
    expect(errors[collection!.id]).toContain('QUOTA_BYTES quota exceeded');
  });

  test('the prior scripts keep running — a failed save changes nothing', async ({ sm }) => {
    const collection = await sm.addCollection(scriptsDir.path);
    const before = (await sm.getCollectionWithScripts(collection!.id))!.scripts;

    // Change the file so a SUCCESSFUL refresh would visibly rewrite the
    // row, then make the write fail. The stored copy must be the old one.
    scriptsDir.write({
      relativePath: 'hello.user.js',
      meta: { name: 'Hello Renamed', match: ['https://example.com/*'] },
      body: 'console.log("changed");',
    });
    await sm.failCollectionWrites('QUOTA_BYTES quota exceeded');
    await sm.updateCollection(collection!.id, 'manual').catch(() => {});

    const after = (await sm.getCollectionWithScripts(collection!.id))!.scripts;
    expect(after).toEqual(before);
  });

  test('a later successful refresh clears the record', async ({ sm }) => {
    const collection = await sm.addCollection(scriptsDir.path);
    await sm.failCollectionWrites('QUOTA_BYTES quota exceeded');
    await sm.updateCollection(collection!.id, 'manual').catch(() => {});
    expect(await sm.getRefreshErrors()).not.toEqual({});

    await sm.failCollectionWrites(null);
    await sm.updateCollection(collection!.id, 'manual');
    expect(await sm.getRefreshErrors()).toEqual({});
  });

  test('one collection failing does not stop the others refreshing', async ({ sm }) => {
    // The whole point of not rethrowing out of refreshAllCollections: on
    // an exhausted quota EVERY collection fails, so a first-failure
    // abort would have been the normal case, not the rare one.
    const other = ScriptsDir.create();
    try {
      other.write({
        relativePath: 'second.user.js',
        meta: { name: 'Second', match: ['https://example.org/*'] },
        body: '',
      });
      const a = await sm.addCollection(scriptsDir.path);
      const b = await sm.addCollection(other.path);

      await sm.failCollectionWrites('QUOTA_BYTES quota exceeded');
      // Deliberately NOT caught: the pass records each collection's
      // failure and resolves. Rejecting here would mean the caller
      // couldn't tell a total failure from a partial one, and the
      // collections page would have nothing to repaint from.
      await sm.updateAllCollections('manual');

      // Both were attempted, so both are recorded — neither was skipped
      // because a sibling failed first.
      const errors = await sm.getRefreshErrors();
      expect(Object.keys(errors).sort()).toEqual([a!.id, b!.id].sort());
    } finally {
      other.cleanup();
    }
  });

  test('the collections page shows the section message and the banner', async ({
    extensionContext, extensionId, sm,
  }) => {
    const collection = await sm.addCollection(scriptsDir.path);
    await sm.failCollectionWrites('QUOTA_BYTES quota exceeded');
    await sm.updateCollection(collection!.id, 'manual').catch(() => {});
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/collections.html`);

    const section = page.locator(`section.collection[data-collection-id="${collection!.id}"]`);
    await expect(section.locator('p.error[data-message-kind="refresh"]'))
      .toContainText(SECTION_MESSAGE);
    // Storage is nowhere near full in a test profile, so the banner
    // takes its "some other reason" wording rather than the quota one.
    await expect(page.locator('#storage-banner')).toContainText('could not be saved');
    await expect(page.locator('#storage-banner')).not.toContainText(BANNER);
    await page.close();
  });

  test('the page drops both the message and the banner once it saves', async ({
    extensionContext, extensionId, sm,
  }) => {
    const collection = await sm.addCollection(scriptsDir.path);
    await sm.failCollectionWrites('QUOTA_BYTES quota exceeded');
    await sm.updateCollection(collection!.id, 'manual').catch(() => {});

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/collections.html`);
    await expect(page.locator('#storage-banner')).toBeVisible();

    // No reload: the page is watching `chrome.storage.session`, so the
    // recovery has to reach it on its own.
    await sm.failCollectionWrites(null);
    await sm.updateCollection(collection!.id, 'manual');

    await expect(page.locator('#storage-banner')).toHaveCount(0);
    await expect(
      page.locator(`section.collection[data-collection-id="${collection!.id}"] p.error[data-message-kind="refresh"]`),
    ).toHaveCount(0);
    await page.close();
  });

  // Refresh All must not say less than refreshing the same collection on
  // its own. Once `refreshAllCollections` stopped rethrowing, the catch
  // that used to fan this out became unreachable for a write failure.
  test('Refresh All still logs the failure to every affected script', async ({ sm }) => {
    const collection = await sm.addCollection(scriptsDir.path);
    const script = (await sm.getCollectionWithScripts(collection!.id))!.scripts[0];
    await sm.clearScriptLog(script!.id);

    await sm.failCollectionWrites('QUOTA_BYTES quota exceeded');
    await sm.updateAllCollections('manual');

    const log = await sm.getScriptLog(script!.id);
    const saved = log.filter((e) => e.message.includes('could not be saved'));
    expect(saved.length).toBeGreaterThan(0);
    expect(saved[0]!.message).toContain('QUOTA_BYTES quota exceeded');
  });

  // The single-collection path logs through a different branch, so the
  // two are asserted separately — they are exactly the pair that drifted.
  // Both assert the SHARED sentence, not just the raw reason: asserting
  // only the reason is what let the two wordings diverge unnoticed.
  test('refreshing one collection logs the same sentence Refresh All does', async ({ sm }) => {
    const collection = await sm.addCollection(scriptsDir.path);
    const script = (await sm.getCollectionWithScripts(collection!.id))!.scripts[0];
    await sm.clearScriptLog(script!.id);

    await sm.failCollectionWrites('QUOTA_BYTES quota exceeded');
    await sm.updateCollection(collection!.id, 'manual').catch(() => {});

    const log = await sm.getScriptLog(script!.id);
    const saved = log.filter((e) => e.message.includes(SECTION_MESSAGE));
    expect(saved.length).toBeGreaterThan(0);
    expect(saved[0]!.message).toContain('QUOTA_BYTES quota exceeded');
  });

  // The first thing the original report hit: an add whose refresh
  // couldn't be saved. `addCollection` commits the seeded row before it
  // refreshes, so the collection exists and re-adding would only report
  // a duplicate — the section has to appear with its own message and the
  // Refresh button that is the actual way back.
  //
  // Driven through the SW rather than the page's Add box because
  // `failCollectionWrites` sets a module variable in the SW's copy of
  // script-store, and the collections page runs its own copy in the page
  // context — arming it would not affect a page-driven add. So this
  // covers the recoverable-section half; the `#add-error` line on the
  // page's own Add path is not covered here.
  test('an add whose refresh cannot be saved leaves a recoverable section', async ({
    extensionContext, extensionId, sm,
  }) => {
    await sm.failCollectionWrites('QUOTA_BYTES quota exceeded');
    await sm.addCollection(scriptsDir.path).catch(() => {});

    // The seeded row is committed before the refresh, so the collection
    // exists even though nothing populated it.
    const collections = await sm.getCollections();
    expect(collections).toHaveLength(1);
    const id = collections[0]!.id;
    expect((await sm.getRefreshErrors())[id]).toContain('QUOTA_BYTES quota exceeded');

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/collections.html`);
    const section = page.locator(`section.collection[data-collection-id="${id}"]`);
    await expect(section.locator('p.error[data-message-kind="refresh"]'))
      .toContainText(SECTION_MESSAGE);

    // That section's Refresh is a real way out: once storage accepts
    // writes again, the same button completes what the add started.
    await sm.failCollectionWrites(null);
    await section.getByRole('button', { name: 'Refresh this collection' }).click();
    await expect(section.locator('p.error[data-message-kind="refresh"]')).toHaveCount(0);
    await expect(section.locator('tr[data-script-id]')).toHaveCount(1);
    await page.close();
  });

  test('removing a collection clears its record', async ({ sm }) => {
    const collection = await sm.addCollection(scriptsDir.path);
    await sm.failCollectionWrites('QUOTA_BYTES quota exceeded');
    await sm.updateCollection(collection!.id, 'manual').catch(() => {});
    expect(await sm.getRefreshErrors()).not.toEqual({});

    await sm.failCollectionWrites(null);
    await sm.removeCollection(collection!.id);
    expect(await sm.getRefreshErrors()).toEqual({});
  });
});
