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
    sm,
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
        if (el) el.textContent = 'injected by SourceMonkey';
      `,
    });
    const source = await sm.addSource(scriptsDir.path);
    expect(source).not.toBeNull();
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('#target')).toHaveText('injected by SourceMonkey');
    await page.close();
  });

  test('script is skipped on non-matching URL', async ({
    extensionContext,
    fixtureServer,
    sm,
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
    await sm.addSource(scriptsDir.path);
    await sm.syncNow();

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
    sm,
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
    await sm.addSource(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('#target')).toHaveAttribute('data-a', 'yes');
    await expect(page.locator('#target')).toHaveAttribute('data-b', 'yes');
    await page.close();
  });

  // Re-enabling a missing script reuses its cached body. The file
  // vanishes (→ status: 'missing', enabled: false), the user toggles
  // enabled back on, and the script should run on the next navigation
  // straight from the last-known content — no refresh required, since
  // the bytes are still in storage.
  //
  // Covers two regression hazards beyond the basic happy path:
  //   1. The match-index should include the re-enabled missing script
  //      so the per-tab badge counts it — not just chrome.userScripts.
  //   2. A subsequent source refresh while the file is still gone must
  //      NOT silently clobber the user's enabled=true back to false.
  test('re-enabled missing script runs from cached body and survives a refresh', async ({
    extensionContext,
    fixtureServer,
    sm,
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
        if (el) el.textContent = 'injected from cache';
      `,
    });
    const source = await sm.addSource(scriptsDir.path);
    await sm.syncNow();

    // Delete the file and refresh so the row flips to missing + disabled.
    scriptsDir.remove('mark.user.js');
    await sm.updateSource(source!.id, 'manual');
    await sm.syncNow();
    const after = await sm.getSourceWithScripts(source!.id);
    expect(after!.scripts).toHaveLength(1);
    expect(after!.scripts[0].status).toBe('missing');
    expect(after!.scripts[0].enabled).toBe(false);

    // While disabled, the match-index should NOT list it.
    const offMatch = await sm.debugMatchIndex(`${fixtureServer.baseUrl}/target.html`);
    expect(offMatch.matches.map((m) => m.id)).not.toContain(after!.scripts[0].id);

    // User explicitly re-enables. No fresh fetch — the cached body is
    // what should run.
    await sm.setScriptEnabled(after!.scripts[0].id, true);
    await sm.syncNow();

    // Match-index now lists the re-enabled missing script — this is what
    // drives the per-tab badge / match counter.
    const onMatch = await sm.debugMatchIndex(`${fixtureServer.baseUrl}/target.html`);
    expect(onMatch.matches.map((m) => m.id)).toContain(after!.scripts[0].id);

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('#target')).toHaveText('injected from cache');
    await page.close();

    // A second refresh while the file is STILL missing must preserve
    // the user's enabled=true. Without the guard in applyMissing, this
    // would silently clobber it back to false.
    await sm.updateSource(source!.id, 'manual');
    await sm.syncNow();
    const afterSecond = await sm.getSourceWithScripts(source!.id);
    expect(afterSecond!.scripts[0].status).toBe('missing');
    expect(afterSecond!.scripts[0].enabled).toBe(true);

    // And it should still inject after that second refresh.
    const page2 = await extensionContext.newPage();
    await page2.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page2.locator('#target')).toHaveText('injected from cache');
    await page2.close();
  });

  // SM registers every userscript at chrome's document_start and the
  // wrapper itself awaits the matching lifecycle event (DCL for
  // document-end, load for document-idle). With the slow-blocker
  // script holding the parser in `loading` for 250ms, the three
  // variants land in distinct readyState windows:
  //   document-start → readyState=loading (no wait)
  //   document-end   → readyState=interactive (after DCL)
  //   document-idle  → readyState=complete (after load)
  // Without that gating Chrome's userScripts scheduler would batch
  // document_end into the post-load burst and document-end would
  // observe `complete`, matching document-idle.
  test('document-start, document-end, document-idle inject in @run-at order', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    // Each script records the readyState it observed *at injection*,
    // which is the property @run-at actually controls. document-start
    // has to defer its DOM append to DCL (the `#log` element doesn't
    // exist yet when it injects), so it captures readyState first and
    // appends later — reading readyState inside the deferred callback
    // would report `interactive` and prove nothing.
    // tag is one of start/end/idle — safe to interpolate raw into a JS
    // string body.
    for (const runAt of ['document-start', 'document-end', 'document-idle'] as const) {
      const tag = runAt.split('-')[1]!;
      const body =
        tag === 'start'
          ? `
            const injectedAt = document.readyState;
            function record() {
              const log = document.getElementById('log');
              if (!log) return;
              const li = document.createElement('li');
              li.dataset.script = '${tag}';
              li.textContent = '${tag} readyState=' + injectedAt;
              log.appendChild(li);
            }
            if (document.readyState === 'loading') {
              document.addEventListener('DOMContentLoaded', record);
            } else {
              record();
            }
          `
          : `
            const log = document.getElementById('log');
            if (log) {
              const li = document.createElement('li');
              li.dataset.script = '${tag}';
              li.textContent = '${tag} readyState=' + document.readyState;
              log.appendChild(li);
            }
          `;
      scriptsDir.write({
        relativePath: `${tag}.user.js`,
        meta: {
          name: `RunAt-${tag}`,
          match: [`${fixtureServer.baseUrl}/*`],
          runAt,
        },
        body,
      });
    }
    await sm.addSource(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/run-at.html`);
    await expect(page.locator('#log li')).toHaveCount(3);

    // The readyState each script saw when it injected is the real
    // proof of ordering, and unlike DOM-append order it's fully
    // determined by the 250ms blocker.

    // document-start runs before the parser has even finished the
    // head, so it sees `loading`.
    await expect(page.locator('#log li[data-script="start"]'))
      .toContainText('readyState=loading');

    // document-end fires at DCL, when the slow blocker has resolved
    // and parsing has finished but `load` hasn't fired yet —
    // readyState=interactive. This is the assertion that proves the
    // wrapper-side runAt gating is working: without it, Chrome batches
    // document_end into the post-load burst and end would observe
    // `complete` instead.
    await expect(page.locator('#log li[data-script="end"]'))
      .toContainText('readyState=interactive');

    // document-idle waits for load, so it observes complete.
    await expect(page.locator('#log li[data-script="idle"]'))
      .toContainText('readyState=complete');

    const order = await page.locator('#log li').evaluateAll((els) =>
      els.map((el) => (el as HTMLElement).dataset.script),
    );
    // `idle` waits for `load`, strictly after the other two, so its
    // position is guaranteed. `start` and `end` both *append* on
    // DOMContentLoaded — start's body defers there because `#log`
    // doesn't exist at document_start, and end's wrapper gates on that
    // same event — so which of the two DCL listeners runs first is
    // whichever userscript entry Chrome happened to execute first at
    // document_start. Chrome doesn't promise a stable order across
    // separately-registered scripts, so asserting one here tests
    // something we don't implement.
    expect(order[2]).toBe('idle');
    expect([...order.slice(0, 2)].sort()).toEqual(['end', 'start']);

    await page.close();
  });
});
