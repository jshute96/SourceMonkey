// `sm-dev --open-browser`: starts a browser that stays open after sm-dev
// exits, with a window and a debugging port, for runs to connect to.
// It is spawned on its own, as a person would start it (`startBrowser`,
// which a temp Google Chrome uses too), not through Playwright's launch.
//
// - The port is `--browser`'s (default $SM_DEV_BROWSER or 9233), which
//   is also where later commands connect, so `sm-dev --open-browser
//   start x.user.js --detach` needs nothing else.
// - The profile is kept, so sign-ins and extensions carry over:
//   `~/.config/sm-dev/browser-profile-{chrome,chromium}-<port>`, one for
//   each browser and port, since only one Chrome at a time can use a
//   profile, and a browser shouldn't open a profile another one wrote.
//   `--profile` picks another.
// - Idempotent: a browser already answering on the port is used as is.
//   With `--profile`, it must be the browser using that profile.
//   Otherwise sm-dev stops with an error, without running any commands,
//   rather than use the wrong browser.
// - Google Chrome when it's installed (better at Google sign-in than
//   other builds), else Playwright's Chromium. `--browser-type` picks
//   one, with no fallback, and is checked against a browser already on
//   the port. $SM_DEV_BROWSER_BINARY names another binary when
//   `--browser-type` isn't given, and $SM_DEV_BROWSER_ARGS adds arguments
//   (the tests add --headless=new).

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, openSync, closeSync, readFileSync, readlinkSync, renameSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { runningBrowserType } from './browser-extensions.js';
import { loadPlaywright, missingChromium } from './playwright-chromium.js';
import { processAlive } from './runs.js';
import { quoted } from './output-style.js';

// How long a started browser has to open its port.
const START_TIMEOUT_MS = 10_000;

/** Where Google Chrome is installed, by platform, most likely first. */
export function chromeCandidates(): string[] {
  if (process.platform === 'darwin') {
    return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome')];
  }
  if (process.platform === 'win32') {
    const dirs = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter((d): d is string => !!d);
    return dirs.map((d) => path.join(d, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  }
  return ['/opt/google/chrome/chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'];
}

/** `--browser-type`: which browser to launch. */
export type BrowserType = 'chrome' | 'chromium';

const BROWSER_NAMES: Record<BrowserType, string> = { chrome: 'Google Chrome', chromium: 'Chromium' };

/**
 * The browser to start, and what to call it. A `type` given must be
 * there: it doesn't fall back to the other one.
 */
export async function browserBinary(type?: BrowserType): Promise<{ file: string; name: string; type?: BrowserType }> {
  const chosen = process.env.SM_DEV_BROWSER_BINARY?.trim();
  if (chosen && !type) return { file: chosen, name: path.basename(chosen) };
  const chrome = type === 'chromium' ? undefined : chromeCandidates().find((f) => existsSync(f));
  if (chrome) return { file: chrome, name: BROWSER_NAMES.chrome, type: 'chrome' };
  if (type === 'chrome') throw new Error(`Google Chrome isn't installed. Install it, or use ${quoted('--browser-type chromium')}.`);
  const { chromium, install } = await loadPlaywright();
  const file = chromium.executablePath();
  const missing = missingChromium(file, install);
  if (missing) throw new Error(type ? missing : `No browser to launch: Google Chrome isn't installed. ${missing}`);
  return { file, name: BROWSER_NAMES.chromium, type: 'chromium' };
}

/**
 * The profile a port's browser keeps, named for the browser so neither
 * opens a profile the other wrote. A browser named by
 * `$SM_DEV_BROWSER_BINARY` has no type, and gets the plain name.
 */
export function defaultProfile(port: number, type?: BrowserType): string {
  const config = process.env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), '.config');
  return path.join(config, 'sm-dev', type ? `browser-profile-${type}-${port}` : `browser-profile-${port}`);
}

/**
 * Renames a port's profile from before names had the browser in them, so
 * its sign-ins carry over. It belongs to the browser that was the default
 * then: Google Chrome if installed, else Chromium. Throws if a browser
 * has it open.
 */
function adoptOldProfile(port: number, type: BrowserType): void {
  const dir = defaultProfile(port, type);
  const old = defaultProfile(port);
  const owner: BrowserType = chromeCandidates().some((f) => existsSync(f)) ? 'chrome' : 'chromium';
  if (type !== owner || existsSync(dir) || !existsSync(old)) return;
  const inUse = profileInUse(old);
  if (inUse) throw new Error(inUse);
  try {
    renameSync(old, dir);
  } catch {
    throw new Error(`Could not rename the profile ${withTilde(old)} to ${withTilde(dir)}, its name now. Rename it, or remove it to start with a new profile.`);
  }
  // On Linux, Chrome keeps a profile's disk cache at its path under the
  // cache directory. It can be rebuilt, so failing here doesn't matter.
  const cache = process.env.XDG_CACHE_HOME?.trim() || path.join(os.homedir(), '.cache');
  try {
    renameSync(path.join(cache, 'sm-dev', path.basename(old)), path.join(cache, 'sm-dev', path.basename(dir)));
  } catch { /* There's none, or it can't be moved */ }
}

/** The path with the home directory as ~, for messages. */
export function withTilde(file: string): string {
  const home = os.homedir();
  return file === home || file.startsWith(home + path.sep) ? '~' + file.slice(home.length) : file;
}

async function answers(endpoint: string): Promise<boolean> {
  try {
    const res = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Why the profile can't be used, when another browser has it: Chrome
 * locks a profile with a `SingletonLock` link to `host-pid`, and a
 * second browser on it hands its window to the first and exits,
 * dropping its debugging port. Null when it's free, or when the lock
 * can't be read (Windows keeps it differently) or is another machine's
 * (a shared home directory): the start then fails, or Chrome asks.
 */
function profileInUse(dir: string): string | null {
  const holder = profileHolder(dir);
  if (!holder) return null;
  return holder.port
    ? `The profile ${withTilde(dir)} is in use by the browser on port ${holder.port}. Use ${quoted(`--browser ${holder.port}`)}, or another ${quoted('--profile')}`
    : `The profile ${withTilde(dir)} is in use by a browser without a debugging port (pid ${holder.pid}). Close it, or use another ${quoted('--profile')}`;
}

// The browser on this machine holding the profile, by its lock, and the
// port it listens on, if any. Null when it's free, or when the lock
// can't be read or is another machine's (see profileInUse).
function profileHolder(dir: string): { pid: number; port?: string } | null {
  let owner: string;
  try {
    owner = readlinkSync(path.join(dir, 'SingletonLock'));
  } catch {
    return null;
  }
  const match = /^(.*)-(\d+)$/.exec(owner);
  if (!match || match[1] !== os.hostname() || !processAlive(Number(match[2]))) return null;
  return { pid: Number(match[2]), port: debuggingPort(dir, Number(match[2])) };
}

// Why the browser already at `endpoint` can't be used as `--profile`
// asks: it isn't the one holding that profile. Null when it is, and
// when that can't be told: on Windows, which locks a profile another
// way, or with a lock that is another machine's (a shared home
// directory) or can't be read. A lock left by a browser that has since
// ended holds nothing.
function otherProfile(endpoint: URL, dir: string): string | null {
  if (process.platform === 'win32') return null;
  let owner: string | null = null;
  try {
    owner = readlinkSync(path.join(dir, 'SingletonLock'));
  } catch { /* free */ }
  // A lock that isn't `host-pid`, or is another machine's, can't be traced.
  const host = owner ? /^(.*)-\d+$/.exec(owner)?.[1] : undefined;
  if (owner && host !== os.hostname()) return null;
  const holder = profileHolder(dir);
  if (holder?.port === endpoint.port) return null;
  const wrong = `The browser at ${endpoint.host} isn't using the profile ${withTilde(dir)}`;
  if (!holder) return `${wrong}. Use another ${quoted('--browser')} port to start one with it`;
  return holder.port
    ? `${wrong}. The browser on port ${holder.port} is. Use ${quoted(`--browser ${holder.port}`)}`
    : `${wrong}. A browser without a debugging port is (pid ${holder.pid}). Close it to use the profile`;
}

// Where the browser with this pid listens, if it does: the port in its
// command line, or (for --remote-debugging-port=0) the one Chrome writes
// in the profile.
function debuggingPort(dir: string, pid: number): string | undefined {
  try {
    const args = execFileSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8' });
    const port = /--remote-debugging-port=(\d+)/.exec(args)?.[1];
    if (port && port !== '0') return port;
  } catch {
    // No ps (Windows), or it's gone.
  }
  try {
    return readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8').split('\n')[0].trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Why `--open-browser` can't start a browser at `endpoint`, or null: it
 * starts one on this machine only.
 */
export function launchEndpointMistake(endpoint: string, setting = '--browser', starter = 'The --open-browser flag starts a browser'): string | null {
  const url = new URL(endpoint);
  // Chrome's debugging port listens on 127.0.0.1 only, so not [::1];
  // and a port is all it takes, not a path.
  const local = ['127.0.0.1', 'localhost'].includes(url.hostname) && url.port && url.pathname === '/' && !url.search;
  if (local) return null;
  return `${starter} on this machine, so ${setting} must be a local port, not ${endpoint.replace(/^https?:\/\//, '')}`;
}

/**
 * Starts the browser at `endpoint` unless one answers there already,
 * and says which. Throws an error saying why it couldn't.
 */
export async function launchBrowser(endpoint: string, profile: string | undefined, out: (line: string) => void, muted = false, headless = false, type?: BrowserType): Promise<void> {
  const url = new URL(endpoint);
  const where = `${url.hostname}:${url.port}`;
  if (await answers(endpoint)) {
    // A profile asked for outright has to be the running browser's.
    const other = profile !== undefined ? otherProfile(url, path.resolve(profile)) : null;
    if (other) throw new Error(other);
    // A browser whose type can't be read is used as it is.
    const found = type ? await runningBrowserType(endpoint).catch(() => null) : null;
    if (type && found && found !== type) {
      throw new Error(`The browser at ${where} is ${BROWSER_NAMES[found]}, not ${BROWSER_NAMES[type]}. Close it, or use another ${quoted('--browser')} port to start one.`);
    }
    out(`[sm-dev] A browser is already running at ${where}`);
    return;
  }
  const port = Number(url.port);
  const { file, name, type: started } = await browserBinary(type);
  if (profile === undefined && started) adoptOldProfile(port, started);
  const dir = path.resolve(profile ?? defaultProfile(port, started));
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const inUse = profileInUse(dir);
  if (inUse) throw new Error(inUse);
  const extra = process.env.SM_DEV_BROWSER_ARGS?.split(/\s+/).filter(Boolean) ?? [];
  await startBrowser({ file, name, dir, endpoint, args: [...(muted ? ['--mute-audio'] : []), ...(headless ? ['--headless=new'] : []), ...extra] });
  out(`[sm-dev] Launched ${name} at ${where} (profile ${withTilde(dir)})`);
}

export interface StartBrowserOptions {
  file: string;
  /** What to call it in messages. */
  name: string;
  /** The profile. */
  dir: string;
  endpoint: string;
  args: string[];
  /** The browser's environment, when not this process's. */
  env?: NodeJS.ProcessEnv;
  /** Called with the browser's process as soon as it's spawned, before its port opens. */
  onSpawn?: (child: ChildProcess) => void;
  /** The profile is deleted if the start fails, so the error doesn't name the log in it. */
  throwaway?: boolean;
}

/**
 * Spawns a browser on its own, as a person would start it, and waits for
 * its debugging port at `endpoint`. Throws an error saying why it couldn't
 * start.
 */
export async function startBrowser(o: StartBrowserOptions): Promise<ChildProcess> {
  const { file, name, dir, endpoint } = o;
  const url = new URL(endpoint);
  const where = `${url.hostname}:${url.port}`;
  // Its output goes to a file in the profile, where it can be read if
  // it fails to start.
  const logFile = path.join(dir, 'sm-dev-browser.log');
  const log = openSync(logFile, 'w');
  // Why it stopped before its port opened: its exit code, or the error
  // that kept it from starting at all (no such file, say).
  let ended: string | null = null;
  let child: ChildProcess;
  try {
    child = spawn(file, [
      `--remote-debugging-port=${url.port}`, `--user-data-dir=${dir}`,
      '--no-first-run', '--no-default-browser-check', ...o.args,
    ], { detached: true, stdio: ['ignore', log, log], env: o.env });
    child.on('exit', (code, signal) => { ended ??= `It exited (${signal ?? `code ${code}`})`; });
    child.on('error', (err) => { ended = `It could not be started from ${file}: ${err.message}`; });
    child.unref();
    o.onSpawn?.(child);
  } finally {
    closeSync(log);
  }
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (!await answers(endpoint)) {
    if (ended !== null || Date.now() > deadline) {
      // One that's up without its port would hold the profile's lock,
      // and the next --open-browser would be refused.
      if (ended === null) child.kill();
      const last = readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).at(-1);
      const why = ended ?? `Its port didn't open within ${START_TIMEOUT_MS / 1000}s, so it was closed`;
      const named = o.throwaway ? 'Its log' : `Its log (${withTilde(logFile)})`;
      throw new Error(`Could not launch ${name} at ${where}: ${why}${last ? `. ${named} ends with: ${last}` : ''}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return child;
}
