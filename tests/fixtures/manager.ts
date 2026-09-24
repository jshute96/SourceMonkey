// Manager-agnostic Playwright fixture for the examples / compliance
// suite. Picks a backend per the active Playwright project:
//
//   --project=sourcemonkey   — launches Chromium with the unpacked
//     dist/ extension, same shape as tests/fixtures/extension.ts.
//   --project=tampermonkey   — connects to a persistent profile with
//     Tampermonkey (TM) installed from the Chrome Web Store.
//   --project=violentmonkey  — the same, for Violentmonkey (VM).
//   --project=harness        — no manager at all: a plain Chromium, with
//     the development harness (src/harness/) injecting the scripts and
//     a Node host standing in for the service worker. Running the
//     examples this way checks that host against the real worker; see
//     docs/harness-design.md.
//
// The two external managers share one code path here; everything that
// differs between them (profile directory, CDP port, env-var names) is
// a row in tests/fixtures/managers.mjs.
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

import { test as base, chromium, type BrowserContext } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
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
import {
  ViolentmonkeyDriver,
  getViolentmonkeyExtensionId,
  syncViolentmonkeyScripts,
} from './violentmonkey-driver.mjs';
import {
  EXTERNAL_MANAGERS,
  managerCdpPort,
  managerConfig,
  managerHeaded,
} from './managers.mjs';
import { listUserscriptsRecursive } from './userscript-files.mjs';
import { HarnessHost } from '../../lib/harness/host.js';
import { attachPage, readUserAgentData } from '../../lib/harness/inject.js';
import { prepareScript, type PreparedScript } from '../../lib/harness/prepare.js';

/**
 * The managers this fixture can drive. Everything but `sourcemonkey`
 * comes from the `managers.mjs` table — adding a row there is what
 * makes a new backend possible, and this union is the one other place
 * that has to learn its name.
 */
export type ExternalManagerName = 'tampermonkey' | 'violentmonkey';
export type ManagerName = 'sourcemonkey' | 'harness' | ExternalManagerName;

/** Narrowing helper so the shared external-manager paths type-check. */
function isExternal(name: ManagerName): name is ExternalManagerName {
  return name !== 'sourcemonkey' && name !== 'harness';
}

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
  if (chosen !== 'sourcemonkey' && chosen !== 'harness' && !EXTERNAL_MANAGERS.includes(chosen)) {
    throw new Error(
      `Manager must be one of sourcemonkey, harness, ${EXTERNAL_MANAGERS.join(', ')}; `
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
const EXTENSION_PATH = path.resolve(__dirname, '../../dist');
const FIXTURE_PAGES_DIR = path.resolve(__dirname, 'pages');
const EXAMPLES_DIR = path.resolve(__dirname, '../examples');
const SOURCEMONKEY_EXTENSION_ID = extensionIdFromPath(EXTENSION_PATH);

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
   * Necessary under TM and VM because the connected CDP context is
   * the user's interactive browser; pages we open during a test (the
   * spec's own `extensionContext.newPage()`, plus anything a manager
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
      // An external-manager project drives ONE real browser over CDP,
      // with the developer's own profile and no per-test state reset.
      // Several workers would install and uninstall userscripts in each
      // other's way in that single browser, and nothing would put it back.
      //
      // `workers` is a global Playwright option — it cannot be set per
      // project — so the package scripts pass `--workers=1` and this catches
      // an invocation that bypassed them. Failing here, before the CDP
      // attach, beats discovering it halfway through a run against a
      // browser that is now in an unknown state.
      // `config.workers`, not `workerIndex`: this fails on the FIRST
      // worker, before anything attaches, rather than letting worker 0
      // proceed and only tripping its siblings.
      if (isExternal(name) && workerInfo.config.workers > 1) {
        throw new Error(
          `The ${name} project must run with --workers=1 (it shares one real `
          + `browser and does not reset state between tests). Use `
          + `\`pnpm run test:e2e:${managerConfig(name).scriptSuffix}\`, `
          + `or pass --workers=1 explicitly.`,
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
      if (manager === 'harness') {
        // No extension: a plain headless Chromium. The scripts reach
        // its pages through `setup.installScriptsFrom` below.
        const browser = await chromium.launch();
        const ctx = await browser.newContext();
        await use(ctx);
        await ctx.close();
        await browser.close();
        return;
      }
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

      const cfg = managerConfig(manager);
      const port = managerCdpPort(manager);
      const opener = `scripts/open-test-browser.sh ${manager}`;

      if (managerHeaded(manager)) {
        // Headed (debug) mode: connect to a browser the user already
        // opened with the opener script. Don't close at teardown —
        // it's their interactive session.
        const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`).catch((err) => {
          throw new Error(
            `Could not connect to the ${cfg.label} test browser at CDP port ${port}. ` +
            `Start it first with: ${opener}\n` +
            `Underlying error: ${err?.message ?? err}`
          );
        });
        const ctx = browser.contexts()[0];
        if (!ctx) {
          await browser.close();
          throw new Error(`Connected to the ${cfg.label} browser but no context found.`);
        }
        await use(ctx);
        // Don't close the user's browser.
        return;
      }

      // Default: headless. Launch a fresh Chromium against the
      // manager's persistent profile so the installed extension and the
      // user's "Allow access to file URLs" toggle come along for the
      // ride. `--headless=new` is required for extension support;
      // `headless: false` keeps Playwright from forcing the old
      // headless flag, then we pass --headless=new ourselves.
      //
      // Chromium locks the profile dir — if the user has the headed
      // browser open against the same profile, this throws. Surface a
      // friendly message in that case.
      if (!fs.existsSync(cfg.profileDir)) {
        throw new Error(
          `${cfg.label} profile not found at ${cfg.profileDir}. ` +
          `First-time setup: run ${opener} and install ${cfg.label} ` +
          `from the Chrome Web Store, then close the browser. ` +
          `See docs/cross-manager-testing.md.`
        );
      }
      // `ignoreDefaultArgs: ['--disable-extensions']` is the load-bearing
      // bit: Playwright passes `--disable-extensions` by default, which
      // suppresses every extension in the profile. The SM fixture
      // sidesteps this with `--disable-extensions-except=<unpacked-path>`,
      // but these managers were CWS-installed into the profile so we have
      // no unpacked path to point at — we have to suppress the default
      // flag instead. Without this, the manager doesn't load and the
      // chrome-extension:// URL returns ERR_BLOCKED_BY_CLIENT.
      const ctx = await chromium.launchPersistentContext(cfg.profileDir, {
        headless: false,
        args: ['--headless=new'],
        ignoreDefaultArgs: ['--disable-extensions'],
      }).catch((err) => {
        const msg = String(err?.message ?? err);
        if (msg.includes('ProcessSingleton') || msg.includes('SingletonLock') || msg.includes('already in use')) {
          throw new Error(
            `The ${cfg.label} profile is locked — another Chromium is using ${cfg.profileDir}. ` +
            `Close the headed browser (or set ${cfg.headedEnv}=1 to connect to it instead). ` +
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

  externalDriver: [
    async ({ manager, extensionContext }, use) => {
      if (manager === 'tampermonkey') {
        const driver = new TampermonkeyDriver(extensionContext, getTampermonkeyExtensionId());
        // Nobody is watching to click "OK" on TM's GM-permission prompts
        // (GM_download raises one), and an unanswered prompt means the GM
        // call never settles. VM needs no equivalent — it falls back to
        // an anchor download rather than prompting for `chrome.downloads`.
        driver.autoApprovePermissionPrompts();
        await use(driver);
        return;
      }
      if (manager === 'violentmonkey') {
        await use(new ViolentmonkeyDriver(extensionContext, getViolentmonkeyExtensionId()));
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
    if (manager === 'harness') {
      // A per-test download directory, so parallel workers writing the
      // same name can't collide in the shared default.
      const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sourcemonkey-harness-downloads-'));
      await use(await harnessSetup(extensionContext, downloadDir, `${fixtureServer.baseUrl}/blank.html`));
      fs.rmSync(downloadDir, { recursive: true, force: true });
      return;
    }
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
    // list is read only once per worker. Scripts persist in the user's
    // profile across tests AND runs, and both sync helpers are
    // idempotent (skip when name+version matches), so after the initial
    // read the per-test cost is just a Map lookup.
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

interface HarnessState {
  host: HarnessHost;
  prepared: PreparedScript[];
}

// Per context, because the context is worker-scoped and `setup` is
// per test: `newPage` is patched once and reads the current test's
// state from here, so the patch never wraps itself.
const harnessStates = new WeakMap<BrowserContext, HarnessState>();

/**
 * The harness backend of `setup`. `installScriptsFrom` prepares every
 * userscript under `dir` (the directory is the collection root, so
 * relative and local `@require`s resolve as under SourceMonkey), and
 * from then on every page the spec opens through
 * `extensionContext.newPage()` gets them injected before the spec can
 * navigate it. Pages are attached inside `newPage` rather than from the
 * context's `page` event, which fires asynchronously and would race the
 * spec's first `goto`.
 */
async function harnessSetup(ctx: BrowserContext, downloadDir: string, probeUrl: string): Promise<SetupApi> {
  let state = harnessStates.get(ctx);
  if (!state) {
    state = { host: new HarnessHost(), prepared: [] };
    harnessStates.set(ctx, state);
    // Once per browser: the brands `GM_info` reports come from a page
    // on a secure origin (the fixture server is one), and the scripts
    // are prepared before any spec opens a page.
    const probe = await ctx.newPage();
    await probe.goto(probeUrl);
    await readUserAgentData(probe);
    await probe.close();
    const originalNewPage = ctx.newPage.bind(ctx);
    ctx.newPage = async () => {
      const page = await originalNewPage();
      const current = harnessStates.get(ctx)!;
      const attachment = await attachPage(page, current.host);
      for (const script of current.prepared) await attachment.inject(script);
      return page;
    };
  }
  // A fresh host per test: no values, reports, or scripts carried over,
  // matching the SM branch's `resetAllState`.
  state.host = new HarnessHost();
  state.host.downloadDir = downloadDir;
  state.prepared = [];
  const s = state;
  // A tab `GM_openInTab` opens is created over CDP, born navigating to
  // its URL, and never passes through `newPage`; it gets no scripts.
  // The extension would inject whatever matches it. No example asserts
  // on that, and attaching after the fact would only reach the tab's
  // next document.
  return {
    manager: 'harness',
    installScriptsFrom: async (dir: string) => {
      s.prepared = [];
      for (const { filepath } of listUserscriptsRecursive(dir)) {
        const p = await prepareScript({ file: filepath, collectionRoot: dir });
        if (p.status !== 'ok') throw new Error(`Example script is invalid under the harness: ${p.diagnostic}`);
        s.prepared.push(p);
      }
    },
  };
}

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
