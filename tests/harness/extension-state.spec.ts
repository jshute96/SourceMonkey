// Whether sm-dev sees SourceMonkey in a browser (`sourceMonkeyState`),
// as the run's first line and `status` say: in a browser with the
// built extension loaded unpacked, and in one without it.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium, test, expect } from '@playwright/test';
import { extensionLabel, sourceMonkeyState } from '../../lib/harness/extension-backend.js';

const DIST = fileURLToPath(new URL('../../dist', import.meta.url));

// A browser on a CDP port of its own, with the extension or without.
async function withBrowser(extension: boolean, check: (endpoint: string) => Promise<void>): Promise<void> {
  const profile = mkdtempSync(path.join(os.tmpdir(), 'sm-ext-state-'));
  // Extensions need Chrome's new headless mode, which Playwright's own
  // headless flag doesn't give (see src/harness/extension-launch.ts).
  const context = await chromium.launchPersistentContext(profile, {
    headless: false,
    args: ['--headless=new', '--remote-debugging-port=0', ...(extension ? [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`] : [])],
  });
  try {
    const port = readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0];
    await check(`http://127.0.0.1:${port}`);
  } finally {
    await context.close();
    rmSync(profile, { recursive: true, force: true });
  }
}

test('a browser with SourceMonkey loaded unpacked has it', async () => {
  await withBrowser(true, async (endpoint) => {
    expect(await sourceMonkeyState(endpoint)).toBe('installed');
  });
});

test('a browser without it has none, and a closed port says nothing', async () => {
  await withBrowser(false, async (endpoint) => {
    expect(await sourceMonkeyState(endpoint)).toBe('absent');
  });
  expect(await sourceMonkeyState('http://127.0.0.1:1')).toBeNull();
  expect([null, 'installed', 'disabled', 'absent'].map((s) => extensionLabel(s as never)))
    .toEqual(['', 'has SourceMonkey', 'SourceMonkey disabled', 'no extension']);
});
