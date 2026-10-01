// `sm-dev --temp-browser start --extension`: the launched browser loads
// the built extension (dist/), and the script runs in it, in the tab
// the run opened before pushing it (see warmUp in extension-launch.ts).

import { existsSync } from 'node:fs';

import { chromium } from '@playwright/test';

import { test, expect } from '../fixtures/harness.js';
import { renderUserscript } from '../fixtures/scripts-dir.js';
import { ExtensionBackend, findExtensionWorker } from '../../lib/harness/extension-backend.js';
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
  const { lines, left } = await driveCli(['--temp-browser', 'start', '--extension', file, `${fixtureServer.baseUrl}/target.html`], steps);
  const text = lines.join('\n');
  expect(left, text).toEqual([]);
  expect(text).toContain('/cmds.user.js');
  expect(text).toMatch(/\* 1: Cmds \(.*cmds\.user\.js\)/);
});

test('the extension\'s own scripts on the tab are E1, ..., kept out, and their values reachable', async ({ fixtureServer, scriptsDir }) => {
  test.setTimeout(90_000);
  // A browser with another script already installed (as a scratch
  // script the run didn't push), which has stored a value.
  const launched = await launchExtensionBrowser(false);
  try {
    const browser = await chromium.connectOverCDP(launched.endpoint);
    const context = browser.contexts()[0];
    const backend = await ExtensionBackend.connect(context);
    await backend.push(renderUserscript({
      relativePath: 'other.user.js',
      meta: { name: 'Other', match: ['*://*/target.html'], grant: ['GM_setValue'] },
      body: `GM_setValue('seen', 1); document.title = 'other ran';`,
    }), 'other.user.js');
    const page = await context.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page).toHaveTitle('other ran');
    await browser.close();

    const file = scriptsDir.write({
      relativePath: 'mine.user.js',
      meta: { name: 'Mine', match: ['*://*/target.html'] },
      body: `console.log('[mine] title ' + document.title);`,
    });
    const { lines, left } = await driveCli(['--cdp', launched.endpoint, 'start', '--extension', file, `${fixtureServer.baseUrl}/target.html`], [
      ['Mine started on', 'scripts'],
      ['E1: Other', 'values E1'],
      ['seen = 1', 'scripts E1'],
      ['Using E1: Other', 'set seen --force 2'],
      ['Set seen', 'get seen'],
      // Not a throwaway browser, so without --force it refuses (which
      // ends a --stdin run).
      ['seen = 2', 'set seen 3'],
    ]);
    const text = lines.join('\n');
    expect(left, text).toEqual([]);
    expect(text).toContain('Add --force to do it');
    // Kept out of the run's tab: only the run's own script ran there.
    expect(text).toContain('Kept out of the run\'s tabs');
    expect(text).not.toContain('other ran');
  } finally {
    await launched.close();
  }
});

// Drives the real CLI through its input: each command is sent once a
// line containing its trigger shows up. Returns the output, and the
// steps that never got sent.
async function driveCli(args: string[], steps: [string, string][]): Promise<{ lines: string[]; left: [string, string][] }> {
  const { spawn } = await import('node:child_process');
  const cli = new URL('../../lib/harness/cli.js', import.meta.url).pathname;
  const child = spawn(process.execPath, [cli, '--stdin', ...args, '--seconds', '70'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const left = [...steps];
  const lines: string[] = [];
  let buffer = '';
  const onData = (chunk: Buffer): void => {
    buffer += chunk.toString();
    const parts = buffer.split('\n');
    buffer = parts.pop() ?? '';
    for (const line of parts) {
      lines.push(line);
      if (left[0] && line.includes(left[0][0])) {
        const command = left.shift()![1];
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
  return { lines, left };
}
