// Ending a browser a run launched, all of it, however the run ends.
//
// A launched browser runs as its own process group (Playwright and
// chrome-launch.ts both spawn it detached), with its helper processes
// in it. Closing it over CDP needs it to answer, so the group is
// killed instead: at the end of a run's teardown, and when sm-dev finds
// a run that died without closing it. Playwright's Chromium also ends
// with the run on its own (it talks to the run over a pipe), and
// chrome-launch.ts ends a temp Chrome on the signals the run doesn't
// handle.

import { spawnSync } from 'node:child_process';

import type { Browser } from '@playwright/test';

/**
 * The pid of `browser`'s main process, read over CDP, or undefined
 * when it can't be read in time.
 */
export async function browserPid(browser: Browser): Promise<number | undefined> {
  const read = async (): Promise<number | undefined> => {
    const cdp = await browser.newBrowserCDPSession();
    try {
      const { processInfo } = await cdp.send('SystemInfo.getProcessInfo') as { processInfo: { type: string; id: number }[] };
      return processInfo.find((p) => p.type === 'browser')?.id;
    } finally {
      await cdp.detach().catch(() => undefined);
    }
  };
  // Not wait.ts's `within`: `sm-dev stop` loads this, and shouldn't
  // load the page commands with it.
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), 2000); });
  try {
    return await Promise.race([read().catch(() => undefined), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** Whether a process `pid` is running. */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: running, as another user.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Kills the browser whose main process is `pid`, and its helpers with
 * it (its process group). Windows has no process groups, so there only
 * the main process is killed.
 */
export function killBrowser(pid: number): void {
  try {
    if (process.platform !== 'win32') {
      process.kill(-pid, 'SIGKILL');
      return;
    }
  } catch {
    // Not a group's leader (a launcher that forked rather than exec'd),
    // or gone: the main process alone, below.
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch { /* It has gone */ }
}

/**
 * Kills the browser a run that has ended left running, if `pid` is
 * still that browser: one using the run's own temp `profile`, not
 * another process that got the pid since. True when it was killed.
 * Windows isn't checked, so nothing is killed there.
 */
export function killLeftBrowser(pid: number, profile: string): boolean {
  if (process.platform === 'win32' || !alive(pid)) return false;
  const args = spawnSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8' }).stdout ?? '';
  if (!args.includes(`--user-data-dir=${profile}`)) return false;
  killBrowser(pid);
  return true;
}
