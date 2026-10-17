// Real end-to-end injection: write userscript files into a tmp dir,
// register the dir as a collection through the real addCollection pipeline,
// open a fixture page in the browser, and assert the script's DOM
// mutation actually lands.
//
// This is the test that proves the full chrome.userScripts path works
// in headless mode (file:// access enabled + user_scripts_enabled set
// in extension Preferences, both done by the fixture).

import path from 'node:path';

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';
import { bridgeSend } from '../fixtures/bridge-forge';
import { activeTabId, allScripts, waitForTabState } from '../fixtures/sw-api';

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

  // A `:*` port is any port to Chrome. The `@include` makes the
  // wrapper's in-page matcher run, which has to read `:*` the same way
  // or it skips the script Chrome injected.
  test('a `:*` port @match injects past the in-page matcher', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    const hostname = new URL(fixtureServer.baseUrl).hostname;
    scriptsDir.write({
      relativePath: 'any-port.user.js',
      meta: {
        name: 'Any Port',
        match: [`*://${hostname}:*/*`],
        include: ['https://never.invalid/*'],
        runAt: 'document-end',
      },
      body: `
        document.getElementById('target').textContent = 'injected on any port';
      `,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('#target')).toHaveText('injected on any port');
    await page.close();
  });

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
  // document-end, readyState `complete` for document-idle). With the
  // slow-blocker script holding the parser in `loading` for 250ms, the three
  // variants land in distinct readyState windows:
  //   document-start → readyState=loading (no wait)
  //   document-end   → readyState=interactive (after DCL)
  //   document-idle  → readyState=complete (just before load)
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

    // document-idle waits for readyState complete, just before load.
    await expect(page.locator('#log li[data-script="idle"]'))
      .toContainText('readyState=complete');

    const order = await page.locator('#log li').evaluateAll((els) =>
      els.map((el) => (el as HTMLElement).dataset.script),
    );
    // `idle` waits for readyState complete, strictly after the other two, so its
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

  test('document-idle runs on a page that calls window.stop(), where load never fires', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    scriptsDir.write({
      relativePath: 'idle.user.js',
      meta: { name: 'Idle After Stop', match: [`${fixtureServer.baseUrl}/window-stop.html`] },
      body: `document.getElementById('target').textContent = 'idle ran';`,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/window-stop.html`, { waitUntil: 'commit' });
    await expect(page.locator('#target')).toHaveText('idle ran');
    await page.close();
  });

  test('document-idle runs shortly after DOMContentLoaded when load is held back', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    scriptsDir.write({
      relativePath: 'idle.user.js',
      meta: { name: 'Idle Stalled Load', match: [`${fixtureServer.baseUrl}/stalled-load.html`] },
      body: `document.getElementById('target').textContent = 'idle ran: ' + document.readyState;`,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/stalled-load.html`, { waitUntil: 'commit' });
    // The image holds `load` for 5s; the fallback runs the body well
    // before that, while the page is still `interactive`.
    await expect(page.locator('#target')).toHaveText('idle ran: interactive', { timeout: 3000 });
    await page.close();
  });

  // Many old scripts set themselves up in a `window` load listener.
  // Tampermonkey runs idle scripts at the "complete" readystatechange,
  // just before `load`, so that listener fires; so must ours, in both
  // worlds. target.html is a fast page whose `load` usually beats the
  // run decision, so this mostly exercises runWithLoadReplay.
  test('document-idle runs before load, so a load listener it adds fires', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    const variants = [
      ['page', 'none', 'addEventListener'],
      ['isolated', 'GM_getValue', 'addEventListener'],
      ['onload', 'none', 'onload'],
    ] as const;
    for (const [tag, grant, how] of variants) {
      const setup = `() => {
        document.getElementById('target').dataset.${tag} = startedAt + ' then load';
      }`;
      scriptsDir.write({
        relativePath: `${tag}.user.js`,
        meta: { name: `Idle Load ${tag}`, match: [`${fixtureServer.baseUrl}/target.html`], grant: [grant] },
        body: `
          const startedAt = document.readyState;
          ${how === 'onload' ? `window.onload = ${setup};` : `window.addEventListener('load', ${setup});`}
        `,
      });
    }
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    for (let i = 0; i < 3; i++) {
      if (i === 0) await page.goto(`${fixtureServer.baseUrl}/target.html`);
      else await page.reload();
      await expect(page.locator('#target')).toHaveAttribute('data-page', 'complete then load');
      await expect(page.locator('#target')).toHaveAttribute('data-isolated', 'complete then load');
      await expect(page.locator('#target')).toHaveAttribute('data-onload', 'complete then load');
    }
    await page.close();
  });

  // A sync that widens the page bridge's patterns re-registers it, and
  // Chrome puts it after the scripts already registered. A page-world
  // script injected ahead of it asks whether to run before it listens,
  // so its request is held and sent when the bridge announces itself,
  // rather than it waiting out its 10s timer and not running. More
  // late-bridge cases are in late-bridge.spec.ts.
  test('a page-world script ahead of the bridge gets its answer at once', async ({
    extensionContext, fixtureServer, sm, getServiceWorker,
  }) => {
    const base = fixtureServer.baseUrl;
    scriptsDir.write({
      relativePath: 'first/early.user.js',
      meta: { name: 'Early', match: [`${base}/target.html`], grant: ['none'] },
      body: `document.documentElement.dataset.ranAt = String(Math.round(performance.now()));`,
    });
    await sm.addCollection(path.join(scriptsDir.path, 'first'));
    await sm.syncNow();
    // A page-world script on another page widens the bridge.
    scriptsDir.write({ relativePath: 'second/wider.user.js', meta: { name: 'Wider', match: [`${base}/other.html`], grant: ['none'] }, body: '' });
    await sm.addCollection(path.join(scriptsDir.path, 'second'));
    await sm.syncNow();
    const order = await (await getServiceWorker()).evaluate(async () => (await chrome.userScripts.getScripts()).map((r) => r.id));
    const early = (await allScripts(sm)).find((r) => r.relativePath.endsWith('early.user.js'))!.id;
    expect(order.indexOf('sourcemonkey-bridge')).toBeGreaterThan(order.indexOf(early));

    const page = await extensionContext.newPage();
    await page.goto(`${base}/target.html`);
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.ranAt ?? null)).not.toBeNull();
    // Well before the 2s timer.
    expect(Number(await page.evaluate(() => document.documentElement.dataset.ranAt))).toBeLessThan(1500);
    await page.close();
  });

  // A wrapper with no decision doesn't run, and its report of that is an
  // error: in the script's Log, with why, and on the badge, so it isn't
  // later explained as a script the page kept from starting.
  test('a script with no run decision shows as an error, with why', async ({
    extensionContext, fixtureServer, sm, getServiceWorker,
  }) => {
    scriptsDir.write({
      relativePath: 'main.user.js',
      meta: { name: 'Main', match: [`${fixtureServer.baseUrl}/*`], grant: ['none'] },
      body: '',
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();
    const id = (await allScripts(sm))[0].id;
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    const tabId = await activeTabId(getServiceWorker);
    await waitForTabState(sm, tabId, (s) => s.rows.includes('Main | OK'), 'Main OK');
    // The report a wrapper sends with no decision, over the page bridge
    // as a page-world one does (with the channel key it has). Chrome's
    // own messages end in a period.
    await bridgeSend(page, await sm.channelKey(), {
      type: 'sm:abandoned', id, name: 'Main', reason: 'no-decision',
      detail: 'Asking SourceMonkey whether to run it failed: Receiving end does not exist.',
    });
    await waitForTabState(sm, tabId, (s) => s.rows.includes('Main | ERROR'), 'Main ERROR');
    const entry = (await sm.getScriptLog(id)).find((e) => e.message.startsWith('Did not run on this page.'));
    expect(entry).toMatchObject({
      level: 'error',
      message: 'Did not run on this page. Asking SourceMonkey whether to run it failed: Receiving end does not exist.',
    });
    await page.close();
  });
  test('a helper whose patterns move keeps its code', async ({
    extensionContext,
    fixtureServer,
    getServiceWorker,
    sm,
  }) => {
    // Turning a script on moves the GM runtime's patterns, and the update
    // that follows leaves the runtime's code out (`withoutCode` in
    // injector.ts): Chrome keeps what it isn't sent. Pinned here because
    // if it didn't, GM_* would be gone from every page.
    for (const [file, page] of [['a.user.js', 'target.html'], ['b.user.js', 'other.html']]) {
      scriptsDir.write({
        relativePath: file,
        meta: { name: file, match: [`${fixtureServer.baseUrl}/${page}`], grant: ['GM_getValue'], injectInto: 'content' },
        body: `document.documentElement.dataset.gm = String(GM_getValue('k', 'from-runtime'));\n`,
      });
    }
    await sm.addCollection(scriptsDir.path);
    const b = (await allScripts(sm)).find((s) => s.relativePath === 'b.user.js')!;
    await sm.setScriptEnabled(b.id, false);
    await sm.syncNow();

    await sm.setScriptEnabled(b.id, true);
    // Incremental: the kind that leaves the code out. A full sync sends it.
    expect((await sm.syncNow()).kind).toBe('incremental');

    const runtime = await (await getServiceWorker()).evaluate(async () =>
      (await chrome.userScripts.getScripts({ ids: ['sourcemonkey-gm-runtime'] }))
        .map((r) => ({ matches: r.matches ?? [], code: r.js?.[0]?.code?.length ?? 0 })));
    expect(runtime).toHaveLength(1);
    expect(runtime[0].matches).toContain(`${fixtureServer.baseUrl}/other.html`);
    expect(runtime[0].code).toBeGreaterThan(10_000);

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/other.html`);
    await expect(page.locator('html')).toHaveAttribute('data-gm', 'from-runtime');
    await page.close();
  });
});
