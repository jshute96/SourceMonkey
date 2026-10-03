// A headless Chromium with a CDP debugging port and SourceMonkey loaded,
// for tests that connect to a browser the way `sm-dev start --browser`
// does, rather than launch one through Playwright. Its profile lives in a
// temp directory of its own, readied as sm-dev's own launcher readies
// one (src/harness/extension-launch.ts).

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { chromium } from '@playwright/test';

import { extensionArgs, prepareProfile, warmUp } from '../../lib/harness/extension-launch.js';

export interface DebugBrowser {
  port: number;
  /** A temp directory of the test's own, removed by `close`. */
  dir: string;
  /** Stops the browser and every helper process it started, and removes `dir`. */
  close: () => Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer().listen(0, () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

export async function launchDebugBrowser(): Promise<DebugBrowser> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'sm-dev-browser-'));
  const profile = path.join(dir, 'profile');
  await prepareProfile(profile);
  const port = await freePort();
  // In a process group of its own, so its helper processes can be
  // stopped with it.
  const browser = spawn(chromium.executablePath(), [
    '--headless=new', '--mute-audio', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', ...extensionArgs(), 'about:blank',
  ], { stdio: 'ignore', detached: true });
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    up = await fetch(`http://127.0.0.1:${port}/json/version`).then(() => true, () => false);
    if (!up) await new Promise((r) => setTimeout(r, 100));
  }
  if (!up) throw new Error(`The test browser's debugging port ${port} didn't answer within 10 seconds`);
  // So tabs opened from here on can reach the extension (see `warmUp`).
  const connected = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  await warmUp(connected.contexts()[0]);
  await connected.close();
  return {
    port,
    dir,
    close: async () => {
      const gone = new Promise((r) => browser.once('exit', r));
      try {
        process.kill(-browser.pid!, 'SIGKILL');
      } catch {
        // Gone already.
      }
      await Promise.race([gone, new Promise((r) => setTimeout(r, 5000))]);
      // Its helper processes can still be writing for a moment.
      for (let i = 0; i < 20 && existsSync(dir); i++) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          await new Promise((r) => setTimeout(r, 250));
        }
      }
      if (existsSync(dir)) throw new Error(`The test browser's directory ${dir} could not be removed`);
    },
  };
}

/** Opens a tab straight through the browser's endpoint, and returns its page's target id. */
export async function openTab(port: number, url = 'about:blank'): Promise<string> {
  const tab = await (await fetch(`http://127.0.0.1:${port}/json/new?${url}`, { method: 'PUT' })).json() as { id: string };
  return tab.id;
}
