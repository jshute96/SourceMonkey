// `sm-dev --temp-browser start --extension`: the launched browser loads
// the built extension (dist/), and the script runs in it, in the tab
// the run opened before pushing it (see warmUp in extension-launch.ts).

import { existsSync } from 'node:fs';

import { chromium } from '@playwright/test';

import { test, expect } from '../fixtures/harness.js';
import { findExtensionWorker } from '../../lib/harness/extension-backend.js';
import { launchExtensionBrowser } from '../../lib/harness/extension-launch.js';
import { run } from '../../lib/harness/run.js';

test('the launch leaves no default collections and one blank tab, and close deletes its profile', async () => {
  const launched = await launchExtensionBrowser(false);
  try {
    const browser = await chromium.connectOverCDP(launched.endpoint);
    const context = browser.contexts()[0];
    expect(context.pages().map((p) => p.url())).toEqual(['about:blank']);
    const worker = await findExtensionWorker(context);
    const collections = await worker.evaluate(() =>
      (self as unknown as { SourceMonkey: { getCollections(): Promise<unknown[]> } }).SourceMonkey.getCollections());
    expect(collections).toEqual([]);
    await browser.close();
  } finally {
    await launched.close();
  }
  expect(existsSync(launched.profile)).toBe(false);
});

test('a temp browser with --extension runs the script in the real extension', async ({ fixtureServer, scriptsDir }) => {
  const file = scriptsDir.write({
    relativePath: 'ext.user.js',
    meta: { name: 'Ext', match: ['*://*/target.html'], grant: ['GM_setValue'] },
    body: `console.log('[ext] handler ' + GM_info.scriptHandler); GM_setValue('k', 1);`,
  });
  const lines: string[] = [];
  let stop!: () => void;
  const until = new Promise<void>((resolve) => { stop = resolve; });
  const wanted = ['[ext] handler SourceMonkey', 'Started at'];
  const done = run({
    files: [file],
    urls: [`${fixtureServer.baseUrl}/target.html`],
    tempBrowser: true,
    extension: true,
    collectionRoot: scriptsDir.path,
    localRoots: [],
    out: (line) => {
      lines.push(line);
      if (wanted.every((w) => lines.some((l) => l.includes(w)))) stop();
    },
    until,
  });
  const timer = setTimeout(stop, 20000);
  try {
    expect(await done).toBe(0);
  } finally {
    clearTimeout(timer);
  }
  const text = lines.join('\n');
  expect(text).toContain('has SourceMonkey');
  for (const w of wanted) expect(text).toContain(w);
  // The browser and its extension are gone, so no Scratch hint, and
  // no tab closing as it went.
  expect(text).not.toContain('Scratch collection');
  expect(text).not.toContain('Tab T1 closed');
});
