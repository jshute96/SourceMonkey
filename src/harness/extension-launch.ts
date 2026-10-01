// `sm-dev --temp-browser start --extension`: a throwaway Chromium with
// the package's built SourceMonkey (dist/) loaded, for trying a script
// in the real extension without setting up a browser by hand.
//
// - Playwright's Chromium, since Google Chrome (137+) ignores
//   `--load-extension`. Hidden runs use Chrome's new headless mode
//   (`--headless=new`), the only headless mode that loads extensions.
// - A fresh profile in a temp directory, deleted when the run ends. Its
//   Preferences grant "Allow User Scripts" before launch, which Chrome
//   otherwise leaves to a click (chrome.userScripts is undefined
//   without it), and pin the extension to the toolbar.
// - Launched as a persistent context (a profile directory needs one),
//   which has no Playwright `Browser`. The run connects over CDP to the
//   launched browser's port for that, as it would to any browser.
// - Mirrors tests/fixtures/sourcemonkey-launch.ts, which the e2e tests
//   launch the extension with.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { BrowserContext } from '@playwright/test';

import { leaveDialogsOpen } from './console-commands.js';
import { ExtensionBackend, ExtensionMissingError, findExtensionWorker, sourceMonkeyExtensionId } from './extension-backend.js';
import { rebuildAdvice } from './stale-build.js';

// dist/, beside lib/: in the checkout, and in an installed package,
// which ships both.
const EXTENSION_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist');

export interface LaunchedExtensionBrowser {
  /** The launched browser's CDP endpoint, for the run to connect to. */
  endpoint: string;
  /** The temp profile, deleted by `close`. */
  profile: string;
  /** Closes the browser and deletes its profile. */
  close(): Promise<void>;
}

/**
 * Launches Chromium with SourceMonkey loaded. Throws an error saying why
 * when it can't. It has one blank tab, opened after the warm-up (see
 * `warmUp`), for the run's first tab.
 */
export async function launchExtensionBrowser(headed: boolean): Promise<LaunchedExtensionBrowser> {
  if (!existsSync(path.join(EXTENSION_DIR, 'manifest.json'))) {
    throw new Error(`The built extension is missing from ${EXTENSION_DIR}. ${rebuildAdvice()}`);
  }
  const profile = mkdtempSync(path.join(os.tmpdir(), 'sm-dev-extension-'));
  let context: BrowserContext | undefined;
  const close = async (): Promise<void> => {
    await context?.close().catch(() => undefined);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* Chrome may hold a file briefly */ }
  };
  try {
    writePreferences(profile, await sourceMonkeyExtensionId());
    await primeFirstRun(profile);
    // Port 0 has Chrome pick a free port and write it to the profile.
    // A port picked here could be taken before Chrome binds it, and the
    // run would connect to whatever took it.
    context = await launch(profile, headed, ['--remote-debugging-port=0']);
    const port = readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0].trim();
    // This Playwright client isn't the run's, so it leaves the run's
    // dialogs to the run.
    leaveDialogsOpen(context);
    await warmUp(context);
    // The launch's first tab predates the warm-up, so scripts fail in
    // it. A new one replaces it (opened first: a headed browser with
    // no tab left would quit).
    const stale = context.pages();
    await context.newPage();
    for (const page of stale) await page.close();
    return { endpoint: `http://127.0.0.1:${port}`, profile, close };
  } catch (err) {
    await close();
    if (err instanceof ExtensionMissingError) throw new Error(`Chromium did not load the extension from ${EXTENSION_DIR}`);
    throw err;
  }
}

async function launch(profile: string, headed: boolean, args: string[] = []): Promise<BrowserContext> {
  const { chromium } = await import('@playwright/test');
  try {
    return await chromium.launchPersistentContext(profile, {
      // `headless: false` keeps Playwright from adding its own headless
      // flag (the old mode, which doesn't load extensions); a hidden
      // browser gets `--headless=new` instead.
      headless: false,
      // The run closes it as it stops, on the signals it handles itself.
      // Playwright's own handlers would close it first, and the run would
      // report the browser gone. It still closes it if sm-dev exits.
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
      args: [
        ...(headed ? [] : ['--headless=new', '--mute-audio']),
        `--disable-extensions-except=${EXTENSION_DIR}`,
        `--load-extension=${EXTENSION_DIR}`,
        ...args,
      ],
    });
  } catch (err) {
    // Playwright's message starts with the call's name, and may go on
    // for lines (a boxed install hint); the first line says what failed.
    const first = (err as Error).message.split('\n')[0].replace(/^browserType\.\w+: /, '');
    throw new Error(`Chromium could not start: ${first}`);
  }
}

/**
 * Installs a script and removes it again, before the run opens its tab.
 *
 * - In a fresh profile, a tab opened before the extension's first script
 *   install can't message the extension, even after a reload: a script
 *   that runs there reports that it couldn't read its stored GM values.
 *   Only a tab in a new renderer process (another site) recovers.
 * - The run pushes its scripts after its tab is open, so it needs a tab
 *   opened after this. See TODO.md.
 */
async function warmUp(context: BrowserContext): Promise<void> {
  const backend = await ExtensionBackend.connect(context);
  await backend.push('// ==UserScript==\n// @name sm-dev warm-up\n// @match https://sm-dev.invalid/*\n// ==/UserScript==\n');
  await backend.clear();
}

// Grants the extension "Allow User Scripts" and pins it to the toolbar,
// with the keys Chrome writes when those are clicked.
function writePreferences(profile: string, extensionId: string): void {
  const dir = path.join(profile, 'Default');
  mkdirSync(dir, { recursive: true });
  const prefs = { extensions: { settings: { [extensionId]: { user_scripts_enabled: true } }, pinned_extensions: [extensionId] } };
  writeFileSync(path.join(dir, 'Preferences'), JSON.stringify(prefs));
}

/**
 * Marks the extension's first run done, in a launch of its own before
 * the run's.
 *
 * - On a first run, the extension opens its collections page, which adds
 *   the default collections from GitHub. Their scripts would then run
 *   alongside the one being tried.
 * - That starts while the browser is still starting, so the flag can't
 *   be set in time in the run's own launch. Set here, it's in storage
 *   for the next launch, whose first-run check then does nothing.
 * - This launch may still have started the page's adds, so it closes the
 *   page and removes what they added.
 */
async function primeFirstRun(profile: string): Promise<void> {
  const context = await launch(profile, false);
  try {
    const worker = await findExtensionWorker(context);
    // Key mirrors FIRST_RUN_DONE_KEY in src/script-store.ts.
    await worker.evaluate(() => chrome.storage.local.set({ firstRunComplete: true }));
    for (const page of context.pages()) {
      if (page.url().includes('/collections.html')) await page.close().catch(() => undefined);
    }
    await worker.evaluate(async () => {
      type Surface = { getCollections(): Promise<{ id: string }[]>; removeCollection(id: string): Promise<void> };
      const sm = (self as unknown as { SourceMonkey: Surface }).SourceMonkey;
      for (const c of await sm.getCollections()) await sm.removeCollection(c.id);
    });
  } finally {
    // A clean close is what writes the storage to disk.
    await context.close();
  }
}
