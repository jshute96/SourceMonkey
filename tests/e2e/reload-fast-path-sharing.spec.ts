// Batched navigation-triggered checks: the scripts a page matches are
// usually all in one collection and one folder, so the checks a
// navigation starts share their reads instead of each doing the same
// ones. Both the reload fast path and the opportunistic sweep are
// covered. See docs/injection.md#shared-work-across-the-batch and
// `RefreshBatch` in src/script-store.ts.
//
// The sharing has no behavioural signature by design — same rows, same
// verdicts, same writes — so what these tests assert on is the SW's own
// count of the two things a batch shares: `file://` directory listings
// fetched, and collection rows read. Both halves are pinned, because a
// change that stopped threading the batch into just one of them would
// otherwise leave every test green.

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';
import type { SmApi } from '../fixtures/sw-api';

// Wait until nothing is reading on the batch's behalf any more, then
// zero both counters. The `goto` that precedes a reload kicks off its
// own opportunistic checks, and those are not what these tests measure.
//
// A fixed short interval and three consecutive equal reads, rather than
// `expect.poll`'s growing backoff: with backoff, a quiet gap in the
// middle of a fan-out can satisfy "two reads agreed" and reset the
// counter half way through the work under test.
async function settleAndResetCounters(sm: SmApi): Promise<void> {
  const deadline = Date.now() + 10_000;
  let stable = 0;
  let last = -1;
  while (Date.now() < deadline) {
    const now = await sm.getDirectoryListingFetches() + await sm.getCollectionRowReads();
    stable = now === last ? stable + 1 : 0;
    last = now;
    if (stable >= 3) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  expect(stable, 'counters to stop moving before the measured window').toBeGreaterThanOrEqual(3);
  await sm.resetDirectoryListingFetches();
  await sm.resetCollectionRowReads();
}

// Both halves of what a `RefreshBatch` shares, as the SW counted them.
async function shared(sm: SmApi): Promise<{ listings: number; collectionRows: number }> {
  return {
    listings: await sm.getDirectoryListingFetches(),
    collectionRows: await sm.getCollectionRowReads(),
  };
}

test.describe('navigation refresh work sharing', () => {
  let scriptsDir: ScriptsDir;
  test.beforeEach(() => { scriptsDir = ScriptsDir.create(); });
  test.afterEach(() => { scriptsDir.cleanup(); });

  test('scripts sharing a folder read it once for the batch', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    // Three scripts, one collection, one folder — the shape the
    // measurement that motivated the batch was taken on. Each appends
    // to document.title so the test can tell all three ran.
    for (const n of ['one', 'two', 'three']) {
      scriptsDir.write({
        relativePath: `${n}.user.js`,
        meta: {
          name: n,
          match: [`${fixtureServer.baseUrl}/*`],
          runAt: 'document-end',
          injectInto: 'content',
        },
        body: `document.title = (document.title || '') + '-${n}';`,
      });
    }
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page).toHaveTitle(/-one/);
    await expect(page).toHaveTitle(/-three/);

    await settleAndResetCounters(sm);
    await page.reload();
    await expect(page).toHaveTitle(/-three/);

    // One listing AND one collection-row read for three checks. Without
    // the shared batch both are 3 — once per script, of the same
    // directory and the same row.
    await expect.poll(
      () => shared(sm),
      { message: 'the batch to finish its checks' },
    ).toEqual({ listings: 1, collectionRows: 1 });
    // And they stay there: nothing re-reads after the batch settles.
    expect(await shared(sm)).toEqual({ listings: 1, collectionRows: 1 });
    await page.close();
  });

  test('a shared listing still detects a per-script edit', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    // The sharing must not cost the fast path its whole point. Two
    // scripts in one folder, one of them edited between the load and
    // the reload: the shared listing has to carry a size/mtime per
    // FILE, so the edited one refetches and swaps while its sibling
    // takes the unchanged skip.
    for (const n of ['edited', 'stable']) {
      scriptsDir.write({
        relativePath: `${n}.user.js`,
        meta: {
          name: n,
          match: [`${fixtureServer.baseUrl}/*`],
          runAt: 'document-end',
          injectInto: 'content',
        },
        body: `document.title = (document.title || '') + '-${n}v1';`,
      });
    }
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page).toHaveTitle(/-editedv1/);
    await expect(page).toHaveTitle(/-stablev1/);

    await settleAndResetCounters(sm);
    scriptsDir.rewriteBody(
      'edited.user.js',
      `document.title = (document.title || '') + '-editedv2';`,
    );
    await page.reload();
    // v2 for the edited one on THIS reload, v1 for its sibling.
    await expect(page).toHaveTitle(/-editedv2/);
    await expect(page).toHaveTitle(/-stablev1/);
    await expect.poll(
      () => shared(sm),
      { message: 'the batch to finish its checks' },
    ).toEqual({ listings: 1, collectionRows: 1 });
    await page.close();
  });

  test('a first-visit navigation shares its reads too', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    // The opportunistic sweep, on its own. A plain navigation (no
    // reload) sets up no fast path, so `requestOpportunisticScriptChecks`
    // is the only fan-out — and on a FIRST visit nothing has completed
    // yet, so the cooldown doesn't short-circuit it and every check does
    // real work.
    //
    // This is the path that would regress silently: it has no wrapper
    // waiting on it and no user-visible outcome, so nothing but this
    // count would notice it going back to one listing and one row read
    // per script.
    for (const n of ['alpha', 'beta', 'gamma']) {
      scriptsDir.write({
        relativePath: `${n}.user.js`,
        meta: {
          name: n,
          match: [`${fixtureServer.baseUrl}/*`],
          runAt: 'document-end',
          injectInto: 'content',
        },
        body: `document.title = (document.title || '') + '-${n}';`,
      });
    }
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();
    // After the add's own scan, before the navigation under test.
    await settleAndResetCounters(sm);

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page).toHaveTitle(/-gamma/);

    await expect.poll(
      () => shared(sm),
      { message: 'the opportunistic sweep to finish' },
    ).toEqual({ listings: 1, collectionRows: 1 });
    expect(await shared(sm)).toEqual({ listings: 1, collectionRows: 1 });
    await page.close();
  });

  test('a reload past the cooldown still costs one listing and one row read', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    // The reload is deliberately more than UPDATE_MIN_INTERVAL_MS after
    // the first visit, so the opportunistic sweep is NOT rate-limited
    // out and both of the commit's fan-outs are live at once. That gap
    // is the ordinary edit-save-reload rhythm.
    //
    // **What this pins is the total, not the mechanism.** It cannot
    // distinguish "both fan-outs share one batch" from "a batch each":
    // the fast path reaches `gate()` first here, so the sweep's calls
    // coalesce onto its in-flight checks and do no reads of their own
    // whichever batch they hold. Verified by construction — giving the
    // sweep a separate batch leaves this test green.
    //
    // The sweep's own batching is pinned by the first-visit case above,
    // where there is no fast path to coalesce onto. This one guards the
    // number the user actually pays.
    for (const n of ['one', 'two', 'three']) {
      scriptsDir.write({
        relativePath: `${n}.user.js`,
        meta: {
          name: n,
          match: [`${fixtureServer.baseUrl}/*`],
          runAt: 'document-end',
          injectInto: 'content',
        },
        body: `document.title = (document.title || '') + '-${n}';`,
      });
    }
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page).toHaveTitle(/-three/);
    await settleAndResetCounters(sm);

    // Past the opportunistic cooldown (UPDATE_MIN_INTERVAL_MS, 10s).
    await page.waitForTimeout(11_000);
    await settleAndResetCounters(sm);

    await page.reload();
    await expect(page).toHaveTitle(/-three/);
    await expect.poll(
      () => shared(sm),
      { message: 'both fan-outs to finish' },
    ).toEqual({ listings: 1, collectionRows: 1 });
    expect(await shared(sm)).toEqual({ listings: 1, collectionRows: 1 });
    await page.close();
  });

  test('a single-script page reads once, batch or no batch', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    // The control. A batch of one has nothing to share, so this is the
    // number the multi-script cases are being brought down to.
    scriptsDir.write({
      relativePath: 'solo.user.js',
      meta: {
        name: 'Solo',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        injectInto: 'content',
      },
      body: `document.title = 'solo';`,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page).toHaveTitle('solo');

    await settleAndResetCounters(sm);
    await page.reload();
    await expect(page).toHaveTitle('solo');
    await expect.poll(
      () => shared(sm),
      { message: 'the check to finish' },
    ).toEqual({ listings: 1, collectionRows: 1 });
    await page.close();
  });
});
