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
  const wanted = ['[ext] handler SourceMonkey', 'Ext started on'];
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

test('an extension run takes the run commands: status, values, set, menu, eval, reload', async ({ fixtureServer, scriptsDir }) => {
  // Two browser launches, then each command in turn.
  test.setTimeout(90_000);
  const file = scriptsDir.write({
    relativePath: 'cmds.user.js',
    meta: { name: 'Cmds', match: ['*://*/target.html', '*://*/other.html'], grant: ['GM_setValue', 'GM_getValue', 'GM_registerMenuCommand'] },
    body: `
      if (location.pathname.endsWith('other.html')) {
        console.log('[cmds] on other');
      } else {
        console.log('[cmds] count ' + GM_getValue('count', 0));
        GM_setValue('count', GM_getValue('count', 0) + 1);
        GM_registerMenuCommand('Mark', () => { document.title = 'marked'; });
        GM_registerMenuCommand('Open', () => { window.open('other.html'); });
      }
    `,
  });
  const { spawn } = await import('node:child_process');
  const cli = new URL('../../lib/harness/cli.js', import.meta.url).pathname;
  const child = spawn(process.execPath, [cli, '--stdin', '--temp-browser', 'start', '--extension', file, `${fixtureServer.baseUrl}/target.html`, '--seconds', '70'],
    { stdio: ['pipe', 'pipe', 'pipe'] });
  // Each command once the line before it shows up.
  const steps: [string, string][] = [
    ['GM_setValue count = 1', 'status'],
    ['2 menu commands, 1 stored value', 'menu Mark'],
    ['Fired "Mark"', 'eval document.title'],
    ['"marked"', 'set count 10'],
    ['Set count', 'reload'],
    ['[cmds] count 10', 'get count'],
    // The extension's own world, where `chrome.runtime` is there.
    ['count = 11', 'eval --script typeof chrome.runtime.sendMessage'],
    ['"function"', 'menu Open'],
    // Followed into the tab it opens, which runs the run's script.
    ['[T2] [sm-dev] Cmds started on', 'newtab'],
    ['Tab T3 opened', 'stop'],
  ];
  const lines: string[] = [];
  let buffer = '';
  const onData = (chunk: Buffer): void => {
    buffer += chunk.toString();
    const parts = buffer.split('\n');
    buffer = parts.pop() ?? '';
    for (const line of parts) {
      lines.push(line);
      if (steps[0] && line.includes(steps[0][0])) {
        const command = steps.shift()![1];
        child.stdin.write(`${command}\n`);
        // The client reads stdin until it ends.
        if (command === 'stop') child.stdin.end();
      }
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  const exited = new Promise((resolve) => child.on('exit', resolve));
  // Stopped if it outlasts the test, so a stuck step can't leave it running.
  const timer = setTimeout(() => child.kill(), 75_000);
  await exited;
  clearTimeout(timer);
  const text = lines.join('\n');
  expect(steps, text).toEqual([]);
  expect(text).toContain('/cmds.user.js');
  expect(text).toMatch(/\* 1: Cmds \(.*cmds\.user\.js\)/);
});
