// Membership between a collection and its scripts is stored twice —
// `collection.scriptIds` (what the collections page renders and what a
// refresh iterates) and `script.collectionId` (what the viewer and the
// injector read). When those two disagree the script is half-visible:
// unlisted by the collection it names, it still injects and still opens
// in the viewer but never appears on the collections page and is never
// refreshed again; listed by a collection it doesn't name, it shows up
// somewhere it doesn't belong.
//
// Two halves here: the refresh write no longer creates a disagreement
// in either direction, and the sweep repairs the ones older builds left
// behind.
//
// The race tests start a refresh, wait for its fetch to actually reach
// the server, then land the mutation while a `delayMs` route holds that
// fetch open. Waiting on the request is what makes the interleaving
// real rather than assumed: by the time it arrives, the refresh has
// taken the snapshot the mutation has to survive.

import { test, expect } from '../fixtures/extension';
import { UserscriptServer, userscriptText } from '../fixtures/userscript-server';

test.describe('collection membership', () => {
  let server: UserscriptServer;
  test.beforeEach(async () => {
    server = await UserscriptServer.start();
  });
  test.afterEach(async () => {
    await server.stop();
  });

  test('a move that lands mid-refresh survives the refresh write', async ({ sm }) => {
    server.setRoute('/slow.user.js', userscriptText('Slow'));
    server.setRoute('/moved.user.js', userscriptText('Moved'));

    const dest = (await sm.createCollection({ kind: 'scripts', name: 'Destination' }))!;
    const from = (await sm.createCollection({ kind: 'scripts', name: 'Origin' }))!;
    await sm.installScript(`${server.baseUrl}/slow.user.js`, { collectionId: dest.id });
    await sm.installScript(`${server.baseUrl}/moved.user.js`, { collectionId: from.id });
    const movedId = (await sm.getCollectionWithScripts(from.id))!.scripts[0].id;

    // Hold the destination's own fetch open so the move lands between
    // the refresh's read and its write — the window that used to erase
    // the moved row's id from `scriptIds`.
    server.setRoute('/slow.user.js', userscriptText('Slow', ' // v2'), { delayMs: 1500 });
    const refreshing = sm.updateCollection(dest.id, 'manual');
    await server.waitForRequest('/slow.user.js');
    await sm.moveScript(movedId, { collectionId: dest.id });
    await refreshing;

    const after = (await sm.getCollectionWithScripts(dest.id))!;
    expect(after.collection.scriptIds).toContain(movedId);
    expect(after.scripts.map((s) => s.id)).toContain(movedId);
    // And the collection it left doesn't still claim it.
    expect((await sm.getCollectionWithScripts(from.id))!.collection.scriptIds)
      .not.toContain(movedId);
  });

  test('a move OUT that lands mid-refresh is not reverted', async ({ sm }) => {
    server.setRoute('/slow.user.js', userscriptText('Slow'));
    server.setRoute('/leaving.user.js', userscriptText('Leaving'));

    const from = (await sm.createCollection({ kind: 'scripts', name: 'Origin' }))!;
    const dest = (await sm.createCollection({ kind: 'scripts', name: 'Destination' }))!;
    await sm.installScript(`${server.baseUrl}/slow.user.js`, { collectionId: from.id });
    await sm.installScript(`${server.baseUrl}/leaving.user.js`, { collectionId: from.id });
    const movedId = (await sm.getCollectionWithScripts(from.id))!.collection.scriptIds[1];

    // The mirror of the test above: this time the refresh is of the
    // collection the script LEAVES, and its rebuilt rows still say the
    // script is here. Writing them back would revert the move and leave
    // both collections listing the row.
    server.setRoute('/slow.user.js', userscriptText('Slow', ' // v2'), { delayMs: 1500 });
    const refreshing = sm.updateCollection(from.id, 'manual');
    await server.waitForRequest('/slow.user.js');
    await sm.moveScript(movedId, { collectionId: dest.id });
    await refreshing;

    expect((await sm.getCollectionWithScripts(from.id))!.collection.scriptIds)
      .not.toContain(movedId);
    const after = (await sm.getCollectionWithScripts(dest.id))!;
    expect(after.collection.scriptIds).toContain(movedId);
    expect(after.scripts.find((s) => s.id === movedId)?.collectionId).toBe(dest.id);
  });

  test('a removal that lands mid-refresh is not resurrected', async ({ sm }) => {
    server.setRoute('/slow.user.js', userscriptText('Slow'));
    server.setRoute('/doomed.user.js', userscriptText('Doomed'));

    const collection = (await sm.createCollection({ kind: 'scripts', name: 'Mine' }))!;
    await sm.installScript(`${server.baseUrl}/slow.user.js`, { collectionId: collection.id });
    await sm.installScript(`${server.baseUrl}/doomed.user.js`, { collectionId: collection.id });
    const doomedId = (await sm.getCollectionWithScripts(collection.id))!.collection.scriptIds[1];

    server.setRoute('/slow.user.js', userscriptText('Slow', ' // v2'), { delayMs: 1500 });
    const refreshing = sm.updateCollection(collection.id, 'manual');
    await server.waitForRequest('/slow.user.js');
    await sm.removeScript(doomedId);
    await refreshing;

    const after = (await sm.getCollectionWithScripts(collection.id))!;
    expect(after.collection.scriptIds).not.toContain(doomedId);
    expect(after.scripts.map((s) => s.id)).not.toContain(doomedId);
  });

  test('the sweep re-links a row no collection lists', async ({ sm, getServiceWorker }) => {
    server.setRoute('/one.user.js', userscriptText('One'));
    server.setRoute('/two.user.js', userscriptText('Two'));
    const collection = (await sm.createCollection({ kind: 'scripts', name: 'Mine' }))!;
    await sm.installScript(`${server.baseUrl}/one.user.js`, { collectionId: collection.id });
    await sm.installScript(`${server.baseUrl}/two.user.js`, { collectionId: collection.id });
    const before = (await sm.getCollectionWithScripts(collection.id))!;
    const orphanId = before.collection.scriptIds[1];

    // Stage the damage an older build's racing refresh left: the id
    // gone from the list, the row itself untouched.
    const sw = await getServiceWorker();
    await sw.evaluate(async ([cid, sid]) => {
      const key = `collection:${cid}`;
      const row = (await chrome.storage.local.get(key))[key] as { scriptIds: string[] };
      row.scriptIds = row.scriptIds.filter((id) => id !== sid);
      await chrome.storage.local.set({ [key]: row });
    }, [collection.id, orphanId]);
    expect((await sm.getCollectionWithScripts(collection.id))!.scripts).toHaveLength(1);

    expect(await sm.reconcileScriptMembership()).toBe(1);

    const healed = (await sm.getCollectionWithScripts(collection.id))!;
    expect(healed.collection.scriptIds).toContain(orphanId);
    expect(healed.scripts.map((s) => s.id)).toContain(orphanId);
    // Idempotent: a healthy profile is left alone.
    expect(await sm.reconcileScriptMembership()).toBe(0);
  });

  test('opening the collections page repairs the profile', async ({
    extensionContext, extensionId, sm, getServiceWorker,
  }) => {
    server.setRoute('/one.user.js', userscriptText('One'));
    server.setRoute('/two.user.js', userscriptText('Two'));
    const collection = (await sm.createCollection({ kind: 'scripts', name: 'Mine' }))!;
    await sm.installScript(`${server.baseUrl}/one.user.js`, { collectionId: collection.id });
    await sm.installScript(`${server.baseUrl}/two.user.js`, { collectionId: collection.id });
    const orphanId = (await sm.getCollectionWithScripts(collection.id))!.collection.scriptIds[1];

    const sw = await getServiceWorker();
    await sw.evaluate(async ([cid, sid]) => {
      const key = `collection:${cid}`;
      const row = (await chrome.storage.local.get(key))[key] as { scriptIds: string[] };
      row.scriptIds = row.scriptIds.filter((id) => id !== sid);
      await chrome.storage.local.set({ [key]: row });
    }, [collection.id, orphanId]);

    // No explicit call: the page's own render is the trigger, and the
    // row it repairs has to be on screen by the time it finishes.
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/collections.html`);
    await expect(page.locator(`tr[data-script-id="${orphanId}"]`)).toBeVisible();
    expect((await sm.getCollectionWithScripts(collection.id))!.collection.scriptIds)
      .toContain(orphanId);
    await page.close();
  });

  test('the sweep drops a listing from a collection the row does not name', async ({
    sm, getServiceWorker,
  }) => {
    server.setRoute('/one.user.js', userscriptText('One'));
    const mine = (await sm.createCollection({ kind: 'scripts', name: 'Mine' }))!;
    const other = (await sm.createCollection({ kind: 'scripts', name: 'Other' }))!;
    await sm.installScript(`${server.baseUrl}/one.user.js`, { collectionId: mine.id });
    const scriptId = (await sm.getCollectionWithScripts(mine.id))!.collection.scriptIds[0];

    // Stage the double-listing an older build's refresh could leave
    // behind when a move raced it: the row names `mine`, but `other`
    // claims it too, so it renders under both.
    const sw = await getServiceWorker();
    await sw.evaluate(async ([cid, sid]) => {
      const key = `collection:${cid}`;
      const row = (await chrome.storage.local.get(key))[key] as { scriptIds: string[] };
      row.scriptIds = [...row.scriptIds, sid];
      await chrome.storage.local.set({ [key]: row });
    }, [other.id, scriptId]);
    expect((await sm.getCollectionWithScripts(other.id))!.scripts).toHaveLength(1);

    expect(await sm.reconcileScriptMembership()).toBe(1);

    expect((await sm.getCollectionWithScripts(other.id))!.collection.scriptIds).toEqual([]);
    expect((await sm.getCollectionWithScripts(mine.id))!.collection.scriptIds).toContain(scriptId);
  });
});
