// Smoke test for the VibeMonkey stub extension. Asserts the unpacked
// extension actually loads, the MV3 service worker is reachable from
// Playwright, and the options page renders. These are the floor —
// every later feature test inherits these guarantees from the fixture.

import { test, expect } from '../fixtures/extension';

test('service worker exposes the VibeMonkey api', async ({ getServiceWorker }) => {
  const sw = await getServiceWorker();
  const result = await sw.evaluate(() => {
    const api = (self as unknown as {
      VibeMonkey: { version: string; ping: (v?: string) => string };
    }).VibeMonkey;
    return { version: api.version, echoed: api.ping('hi') };
  });
  expect(result.version).toBe('0.0.1');
  expect(result.echoed).toBe('hi');
});

test('options page loads and renders the version', async ({
  extensionContext,
  extensionId,
}) => {
  const page = await extensionContext.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  await expect(page.locator('h1')).toHaveText('VibeMonkey');
  await expect(page.locator('#version')).toHaveText(/^Version /);
  await page.close();
});

test('fixture server serves pages', async ({ extensionContext, fixtureServer }) => {
  const page = await extensionContext.newPage();
  await page.goto(`${fixtureServer.baseUrl}/blank.html`);
  await expect(page.locator('p')).toHaveText('blank fixture page');
  await page.close();
});
