// `sm-dev --open-browser`: starts a browser that stays open after sm-dev
// exits, with a window and a debugging port, for runs to connect to.
// Unlike `--temp-browser` (Playwright's own launch, which ends
// with the run), it is spawned on its own, as a person would start it.
//
// - The port is `--cdp`'s (default $SM_DEV_CDP or 9233), which is also
//   where later commands connect, so `sm-dev --open-browser start x.user.js
//   --detach` needs nothing else.
// - The profile is kept, so sign-ins and extensions carry over:
//   `~/.config/sm-dev/browser-profile-<port>`, one for each port, since
//   only one Chrome at a time can use a profile. `--profile` picks
//   another.
// - Idempotent: a browser already answering on the port is used as is,
//   whatever its profile.
// - Google Chrome when it's installed (better at Google sign-in than
//   other builds), else Playwright's Chromium. $SM_DEV_BROWSER names
//   another binary, and $SM_DEV_BROWSER_ARGS adds arguments (the tests
//   add --headless=new).

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, openSync, closeSync, readFileSync, readlinkSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { processAlive } from './runs.js';

// How long a started browser has to open its port.
const START_TIMEOUT_MS = 10_000;

/** Where Google Chrome is installed, by platform, most likely first. */
function chromeCandidates(): string[] {
  if (process.platform === 'darwin') {
    return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome')];
  }
  if (process.platform === 'win32') {
    const dirs = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter((d): d is string => !!d);
    return dirs.map((d) => path.join(d, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  }
  return ['/opt/google/chrome/chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'];
}

/** The browser to start, and what to call it. */
async function browserBinary(): Promise<{ file: string; name: string }> {
  const chosen = process.env.SM_DEV_BROWSER?.trim();
  if (chosen) return { file: chosen, name: path.basename(chosen) };
  const chrome = chromeCandidates().find((f) => existsSync(f));
  if (chrome) return { file: chrome, name: 'Google Chrome' };
  const { chromium } = await import('@playwright/test');
  const file = chromium.executablePath();
  if (!existsSync(file)) throw new Error('No browser to launch: Google Chrome isn\'t installed, and neither is Playwright\'s Chromium (pnpm exec playwright install chromium)');
  return { file, name: 'Chromium' };
}

/** The profile a port's browser keeps. */
export function defaultProfile(port: number): string {
  const config = process.env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), '.config');
  return path.join(config, 'sm-dev', `browser-profile-${port}`);
}

// The path with the home directory as ~, for messages.
function shown(file: string): string {
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
  let owner: string;
  try {
    owner = readlinkSync(path.join(dir, 'SingletonLock'));
  } catch {
    return null;
  }
  const match = /^(.*)-(\d+)$/.exec(owner);
  if (!match || match[1] !== os.hostname() || !processAlive(Number(match[2]))) return null;
  const port = debuggingPort(dir, Number(match[2]));
  return port
    ? `The profile ${shown(dir)} is in use by the browser on port ${port}. Use --cdp ${port}, or another --profile`
    : `The profile ${shown(dir)} is in use by a browser without a debugging port (pid ${match[2]}). Close it, or use another --profile`;
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
export function launchEndpointMistake(endpoint: string): string | null {
  const url = new URL(endpoint);
  // Chrome's debugging port listens on 127.0.0.1 only, so not [::1];
  // and a port is all it takes, not a path.
  const local = ['127.0.0.1', 'localhost'].includes(url.hostname) && url.port && url.pathname === '/' && !url.search;
  if (local) return null;
  return `The --open-browser flag starts a browser on this machine, so --cdp must be a local port, not ${endpoint.replace(/^https?:\/\//, '')}`;
}

/**
 * Starts the browser at `endpoint` unless one answers there already,
 * and says which. Throws an error saying why it couldn't.
 */
export async function launchBrowser(endpoint: string, profile: string | undefined, out: (line: string) => void): Promise<void> {
  const url = new URL(endpoint);
  const where = `${url.hostname}:${url.port}`;
  if (await answers(endpoint)) {
    out(`[sm-dev] A browser is already running at ${where}`);
    return;
  }
  const port = Number(url.port);
  const dir = path.resolve(profile ?? defaultProfile(port));
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const inUse = profileInUse(dir);
  if (inUse) throw new Error(inUse);
  const { file, name } = await browserBinary();
  const extra = process.env.SM_DEV_BROWSER_ARGS?.split(/\s+/).filter(Boolean) ?? [];
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
      `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`,
      '--no-first-run', '--no-default-browser-check', ...extra,
    ], { detached: true, stdio: ['ignore', log, log] });
    child.on('exit', (code, signal) => { ended ??= `It exited (${signal ?? `code ${code}`})`; });
    child.on('error', (err) => { ended = `It could not be started from ${file}: ${err.message}`; });
    child.unref();
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
      throw new Error(`Could not launch ${name} at ${where}: ${why}${last ? `. Its log (${shown(logFile)}) ends with: ${last}` : ''}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  out(`[sm-dev] Launched ${name} at ${where} (profile ${shown(dir)})`);
}
