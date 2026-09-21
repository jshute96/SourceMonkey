// End-to-end coverage of the REJECTED state: a script we loaded and
// validated happily, that `chrome.userScripts.register` then refuses.
//
// The gap is real, and deliberately narrower than it used to be.
// `matchPatternProblem` (src/url-match.ts) now reproduces the shapes of
// Chrome's match-pattern grammar we are sure about — a missing path, a
// bad scheme, an empty host, a misplaced host wildcard — so those are
// caught at parse time and never reach a registration. What it does NOT
// reproduce is the rest of Chrome's parser, because a false positive
// there would drop a pattern that works.
//
// A malformed port is one of those: `@match https://rejected.example:notaport/*`
// passes our check, and Chrome answers
//   "Script with ID <id> has invalid value for matches[0]: Invalid port".
// That is what this suite provokes with, and any other refusal Chrome
// grows tomorrow lands on the same path.
//
// What that must produce:
//   - the script row stays `status: 'ok'` (nothing about the LOAD
//     failed) but displays REJECTED, because it never runs;
//   - the reason is in the script's Log, and in the status cell's
//     hover text;
//   - other scripts in the same collection still register — the per-script
//     fallback in registerWithFallback exists for exactly this;
//   - every re-attempt says so again — a Refresh, or a "Clear log"
//     followed by one, must not leave a REJECTED row with nothing
//     explaining it;
//   - fixing the pattern clears the state with no further user action.

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';
import { waitForTabState } from '../fixtures/sw-api';

// Chrome's own wording for the failure this suite provokes. Matched
// loosely (the id and index vary) so a Chrome rephrasing doesn't fail
// the suite for the wrong reason.
const INVALID_PORT = /Invalid port/i;

// Valid to us, refused by Chrome — see the header. Keep this a pattern
// `matchPatternProblem` accepts, or the script lands INVALID at load
// time and never gets as far as a registration to be refused.
const BAD_PATTERN = 'https://rejected.example:notaport/*';

test.describe('rejected registrations', () => {
  let dir: ScriptsDir;
  test.beforeEach(() => { dir = ScriptsDir.create('sourcemonkey-rejected-'); });
  test.afterEach(() => { dir.cleanup(); });

  function writeBad(body = 'console.log("bad");\n'): void {
    dir.write({
      relativePath: 'bad-match.user.js',
      meta: { name: 'Bad Match', match: [BAD_PATTERN] },
      body,
    });
  }

  function writeGood(): void {
    dir.write({
      relativePath: 'good-match.user.js',
      meta: { name: 'Good Match', match: ['https://accepted.example/*'] },
      body: 'console.log("good");\n',
    });
  }

  test('a script Chrome refuses is recorded as rejected, not as a load failure', async ({ sm }) => {
    writeBad();
    writeGood();
    const collection = await sm.addCollection(dir.path);
    const sync = await sm.syncNow();

    const scripts = (await sm.getCollectionWithScripts(collection!.id))!.scripts;
    const bad = scripts.find((s) => s.relativePath === 'bad-match.user.js')!;
    const good = scripts.find((s) => s.relativePath === 'good-match.user.js')!;

    // The load succeeded — this is the whole point of a separate state.
    expect(bad.status).toBe('ok');
    expect(bad.errorMessage).toBeUndefined();
    expect(bad.refreshError).toBeUndefined();

    // But Chrome refused it, and says why.
    const rejections = await sm.getRejections();
    expect(Object.keys(rejections)).toEqual([bad.id]);
    expect(rejections[bad.id]).toMatch(INVALID_PORT);

    // The good sibling still registered: one bad pattern must not take
    // the whole batch down.
    expect(sync.registered.map((r) => r.id)).toContain(good.id);
    expect(sync.registered.map((r) => r.id)).not.toContain(bad.id);
  });

  test('the reason lands in the script Log', async ({ sm }) => {
    writeBad();
    const collection = await sm.addCollection(dir.path);
    await sm.syncNow();
    const bad = (await sm.getCollectionWithScripts(collection!.id))!.scripts[0];

    const log = await sm.getScriptLog(bad.id);
    const rows = log.filter((e) => e.source === 'chrome-injector');
    expect(rows).toHaveLength(1);
    expect(rows[0].level).toBe('error');
    expect(rows[0].message).toMatch(/Chrome rejected this script's registration/);
    expect(rows[0].message).toMatch(INVALID_PORT);
  });

  test('a sync with nothing to do does not re-report the refusal', async ({ sm }) => {
    // Every refused ATTEMPT gets a Log row, and that rule is right — a
    // suppressed retry is indistinguishable from no retry. What must
    // not happen is two attempts for one change.
    //
    // The pair that produced them: the debounced sync lands first and
    // drains the accumulated scope, then `syncNow` finds nothing
    // pending. Reading that as "reconcile everything" made it rebuild
    // and re-offer a spec Chrome had just refused, for a script nothing
    // had touched since. Nothing pending means nothing changed.
    writeBad();
    const collection = await sm.addCollection(dir.path);
    // Longer than scheduleSync's 50 ms debounce, so the automatic sync
    // has certainly landed before syncNow asks for another.
    await new Promise((r) => setTimeout(r, 400));
    const second = await sm.syncNow();
    expect(second.kind).toBe('incremental');

    const bad = (await sm.getCollectionWithScripts(collection!.id))!.scripts[0];
    const rows = (await sm.getScriptLog(bad.id)).filter((e) => e.source === 'chrome-injector');
    expect(rows).toHaveLength(1);
    // And the state it describes is untouched.
    expect(Object.keys(await sm.getRejections())).toEqual([bad.id]);
  });

  type SmForLog = { getScriptLog(id: string): Promise<{ source: string }[]> };

  async function rejectionRows(sm: SmForLog, id: string) {
    return (await sm.getScriptLog(id)).filter((e) => e.source === 'chrome-injector');
  }

  // NOTE: these must NOT call syncNow(). The whole point is that a
  // Refresh drives the retry on its own. An explicit sync would pass
  // even with the retry hook removed — which is exactly how the first
  // version of this suite missed the bug.
  //
  // The retry is fire-and-forget (it can't sit in the reload
  // fast-path's 500 ms window), so the assertion polls.
  const pollRows = (sm: SmForLog, id: string) =>
    expect.poll(async () => (await rejectionRows(sm, id)).length, { timeout: 5000 });

  test('a Refresh that changes nothing still retries, and reports it', async ({ sm }) => {
    // The user-visible bug this covers: a refresh with no content
    // change writes an identical row, so Chrome fires no
    // storage.onChanged, so the normal onCacheChanged → sync path never
    // runs. Without an explicit retry the spec is never re-offered and
    // the Log stays silent while the row still reads REJECTED.
    writeBad();
    const collection = await sm.addCollection(dir.path);
    await sm.syncNow();
    const bad = (await sm.getCollectionWithScripts(collection!.id))!.scripts[0];
    expect(Object.keys(await sm.getRejections())).toEqual([bad.id]);
    expect(await rejectionRows(sm, bad.id)).toHaveLength(1);

    // 'force' is what a real Refresh click passes, and it bypasses the
    // retry rate limit — so back-to-back clicks each get an answer.
    await sm.updateScript(bad.id, 'manual', 'force');
    await pollRows(sm, bad.id).toBe(2);

    // Same again with an actual edit that doesn't fix the pattern.
    // At least one more row — an edit changes the content, which also
    // fires storage.onChanged → a full sync, and that sync makes its
    // own real attempt. Two attempts, two rows; asserting an exact
    // count here would race the sync.
    dir.rewriteBody('bad-match.user.js', 'console.log("edited");\n');
    await sm.updateScript(bad.id, 'manual', 'force');
    await pollRows(sm, bad.id).toBeGreaterThanOrEqual(3);

    const after = (await sm.getCollectionWithScripts(collection!.id))!.scripts[0];
    expect(after.bodyText).toContain('edited');
    expect(after.status).toBe('ok');
    expect(Object.keys(await sm.getRejections())).toEqual([bad.id]);
  });

  test('refreshing the collection retries too', async ({ sm }) => {
    writeBad();
    const collection = await sm.addCollection(dir.path);
    await sm.syncNow();
    const bad = (await sm.getCollectionWithScripts(collection!.id))!.scripts[0];
    expect(await rejectionRows(sm, bad.id)).toHaveLength(1);

    await sm.updateCollection(collection!.id, 'manual');
    await pollRows(sm, bad.id).toBe(2);

    await sm.updateAllCollections('manual');
    await pollRows(sm, bad.id).toBe(3);
  });

  test('loading a page the script matches retries and reports', async ({
    sm, extensionContext, fixtureServer,
  }) => {
    // Two patterns: one Chrome accepts (so our matcher fires on the
    // fixture page) and one it doesn't (so the spec as a whole is
    // refused). Visiting a matching page runs a check for the script,
    // which is the other place the user expects to hear about it — the
    // page is right there showing the script never ran.
    dir.write({
      relativePath: 'bad-match.user.js',
      meta: {
        name: 'Bad Match',
        match: [`${fixtureServer.baseUrl}/*`, BAD_PATTERN],
      },
      body: 'console.log("bad");\n',
    });
    const collection = await sm.addCollection(dir.path);
    await sm.syncNow();
    const bad = (await sm.getCollectionWithScripts(collection!.id))!.scripts[0];
    expect(Object.keys(await sm.getRejections())).toEqual([bad.id]);
    const before = (await rejectionRows(sm, bad.id)).length;

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await pollRows(sm, bad.id).toBe(before + 1);

    // ...and exactly once. A navigation fans out into several checks of
    // the same script (the reload fast-path plus an opportunistic check
    // per commit event, per frame); before the rate limit each one
    // re-offered the spec and wrote its own row, so one page load
    // produced a burst of identical entries.
    await page.reload();
    await page.reload();
    await page.waitForTimeout(1500);
    expect(await rejectionRows(sm, bad.id)).toHaveLength(before + 1);
    await page.close();
  });

  test('the tab badge says REJECTED, in red', async ({
    sm, extensionContext, fixtureServer, getServiceWorker,
  }) => {
    // The pure classifier is unit-tested; this is the wiring — that the
    // badge path actually reads the rejection map. Without it the row
    // reads MISSING/amber (the badge's "expected but never reported"
    // state), which reads as "still waiting" when nothing is coming.
    dir.write({
      relativePath: 'bad-match.user.js',
      meta: {
        name: 'Bad Match',
        match: [`${fixtureServer.baseUrl}/*`, BAD_PATTERN],
      },
      body: 'console.log("bad");\n',
    });
    const collection = await sm.addCollection(dir.path);
    await sm.syncNow();
    const bad = (await sm.getCollectionWithScripts(collection!.id))!.scripts[0];

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    const sw = await getServiceWorker();
    const tabId = await sw.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tab?.id) throw new Error('no active tab');
      return tab.id;
    });

    const state = await waitForTabState(
      sm, tabId,
      (s) => s.title.includes('REJECTED'),
      'badge to read REJECTED',
    );
    expect(state.title).toContain('Bad Match | REJECTED');
    // Red — as final as a thrown error, not the amber "still waiting"
    // that MISSING means.
    const [r, g, b] = state.badgeColor as number[];
    expect([r, g, b]).toEqual([0xd3, 0x2f, 0x2f]);
    await page.close();
  });

  test('Clear log then Refresh puts the reason back', async ({ sm }) => {
    // A REJECTED row whose Log is empty explains nothing, and reads as
    // though the retry stopped happening.
    writeBad();
    const collection = await sm.addCollection(dir.path);
    await sm.syncNow();
    const bad = (await sm.getCollectionWithScripts(collection!.id))!.scripts[0];
    expect(await rejectionRows(sm, bad.id)).toHaveLength(1);

    await sm.clearScriptLog(bad.id);
    expect(await sm.getScriptLog(bad.id)).toEqual([]);

    await sm.updateScript(bad.id, 'manual');
    await pollRows(sm, bad.id).toBe(1);
    expect(Object.keys(await sm.getRejections())).toEqual([bad.id]);
  });

  test('fixing the pattern clears the rejection and says so', async ({
    sm, extensionContext, extensionId,
  }) => {
    writeBad();
    const collection = await sm.addCollection(dir.path);
    await sm.syncNow();
    const bad = (await sm.getCollectionWithScripts(collection!.id))!.scripts[0];
    expect(Object.keys(await sm.getRejections())).toEqual([bad.id]);

    // Same file, now with a path Chrome accepts.
    dir.write({
      relativePath: 'bad-match.user.js',
      meta: { name: 'Bad Match', match: ['https://rejected.example/*'] },
      body: 'console.log("fixed");\n',
    });
    await sm.updateScript(bad.id, 'manual');
    const sync = await sm.syncNow();

    expect(await sm.getRejections()).toEqual({});
    expect(sync.registered.map((r) => r.id)).toContain(bad.id);

    // The Log has to confirm the fix took — otherwise its last word on
    // this script is a refusal that is no longer true.
    const recovery = (await sm.getScriptLog(bad.id))
      .filter((e) => e.source === 'chrome-injector' && e.level === 'info');
    expect(recovery).toHaveLength(1);
    expect(recovery[0].message).toMatch(/Chrome accepted this script's registration/);

    // The displayed status must stop saying REJECTED — and read OK, not
    // ERROR: the refusal's error rows carry `state: 'rejected'`, so they
    // never touched the `loglevel:` sentinel and nothing residual is
    // left once the rejection map clears.
    expect(recovery[0].state).toBe('ok');
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/userscript.html?script=${bad.id}`);
    await expect(page.locator('.meta-status')).not.toHaveText('REJECTED');
    await expect(page.locator('.meta-status')).toHaveText('OK');
    await page.close();
  });

  test('disabling a rejected script drops the state with it', async ({ sm }) => {
    // The rejection map describes the CURRENT registration set. A
    // script nobody is trying to register can't be REJECTED, or its row
    // would keep a badge the user has no way to clear.
    writeBad();
    const collection = await sm.addCollection(dir.path);
    await sm.syncNow();
    const bad = (await sm.getCollectionWithScripts(collection!.id))!.scripts[0];
    expect(Object.keys(await sm.getRejections())).toEqual([bad.id]);

    await sm.setScriptEnabled(bad.id, false);
    await sm.syncNow();
    expect(await sm.getRejections()).toEqual({});
  });

  test('the collections page shows REJECTED with Chrome\'s reason on hover', async ({
    sm, extensionContext, extensionId,
  }) => {
    writeBad();
    writeGood();
    const collection = await sm.addCollection(dir.path);
    await sm.syncNow();
    const scripts = (await sm.getCollectionWithScripts(collection!.id))!.scripts;
    const bad = scripts.find((s) => s.relativePath === 'bad-match.user.js')!;
    const good = scripts.find((s) => s.relativePath === 'good-match.user.js')!;

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/collections.html`);

    const badCell = page.locator(`tr[data-script-id="${bad.id}"] td.status-cell a`);
    await expect(badCell).toHaveText('REJECTED');
    await expect(badCell).toHaveAttribute('title', INVALID_PORT);
    // The sibling is unaffected.
    await expect(page.locator(`tr[data-script-id="${good.id}"] td.status-cell a`))
      .toHaveText('OK');
    await page.close();
  });

  test('the viewer shows REJECTED and explains it in the message bar', async ({
    sm, extensionContext, extensionId,
  }) => {
    writeBad();
    const collection = await sm.addCollection(dir.path);
    await sm.syncNow();
    const bad = (await sm.getCollectionWithScripts(collection!.id))!.scripts[0];

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/userscript.html?script=${bad.id}`);
    await expect(page.locator('.meta-status')).toHaveText('REJECTED');
    const message = page.locator('#message');
    await expect(message).toContainText("Chrome rejected this script's registration");
    await expect(message).toContainText(INVALID_PORT);
    await page.close();
  });
});
