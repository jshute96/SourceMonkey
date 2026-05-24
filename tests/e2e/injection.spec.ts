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

  // chrome.userScripts queues scripts by @run-at then registration
  // order, so document-start → document-end → document-idle is a
  // hard invariant under SM. (The cross-manager spec in
  // tests/examples/headers-run-at intentionally loosens this: TM has
  // been observed running document-end at `load`, which can land
  // *after* idle when a slow subresource is on the page.)
  test('document-start, document-end, document-idle inject in @run-at order', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    // Only document-start defers to DCL (the body element may not
    // exist yet when start injects). document-end and document-idle
    // append synchronously on inject, so `#log` order reflects real
    // injection order rather than the order DCL listeners happened
    // to fire. tag is one of start/end/idle — safe to interpolate
    // raw into a JS string body.
    for (const runAt of ['document-start', 'document-end', 'document-idle'] as const) {
      const tag = runAt.split('-')[1]!;
      const body =
        tag === 'start'
          ? `
            function record() {
              const log = document.getElementById('log');
              if (!log) return;
              const li = document.createElement('li');
              li.dataset.script = '${tag}';
              li.textContent = '${tag} readyState=' + document.readyState;
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

    const order = await page.locator('#log li').evaluateAll((els) =>
      els.map((el) => (el as HTMLElement).dataset.script),
    );
    expect(order).toEqual(['start', 'end', 'idle']);

    // document-idle waits for load, so it observes complete.
    await expect(page.locator('#log li[data-script="idle"]'))
      .toContainText('readyState=complete');

    await page.close();
  });
});
