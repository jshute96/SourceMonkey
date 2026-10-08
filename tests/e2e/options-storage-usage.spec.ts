// Options page's read-only storage-usage table: what is stored by kind,
// against Chrome's quota, repainted when storage changes.

import { test, expect } from '../fixtures/extension';

test('shows storage usage by kind and follows changes', async ({
  extensionContext, extensionId, getServiceWorker, sm,
}) => {
  void sm; // Requested for its reset-before-each-test.
  const page = await extensionContext.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  const table = page.locator('#storage-usage');
  await expect(page.locator('#storage-limit'))
    .toHaveText('Chrome limits each extension to 10 MB of storage.');
  const total = table.locator('tr.total td:last-child');
  await expect(total).toHaveText(/^\d+\.\d MB of 10 MB \(\d+%\)$/);
  // Rows that round to nothing are left out.
  await expect(table.locator('tr', { hasText: 'Script values' })).toHaveCount(0);

  // A ~2 MB GM value lands in its own row and moves the total.
  const sw = await getServiceWorker();
  await sw.evaluate(() => chrome.storage.local.set({ 'gmval:s1:big': 'x'.repeat(2 * 1024 * 1024) }));
  const values = table.locator('tr', { hasText: 'Script values' });
  await expect(values.locator('td').nth(1)).toHaveText('1 value in 1 script');
  await expect(values.locator('td').nth(2)).toHaveText('2,048 KB');
  await expect(total).toHaveText(/^2\.0 MB of 10 MB \(20%\)$/);
  // The shown sizes add up to the shown total, in its MB.
  const sizes = await table.locator('tr:not(.total) td:last-child').allTextContents();
  const sum = sizes.reduce((n, t) => n + Number(t.replace(/[^\d]/g, '')), 0);
  expect(`${(sum / 1024).toFixed(1)} MB`).toBe((await total.textContent())!.split(' of ')[0]);
  await sw.evaluate(() => chrome.storage.local.remove('gmval:s1:big'));
  await page.close();
});
