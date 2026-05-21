// Favicon slot DOM contract: every script row paints an inner element
// containing a globe SVG placeholder. When the script's @match yields
// a usable origin the inner is a clickable <a target="_blank"> with
// the linkUrl; when it doesn't (e.g. `<all_urls>`), the inner is an
// inert <span>. The third test exercises the @icon header override
// using a `data:` URL so the swap-in is network-independent.

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';

test.describe('site-icon slot', () => {
  let scriptsDir: ScriptsDir;
  test.beforeEach(() => { scriptsDir = ScriptsDir.create(); });
  test.afterEach(() => { scriptsDir.cleanup(); });

  test('renders an anchor + globe for scripts with a usable @match origin', async ({
    extensionContext, extensionId, sm,
  }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: { name: 'A', match: ['https://example.com/posts/*/edit'] },
      body: '',
    });
    const source = await sm.addSource(scriptsDir.path);

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/options.html`);
    const row = page.locator(`section.directory[data-source-id="${source!.id}"] tbody tr`).first();
    const slot = row.locator('.site-icon');
    // Anchor wrapper with the segment-trimmed linkUrl.
    const anchor = slot.locator('a.site-icon-inner');
    await expect(anchor).toHaveAttribute('href', 'https://example.com/posts/');
    await expect(anchor).toHaveAttribute('target', '_blank');
    // Globe placeholder paints synchronously.
    await expect(slot.locator('svg.site-icon-globe')).toBeVisible();
    await page.close();
  });

  test('@icon header takes priority over origin-discovered favicon', async ({
    extensionContext, extensionId, sm,
  }) => {
    // 1x1 transparent PNG inlined as a data: URL — `ensureIconForUrl`
    // returns it synchronously without any network round-trip, so the
    // swap-in happens deterministically in test.
    const dataUrl =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
    scriptsDir.write({
      relativePath: 'icon.user.js',
      meta: {
        name: 'Pinned',
        match: ['https://example.com/*'],
        extra: [`// @icon       ${dataUrl}`],
      },
      body: '',
    });
    const source = await sm.addSource(scriptsDir.path);

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/options.html`);
    const row = page.locator(`section.directory[data-source-id="${source!.id}"] tbody tr`).first();
    const slot = row.locator('.site-icon');
    // Anchor still points at the @match-derived linkUrl — the @icon
    // header is a visual override only.
    await expect(slot.locator('a.site-icon-inner'))
      .toHaveAttribute('href', 'https://example.com/');
    // The img inside the anchor gets the data: URL from @icon, not a
    // network-discovered favicon. The expect-poll waits for the async
    // swap to complete.
    await expect(slot.locator('a.site-icon-inner img'))
      .toHaveAttribute('src', dataUrl);
    await page.close();
  });

  test('renders an inert span + globe for scripts without a usable origin', async ({
    extensionContext, extensionId, sm,
  }) => {
    scriptsDir.write({
      relativePath: 'b.user.js',
      meta: { name: 'B', match: ['<all_urls>'] },
      body: '',
    });
    const source = await sm.addSource(scriptsDir.path);

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/options.html`);
    const row = page.locator(`section.directory[data-source-id="${source!.id}"] tbody tr`).first();
    const slot = row.locator('.site-icon');
    // No anchor — `<all_urls>` doesn't yield an origin to link to.
    await expect(slot.locator('a.site-icon-inner')).toHaveCount(0);
    await expect(slot.locator('span.site-icon-inner')).toHaveCount(1);
    await expect(slot.locator('svg.site-icon-globe')).toBeVisible();
    await page.close();
  });
});
