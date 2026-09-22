// The fixture a consumer repo imports from `sourcemonkey/harness`,
// driven here from `dist/` the way that repo would: `loadUserscript`,
// `gm`, `reports`, and `serveSnapshot`.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { test as harnessTest, expect } from '../../dist/harness/index.js';

// A repo-like directory with one script, as a consumer would have.
const test = harnessTest.extend<{ repo: string }>({
  repo: async ({}, use) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'sourcemonkey-consumer-'));
    await writeFile(path.join(dir, 'greet.user.js'), `// ==UserScript==
// @name         Greeter
// @match        https://example.test/items/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// ==/UserScript==
const greeting = GM_getValue('greeting', 'hello');
document.getElementById('target').textContent = greeting + ' from Greeter';
GM_setValue('visits', GM_getValue('visits', 0) + 1);
GM_registerMenuCommand('Shout', () => {
  document.getElementById('target').textContent = greeting.toUpperCase();
});
`);
    await writeFile(path.join(dir, 'snapshot.html'),
      '<!DOCTYPE html><html><body><main id="target">snapshot content</main></body></html>');
    await use(dir);
    await rm(dir, { recursive: true, force: true });
  },
});

test.describe('consumer fixture', () => {
  test('loads a script against a served snapshot and exposes gm and reports', async ({ page, repo, loadUserscript, gm, reports, serveSnapshot }) => {
    await serveSnapshot(path.join(repo, 'snapshot.html'), 'https://example.test/items/42', { block: true });
    await loadUserscript(path.join(repo, 'greet.user.js'), {
      collectionRoot: repo,
      values: { greeting: 'hi' },
      url: 'https://example.test/items/42',
    });
    await page.goto('https://example.test/items/42');
    await expect(page.locator('#target')).toHaveText('hi from Greeter');
    await reports.waitForStart();
    expect(reports.errors()).toEqual([]);
    await expect.poll(() => gm.get('visits')).toBe(1);
    expect(gm.list()).toEqual({ greeting: 'hi', visits: 1 });
    await expect.poll(() => gm.menuCommands()).toEqual(['Shout']);
    expect(await gm.fireMenu('Shout')).toBe(true);
    await expect(page.locator('#target')).toHaveText('HI');
    // A write from the test reaches the running script like another tab's.
    await gm.set('greeting', 'yo', 'Greeter');
    expect(await gm.fireMenu('Shout', 'greet.user.js')).toBe(true);
    await expect(page.locator('#target')).toHaveText('HI');
    await expect.poll(() => gm.get('greeting')).toBe('yo');
  });

  test('a second snapshot route sits beside the first', async ({ page, repo, serveSnapshot }) => {
    await writeFile(path.join(repo, 'two.html'), '<!DOCTYPE html><html><body><main id="target">second</main></body></html>');
    await serveSnapshot(path.join(repo, 'snapshot.html'), 'https://example.test/one', { block: true });
    await serveSnapshot(path.join(repo, 'two.html'), 'https://example.test/two');
    await page.goto('https://example.test/one');
    await expect(page.locator('#target')).toHaveText('snapshot content');
    await page.goto('https://example.test/two');
    await expect(page.locator('#target')).toHaveText('second');
    // Anything else falls through to the blocking route and is refused.
    await expect(page.goto('https://example.test')).rejects.toThrow();
  });

  test('a URL the header does not cover is refused up front', async ({ repo, loadUserscript }) => {
    await expect(loadUserscript(path.join(repo, 'greet.user.js'), {
      collectionRoot: repo,
      url: 'https://example.test/other',
    })).rejects.toThrow(/would not run on https:\/\/example\.test\/other: No @match or @include covers this URL/);
  });

  test('waitForStart explains a miss instead of timing out silently', async ({ page, repo, loadUserscript, reports, serveSnapshot }) => {
    await serveSnapshot(path.join(repo, 'snapshot.html'), 'https://example.test/other', { block: true });
    await loadUserscript(path.join(repo, 'greet.user.js'), { collectionRoot: repo });
    await page.goto('https://example.test/other');
    await expect(reports.waitForStart(undefined, 500)).rejects.toThrow(/Skipped: Greeter on https:\/\/example\.test\/other: No @match/);
  });
});
