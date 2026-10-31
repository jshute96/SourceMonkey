// Opening a `.user.js` URL with SourceMonkey and other script managers
// installed: SourceMonkey's install page should show without keeping
// another manager's from showing, whichever way the URL was opened.
//
// - SourceMonkey beside Tampermonkey (TM), and beside Violentmonkey
//   (VM): both install pages must show.
// - All three together: SourceMonkey's must show. TM's and VM's are
//   only recorded (as annotations on the test), since TM and VM can get
//   in each other's way without SourceMonkey: depending on timing,
//   VM's rewrite of the tab can cancel TM's capture page before it
//   loads.
// - Opened from the address bar (blank tab and a tab showing a page),
//   by a click and by a middle-click.
// - http(s) with the server answering at different speeds. file://
//   across VM's file access and its help-page option. TM captures
//   local files only with "Allow access to file URLs", which every
//   extension in this browser has (see all-managers-launch.ts).
//
// Run on demand: `pnpm run test:all-managers`. It needs the TM and VM
// copies `sm-dev --manager tm|vm manager fetch` keeps, and fetches them
// when missing.

import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchAllManagers, type AllManagers, type AllManagersOptions } from '../fixtures/all-managers-launch';
import { UserscriptServer, userscriptText } from '../fixtures/userscript-server';

type Way = 'address bar, blank tab' | 'address bar, from a page' | 'click' | 'middle-click';
const WAYS: Way[] = ['address bar, blank tab', 'address bar, from a page', 'click', 'middle-click'];

const COMBOS: { label: string; others: AllManagersOptions['others'] }[] = [
  { label: 'SourceMonkey and Tampermonkey', others: ['tm'] },
  { label: 'SourceMonkey and Violentmonkey', others: ['vm'] },
  { label: 'all three managers', others: ['tm', 'vm'] },
];

// What each manager's install page looks like, by URL.
function installPages(m: AllManagers): Record<string, (url: string) => boolean> {
  return {
    SourceMonkey: (url) => url.startsWith(`chrome-extension://${m.ids.sm}/userscript.html?preview=`),
    ...(m.ids.tm ? { Tampermonkey: (url: string) => url.startsWith(`chrome-extension://${m.ids.tm}/ask.html`) } : {}),
    ...(m.ids.vm ? { Violentmonkey: (url: string) => url.startsWith(`chrome-extension://${m.ids.vm}/confirm/index.html`) } : {}),
  };
}

function managersShown(m: AllManagers): string[] {
  const urls = m.ctx.pages().map((p) => p.url());
  return Object.entries(installPages(m)).filter(([, isPage]) => urls.some(isPage)).map(([name]) => name);
}

// Open `scriptUrl` the way given, from a page linking to it at
// `listingUrl`.
async function open(m: AllManagers, way: Way, listingUrl: string, scriptUrl: string): Promise<void> {
  const page = await m.ctx.newPage();
  // A manager may rewrite or close the tab mid-navigation, which `goto`
  // reports as a failure; only where the tabs end up matters.
  const go = (p: Page, url: string) => p.goto(url, { timeout: 10_000 }).catch(() => undefined);
  if (way === 'address bar, blank tab') return void go(page, scriptUrl);
  await page.goto(listingUrl);
  if (way === 'address bar, from a page') return void go(page, scriptUrl);
  await page.locator('#install').click(way === 'middle-click' ? { button: 'middle' } : {});
}

// With two managers, both install pages must show. With all three,
// SourceMonkey's must, and which others showed is recorded.
async function expectInstallPages(m: AllManagers, others: AllManagersOptions['others'], timeout: number): Promise<void> {
  const names = Object.keys(installPages(m));
  const required = others.length > 1 ? ['SourceMonkey'] : names;
  for (const name of required) {
    await expect.soft.poll(() => managersShown(m).includes(name), { message: `${name}'s install page`, timeout }).toBe(true);
  }
  if (others.length > 1) {
    await new Promise((r) => setTimeout(r, 2000));
    test.info().annotations.push({ type: 'install pages shown', description: managersShown(m).join(', ') });
  }
}

async function closeAllTabs(m: AllManagers): Promise<void> {
  const fresh = await m.ctx.newPage();
  for (const page of m.ctx.pages()) if (page !== fresh) await page.close().catch(() => undefined);
}

// A local script and a page linking to it, in `dir`.
function writeFiles(dir: string, way: Way): { listing: string; script: string } {
  const slug = way.replace(/\W+/g, '-');
  const script = path.join(dir, `${slug}.user.js`);
  fs.writeFileSync(script, userscriptText(`All Managers ${slug}`));
  const listing = path.join(dir, `${slug}.html`);
  fs.writeFileSync(listing, `<!doctype html><title>Listing</title><a id="install" href="${slug}.user.js">Install</a>`);
  return { listing: `file://${listing}`, script: `file://${script}` };
}

for (const combo of COMBOS) {
  test.describe(`http(s) .user.js with ${combo.label}`, () => {
    let m: AllManagers;
    let server: UserscriptServer;
    test.beforeAll(async () => {
      m = await launchAllManagers({ others: combo.others });
      server = await UserscriptServer.start();
    });
    test.afterAll(async () => {
      await server?.stop();
      await m?.close();
    });
    test.afterEach(async () => closeAllTabs(m));

    for (const delayMs of [0, 500, 2000]) {
      for (const way of WAYS) {
        test(`${way}, server answers in ${delayMs}ms`, async () => {
          // A path per test, so no manager answers from a cache.
          const slug = `${way.replace(/\W+/g, '-')}-${delayMs}`;
          server.setRoute(`/${slug}.user.js`, userscriptText(`All Managers ${slug}`), { delayMs });
          server.setRoute(
            `/${slug}.html`,
            `<!doctype html><title>Listing</title><a id="install" href="/${slug}.user.js">Install</a>`,
            { contentType: 'text/html; charset=utf-8' },
          );
          await open(m, way, `${server.baseUrl}/${slug}.html`, `${server.baseUrl}/${slug}.user.js`);
          await expectInstallPages(m, combo.others, delayMs + 10_000);
        });
      }
    }
  });
}

const FILE_SETUPS: { label: string; options: AllManagersOptions }[] = [
  { label: 'SourceMonkey and Tampermonkey', options: { others: ['tm'] } },
  { label: 'SourceMonkey and Violentmonkey, VM file access on', options: { others: ['vm'] } },
  { label: 'SourceMonkey and Violentmonkey, VM file access off, help page on', options: { others: ['vm'], vmFileAccess: false } },
  { label: 'all three managers', options: { others: ['tm', 'vm'] } },
];

for (const setup of FILE_SETUPS) {
  test.describe(`file:// .user.js with ${setup.label}`, () => {
    let m: AllManagers;
    let dir: string;
    test.beforeAll(async () => {
      m = await launchAllManagers(setup.options);
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-all-managers-files-'));
    });
    test.afterAll(async () => {
      await m?.close();
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    });
    test.afterEach(async () => closeAllTabs(m));

    for (const way of WAYS) {
      test(way, async () => {
        const { listing, script } = writeFiles(dir, way);
        await open(m, way, listing, script);
        await expectInstallPages(m, setup.options.others, 10_000);
      });
    }
  });
}

test.describe('file:// .user.js with SourceMonkey and Violentmonkey, VM file access off, help page off', () => {
  // VM has nothing to show for a local file it can't read, so only
  // SourceMonkey's page is expected, and VM's mustn't appear.
  let m: AllManagers;
  let dir: string;
  test.beforeAll(async () => {
    m = await launchAllManagers({ others: ['vm'], vmFileAccess: false, vmLocalFileHelp: false });
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-all-managers-files-'));
  });
  test.afterAll(async () => {
    await m?.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });
  test.afterEach(async () => closeAllTabs(m));

  for (const way of WAYS) {
    test(way, async () => {
      const { listing, script } = writeFiles(dir, way);
      await open(m, way, listing, script);
      await expect.poll(() => managersShown(m), { timeout: 10_000 }).toEqual(['SourceMonkey']);
      await new Promise((r) => setTimeout(r, 2000));
      expect(managersShown(m)).toEqual(['SourceMonkey']);
    });
  }
});
