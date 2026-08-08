// Smoke test for the SourceMonkey stub extension. Asserts the unpacked
// extension actually loads, the MV3 service worker is reachable from
// Playwright, and the sources page renders. These are the floor —
// every later feature test inherits these guarantees from the fixture.

import { test, expect } from '../fixtures/extension';

test('service worker exposes the SourceMonkey api', async ({ getServiceWorker }) => {
  const sw = await getServiceWorker();
  const result = await sw.evaluate(() => {
    const api = (self as unknown as {
      SourceMonkey: { version: string; ping: (v?: string) => string };
    }).SourceMonkey;
    return { version: api.version, echoed: api.ping('hi') };
  });
  expect(result.version).toBe('0.0.1');
  expect(result.echoed).toBe('hi');
});

test('sources page loads', async ({
  extensionContext,
  extensionId,
}) => {
  const page = await extensionContext.newPage();
  await page.goto(`chrome-extension://${extensionId}/sources.html`);
  await expect(page.locator('h1')).toHaveText('SourceMonkey');
  await page.close();
});

test('options page renders', async ({
  extensionContext,
  extensionId,
}) => {
  const page = await extensionContext.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  await expect(page.locator('h1')).toHaveText('SourceMonkey');
  await page.close();
});

test('fixture server serves pages', async ({ extensionContext, fixtureServer }) => {
  const page = await extensionContext.newPage();
  await page.goto(`${fixtureServer.baseUrl}/blank.html`);
  await expect(page.locator('p')).toHaveText('blank fixture page');
  await page.close();
});
