// E2E coverage for `@grant window.onurlchange`.
//
// The interesting part is that the userscript runs in USER_SCRIPT
// world while `history.pushState` is called by the PAGE (MAIN world) —
// exactly the split that makes an isolated-world history patch
// useless. `page.evaluate` runs in MAIN, so every drive below is a
// genuine page-initiated navigation, not one our own world made.
//
// Signals under test — both come from the service worker
// (`chrome.webNavigation` → `sm:url-change`), which is also where
// Tampermonkey sources its own `urlchange`:
//   - pushState / replaceState / same-document traversal
//     → onHistoryStateUpdated
//   - fragment-only changes → onReferenceFragmentUpdated
//
// Firing rules asserted here match TM's, which were verified against
// TM 5.5.0: no event on initial load, and NO de-duplication (a
// same-URL replaceState does fire).

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';

// Records every urlchange the script sees onto `body[data-urls]`, and
// reports the feature test onto `body[data-supported]`. Reading
// `location.href` inside the handler as well proves the event's `url`
// agrees with what the document actually shows. `keys` pins the
// TM-compatible payload shape: exactly one own property, `url`.
const listenerBody = `
  const seen = [];
  document.body.dataset.supported = String(window.onurlchange === null);
  window.addEventListener('urlchange', function (info) {
    seen.push({
      url: info && info.url,
      href: location.href,
      keys: Object.keys(info).join(','),
      isEvent: (typeof Event === 'function') && (info instanceof Event),
    });
    document.body.dataset.urls = JSON.stringify(seen);
  });
  document.body.dataset.urls = JSON.stringify(seen);
  document.body.dataset.ready = 'yes';
`;

async function readSeen(page: import('@playwright/test').Page) {
  const raw = await page.locator('body').getAttribute('data-urls');
  return JSON.parse(raw ?? '[]') as Array<{
    url: string; href: string; keys: string; isEvent: boolean;
  }>;
}

test.describe('window.onurlchange', () => {
  let scriptsDir: ScriptsDir;

  test.beforeEach(() => {
    scriptsDir = ScriptsDir.create();
  });
  test.afterEach(() => {
    scriptsDir.cleanup();
  });

  test('granted: pushState from the page fires urlchange with the new URL', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    scriptsDir.write({
      relativePath: 'watch.user.js',
      meta: {
        name: 'URL Watcher',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['window.onurlchange'],
      },
      body: listenerBody,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-ready', 'yes');

    // The documented TM feature test must succeed.
    await expect(page.locator('body')).toHaveAttribute('data-supported', 'true');
    // A plain document load is NOT a urlchange (matches TM: scripts
    // handle the initial URL themselves, then listen).
    expect(await readSeen(page)).toEqual([]);

    await page.evaluate(() => history.pushState({}, '', '/target.html?page=2'));
    await expect(page.locator('body')).toHaveAttribute('data-urls', /page=2/);

    const seen = await readSeen(page);
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe(`${fixtureServer.baseUrl}/target.html?page=2`);
    // The event's url agrees with the document's live location.
    expect(seen[0].href).toBe(seen[0].url);
    // TM hands over a bare `{url}` object, not an Event. Match it.
    expect(seen[0].keys).toBe('url');
    expect(seen[0].isEvent).toBe(false);

    // replaceState to a DIFFERENT url fires too.
    await page.evaluate(() => history.replaceState({}, '', '/target.html?page=3'));
    await expect(page.locator('body')).toHaveAttribute('data-urls', /page=3/);
    expect(await readSeen(page)).toHaveLength(2);

    await page.close();
  });

  test('ungranted: window.onurlchange is undefined and no listener fires', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    // Same body, but the script grants something else entirely. The
    // feature test must report "unsupported" and the listener must
    // never be called, even though the page does a real pushState.
    scriptsDir.write({
      relativePath: 'nowatch.user.js',
      meta: {
        name: 'No URL Grant',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_addStyle'],
      },
      body: listenerBody,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-ready', 'yes');
    await expect(page.locator('body')).toHaveAttribute('data-supported', 'false');

    await page.evaluate(() => history.pushState({}, '', '/target.html?page=2'));
    // Give the SW round-trip a chance to (not) arrive, then assert
    // nothing landed. A bare expect would pass instantly on an empty
    // list either way, so we wait for the URL to actually have changed
    // in the page first.
    await expect
      .poll(() => page.evaluate(() => location.search))
      .toBe('?page=2');
    await page.waitForTimeout(300);
    expect(await readSeen(page)).toEqual([]);

    await page.close();
  });

  test('fragment changes and back/forward fire; a same-URL replaceState fires too', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    scriptsDir.write({
      relativePath: 'watch.user.js',
      meta: {
        name: 'URL Watcher',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['window.onurlchange'],
      },
      body: listenerBody,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-ready', 'yes');

    // Fragment-only change — only `onReferenceFragmentUpdated` reports
    // this one, so it's the regression guard for that subscription.
    await page.evaluate(() => { location.hash = '#one'; });
    await expect(page.locator('body')).toHaveAttribute('data-urls', /#one/);
    expect(await readSeen(page)).toHaveLength(1);

    // Same-URL replaceState: TM does NOT suppress this, and neither do
    // we — there is no URL comparison anywhere in the path.
    await page.evaluate(() => history.replaceState({}, '', location.href));
    await expect.poll(async () => (await readSeen(page)).length).toBe(2);
    const afterReplace = await readSeen(page);
    expect(afterReplace[1].url).toBe(afterReplace[0].url);

    // Back to the un-hashed URL: a same-document traversal.
    await page.goBack();
    await expect
      .poll(() => page.evaluate(() => location.hash))
      .toBe('');
    await expect.poll(async () => (await readSeen(page)).length).toBe(3);
    const seen = await readSeen(page);
    expect(seen[2].url).toBe(`${fixtureServer.baseUrl}/target.html`);

    await page.close();
  });

  test('the window.onurlchange = fn assignment form is wired up too', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    scriptsDir.write({
      relativePath: 'assign.user.js',
      meta: {
        name: 'URL Watcher (assignment)',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['window.onurlchange'],
      },
      body: `
        // Registered FIRST, so it must also fire first: the slot
        // registers into the same list as addEventListener (matches TM).
        const order = [];
        window.addEventListener('urlchange', function () { order.push('listener'); });
        window.onurlchange = function (info) {
          order.push('slot');
          document.body.dataset.assigned = info.url;
          document.body.dataset.order = order.join(',');
        };
        // Reading it back returns the handler we set — it behaves as a
        // real on-event slot, not a write-only sentinel.
        document.body.dataset.slot = typeof window.onurlchange;
        document.body.dataset.ready = 'yes';
      `,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-ready', 'yes');
    await expect(page.locator('body')).toHaveAttribute('data-slot', 'function');

    await page.evaluate(() => history.pushState({}, '', '/target.html?assigned=1'));
    await expect(page.locator('body')).toHaveAttribute('data-assigned', /assigned=1/);
    await expect(page.locator('body')).toHaveAttribute('data-order', 'listener,slot');

    await page.close();
  });

  test('the slot and addEventListener do not alias each other', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    // The slot and `addEventListener` share one registration list, so
    // the naive implementation (put the user's function in the list
    // directly) lets one form silently unregister the other's entry
    // for the same function. Three ways that shows up, all asserted
    // here after a single navigation.
    scriptsDir.write({
      relativePath: 'alias.user.js',
      meta: {
        name: 'URL Watcher (aliasing)',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['window.onurlchange'],
      },
      body: `
        let hits = 0;
        function shared() { hits += 1; document.body.dataset.hits = String(hits); }

        // (a) The same function registered BOTH ways, then the slot
        // cleared. The addEventListener registration must survive.
        window.addEventListener('urlchange', shared);
        window.onurlchange = shared;
        window.onurlchange = null;

        // (b) removeEventListener naming a function that was only ever
        // installed via the slot must not stop it, nor desync the
        // getter from what actually fires.
        let slotHits = 0;
        function slotOnly() { slotHits += 1; document.body.dataset.slotHits = String(slotHits); }
        window.onurlchange = slotOnly;
        window.removeEventListener('urlchange', slotOnly);
        document.body.dataset.getter = (window.onurlchange === slotOnly) ? 'same' : 'lost';

        // (c) A non-function assignment round-trips through the getter
        // (TM stores it too) and registers nothing. Restore the real
        // handler afterwards so (b)'s assertion still means something.
        window.onurlchange = 42;
        document.body.dataset.stored = String(window.onurlchange);
        window.onurlchange = slotOnly;

        document.body.dataset.hits = '0';
        document.body.dataset.slotHits = '0';
        document.body.dataset.ready = 'yes';
      `,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-ready', 'yes');
    // (b) the getter still names the handler that will actually run.
    await expect(page.locator('body')).toHaveAttribute('data-getter', 'same');
    // (c) the non-function assignment round-tripped.
    await expect(page.locator('body')).toHaveAttribute('data-stored', '42');

    await page.evaluate(() => history.pushState({}, '', '/target.html?alias=1'));

    // (a) the addEventListener registration survived the slot churn,
    // and fires exactly once (not twice — it's one entry, not two).
    await expect(page.locator('body')).toHaveAttribute('data-hits', '1');
    // (b) the slot's handler fires despite the stray removeEventListener.
    await expect(page.locator('body')).toHaveAttribute('data-slot-hits', '1');

    await page.evaluate(() => history.pushState({}, '', '/target.html?alias=2'));
    await expect(page.locator('body')).toHaveAttribute('data-hits', '2');
    await expect(page.locator('body')).toHaveAttribute('data-slot-hits', '2');

    await page.close();
  });

  test('the grant leaks to sibling scripts in the same document (known deviation)', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    // Pins the documented per-document (not per-script) enforcement
    // gap: USER_SCRIPT world is one realm per document, so once ANY
    // script grants the API the surface exists for every SourceMonkey
    // script on the page. TM sandboxes each script's window and gates
    // exactly. If per-script worlds ever land, this test should flip —
    // it exists so that change can't happen silently.
    scriptsDir.write({
      relativePath: 'granting.user.js',
      meta: {
        name: 'Granting',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['window.onurlchange'],
      },
      body: `document.body.dataset.granting = 'ran';`,
    });
    scriptsDir.write({
      relativePath: 'sibling.user.js',
      meta: {
        name: 'Sibling without the grant',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-idle',
        grant: ['GM_addStyle'],
      },
      body: `
        // Probe on demand rather than at script start. Injection order
        // BETWEEN two chrome.userScripts registrations isn't
        // guaranteed, so "did the granting script install the surface
        // before this line ran" is a coin flip; the test drives the
        // probe once it has seen both scripts run.
        window.addEventListener('sm-probe-leak', function () {
          document.body.dataset.siblingSupported = String(window.onurlchange === null);
          window.addEventListener('urlchange', function () {
            document.body.dataset.siblingFired = 'yes';
          });
        });
        document.body.dataset.sibling = 'ran';
      `,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-granting', 'ran');
    await expect(page.locator('body')).toHaveAttribute('data-sibling', 'ran');

    // Both have run, so the surface is installed if it's going to be.
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('sm-probe-leak')));
    // The ungranted sibling sees it, because the granting script
    // installed it on the shared isolated-world window.
    await expect(page.locator('body')).toHaveAttribute('data-sibling-supported', 'true');

    await page.evaluate(() => history.pushState({}, '', '/target.html?leak=1'));
    await expect(page.locator('body')).toHaveAttribute('data-sibling-fired', 'yes');

    await page.close();
  });

  test('removeEventListener stops delivery, and other event types still work', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    // The runtime patches window.addEventListener to intercept the
    // synthetic `urlchange` type. Everything else must pass straight
    // through to the real EventTarget method — this asserts both
    // halves of that patch.
    scriptsDir.write({
      relativePath: 'remove.user.js',
      meta: {
        name: 'URL Watcher (remove)',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['window.onurlchange'],
      },
      body: `
        let count = 0;
        function onUrl() {
          count += 1;
          document.body.dataset.count = String(count);
          if (count === 1) window.removeEventListener('urlchange', onUrl);
        }
        window.addEventListener('urlchange', onUrl);
        // A pass-through registration on a real DOM event type.
        window.addEventListener('sm-probe', function () {
          document.body.dataset.probe = 'fired';
        });
        document.body.dataset.count = '0';
        document.body.dataset.ready = 'yes';
      `,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-ready', 'yes');

    // Pass-through: an event the page dispatches reaches the
    // isolated-world listener registered through the patched method.
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('sm-probe')));
    await expect(page.locator('body')).toHaveAttribute('data-probe', 'fired');

    await page.evaluate(() => history.pushState({}, '', '/target.html?n=1'));
    await expect(page.locator('body')).toHaveAttribute('data-count', '1');

    // The handler removed itself, so the second navigation lands
    // nowhere.
    await page.evaluate(() => history.pushState({}, '', '/target.html?n=2'));
    await expect
      .poll(() => page.evaluate(() => location.search))
      .toBe('?n=2');
    await page.waitForTimeout(300);
    await expect(page.locator('body')).toHaveAttribute('data-count', '1');

    await page.close();
  });
});
