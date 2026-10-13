import { test, expect } from '../fixtures/extension';

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

test.describe('/debug/icons.html page', () => {
  test('renders cached icons, per-row refresh & delete, and Delete All', async ({
    extensionContext,
    extensionId,
    sm,
  }) => {
    // Requested for its reset-before-each-test: an icon an earlier test
    // cached (example.com, say) would otherwise be an extra row here.
    void sm;
    const page = await extensionContext.newPage();

    // Seed three cached icon rows (origin, path, and @icon url) in storage.
    await page.goto(`chrome-extension://${extensionId}/collections.html`);
    const now = Date.now();
    await page.evaluate(
      ([ts, png]) =>
        chrome.storage.local.set({
          'siteIcon:https://alpha.example': {
            dataUrl: `data:image/png;base64,${png}`,
            fetchedAt: ts - 60_000,
            v: 2,
          },
          'pathIcon:https://beta.example/app/': {
            dataUrl: null,
            fetchedAt: ts - 120_000,
            v: 2,
          },
          'iconUrl:https://gamma.example/icon.png': {
            dataUrl: `data:image/png;base64,${png}`,
            fetchedAt: ts - 30_000,
          },
          // Written before rows were versioned: fresh, but not usable.
          'siteIcon:https://delta.example': {
            dataUrl: `data:image/png;base64,${png}`,
            fetchedAt: ts - 90_000,
          },
        }),
      [now, PNG_BASE64] as const,
    );

    await page.goto(`chrome-extension://${extensionId}/debug/icons.html`);
    await expect(page).toHaveURL(`chrome-extension://${extensionId}/debug/icons.html`);
    await expect(page.locator('header.page-header h1')).toContainText('SourceMonkey');
    await expect(page.locator('header.page-header h1')).toContainText('Debug');
    await expect(page.locator('header.page-header h1')).toContainText('Icons');

    // All rows render in sorted target order.
    const rows = page.locator('#icons-tbody tr');
    await expect(rows).toHaveCount(4);
    await expect(page.locator('#icons-summary')).toHaveText('4 cached icons');

    // Row 0: siteIcon:https://alpha.example
    const row0 = rows.nth(0);
    await expect(row0.locator('td.col-target a')).toHaveText('https://alpha.example');
    await expect(row0.locator('td.col-icon img')).toHaveCount(1);
    await expect(row0.locator('.kind-chip')).toHaveText('origin');
    await expect(row0.locator('.status-badge')).toHaveText('ok');
    await expect(row0.locator('td.col-time').nth(0)).not.toBeEmpty();
    await expect(row0.locator('td.col-time').nth(1)).not.toBeEmpty();

    // Row 1: pathIcon:https://beta.example/app/ (null entry shows globe + miss)
    const row1 = rows.nth(1);
    await expect(row1.locator('td.col-target a')).toHaveText('https://beta.example/app/');
    await expect(row1.locator('td.col-icon svg.site-icon-globe')).toBeVisible();
    await expect(row1.locator('.kind-chip')).toHaveText('path');
    await expect(row1.locator('.status-badge')).toHaveText('miss');

    // Row 2: siteIcon:https://delta.example — unversioned, so the read
    // would ignore it; the badge's tooltip says what it has vs needs.
    const row2 = rows.nth(2);
    await expect(row2.locator('td.col-target a')).toHaveText('https://delta.example');
    await expect(row2.locator('.status-badge')).toHaveText('stale schema');
    await expect(row2.locator('.status-badge')).toHaveAttribute(
      'title',
      /^Schema version: none\nCurrent version: v2\n/,
    );

    // Test per-row Refresh on beta.example/app/ after routing a live icon.
    const REFRESHED_ICON = 'data:image/png;base64,REFRESH1';
    await extensionContext.route('https://beta.example/**', async (route) => {
      await route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: `<html><head><link rel="icon" href="${REFRESHED_ICON}"></head></html>`,
      });
    });
    try {
      await row1.locator('button.refresh-icon').click();
      await expect(row1.locator('td.col-icon img')).toHaveAttribute('src', REFRESHED_ICON);
      await expect(row1.locator('.status-badge')).toHaveText('ok');
    } finally {
      await extensionContext.unroute('https://beta.example/**');
    }

    // Test per-row Delete on row 0.
    await row0.locator('button.delete-icon').click();
    await expect(rows).toHaveCount(3);
    await expect(page.locator('#icons-summary')).toHaveText('3 cached icons');

    // Test Delete All button at top.
    await page.locator('#delete-all').click();
    await expect(rows).toHaveCount(0);
    await expect(page.locator('#icons-summary')).toHaveText('0 cached icons');
    await expect(page.locator('#icons-empty')).toBeVisible();
    await expect(page.locator('#delete-all')).toBeDisabled();

    await page.close();
  });
});
