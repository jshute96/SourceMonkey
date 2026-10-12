// Regression test for the cross-script GM_setValue read leak.
//
// Threat: a USER_SCRIPT-world storage script keeps its GM values in an
// isolated world the page can't read. But the SW attaches that
// script's value snapshot (`gmValues`) to the `sm:check-pending`
// reply, and the MAIN-world bridge (wrapper-bridge.js) forwards
// `sm:check-pending` postMessages from the page. So a hostile page
// could forge a check-pending with the victim's scriptId +
// `needsValues:true`, and read the snapshot back out of the reply the
// bridge posts to the page.
//
// Fix: the bridge stamps `__viaBridge:true` on everything it relays
// (the page can't strip a marker added in USER_SCRIPT world, and the
// page can't reach the SW any other way), and the SW refuses to attach
// `gmValues` to any `__viaBridge` request. Legitimate reads come from
// the USER_SCRIPT-world script's OWN direct chrome.runtime path, which
// carries no marker — so this withholds nothing a script is owed.
//
// The test installs a USER_SCRIPT-world storage victim (writes a
// secret value) plus a trivial MAIN-world script (so the bridge
// registers), then forges a bridge check-pending for the victim's id
// and asserts the reply carries no values.

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';
import { waitFor } from '../fixtures/sw-api';

const SECRET = 'leak-canary-9d3f';

test.describe('GM storage cross-script read leak', () => {
  let scriptsDir: ScriptsDir;

  test.beforeEach(() => { scriptsDir = ScriptsDir.create(); });
  test.afterEach(() => { scriptsDir.cleanup(); });

  test('a page-forged bridge check-pending cannot read another script\'s GM values', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    // Victim: USER_SCRIPT-world (real @grant → isolated world) storage
    // script. Seeds a secret value on its first run and echoes whatever
    // it reads so the test can confirm the value really is in the SW
    // snapshot via the legitimate direct path.
    scriptsDir.write({
      relativePath: 'victim.user.js',
      meta: {
        name: 'Victim',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_setValue', 'GM_getValue'],
      },
      body: `
        if (GM_getValue('secret', '') === '') GM_setValue('secret', '${SECRET}');
        document.body.dataset.smVictim = String(GM_getValue('secret', '_NONE_'));
      `,
    });
    // Filler: MAIN-world (@grant none) script on the same page. Its only
    // job is to make the SW register the MAIN-world bridge, which is the
    // channel the forgery rides.
    scriptsDir.write({
      relativePath: 'filler.user.js',
      meta: {
        name: 'Filler',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['none'],
      },
      body: `document.documentElement.dataset.smFiller = '1';`,
    });

    const added = await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    // First load: victim seeds the secret and persists it to the SW.
    const seed = await extensionContext.newPage();
    await seed.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(seed.locator('body')).toHaveAttribute('data-sm-victim', SECRET);

    // Resolve the victim's real scriptId (a v4 UUID — the practical
    // barrier the leak relied on; the test knows it, a real page would
    // have to guess it).
    const detail = await sm.getCollectionWithScripts(added!.id);
    const victimId = detail!.scripts.find((s) => s.relativePath === 'victim.user.js')!.id;

    // The probe below is only meaningful once there is something stored
    // to leak, and GM_setValue's write reaches the worker a message later.
    await waitFor(
      () => sm.getGmValues(victimId),
      (values) => values.secret === SECRET,
      { label: "the victim's secret reaches storage" },
    );
    await seed.close();

    // Fresh document. Positive control: the victim's OWN direct
    // check-pending still seeds the secret, proving the SW snapshot
    // holds it and the legitimate path is unaffected by the fix.
    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html?n=2`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-victim', SECRET);

    // Now the attack: forge a bridge check-pending for the victim's id
    // with needsValues:true and read whatever the bridge posts back.
    const reply = await page.evaluate((id) => {
      return new Promise<unknown>((resolve) => {
        const rid = 'forge-' + Math.random().toString(36).slice(2);
        const onMsg = (ev: MessageEvent): void => {
          const d = ev.data as { __sm?: string; requestId?: string; reply?: unknown };
          if (ev.source !== window || !d || d.__sm !== 'sourcemonkey-bridge-reply' || d.requestId !== rid) return;
          window.removeEventListener('message', onMsg, true);
          resolve(d.reply ?? null);
        };
        window.addEventListener('message', onMsg, true);
        // The page -> SW direction is a DOM event; replies still come
        // back as a postMessage. A page can dispatch the event as
        // easily as it could post the message, which is the point of
        // the SW-side gate this test exercises.
        document.dispatchEvent(new CustomEvent('sourcemonkey-bridge-sync', {
          detail: JSON.stringify({
            requestId: rid,
            payload: {
              type: 'sm:check-pending',
              id,
              name: 'Victim',
              loadedAt: 0,
              url: location.href,
              needsValues: true,
            },
          }),
        }));
        setTimeout(() => { window.removeEventListener('message', onMsg, true); resolve(null); }, 2500);
      });
    }, victimId);

    // We must actually have gotten a reply (proves the bridge relayed
    // and replied — i.e. the forgery channel is live and we're testing
    // the real path, not a silent drop).
    expect(reply, 'bridge should reply to the forged check-pending').not.toBeNull();
    // ...and it must NOT carry the victim's values.
    expect((reply as { gmValues?: unknown }).gmValues).toBeUndefined();
    expect(JSON.stringify(reply)).not.toContain(SECRET);

    await page.close();
  });
});
