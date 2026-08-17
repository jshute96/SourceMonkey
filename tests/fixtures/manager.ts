// Manager-agnostic Playwright fixture for the examples / compliance
// suite. Picks a backend per the active Playwright project:
//
//   --project=sourcemonkey  — launches Chromium with the unpacked
//     dist/ extension, same shape as tests/fixtures/extension.ts.
//   --project=tampermonkey  — connects via CDP (port 9223) to the
//     browser opened by scripts/open-test-browser-with-Tampermonkey.sh.
//     TM must be installed in that profile interactively beforehand.
//
// The project's `metadata.manager` field is what we read. The
// SM_MANAGER env var is a fallback for direct `pnpm exec playwright test
// <file>` runs that don't pass --project; if both are set and
// disagree, we throw.
//
// Tests get a single `setup.installScriptsFrom(dir)` helper that does
// the right thing per manager — adds a directory collection under SM, or
// syncs each *.user.js file into TM via the dashboard.

import { test as base, chromium, type BrowserContext } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extensionIdFromPath } from './extension-id';
import { makeSwApi } from './sw-api';
import {
  createFixtureServer,
  launchSourceMonkeyContext,
  makeGetServiceWorker,
  type FixtureServer,
} from './sourcemonkey-launch';
import {
  TampermonkeyDriver,
  getTampermonkeyExtensionId,
  syncTampermonkeyScripts,
} from './tampermonkey-driver.mjs';

export type ManagerName = 'sourcemonkey' | 'tampermonkey';

/**
 * Resolve which manager this worker is running against.
 *
 * Precedence: project metadata (set by playwright.config.ts) wins; the
 * `SM_MANAGER` env var is honoured as a fallback (and convenience for
 * single-file `pnpm exec playwright test path/to/x.spec.ts` runs that bypass
 * project filtering). If both are set and disagree, throw — that's
 * always a configuration bug.
 */
export function resolveManager(workerInfo: { project: { metadata?: { manager?: unknown } } }): ManagerName {
  const fromProject = normalize(workerInfo.project.metadata?.manager);
  const fromEnv = normalize(process.env.SM_MANAGER);
  if (fromProject && fromEnv && fromProject !== fromEnv) {
    throw new Error(
      `Manager mismatch: project metadata says '${fromProject}' but SM_MANAGER='${fromEnv}'. ` +
      `Unset SM_MANAGER or pick the matching --project.`
    );
  }
  const chosen = fromProject || fromEnv || 'sourcemonkey';
  if (chosen !== 'sourcemonkey' && chosen !== 'tampermonkey') {
    throw new Error(`Manager must be 'sourcemonkey' or 'tampermonkey'; got ${JSON.stringify(chosen)}`);
  }
  return chosen;
}

function normalize(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.toLowerCase();
  return s || undefined;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(__dirname, '../../dist');
const FIXTURE_PAGES_DIR = path.resolve(__dirname, 'pages');
const EXAMPLES_DIR = path.resolve(__dirname, '../examples');
const SOURCEMONKEY_EXTENSION_ID = extensionIdFromPath(EXTENSION_PATH);
const TM_CDP_PORT = Number(process.env.TM_CDP_PORT || 9223);
const TM_PROFILE_DIR = path.resolve(__dirname, '../../.chrome-tampermonkey-profile');
const TM_HEADED = process.env.TM_HEADED === '1';

export interface SetupApi {
  /**
   * Install or sync every `*.user.js` in `dir` into the active manager.
   * Under SourceMonkey, registers the directory as a collection. Under
   * Tampermonkey, installs/updates scripts via the dashboard, skipping
   * already-installed entries at the same-or-newer version.
   */
  installScriptsFrom(dir: string): Promise<void>;
  /** Which manager this run is exercising. Tests can branch on this. */
  manager: ManagerName;
}

type WorkerFixtures = {
  manager: ManagerName;
  fixtureServer: FixtureServer;
  extensionContext: BrowserContext;
  /**
   * Worker-scoped TM driver — `null` under SM. Lives at worker scope
   * so its dashboard-cache (`getInstalledMap`) persists across every
   * test in the worker. Without that, every spec would re-scrape the
   * TM dashboard on `installScriptsFrom` (slow: ~1s per call).
   */
  tampermonkeyDriver: TampermonkeyDriver | null;
};

type TestFixtures = {
  setup: SetupApi;
  /**
   * Internal: snapshots which pages already existed in the context at
   * test start, then closes any new ones at test end. Runs
   * automatically per test (`auto: true`).
   *
   * Necessary under TM because the connected CDP context is the
   * user's interactive browser; pages we open during a test (the
   * spec's own `extensionContext.newPage()`, plus anything the TM
   * driver might leave around) would otherwise pile up forever,
   * especially after assertion failures that skip the spec's manual
   * `page.close()`. Under SM the persistent context dies at worker
   * teardown so this is mostly a no-op, but it doesn't hurt.
   */
  _autoCloseTestPages: void;
};

export const test = base.extend<TestFixtures, WorkerFixtures>({
  manager: [
    async ({}, use, workerInfo) => {
      const name = resolveManager(workerInfo);
      // The tampermonkey project drives ONE real browser over CDP, with
      // the developer's own profile and no per-test state reset. Several
      // workers would install and uninstall userscripts in each other's
      // way in that single browser, and nothing would put it back.
      //
      // `workers` is a global Playwright option — it cannot be set per
      // project — so the package scripts pass `--workers=1` and this catches
      // an invocation that bypassed them. Failing here, before the CDP
      // attach, beats discovering it halfway through a run against a
      // browser that is now in an unknown state.
      // `config.workers`, not `workerIndex`: this fails on the FIRST
      // worker, before anything attaches, rather than letting worker 0
      // proceed and only tripping its siblings.
      if (name === 'tampermonkey' && workerInfo.config.workers > 1) {
        throw new Error(
          'The tampermonkey project must run with --workers=1 (it shares one real '
          + 'browser and does not reset state between tests). Use `pnpm run test:e2e:tm`, '
          + 'or pass --workers=1 explicitly.',
        );
      }
      await use(name);
    },
    { scope: 'worker' },
  ],

  fixtureServer: [
    async ({}, use) => {
      const server = await createFixtureServer(FIXTURE_PAGES_DIR, EXAMPLES_DIR);
      await use(server);
      await server.close();
    },
    { scope: 'worker' },
  ],

  extensionContext: [
    async ({ manager }, use) => {
      if (manager === 'sourcemonkey') {
        const launched = await launchSourceMonkeyContext({
          extensionPath: EXTENSION_PATH,
          extensionId: SOURCEMONKEY_EXTENSION_ID,
        });
        await use(launched.ctx);
        await launched.ctx.close();
        launched.cleanup();
        return;
      }

      if (TM_HEADED) {
        // Headed (debug) mode: connect to a browser the user already
        // opened with scripts/open-test-browser-with-Tampermonkey.sh.
        // Don't close at teardown — it's their interactive session.
        const browser = await chromium.connectOverCDP(`http://127.0.0.1:${TM_CDP_PORT}`).catch((err) => {
          throw new Error(
            `Could not connect to Tampermonkey test browser at CDP port ${TM_CDP_PORT}. ` +
            `Start it first with: scripts/open-test-browser-with-Tampermonkey.sh\n` +
            `Underlying error: ${err?.message ?? err}`
          );
        });
        const ctx = browser.contexts()[0];
        if (!ctx) {
          await browser.close();
          throw new Error('Connected to TM browser but no context found.');
        }
        await use(ctx);
        // Don't close the user's browser.
        return;
      }

      // Default: headless. Launch a fresh Chromium against the
      // persistent TM profile so the installed TM extension and the
      // user's "Allow access to file URLs" toggle come along for the
      // ride. `--headless=new` is required for extension support;
      // `headless: false` keeps Playwright from forcing the old
      // headless flag, then we pass --headless=new ourselves.
      //
      // Chromium locks the profile dir — if the user has the headed
      // browser open against the same profile, this throws. Surface a
      // friendly message in that case.
      if (!fs.existsSync(TM_PROFILE_DIR)) {
        throw new Error(
          `TM profile not found at ${TM_PROFILE_DIR}. ` +
          `First-time setup: run scripts/open-test-browser-with-Tampermonkey.sh and install TM ` +
          `from the Chrome Web Store, then close the browser. ` +
          `See docs/cross-manager-testing.md.`
        );
      }
      // `ignoreDefaultArgs: ['--disable-extensions']` is the load-bearing
      // bit: Playwright passes `--disable-extensions` by default, which
      // suppresses every extension in the profile. The SM fixture
      // sidesteps this with `--disable-extensions-except=<unpacked-path>`,
      // but TM was CWS-installed into the profile so we have no unpacked
      // path to point at — we have to suppress the default flag instead.
      // Without this, TM doesn't load and the chrome-extension:// URL
      // returns ERR_BLOCKED_BY_CLIENT.
      const ctx = await chromium.launchPersistentContext(TM_PROFILE_DIR, {
        headless: false,
        args: ['--headless=new'],
        ignoreDefaultArgs: ['--disable-extensions'],
      }).catch((err) => {
        const msg = String(err?.message ?? err);
        if (msg.includes('ProcessSingleton') || msg.includes('SingletonLock') || msg.includes('already in use')) {
          throw new Error(
            `TM profile is locked — another Chromium is using ${TM_PROFILE_DIR}. ` +
            `Close the headed browser (or set TM_HEADED=1 to connect to it instead). ` +
            `Underlying error: ${msg}`
          );
        }
        throw err;
      });
      await use(ctx);
      await ctx.close();
    },
    { scope: 'worker' },
  ],

  tampermonkeyDriver: [
    async ({ manager, extensionContext }, use) => {
      if (manager !== 'tampermonkey') {
        await use(null);
        return;
      }
      const driver = new TampermonkeyDriver(extensionContext, getTampermonkeyExtensionId());
      // Nobody is watching to click "OK" on TM's GM-permission prompts
      // (GM_download raises one), and an unanswered prompt means the GM
      // call never settles.
      driver.autoApprovePermissionPrompts();
      await use(driver);
    },
    { scope: 'worker' },
  ],

  _autoCloseTestPages: [
    async ({ extensionContext }, use) => {
      const preExisting = new Set(extensionContext.pages());
      await use();
      for (const p of extensionContext.pages()) {
        if (!preExisting.has(p) && !p.isClosed()) {
          try { await p.close(); } catch { /* already gone */ }
        }
      }
    },
    { auto: true },
  ],

  setup: async ({ extensionContext, manager, tampermonkeyDriver }, use) => {
    if (manager === 'sourcemonkey') {
      const getServiceWorker = makeGetServiceWorker(extensionContext);
      const sm = makeSwApi(getServiceWorker);
      // Per-test clean slate matches tests/fixtures/extension.ts: each
      // test starts with no collections registered, no scripts in storage.
      await sm.resetAllState();
      await use({
        manager,
        installScriptsFrom: async (dir: string) => {
          await sm.addCollection(dir);
          await sm.syncNow();
        },
      });
      try { await sm.resetAllState(); } catch {}
      return;
    }

    // Tampermonkey: reuse the worker-scoped driver so the dashboard-cache
    // is hit only once per worker. Scripts persist in the user's
    // profile across tests AND runs; syncTampermonkeyScripts is
    // idempotent (skip when name+version matches), so after the
    // initial scrape the per-test cost is just a Map lookup.
    if (!tampermonkeyDriver) throw new Error('tampermonkeyDriver missing under tampermonkey manager');
    const driver = tampermonkeyDriver;
    await use({
      manager,
      installScriptsFrom: async (dir: string) => {
        await syncTampermonkeyScripts(driver, dir);
      },
    });
  },
});

export const expect = test.expect;
