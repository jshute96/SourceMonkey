// `sm-dev --temp-browser start --extension`: the launched browser loads
// the built extension (dist/), and the script runs in it, in the tab
// the run opened before pushing it (see warmUp in extension-launch.ts).

import { existsSync } from 'node:fs';

import { chromium, type BrowserContext } from '@playwright/test';

import { test, expect } from '../fixtures/harness.js';
import { renderUserscript } from '../fixtures/scripts-dir.js';
import { findExtensionWorker } from '../../lib/harness/extension-backend.js';
import { launchExtensionBrowser } from '../../lib/harness/extension-launch.js';
import { run } from '../../lib/harness/run.js';
import { UserscriptServer } from '../fixtures/userscript-server.js';

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
  // Another of the same file name: the extension keeps the run's
  // scripts by path, so both are pushed and both run.
  const twin = scriptsDir.write({
    relativePath: 'other/ext.user.js',
    meta: { name: 'Twin', match: ['*://*/target.html'] },
    body: `console.log('[twin] ran');`,
  });
  const lines: string[] = [];
  let stop!: () => void;
  const until = new Promise<void>((resolve) => { stop = resolve; });
  const wanted = ['[ext] handler SourceMonkey', 'Ext started on', '[twin] ran', 'Twin started on'];
  const done = run({
    files: [file, twin],
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
  // No tab closing as the browser went.
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
  // The run's own test collection, by its unique id.
  expect(text).toMatch(/Backend: SourceMonkey extension, test collection [\w.-]+-[0-9a-f]{4}\b/);
});

test('SourceMonkey-managed scripts on the tab are E1, ..., kept out, and their values reachable', async ({ fixtureServer, scriptsDir }) => {
  test.setTimeout(90_000);
  // A browser with another script already installed, which has stored
  // a value.
  const launched = await launchExtensionBrowser(false);
  try {
    const browser = await chromium.connectOverCDP(launched.endpoint);
    const context = browser.contexts()[0];
    await installScript(context, renderUserscript({
      relativePath: 'other.user.js',
      meta: { name: 'Other', match: ['*://*/target.html'], grant: ['GM_setValue'] },
      body: `GM_setValue('seen', 1); document.title = 'other ran';`,
    }));
    const page = await context.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page).toHaveTitle('other ran');
    await browser.close();

    const file = scriptsDir.write({
      relativePath: 'mine.user.js',
      meta: { name: 'Mine', match: ['*://*/target.html'] },
      body: `console.log('[mine] title ' + document.title);`,
    });
    const { lines, left } = await driveCli(['--browser', launched.endpoint, 'start', '--extension', file, `${fixtureServer.baseUrl}/target.html`], [
      ['Mine started on', 'scripts'],
      ['E1: Other', 'values E1'],
      ['seen = 1', 'scripts E1'],
      ['Selected E1: Other', 'scripts'],
      ['* E1: Other', 'set seen --force 2'],
      ['Set seen', 'get seen'],
      // Not a throwaway browser, so without --force it refuses (which
      // ends a --stdin run).
      ['seen = 2', 'set seen 3'],
    ]);
    const text = lines.join('\n');
    expect(left, text).toEqual([]);
    expect(text).toContain('so this would change its real stored data. Use --force to continue.');
    // The picked one is marked, and the run's own script isn't.
    expect(text).toMatch(/\* E1: Other \(Scripts from web\)/);
    // Kept out of the run's tab: only the run's own script ran there.
    expect(text).toContain('Kept out of the run\'s tabs');
    expect(text).not.toContain('other ran');
    // The run's test collection went with it; the person's stays.
    const after = await chromium.connectOverCDP(launched.endpoint);
    const worker = await findExtensionWorker(after.contexts()[0]);
    const names = await worker.evaluate(async () => {
      const api = (self as unknown as { SourceMonkey: { getCollections(): Promise<{ displayName?: string; path: string }[]> } }).SourceMonkey;
      return (await api.getCollections()).map((c) => c.path);
    });
    expect(names.some((p) => p.startsWith('container:sm-dev:'))).toBe(false);
    expect(names.length).toBeGreaterThan(0);
    await after.close();
  } finally {
    await launched.close();
  }
});

test('a harness run in a browser with SourceMonkey keeps its scripts out of the run\'s tabs', async ({ fixtureServer, scriptsDir }) => {
  test.setTimeout(90_000);
  const launched = await launchExtensionBrowser(false);
  try {
    const browser = await chromium.connectOverCDP(launched.endpoint);
    // An installed script that marks every fixture page it runs on.
    await installScript(browser.contexts()[0], renderUserscript({
      relativePath: 'other.user.js',
      meta: { name: 'Other', match: ['*://*/target.html', '*://*/other.html'], runAt: 'document-start' },
      body: `document.documentElement.dataset.other = 'ran';`,
    }));
    await browser.close();

    const file = scriptsDir.write({
      relativePath: 'mine.user.js',
      meta: { name: 'Mine', match: ['*://*/target.html', '*://*/other.html'], grant: ['GM_openInTab'] },
      body: `
        console.log('[mine] other is ' + (document.documentElement.dataset.other ?? 'out') + ' on ' + location.pathname);
        if (location.pathname.endsWith('target.html')) GM_openInTab(location.href.replace('target.html', 'other.html'));
      `,
    });
    // A page-world one too: SourceMonkey's bridge hears its messages, and
    // must still let it run.
    const main = scriptsDir.write({
      relativePath: 'main.user.js',
      meta: { name: 'Main', match: ['*://*/target.html'], grant: ['none'] },
      body: `console.log('[main] ran');`,
    });
    const { lines, left } = await driveCli(['--browser', launched.endpoint, 'start', file, main, `${fixtureServer.baseUrl}/target.html`], [
      ['[mine] other is out on /other.html', 'stop'],
    ]);
    const text = lines.join('\n');
    expect(left, text).toEqual([]);
    expect(text).toContain('[mine] other is out on /target.html');
    expect(text).toContain('[main] ran');
    expect(text).not.toMatch(/Main skipped on \S+target\.html/);
  } finally {
    await launched.close();
  }
});

test('a run started with no scripts claims its tabs, so a script it loads runs alone, in either backend', async ({ fixtureServer, scriptsDir }) => {
  test.setTimeout(120_000);
  const launched = await launchExtensionBrowser(false);
  try {
    let browser = await chromium.connectOverCDP(launched.endpoint);
    await installScript(browser.contexts()[0], renderUserscript({
      relativePath: 'other.user.js',
      meta: { name: 'Other', match: ['*://*/target.html'], runAt: 'document-start' },
      body: `document.documentElement.dataset.other = 'ran';`,
    }));
    await browser.close();
    // Page-world, so its reports reach SourceMonkey's bridge too.
    const file = scriptsDir.write({
      relativePath: 'mine.user.js',
      meta: { name: 'Mine', match: ['*://*/target.html'], grant: ['none'] },
      body: `console.log('[mine] other is ' + (document.documentElement.dataset.other ?? 'out'));`,
    });
    for (const extension of [false, true]) {
      const { lines, left } = await driveCli(['--browser', launched.endpoint, 'start', ...(extension ? ['--extension'] : []), `${fixtureServer.baseUrl}/target.html`], [
        ['Opening', `load ${file}`],
        ['[mine] other is', 'stop'],
      ]);
      const text = lines.join('\n');
      expect(left, text).toEqual([]);
      expect(text).toContain('[mine] other is out');
      // The extension shows the tab as sm-dev's, with its own script
      // kept out and the run's not listed as a stranger.
      browser = await chromium.connectOverCDP(launched.endpoint);
      const worker = await findExtensionWorker(browser.contexts()[0]);
      const titles = await worker.evaluate(async () => {
        const api = (self as unknown as { SourceMonkey: { getTabState(id: number): Promise<{ title: string } | null> } }).SourceMonkey;
        const tabs = await chrome.tabs.query({});
        return Promise.all(tabs.filter((t) => t.url?.endsWith('/target.html')).map(async (t) => (await api.getTabState(t.id!))?.title ?? ''));
      });
      await browser.close();
      const title = titles.join('\n');
      expect(title, text).toContain('Page under sm-dev control');
      expect(title).toContain('Other | NOT LOADED');
      expect(title).not.toContain('UNEXPECTED');
    }
  } finally {
    await launched.close();
  }
});

test('an --extension run follows the tabs its scripts open, each by its own tab', async ({ scriptsDir }) => {
  test.setTimeout(90_000);
  const server = await UserscriptServer.start();
  const html = { contentType: 'text/html; charset=utf-8' };
  const base = server.baseUrl;
  // The opener: two pop-ups at once, and a GM_openInTab that redirects.
  server.setRoute('/opener.html', '<html><body>opener</body></html>', html);
  server.setRoute('/a.html', '<html><body>a</body></html>', html);
  server.setRoute('/b.html', '<html><body>b</body></html>', html);
  server.setRoute('/landing.html', '<html><body>landing</body></html>', html);
  server.setRedirect('/redirect', `${base}/landing.html`);
  const file = scriptsDir.write({
    relativePath: 'pop.user.js',
    meta: { name: 'Pop', match: [`${base}/*`], grant: ['GM_openInTab'] },
    body: `
      console.log('[pop] on ' + location.pathname);
      if (location.pathname === '/opener.html') {
        window.open('/a.html');
        window.open('/b.html');
        GM_openInTab('${base}/redirect');
      }
    `,
  });
  const lines: string[] = [];
  let stop!: () => void;
  const until = new Promise<void>((resolve) => { stop = resolve; });
  const done = run({
    files: [file],
    urls: [`${base}/opener.html`],
    tempBrowser: true,
    extension: true,
    collectionRoot: scriptsDir.path,
    localRoots: [],
    out: (line) => {
      lines.push(line);
      const text = lines.join('\n');
      if (['/a.html', '/b.html', '/landing.html'].every((p) => text.includes(`Pop started on ${base}${p}`))) stop();
    },
    until,
  });
  const timer = setTimeout(stop, 40_000);
  try {
    await done;
  } finally {
    clearTimeout(timer);
    await server.stop();
  }
  const text = lines.join('\n');
  // Each opened tab is announced with the page it shows, and that tab's
  // own lines are tagged with its number.
  for (const page of ['/a.html', '/b.html', '/landing.html']) {
    const announced = text.match(new RegExp(`Tab (T\\d+) opened at \\S*${page.replace('.', '\\.')}`));
    expect(announced, text).not.toBeNull();
    // (Console lines from an opened tab's first load don't reach the
    // run yet: see TODO.md.)
    expect(text).toMatch(new RegExp(`\\[${announced![1]}\\] \\[sm-dev\\] Pop started on \\S*${page.replace('.', '\\.')}`));
  }
  expect(text).not.toContain('couldn\'t follow');
});

// Installs `text` into the browser's SourceMonkey as a person's own
// script would be, in a collection of its own (not as a scratch
// script, which only sm-dev's tabs run). Served over http to install.
async function installScript(context: BrowserContext, text: string): Promise<void> {
  const server = await UserscriptServer.start();
  try {
    server.setRoute('/other.user.js', text, { contentType: 'text/javascript' });
    const worker = await findExtensionWorker(context);
    await worker.evaluate(async (url) => {
      const api = (self as unknown as { SourceMonkey: { addCollection(u: string): Promise<unknown>; syncNow(): Promise<void> } }).SourceMonkey;
      await api.addCollection(url);
      await api.syncNow();
    }, `${server.baseUrl}/other.user.js`);
  } finally {
    await server.stop();
  }
}

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
