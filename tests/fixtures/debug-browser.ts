// A headless Chromium with a CDP debugging port, for tests that connect
// to a browser the way `sm-dev start --cdp` does, rather than launch one
// through Playwright. Its profile lives in a temp directory of its own.

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { chromium } from '@playwright/test';

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
  const port = await freePort();
  // In a process group of its own, so its helper processes can be
  // stopped with it.
  const browser = spawn(chromium.executablePath(), [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(dir, 'profile')}`,
    '--no-first-run', '--no-default-browser-check', 'about:blank',
  ], { stdio: 'ignore', detached: true });
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    up = await fetch(`http://127.0.0.1:${port}/json/version`).then(() => true, () => false);
    if (!up) await new Promise((r) => setTimeout(r, 100));
  }
  if (!up) throw new Error(`The test browser's debugging port ${port} didn't answer within 10 seconds`);
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
