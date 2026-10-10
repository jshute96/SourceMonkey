// E2E coverage for the frames example: which scripts run in which of a
// page's frames, and a GM value shared across them.
//
// Manager-agnostic: asserts only what the scripts write into each
// document. SourceMonkey's own side (the popup, badge and menu
// commands for scripts in frames) is in `tests/e2e/frames.spec.ts`.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Frame, Page } from '@playwright/test';
import { test, expect } from '../../fixtures/manager';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The page's frames by the page name each document carries.
async function framesByPage(page: Page): Promise<Record<string, Frame>> {
  const out: Record<string, Frame> = {};
  for (const frame of page.frames()) {
    const name = await frame.evaluate(() => document.body?.dataset.page ?? '').catch(() => '');
    if (name) out[name] = frame;
  }
  return out;
}

test.describe('examples / frames', () => {
  test('each script runs in the frames it matches; @noframes keeps one to the top', async ({
    extensionContext, fixtureServer, setup,
  }) => {
    await setup.installScriptsFrom(__dirname);

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/frames/frames.html`);
    await expect.poll(async () => Object.keys(await framesByPage(page)).sort())
      .toEqual(['frame-a', 'frame-b', 'nested', 'top']);
    const frames = await framesByPage(page);

    // Frame B is on another origin than the page.
    expect(new URL(frames['frame-b']!.url()).origin).not.toBe(new URL(page.url()).origin);

    const scriptsIn = (name: string) => frames[name]!.locator('#log li').evaluateAll(
      (els) => els.map((li) => (li as HTMLElement).dataset.script).sort(),
    );
    const want: Record<string, string[]> = {
      'top': ['every-frame', 'top-only'],
      'frame-a': ['every-frame'],
      'frame-b': ['every-frame', 'frame-b-only'],
      'nested': ['every-frame'],
    };
    for (const [name, scripts] of Object.entries(want)) {
      await expect.poll(() => scriptsIn(name), { message: `scripts in ${name}` }).toEqual(scripts);
    }
    await expect(frames['nested']!.locator('#log')).toContainText('Ran in nested (a frame)');

    // A count in one frame shows in every document, cross-origin
    // included, through the value-change listener.
    await frames['frame-a']!.locator('#btn-count').click();
    for (const name of Object.keys(want)) {
      await expect(frames[name]!.locator('#count'), `count in ${name}`).toHaveText('1');
    }

    await page.close();
  });
});
