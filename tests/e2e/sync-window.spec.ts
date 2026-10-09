// The registration sync must never leave a live script unregistered.
//
// The sync used to be a full wipe-and-replace: unregister everything,
// then register everything back. Those are two separate awaits, so
// between them Chrome held no userscripts at all — and that window
// opened after EVERY script-row write, i.e. after every edit the user
// reloads for. A document created inside it ran nothing: no error, no
// badge, no Log row, just a page where the script silently didn't run.
//
// It is now incremental — only the rows that moved are rebuilt, and a
// script that is staying registered is UPDATED in place rather than
// dropped and re-added. These tests pin the user-visible half of that.
// The operation-order half (never unregister an id that is staying) is
// pinned deterministically in tests/unit/injector.test.mjs.

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';

// Enough scripts that a full re-registration takes real time. With the
// wipe-and-replace sync this is what made the window wide enough to
// hit reliably; with the incremental one the count is irrelevant, which
// is itself the point.
const FILLER_SCRIPTS = 30;

// A body with some bulk to it, and no repeated declarations — 200
// copies of one `const` line is a duplicate declaration, which the
// parse check would (correctly) refuse to register.
function fillerBody(i: number): string {
  return Array.from({ length: 200 }, (_, n) => `const v${i}_${n} = ${n};`).join('\n');
}
const RACES = 8;

test.describe('registration sync window', () => {
  let scriptsDir: ScriptsDir;

  test.beforeEach(() => { scriptsDir = ScriptsDir.create(); });
  test.afterEach(() => { scriptsDir.cleanup(); });

  test('a navigation racing a sync still gets its script injected', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    // The script under test. Nothing in this test ever edits it, so an
    // incremental sync has no reason to touch its registration at all.
    scriptsDir.write({
      relativePath: 'mark.user.js',
      meta: {
        name: 'Mark Target',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
      },
      body: `document.getElementById('target').textContent = 'injected';`,
    });
    // Filler, so the sync each edit triggers has real work to do.
    for (let i = 0; i < FILLER_SCRIPTS; i++) {
      scriptsDir.write({
        relativePath: `filler-${i}.user.js`,
        meta: { name: `Filler ${i}`, match: ['https://filler.invalid/*'] },
        body: fillerBody(i),
      });
    }
    const collection = await sm.addCollection(scriptsDir.path);
    expect(collection).not.toBeNull();
    await sm.syncNow();

    const page = await extensionContext.newPage();
    const kinds = new Set<string>();
    for (let round = 0; round < RACES; round++) {
      // Edit a DIFFERENT script and let its sync start, then navigate
      // WITHOUT waiting for it. The document is created while the sync
      // is mid-flight; `mark.user.js` must still run, because nothing
      // about it changed.
      scriptsDir.rewriteBody('filler-0.user.js', `const round = ${round};\n`);
      await sm.updateCollection(collection!.id, 'manual');
      const syncing = sm.syncNow();
      await page.goto(`${fixtureServer.baseUrl}/target.html`);
      await expect(page.locator('#target')).toHaveText('injected');
      kinds.add((await syncing).kind ?? 'none');
    }
    // Which path ran is not observable from the registration set —
    // both leave the same one — so the test asserts it rather than
    // implying it. Whether the 50 ms debounce drained the scope before
    // `syncNow` reached it is a race, but the answer is incremental
    // either way: a drained scope is an EMPTY scope, not a request to
    // reconcile everything. (Reading it as the latter is what wrote a
    // second identical Log row for an already-refused script — see
    // tests/e2e/rejected-registration.spec.ts.)
    expect([...kinds]).toEqual(['incremental']);
    await page.close();
  });

  test('the registration set never empties out during a sync', async ({
    fixtureServer, sm, getServiceWorker,
  }) => {
    scriptsDir.write({
      relativePath: 'mark.user.js',
      meta: { name: 'Mark Target', match: [`${fixtureServer.baseUrl}/*`] },
      body: 'void 0;',
    });
    for (let i = 0; i < FILLER_SCRIPTS; i++) {
      scriptsDir.write({
        relativePath: `filler-${i}.user.js`,
        meta: { name: `Filler ${i}`, match: ['https://filler.invalid/*'] },
        body: fillerBody(i),
      });
    }
    const collection = await sm.addCollection(scriptsDir.path);
    await sm.syncNow();
    const before = (await sm.syncNow()).registered.length;
    expect(before).toBeGreaterThan(FILLER_SCRIPTS);

    // Sample the registration set from inside the worker while a sync
    // runs. The worker is single-threaded, so each sample lands at one
    // of the sync's await points — exactly where the old wipe left the
    // set empty.
    // Write the row and sync inside ONE worker task, so the 50 ms
    // debounce cannot drain the scope in between: this pins the
    // INCREMENTAL path, which is the one every ordinary edit takes.
    const scriptId = (await sm.getCollectionWithScripts(collection!.id))!
      .scripts.find((s) => s.relativePath.endsWith('filler-0.user.js'))!.id;
    const sw = await getServiceWorker();
    const result = await sw.evaluate(async ([expected, id]: [number, string]) => {
      const api = (self as unknown as {
        SourceMonkey: { syncNow(): Promise<{ kind: string | null }> };
      }).SourceMonkey;
      const key = `script:${id}`;
      const row = (await chrome.storage.local.get(key))[key] as Record<string, unknown>;
      // An inline body, which reads as it is in place of the row's blob.
      await chrome.storage.local.set({ [key]: { ...row, bodyBlobRef: undefined, bodyText: 'const edited = 1;' } });
      // Sample the registration set while the sync runs. The worker is
      // single-threaded, so each sample lands at one of the sync's
      // await points — exactly where the old wipe left the set empty.
      let low = expected;
      let sampling = true;
      const sample = async (): Promise<void> => {
        while (sampling) {
          low = Math.min(low, (await chrome.userScripts.getScripts()).length);
        }
      };
      const sampler = sample();
      const { kind } = await api.syncNow();
      sampling = false;
      await sampler;
      return { low, kind };
    }, [before, scriptId] as [number, string]);

    expect(result.kind).toBe('incremental');
    expect(result.low).toBe(before);
  });
});
