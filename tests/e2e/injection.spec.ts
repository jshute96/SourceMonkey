// Real end-to-end injection: write userscript files into a tmp dir,
// register the dir as a collection through the real addCollection pipeline,
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
    const collection = await sm.addCollection(scriptsDir.path);
    expect(collection).not.toBeNull();
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
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/other.html`);
    // Give Chrome a moment in case a stray injection happens.
    await page.waitForLoadState('networkidle');
    await expect(page.locator('#target')).toHaveText('other page');
    await page.close();
  });

  // The lenient `@match` readings, end to end: Chrome's parser refuses
  // a scheme-less pattern and a scheme glob outright, so this proves
  // the rewrite in `canonicalMatchPatterns` produces something Chrome
  // takes AND that it still means what the author wrote. A unit test
  // can only show the strings; only Chrome can say it registered them.
  for (const [label, pattern] of [
    ['a scheme-less @match', '{host}/*'],
    ['a scheme-glob @match', 'http*://{host}/*'],
  ] as const) {
    test(`${label} registers and injects`, async ({
      extensionContext,
      fixtureServer,
      sm,
    }) => {
      const host = fixtureServer.baseUrl.replace(/^https?:\/\//, '');
      scriptsDir.write({
        relativePath: 'lenient.user.js',
        meta: {
          name: 'Lenient Match',
          match: [pattern.replace('{host}', host)],
          runAt: 'document-end',
        },
        body: `
          const el = document.getElementById('target');
          if (el) el.textContent = 'injected by SourceMonkey';
        `,
      });
      const collection = await sm.addCollection(scriptsDir.path);
      await sm.syncNow();

      // Loaded clean: no warning about a dropped pattern, and no
      // registration refusal from Chrome.
      const script = (await sm.getCollectionWithScripts(collection!.id))!.scripts[0];
      expect(script.status).toBe('ok');
      expect(script.startupLogs ?? []).toEqual([]);
      expect(await sm.getRejections()).toEqual({});

      const page = await extensionContext.newPage();
      await page.goto(`${fixtureServer.baseUrl}/target.html`);
      await expect(page.locator('#target')).toHaveText('injected by SourceMonkey');
      await page.close();
    });
  }

  // The negative half of the claim the pair expansion rests on. Nothing
  // in the pipeline can produce `*://host:PORT/*` any more, so this asks
  // Chrome directly: if it ever starts accepting that spelling, this
  // fails and `anyScheme` (src/url-match.ts) can go back to one pattern.
  test('Chrome still refuses `*` beside a numeric port', async ({
    fixtureServer,
    getServiceWorker,
  }) => {
    const host = fixtureServer.baseUrl.replace(/^https?:\/\//, '');
    const sw = await getServiceWorker();
    const error = await sw.evaluate(async (pattern) => {
      try {
        await chrome.userScripts.register([{
          id: 'port-probe',
          matches: [pattern],
          js: [{ code: 'void 0;' }],
        }]);
        await chrome.userScripts.unregister({ ids: ['port-probe'] });
        return null;
      } catch (e) {
        return String((e as Error).message);
      }
    }, `*://${host}/*`);
    expect(error).toMatch(/Invalid port/i);
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
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('#target')).toHaveAttribute('data-a', 'yes');
    await expect(page.locator('#target')).toHaveAttribute('data-b', 'yes');
    await page.close();
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
    await sm.addCollection(scriptsDir.path);
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
