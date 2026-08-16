// The reload fast-path answers the wrapper WITHOUT waiting for the
// compile-only parse check, then runs the check against the row it
// stored. See docs/injection.md#reload-fast-path and
// docs/parse-check.md#deferring-the-check-on-the-reload-fast-path.
//
// Two things have to hold at once, and they pull in opposite
// directions:
//   - a fresh body reaches the page on ONE reload, even though the
//     check for it has not come back yet, and
//   - the verdict still lands on the stored row afterwards.
//
// The syntax-error case is the sharp edge, and it is pinned here on
// purpose: a broken edit IS swapped in, throws in the page, and the
// row goes `invalid` moments later.

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';
import { waitFor, waitForTabState, type StoredScriptLike } from '../fixtures/sw-api';

test.describe('reload fast-path: deferred parse check', () => {
  let scriptsDir: ScriptsDir;
  test.beforeEach(() => { scriptsDir = ScriptsDir.create(); });
  test.afterEach(() => { scriptsDir.cleanup(); });

  // The single script of the single collection, read back from storage.
  async function storedScript(sm: {
    getCollections: () => Promise<{ id: string }[]>;
    getCollectionWithScripts: (id: string) => Promise<{ scripts: StoredScriptLike[] } | null>;
  }): Promise<StoredScriptLike> {
    const [collection] = await sm.getCollections();
    const withScripts = await sm.getCollectionWithScripts(collection.id);
    return withScripts!.scripts[0];
  }

  test('an edited body swaps in on one reload and is parse-checked afterwards', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    // `injectInto: 'content'` forces USER_SCRIPT world, which is what
    // gives the wrapper a direct sm:check-pending channel — same
    // reason as in reload-fast-path.spec.ts.
    scriptsDir.write({
      relativePath: 'live.user.js',
      meta: {
        name: 'DeferredOk',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        injectInto: 'content',
      },
      body: `document.title = 'v1';`,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page).toHaveTitle('v1');

    // The install already checked v1, so the count taken here is what
    // separates "the check ran again for v2" from "it never ran".
    const runsBeforeEdit = await sm.getParseCheckRuns();
    scriptsDir.rewriteBody('live.user.js', `document.title = 'v2';`);

    await page.reload();
    // The swap happened on THIS reload — the reply didn't wait for a
    // verdict on v2's source.
    await expect(page).toHaveTitle('v2');

    // ...and the verdict lands anyway, on the row that was written.
    const runsAfter = await waitFor(
      () => sm.getParseCheckRuns(),
      (n) => n > runsBeforeEdit,
      { label: 'deferred parse check ran for the new content' },
    );
    expect(runsAfter).toBeGreaterThan(runsBeforeEdit);

    // Exactly one compile for the new bytes, counted after a quiescing
    // step rather than at the moment the counter first moved — a
    // duplicate arriving a beat later is the failure `inFlightChecks`
    // exists to prevent, and `waitFor` returns before it would land.
    // `syncNow` is the step: it drives the registration gate, which
    // looks at the same row and must either find the verdict recorded
    // or join the check still in flight for that fingerprint. See
    // docs/parse-check.md#one-compile-not-two.
    //
    // Which of those two it takes is not pinned here, and locally it is
    // always the first: a warm offscreen document compiles one small
    // script faster than the 50 ms storage-write debounce that
    // schedules the sync. The join is what covers the case where it
    // isn't — a cold document, or the whole-library recheck after an
    // extension update — and this asserts the outcome both must produce.
    await sm.syncNow();
    expect(await sm.getParseCheckRuns()).toBe(runsBeforeEdit + 1);
    const row = await waitFor(
      () => storedScript(sm),
      (s) => Boolean(s.parseCheckedHash),
      { label: 'deferred verdict recorded on the row' },
    );
    expect(row.status).toBe('ok');
    await page.close();
  });

  test('an edit that does not parse is swapped in, then flips the row to invalid', async ({
    extensionContext, fixtureServer, sm, getServiceWorker,
  }) => {
    scriptsDir.write({
      relativePath: 'live.user.js',
      meta: {
        name: 'DeferredBroken',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        injectInto: 'content',
      },
      body: `document.title = 'v1';`,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page).toHaveTitle('v1');
    const sw = await getServiceWorker();
    const tabId = await sw.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tab?.id) throw new Error('no active tab');
      return tab.id;
    });

    // A syntax error, so the whole swapped program fails to compile —
    // the title assignment above it never runs either.
    scriptsDir.rewriteBody('live.user.js', `document.title = 'v2'; const x = (;`);
    await page.reload();

    // The wrapper reports the swap AND the throw the swapped body
    // produced: it was handed the broken body rather than being told
    // to keep running v1.
    const state = await waitForTabState(
      sm, tabId,
      (s) => {
        const doc = s.record?.byDoc?.[s.record.currentDocId];
        return Object.values(doc?.actual ?? {}).some((a) => a.state === 'error');
      },
      'swapped body reported its syntax error',
    );
    expect(state.record).toBeTruthy();
    // v1's assignment is gone and v2's never ran, so the title is
    // whatever the page itself set.
    await expect(page).not.toHaveTitle('v2');

    // The deferred verdict lands on the stored row, so the collections
    // page says why and the next sync won't register it.
    const row = await waitFor(
      () => storedScript(sm),
      (s) => s.status === 'invalid',
      { label: 'deferred verdict flipped the row to invalid' },
    );
    expect(row.errorMessage).toMatch(/syntax error/i);
    expect(row.parseCheckedHash).toBeUndefined();

    // ...and it is explained in the Log, not just in the badge.
    // `source: 'parser'` is the verdict's own entry: the in-page
    // `sm:error` from the swapped body lands in this same log, so
    // matching any error-level row would pass even if the verdict
    // stopped writing one. The startup-log replay shares that source,
    // but this script declares no header diagnostics, so nothing else
    // here can produce a parse-flavoured `parser` row.
    const log = await waitFor(
      () => sm.getScriptLog(row.id),
      (entries) => entries.some(
        (e) => e.source === 'parser' && e.level === 'error' && /syntax error/i.test(e.message),
      ),
      { label: 'parser-source log entry for the deferred verdict' },
    );
    expect(log.length).toBeGreaterThan(0);

    // The verdict has to reach the REGISTRATION set too, not just the
    // row. A sync that hands Chrome a body it has already judged
    // unparsable raises an uncatchable SyntaxError against the
    // extension — see docs/parse-check.md#the-gate-before-registration.
    const synced = await sm.syncNow();
    expect(synced.registered.map((r) => r.id)).not.toContain(row.id);

    // And nothing is injected on the next navigation: not the broken
    // body, and not the previous one either.
    const after = await extensionContext.newPage();
    await after.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(after).toHaveTitle('target');
    await after.close();
    await page.close();
  });
});
