// End-to-end tests for storage freshness across documents.
//
// Every fresh document seeds its in-page GM_setValue cache from a
// snapshot the SW attaches to the `sm:check-pending` reply. These
// tests verify that the snapshot is current: a write made in one
// document is visible to any subsequent document (same tab after
// navigation, fresh tab, write-then-immediate-navigate within the
// 150 ms debounce, multi-key burst, concurrent writes from two
// tabs, pagehide-only flush).
//
// Each test asserts the value seen by the script's FIRST GM_getValue
// call (the `data-sm-initial` attribute), captured before any post-load
// SW message can arrive. That isolates the prelude path from any
// after-the-fact live broadcast, so we test the snapshot that actually
// reaches user code.

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';

test.describe('GM_* storage freshness across documents', () => {
  let scriptsDir: ScriptsDir;

  test.beforeEach(() => { scriptsDir = ScriptsDir.create(); });
  test.afterEach(() => { scriptsDir.cleanup(); });

  // Shared probe. Captures the initial GM_getValue at the very first
  // line so we can assert what the prelude+check-pending path actually
  // surfaced to the body. Also exposes a command channel via
  // `dataset.smCmd = 'set:<value>'` so the test can drive writes from
  // PAGE world.
  const probeBody = `
    document.body.dataset.smInitial = String(GM_getValue('shared', '_NONE_'));
    const reportCurrent = () => {
      document.body.dataset.smValue = String(GM_getValue('shared', '_NONE_'));
    };
    reportCurrent();
    let lastSeen = '';
    setInterval(() => {
      const cmd = document.body.dataset.smCmd || '';
      if (cmd && cmd !== lastSeen) {
        lastSeen = cmd;
        if (cmd.startsWith('set:')) GM_setValue('shared', cmd.slice(4));
      }
      reportCurrent();
    }, 50);
  `;

  function writeProbe(baseUrl: string): void {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'Freshness',
        match: [`${baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_setValue', 'GM_getValue'],
      },
      body: probeBody,
    });
  }

  test('same-tab navigation: new document sees value written before the navigation', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    writeProbe(fixtureServer.baseUrl);
    await sm.addSource(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-initial', '_NONE_');

    // Write through the probe's command channel.
    await page.evaluate(() => { document.body.dataset.smCmd = 'set:fromA'; });
    await expect(page.locator('body')).toHaveAttribute('data-sm-value', 'fromA');

    // Generous pause so the 150ms debounced flush AND any SW-side
    // re-register has time to propagate.
    await page.waitForTimeout(500);

    // Navigate within the same tab.
    await page.goto(`${fixtureServer.baseUrl}/target.html?n=2`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-initial', 'fromA');
    await page.close();
  });

  test('newly opened tab sees value written and persisted by an earlier tab', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    writeProbe(fixtureServer.baseUrl);
    await sm.addSource(scriptsDir.path);
    await sm.syncNow();

    const pageA = await extensionContext.newPage();
    await pageA.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(pageA.locator('body')).toHaveAttribute('data-sm-initial', '_NONE_');
    await pageA.evaluate(() => { document.body.dataset.smCmd = 'set:fromA'; });
    await expect(pageA.locator('body')).toHaveAttribute('data-sm-value', 'fromA');
    await pageA.waitForTimeout(500);
    await pageA.close();

    const pageB = await extensionContext.newPage();
    await pageB.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(pageB.locator('body')).toHaveAttribute('data-sm-initial', 'fromA');
    await pageB.close();
  });

  test('write-then-immediate-navigate within debounce: new doc still sees the value', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    writeProbe(fixtureServer.baseUrl);
    await sm.addSource(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-initial', '_NONE_');

    // Write and navigate without waiting for the 150ms debounce. The
    // pagehide handler force-flushes, but chrome.storage.local.set is
    // async; depending on machine speed the persist may or may not
    // have landed by the time the new doc requests its snapshot. The
    // assertion just checks the end result — we want the value to
    // surface either via the in-flight overlay or via the freshly-
    // persisted row. Either path keeps the user-visible behavior
    // correct, so we don't try to distinguish them here.
    await page.evaluate(() => { document.body.dataset.smCmd = 'set:fromA'; });
    await expect(page.locator('body')).toHaveAttribute('data-sm-value', 'fromA');
    await page.goto(`${fixtureServer.baseUrl}/target.html?n=race`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-initial', 'fromA');
    await page.close();
  });

  // Multi-key probe used by the burst / concurrent-tabs / pagehide-only
  // tests below. Differs from `probeBody` above only in that it
  // accepts a `;`-separated burst of `set:key=value` ops in
  // dataset.smCmd, and reflects the full GM_listValues / GM_getValue
  // snapshot as a JSON string in dataset.smInitial / dataset.smState.
  // The whole burst is applied inside a single polling tick, so the
  // batched-write debounce sees one queue of writes — closer to a
  // real script's GM_setValue spree than three separate cmds.
  const multiProbeBody = `
    const snapshot = () => {
      const keys = GM_listValues();
      const map = {};
      for (const k of keys) map[k] = GM_getValue(k);
      return JSON.stringify(map);
    };
    document.body.dataset.smInitial = snapshot();
    document.body.dataset.smState = snapshot();
    let lastSeen = '';
    setInterval(() => {
      const cmd = document.body.dataset.smCmd || '';
      if (cmd && cmd !== lastSeen) {
        lastSeen = cmd;
        for (const op of cmd.split(';')) {
          if (op.startsWith('set:')) {
            const eq = op.indexOf('=');
            if (eq > 4) GM_setValue(op.slice(4, eq), op.slice(eq + 1));
          }
        }
      }
      document.body.dataset.smState = snapshot();
    }, 50);
  `;

  function writeMultiProbe(baseUrl: string): void {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'FreshnessMulti',
        match: [`${baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_setValue', 'GM_getValue', 'GM_listValues'],
      },
      body: multiProbeBody,
    });
  }

  // T1. Verifies the whole batch survives even when navigation
  // happens before the debounce fires — a regression where, say,
  // only the last write in the queue made it across would pass
  // the single-key freshness tests above but fail here.
  test('multi-key burst survives an immediate navigation', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    writeMultiProbe(fixtureServer.baseUrl);
    await sm.addSource(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-initial', '{}');

    // Three writes applied in one polling tick — closer to a real
    // userscript's "save config" burst than three round-trips.
    await page.evaluate(() => {
      document.body.dataset.smCmd = 'set:k1=v1;set:k2=v2;set:k3=v3';
    });
    // Wait until the burst has been applied locally — `data-sm-state`
    // is the in-page snapshot rebuilt every 50ms.
    await expect(page.locator('body')).toHaveAttribute('data-sm-state', /v3/);
    // Navigate immediately, no debounce wait.
    await page.goto(`${fixtureServer.baseUrl}/target.html?n=2`);
    const initial = await page.locator('body').getAttribute('data-sm-initial');
    expect(JSON.parse(initial ?? '')).toEqual({ k1: 'v1', k2: 'v2', k3: 'v3' });
    await page.close();
  });

  // T2. Two tabs write different keys at roughly the same time;
  // a third tab opened later sees both. Catches any cross-tab
  // serialization bug that lets one write clobber the other.
  test('concurrent writes to different keys from two tabs both persist', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    writeMultiProbe(fixtureServer.baseUrl);
    await sm.addSource(scriptsDir.path);
    await sm.syncNow();

    const pageA = await extensionContext.newPage();
    await pageA.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(pageA.locator('body')).toHaveAttribute('data-sm-initial', '{}');
    const pageB = await extensionContext.newPage();
    await pageB.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(pageB.locator('body')).toHaveAttribute('data-sm-initial', '{}');

    // Issue both commands in parallel — they'll be picked up by each
    // tab's next polling tick (within 50ms). The SW receives the two
    // batch-writes near-simultaneously.
    await Promise.all([
      pageA.evaluate(() => { document.body.dataset.smCmd = 'set:fromA=valueA'; }),
      pageB.evaluate(() => { document.body.dataset.smCmd = 'set:fromB=valueB'; }),
    ]);
    await expect(pageA.locator('body')).toHaveAttribute('data-sm-state', /fromA/);
    await expect(pageB.locator('body')).toHaveAttribute('data-sm-state', /fromB/);
    // Let both flushes and cross-broadcast settle.
    await pageA.waitForTimeout(500);

    const pageC = await extensionContext.newPage();
    await pageC.goto(`${fixtureServer.baseUrl}/target.html`);
    const initial = await pageC.locator('body').getAttribute('data-sm-initial');
    expect(JSON.parse(initial ?? '')).toEqual({ fromA: 'valueA', fromB: 'valueB' });

    await pageA.close();
    await pageB.close();
    await pageC.close();
  });

  // T3. Pagehide-only path: the tab is closed before the 150ms
  // debounce would have fired. The runtime's pagehide / visibility-
  // hidden handler must force-flush so the write isn't lost across
  // the close. A fresh tab opened after the close reads the value.
  test('write then close tab without navigating; fresh tab still sees the value', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    writeMultiProbe(fixtureServer.baseUrl);
    await sm.addSource(scriptsDir.path);
    await sm.syncNow();

    const pageA = await extensionContext.newPage();
    await pageA.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(pageA.locator('body')).toHaveAttribute('data-sm-initial', '{}');
    await pageA.evaluate(() => { document.body.dataset.smCmd = 'set:k=closedWrite'; });
    await expect(pageA.locator('body')).toHaveAttribute('data-sm-state', /closedWrite/);
    // Close BEFORE the 150ms debounce: only the pagehide /
    // visibilitychange flush can save the write.
    await pageA.close();

    const pageB = await extensionContext.newPage();
    await pageB.goto(`${fixtureServer.baseUrl}/target.html`);
    const initial = await pageB.locator('body').getAttribute('data-sm-initial');
    expect(JSON.parse(initial ?? '')).toEqual({ k: 'closedWrite' });
    await pageB.close();
  });

  // T4. SW-failure path. The wrapper expects the SW to attach a
  // gmValues snapshot to the sm:check-pending reply for any
  // storage-granting script. When it's missing (SW unreachable past
  // the 2 s safety timer, or the snapshot read threw on the SW
  // side), the prelude must hard-abort rather than running the body
  // with empty storage. The debug knob
  // `setDebugForceSnapshotFailure` makes `loadSnapshotForCheckPending`
  // throw, which causes the message handler to reply
  // `{action: "run"}` with no `gmValues` — exactly the failure
  // shape we want to verify.
  test('SW snapshot unavailable: storage-granting script aborts cleanly', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    writeMultiProbe(fixtureServer.baseUrl);
    await sm.addSource(scriptsDir.path);
    await sm.syncNow();
    await sm.setDebugForceSnapshotFailure(true);
    try {
      const page = await extensionContext.newPage();
      await page.goto(`${fixtureServer.baseUrl}/target.html`);
      // The probe sets data-sm-initial on its very first line. With
      // the snapshot missing the prelude returns before that runs,
      // so the attribute should never appear. Give the wrapper
      // plenty of time to have produced output if it was going to.
      await page.waitForTimeout(500);
      expect(await page.locator('body').getAttribute('data-sm-initial')).toBeNull();

      // The wrapper should have sent sm:error so the failure
      // surfaces on the per-script log.
      const sources = await sm.getSources();
      const scriptIds = sources.flatMap((s) => s.scriptIds);
      expect(scriptIds.length).toBe(1);
      const log = await sm.getScriptLog(scriptIds[0]);
      const errors = log.filter((e) => e.level === 'error');
      expect(errors.length).toBeGreaterThanOrEqual(1);
      expect(errors[0].message).toMatch(/failed reading this script's stored GM values/i);
      // The recovery half is the point of the message — it used to be
      // dropped from this copy while the console kept it.
      expect(errors[0].message).toMatch(/reload the page to retry/i);

      await page.close();
    } finally {
      await sm.setDebugForceSnapshotFailure(false);
    }
  });
});
