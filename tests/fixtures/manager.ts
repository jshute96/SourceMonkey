// Manager-agnostic Playwright fixture for the examples / compliance
// suite. Picks a backend per the active Playwright project:
//
//   --project=sourcemonkey   — launches Chromium with the unpacked
//     dist/ extension, same shape as tests/fixtures/extension.ts.
//   --project=tampermonkey   — launches Chromium in a new temporary
//     profile with Tampermonkey (TM) loaded, from sm-dev's cache of
//     the Web Store build (see manager-launch.ts).
//   --project=violentmonkey  — the same, for Violentmonkey (VM).
//
// The two external managers share one code path here; everything that
// differs between them (label, extension ID, env-var names) is a row
// in tests/fixtures/managers.mjs.
//
// The project's `metadata.manager` field is what we read. The
// SM_MANAGER env var is a fallback for direct `pnpm exec playwright test
// <file>` runs that don't pass --project; if both are set and
// disagree, we throw.
//
// Tests get a single `setup.installScriptsFrom(dir)` helper that does
// the right thing per manager: a directory collection under SM, an
// import-from-file per script under TM, and a background install
// keyed to the fixture server's URL under VM.

import { test as base, type BrowserContext } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeSwApi } from './sw-api';
import {
  createFixtureServer,
  launchSourceMonkeyContext,
  makeGetServiceWorker,
  type FixtureServer,
} from './sourcemonkey-launch';
import {
  TampermonkeyDriver,
  syncTampermonkeyScripts,
} from './tampermonkey-driver.mjs';
import {
  ViolentmonkeyDriver,
  syncViolentmonkeyScripts,
} from './violentmonkey-driver.mjs';
import {
  EXTERNAL_MANAGERS,
  managerConfig,
  managerHeaded,
} from './managers.mjs';
import { launchManagerContext } from './manager-launch';
import { fetchedId } from '../../lib/harness/extension-launch.js';
import { fetchedDir } from '../../lib/harness/manager-fetch.js';

/**
 * The managers this fixture can drive. Everything but `sourcemonkey`
 * comes from the `managers.mjs` table — adding a row there is what
 * makes a new backend possible, and this union is the one other place
 * that has to learn its name.
 */
export type ExternalManagerName = 'tampermonkey' | 'violentmonkey';
export type ManagerName = 'sourcemonkey' | ExternalManagerName;

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
  if (chosen !== 'sourcemonkey' && !EXTERNAL_MANAGERS.includes(chosen)) {
    throw new Error(
      `Manager must be one of sourcemonkey, ${EXTERNAL_MANAGERS.join(', ')}; `
      + `got ${JSON.stringify(chosen)}`,
    );
  }
  return chosen as ManagerName;
}

function normalize(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.toLowerCase();
  return s || undefined;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PAGES_DIR = path.resolve(__dirname, 'pages');
const EXAMPLES_DIR = path.resolve(__dirname, '../examples');

export interface SetupApi {
  /**
   * Install or sync every `*.user.js` in `dir` into the active manager.
   * Under SourceMonkey, registers the directory as a collection. Under
   * TM and VM, installs or updates each script, skipping entries
   * already present at the same-or-newer version.
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
   * Worker-scoped driver for the active external manager — `null`
   * under SM. Lives at worker scope so its installed-scripts cache
   * (`getInstalledMap`) persists across every test in the worker.
   * Without that, every spec would re-read the manager's script list
   * on `installScriptsFrom` (slow: ~1s per call under TM).
   */
  externalDriver: TampermonkeyDriver | ViolentmonkeyDriver | null;
};

type TestFixtures = {
  setup: SetupApi;
  /**
   * Internal: snapshots which pages already existed in the context at
   * test start, then closes any new ones at test end. Runs
   * automatically per test (`auto: true`).
   *
   * A worker's browser lives for all its tests, so pages a test opens
   * (the spec's own `extensionContext.newPage()`, plus anything a
   * manager driver leaves around) would otherwise pile up, especially
   * after assertion failures that skip the spec's manual
   * `page.close()`.
   */
  _autoCloseTestPages: void;
};

export const test = base.extend<TestFixtures, WorkerFixtures>({
  manager: [
    async ({}, use, workerInfo) => {
      const name = resolveManager(workerInfo);
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
        const launched = await launchSourceMonkeyContext();
        await use(launched.ctx);
        await launched.close();
        return;
      }

      // A new browser and profile per worker, with the manager freshly
      // loaded: see manager-launch.ts. `test:e2e:tm:headed` and
      // `:vm:headed` set the headed env var, to watch the run.
      const launched = await launchManagerContext(manager, managerHeaded(manager));
      await use(launched.ctx);
      await launched.close();
    },
    // Room for the first run, which downloads the manager before the
    // browser starts. Playwright's default for a worker fixture is 30s.
    { scope: 'worker', timeout: 180_000 },
  ],

  externalDriver: [
    async ({ manager, extensionContext }, use) => {
      if (manager === 'tampermonkey') {
        const driver = new TampermonkeyDriver(extensionContext, fetchedId(fetchedDir(manager), manager));
        // Nobody is watching to click "OK" on TM's GM-permission prompts
        // (GM_download raises one), and an unanswered prompt means the GM
        // call never settles. VM needs no equivalent — it falls back to
        // an anchor download rather than prompting for `chrome.downloads`.
        driver.autoApprovePermissionPrompts();
        await use(driver);
        return;
      }
      if (manager === 'violentmonkey') {
        await use(new ViolentmonkeyDriver(extensionContext, fetchedId(fetchedDir(manager), manager)));
        return;
      }
      await use(null);
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

  setup: async ({ extensionContext, fixtureServer, manager, externalDriver }, use) => {
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

    // TM / VM: reuse the worker-scoped driver so the installed-scripts
    // list is read only once per worker. Scripts stay installed across
    // the worker's tests, and both sync helpers are idempotent (skip
    // when name+version matches), so after the first install the
    // per-test cost is just a Map lookup.
    if (!externalDriver) throw new Error(`externalDriver missing under the ${manager} manager`);

    // Dispatch on the manager name, the same way the driver fixture
    // does, so a future backend fails here instead of silently taking
    // whichever branch happens to be last.
    if (manager === 'violentmonkey' && externalDriver instanceof ViolentmonkeyDriver) {
      const driver = externalDriver;
      await use({
        manager,
        installScriptsFrom: async (dir: string) => {
          await syncViolentmonkeyScripts(driver, dir, (filepath) => exampleUrl(fixtureServer, filepath));
        },
      });
      return;
    }
    if (manager === 'tampermonkey' && externalDriver instanceof TampermonkeyDriver) {
      const driver = externalDriver;
      await use({
        manager,
        installScriptsFrom: async (dir: string) => {
          await syncTampermonkeyScripts(driver, dir);
        },
      });
      return;
    }
    throw new Error(`No install path wired up for the ${manager} manager`);
  },
});

export const expect = test.expect;

/**
 * The URL this worker's fixture server serves `filepath` at.
 *
 * VM installs a script *from a URL* and resolves its relative
 * `@require` / `@resource` / `@icon` refs against it, so a VM install
 * has to name the served copy of the file rather than its path on
 * disk. The server binds a fresh port per worker, so this is computed
 * per run rather than baked into the example.
 */
function exampleUrl(server: FixtureServer, filepath: string): string {
  const rel = path.relative(EXAMPLES_DIR, filepath).split(path.sep).join('/');
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Example script is outside ${EXAMPLES_DIR}: ${filepath}`);
  }
  return `${server.baseUrl}/${rel}`;
}
