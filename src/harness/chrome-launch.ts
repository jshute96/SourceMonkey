// `sm-dev --temp-browser --browser-type chrome`: a throwaway Google Chrome
// for a run, which gets past some bot checks that stop Playwright's
// Chromium.
//
// - Spawned on its own (see `startBrowser`), not through Playwright's
//   launch, with the manager loaded over CDP: Google Chrome (137+) ignores
//   `--load-extension`.
// - A new empty profile in a temp directory, with the `sm-dev-chrome-`
//   prefix, deleted with `close`, or when the run exits or a signal ends
//   it first.
// - A run killed outright (SIGKILL) can't clean up: its Chrome keeps
//   running, and the profile stays. Chrome's command line names the
//   profile, which has that prefix, so that is how to find both.

import type { ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, type RmOptions } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { allowUserScripts, loadUnpacked } from './browser-extensions.js';
import { browserBinary, startBrowser } from './browser-launch.js';
import { ExtensionMissingError, sourceMonkeyExtensionId } from './extension-backend.js';
import {
  extensionNotLoaded, fetchedId, managerDir, markFirstRunDone, MOUSE_SETTINGS, portFree, portInUse, quietTampermonkey, warmUp, windowedUserAgent, writePreferences,
} from './extension-launch.js';
import type { ManagerName } from './managers.js';
import { loadPlaywright } from './playwright-chromium.js';

// A hidden Chrome's window, whose own UI takes 87px, so its pages get the
// 1280x720 a hidden temp Chromium's do. Its default is much narrower
// (780x493), where some sites show their phone layout.
const HIDDEN_WINDOW_SIZE = '--window-size=1280,807';

// How long Chrome gets to quit before it's killed.
const QUIT_TIMEOUT_MS = 5_000;

// Chrome can still be writing to the profile for a moment after it exits.
const REMOVE_PROFILE: RmOptions = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 };

// The longest temp directory Chrome can be given. Its singleton socket
// goes in a folder there, and Chrome fails to start when that socket's
// path is longer than a socket's can be (104 bytes on macOS, 108 on Linux).
const MAX_TEMP_LENGTH = 104 - '/com.google.Chrome.XXXXXX/SingletonSocket'.length;

// The signals that would end a run with Chrome still running. Windows has
// no SIGHUP.
const SIGNALS: NodeJS.Signals[] = process.platform === 'win32' ? ['SIGINT', 'SIGTERM'] : ['SIGINT', 'SIGTERM', 'SIGHUP'];

export interface TempChromeOptions {
  /** The debugging port, which must be free. A free one is picked when not given. */
  port?: number;
  /** A visible window. Hidden otherwise. */
  headed?: boolean;
  /** Without sound (the default), or with it when false. */
  muted?: boolean;
  /** More Chrome flags. */
  args?: string[];
  /** Where Chrome saves downloads. */
  downloadsDir?: string;
  manager: ManagerName;
}

/**
 * Launches Google Chrome on a new empty profile, with the manager loaded
 * and "Allow User Scripts" on, and one blank tab for a run's first tab.
 * `close` closes it and deletes the profile. Throws an error saying why
 * when it can't launch it.
 */
export async function launchTempChrome(options: TempChromeOptions): Promise<{ endpoint: string; close(): Promise<void> }> {
  const { manager, port } = options;
  const dir = managerDir(manager);
  const { file, name } = await browserBinary('chrome');
  if (port !== undefined && !await portFree(port)) throw new Error(portInUse(port));
  const profile = mkdtempSync(path.join(os.tmpdir(), 'sm-dev-chrome-'));
  // Chrome's own temp files, which it leaves when it quits (its
  // `SingletonSocket`, say), go in the profile, to be deleted with it.
  // Not when that path is too long, as macOS's temp directory makes it:
  // they're left in the temp directory then.
  const temp = path.join(profile, 'tmp');
  const ownTemp = temp.length <= MAX_TEMP_LENGTH;
  if (ownTemp) mkdirSync(temp);
  let child: ChildProcess | undefined;
  const removeProfile = (): void => {
    try { rmSync(profile, REMOVE_PROFILE); } catch { /* Chrome may hold a file */ }
  };
  const end = (): void => {
    if (child) killAll(child);
    removeProfile();
  };
  // A run that exits without closing it (an uncaught error, say).
  const onExit = end;
  // A signal with no handler ends Node at once, with no `exit` event,
  // and Chrome, spawned on its own, would keep running. This ends Chrome
  // and then the run, as the signal would have. It stands aside while
  // the run has its own handler, which closes this Chrome: it's
  // registered first, so it runs while that handler is still there.
  // Before the run sets that handler, and after it drops it to tear
  // down, this one acts.
  const onSignal = (signal: NodeJS.Signals): void => {
    if (process.listenerCount(signal) > 1) return;
    end();
    release();
    process.kill(process.pid, signal);
  };
  const release = (): void => {
    process.off('exit', onExit);
    for (const signal of SIGNALS) process.off(signal, onSignal);
  };
  process.on('exit', onExit);
  for (const signal of SIGNALS) process.on(signal, onSignal);
  const close = async (): Promise<void> => {
    if (child) await quit(child);
    removeProfile();
    release();
  };
  try {
    const id = manager === 'sourcemonkey' ? await sourceMonkeyExtensionId() : fetchedId(dir, manager);
    writePreferences(profile, id, options.downloadsDir);
    const userAgent = options.headed ? null : await windowedUserAgent(file).catch(() => null);
    const endpoint = `http://127.0.0.1:${port ?? await freePort()}`;
    await startBrowser({
      file, name, dir: profile, endpoint,
      env: ownTemp ? { ...process.env, TMPDIR: temp } : undefined,
      onSpawn: (spawned) => { child = spawned; },
      throwaway: true,
      args: [
        ...(options.headed ? [] : ['--headless=new', HIDDEN_WINDOW_SIZE, MOUSE_SETTINGS]),
        ...(userAgent ? [`--user-agent=${userAgent}`] : []),
        ...(options.muted === false ? [] : ['--mute-audio']),
        ...(options.args ?? []),
      ],
    });
    const loaded = await loadUnpacked(endpoint, dir);
    await allowUserScripts(endpoint, loaded);
    await settleTabs(endpoint, manager, loaded);
    return { endpoint, close };
  } catch (err) {
    await close();
    if (err instanceof ExtensionMissingError) throw new Error(extensionNotLoaded(name, dir));
    throw err;
  }
}

// A free port for Chrome. Not `--remote-debugging-port=0`, which has Chrome
// pick one, since Chrome treats that as automation: it reports
// `navigator.webdriver`, which brings back the bot checks this browser is
// for (Google's `/sorry`). Something else could take the port before Chrome
// binds it. A browser that took it would then get the manager and the run,
// since the start only waits for an answer at the port. That's rare enough
// to leave.
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

// Asks Chrome to quit, and kills it if it hasn't soon after.
async function quit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    killAll(child);
    return;
  }
  const gone = new Promise<void>((resolve) => { child.once('exit', () => resolve()); });
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), QUIT_TIMEOUT_MS);
  await gone;
  clearTimeout(timer);
  killAll(child);
}

// Kills Chrome and its helpers at once. Its main process exits first, and
// its helpers can go on writing to the profile for long enough that it can't
// be deleted (`ENOTEMPTY`). It's spawned as its own process group, which they
// are in. Windows has no process groups, so there only the main process is
// killed.
function killAll(child: ChildProcess): void {
  if (process.platform === 'win32') {
    child.kill();
    return;
  }
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch { /* They've all gone */ }
}

// Readies the manager for a run: its first run done, the warm-up a new
// profile needs, and one blank tab in place of what's open so far, which
// predates the warm-up and may include the page a manager opens on its
// first run.
async function settleTabs(endpoint: string, manager: ManagerName, id: string): Promise<void> {
  const { chromium } = await loadPlaywright();
  const browser = await chromium.connectOverCDP(endpoint, { noDefaults: true });
  try {
    const context = browser.contexts()[0] ?? await browser.newContext();
    if (manager === 'sourcemonkey') {
      await markFirstRunDone(context);
      await warmUp(context);
    } else if (manager === 'tampermonkey') {
      await quietTampermonkey(context, id);
    }
    const stale = context.pages();
    // Opened first: a headed browser with no tab left would quit.
    await context.newPage();
    for (const page of stale) await page.close();
  } finally {
    await browser.close();
  }
}
