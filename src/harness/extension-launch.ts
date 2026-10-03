// A throwaway Chromium with the package's built SourceMonkey (dist/)
// loaded: `sm-dev --temp-browser`'s browser, the `sourcemonkey/harness`
// fixture's, and the repo's own e2e suites'.
//
// - Playwright's Chromium, since Google Chrome (137+) ignores
//   `--load-extension`. Hidden runs use Chrome's new headless mode
//   (`--headless=new`), the only headless mode that loads extensions,
//   with a windowed Chrome's user agent (see `windowedUserAgent`).
// - A fresh profile in a temp directory, deleted when the browser is
//   closed. Its Preferences grant "Allow User Scripts" before launch,
//   which Chrome otherwise leaves to a click (chrome.userScripts is
//   undefined without it), and pin the extension to the toolbar.
// - Launched as a persistent context (a profile directory needs one),
//   which has no Playwright `Browser`. A caller that needs one (sm-dev's
//   run, the fixture's `browser`) connects over CDP to the launched
//   browser's port; the e2e suites use the context as it is.

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { BrowserContext } from '@playwright/test';

import { leaveDialogsOpen } from './console-commands.js';
import { ExtensionMissingError, findExtensionWorker, sourceMonkeyExtensionId } from './extension-backend.js';
import { rebuildAdvice } from './stale-build.js';

// dist/, beside lib/: in the checkout, and in an installed package,
// which ships both.
export const EXTENSION_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist');

export interface ExtensionLaunchOptions {
  /** A visible window, with sound. Hidden and muted otherwise. */
  headed?: boolean;
  /** More Chrome flags. */
  args?: string[];
  /**
   * Chrome's own download manager saves downloads here, rather than
   * Playwright's, which hides their real names and paths from
   * `chrome.downloads`.
   */
  downloadsDir?: string;
  /**
   * Another Playwright client drives the browser, over `endpoint`. The
   * launch's own client then leaves the pages' dialogs to it; otherwise
   * it would dismiss them first.
   */
  connectedElsewhere?: boolean;
}

export interface LaunchedExtensionBrowser {
  /** The launched browser's CDP endpoint, for a client to connect to. */
  endpoint: string;
  /** The launch's own Playwright context: the browser's default one. */
  context: BrowserContext;
  /** The temp profile, deleted by `close`. */
  profile: string;
  /** Closes the browser and deletes its profile. */
  close(): Promise<void>;
}

/**
 * Launches Chromium with SourceMonkey loaded. Throws an error saying why
 * when it can't. It has one blank tab, opened after the warm-up (see
 * `warmUp`), for a run's first tab.
 */
export async function launchExtensionBrowser(options: ExtensionLaunchOptions = {}): Promise<LaunchedExtensionBrowser> {
  if (!existsSync(path.join(EXTENSION_DIR, 'manifest.json'))) {
    throw new Error(`The built extension is missing from ${EXTENSION_DIR}. ${rebuildAdvice()}`);
  }
  const headed = options.headed === true;
  const profile = mkdtempSync(path.join(os.tmpdir(), 'sm-dev-extension-'));
  let context: BrowserContext | undefined;
  const close = async (): Promise<void> => {
    await context?.close().catch(() => undefined);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* Chrome may hold a file briefly */ }
  };
  try {
    await prepareProfile(profile, options.downloadsDir);
    // Port 0 has Chrome pick a free port and write it to the profile.
    // A port picked here could be taken before Chrome binds it, and the
    // run would connect to whatever took it.
    context = await launch(profile, headed, ['--remote-debugging-port=0', ...(options.args ?? [])]);
    const port = readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0].trim();
    if (options.connectedElsewhere) leaveDialogsOpen(context);
    if (options.downloadsDir) await chromeDownloads(context);
    await warmUp(context);
    // The launch's first tab predates the warm-up, so scripts fail in
    // it. A new one replaces it (opened first: a headed browser with
    // no tab left would quit).
    const stale = context.pages();
    await context.newPage();
    for (const page of stale) await page.close();
    return { endpoint: `http://127.0.0.1:${port}`, context, profile, close };
  } catch (err) {
    await close();
    if (err instanceof ExtensionMissingError) throw new Error(`Chromium did not load the extension from ${EXTENSION_DIR}`);
    throw err;
  }
}

// The user agent a windowed Chrome of this version sends, in Chrome's
// reduced form (`Chrome/153.0.0.0`). A hidden one says HeadlessChrome,
// which some servers refuse, and the extension fetches a script's
// `@require`s and `GM_xmlhttpRequest`s with it. Only the user agent
// string changes: the client hints (`Sec-CH-UA`,
// `navigator.userAgentData`) still name HeadlessChrome. Null when the
// version can't be read; the browser's own is kept then.
async function windowedUserAgent(executable: string): Promise<string | null> {
  const version = process.platform === 'win32'
    // There `chrome.exe --version` opens a window instead of printing;
    // the version is the name of a folder beside it.
    ? readdirSync(path.dirname(executable)).find((name) => /^\d+\.\d+\.\d+\.\d+$/.test(name)) ?? ''
    : await new Promise<string>((resolve) => {
      execFile(executable, ['--version'], { timeout: 5000 }, (err, stdout) => resolve(err ? '' : stdout));
    });
  const major = /(\d+)\.\d+\.\d+\.\d+/.exec(version)?.[1];
  if (!major) return null;
  const platform = process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7'
    : process.platform === 'win32' ? 'Windows NT 10.0; Win64; x64'
      : 'X11; Linux x86_64';
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

async function launch(profile: string, headed: boolean, args: string[] = []): Promise<BrowserContext> {
  const { chromium } = await import('@playwright/test');
  const userAgent = headed ? null : await windowedUserAgent(chromium.executablePath()).catch(() => null);
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
        ...(userAgent ? [`--user-agent=${userAgent}`] : []),
        ...extensionArgs(),
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
export async function warmUp(context: BrowserContext): Promise<void> {
  const worker = await findExtensionWorker(context);
  await worker.evaluate(async (text) => {
    const api = (self as unknown as { SourceMonkey: WarmUpApi }).SourceMonkey;
    const run = 'sm-dev-warm-up';
    await api.writeRunScript({ run, text });
    await api.releaseRun(run);
  }, '// ==UserScript==\n// @name sm-dev warm-up\n// @match https://sm-dev.invalid/*\n// ==/UserScript==\n');
}

// The part of the worker's `self.SourceMonkey` `warmUp` calls.
interface WarmUpApi {
  writeRunScript(args: { run: string; text: string }): Promise<unknown>;
  releaseRun(runId: string): Promise<void>;
}

/**
 * Readies a new profile for SourceMonkey (Preferences, first run done),
 * for a browser started with `extensionArgs`. Also for a test's own
 * browser, launched outside Playwright.
 */
export async function prepareProfile(profile: string, downloadsDir?: string): Promise<void> {
  writePreferences(profile, await sourceMonkeyExtensionId(), downloadsDir);
  await primeFirstRun(profile);
}

/** The Chrome flags that load the package's SourceMonkey, and only it. */
export function extensionArgs(): string[] {
  return [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`];
}

// Grants the extension "Allow User Scripts" and pins it to the toolbar,
// with the keys Chrome writes when those are clicked. With
// `downloadsDir`, also the keys Chrome writes when the download
// location is changed in its settings: `directory_upgrade` marks it
// user-chosen, so Chrome doesn't fall back to its platform default.
function writePreferences(profile: string, extensionId: string, downloadsDir?: string): void {
  const dir = path.join(profile, 'Default');
  mkdirSync(dir, { recursive: true });
  const prefs = {
    extensions: { settings: { [extensionId]: { user_scripts_enabled: true } }, pinned_extensions: [extensionId] },
    ...(downloadsDir ? { download: { default_directory: downloadsDir, directory_upgrade: true, prompt_for_download: false } } : {}),
  };
  writeFileSync(path.join(dir, 'Preferences'), JSON.stringify(prefs));
}

// Hands downloads back to Chrome. Playwright has told it to save every
// download under a GUID name in its own temp dir (CDP
// `Browser.setDownloadBehavior: allowAndName`), with no option to opt
// out. `default` undoes that, so the Preferences above apply.
async function chromeDownloads(context: BrowserContext): Promise<void> {
  const page = await context.newPage();
  try {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'default' });
    await cdp.detach();
  } finally {
    await page.close();
  }
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
    // Key mirrors FIRST_RUN_DONE_KEY in src/extension/script-store.ts.
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
